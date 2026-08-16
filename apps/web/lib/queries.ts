import "server-only";
import { sql } from "./db";

export type Status = "red" | "amber" | "green";

export type StoreWeek = {
  store_id: string;
  name: string;
  retailer: string;
  size_category: string | null;
  shelf_max: number | null;
  region_id: string | null;
  region: string | null;
  total_sent: number;
  total_sold: number;
  total_sold_prev: number;
  total_wasted: number;
  stockout_days: number;
  waste_pct: number | null;
  status: Status;
};

export type NetworkWeek = {
  stores: number; red: number; amber: number; green: number;
  total_sent: number; total_sold: number; total_wasted: number; waste_pct: number | null;
};

export type RegionWeek = {
  region_id: string; region: string; stores: number;
  red: number; amber: number; green: number;
  total_sent: number; total_sold: number; total_wasted: number; waste_pct: number | null;
};

export async function getAsOf(): Promise<Date> {
  const [row] = await sql<{ as_of: Date }[]>`select as_of from v_asof`;
  return row.as_of;
}

export async function getNetwork(): Promise<NetworkWeek> {
  const [row] = await sql<NetworkWeek[]>`select * from v_network_week`;
  return row;
}

export async function getStoreWeek(): Promise<StoreWeek[]> {
  return sql<StoreWeek[]>`select * from v_store_week`;
}

export async function getRegions(): Promise<RegionWeek[]> {
  return sql<RegionWeek[]>`
    select * from v_region_week
    order by red * 10 + amber desc, waste_pct desc nulls last`;
}

// 6-week network waste trend, oldest -> newest, as a % series for the chart.
export async function getWasteTrend(): Promise<number[]> {
  const rows = await sql<{ wk: number; sent: number; wasted: number }[]>`
    select wk, sent, wasted from v_waste_trend order by wk desc`;
  return rows.map((r) =>
    r.sent > 0 ? Math.round((1000 * r.wasted) / r.sent) / 10 : 0
  );
}

// Engine projection — the real "32% -> X%" waste model (Woolworths mature feed).
// One row per scenario: current + lean/balanced/service service-levels. Computed
// offline by the newsvendor engine on the real delivered-vs-sold ledger and loaded
// into engine_projection. The service dial on the dashboard picks between them.
export type EngineScenario = {
  scenario: string;
  label: string;
  ord: number;
  waste_pct: number | null;
  lost_sales_pct: number | null;
  units_saved_wk: number;
  delivered: number | null;
  channel: string;
};
export async function getEngineProjection(): Promise<EngineScenario[]> {
  try {
    return await sql<EngineScenario[]>`select * from engine_projection order by ord`;
  } catch {
    return []; // table not present yet — panel renders nothing rather than crashing
  }
}

// Delivery order sheet — per-store current-send vs engine-recommended, from the
// engine's plan (store_reco). Grouped by region in the Deliveries page. This is
// the run sheet Simona would actually work from.
export type DeliveryLine = { store_id: string; name: string; region: string | null; sent: number; recommended: number };
export async function getDeliveryPlan(): Promise<DeliveryLine[]> {
  try {
    return await sql<DeliveryLine[]>`
      select s.id as store_id, s.name, reg.name as region,
             sum(r.sent)::int as sent, sum(r.recommended)::int as recommended
      from store_reco r
      join stores s on s.id = r.store_id
      left join regions reg on reg.id = s.region_id
      group by s.id, s.name, reg.name
      order by sum(r.sent - r.recommended) desc`;
  } catch {
    return [];
  }
}

// Per-store, per-product delivery lines — powers the expandable product
// breakdown under each store on the Deliveries sheet (Simona: "a dropdown to
// see per-product without opening the full profile").
export type DeliveryDetailLine = { store_id: string; product_name: string; sent: number; recommended: number };
export async function getDeliveryDetail(): Promise<DeliveryDetailLine[]> {
  try {
    return await sql<DeliveryDetailLine[]>`
      select r.store_id, p.name as product_name,
             sum(r.sent)::int as sent, sum(r.recommended)::int as recommended
      from store_reco r
      join products p on p.id = r.product_id
      group by r.store_id, p.name
      order by sum(r.sent - r.recommended) desc`;
  } catch {
    return [];
  }
}

