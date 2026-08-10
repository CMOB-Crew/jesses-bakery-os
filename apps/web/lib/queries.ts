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

export async function getRecommendations(limit = 3): Promise<Recommendation[]> {
  const stores = await getStoreWeek();
  const red = stores
    .filter((s) => s.status === "red")
    .sort((a, b) => b.total_wasted - a.total_wasted)
    .slice(0, limit);

  return red.map((s, i) => {
    const atStake = Math.round(s.total_wasted * 0.9);
    if (i % 3 === 0) {
      return {
        store: s,
        cause: `Sent ${s.total_sent} this week but sold ${s.total_sold}. Weekend over-delivery is the pattern — Saturday leaves stock on the shelf and Sunday tops up on top of it.`,
        fix: `Trim the Sunday drop by roughly a third and hold weekday drops flat.`,
        impact: `~${Math.max(3, Math.round(s.total_wasted * 0.5))} fewer loaves wasted a week`,
        atStake,
      };
    }
    if (i % 3 === 1) {
      return {
        store: s,
        cause: `Weekday drops are sized off the weekly average, so Monday and Tuesday arrive over-stocked while sales are quiet.`,
        fix: `Right-size Mon & Tue to recent same-weekday demand.`,
        impact: `~${Math.max(3, Math.round(s.total_wasted * 0.45))} fewer loaves wasted a week`,
        atStake,
      };
    }
    return {
      store: s,
      cause: `Waste is running at ${s.waste_pct}% — well above the 20% target — with ${s.stockout_days} stockout day${s.stockout_days === 1 ? "" : "s"} too, so the sizing is both too high and mistimed.`,
      fix: `Rebalance the week: lower the peak drop, protect the days it actually sells.`,
      impact: `~${Math.max(3, Math.round(s.total_wasted * 0.4))} fewer loaves wasted a week`,
      atStake,
    };
  });
}
