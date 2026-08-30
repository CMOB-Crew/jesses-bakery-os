import "server-only";
import { q as sql } from "./db";
import { dayShare, dowMultipliers, dayIndexFromISO } from "./dayshare";

export type Status = "red" | "amber" | "green";

export type StoreWeek = {
  store_id: string;
  name: string;
  retailer: string;
  // False for invoice customers: Jesse delivers and invoices them, they never
  // report a scan sale. Waste for those stores isn't low, it's unknowable — the
  // view returns null waste rather than a number computed over a denominator
  // that can never be met (migration 027).
  has_sales_feed?: boolean;
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
  // The measured population (migration 031). total_* covers every supplied
  // store, including the invoice customers who never report a scan sale; feed_*
  // covers only the stores whose sales we can actually see. Any RATIO must come
  // from the feed_* pair — mixing them put 15.6% waste and 29.6% sell-through on
  // the Overview next to the engine panel's 34.3%, all from the same rows.
  feed_stores: number; feed_sent: number; feed_sold: number; feed_wasted: number;
};

export type RegionWeek = {
  region_id: string; region: string; stores: number;
  red: number; amber: number; green: number;
  total_sent: number; total_sold: number; total_wasted: number; waste_pct: number | null;
  // Measured population, same rule as NetworkWeek (migration 032). waste_pct is
  // computed over these stores; total_* still covers the whole region.
  feed_stores: number; feed_sent: number; feed_sold: number;
};

// Every reader below is wrapped so a transient DB blip (notably Supabase being
// briefly unreachable during a Netlify build's prerender) degrades to an empty
// default instead of throwing and failing the whole build. ISR then fills real
// data on the next request. Guarded readers keep the page from ever going blank
// AND keep deploys reliable.
export async function getAsOf(): Promise<Date> {
  try {
    const [row] = await sql<{ as_of: Date }[]>`select as_of from v_asof`;
    return row?.as_of ?? new Date();
  } catch {
    return new Date();
  }
}

const EMPTY_NETWORK: NetworkWeek = { stores: 0, red: 0, amber: 0, green: 0, total_sent: 0, total_sold: 0, total_wasted: 0, waste_pct: null, feed_stores: 0, feed_sent: 0, feed_sold: 0, feed_wasted: 0 };
export async function getNetwork(): Promise<NetworkWeek> {
  try {
    const [row] = await sql<NetworkWeek[]>`select * from v_network_week`;
    return row ?? EMPTY_NETWORK;
  } catch {
    return EMPTY_NETWORK;
  }
}

export async function getStoreWeek(): Promise<StoreWeek[]> {
  try {
    return await sql<StoreWeek[]>`select * from v_store_week`;
  } catch {
    return [];
  }
}

export async function getRegions(): Promise<RegionWeek[]> {
  try {
    return await sql<RegionWeek[]>`
      select * from v_region_week
      order by red * 10 + amber desc, waste_pct desc nulls last`;
  } catch {
    return [];
  }
}

// Every real region name, straight from the regions table (not store-gated like
// v_region_week). Drives the New store dropdown so it only ever offers regions
// that actually exist — a picked region can't silently fail to attach.
export async function getRegionNames(): Promise<string[]> {
  try {
    const rows = await sql<{ name: string }[]>`select name from regions order by name`;
    return rows.map((r) => r.name).filter(Boolean);
  } catch {
    return [];
  }
}