// Production bake plan — per-product totals across the whole plan (store_reco),
// current bake vs engine-sized. This is the factory sheet: what to make today.
export type ProductionLine = { name: string; category: string; sent: number; recommended: number; stores: number };
export async function getProductionPlan(): Promise<ProductionLine[]> {
  try {
    return await sql<ProductionLine[]>`
      select p.name, p.category::text as category,
             sum(r.sent)::int as sent, sum(r.recommended)::int as recommended,
             count(distinct r.store_id)::int as stores
      from store_reco r join products p on p.id = r.product_id
      group by p.name, p.category
      order by sum(r.sent) desc`;
  } catch {
    return [];
  }
}

export type FeedStatus = { source: string; status: string; as_of: Date; detail: string | null };
export async function getFeedStatus(): Promise<FeedStatus[]> {
  return sql<FeedStatus[]>`
    select distinct on (source) source, status, as_of, detail
    from feed_status_log order by source, checked_at desc`;
}

// ---------------------------------------------------------------------
// Recommendations — the exception-first "Needs you today" cards.
// Derived deterministically from the worst stores by wasted units. These
// are heuristic explanations grounded in the store's real weekly numbers;
// when the forecasting service is wired, the "fix" quantities switch to the
// engine's replenishment_plans.recommended_qty for that store.
// ---------------------------------------------------------------------
export type Recommendation = {
  store: StoreWeek;
  cause: string;
  fix: string;
  impact: string;
  atStake: number; // $/wk
};

// Stores in a region, worst-first (for the region drill-down).
export async function getRegionStores(region: string): Promise<StoreWeek[]> {
  return sql<StoreWeek[]>`
    select * from v_store_week where region = ${region}
    order by (case status when 'red' then 0 when 'amber' then 1 else 2 end),
             total_wasted desc`;
}

export async function getStoreById(id: string): Promise<StoreWeek | null> {
  const rows = await sql<StoreWeek[]>`select * from v_store_week where store_id = ${id}`;
  return rows[0] ?? null;
}

// Per-product engine order recommendation for a store — the "does Simona's job"
// table. sold/sent are this week's real numbers; recommended is the newsvendor
// order-up-to (balanced). Woolworths mature feed; empty for stores without a plan.
export type StoreReco = { product_name: string; sold: number; sent: number; recommended: number };
export async function getStoreRecos(id: string): Promise<StoreReco[]> {
  try {
    return await sql<StoreReco[]>`
      select p.name as product_name, r.sold, r.sent, r.recommended
      from store_reco r join products p on p.id = r.product_id
      where r.store_id = ${id}
      order by (r.sent - r.recommended) desc, p.name`;
  } catch {
    return []; // table not present yet — store page falls back gracefully
  }
}

export type DailyBar = { sale_date: Date; dow: string; sold: number; sent: number };
export async function getStoreDaily(id: string): Promise<DailyBar[]> {
  return sql<DailyBar[]>`
    select sale_date, dow, sold, sent from v_store_daily
    where store_id = ${id} order by sale_date`;
}

export type ProductRow = {
  name: string; category: string; sold: number; sent: number;
  wasted: number; waste_pct: number | null; suggested: number | null; status: Status;
};
// Per-product week for a store. `suggested` comes from the forecasting
// service's replenishment_plans when present (the real engine output).
export async function getStoreProducts(id: string): Promise<ProductRow[]> {
  return sql<ProductRow[]>`
    with a as (select as_of from v_asof),
    sold as (
      select product_id, sum(units_sold)::int s from sales_daily, a
      where store_id = ${id} and sale_date > a.as_of - interval '7 days' and sale_date <= a.as_of
      group by product_id),
    sent as (
      select di.product_id, sum(di.qty_sent)::int s
      from deliveries d join delivery_items di on di.delivery_id = d.id, a
      where d.store_id = ${id} and d.delivery_date > a.as_of - interval '7 days' and d.delivery_date <= a.as_of
      group by di.product_id),
    waste as (
      select product_id, sum(qty)::int w from wastage, a
      where store_id = ${id} and waste_date > a.as_of - interval '7 days' and waste_date <= a.as_of
      group by product_id),
    plan as (
      select distinct on (product_id) product_id, recommended_qty
      from replenishment_plans where store_id = ${id} order by product_id, target_date desc)
    select p.name, p.category::text as category,
      coalesce(sold.s,0) as sold, coalesce(sent.s,0) as sent,
      coalesce(waste.w,0) as wasted,
      round(100.0 * coalesce(waste.w,0) / nullif(coalesce(sent.s,0),0), 1) as waste_pct,
      plan.recommended_qty as suggested,
      jb_status(round(100.0 * coalesce(waste.w,0) / nullif(coalesce(sent.s,0),0),1), 0) as status
    from products p
    left join sold on sold.product_id = p.id
    left join sent on sent.product_id = p.id
    left join waste on waste.product_id = p.id
    left join plan on plan.product_id = p.id
    where p.active and (sold.s is not null or sent.s is not null)
    order by wasted desc, p.name`;
}

