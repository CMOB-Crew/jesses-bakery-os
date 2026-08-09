"""
Jesse's Bakery OS — forecasting service.

The real replenishment engine: a newsvendor / critical-fractile order-up-to
policy, reading demand history + the on-hand ledger from Postgres and writing
auditable rows into replenishment_plans (recommendation + reasoning, so the
dashboard and the assistant can explain "why 25, not 45").

Why newsvendor here: on pay-on-scan, an unsold loaf is 100% waste while a
stockout only costs the margin. The optimal stocking point is the critical
ratio CR = Cu / (Cu + Co) of the demand distribution — deliberately below the
mean when waste is expensive. This is the mathematically correct answer to the
"139 into a 45-capacity store" problem, and it's capped hard at shelf_max.

Run:  uvicorn app:app --port 8088
"""
import os
import datetime as dt
from statistics import NormalDist
from typing import Optional

import psycopg
from psycopg.rows import dict_row
from fastapi import FastAPI
from pydantic import BaseModel

DB_URL = os.environ.get("DATABASE_URL", "postgres://postgres@127.0.0.1:5433/jesses")
MODEL_VERSION = "newsvendor-v1"

# Cost model (share of unit price). Pay-on-scan: overstock wastes the whole
# unit cost; understock loses the margin. CR = Cu / (Cu + Co).
UNDERSTOCK_COST = 0.40   # lost gross margin on a missed sale
OVERSTOCK_COST = 0.55    # unit cost written off when a loaf is wasted
CRITICAL_RATIO = UNDERSTOCK_COST / (UNDERSTOCK_COST + OVERSTOCK_COST)  # ~0.42

app = FastAPI(title="Jesse's Bakery Forecasting", version="1.0")


def db():
    return psycopg.connect(DB_URL, row_factory=dict_row)


class PlanRequest(BaseModel):
    target_date: Optional[str] = None   # ISO date; defaults to the day after latest data
    critical_ratio: Optional[float] = None


@app.get("/health")
def health():
    with db() as c:
        n = c.execute("select count(*) n from stores where active").fetchone()["n"]
    return {"status": "ok", "active_stores": n, "model": MODEL_VERSION,
            "critical_ratio": round(CRITICAL_RATIO, 3)}


def weekday_stats(cur, store_id, product_id, dow, weeks=6):
    """Mean/std of demand for a given weekday from recent history.

    NOTE: sales are censored (a sell-out hides true demand). Baseline uses
    observed sold as a demand proxy; the roadmap swaps this for a censored-
    demand estimator (the value is in the ledger's stockout flags)."""
    cur.execute(
        """
        select units_sold from sales_daily s
        join stores st on st.id = s.store_id
        where s.store_id = %s and s.product_id = %s
          and extract(dow from s.sale_date) = %s
        order by s.sale_date desc limit %s
        """,
        (store_id, product_id, dow, weeks),
    )
    vals = [r["units_sold"] for r in cur.fetchall()]
    if not vals:
        return None
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / len(vals) if len(vals) > 1 else (mean * 0.25) ** 2
    return mean, max(var, 0.0) ** 0.5


def event_uplift(cur, target_date, state):
    cur.execute(
        """select coalesce(sum(uplift_pct),0) up from events
           where %s between start_date and end_date
             and (state is null or state = %s::text)""",
        (target_date, state),
    )
    return float(cur.fetchone()["up"]) / 100.0


@app.post("/plan")
def build_plan(req: PlanRequest = PlanRequest()):
    cr = req.critical_ratio or CRITICAL_RATIO
    z = NormalDist().inv_cdf(cr)   # quantile multiplier for the critical ratio
    with db() as c, c.cursor() as cur:
        cur.execute("select coalesce(max(sale_date), current_date) d from sales_daily")
        as_of = cur.fetchone()["d"]
        target = dt.date.fromisoformat(req.target_date) if req.target_date else as_of + dt.timedelta(days=1)
        dow = target.weekday()               # 0=Mon
        pg_dow = (dow + 1) % 7               # Postgres extract(dow): 0=Sun

        cur.execute("""select st.id store_id, st.shelf_max, st.region_id,
                              reg.state, p.id product_id, p.lead_time_days,
                              p.min_on_shelf, p.name pname
                       from stores st cross join products p
                       left join regions reg on reg.id = st.region_id
                       where st.active and p.active""")
        combos = cur.fetchall()

        written = 0
        capped = 0
        rows = []
        for r in combos:
            stats = weekday_stats(cur, r["store_id"], r["product_id"], pg_dow)
            if stats is None:
                continue
            mean, std = stats
            # coverage = lead time + one review day
            coverage = max(1, r["lead_time_days"])
            uplift = event_uplift(cur, target, r["state"])
            f_mean = mean * coverage * (1 + uplift)
            f_std = std * (coverage ** 0.5)
            target_stock = max(0, round(f_mean + z * f_std))

            # on-hand from the latest ledger close
            cur.execute("""select closing_on_hand from on_hand_ledger
                           where store_id=%s and product_id=%s
                           order by as_of_date desc limit 1""",
                        (r["store_id"], r["product_id"]))
            oh = cur.fetchone()
            on_hand = oh["closing_on_hand"] if oh else 0

            rec = max(0, target_stock - on_hand)
            hit_cap = False
            if r["shelf_max"] and rec > r["shelf_max"]:
                rec = r["shelf_max"]; hit_cap = True; capped += 1
            if 0 < rec < r["min_on_shelf"]:
                rec = r["min_on_shelf"]

            reason = (f"Weekday demand ~{mean:.1f}/day, {coverage}-day cover"
                      + (f", +{uplift*100:.0f}% event" if uplift else "")
                      + f". Target {target_stock} at the {cr*100:.0f}th percentile "
                      + f"(waste-aware), on hand ~{on_hand}"
                      + (" — capped at shelf max." if hit_cap else "."))
            rows.append((r["store_id"], r["product_id"], target, round(f_mean, 2),
                         target_stock, on_hand, rec, hit_cap, reason, MODEL_VERSION))
            written += 1

        cur.executemany(
            """insert into replenishment_plans
               (store_id,product_id,target_date,forecast_demand,target_stock,
                on_hand_estimate,recommended_qty,capped_by_shelf,reason,model_version)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               on conflict (store_id,product_id,target_date) do update set
                 forecast_demand=excluded.forecast_demand, target_stock=excluded.target_stock,
                 on_hand_estimate=excluded.on_hand_estimate, recommended_qty=excluded.recommended_qty,
                 capped_by_shelf=excluded.capped_by_shelf, reason=excluded.reason,
                 model_version=excluded.model_version""",
            rows,
        )
        c.commit()
    return {"target_date": str(target), "plans_written": written,
            "capped_by_shelf": capped, "critical_ratio": round(cr, 3), "model": MODEL_VERSION}


@app.get("/plan/{store_id}")
def store_plan(store_id: str):
    with db() as c, c.cursor() as cur:
        cur.execute("""select p.name, rp.target_date, rp.forecast_demand, rp.target_stock,
                              rp.on_hand_estimate, rp.recommended_qty, rp.capped_by_shelf, rp.reason
                       from replenishment_plans rp join products p on p.id = rp.product_id
                       where rp.store_id = %s
                       order by rp.target_date desc, p.name""", (store_id,))
        return {"store_id": store_id, "plans": cur.fetchall()}