// 6-week network waste trend, oldest -> newest, as a % series for the chart.
export async function getWasteTrend(): Promise<number[]> {
  try {
    const rows = await sql<{ wk: number; sent: number; wasted: number }[]>`
      select wk, sent, wasted from v_waste_trend order by wk desc`;
    return rows.map((r) =>
      r.sent > 0 ? Math.round((1000 * r.wasted) / r.sent) / 10 : 0
    );
  } catch {
    return [];
  }
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
// `days` is this STORE's own delivery days, not the run's. Simona, 26 Aug
// [37:26]: when she expands a run, the run's set days are not true for every
// store on it — "Edgecliff and Metro Paddington do not get a delivery every
// day". Approving an order sheet without knowing that is how a store gets sent
// stock on a day nobody drives to it.
//
// `pm` is the subset of `days` this store takes as an EVENING drop. Worked out
// per day, not per store, because a store is not always on the same run every
// day: store_run_overrides records which run serves it on a given day (Coles
// Maroubra sits on four). So for each of the store's own days we ask which run
// covers THAT day — the override if there is one, otherwise its default run —
// and check whether that run lists the day in run_pm.
//
// Assuming the default run for every day is what caught migration 052 out, and
// it would be wrong here in the same way.
export type DeliveryLine = { store_id: string; name: string; region: string | null; sent: number; recommended: number; days: string[]; pm: string[] };
export async function getDeliveryPlan(): Promise<DeliveryLine[]> {
  try {
    const rows = await sql<(Omit<DeliveryLine, "days" | "pm"> & { days: string[] | null; pm: string[] | null })[]>`
      select s.id as store_id, s.name, reg.name as region,
             s.delivery_days::text[] as days,
             (select coalesce(array_agg(d::text), '{}'::text[])
                from unnest(s.delivery_days) d
               where d = any(coalesce(
                       (select ro.run_pm
                          from store_run_overrides ovr
                          join runs ro on ro.id = ovr.run_id
                         where ovr.store_id = s.id and ovr.day = d),
                       rn.run_pm,
                       '{}'::weekday[]))
             ) as pm,
             sum(r.sent)::int as sent,
             sum(coalesce(o.qty, r.recommended))::int as recommended
      from store_reco r
      join stores s on s.id = r.store_id
      left join regions reg on reg.id = s.region_id
      left join runs rn on rn.id = s.default_run_id
      left join store_product_overrides o
        on o.store_id = r.store_id and o.product_id = r.product_id
        and (o.mode = 'perm' or o.ends_on is null or o.ends_on >= current_date)
      group by s.id, s.name, reg.name, s.delivery_days, rn.run_pm
      order by sum(r.sent - coalesce(o.qty, r.recommended)) desc`;
    return rows.map((r) => ({ ...r, days: r.days ?? [], pm: r.pm ?? [] }));
  } catch {
    return [];
  }
}

// Per-store, per-product delivery lines — powers the expandable product
// breakdown under each store on the Deliveries sheet (Simona: "a dropdown to
// see per-product without opening the full profile").
export type DeliveryDetailLine = { store_id: string; product_id: string; product_name: string; sent: number; recommended: number };
export async function getDeliveryDetail(): Promise<DeliveryDetailLine[]> {
  try {
    // `recommended` is the FINAL delivery: a manual override wins over the engine
    // number, so store-profile adjustments (and delivery-sheet edits, which save
    // as overrides) flow through here. Falls back to the engine rec when unset.
    return await sql<DeliveryDetailLine[]>`
      select r.store_id, p.id::text as product_id, p.name as product_name,
             sum(r.sent)::int as sent,
             sum(coalesce(o.qty, r.recommended))::int as recommended
      from store_reco r
      join products p on p.id = r.product_id
      left join store_product_overrides o
        on o.store_id = r.store_id and o.product_id = r.product_id
        and (o.mode = 'perm' or o.ends_on is null or o.ends_on >= current_date)
      group by r.store_id, p.id, p.name
      order by sum(r.sent - coalesce(o.qty, r.recommended)) desc`;
  } catch {
    return [];
  }
}

// Production bake plan — per-product totals across the whole plan (store_reco),
// current bake vs engine-sized. This is the factory sheet: what to make today.
// Units per tray, per product, from Jesse's own Products_Master (migration 024).
// Keyed by product name because the bake sheet works by name.
//
// Deliberately its own query rather than a join inside getProductionPlan: if
// migration 024 hasn't been applied the columns don't exist, and folding this
// into the plan query would blank out the entire bake sheet. Here a missing
// column just yields {} -- the sheet shows units and waits, which is what it
// did before tray sizes existed at all.
export async function getTraySizes(): Promise<Record<string, number>> {
  try {
    const rows = await sql<{ name: string; baking_qty: number }[]>`
      select name, baking_qty from products
      where baking_uom = 'TRAY' and baking_qty is not null and baking_qty > 0`;
    const m: Record<string, number> = {};
    for (const r of rows) {
      const n = Number(r.baking_qty) || 0;
      if (n > 0) m[r.name] = n;
    }
    return m;
  } catch {
    return {};
  }
}

export type ProductionLine = { name: string; category: string; state: string | null; sent: number; recommended: number; stores: number };
export async function getProductionPlan(): Promise<ProductionLine[]> {
  try {
    return await sql<ProductionLine[]>`
      select p.name, p.category::text as category, st.state,
             sum(r.sent)::int as sent,
             sum(coalesce(o.qty, r.recommended))::int as recommended,
             count(distinct r.store_id)::int as stores
      from store_reco r join products p on p.id = r.product_id
      left join stores st on st.id = r.store_id
      left join store_product_overrides o
        on o.store_id = r.store_id and o.product_id = r.product_id
        and (o.mode = 'perm' or o.ends_on is null or o.ends_on >= current_date)
      group by p.name, p.category, st.state
      order by sum(r.sent) desc`;
  } catch {
    return [];
  }
}

// Product performance directory — the per-product lens on the whole network,
// aggregated from the engine ledger (store_reco). Delivered/sold/recommended
// summed across every store that ranges the product. Sell-through = sold /
// delivered; implied waste = delivered - sold (the same inferred method the
// store view uses). `change` is the engine's net order move (recommended -
// current send) across the network. This is the product-side mirror of the
// Stores directory: which lines waste most, which are being under-ordered,
// and how widely each is ranged.
export type ProductPerf = {
  product_id: string; name: string; category: string;
  stores: number; sent: number; sold: number; recommended: number;
  sell_through: number | null; waste_pct: number | null; change: number;
  launched: boolean; // tagged as a tracked launch (launched_at set)
  // Measured population, same rule as the network and region rollups
  // (migrations 031/032). stores/sent/recommended cover everywhere we deliver;
  // feed_* is only where sales come back. Any RATIO uses the feed_* pair.
  feed_stores: number; feed_sent: number;
};
export async function getProducts(): Promise<ProductPerf[]> {
  try {
    const rows = await sql<{ product_id: string; name: string; category: string; stores: number; sent: number; sold: number; recommended: number; feed_stores: number; feed_sent: number; launched_at: Date | null }[]>`
      select p.id as product_id, p.name, p.category::text as category,
             count(distinct r.store_id)::int as stores,
             sum(r.sent)::int as sent, sum(r.sold)::int as sold,
             sum(r.recommended)::int as recommended,
             -- Where the sales actually come back from. A product delivered
             -- only to invoice customers has no measurable waste at all, and
             -- must not be reported as 100%.
             count(distinct r.store_id) filter (where w.has_sales_feed)::int as feed_stores,
             coalesce(sum(r.sent) filter (where w.has_sales_feed), 0)::int      as feed_sent,
             p.launched_at
      from store_reco r
      join products p on p.id = r.product_id
      left join v_store_week w on w.store_id = r.store_id
      where p.active
      group by p.id, p.name, p.category, p.launched_at
      order by sum(r.sent - r.sold) desc`;
    return rows.map((r) => {
      const sent = Number(r.sent), sold = Number(r.sold);
      // Sell-through and waste divide by what the REPORTING stores received, not
      // by everything delivered. Bagel - Mini goes to two invoice customers who
      // never scan a sale, so the old sums read 1,080 delivered / 0 sold / 100%
      // waste and sat at the top of a list sorted worst-first. It is not 100%
      // waste, it is unmeasurable — and "—" is the honest answer. Same rule as
      // migrations 027/031/032.
      const feedSent = Number(r.feed_sent);
      return {
        product_id: r.product_id, name: r.name, category: r.category,
        stores: Number(r.stores), sent, sold, recommended: Number(r.recommended),
        feed_stores: Number(r.feed_stores), feed_sent: feedSent,
        sell_through: feedSent > 0 ? Math.round((1000 * sold) / feedSent) / 10 : null,
        waste_pct: feedSent > 0 ? Math.round((1000 * (feedSent - sold)) / feedSent) / 10 : null,
        change: Number(r.recommended) - sent,
        launched: r.launched_at != null,
      };
    });
  } catch {
    return [];
  }
}

// One product's network totals — for the product drill-down header.
export type ProductDetail = {
  product_id: string; name: string; category: string; launched: boolean;
  stores: number; sent: number; sold: number; recommended: number;
  feed_stores: number; feed_sent: number;
  sell_through: number | null; waste_pct: number | null; change: number;
};
export async function getProductById(id: string): Promise<ProductDetail | null> {
  try {
    const rows = await sql<{
      product_id: string; name: string; category: string; launched_at: Date | null;
      stores: number; sent: number; sold: number; recommended: number;
      feed_stores: number; feed_sent: number;
    }[]>`
      select p.id::text as product_id, p.name, p.category::text as category, p.launched_at,
             count(distinct r.store_id)::int as stores,
             coalesce(sum(r.sent), 0)::int as sent,
             coalesce(sum(r.sold), 0)::int as sold,
             coalesce(sum(r.recommended), 0)::int as recommended,
             count(distinct r.store_id) filter (where w.has_sales_feed)::int as feed_stores,
             coalesce(sum(r.sent) filter (where w.has_sales_feed), 0)::int as feed_sent
      from products p
      left join store_reco r on r.product_id = p.id
      left join v_store_week w on w.store_id = r.store_id
      where p.id = ${id}::uuid
      group by p.id, p.name, p.category, p.launched_at`;
    const r = rows[0];
    if (!r) return null;
    // Same rule as the Products list: sold can only be counted where there's a
    // feed, so the denominator has to be the feed's deliveries too. Delivered
    // stays as everything that left the bakery.
    const sent = Number(r.sent), sold = Number(r.sold), feedSent = Number(r.feed_sent);
    return {
      product_id: r.product_id, name: r.name, category: r.category,
      launched: r.launched_at != null,
      stores: Number(r.stores), sent, sold, recommended: Number(r.recommended),
      feed_stores: Number(r.feed_stores), feed_sent: feedSent,
      sell_through: feedSent > 0 ? Math.round((1000 * sold) / feedSent) / 10 : null,
      waste_pct: feedSent > 0 ? Math.round((1000 * (feedSent - sold)) / feedSent) / 10 : null,
      change: Number(r.recommended) - sent,
    };
  } catch {
    return null;
  }
}

// Per-store breakdown for one product (the drill-down): which stores range it
// and how each does. Straight from the engine plan (store_reco).
export type ProductStore = {
  store_id: string; name: string; region: string | null;
  sent: number; sold: number; recommended: number;
  has_sales_feed: boolean;
  sell_through: number | null; waste_pct: number | null; change: number;
};
export async function getProductStores(id: string): Promise<ProductStore[]> {
  try {
    const rows = await sql<{ store_id: string; name: string; region: string | null; sent: number; sold: number; recommended: number; has_sales_feed: boolean }[]>`
      select s.id::text as store_id, s.name, reg.name as region,
             r.sent, r.sold, r.recommended,
             coalesce(w.has_sales_feed, false) as has_sales_feed
      from store_reco r
      join stores s on s.id = r.store_id
      left join regions reg on reg.id = s.region_id
      left join v_store_week w on w.store_id = r.store_id
      where r.product_id = ${id}::uuid
      -- Measured stores first. Ordering on (sent - sold) alone floats every
      -- invoice customer to the top of a "worst waste first" table, because a
      -- store that never scans a sale looks like a store that sold nothing.
      order by coalesce(w.has_sales_feed, false) desc, (r.sent - r.sold) desc, s.name`;
    return rows.map((r) => {
      const sent = Number(r.sent), sold = Number(r.sold);
      const measured = r.has_sales_feed !== false;
      return {
        store_id: r.store_id, name: r.name, region: r.region,
        sent, sold, recommended: Number(r.recommended),
        has_sales_feed: measured,
        sell_through: measured && sent > 0 ? Math.round((1000 * sold) / sent) / 10 : null,
        waste_pct: measured && sent > 0 ? Math.round((1000 * (sent - sold)) / sent) / 10 : null,
        change: Number(r.recommended) - sent,
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Product launches -- a new product line, tracked separately for its first
// 6 weeks (mirrors the store Launches flow). launched_at is set from the
// Products page; performance is aggregated from the engine ledger
// (store_reco): stores ranging it, units sold, sell-through, waste. A brand
// new line shows zeros honestly until the plan/sales come in.
// ---------------------------------------------------------------------
const PRODUCT_LAUNCH_WINDOW = 42; // a product counts as a "new launch" for 6 weeks

export type ProductLaunch = {
  product_id: string; name: string; category: string;
  launched_at: Date | null; days_since: number | null;
  stores: number; sent: number; sold: number;
  feed_stores: number; feed_sent: number;
  sell_through: number | null; waste_pct: number | null; units_per_day: number | null;
  // Simona's trial call — Expand / Continue / Modify / Remove — from the SAME
  // engine the store-cohort trials use, so a product and a store rollout are
  // judged the same way. "early" until the 4-week read window (her "after 4–6
  // weeks" rule); no salesGrowth for a product line yet, so that axis is null.
  verdict: TrialVerdict; verdictReason: string;
};

export async function getProductLaunches(): Promise<ProductLaunch[]> {
  try {
    const rows = await sql<{
      product_id: string; name: string; category: string;
      launched_at: Date | null; days_since: number | null;
      stores: number; sent: number; sold: number; feed_stores: number; feed_sent: number;
    }[]>`
      select p.id::text as product_id, p.name, p.category::text as category,
             p.launched_at,
             (current_date - p.launched_at)::int as days_since,
             count(distinct r.store_id) filter (where r.sent > 0 or r.sold > 0) as stores,
             coalesce(sum(r.sent), 0)::int as sent,
             coalesce(sum(r.sold), 0)::int as sold,
             count(distinct r.store_id) filter (where w.has_sales_feed and (r.sent > 0 or r.sold > 0))::int as feed_stores,
             coalesce(sum(r.sent) filter (where w.has_sales_feed), 0)::int as feed_sent
      from products p
      left join store_reco r on r.product_id = p.id
      left join v_store_week w on w.store_id = r.store_id
      where p.launched_at is not null
        and p.launched_at >= current_date - ${PRODUCT_LAUNCH_WINDOW}::int
      group by p.id, p.name, p.category, p.launched_at
      order by p.launched_at desc, p.name`;
    return rows.map((r) => {
      const sent = Number(r.sent), sold = Number(r.sold), stores = Number(r.stores);
      const feedStores = Number(r.feed_stores), feedSent = Number(r.feed_sent);
      const days = r.days_since == null ? null : Number(r.days_since);
      // Units per store per day is measured over the stores we can see selling,
      // not every store ranging the line — otherwise a line launched half into
      // Coles reads as half as popular as it is.
      const denom = feedStores > 0 ? feedStores * Math.min(7, Math.max(1, days ?? 7)) : 0;
      // This one matters more than the other surfaces. A new line rolled into
      // stores that don't report sales has sold = 0 through no fault of the
      // product, which reads as 0% sell-through and 100% waste — and
      // trialVerdict turns that into "remove: weak demand for the space". That
      // is a wrong number becoming a wrong RECOMMENDATION, and Simona could
      // reasonably kill a good line on it. Measuring over feed_sent means an
      // unmeasurable launch comes back null and lands on "early" instead.
      const sellThrough = feedSent > 0 ? Math.round((1000 * sold) / feedSent) / 10 : null;
      const wastePct = feedSent > 0 ? Math.round((1000 * (feedSent - sold)) / feedSent) / 10 : null;
      const noData = sent === 0 && sold === 0;
      const blind = !noData && feedSent === 0;
      const { verdict, reason } = trialVerdict(days ?? 0, sellThrough, wastePct, null);
      return {
        product_id: r.product_id, name: r.name, category: r.category,
        launched_at: r.launched_at, days_since: days,
        stores, sent, sold,
        feed_stores: feedStores, feed_sent: feedSent,
        sell_through: sellThrough,
        waste_pct: wastePct,
        units_per_day: sold > 0 && denom > 0 ? Math.round((10 * sold) / denom) / 10 : null,
        verdict,
        verdictReason: noData
          ? "Gathering data — no sales in yet"
          : blind
            ? `Out in ${stores} ${stores === 1 ? "store" : "stores"}, none of which send us their sales yet — no read possible`
            : reason,
      };
    });
  } catch {
    return [];
  }
}

// THREE states, not two. This used to collapse everything past two days into
// "stale", so a retailer one day late and a retailer dark for three weeks wore
// the same amber badge on the Overview.
//
// Fred's framing is the whole point: "Coles died 4 Aug and reported Success for
// three weeks. That's the difference between our system and theirs." A quiet
// badge reading "stale" is that same failure in better clothing — it reports a
// fact and hides the consequence, which is that every other number on the page
// silently excludes 115 stores.
//
// Thresholds match v_feed_health so the Overview and /feeds can never disagree.
export type FeedStatus = { source: string; status: "ok" | "late" | "stopped"; as_of: Date; days_behind: number; detail: string | null };
export async function getFeedStatus(): Promise<FeedStatus[]> {
  try {
    // Measured from sales_daily, not read from feed_status_log.
    //
    // feed_status_log is hand-maintained, and on 24 Aug it was flagging HARRIS
    // FARM as 18 days stale while saying nothing about COLES -- which had sent
    // nothing since 8 Aug. Exactly backwards: it cried wolf about the healthy
    // feed and stayed silent about the broken one, while Simona was running
    // production off old sheets because she had no Coles data.
    //
    // A feed's health is knowable from the data itself, so ask the data. Two
    // days' grace because a retailer reporting a day late is normal.
    // Ordered oldest-first so the caller's find() picks the WORST feed, not
    // whichever happened to sort first.
    // Bounded to the last 120 days, with integer date arithmetic.
    //
    // Two attempts at this on 25 Aug, both instructive. Unbounded
    // `group by source` aggregates all 1.15M rows to return three: 2.2s, and
    // the slowest query on the Overview. Asking each retailer separately, which
    // should be three index seeks, measured WORSE — the correlated subquery
    // doesn't get the plan the shape suggests it should — and pushed the
    // Overview past Netlify's 10s limit, blanking the front page.
    //
    // This is the shape with an EXPLAIN behind it: a bounded sale_date range is
    // a Bitmap Index Scan with both ends in the Index Cond (~128ms for 91 days).
    // The bound must be `date - integer`, never `date - interval` — an interval
    // yields a TIMESTAMP, which silently demotes the Index Cond to a row Filter
    // and scans the table anyway. Same trap as getWeekdayShape.
    //
    // What 120 days costs us: a retailer that has sent nothing for four months
    // drops off this list rather than showing as very stale. The worst feed
    // today is Coles at 17 days, and a four-month silence is a different
    // conversation from a stale badge, so that's an acceptable edge for now.
    return await sql<FeedStatus[]>`
      with t as (
        -- The SYDNEY date, not jb_asof(). jb_asof() is max(as_of) from
        -- store_actuals -- a number made from the same data whose freshness
        -- this is judging. Anchored there, a feed is only late relative to
        -- whichever feed is freshest, and if they ALL stop the anchor stops
        -- with them: every gap computes to zero and every retailer reads
        -- "up to date" forever. That is the exact silent failure this query
        -- was written to catch. See migration 066.
        --
        -- Not current_date either: that resolves in the session timezone,
        -- which is UTC on Supabase, and does not roll over until 10am Sydney.
        select (now() at time zone 'Australia/Sydney')::date as today
      ),
      last_seen as (
        select sd.source::text as source, max(sd.sale_date) as as_of
        from sales_daily sd
        -- Both ends bounded, INTEGER arithmetic. Written as date minus an
        -- INTEGER. An interval instead yields a timestamp, which silently
        -- demotes the Index Cond to a row Filter and scans the table.
        where sd.sale_date >  (select today from t) - 120
          and sd.sale_date <= (select today from t)
        group by 1
      )
      select l.source,
             case when (select today from t) - l.as_of <= 2 then 'ok'
                  when (select today from t) - l.as_of <= 5 then 'late'
                  else 'stopped' end as status,
             l.as_of,
             ((select today from t) - l.as_of)::int as days_behind,
             null::text as detail
      from last_seen l
      order by l.as_of asc`;
  } catch {
    return [];
  }
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
  try {
    return await sql<StoreWeek[]>`
      select * from v_store_week where region = ${region}
      order by (case status when 'red' then 0 when 'amber' then 1 else 2 end),
               total_wasted desc`;
  } catch {
    return [];
  }
}

export async function getStoreById(id: string): Promise<StoreWeek | null> {
  try {
    const rows = await sql<StoreWeek[]>`select * from v_store_week where store_id = ${id}`;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

// Per-product engine order recommendation for a store — the "does Simona's job"
// table. sold/sent are this week's real numbers; recommended is the newsvendor
// order-up-to (balanced). Woolworths mature feed; empty for stores without a plan.
export type StoreReco = { product_id: string; product_name: string; sold: number; sent: number; recommended: number };
export async function getStoreRecos(id: string): Promise<StoreReco[]> {
  try {
    return await sql<StoreReco[]>`
      select p.id::text as product_id, p.name as product_name, r.sold, r.sent, r.recommended
      from store_reco r join products p on p.id = r.product_id
      where r.store_id = ${id}
      order by (r.sent - r.recommended) desc, p.name`;
  } catch {
    return []; // table not present yet — store page falls back gracefully
  }
}

// Active manual overrides Simona has set on a store's product lines (the
// write-back layer). One row per product; perm rows always apply, temp rows
// apply only until their end date, so an expired temporary change quietly stops
// mattering with no cleanup. Empty (and a no-op) until migration 011 is applied.
export type StoreOverride = {
  product_id: string;
  qty: number;
  mode: "perm" | "temp";
  starts_on: string | null;
  ends_on: string | null;
};
export async function getStoreOverrides(id: string): Promise<StoreOverride[]> {
  try {
    return await sql<StoreOverride[]>`
      select product_id::text as product_id, qty, mode,
             to_char(starts_on, 'YYYY-MM-DD') as starts_on,
             to_char(ends_on, 'YYYY-MM-DD') as ends_on
      from store_product_overrides
      where store_id = ${id}::uuid
        and (mode = 'perm' or ends_on is null or ends_on >= current_date)`;
  } catch {
    return []; // table not present yet — profile falls back to engine numbers
  }
}

// Saved product ranging (in/out) for a store (migration 015). A row is an
// explicit choice; absence means ranged by default. Falls back to empty (all
// ranged) if the table isn't present yet.
export type StoreRanging = { product_id: string; ranged: boolean };
export async function getStoreRanging(id: string): Promise<StoreRanging[]> {
  try {
    return await sql<StoreRanging[]>`
      select product_id::text as product_id, ranged
      from store_product_ranging where store_id = ${id}::uuid`;
  } catch {
    return [];
  }
}

// Saved per-store service level (migration 015). Null = not set, UI defaults to
// "balanced".
export async function getStoreServiceLevel(id: string): Promise<string | null> {
  try {
    const rows = await sql<{ service_level: string | null }[]>`
      select service_level from store_settings where store_id = ${id}::uuid`;
    return rows[0]?.service_level ?? null;
  } catch {
    return null;
  }
}

// Per-store "last visited" date (migration 019), YYYY-MM-DD or null.
export async function getStoreLastVisit(id: string): Promise<string | null> {
  try {
    const rows = await sql<{ last_visit_on: string | null }[]>`
      select last_visit_on::text as last_visit_on from store_settings where store_id = ${id}::uuid`;
    return rows[0]?.last_visit_on ?? null;
  } catch {
    return null;
  }
}

// Per-store state (NSW/QLD/ACT), as a store_id -> state map, for the one-system
// state filter (migration 023). Empty when the column/data isn't there yet, so
// the filter just doesn't show until states are loaded.
export async function getStoreStates(): Promise<Record<string, string>> {
  try {
    const rows = await sql<{ store_id: string; state: string | null }[]>`
      select id as store_id, state from stores where active and state is not null`;
    const m: Record<string, string> = {};
    for (const r of rows) if (r.state) m[r.store_id] = r.state;
    return m;
  } catch {
    return {};
  }
}

// Named delivery runs + their days (runs table, loaded from Simona's confirmed
// schedule). One run per region; region name = run name. Only runs that actually
// have days set are returned, so the legacy empty "Run 1..8" rows drop out.
// Powers the New Store wizard's "pick a run -> days auto-fill".
// `id` is here because the New store form now writes default_run_id directly
// rather than fuzzy-matching a label back to a region (see app/new-store/actions.ts).
// `pm` is the subset of `days` that go out in the EVENING (runs.run_pm,
// migration 052, from Sahil's run timings on 27 Aug). Empty for most runs;
// five carry at least one evening day — Central Coast, City, North West, Inner
// West and Western Sydney. Simona described the Central Coast one on the
// 26 Aug call: the driver goes Friday night and Sunday night. Until now it was
// stored and nothing on screen said it, so a run board reading "Central Coast
// — Sun, Wed, Fri" told a packer nothing about which of those are night loads.
export type RunOption = { id: string; name: string; region: string; days: string[]; pm: string[] };
export async function getRuns(): Promise<RunOption[]> {
  try {
    const rows = await sql<{ id: string; name: string; region: string; days: string[]; pm: string[] }[]>`
      select rn.id::text as id, rn.name, r.name as region,
             rn.run_days::text[] as days,
             rn.run_pm::text[]   as pm
      from runs rn join regions r on r.id = rn.region_id
      where cardinality(rn.run_days) > 0
      order by rn.name`;
    return rows.map((r) => ({ id: r.id, name: r.name, region: r.region, days: r.days ?? [], pm: r.pm ?? [] }));
  } catch {
    return [];
  }
}

// Per-store shelf-cap override (migration 022): a hand-set cap that replaces the
// size-band default, and a no-limit flag for pick-to-order stores. Defaults
// (null / false) when there's no row, so the profile falls back to stores.shelf_max.
export async function getStoreShelfCap(id: string): Promise<{ shelfCap: number | null; noCap: boolean }> {
  try {
    const rows = await sql<{ shelf_cap: number | null; no_cap: boolean }[]>`
      select shelf_cap, no_cap from store_settings where store_id = ${id}::uuid`;
    return { shelfCap: rows[0]?.shelf_cap ?? null, noCap: rows[0]?.no_cap ?? false };
  } catch {
    return { shelfCap: null, noCap: false };
  }
}

// Every per-store shelf-cap override in one round trip, keyed by store id.
//
// The single-store version above is what the profile uses. The Overview action
// list and the Stores drill-down need the whole set, because a cap Simona has
// already corrected by hand must stop being flagged everywhere at once —
// otherwise she fixes a store and the tally that sent her there doesn't move.
//
// Only stores with a row come back; every other store falls through to the
// size-band default in stores.shelf_max, which is what isCapStale() expects.
export async function getShelfCapOverrides(): Promise<Record<string, { cap: number | null; noCap: boolean }>> {
  try {
    const rows = await sql<{ store_id: string; shelf_cap: number | null; no_cap: boolean }[]>`
      select store_id, shelf_cap, no_cap
        from store_settings
       where shelf_cap is not null or no_cap`;
    const out: Record<string, { cap: number | null; noCap: boolean }> = {};
    for (const r of rows) out[r.store_id] = { cap: r.shelf_cap, noCap: !!r.no_cap };
    return out;
  } catch {
    return {};
  }
}

// Units sold on each store's BUSIEST single day of the week, keyed by store id.
//
// This is the denominator the shelf-cap check needs. A cap is a snapshot of what
// the fixture holds; a week of sales is six deliveries' worth of flow. Comparing
// a cap to the week flagged 84 of 95 stores; comparing it to the busiest day
// flags one. See lib/shelfcap.ts for the full reasoning.
//
// Same seven-day window as v_store_week, off the same v_asof anchor, so the peak
// day and the weekly total on the same screen are always about the same week.
export async function getPeakDaySold(): Promise<Record<string, number>> {
  try {
    const rows = await sql<{ store_id: string; peak: number }[]>`
            select x.store_id, max(x.dayq)::int as peak
        from (
          select sd.store_id, sd.sale_date, sum(sd.units_sold) as dayq
            from sales_daily sd
           where sd.sale_date >  jb_asof() - 7
             and sd.sale_date <= jb_asof()
           group by 1, 2
        ) x
       group by 1`;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.store_id] = Number(r.peak) || 0;
    return out;
  } catch {
    return {};
  }
}

// Per-retailer feed freshness (migration 039). The thing whose absence let
// Coles die on 3 Aug and stay dead for three weeks under a green light.
export type FeedHealth = {
  retailer: string; last_sale: string; days_behind: number;
  status: "ok" | "late" | "stopped"; last_upload: string | null;
};
export async function getFeedHealth(): Promise<FeedHealth[]> {
  try {
    return await sql<FeedHealth[]>`select * from v_feed_health order by days_behind desc`;
  } catch {
    return [];
  }
}

// The upload log — what was loaded, when, and how much of it didn't.
export type FeedUpload = {
  id: string; retailer: string; filename: string;
  period_from: string | null; period_to: string | null;
  rows_read: number; rows_loaded: number; rows_rejected: number;
  status: string; error: string | null; uploaded_at: string;
};
export async function getFeedUploads(limit = 12): Promise<FeedUpload[]> {
  try {
    return await sql<FeedUpload[]>`
      select id, retailer::text as retailer, filename, period_from, period_to,
             rows_read, rows_loaded, rows_rejected, status, error, uploaded_at
        from feed_uploads order by uploaded_at desc limit ${limit}`;
  } catch {
    return [];
  }
}

// Store street address (+ postcode) straight from the stores table, for the
// profile header. Simona asked to see the address on the store screen (Session 2
// UAT); it's in the Stores Master she confirmed. Null if not on file.
export async function getStoreAddress(id: string): Promise<string | null> {
  try {
    const rows = await sql<{ address: string | null; postcode: string | null }[]>`
      select address, postcode from stores where id = ${id}::uuid`;
    const a = rows[0]?.address?.trim() || "";
    const p = rows[0]?.postcode?.trim() || "";
    const full = [a, p].filter(Boolean).join(" ");
    return full || null;
  } catch {
    return null;
  }
}

// Per-store profile photo (migration 020) as a JPEG data URL, or null.
export async function getStorePhoto(id: string): Promise<string | null> {
  try {
    const rows = await sql<{ photo_url: string | null }[]>`
      select photo_url from store_settings where store_id = ${id}::uuid`;
    return rows[0]?.photo_url ?? null;
  } catch {
    return null;
  }
}

// Global app config (migration 016) as a key -> JSON value map. Falls back to
// empty (UI uses its defaults) if the table isn't present yet.
export type AppSettings = Record<string, unknown>;
export async function getAppSettings(): Promise<AppSettings> {
  try {
    const rows = await sql<{ key: string; value: unknown }[]>`select key, value from app_settings`;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

// Today's saved approval set for a run board (migration 017). itemId -> bool.
// Empty fallback so the board just starts unapproved if the table isn't there.
//
// The day is the SYDNEY day. current_date is UTC on Supabase and the UTC date
// does not roll over until 10am Sydney, so this read and the write in
// run-state-actions.ts disagreed with each other for the first ten hours of
// every day — ticks made at 7am disappeared at 10am. Both sides now use the
// same expression; if one moves, move the other.
export async function getRunState(surface: string): Promise<Record<string, boolean>> {
  try {
    const rows = await sql<{ approved: Record<string, boolean> }[]>`
      select approved from daily_run_state where surface = ${surface} and day = (now() at time zone 'Australia/Sydney')::date`;
    return rows[0]?.approved ?? {};
  } catch {
    return {};
  }
}

export type DailyBar = { sale_date: Date; dow: string; sold: number; sent: number };
export async function getStoreDaily(id: string): Promise<DailyBar[]> {
  try {
    return await sql<DailyBar[]>`
      select sale_date, dow, sold, sent from v_store_daily
      where store_id = ${id} order by sale_date`;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// STORE — the seven-day grid, and where the shelf hit zero.
//
// Simona, 26 Aug: "I need to see it by day... the weekend's very busy and the
// week can be quiet", and on stockouts: "I've never, ever been able to see
// where we've sold out of stock."
//
// Why this exists rather than reusing v_store_daily:
//
//   1. v_store_daily is DRIVEN BY sales_daily, so a day only exists if
//      something sold. A quiet Tuesday, or a delivery day with no scan,
//      produces no row at all — the panel then shows five days instead of
//      seven and she cannot tell "sold nothing" from "we have no idea".
//      Building the calendar first and left-joining onto it fixes that: seven
//      rows, always, with an honest zero where a zero is real.
//
//   2. It bounds with `interval '7 days'`. sale_date is a DATE; subtracting an
//      interval yields a TIMESTAMP, which stops matching the date index. Same
//      trap as getWeekdayShape. Integer day arithmetic throughout here.
// ---------------------------------------------------------------------
export type StoreDay = {
  day: string;          // YYYY-MM-DD
  dow: string;          // Mon..Sun
  delivered: number;
  sold: number;
  sellout_lines: number; // products whose shelf hit zero that day
};
export async function getStoreDayGrid(id: string): Promise<StoreDay[]> {
  try {
    return await sql<StoreDay[]>`
      with cal as (
        select (jb_asof() - g.n)::date as d
        from generate_series(0, 6) g(n)
      ),
      sold as (
        select sd.sale_date as d, sum(sd.units_sold)::int as n
        from sales_daily sd
        where sd.store_id = ${id}::uuid
          and sd.sale_date >  jb_asof() - 7
          and sd.sale_date <= jb_asof()
        group by 1
      ),
      sent as (
        select dl.delivery_date as d, sum(di.qty_sent)::int as n
        from deliveries dl
        join delivery_items di on di.delivery_id = dl.id
        where dl.store_id = ${id}::uuid
          and dl.delivery_date >  jb_asof() - 7
          and dl.delivery_date <= jb_asof()
        group by 1
      ),
      outs as (
        select o.as_of_date as d, count(*)::int as n
        from on_hand_ledger o
        where o.store_id = ${id}::uuid
          and o.closing_on_hand = 0
          and o.expired = 0
          and (o.opening_on_hand + o.delivered) > 0
          and o.as_of_date >  jb_asof() - 7
          and o.as_of_date <= jb_asof()
        group by 1
      )
      select to_char(cal.d, 'YYYY-MM-DD')      as day,
             trim(to_char(cal.d, 'Dy'))        as dow,
             coalesce(sent.n, 0)               as delivered,
             coalesce(sold.n, 0)               as sold,
             coalesce(outs.n, 0)               as sellout_lines
      from cal
      left join sold on sold.d = cal.d
      left join sent on sent.d = cal.d
      left join outs on outs.d = cal.d
      order by cal.d`;
  } catch {
    return [];
  }
}

// Which product ran out, and on which day. This is the thing she has never been
// able to see, so it is deliberately per-line rather than a count: a day with
// "3 lines out" tells her nothing she can act on, "wholemeal sourdough, Friday"
// tells her to send more wholemeal on Fridays.
export type StoreSellout = {
  day: string; dow: string; product_id: string; product_name: string;
  delivered: number; sold: number;
};
export async function getStoreSellouts(id: string): Promise<StoreSellout[]> {
  try {
    return await sql<StoreSellout[]>`
            select to_char(o.as_of_date, 'YYYY-MM-DD') as day,
             trim(to_char(o.as_of_date, 'Dy'))   as dow,
             p.id::text                          as product_id,
             p.name                              as product_name,
             o.delivered::int                    as delivered,
             o.sold::int                         as sold
      from on_hand_ledger o
      join products p on p.id = o.product_id
      where o.store_id = ${id}::uuid
        -- A sellout needs stock to run out of. closing = 0 alone also matches
        -- every line the store does not stock — nothing in, nothing sold,
        -- closes empty, every day. 79% of counted stockouts were that. See
        -- migration 038.
        and o.closing_on_hand = 0
        and o.expired = 0
        and (o.opening_on_hand + o.delivered) > 0
        and o.as_of_date >  jb_asof() - 7
        and o.as_of_date <= jb_asof()
      order by o.as_of_date, p.name`;
  } catch {
    return [];
  }
}

// The run this store sits on, the days it receives, and any per-day override.
// Simona, 26 Aug: "in this screen, the profile screen, I need to see what days
// the delivery goes out... maybe on the other half we can use that to say what
// run it's on and what days it goes out."
//
// Overrides matter as much as the base run and she named three by memory —
// Coles Maroubra rides Hills on Monday, East on Wednesday, South on Friday,
// East on Saturday. Showing the base run alone would be wrong four days a week
// for that store, so the overrides are carried here rather than left implicit.
//
// The ids come back alongside the names because the panel is editable now —
// she gets ONE Edit button that opens the whole week, and a save has to say
// which run, not which label.
export type StoreSchedule = {
  run_id: string | null;
  run_name: string | null;
  delivery_days: string[];
  overrides: { day: string; run_id: string; run: string }[];
};
export async function getStoreSchedule(id: string): Promise<StoreSchedule | null> {
  try {
    const rows = await sql<{ run_id: string | null; run_name: string | null; delivery_days: string[] | null; overrides: { day: string; run_id: string; run: string }[] | null }[]>`
      select r.id::text                              as run_id,
             r.name                                  as run_name,
             s.delivery_days::text[]                 as delivery_days,
             coalesce(
               (select json_agg(json_build_object('day', o.day::text, 'run_id', ro.id::text, 'run', ro.name))
                  from store_run_overrides o
                  join runs ro on ro.id = o.run_id
                 where o.store_id = s.id),
               '[]'::json
             )                                        as overrides
      from stores s
      left join runs r on r.id = s.default_run_id
      where s.id = ${id}::uuid`;
    const r = rows[0];
    if (!r) return null;
    return {
      run_id: r.run_id,
      run_name: r.run_name,
      delivery_days: r.delivery_days ?? [],
      overrides: r.overrides ?? [],
    };
  } catch {
    return null;
  }
}

// Every run she can put a day on. Same filter getRuns() uses — the legacy
// "Run 1..8" rows with no days set are not real runs and must not appear in a
// picker, or she will assign a store to one and nothing will ever collect it.
export type RunPick = { id: string; name: string };
export async function getRunPicklist(): Promise<RunPick[]> {
  try {
    return await sql<RunPick[]>`
      select rn.id::text as id, rn.name
        from runs rn
       where cardinality(rn.run_days) > 0
       order by rn.name`;
  } catch {
    return [];
  }
}

export type ProductRow = {
  name: string; category: string; sold: number; sent: number;
  wasted: number; waste_pct: number | null; suggested: number | null; status: Status;
};
// Per-product week for a store. `suggested` comes from the forecasting
// service's replenishment_plans when present (the real engine output).
export async function getStoreProducts(id: string): Promise<ProductRow[]> {
  try {
    return await sql<ProductRow[]>`
    with sold as (
      select product_id, sum(units_sold)::int s from sales_daily
      where store_id = ${id} and sale_date > jb_asof() - 7 and sale_date <= jb_asof()
      group by product_id),
    sent as (
      select di.product_id, sum(di.qty_sent)::int s
      from deliveries d join delivery_items di on di.delivery_id = d.id
      where d.store_id = ${id} and d.delivery_date > jb_asof() - 7 and d.delivery_date <= jb_asof()
      group by di.product_id),
    waste as (
      select product_id, sum(qty)::int w from wastage
      where store_id = ${id} and waste_date > jb_asof() - 7 and waste_date <= jb_asof()
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
  } catch {
    return [];
  }
}

const titleCase = (t: string) => t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Every recommendation line for a handful of stores, in one query rather than
// one per store. Same rows and same ordering as getStoreRecos, so callers can
// swap between them freely.
async function getRecosForStores(ids: string[]): Promise<Map<string, StoreReco[]>> {
  const m = new Map<string, StoreReco[]>();
  if (!ids.length) return m;
  try {
    const rows = await sql<(StoreReco & { store_id: string })[]>`
      select r.store_id::text as store_id, p.id::text as product_id, p.name as product_name,
             r.sold, r.sent, r.recommended
      from store_reco r join products p on p.id = r.product_id
      where r.store_id::text = any(${ids})
      order by r.store_id, (r.sent - r.recommended) desc, p.name`;
    for (const r of rows) {
      const list = m.get(r.store_id) ?? [];
      list.push({ product_id: r.product_id, product_name: r.product_name, sold: Number(r.sold), sent: Number(r.sent), recommended: Number(r.recommended) });
      m.set(r.store_id, list);
    }
  } catch {
    // store_reco absent — callers fall back to their generic wording.
  }
  return m;
}

// `stores` is optional so the Overview can hand over the store-week rows it has
// already fetched in its own Promise.all, instead of this asking for the same
// 265 rows a second time. Every round trip to the Singapore pooler is ~130ms of
// the Overview's 10s Netlify budget, and on a cold function start that budget
// is already half spent before any query runs.
export async function getRecommendations(limit = 3, stores?: StoreWeek[]): Promise<Recommendation[]> {
  const all = stores ?? (await getStoreWeek());
  // Only recommend action on stores we can actually see. Same guard as the
  // Overview's own counting rule — these cards sit on that page.
  const red = all
    .filter((s) => s.has_sales_feed !== false && s.status === "red")
    .sort((a, b) => b.total_wasted - a.total_wasted)
    .slice(0, limit);

  // One query for all three stores' lines, not three.
  const recosByStore = await getRecosForStores(red.map((s) => s.store_id));

  return Promise.all(
    red.map(async (s, i) => {
      // Units wasted per week — the real, cost-feed-free figure. Labelled as
      // units (not $) until Invoice_Cost lands and we can price it.
      const atStake = Math.round(Number(s.total_wasted) || 0);
      const recos = recosByStore.get(s.store_id) ?? [];

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
  store_id: string; name: string; region: string; size: string; channel: string;
  sell: number; cohort_median: number | null; vs_cohort: number | null; trend: number | null; status: Status;
};
export type BenchCohort = { key: string; region: string; size: string; channel: string; median: number; count: number; stores: { store_id: string; name: string; sell: number; vs: number; status: Status }[] };
export type Benchmarks = { cohorts: BenchCohort[]; rows: BenchRow[]; under: BenchRow[]; over: BenchRow[]; networkMedian: number | null; cohortCount: number; hasData: boolean };

const jbMedian = (ns: number[]) => {
  if (!ns.length) return 0;
  const a = [...ns].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export async function getBenchmarks(): Promise<Benchmarks> {
  const sizeLabel = (s: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "Unsized");
  // Channel splits the cohorts so we compare like with like. Direct-invoice
  // stores (cafes, schools, hospitals) invoice exactly what they sell, so their
  // sell-through is structurally ~100% and can't be compared to a retail shelf.
  // Grouping them together would pin a retail store's cohort median at 100% and
  // flag it red for a gap it can never close. Retail = Woolworths/Coles/Harris
  // Farm scan feeds (real sell-through); Invoice = everything on direct invoice.
  const channelOf = (retailer: string) => (retailer === "invoice" ? "Invoice" : "Retail");
  // Only stores whose sales we can see. An invoice customer is delivered to and
  // never scans, so its sell-through reads 0% — and with 153 of them in a 265
  // store network they were half the population, which pinned the headline
  // "network median sell-through" tile at a flat 0%. Same rule as migration 027
  // and the Overview: no feed, no score.
  const base = (await getStoreWeek())
    .filter((s) => Number(s.total_sent) > 0 && s.has_sales_feed !== false)
    .map((s) => {
      const sent = Number(s.total_sent), sold = Number(s.total_sold), prev = Number(s.total_sold_prev);
      return {
        store_id: s.store_id, name: s.name, region: s.region ?? "Unassigned", size: sizeLabel(s.size_category),
        channel: channelOf(s.retailer),
        sell: Math.round((1000 * sold) / sent) / 10, sold, prev, status: s.status as Status,
      };
    });

  const keyOf = (r: typeof base[number]) => `${r.region} · ${r.size} · ${r.channel}`;
  const groups = new Map<string, typeof base>();
  for (const r of base) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  const med = new Map<string, number>();
  for (const [k, rs] of groups) med.set(k, jbMedian(rs.map((r) => r.sell)));

  const rows: BenchRow[] = base.map((r) => {
    const k = keyOf(r);
    const peer = groups.get(k)!.length >= 2;
    const cm = med.get(k)!;
    return {
      store_id: r.store_id, name: r.name, region: r.region, size: r.size, channel: r.channel, sell: r.sell,
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
      const [region, size, channel] = key.split(" · ");
      return {
        key, region, size, channel, median: cm, count: rs.length,
        stores: [...rs].sort((a, b) => b.sell - a.sell).map((r) => ({ store_id: r.store_id, name: r.name, sell: r.sell, vs: Math.round((r.sell - cm) * 10) / 10, status: r.status })),
      };
    })
    // Retail cohorts first: direct-invoice cohorts are structurally ~100%
    // sell-through with no spread (a cafe invoices exactly what it sells), so
    // they make a flat, zero-signal default and browse poorly. Lead with the
    // retail cohorts that actually vary, then by size. Invoice cohorts still
    // appear, at the end.
    .sort((a, b) =>
      (a.channel === b.channel ? 0 : a.channel === "Retail" ? -1 : 1)
      || b.count - a.count
      || a.key.localeCompare(b.key));

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
  situation: string; move: string; gain: number; gainRevenue: number | null; conf: "high" | "medium";
  // Present on waste opps with a specific line to trim, so the card can route an
  // "apply" to the store profile pre-staged (like Lost sales). Null on general ones.
  store_id?: string; product_id?: string | null; suggested?: number | null;
};
export type Opportunities = { opps: Opp[]; total: number; totalRevenue: number | null; wasteUnits: number; demandUnits: number; hasData: boolean };

export async function getOpportunities(): Promise<Opportunities> {
  // All three reads at once. Awaited one after another, this page spent its
  // whole 10s Netlify budget waiting on round trips to Singapore and streamed
  // an empty body — the Overview only stayed healthy because it happened to use
  // Promise.all. Nothing here depends on anything else here, so nothing should
  // be waiting on anything else here.
  //
  // Revenue overlay: empty until Invoice_Cost loads, so gainRevenue stays null
  // and the page keeps units + the "revenue weighting lights up" note.
  const [stores, revByStore, overByStore] = await Promise.all([
    getStoreWeek(),
    getStoreRevenueWeek(),
    getTopOverSuppliedByStore(),
  ]);
  const unitRev = (storeId: string) => revByStore.get(storeId)?.avg_unit_revenue ?? null;
  const opps: Opp[] = [];

  // Trim waste — over-delivering stores, sized from store_reco where present.
  // Feed-live only, belt and braces. A dark store should already be green (waste
  // is NULL, so jb_status has nothing to fail it on) and therefore shouldn't
  // reach here — but "should already" is how this bug got onto seven pages, and
  // the cost of stating it is one clause. sent > sold is trivially true for any
  // store that never reports a sale.
  const wasteCand = stores
    .filter((s) => s.has_sales_feed !== false && (s.status === "red" || s.status === "amber") && Number(s.total_sent) > Number(s.total_sold))
    .sort((a, b) => Number(b.total_wasted) - Number(a.total_wasted))
    .slice(0, 6);
  // overByStore (fetched above) carries every store's worst over-supplied line,
  // replacing six more sequential per-store round trips.
  for (const s of wasteCand) {
    const top = overByStore.get(s.store_id);
    opps.push({
      id: `w-${s.store_id}`, lever: "waste", store: s.name, region: s.region ?? "—",
      product: top ? titleCase(top.product_name) : "across lines",
      situation: `Sending ${s.total_sent}/wk where ${s.total_sold} sells — ${s.waste_pct ?? "—"}% waste.`,
      move: top
        ? `Trim ${titleCase(top.product_name)} ${top.sent} → ${top.recommended} to match real sell-through.`
        : `Right-size the drops to recent same-weekday demand.`,
      // Size the gain to the MOVE, not to the store. This used to be the
      // store's entire weekly waste sitting next to a card that says "trim
      // White Sourdough 65 -> 28" — 37 units of change priced at 204. Seen
      // live on Mascot DC. If we have named a specific line, the honest number
      // is what trimming that line saves; only when we cannot name one does the
      // store-level figure make sense, and then the card says so too.
      gain: top ? Math.max(0, Number(top.sent) - Number(top.recommended)) : Number(s.total_wasted),
      gainRevenue:
        unitRev(s.store_id) == null
          ? null
          : Math.round(
              (top ? Math.max(0, Number(top.sent) - Number(top.recommended)) : Number(s.total_wasted)) *
                unitRev(s.store_id)!,
            ),
      conf: s.status === "red" ? "high" : "medium",
      store_id: s.store_id, product_id: top ? top.product_id : null, suggested: top ? top.recommended : null,
    });
  }

  // Capture demand — stores running out (stockout days = lost sales we can't see).
  // Feed-live stores only, same as Lost sales: the size of the opportunity comes
  // from total_sold, which is 0 for a dark store, so it would rank by stockout
  // days and then quote a gain of 1 unit.
  const demandCand = stores
    .filter((s) => Number(s.stockout_days) > 0 && s.has_sales_feed !== false)
    .sort((a, b) => Number(b.stockout_days) - Number(a.stockout_days))
    .slice(0, 6);
  for (const s of demandCand) {
    const lost = Math.max(1, Math.round((Number(s.total_sold) / 7) * Number(s.stockout_days) * 0.5));
    opps.push({
      id: `d-${s.store_id}`, lever: "demand", store: s.name, region: s.region ?? "—", product: "peak lines",
      situation: `${s.stockout_days} stockout day${Number(s.stockout_days) === 1 ? "" : "s"} this week — running out before the next drop.`,
      move: `Lift the send on the peak days, or review the run cadence.`,
      gain: lost,
      gainRevenue: unitRev(s.store_id) != null ? Math.round(lost * unitRev(s.store_id)!) : null,
      conf: "medium",
    });
  }

  opps.sort((a, b) => b.gain - a.gain);
  const wasteUnits = opps.filter((o) => o.lever === "waste").reduce((a, o) => a + o.gain, 0);
  const demandUnits = opps.filter((o) => o.lever === "demand").reduce((a, o) => a + o.gain, 0);
  // Total $ at stake only when every opp has a reading, so the headline dollar
  // figure is never a misleading partial. Null -> UI stays on units.
  const totalRevenue = opps.length > 0 && opps.every((o) => o.gainRevenue != null)
    ? opps.reduce((a, o) => a + (o.gainRevenue ?? 0), 0)
    : null;
  return { opps, total: wasteUnits + demandUnits, totalRevenue, wasteUnits, demandUnits, hasData: opps.length > 0 };
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
  id: string; store_id: string; store: string; retailer: string; region: string;
  product: string; product_id: string | null;
  pattern: string; lostWk: number; lostRevenueWk: number | null;
  current: number | null; suggested: number | null; conf: "high" | "medium"; repeat: boolean;
};
export type LostSales = {
  losses: Stockout[]; totalLostWk: number; totalLostRevenueWk: number | null;
  storesFlagged: number; repeatCount: number; hasData: boolean;
};

// Revenue layer (Invoice_Cost). Per-store trailing-week revenue + revenue-weighted
// waste + average unit revenue, from v_store_revenue_week. Returns an EMPTY map
// until sales_daily.invoice_cost is loaded (the view yields no rows), so every
// caller degrades cleanly to units-only. Never throws.
export type StoreRevenue = { revenue_wk: number; waste_revenue_wk: number; avg_unit_revenue: number | null };
export async function getStoreRevenueWeek(): Promise<Map<string, StoreRevenue>> {
  try {
    const rows = await sql<{ store_id: string; revenue_wk: string | null; waste_revenue_wk: string | null; avg_unit_revenue: string | null }[]>`
      select store_id, revenue_wk, waste_revenue_wk, avg_unit_revenue from v_store_revenue_week`;
    const m = new Map<string, StoreRevenue>();
    for (const r of rows) {
      m.set(r.store_id, {
        revenue_wk: Number(r.revenue_wk) || 0,
        waste_revenue_wk: Number(r.waste_revenue_wk) || 0,
        avg_unit_revenue: r.avg_unit_revenue == null ? null : Number(r.avg_unit_revenue),
      });
    }
    return m;
  } catch {
    return new Map();
  }
}

// The single most under-supplied line per store, for every store in one query.
// This used to be a per-store getStoreRecos() call inside the Lost sales loop —
// harmless while stockout_days was near-empty, fatal once the on-hand ledger
// load populated it for 172 stores: 172 sequential pooler round-trips overran
// Netlify's 10s function budget, the render never finished, and the page
// streamed its shell with an empty body. One DISTINCT ON makes the same
// selection the JS did — largest (recommended - sent) gap, product name as the
// tie-break — in a single round trip.
type UnderLine = { product_id: string; product_name: string; sent: number; recommended: number };
async function getTopUnderSuppliedByStore(): Promise<Map<string, UnderLine>> {
  return topGapByStore("under");
}

// The mirror of the above: the worst OVER-supplied line per store, for the
// Opportunities "trim waste" cards, which had the same six-round-trip loop.
async function getTopOverSuppliedByStore(): Promise<Map<string, UnderLine>> {
  return topGapByStore("over");
}

async function topGapByStore(dir: "under" | "over"): Promise<Map<string, UnderLine>> {
  const m = new Map<string, UnderLine>();
  try {
    // Two near-identical statements rather than one interpolated ordering —
    // postgres.js parameterises values, not SQL fragments, and a hand-built
    // order-by string is exactly the kind of thing that rots silently.
    const rows =
      dir === "under"
        ? await sql<{ store_id: string; product_id: string; product_name: string; sent: number; recommended: number }[]>`
            select distinct on (r.store_id)
                   r.store_id::text as store_id, p.id::text as product_id, p.name as product_name,
                   r.sent, r.recommended
            from store_reco r join products p on p.id = r.product_id
            where r.recommended > r.sent
            order by r.store_id, (r.recommended - r.sent) desc, p.name`
        : await sql<{ store_id: string; product_id: string; product_name: string; sent: number; recommended: number }[]>`
            select distinct on (r.store_id)
                   r.store_id::text as store_id, p.id::text as product_id, p.name as product_name,
                   r.sent, r.recommended
            from store_reco r join products p on p.id = r.product_id
            where r.sent > r.recommended
            order by r.store_id, (r.sent - r.recommended) desc, p.name`;
    for (const r of rows) {
      m.set(r.store_id, {
        product_id: r.product_id, product_name: r.product_name,
        sent: Number(r.sent), recommended: Number(r.recommended),
      });
    }
  } catch {
    // store_reco not present yet — every card falls back to its generic wording,
    // the same graceful degradation getStoreRecos() had.
  }
  return m;
}

export async function getStockouts(): Promise<LostSales> {
  // Three independent reads, so three at once rather than three in a queue.
  //
  // Revenue overlay: empty until the Invoice_Cost extract is loaded, so lost
  // revenue stays null and the UI keeps its "$ —, lights up with the price feed"
  // placeholder. The moment the feed lands this fills in with no code change.
  const [stores, revByStore, underByStore] = await Promise.all([
    getStoreWeek(),
    getStoreRevenueWeek(),
    getTopUnderSuppliedByStore(),
  ]);
  // Only stores whose sales are reaching us. The ledger records a zero shelf for
  // dark stores too, but nothing downstream of it works for them: lost units are
  // sized from `total_sold`, which is 0, so every one of them landed on the page
  // as a flat "1 unit lost"; there is no revenue to price it with, which left
  // the "Lost revenue / wk" tile stuck on "$ —" while the individual cards
  // showed real dollar figures beside it; and the suggested fix comes from
  // store_reco, where a dark store's row is its own standing order passed
  // through, so the "fix" is to change nothing. 172 flagged stores were 95 real
  // ones and 77 rows of noise that broke the total.
  const cand = stores.filter(
    (s) => Number(s.stockout_days) > 0 && s.has_sales_feed !== false,
  );
  const losses: Stockout[] = [];
  for (const s of cand) {
    const days = Number(s.stockout_days);
    const lostWk = Math.max(1, Math.round((Number(s.total_sold) / 7) * days * 0.5));
    const unitRev = revByStore.get(s.store_id)?.avg_unit_revenue ?? null;
    const lostRevenueWk = unitRev != null ? Math.round(lostWk * unitRev) : null;
    const under = underByStore.get(s.store_id);
    losses.push({
      id: `so-${s.store_id}`, store_id: s.store_id, store: s.name, retailer: s.retailer, region: s.region ?? "—",
      product: under ? titleCase(under.product_name) : "peak lines", product_id: under ? under.product_id : null,
      pattern: under
        ? `Ran out on ${days} day${days === 1 ? "" : "s"} this week — ${titleCase(under.product_name)} short before the next drop.`
        : `Ran out on ${days} day${days === 1 ? "" : "s"} this week — running dry before the next delivery.`,
      lostWk, lostRevenueWk, current: under ? under.sent : null, suggested: under ? under.recommended : null,
      conf: days >= 3 ? "high" : "medium", repeat: days >= 3,
    });
  }
  losses.sort((a, b) => b.lostWk - a.lostWk);
  // Total lost revenue only when we have a reading for every flagged store, so we
  // never show a misleadingly-low partial dollar figure. Null -> UI stays on "$ —".
  const revCount = losses.filter((l) => l.lostRevenueWk != null).length;
  const totalLostRevenueWk = losses.length > 0 && revCount === losses.length
    ? losses.reduce((a, l) => a + (l.lostRevenueWk ?? 0), 0)
    : null;
  return {
    losses, totalLostWk: losses.reduce((a, l) => a + l.lostWk, 0), totalLostRevenueWk,
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
  status: Status; sent: number; sold: number; waste_pct: number | null;
  has_sales_feed: boolean;
};
export async function getMapStores(): Promise<MapStore[]> {
  try {
    // The network map is a region-grouped diagram, not a to-scale geographic
    // plot — it never uses coordinates. Read straight from v_store_week (the
    // same active-store population Overview and Stores use) so every one of the
    // 265 stores is placed and the map's counts reconcile with the rest of the
    // app. (Previously it inner-joined stores on lat/lng and silently dropped
    // ~39 stores with no coordinates, so the map read 226 / fewer of every
    // status than the dashboards.)
    return await sql<MapStore[]>`
      select store_id, name, retailer, region, status,
             total_sent as sent, total_sold as sold, waste_pct, has_sales_feed
      from v_store_week`;
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
    // The last-sale lookup is a LATERAL, not a grouped subquery over the whole
    // table. As `group by store_id` across all of sales_daily it aggregated
    // every row in the network — over a million now that the legacy history is
    // loaded — to answer a question about the handful of stores that are
    // archived, and the page blew Netlify's 10s budget and rendered blank. Per
    // store, max(sale_date) is a backward walk of one index
    // (sales_daily (store_id, sale_date)) that stops on the first row.
    return await sql<ArchivedStore[]>`
      select s.id as store_id, s.name, s.retailer::text as retailer, reg.name as region,
             s.size_category::text as size, last.last_sale as last_active,
             (current_date - last.last_sale)::int as days_since
      from stores s
      left join regions reg on reg.id = s.region_id
      left join lateral (
        select max(sd.sale_date) as last_sale from sales_daily sd where sd.store_id = s.id
      ) last on true
      where s.active = false
        -- Exclude upcoming rollouts (added, planned go-live, not yet live).
        -- They belong on the Launches page, not in the dormant Archive.
        and not (s.go_live_at is not null and s.onboarded_at is null)
      order by last.last_sale desc nulls last, s.name`;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Launches -- new-store rollouts, tracked from before they go live.
//   * pipeline: added and inactive, with a planned go-live (go_live_at) and no
//     onboarded_at yet -- the "so I never forget a rollout" list.
//   * live: onboarded within the last 6 weeks and active -- tracked with the
//     metric Simona asked for (units per store per day) until they graduate.
// Both come straight from the store master, so a launch appears automatically
// the moment it is added or flipped live. Per-day precision arrives with Fred's
// daily feed; until then units/day is the weekly total spread over 7 days (~).
// ---------------------------------------------------------------------
const LAUNCH_WINDOW_DAYS = 42; // a store counts as a "new launch" for 6 weeks

export type PipelineStore = {
  store_id: string; name: string; retailer: string; region: string | null;
  size: string | null; supplier_code: string | null; go_live_at: Date | null;
  days_to_live: number | null;
};
export type LiveLaunch = {
  store_id: string; name: string; retailer: string; region: string | null;
  size: string | null; onboarded_at: Date | null; days_live: number | null;
  total_sent: number; total_sold: number; total_sold_prev: number;
  stockout_days: number; waste_pct: number | null; status: Status;
  units_per_day: number | null; has_sales_feed: boolean;
};
export type LaunchCohort = {
  key: string; label: string; region: string | null; go_live_at: Date | null;
  stores: PipelineStore[];
};
// Trial-report verdict for a launch cohort after it has had time to prove out.
//   early    — under the 4-week read window, still learning
//   expand   — strong sell-through, low waste, holding/growing -> roll out more
//   continue — healthy, keep as is
//   modify   — mixed (waste creeping, or sales slipping) -> adjust the range/size
//   remove   — not working (weak sell-through / high waste / falling) -> pull back
export type TrialVerdict = "early" | "expand" | "continue" | "modify" | "remove";
export type LaunchTrial = {
  key: string; label: string; region: string | null; retailers: string;
  storeCount: number; measuredStores: number; daysLive: number; weeksLive: number;
  unitsPerStorePerDay: number | null; sellThrough: number | null;
  wastePct: number | null; salesGrowth: number | null;
  growingStores: number; hasData: boolean;
  verdict: TrialVerdict; verdictReason: string;
};
export type Launches = {
  pipeline: PipelineStore[]; cohorts: LaunchCohort[]; live: LiveLaunch[];
  trials: LaunchTrial[];
  pipelineCount: number; liveCount: number;
};
const EMPTY_LAUNCHES: Launches = { pipeline: [], cohorts: [], live: [], trials: [], pipelineCount: 0, liveCount: 0 };

// Read window: a launch only gets a real verdict once it has had ~4 weeks to
// settle (Simona's "after 4–6 weeks" rule). Before that it's "early".
const TRIAL_READ_DAYS = 28;

// Pure recommendation from the aggregate signals. Ordered worst-first so a
// clear problem is never dressed up as "continue". Nulls are treated as
// non-blocking (no data on that axis rather than a bad reading), except
// sell-through: with nothing sold-vs-sent yet there's nothing to judge.
export function trialVerdict(
  daysLive: number,
  sellThrough: number | null,
  wastePct: number | null,
  salesGrowth: number | null,
): { verdict: TrialVerdict; reason: string } {
  if (daysLive < TRIAL_READ_DAYS) {
    const left = TRIAL_READ_DAYS - daysLive;
    return { verdict: "early", reason: `Still learning — ~${left} more day${left === 1 ? "" : "s"} before a read` };
  }
  if (sellThrough == null) {
    return { verdict: "early", reason: "Waiting on enough sales to judge" };
  }
  const w = wastePct;
  const g = salesGrowth;
  if (sellThrough < 45 || (w != null && w > 35) || (g != null && g <= -25)) {
    return { verdict: "remove", reason: "Weak demand for the space — pull back or rework before spreading it" };
  }
  if (sellThrough >= 85 && (w == null || w < 15) && (g == null || g >= -2)) {
    return { verdict: "expand", reason: "Selling through with low waste — a strong candidate to roll out wider" };
  }
  if ((w != null && w >= 22) || (g != null && g < 0)) {
    return { verdict: "modify", reason: "Working but leaky — tune the range or delivery size before expanding" };
  }
  return { verdict: "continue", reason: "Healthy trial — keep it running as is" };
}

// Build the trial report from the live-launch stores: group into cohorts (same
// region + same launch week, so two separate rollouts to one region stay apart),
// aggregate the tracked metrics, and attach a verdict. Pure — no DB — so the
// thresholds are easy to reason about and test.
export function buildTrials(live: LiveLaunch[]): LaunchTrial[] {
  const groups = new Map<string, LiveLaunch[]>();
  for (const l of live) {
    // Launch "week" bucket from onboarded_at, so a cohort is one rollout event.
    const onb = l.onboarded_at ? new Date(l.onboarded_at) : null;
    const wk = onb ? Math.floor(onb.getTime() / (7 * 864e5)) : 0;
    const key = `${l.region ?? "Unassigned"}|${wk}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(l);
  }

  const trials: LaunchTrial[] = [];
  for (const [key, stores] of groups) {
    const storeCount = stores.length;
    const daysLive = Math.max(...stores.map((s) => s.days_live ?? 0));

    // THE ONE THAT MATTERS MOST. This function's output is a recommendation
    // Simona acts on, not a number she reads past. A cohort of new Coles stores
    // is delivered to (sent > 0) but sends us nothing back (sold = 0, because
    // the feed stopped on 3 Aug), so measuring across every store in the cohort
    // gives 0% sell-through and 100% waste, and trialVerdict turns that into
    // "remove — weak demand for the space". A perfectly good rollout gets
    // recommended for the chop because of a data outage at the retailer.
    //
    // So the cohort is scored ONLY on the stores whose sales we can see. If
    // none of them report, there is no read: hasData goes false and the cohort
    // sits on "gathering data" until the feed lands, which is the honest answer.
    const measured = stores.filter((s) => s.has_sales_feed !== false);
    const sent = measured.reduce((a, s) => a + s.total_sent, 0);
    const sold = measured.reduce((a, s) => a + s.total_sold, 0);
    const soldPrev = measured.reduce((a, s) => a + s.total_sold_prev, 0);
    const hasData = measured.length > 0 && (sent > 0 || sold > 0);

    const sellThrough = hasData && sent > 0 ? Math.round((1000 * sold) / sent) / 10 : null;
    const wastePct = hasData && sent > 0 ? Math.round((1000 * Math.max(0, sent - sold)) / sent) / 10 : null;
    const salesGrowth = soldPrev > 0 ? Math.round((1000 * (sold - soldPrev)) / soldPrev) / 10 : null;
    // Units per store per day: cohort units spread over the store-days we can
    // actually observe, so a half-dark cohort isn't reported as half as busy.
    const storeDays = measured.reduce((a, s) => a + Math.min(7, Math.max(1, s.days_live ?? 1)), 0);
    const unitsPerStorePerDay = sold > 0 && storeDays > 0 ? Math.round((10 * sold) / storeDays) / 10 : null;
    // Repeat-performance proxy: stores holding or growing week-on-week.
    const growingStores = measured.filter((s) => s.total_sold >= s.total_sold_prev && s.total_sold > 0).length;

    const { verdict, reason } = trialVerdict(daysLive, sellThrough, hasData ? wastePct : null, salesGrowth);
    const retailers = [...new Set(stores.map((s) => s.retailer).filter(Boolean))]
      .map((r) => ({ woolworths: "Woolworths", coles: "Coles", harris_farm: "Harris Farm", invoice: "Invoice" }[r] ?? r))
      .join(", ");

    trials.push({
      key, label: stores[0].region ?? "Unassigned", region: stores[0].region, retailers,
      storeCount, measuredStores: measured.length, daysLive, weeksLive: Math.max(1, Math.round(daysLive / 7)),
      unitsPerStorePerDay, sellThrough, wastePct, salesGrowth, growingStores,
      hasData, verdict,
      verdictReason: hasData
        ? reason
        : measured.length === 0
          ? `${storeCount === 1 ? "This store doesn't" : "None of these stores"} send us sales yet — nothing to judge the launch on`
          : "Gathering data — no sales in yet",
    });
  }
  // Most-recently-launched first.
  return trials.sort((a, b) => a.daysLive - b.daysLive);
}

// Pipeline reads ONLY the base stores table, so it can never be taken down by a
// mismatch in the deployed v_store_week shape.
async function getPipelineStores(): Promise<PipelineStore[]> {
  try {
    const rows = await sql<{
      store_id: string; name: string; retailer: string; region: string | null;
      size: string | null; supplier_code: string | null; go_live_at: Date | null;
      days_to_live: number | null;
    }[]>`
      select s.id::text as store_id, s.name, s.retailer::text as retailer,
             reg.name as region, s.size_category::text as size,
             s.supplier_code, s.go_live_at,
             (s.go_live_at - current_date)::int as days_to_live
      from stores s
      left join regions reg on reg.id = s.region_id
      where s.active = false
        and s.go_live_at is not null
        and s.onboarded_at is null
      order by s.go_live_at asc nulls last, reg.name, s.name`;
    return rows.map((r) => ({
      store_id: r.store_id, name: r.name, retailer: r.retailer, region: r.region,
      size: r.size, supplier_code: r.supplier_code, go_live_at: r.go_live_at,
      days_to_live: r.days_to_live == null ? null : Number(r.days_to_live),
    }));
  } catch {
    return [];
  }
}

// Live-launch metrics come from getStoreWeek() (which does `select *`, so it
// tolerates whatever shape the deployed view has). We only hit the base stores
// table directly here, for onboarded_at, and match in JS. An isolated try/catch
// means a view issue can never blank the Coming-up list.
async function getLiveLaunchStores(): Promise<LiveLaunch[]> {
  try {
    const onboard = await sql<{ store_id: string; onboarded_at: Date; days_live: number }[]>`
      select id::text as store_id, onboarded_at,
             (current_date - onboarded_at)::int as days_live
      from stores
      where active = true
        and onboarded_at is not null
        -- cast the bound param to int so it resolves to the date - int operator
        -- (an untyped/bigint bind can fail operator resolution and throw)
        and onboarded_at >= current_date - ${LAUNCH_WINDOW_DAYS}::int
      order by onboarded_at desc, name`;
    if (!onboard.length) return [];
    const week = await getStoreWeek();
    const byId = new Map(week.map((w) => [w.store_id, w] as const));
    return onboard.map((o) => {
      const w = byId.get(o.store_id);
      const sold = Number(w?.total_sold ?? 0);
      const daysLive = Number(o.days_live);
      // Units per store per day = this week's units spread over the days observed
      // (capped at 7, the sold window). ~ until the daily feed lands.
      const denom = Math.min(7, Math.max(1, daysLive));
      return {
        store_id: o.store_id,
        name: w?.name ?? o.store_id,
        retailer: w?.retailer ?? "",
        region: w?.region ?? null,
        size: w?.size_category ?? null,
        onboarded_at: o.onboarded_at,
        days_live: daysLive,
        total_sent: Number(w?.total_sent ?? 0),
        total_sold: sold,
        total_sold_prev: Number(w?.total_sold_prev ?? 0),
        stockout_days: Number(w?.stockout_days ?? 0),
        waste_pct: w?.waste_pct == null ? null : Number(w.waste_pct),
        status: w?.status ?? "green",
        units_per_day: sold > 0 ? Math.round((10 * sold) / denom) / 10 : null,
        has_sales_feed: w?.has_sales_feed !== false,
      };
    });
  } catch {
    return [];
  }
}

export async function getLaunches(): Promise<Launches> {
  try {
    const pipeline = await getPipelineStores();
    const live = await getLiveLaunchStores();

    // Group the pipeline into rollout cohorts (same region + planned go-live) so
    // "5 Woolworths Metro stores launching in Canberra" reads as one rollout.
    const cohortMap = new Map<string, LaunchCohort>();
    for (const p of pipeline) {
      const dateKey = p.go_live_at ? new Date(p.go_live_at).toISOString().slice(0, 10) : "tbd";
      const key = `${p.region ?? "Unassigned"}|${dateKey}`;
      let c = cohortMap.get(key);
      if (!c) {
        c = { key, label: p.region ?? "Unassigned", region: p.region, go_live_at: p.go_live_at, stores: [] };
        cohortMap.set(key, c);
      }
      c.stores.push(p);
    }
    const cohorts = [...cohortMap.values()].sort((a, b) => {
      const ta = a.go_live_at ? new Date(a.go_live_at).getTime() : Infinity;
      const tb = b.go_live_at ? new Date(b.go_live_at).getTime() : Infinity;
      return ta - tb;
    });

    const trials = buildTrials(live);
    return { pipeline, cohorts, live, trials, pipelineCount: pipeline.length, liveCount: live.length };
  } catch {
    return EMPTY_LAUNCHES;
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
  // The delta across the WHOLE trend window. Separate from `improve`
  // because the chart caption sits under the whole line and used to
  // render the 4-week number while calling it "across the window" --
  // so an 8-week climb of 3 points was captioned as 0.
  improveWindow: number;
  panelStores: number;      // stores scored in EVERY week of the trend window
  panelBalanced: boolean;   // false when the panel was too thin and we fell back
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
    // Bounded to the 182 days ending at the as-of date -- 26 weekly points per
    // series, comfortably more than the K=3 backtest and MIN_STORE_WEEKS need,
    // and a fairer read on how the forecast behaves NOW. Unbounded this walked
    // all 1.1M sales rows on every load. Integer day arithmetic, not intervals:
    // see the note in getWeekdayShape for why that distinction decides whether
    // the sale_date index is used at all.
    //
    // Aggregated on store_id, with names joined on afterwards. Grouping by the
    // name text alongside the id makes Postgres carry and sort the text for
    // every one of the ~500k scanned rows before collapsing them; on ids the
    // sort keys are small and the text join lands on the ~10k result rows.
    const storeRows = await sql<{ key: string; store: string; region: string | null; wk: string; sold: number }[]>`
      with agg as (
        select s.store_id,
               date_trunc('week', s.sale_date) as wk,
               sum(s.units_sold)::int          as sold
        from sales_daily s
        where s.sale_date >  (select as_of from v_asof)::date - 182
          and s.sale_date <= (select as_of from v_asof)::date
        group by s.store_id, date_trunc('week', s.sale_date)
      )
      select agg.store_id::text                     as key,
             st.name                                as store,
             reg.name                               as region,
             to_char(agg.wk, 'YYYY-MM-DD')          as wk,
             agg.sold                               as sold
      from agg
      join stores st on st.id = agg.store_id and st.active
      left join regions reg on reg.id = st.region_id
      order by agg.store_id, wk`;

    if (!storeRows.length) return null;

    const meta = new Map<string, { store: string; region: string | null }>();
    for (const r of storeRows) if (!meta.has(r.key)) meta.set(r.key, { store: r.store, region: r.region });

    const series = jbGroupSeries(storeRows.map((r) => ({ key: r.key, wk: r.wk, sold: r.sold })));

    // Per-store scoring + network-by-week accumulation.
    // byStore keeps each store's week -> closeness so the trend line can be
    // built from a BALANCED panel (see below) rather than from whoever
    // happened to be reporting that week.
    const netByWeek = new Map<string, number[]>();
    const byStore = new Map<string, Map<string, number>>();
    const stores: FaccStore[] = [];
    let snapshots = 0;
    for (const [key, ser] of series) {
      const scored = jbBacktest(ser, K);
      if (scored.length < MIN_STORE_WEEKS) continue;
      snapshots += scored.length;
      const mine = new Map<string, number>();
      for (const sc of scored) {
        const arr = netByWeek.get(sc.wk) ?? [];
        arr.push(sc.closeness);
        netByWeek.set(sc.wk, arr);
        mine.set(sc.wk, sc.closeness);
      }
      byStore.set(key, mine);
      const acc = Math.round(scored.reduce((a, b) => a + b.closeness, 0) / scored.length);
      const bias = Math.round(scored.reduce((a, b) => a + b.err, 0) / scored.length);
      const trend = scored.slice(-6).map((x) => Math.round(x.closeness));
      const m = meta.get(key)!;
      stores.push({ store_id: key, store: m.store, region: m.region, acc, bias, trend });
    }

    if (!stores.length) return null;

    // Network weekly closeness series (oldest -> newest), last 8 complete weeks.
    //
    // BALANCED PANEL. Averaging every store that happened to be scorable in a
    // given week makes the trend line a measure of WHO REPORTED, not of how the
    // forecast is doing. Coles stopped sending sales on 3 Aug, so the weeks
    // before that were scored across ~200 stores and the weeks after across
    // ~95. The line then shows a dip and a recovery that is purely the
    // population changing underneath it, and "+1 point vs 4 weeks ago" compares
    // 95 stores against 200 different ones. On a page whose entire job is to
    // answer "is the plan getting it right?", that is the one number that must
    // not be an artefact.
    //
    // So the trend is built only from stores scored in EVERY week of the
    // window. Same stores, every point, like for like.
    const weekKeys = [...netByWeek.keys()].sort();
    const windowKeys = weekKeys.slice(-8);
    const panel = [...byStore.entries()]
      .filter(([, m]) => windowKeys.every((w) => m.has(w)))
      .map(([, m]) => m);
    // Below ~20 stores a balanced panel is noisier than the bias it removes, so
    // fall back to the all-comers average and say so rather than showing a
    // confident line drawn from a handful of stores.
    const panelBalanced = panel.length >= 20;
    const weeks = windowKeys.map((w) => {
      const v = panelBalanced ? panel.map((m) => m.get(w)!) : netByWeek.get(w)!;
      return Math.round(v.reduce((a, b) => a + b, 0) / v.length);
    });
    const network = weeks[weeks.length - 1] ?? 0;
    const improve = weeks.length >= 5 ? network - weeks[weeks.length - 5] : network - weeks[0];
    const improveWindow = weeks.length >= 2 ? network - weeks[0] : 0;
    const netBias = Math.round(stores.reduce((a, s) => a + s.bias, 0) / stores.length);
    const onTrack = Math.round((stores.filter((s) => s.acc >= TARGET).length / stores.length) * 100);

    stores.sort((a, b) => b.acc - a.acc);

    // Product difficulty — same backtest per product, ranked by closeness.
    let hard: FaccProduct[] = [], easy: FaccProduct[] = [];
    try {
      // Same treatment as storeRows above: bounded window, integer day
      // arithmetic, and aggregated on product_id with the name joined on after.
      // This one was the worst of the set -- 5.4s, because it sorted half a
      // million product-name strings to produce 1,002 rows.
      const prodRows = await sql<{ key: string; wk: string; sold: number }[]>`
        with agg as (
          select s.product_id,
                 date_trunc('week', s.sale_date) as wk,
                 sum(s.units_sold)::int          as sold
          from sales_daily s
          where s.sale_date >  (select as_of from v_asof)::date - 182
            and s.sale_date <= (select as_of from v_asof)::date
          group by s.product_id, date_trunc('week', s.sale_date)
        )
        select p.name                       as key,
               to_char(agg.wk, 'YYYY-MM-DD') as wk,
               agg.sold                      as sold
        from agg
        join products p on p.id = agg.product_id
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

    return {
      weeks, network, improve, improveWindow, netBias, onTrack, target: TARGET, lookback: K, snapshots,
      panelStores: panel.length, panelBalanced,
      stores, hard, easy,
    };
  } catch {
    return null; // no history yet / query failed — page shows an honest empty state
  }
}

// ---------------------------------------------------------------------
// Weekday demand shape — the real Sun..Sat multipliers from actual
// sell-through, so the "weekends run much higher" factor Simona named is
// measured, not assumed. Indexed by getDay() (0=Sun … 6=Sat), normalised
// so the 7-day mean is 1.0. weekendLift = how much higher Sat/Sun run
// vs the Mon–Fri average. Falls back to null (page uses the seed shape)
// when there isn't a full week of data.
// ---------------------------------------------------------------------
export type WeekdayShape = { shape: number[]; weekendLift: number; weeks: number };
export async function getWeekdayShape(): Promise<WeekdayShape | null> {
  try {
    // Bounded to the 91 days ending at the as-of date. Unbounded this was a full
    // scan of sales_daily -- harmless while that table held one week, a 1.1M-row
    // scan on every request once the legacy history landed, which is what timed
    // the Deliveries page out. Recent weeks are the more honest shape anyway:
    // seasonality drifts, and a 2024 Tuesday says nothing about this Tuesday.
    //
    // The bound is written as "as_of::date - 91", NOT "- interval '13 weeks'".
    // sale_date is a DATE; subtracting an interval yields a TIMESTAMP, the types
    // stop matching the date index, and the planner silently demotes the bound
    // from an Index Cond to a row Filter -- it still reads all 1.1M rows and
    // throws them away one by one. Integer day arithmetic stays a DATE and keeps
    // the index range scan: measured 836ms -> 128ms, 1,150,920 buffer pages -> 4,920.
    // Same reason v_asof is read as a scalar subquery rather than joined: it has
    // to be an InitPlan constant before the planner will index on it at all.
    const rows = await sql<{ dow: number; sold: number; days: number; weeks: number }[]>`
      with s as (
             select sd.sale_date, sd.units_sold
             from sales_daily sd
             where sd.sale_date >  (select as_of from v_asof)::date - 91
               and sd.sale_date <= (select as_of from v_asof)::date
           ),
           w as (select count(distinct date_trunc('week', sale_date))::int as weeks from s)
      select extract(dow from s.sale_date)::int as dow,
             sum(s.units_sold)::float8          as sold,
             count(distinct s.sale_date)::int   as days,
             w.weeks
      from s, w
      group by 1, w.weeks`;
    if (rows.length < 7) return null;
    const perDay = new Array(7).fill(0);
    for (const r of rows) {
      const d = Number(r.days);
      perDay[Number(r.dow)] = d > 0 ? Number(r.sold) / d : 0;
    }
    if (perDay.some((v) => v <= 0)) return null; // a whole weekday missing -- not enough to trust
    const mean = perDay.reduce((a, b) => a + b, 0) / 7;
    if (mean <= 0) return null;
    const shape = perDay.map((v) => Math.round((v / mean) * 100) / 100);
    const wkndAvg = (perDay[0] + perDay[6]) / 2;
    const wkdayAvg = (perDay[1] + perDay[2] + perDay[3] + perDay[4] + perDay[5]) / 5;
    const weekendLift = wkdayAvg > 0 ? Math.round((wkndAvg / wkdayAvg - 1) * 100) : 0;
    return { shape, weekendLift, weeks: Number(rows[0]?.weeks ?? 0) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Seasonality events — the calendar the engine plans against, read from
// the shared events table (migration 008) so the UI, the engine and
// Simona's edits share one source. `kind` is the calendar's visual
// category (ui_kind). Returns [] when the table is empty or absent, and
// the calendar falls back to its built-in seed.
// ---------------------------------------------------------------------
// storesAffected is how many stores the event will ACTUALLY move, from
// v_event_scope (migration 036). It is not decoration: until 036, the engine
// ignored every event's store scope and applied a "~6 Jewish-demographic
// stores" challah spike to all 265. The calendar showed the right scope text
// the whole time, which is precisely why nobody caught it — the words were
// right and the arithmetic wasn't. Now the page shows the number the engine
// uses, so the two can never drift apart silently again.
// 063 appends three more, and the reason is the same failure repeating one
// layer up. 036 taught the ENGINE about store scope but left the CALENDAR
// summing every event's headline uplift into one network number. With two
// Rosh Hashanah events on the same four days -- +90% on challah, +290% on
// babka, disjoint product sets, 38 stores -- the page printed x6.00 for Sunday
// 13 September. The engine's real figure for that day is +4.3%.
//
//   storesLive     how many of storesAffected the engine can reach TODAY
//                  (active and still reporting). 38 vs 20 on the Rosh
//                  Hashanah events; the 18 missing are all Coles, dark since
//                  8 Aug. Both numbers are shown, because the gap is a feed
//                  outage that reverses and neither number alone is honest.
//   productsScoped null means the event moves every product.
//   dayEffect      uplift x the share of planned units the scope covers.
//                  This is what the calendar cell must be built from.
//                  NULL when no plan exists to weigh against -- the caller
//                  MUST treat null as "no weight available" and fall back to
//                  the raw uplift, never as zero.
export type SeasonEvent = { id: string; kind: string; name: string; scope: string; start: string; end: string; uplift: number; note: string; storesAffected: number | null; storesLive: number | null; productsScoped: number | null; dayEffect: number | null };
export async function getSeasonalEvents(): Promise<SeasonEvent[]> {
  try {
    const rows = await sql<{ id: string; ui_kind: string | null; name: string; scope: string | null; start: string; end: string; uplift: number | null; note: string | null; stores_affected: number | null; stores_live: number | null; products_scoped: number | null; day_effect_pct: number | null }[]>`
      select e.id::text                            as id,
             coalesce(e.ui_kind, 'custom')         as ui_kind,
             e.name,
             e.scope,
             to_char(e.start_date, 'YYYY-MM-DD')   as start,
             to_char(e.end_date,   'YYYY-MM-DD')   as end,
             e.uplift_pct                          as uplift,
             e.note,
             sc.stores_affected,
             sc.stores_live,
             sc.products_scoped,
             sc.day_effect_pct
      from events e
      left join v_event_scope sc on sc.id = e.id
      order by e.start_date, e.name`;
    return rows.map((r) => ({
      id: r.id,
      kind: r.ui_kind ?? "custom",
      name: r.name,
      scope: r.scope ?? "",
      start: r.start,
      end: r.end,
      uplift: Number(r.uplift ?? 0),
      note: r.note ?? "",
      storesAffected: r.stores_affected == null ? null : Number(r.stores_affected),
      storesLive: r.stores_live == null ? null : Number(r.stores_live),
      productsScoped: r.products_scoped == null ? null : Number(r.products_scoped),
      dayEffect: r.day_effect_pct == null ? null : Number(r.day_effect_pct),
    }));
  } catch {
    return []; // events table not seeded yet — calendar uses its seed
  }
}

// ---------------------------------------------------------------------
// DELIVERY RUNS BOARD — item 5 of Simona's 26 Aug brief.
//
// [32:01] "Click a run card, see every store on that run and the order they go
// out in, see what days that run goes out, add a day, change a day."
// [33:43] the bare minimum she'd accept: "click a run, see its stores, and
// tweak the days."
// [23:01] and the hard limit: "I don't want to play with numbers too much. I
// think playing with numbers is really dangerous." So there are NO quantities
// anywhere in these queries. Days and membership only, deliberately.
//
// [31:42] is why this replaces the status map rather than sitting beside it:
// "this whole concept of tracking which region has errors isn't functional,
// because all it's telling us is data about it and then we've got to open up
// the store to get to it." This screen stops reporting and starts editing.
//
// Only runs with days set are returned — the same filter getRuns() uses. The
// twenty legacy "Run N" rows (migration 043) are not runs anyone drives.
// ---------------------------------------------------------------------
export type RunCard = {
  // `pm` is the subset of `days` this run goes out in the EVENING (runs.run_pm).
  // It was already on DeliveryLine and RunOption; RunBoard never got it, which
  // is why /map — the page actually titled "the days it goes out" — was the one
  // surface with no evening marking on it at all.
  //
  // Empty means UNKNOWN, not daytime. Central Coast, City and North West had
  // run_pm cleared when 052 was reverted, and the UI must not fill that silence
  // in with an assumption. That assumption is what 052 was.
  id: string; name: string; region: string; days: string[]; pm: string[];
  stores: number;        // stores whose home run this is
  visitors: number;      // stores that ride it on some days but live elsewhere
  exceptions: number;    // home stores that don't take every one of the run's days
};
export async function getRunBoard(): Promise<RunCard[]> {
  try {
    return await sql<RunCard[]>`
      select rn.id::text                              as id,
             rn.name                                  as name,
             reg.name                                 as region,
             rn.run_days::text[]                      as days,
             coalesce(rn.run_pm, '{}')::text[]        as pm,
             (select count(*) from stores s
               where s.default_run_id = rn.id and s.active)::int          as stores,
             (select count(distinct o.store_id) from store_run_overrides o
                join stores s2 on s2.id = o.store_id and s2.active
               where o.run_id = rn.id)::int                               as visitors,
             -- A store on this run that does NOT take every day the run goes
             -- out. Edgecliff and Metro Paddington are her example: the run's
             -- headline days are not true for every store on it, which is
             -- exactly what section 11 of the brief is about.
             (select count(*) from stores s3
               where s3.default_run_id = rn.id and s3.active
                 and not (rn.run_days <@ s3.delivery_days))::int           as exceptions
        from runs rn
        join regions reg on reg.id = rn.region_id
       where cardinality(rn.run_days) > 0
       order by rn.name`;
  } catch {
    return [];
  }
}

export type RunMember = {
  run_id: string; store_id: string; name: string; retailer: string;
  days: string[];
  away: { day: string; run: string }[];   // days this store rides someone else's run
};
export type RunVisitor = {
  run_id: string; store_id: string; name: string; retailer: string;
  days: string[]; home_run: string;
};

// Every run's roster in TWO queries, not two per run.
//
// The board is a master-detail on one page — she clicks a run and the stores
// appear beside it, which is exactly how she described it at [29:23]. Fetching
// per selection would be a round trip to the Singapore pooler at ~130ms on
// every click; fetching per run up front would be 42 of them. The whole roster
// is 265 stores and 28 exception rows, so it comes back whole and the client
// groups it.
//
// `visitors` is not decoration. For Eastern Suburbs it is the stores from South
// East and City that ride it on Saturdays. A detail showing home members only
// would make the Saturday Eastern Suburbs van look half as busy as it is, and
// Coles Maroubra would be missing from the screen on the exact day Simona goes
// looking for it.
export async function getRunRoster(): Promise<{ members: RunMember[]; visitors: RunVisitor[] }> {
  try {
    const [members, visitors] = await Promise.all([
      sql<RunMember[]>`
        select s.default_run_id::text as run_id,
               s.id::text             as store_id,
               s.name,
               s.retailer::text       as retailer,
               s.delivery_days::text[] as days,
               coalesce(
                 (select json_agg(json_build_object('day', o.day::text, 'run', r2.name))
                    from store_run_overrides o
                    join runs r2 on r2.id = o.run_id
                   where o.store_id = s.id),
                 '[]'::json) as away
          from stores s
         where s.active and s.default_run_id is not null
         order by s.name`,
      sql<RunVisitor[]>`
        select o.run_id::text as run_id,
               s.id::text     as store_id,
               s.name,
               s.retailer::text as retailer,
               array_agg(o.day::text order by
                 array_position(array['mon','tue','wed','thu','fri','sat','sun'], o.day::text)) as days,
               coalesce(hr.name, '(no run)') as home_run
          from store_run_overrides o
          join stores s on s.id = o.store_id and s.active
          left join runs hr on hr.id = s.default_run_id
         group by o.run_id, s.id, s.name, s.retailer, hr.name
         order by s.name`,
    ]);
    return {
      members: (members ?? []).map((m) => ({ ...m, days: m.days ?? [], away: m.away ?? [] })),
      visitors: (visitors ?? []).map((v) => ({ ...v, days: v.days ?? [] })),
    };
  } catch {
    return { members: [], visitors: [] };
  }
}


// =====================================================================
// PACKING — the only per-day read in this file.
// =====================================================================
// Everything above reads store_reco, which is a CURRENT-WEEK total, one row
// per store-product. That is right for the Deliveries and Production boards,
// which are weekly by design. It is wrong for a packing slip, which is one
// day: packing off store_reco overstates every line by roughly the number of
// delivery days in the week.
//
// So packing reads replenishment_plans by target_date. Checked against the
// go-live audit before anything was built on it: 3 September comes back as
// 564 lines / 1,778 units / 40 stores, which is what replenishment_plans says
// read plainly.
//
// THE RUN IS NOT ALWAYS THE STORE'S HOME RUN. store_run_overrides carries 28
// rows over 15 stores. COLES MAROUBRA rides Eastern Suburbs on Wed and Sat,
// Hills on Mon, South on Fri -- never its home run of South East. Packing on
// default_run_id alone would put those boxes in the wrong cage, so the run is
// coalesce(override for that weekday, default run) -- the same rule
// getDeliveryPlan uses for the delivery board. The two must agree.
export type PackItem  = { product_id: string; name: string; qty: number };
// standing = this store has no plan for the day and is shown at its CURRENT
// STANDING ORDER instead. Never a forecast, and marked as such on screen --
// a packer has to tell the difference at a glance.
export type PackStore = { store_id: string; name: string; retailer: string; items: PackItem[]; units: number; standing: boolean };
export type PackRun   = { run_id: string; name: string; stores: PackStore[]; units: number };

// The days the engine has actually planned. Drives the day picker, so the UI
// can never ask for a day that has no plan behind it.
export async function getPackingDays(): Promise<string[]> {
  try {
    const rows = await sql<{ d: string }[]>`
      select to_char(target_date, 'YYYY-MM-DD') as d
        from replenishment_plans
       group by target_date
       order by target_date`;
    return rows.map((r) => r.d);
  } catch {
    return [];
  }
}

export async function getPackingRuns(day: string, shape?: WeekdayShape | null): Promise<PackRun[]> {
  try {
    // TWO sources, deliberately.
    //
    // planned  -- replenishment_plans for this exact date. What the engine sized.
    //
    // standing -- every OTHER store due a delivery this weekday, at its current
    //             standing order from store_reco. Without this branch such a
    //             store does not show as a zero; it does not show at all.
    //
    // Measured 30 Aug for Thursday 3 Sep: 101 stores due, 40 planned. The 61
    // missing were 49 Coles -- feed 22 days behind, so outside jb_plan_day's
    // seven-day ranging window -- and 12 invoice customers that have never had
    // a sales row and never will be forecastable, including JESSE'S CAFE at
    // 4,369 units a week, the largest standing order in the business, absent
    // from the sheet the bakery packs from.
    //
    // That window is measured against max(sale_date) across ALL retailers, one
    // global clock, so the set MOVES: loading only the Coles file pushes the
    // clock forward and drops Woolworths and Harris Farm out. A sheet that
    // silently omits whoever fell out this week is the failure. Showing them at
    // their standing order, marked, is not.
    const rows = await sql<{
      run_id: string; run_name: string | null;
      store_id: string; store_name: string; retailer: string;
      delivery_days: string[] | null;
      product_id: string; product_name: string;
      qty: number; week_sent: number; planned: boolean;
    }[]>`
      with d as (select ${day}::date as day),
      wd as (select lower(to_char(day, 'Dy'))::weekday as w from d),
      planned as (
        select rp.store_id, rp.product_id,
               coalesce(o.qty, rp.recommended_qty)::int as qty
          from replenishment_plans rp
          join d on rp.target_date = d.day
          left join store_product_overrides o
                 on o.store_id = rp.store_id and o.product_id = rp.product_id
                and (o.mode = 'perm' or o.ends_on is null or o.ends_on >= current_date)
         where coalesce(o.qty, rp.recommended_qty) > 0
      ),
      standing as (
        select sr.store_id, sr.product_id, sr.sent::int as week_sent
          from store_reco sr
         where sr.sent > 0
           and not exists (
             select 1 from replenishment_plans rp2, d
              where rp2.store_id = sr.store_id and rp2.target_date = d.day)
      ),
      merged as (
        select store_id, product_id, qty, 0 as week_sent, true  as planned from planned
        union all
        select store_id, product_id, 0 as qty, week_sent, false as planned from standing
      )
      select coalesce(rn.id::text, '')                       as run_id,
             rn.name                                         as run_name,
             s.id::text                                      as store_id,
             s.name                                          as store_name,
             s.retailer::text                                as retailer,
             coalesce(s.delivery_days::text[], '{}'::text[]) as delivery_days,
             p.id::text                                      as product_id,
             p.name                                          as product_name,
             m.qty, m.week_sent, m.planned
        from merged m
        join stores s   on s.id = m.store_id and s.active
        join products p on p.id = m.product_id
        left join store_run_overrides ovr
               on ovr.store_id = s.id and ovr.day = (select w from wd)
        left join runs rn
               on rn.id = coalesce(ovr.run_id, s.default_run_id)
       -- Planned rows pass through as before. A standing row only appears on a
       -- day that store is actually delivered.
       where m.planned or (select w from wd) = any(s.delivery_days)
       order by rn.name nulls last, s.name, p.name`;

    // The weekly standing order becomes one day's drop through the SAME helper
    // the Deliveries sheet uses, so the two pages cannot disagree about what
    // Thursday means. They already did once: /deliveries reads store_reco with
    // no date filter and apportions it, /packing read replenishment_plans by
    // date, and on 30 Aug they said 4,659 and 1,778 for the same day.
    const mult = dowMultipliers(shape);
    const dayIdx = dayIndexFromISO(day);

    const byRun = new Map<string, PackRun>();
    for (const r of rows) {
      const qty = r.planned
        ? r.qty
        : dayShare(r.week_sent, r.delivery_days ?? [], dayIdx, mult);
      // A standing order that rounds to nothing on this day is not packed.
      if (qty <= 0) continue;

      const rid = r.run_id || "unassigned";
      let run = byRun.get(rid);
      if (!run) {
        run = { run_id: rid, name: r.run_name ?? "No run assigned", stores: [], units: 0 };
        byRun.set(rid, run);
      }
      let st = run.stores.find((s) => s.store_id === r.store_id);
      if (!st) {
        st = { store_id: r.store_id, name: r.store_name, retailer: r.retailer, items: [], units: 0, standing: !r.planned };
        run.stores.push(st);
      }
      st.items.push({ product_id: r.product_id, name: r.product_name, qty });
      st.units += qty;
      run.units += qty;
    }
    // Biggest run first, so the packer opens on the one that takes longest.
    return [...byRun.values()].sort((a, b) => b.units - a.units);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Is the engine alive?
// ---------------------------------------------------------------------
// jb_engine_health() is from migration 045 and reads TWO sources, taking the
// later: engine_runs, and cron.job_run_details. Both are needed. jb_run_engine
// commits its log row before doing any work precisely so a 2am failure leaves
// a trace -- but a failure BEFORE that commit (the budget check, a transaction
// error, a timeout during the insert) leaves no row at all. On 26 and 27
// August the scheduled job failed exactly there, twice, and engine_runs has no
// row for either night. cron.job_run_details is the only witness.
//
// That is why the function is SECURITY DEFINER with a locked search_path: the
// app role cannot read the cron schema, and it should not be granted blanket
// access to it just for this.
//
// Migration 070 changed days_since_success from rounded fractional days to
// Sydney calendar days. The old form read 1 at midday on a morning the engine
// had run perfectly at 02:00, and read 1 for a 34-hour-old success too -- one
// number covering "fine" and "missed a night".
//
// Returns null rather than throwing. This renders on the Overview, which has
// already been blanked once by a slow query against Netlify's 10s budget; a
// health check that can take the page down with it is worse than no health
// check.
export type EngineHealth = {
  last_successful_run: Date | null;
  last_attempt: Date | null;
  last_attempt_status: string | null;
  last_attempt_message: string | null;
  days_since_success: number;
  status: "ok" | "late" | "stopped";
};
export async function getEngineHealth(): Promise<EngineHealth | null> {
  try {
    const rows = await sql<EngineHealth[]>`select * from jb_engine_health()`;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