const titleCase = (t: string) => t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export async function getRecommendations(limit = 3): Promise<Recommendation[]> {
  const stores = await getStoreWeek();
  const red = stores
    .filter((s) => s.status === "red")
    .sort((a, b) => b.total_wasted - a.total_wasted)
    .slice(0, limit);

  return Promise.all(
    red.map(async (s, i) => {
      const atStake = Math.round(s.total_wasted * 0.9);
      const recos = await getStoreRecos(s.store_id);

      // Real engine numbers when we have a plan for this store — the card text is
      // built straight from store_reco so it matches the store drill-down exactly.
      if (recos.length >= 2) {
        const sentNow = recos.reduce((a, r) => a + r.sent, 0);
        const engineSend = recos.reduce((a, r) => a + r.recommended, 0);
        const soldSum = recos.reduce((a, r) => a + r.sold, 0);
        const trim = sentNow - engineSend;
        const top = recos.filter((r) => r.sent > r.recommended).slice(0, 3);
        const fixList = top.map((r) => `${titleCase(r.product_name)} ${r.sent}→${r.recommended}`).join(", ");
        return {
          store: s,
          cause: `Over-delivering the top lines — sending ${sentNow} a week where ${soldSum} sells. ${titleCase(recos[0].product_name)} is the worst offender.`,
          fix: fixList ? `Cut ${fixList}.` : `Right-size the over-supplied lines to real demand.`,
          impact: `~${trim} fewer units a week`,
          atStake,
        };
      }

      // Fallback for stores without a loaded plan (heuristic, grounded in their week).
      if (i % 2 === 0) {
        return {
          store: s,
          cause: `Sent ${s.total_sent} this week but sold ${s.total_sold} — over-delivery is leaving stock on the shelf.`,
          fix: `Right-size the drops to recent same-weekday demand.`,
          impact: `~${Math.max(3, Math.round(s.total_wasted * 0.5))} fewer loaves wasted a week`,
          atStake,
        };
      }
      return {
        store: s,
        cause: `Waste is running at ${s.waste_pct}% — well above the 20% target${s.stockout_days ? `, with ${s.stockout_days} stockout day${s.stockout_days === 1 ? "" : "s"} too` : ""}.`,
        fix: `Rebalance the week: lower the peak drop, protect the days it actually sells.`,
        impact: `~${Math.max(3, Math.round(s.total_wasted * 0.4))} fewer loaves wasted a week`,
        atStake,
      };
    })
  );
}

// ---------------------------------------------------------------------
// Benchmarks — peer-relative store scoring, computed from v_store_week.
// Simona's rule: never one absolute target. Each store vs its own week
// and vs similar same-size stores in its region (the cohort). Sell-
// through = sold / delivered. Cohorts need >= 2 stores to benchmark.
// ---------------------------------------------------------------------
export type BenchRow = {
  store_id: string; name: string; region: string; size: string;
  sell: number; cohort_median: number | null; vs_cohort: number | null; trend: number | null; status: Status;
};
export type BenchCohort = { key: string; region: string; size: string; median: number; count: number; stores: { name: string; sell: number; vs: number; status: Status }[] };
export type Benchmarks = { cohorts: BenchCohort[]; rows: BenchRow[]; under: BenchRow[]; over: BenchRow[]; networkMedian: number | null; cohortCount: number; hasData: boolean };

const jbMedian = (ns: number[]) => {
  if (!ns.length) return 0;
  const a = [...ns].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export async function getBenchmarks(): Promise<Benchmarks> {
  const sizeLabel = (s: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "Unsized");
  const base = (await getStoreWeek())
    .filter((s) => Number(s.total_sent) > 0)
    .map((s) => {
      const sent = Number(s.total_sent), sold = Number(s.total_sold), prev = Number(s.total_sold_prev);
      return {
        store_id: s.store_id, name: s.name, region: s.region ?? "Unassigned", size: sizeLabel(s.size_category),
        sell: Math.round((1000 * sold) / sent) / 10, sold, prev, status: s.status as Status,
      };
    });

  const groups = new Map<string, typeof base>();
  for (const r of base) { const k = `${r.region} · ${r.size}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  const med = new Map<string, number>();
  for (const [k, rs] of groups) med.set(k, jbMedian(rs.map((r) => r.sell)));

  const rows: BenchRow[] = base.map((r) => {
    const k = `${r.region} · ${r.size}`;
    const peer = groups.get(k)!.length >= 2;
    const cm = med.get(k)!;
    return {
      store_id: r.store_id, name: r.name, region: r.region, size: r.size, sell: r.sell,
      cohort_median: peer ? cm : null,
      vs_cohort: peer ? Math.round((r.sell - cm) * 10) / 10 : null,
      trend: r.prev > 0 ? Math.round((1000 * (r.sold - r.prev)) / r.prev) / 10 : null,
      status: r.status,
    };
  });

  const cohorts: BenchCohort[] = [...groups.entries()]
    .filter(([, rs]) => rs.length >= 2)
    .map(([key, rs]) => {
      const cm = med.get(key)!;
      const [region, size] = key.split(" · ");
      return {
        key, region, size, median: cm, count: rs.length,
        stores: [...rs].sort((a, b) => b.sell - a.sell).map((r) => ({ name: r.name, sell: r.sell, vs: Math.round((r.sell - cm) * 10) / 10, status: r.status })),
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const under = rows.filter((r) => r.vs_cohort !== null && r.vs_cohort <= -3).sort((a, b) => a.vs_cohort! - b.vs_cohort!);
  const over = rows.filter((r) => r.vs_cohort !== null && r.vs_cohort >= 3).sort((a, b) => b.vs_cohort! - a.vs_cohort!);
  return {
    cohorts, rows, under, over,
    networkMedian: rows.length ? jbMedian(rows.map((r) => r.sell)) : null,
    cohortCount: cohorts.length, hasData: cohorts.length > 0,
  };
}

// ---------------------------------------------------------------------
// Opportunities — one ranked "where's the next dollar" list, derived
// from real data: trim waste (over-delivering stores, sized from the
// plan where present) and capture demand (stores with stockout days).
// Range / rebalance need product-level gap analysis — surfaced as the
// per-product data builds, not faked here.
// ---------------------------------------------------------------------
export type OppLever = "demand" | "waste" | "range" | "rebalance";
export type Opp = {
  id: string; lever: OppLever; store: string; region: string; product: string;
  situation: string; move: string; gain: number; conf: "high" | "medium";
};
export type Opportunities = { opps: Opp[]; total: number; wasteUnits: number; demandUnits: number; hasData: boolean };

export async function getOpportunities(): Promise<Opportunities> {
  const stores = await getStoreWeek();
  const opps: Opp[] = [];

  // Trim waste — over-delivering stores, sized from store_reco where present.
  const wasteCand = stores
    .filter((s) => (s.status === "red" || s.status === "amber") && Number(s.total_sent) > Number(s.total_sold))
    .sort((a, b) => Number(b.total_wasted) - Number(a.total_wasted))
    .slice(0, 6);
  for (const s of wasteCand) {
    const recos = await getStoreRecos(s.store_id);
    const top = recos.filter((r) => r.sent > r.recommended).sort((a, b) => (b.sent - b.recommended) - (a.sent - a.recommended))[0];
    opps.push({
      id: `w-${s.store_id}`, lever: "waste", store: s.name, region: s.region ?? "—",
      product: top ? titleCase(top.product_name) : "across lines",
      situation: `Sending ${s.total_sent}/wk where ${s.total_sold} sells — ${s.waste_pct ?? "—"}% waste.`,
      move: top
        ? `Trim ${titleCase(top.product_name)} ${top.sent} → ${top.recommended} to match real sell-through.`
        : `Right-size the drops to recent same-weekday demand.`,
      gain: Number(s.total_wasted), conf: s.status === "red" ? "high" : "medium",
    });
  }

  // Capture demand — stores running out (stockout days = lost sales we can't see).
  const demandCand = stores
    .filter((s) => Number(s.stockout_days) > 0)
    .sort((a, b) => Number(b.stockout_days) - Number(a.stockout_days))
    .slice(0, 6);
  for (const s of demandCand) {
    const lost = Math.max(1, Math.round((Number(s.total_sold) / 7) * Number(s.stockout_days) * 0.5));
    opps.push({
      id: `d-${s.store_id}`, lever: "demand", store: s.name, region: s.region ?? "—", product: "peak lines",
      situation: `${s.stockout_days} stockout day${Number(s.stockout_days) === 1 ? "" : "s"} this week — running out before the next drop.`,
      move: `Lift the send on the peak days, or review the run cadence.`,
      gain: lost, conf: "medium",
    });
  }

  opps.sort((a, b) => b.gain - a.gain);
  const wasteUnits = opps.filter((o) => o.lever === "waste").reduce((a, o) => a + o.gain, 0);
  const demandUnits = opps.filter((o) => o.lever === "demand").reduce((a, o) => a + o.gain, 0);
  return { opps, total: wasteUnits + demandUnits, wasteUnits, demandUnits, hasData: opps.length > 0 };
}

// ---------------------------------------------------------------------
// Lost sales / stockouts — the availability mirror of waste, live from
// v_store_week.stockout_days (a stockout day = shelf hit zero with
// nothing left to expire). The sized "lift" fix comes from store_reco
// where a store is under-supplied. Reported waste doesn't exist (Fred:
// Waste_Qty all-zero), so this is the only read on lost demand until the
// on-hand ledger fully populates across Coles + Harris.
// ---------------------------------------------------------------------
export type Stockout = {
  id: string; store: string; retailer: string; region: string; product: string;
  pattern: string; lostWk: number; current: number | null; suggested: number | null; conf: "high" | "medium"; repeat: boolean;
};
export type LostSales = { losses: Stockout[]; totalLostWk: number; storesFlagged: number; repeatCount: number; hasData: boolean };

export async function getStockouts(): Promise<LostSales> {
  const stores = await getStoreWeek();
  const cand = stores.filter((s) => Number(s.stockout_days) > 0);
  const losses: Stockout[] = [];
  for (const s of cand) {
    const days = Number(s.stockout_days);
    const lostWk = Math.max(1, Math.round((Number(s.total_sold) / 7) * days * 0.5));
    const recos = await getStoreRecos(s.store_id);
    const under = recos.filter((r) => r.recommended > r.sent).sort((a, b) => (b.recommended - b.sent) - (a.recommended - a.sent))[0];
    losses.push({
      id: `so-${s.store_id}`, store: s.name, retailer: s.retailer, region: s.region ?? "—",
      product: under ? titleCase(under.product_name) : "peak lines",
      pattern: under
        ? `Ran out on ${days} day${days === 1 ? "" : "s"} this week — ${titleCase(under.product_name)} short before the next drop.`
        : `Ran out on ${days} day${days === 1 ? "" : "s"} this week — running dry before the next delivery.`,
      lostWk, current: under ? under.sent : null, suggested: under ? under.recommended : null,
      conf: days >= 3 ? "high" : "medium", repeat: days >= 3,
    });
  }
  losses.sort((a, b) => b.lostWk - a.lostWk);
  return {
    losses, totalLostWk: losses.reduce((a, l) => a + l.lostWk, 0),
    storesFlagged: losses.length, repeatCount: losses.filter((l) => l.repeat).length, hasData: losses.length > 0,
  };
}

// ---------------------------------------------------------------------
// Network map — active stores with real coordinates + this-week status,
// for the geographic view. Joins the store master (lat/lng) to the
// store-week rollup. Stores without coordinates are simply not plotted.
// ---------------------------------------------------------------------
export type MapStore = {
  store_id: string; name: string; retailer: string; region: string | null;
  lat: number; lng: number; status: Status; sent: number; sold: number; waste_pct: number | null;
};
export async function getMapStores(): Promise<MapStore[]> {
  try {
    return await sql<MapStore[]>`
      select v.store_id, v.name, v.retailer, v.region,
             s.lat::float8 as lat, s.lng::float8 as lng, v.status,
             v.total_sent as sent, v.total_sold as sold, v.waste_pct
      from v_store_week v
      join stores s on s.id = v.store_id
      where s.lat is not null and s.lng is not null`;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Archive — inactive stores, kept viewable. Warm/cold is derived from
// how recently the store last had sales (no archive metadata in the
// schema yet, so recency is the honest signal). Reason is a manual tag.
// ---------------------------------------------------------------------
export type ArchivedStore = {
  store_id: string; name: string; retailer: string; region: string | null; size: string | null;
  last_active: Date | null; days_since: number | null;
};
export async function getArchivedStores(): Promise<ArchivedStore[]> {
  try {
    return await sql<ArchivedStore[]>`
      with last as (select store_id, max(sale_date) as last_sale from sales_daily group by store_id)
      select s.id as store_id, s.name, s.retailer::text as retailer, reg.name as region,
             s.size_category::text as size, last.last_sale as last_active,
             (current_date - last.last_sale)::int as days_since
      from stores s
      left join regions reg on reg.id = s.region_id
      left join last on last.store_id = s.id
      where s.active = false
      order by last.last_sale desc nulls last, s.name`;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Forecast accuracy — a real backtest over the sales history. There are
// no stored engine forecasts to grade yet, so we replay the honest
// baseline the engine has to beat: a trailing-demand forecast (each
// week predicted from the mean of the prior K weeks for that store /
// product), scored against what actually sold. One metric everywhere:
// "closeness" = 100 * (1 - min(1, |forecast - actual| / actual)), so
// 100 = spot on, 0 = off by a full week or more. Bias is the mean
// signed error (over = leans waste, under = leans stockout). Every
// scored (store, week) pair is one real backtest snapshot — the count
// is reported, not asserted. The most recent (as-of) week is dropped
// per series because it is usually a partial week and would read as a
// false under-forecast.
// ---------------------------------------------------------------------
export type FaccStore = { store_id: string; store: string; region: string | null; acc: number; bias: number; trend: number[] };
export type FaccProduct = { name: string; acc: number; why: string };
export type ForecastAccuracyData = {
  weeks: number[];          // network weekly closeness, oldest -> newest (up to 8)
  network: number;          // latest complete week's network closeness
  improve: number;          // network vs ~4 weeks ago (points)
  netBias: number;          // mean store bias, %
  onTrack: number;          // % of stores at/above target
  target: number;
  lookback: number;         // K weeks used to form each forecast
  snapshots: number;        // real count of scored (store, week) backtests
  stores: FaccStore[];
  hard: FaccProduct[];
  easy: FaccProduct[];
};

type WkRow = { key: string; wk: string; sold: number };
type Scored = { wk: string; closeness: number; err: number };

// Backtest one oldest->newest weekly series. Drops the final (partial)
// week, then for each week i >= K forecasts from the prior K weeks.
function jbBacktest(series: { wk: string; sold: number }[], K: number): Scored[] {
  const s = series.slice(0, Math.max(0, series.length - 1));
  const out: Scored[] = [];
  for (let i = K; i < s.length; i++) {
    const actual = Number(s[i].sold);
    if (actual <= 0) continue; // nothing to score against
    let sum = 0;
    for (let j = i - K; j < i; j++) sum += Number(s[j].sold);
    const forecast = sum / K;
    const err = (forecast - actual) / actual;
    out.push({
      wk: s[i].wk,
      closeness: 100 * Math.max(0, 1 - Math.min(1, Math.abs(err))),
      err: err * 100,
    });
  }
  return out;
}

function jbGroupSeries(rows: WkRow[]): Map<string, { wk: string; sold: number }[]> {
  const by = new Map<string, { wk: string; sold: number }[]>();
  for (const r of rows) {
    const arr = by.get(r.key) ?? [];
    arr.push({ wk: r.wk, sold: Number(r.sold) });
    by.set(r.key, arr);
  }
  return by;
}

export async function getForecastAccuracy(): Promise<ForecastAccuracyData | null> {
  const K = 3, TARGET = 85, MIN_STORE_WEEKS = 3;
  try {
    const storeRows = await sql<{ key: string; store: string; region: string | null; wk: string; sold: number }[]>`
      select s.store_id::text          as key,
             st.name                    as store,
             reg.name                   as region,
             to_char(date_trunc('week', s.sale_date), 'YYYY-MM-DD') as wk,
             sum(s.units_sold)::int     as sold
      from sales_daily s
      join stores st  on st.id = s.store_id
      left join regions reg on reg.id = st.region_id
      where st.active
      group by s.store_id, st.name, reg.name, date_trunc('week', s.sale_date)
      order by s.store_id, wk`;

    if (!storeRows.length) return null;

    const meta = new Map<string, { store: string; region: string | null }>();
    for (const r of storeRows) if (!meta.has(r.key)) meta.set(r.key, { store: r.store, region: r.region });

    const series = jbGroupSeries(storeRows.map((r) => ({ key: r.key, wk: r.wk, sold: r.sold })));

    // Per-store scoring + network-by-week accumulation.
    const netByWeek = new Map<string, number[]>();
    const stores: FaccStore[] = [];
    let snapshots = 0;
    for (const [key, ser] of series) {
      const scored = jbBacktest(ser, K);
      if (scored.length < MIN_STORE_WEEKS) continue;
      snapshots += scored.length;
      for (const sc of scored) {
        const arr = netByWeek.get(sc.wk) ?? [];
        arr.push(sc.closeness);
        netByWeek.set(sc.wk, arr);
      }
      const acc = Math.round(scored.reduce((a, b) => a + b.closeness, 0) / scored.length);
      const bias = Math.round(scored.reduce((a, b) => a + b.err, 0) / scored.length);
      const trend = scored.slice(-6).map((x) => Math.round(x.closeness));
      const m = meta.get(key)!;
      stores.push({ store_id: key, store: m.store, region: m.region, acc, bias, trend });
    }

    if (!stores.length) return null;

    // Network weekly closeness series (oldest -> newest), last 8 complete weeks.
    const weekKeys = [...netByWeek.keys()].sort();
    const weekly = weekKeys.map((w) => {
      const v = netByWeek.get(w)!;
      return Math.round(v.reduce((a, b) => a + b, 0) / v.length);
    });
    const weeks = weekly.slice(-8);
    const network = weeks[weeks.length - 1] ?? 0;
    const improve = weeks.length >= 5 ? network - weeks[weeks.length - 5] : network - weeks[0];
    const netBias = Math.round(stores.reduce((a, s) => a + s.bias, 0) / stores.length);
    const onTrack = Math.round((stores.filter((s) => s.acc >= TARGET).length / stores.length) * 100);

    stores.sort((a, b) => b.acc - a.acc);

    // Product difficulty — same backtest per product, ranked by closeness.
    let hard: FaccProduct[] = [], easy: FaccProduct[] = [];
    try {
      const prodRows = await sql<{ key: string; wk: string; sold: number }[]>`
        select p.name                    as key,
               to_char(date_trunc('week', s.sale_date), 'YYYY-MM-DD') as wk,
               sum(s.units_sold)::int     as sold
        from sales_daily s
        join products p on p.id = s.product_id
        group by p.name, date_trunc('week', s.sale_date)
        order by p.name, wk`;
      const pSeries = jbGroupSeries(prodRows);
      const scoredProducts: { name: string; acc: number; cv: number; meanWk: number }[] = [];
      for (const [name, ser] of pSeries) {
        const s2 = ser.slice(0, Math.max(0, ser.length - 1));
        const sc = jbBacktest(ser, K);
        if (sc.length < 4) continue;
        const vols = s2.map((x) => Number(x.sold));
        const meanWk = vols.reduce((a, b) => a + b, 0) / vols.length;
        if (meanWk < 20) continue; // ignore tiny SKUs — noise, not signal
        const variance = vols.reduce((a, b) => a + (b - meanWk) ** 2, 0) / vols.length;
        const cv = meanWk > 0 ? Math.sqrt(variance) / meanWk : 0;
        const acc = Math.round(sc.reduce((a, b) => a + b.closeness, 0) / sc.length);
        scoredProducts.push({ name, acc, cv, meanWk });
      }
      if (scoredProducts.length >= 2) {
        const asc = [...scoredProducts].sort((a, b) => a.acc - b.acc);
        const swing = (cv: number) => Math.round(cv * 100);
        hard = asc.slice(0, 3).map((p) => ({
          name: p.name, acc: p.acc,
          why: `${swing(p.cv)}% week-to-week swing${p.meanWk < 60 ? " on thin volume" : ""} — a genuinely noisy pattern`,
        }));
        easy = asc.slice(-3).reverse().map((p) => ({
          name: p.name, acc: p.acc,
          why: `Low ${swing(p.cv)}% swing on steady volume — clean, repeatable shape`,
        }));
      }
    } catch { /* products optional — leave hard/easy empty */ }

    return { weeks, network, improve, netBias, onTrack, target: TARGET, lookback: K, snapshots, stores, hard, easy };
  } catch {
    return null; // no history yet / query failed — page shows an honest empty state
  }
}
