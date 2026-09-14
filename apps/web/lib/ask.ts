import "server-only";
import { aq as sql, withAssistant } from "./db";
import { scoreStore, isMeasured, SCORE_LABEL, scoreNote } from "./store-scoring";

/**
 * Deterministic NL assistant core. The question is routed by keyword to a
 * fixed set of *parameterised* queries — the model never writes SQL, so it
 * can't hallucinate numbers. Each answer returns a plain-English headline,
 * an optional small bar series for the UI, and the query used (for the
 * "how I got this" disclosure). This is the safe v1 recommended in the
 * Quality Bar; an LLM can later sit on top purely to phrase/route.
 */
export type Bar = { label: string; value: number; suffix?: string };
export type Answer = { headline: string; bars?: Bar[]; note?: string; sql?: string };

const strip = (name: string) => name.replace(/^(Coles|Woolworths|Harris Farm)\s+/i, "");

// Find the store a question is asking about by name. Scores each store on how
// many of its distinctive name tokens (>=4 chars, retailer prefix removed)
// appear in the question, weighted by token length, so "how's mascot doing"
// resolves to Woolworths Mascot. Requires a solid hit (>=4) to avoid matching
// on stray short words.
function matchStore<T extends { name: string }>(q: string, stores: T[]): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const s of stores) {
    const toks = strip(s.name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    let score = 0;
    for (const t of toks) if (q.includes(t)) score += t.length;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 4 ? best : null;
}

/**
 * The assistant's one entry point.
 *
 * CONDITION 2. Everything below runs inside a READ ONLY transaction with
 * the signed-in user's RLS claims injected transaction-locally. Postgres
 * refuses a write in one, so no branch of this file can become a write --
 * including a branch nobody has written yet.
 *
 * Wrapped HERE and not in app/api/ask/route.ts on purpose. A wrapper at
 * the route protects the route; a wrapper here protects the function, and
 * the next caller cannot forget it. The unwrapped body is not exported.
 *
 * See lib/db.ts (withAssistant) for why, and
 * scripts/assistant-is-read-only-check.ts for the proof.
 */
export async function answerQuestion(qRaw: string): Promise<Answer> {
  return withAssistant(() => answerQuestionInner(qRaw));
}

async function answerQuestionInner(qRaw: string): Promise<Answer> {
  const q = (qRaw || "").toLowerCase().trim();
  if (!q) return { headline: "Ask about waste, sell-outs, sales, or which stores need attention." };

  const title = (t: string) => t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

  // ---- engine savings / how much can we cut waste ----
  if (
    q.includes("save") || q.includes("saving") || q.includes("engine") ||
    q.includes("potential") || q.includes("reduce waste") || q.includes("cut waste") ||
    q.includes("how much can")
  ) {
    const rows = await sql<{ scenario: string; label: string; waste_pct: number; lost_sales_pct: number | null; units_saved_wk: number }[]>`
      select scenario, label, waste_pct, lost_sales_pct, units_saved_wk from engine_projection order by ord`;
    const cur = rows.find((r) => r.scenario === "current");
    const bal = rows.find((r) => r.scenario === "balanced");
    if (cur && bal) {
      return {
        headline: `The plan cuts Woolworths waste from ${cur.waste_pct}% to ${bal.waste_pct}% at a balanced setting — about ${bal.units_saved_wk.toLocaleString("en-AU")} loaves a week (~${(bal.units_saved_wk * 52).toLocaleString("en-AU")} a year). Push to the lean setting and it drops under 20%.`,
        bars: rows.map((r) => ({ label: r.label, value: r.waste_pct ?? 0, suffix: "%" })),
        note: "Woolworths feed. Dollar savings unlock once we have cost-per-product.",
        sql: "select label, waste_pct, units_saved_wk from engine_projection order by ord;",
      };
    }
  }

  // ---- a product category (bagels / sourdough / challah ...) ----
  // Placed before the waste/sales intents so "how's sourdough waste" resolves to
  // the category rollup rather than the network waste ranking.
  {
    const CATS: { kw: string[]; cat: string; label: string }[] = [
      { kw: ["sourdough"], cat: "sourdough", label: "Sourdough" },
      { kw: ["bagel"], cat: "bagel", label: "Bagels" },
      { kw: ["challah"], cat: "challah", label: "Challah" },
      { kw: ["pita"], cat: "pita", label: "Pita" },
      { kw: ["babka", "pastry"], cat: "pastry", label: "Pastry" },
      { kw: ["cake"], cat: "cake", label: "Cakes" },
    ];
    const catHit = CATS.find((c) => c.kw.some((k) => q.includes(k)));
    if (catHit) {
      // MEASURED, not the go-live snapshot.
      //
      // This used to read store_reco.sent and store_reco.sold. NOTHING HAS
      // EVER WRITTEN EITHER COLUMN -- 0 of 588 rows carry a value, and every
      // migration that touches the table (033, 088, 089) sets only
      // `recommended`. So the answer came from whatever the legacy load put
      // there, presented under a label reading "Live query" on a screen that
      // promises "exact numbers, never guessed".
      //
      // 91d8eeb fixed exactly this on the Products page on 10 September and
      // did not reach here. Same window and the same ranging filter as
      // v_store_week and Products, so the three cannot disagree about what a
      // week is.
      const perProd = await sql<{ name: string; delivered: number; sold: number; standing: number; rec: number }[]>`
        select p.name,
               coalesce(sum(dv.delivered), 0)::int as delivered,
               coalesce(sum(sd.sold), 0)::int      as sold,
               coalesce(sum(r.sent), 0)::int       as standing,
               sum(r.recommended)::int             as rec
        from store_reco r
        join products p on p.id = r.product_id
        left join v_store_product_delivered dv
               on dv.store_id = r.store_id and dv.product_id = r.product_id
        left join (
          select s.store_id, s.product_id, sum(s.units_sold)::int as sold
            from sales_daily s
            left join store_product_ranging rg
              on rg.store_id = s.store_id and rg.product_id = s.product_id
           where s.sale_date >  jb_asof() - 7
             and s.sale_date <= jb_asof()
             and coalesce(rg.ranged, true)
           group by s.store_id, s.product_id
        ) sd on sd.store_id = r.store_id and sd.product_id = r.product_id
        where p.category = ${catHit.cat}::product_category
        group by p.name
        order by coalesce(sum(dv.delivered), 0) desc, p.name
        limit 6`;
      if (perProd.length) {
        const delivered = perProd.reduce((a, r) => a + r.delivered, 0);
        const sold = perProd.reduce((a, r) => a + r.sold, 0);
        const standing = perProd.reduce((a, r) => a + r.standing, 0);
        const rec = perProd.reduce((a, r) => a + r.rec, 0);
        const disclose = `select p.name, sum(dv.delivered) delivered, sum(sd.sold) sold from store_reco r join products p on p.id=r.product_id left join v_store_product_delivered dv on dv.store_id=r.store_id and dv.product_id=r.product_id left join (select store_id, product_id, sum(units_sold) sold from sales_daily where sale_date > jb_asof()-7 and sale_date <= jb_asof() group by 1,2) sd on sd.store_id=r.store_id and sd.product_id=r.product_id where p.category='${catHit.cat}' group by p.name;`;

        // NOTHING DELIVERED IN THE WINDOW IS THE TRUTH TODAY, NOT AN ERROR.
        // 799 of the 801 delivery rows were seeded in one go on 24 August and
        // the driver app has been used twice. Printing "0 sells" as though it
        // were a finding is the exact shape of the bug this replaced, so say
        // what is actually known instead of dressing a zero as a measurement.
        if (delivered === 0) {
          return {
            headline: `${catHit.label}: no deliveries have been confirmed in the last seven days, so there is nothing measured to report yet. The standing order is ${standing.toLocaleString("en-AU")} a week across ${perProd.length} line${perProd.length === 1 ? "" : "s"}, and the plan would send ${rec.toLocaleString("en-AU")}.`,
            bars: perProd.map((r) => ({ label: title(r.name), value: r.standing })),
            note: "Standing order and plan, not measurement. Sell-through fills in as drivers confirm deliveries.",
            sql: disclose,
          };
        }

        const st = Math.round((100 * sold) / delivered);
        return {
          headline: `${catHit.label}: ${delivered.toLocaleString("en-AU")} delivered in the last seven days across ${perProd.length} line${perProd.length === 1 ? "" : "s"}, ${sold.toLocaleString("en-AU")} sold — ${st}% sell-through. The plan would send ${rec.toLocaleString("en-AU")}.`,
          bars: perProd.map((r) => ({ label: title(r.name), value: r.delivered })),
          note: `${catHit.label} lines by units delivered in the seven days ending the last complete sales day. Open Products for the full per-line waste and difference.`,
          sql: disclose,
        };
      }
    }
  }

  // ---- most over-supplied products / what to cut ----
  if (
    q.includes("product") || q.includes("what to cut") || q.includes("what should we cut") ||
    q.includes("over-suppl") || q.includes("oversupply") || q.includes("over order") ||
    q.includes("over-order") || q.includes("which line") || q.includes("over sending") || q.includes("over-sending") ||
    q.includes("bake less") || q.includes("bake fewer") || q.includes("make less") || q.includes("cut back")
  ) {
    // MEASURED. See the note on the category rollup above -- same two dead
    // columns, same fix. This one matters more because "What should we cut?"
    // is a SUGGESTION CHIP on the Overview and on /assistant, so it is one of
    // the first things anybody clicks.
    //
    // It also used to be RANKED UPSIDE DOWN. `trim` was sent - recommended
    // computed from a column of zeros, so the line it named as most
    // over-supplied was whichever had the smallest cut.
    //
    // Over-supply is now delivered minus sold: what went out and did not
    // sell. That is what the question actually asks, and it is the same
    // ordering the Products page uses.
    const rows = await sql<{ name: string; delivered: number; sold: number; standing: number; rec: number; over: number }[]>`
      select p.name,
             coalesce(sum(dv.delivered), 0)::int as delivered,
             coalesce(sum(sd.sold), 0)::int      as sold,
             coalesce(sum(r.sent), 0)::int       as standing,
             sum(r.recommended)::int             as rec,
             (coalesce(sum(dv.delivered), 0) - coalesce(sum(sd.sold), 0))::int as over
        from store_reco r
        join products p on p.id = r.product_id
        left join v_store_product_delivered dv
               on dv.store_id = r.store_id and dv.product_id = r.product_id
        left join (
          select s.store_id, s.product_id, sum(s.units_sold)::int as sold
            from sales_daily s
            left join store_product_ranging rg
              on rg.store_id = s.store_id and rg.product_id = s.product_id
           where s.sale_date >  jb_asof() - 7
             and s.sale_date <= jb_asof()
             and coalesce(rg.ranged, true)
           group by s.store_id, s.product_id
        ) sd on sd.store_id = r.store_id and sd.product_id = r.product_id
      group by p.name
      order by over desc, p.name
      limit 5`;
    if (rows.length) {
      const t = rows[0];
      const disclose = `select p.name, sum(dv.delivered) delivered, sum(sd.sold) sold, sum(r.recommended) rec from store_reco r join products p on p.id=r.product_id left join v_store_product_delivered dv on dv.store_id=r.store_id and dv.product_id=r.product_id left join (select store_id, product_id, sum(units_sold) sold from sales_daily where sale_date > jb_asof()-7 and sale_date <= jb_asof() group by 1,2) sd on sd.store_id=r.store_id and sd.product_id=r.product_id group by p.name order by sum(dv.delivered)-sum(sd.sold) desc;`;

      // Nothing measured yet is an honest answer. A confident one built from
      // zeros is what this screen was doing before.
      if (t.delivered === 0) {
        return {
          headline: `Nothing can be measured yet — no deliveries have been confirmed in the last seven days, so there is no sell-through to cut against. The plan already trims the standing order from ${rows.reduce((a, r) => a + r.standing, 0).toLocaleString("en-AU")} to ${rows.reduce((a, r) => a + r.rec, 0).toLocaleString("en-AU")} a week on these five lines.`,
          bars: rows.map((r) => ({ label: title(r.name), value: r.standing - r.rec })),
          note: "Standing order against the plan, not measurement. Ask again once drivers have been confirming deliveries for a week.",
          sql: disclose,
        };
      }

      return {
        headline: `${title(t.name)} is the most over-supplied line — ${t.delivered.toLocaleString("en-AU")} delivered in the last seven days and ${t.sold.toLocaleString("en-AU")} sold, so ${t.over.toLocaleString("en-AU")} did not sell. The plan would send ${t.rec.toLocaleString("en-AU")}.`,
        bars: rows.map((r) => ({ label: title(r.name), value: r.over })),
        note: "Ranked by units delivered and not sold in the seven days ending the last complete sales day. Open a store for its full order.",
        sql: disclose,
      };
    }
  }

  // ---- waste ----
  if (q.includes("waste") || q.includes("wasting") || q.includes("throwing")) {
    const rows = await sql<{ name: string; waste_pct: number; total_wasted: number }[]>`
      select name, waste_pct, total_wasted from v_store_week
      where waste_pct is not null order by waste_pct desc limit 5`;
    const [net] = await sql<{ waste_pct: number }[]>`select waste_pct from v_network_week`;
    if (!rows.length || !net) return { headline: "No waste data yet — it fills in as the retailer feeds land." };
    return {
      headline: `Waste is worst at ${rows[0].name} (${rows[0].waste_pct}%) this week. Network waste is ${net.waste_pct}%.`,
      bars: rows.map((r) => ({ label: strip(r.name), value: r.waste_pct ?? 0, suffix: "%" })),
      sql: "select name, waste_pct from v_store_week order by waste_pct desc limit 5;",
    };
  }

  // ---- sell-outs / sold out ----
  if (q.includes("sell-out") || q.includes("sell out") || q.includes("sellout") || q.includes("stockout") || q.includes("stock out") || q.includes("sold out") || q.includes("sunday")) {
    const rows = await sql<{ name: string; stockout_days: number }[]>`
      select name, stockout_days from v_store_week
      where stockout_days > 0 order by stockout_days desc limit 6`;
    if (!rows.length) return { headline: "No sell-outs recorded this week — supply is keeping up." };
    return {
      headline: `${rows.length}+ stores sold out this week. Worst: ${rows.slice(0, 3).map((r) => `${r.name} (${r.stockout_days})`).join(", ")}.`,
      bars: rows.map((r) => ({ label: strip(r.name), value: r.stockout_days })),
      note: "A sold-out day = the shelf ran to zero with nothing left to expire — likely lost sales.",
      sql: "select name, stockout_days from v_store_week where stockout_days>0 order by stockout_days desc;",
    };
  }

  // ---- sales trend ----
  if (q.includes("sales") || q.includes("selling") || q.includes("sold")) {
    const [n] = await sql<{ total_sold: number }[]>`select total_sold from v_network_week`;
    const [prev] = await sql<{ s: number }[]>`
      select coalesce(sum(total_sold_prev),0)::int s from v_store_week`;
    if (!n) return { headline: "No sales loaded yet for this week — it lands with the retailer feed." };
    const prevS = prev?.s ?? 0;
    const delta = prevS ? Math.round((1000 * (n.total_sold - prevS)) / prevS) / 10 : 0;
    return {
      headline: `Sales this week: ${n.total_sold.toLocaleString("en-AU")} units${prevS ? `, ${delta >= 0 ? "up" : "down"} ${Math.abs(delta)}% on last week (${prevS.toLocaleString("en-AU")})` : ""}.`,
      bars: [
        { label: "This week", value: n.total_sold },
        { label: "Last week", value: prevS },
      ],
      sql: "select sum(total_sold) this_week, sum(total_sold_prev) last_week from v_store_week;",
    };
  }

  // ---- which stores / attention ----
  if (q.includes("attention") || q.includes("need") || q.includes("worst store") || q.includes("problem") || q.includes("red")) {
    const [net] = await sql<{ red: number }[]>`select red from v_network_week`;
    const rows = await sql<{ name: string; total_wasted: number; waste_pct: number }[]>`
      select name, total_wasted, waste_pct from v_store_week
      where status = 'red' order by total_wasted desc limit 5`;
    if (!net || !net.red || !rows.length) return { headline: "Everything's on track — no stores flagged red this week." };
    return {
      headline: `${net.red} stores need attention. Biggest waste: ${rows.slice(0, 3).map((r) => r.name).join(", ")}.`,
      bars: rows.map((r) => ({ label: strip(r.name), value: r.total_wasted })),
      note: "Ranked by loaves wasted. Open a store to see the recommended fix.",
      sql: "select name from v_store_week where status='red' order by total_wasted desc;",
    };
  }

  // ---- regions ----
  if (q.includes("region") || q.includes("area") || q.includes("suburb")) {
    const rows = await sql<{ region: string; red: number; amber: number; waste_pct: number }[]>`
      select region, red, amber, waste_pct from v_region_week
      order by red*10+amber desc, waste_pct desc nulls last limit 5`;
    if (!rows.length) return { headline: "No regional data yet — it fills in as store feeds land." };
    return {
      headline: `${rows[0].region} needs the most attention (${rows[0].red} stores red, ${rows[0].waste_pct}% waste).`,
      bars: rows.map((r) => ({ label: r.region, value: r.waste_pct ?? 0, suffix: "%" })),
      sql: "select region, red, amber, waste_pct from v_region_week order by red desc;",
    };
  }

  // ---- best performers / stores doing well ----
  if (
    q.includes("best") || q.includes("top perform") || q.includes("doing well") ||
    q.includes("strongest") || q.includes("high perform") || q.includes("star store")
  ) {
    // Exclude the direct-invoice channel: those stores invoice exactly what they
    // sell (~100% sell-through, 0 waste by definition), so they'd trivially top
    // the list and aren't a model for retail-shelf management. Retail standouts
    // are the ones worth learning from -- same channel split the Benchmarks use.
    const rows = await sql<{ name: string; waste_pct: number | null; st: number | null }[]>`
      select name, waste_pct,
             case when total_sent > 0 then round(100.0 * total_sold / total_sent, 0) end as st
      from v_store_week
      where status = 'green' and total_sent > 0 and retailer <> 'invoice'
      order by st desc nulls last, waste_pct asc nulls last limit 5`;
    if (!rows.length) return { headline: "No standout performers flagged on track this week yet." };
    return {
      headline: `Your best performers this week: ${rows.slice(0, 3).map((r) => `${strip(r.name)} (${r.st}% sell-through)`).join(", ")}. Low waste, high sell-through — these are the ones worth learning from, not just the ones to fix.`,
      bars: rows.map((r) => ({ label: strip(r.name), value: r.st ?? 0, suffix: "%" })),
      note: "Ranked by sell-through among stores on track. Open one to see what it's doing right.",
      sql: "select name, round(100.0*total_sold/total_sent,0) sell_through from v_store_week where status='green' order by sell_through desc limit 5;",
    };
  }

  // ---- what's going to a specific store this week (its delivery) ----
  // Needs a delivery cue + a store name, so it beats the generic store lookup
  // below for "what's going to Bondi?" but leaves "how's Bondi?" to it.
  if (
    q.includes("going to") || q.includes("deliver") || q.includes("delivery") ||
    q.includes("sending") || q.includes("send to") || q.includes("this week to") ||
    q.includes("order for") || q.includes("what's going") || q.includes("whats going")
  ) {
    const stores = await sql<{ name: string; store_id: string }[]>`select name, store_id::text as store_id from v_store_week`;
    const hit = matchStore(q, stores);
    if (hit) {
      const lines = await sql<{ name: string; qty: number }[]>`
        select p.name, coalesce(o.qty, r.recommended)::int as qty
        from store_reco r
        join products p on p.id = r.product_id
        left join store_product_overrides o
          on o.store_id = r.store_id and o.product_id = r.product_id
          and (o.mode = 'perm' or o.ends_on is null or o.ends_on >= current_date)
        where r.store_id = ${hit.store_id}::uuid
        order by qty desc limit 8`;
      if (lines.length) {
        return {
          headline: `${hit.name} — biggest lines this week: ${lines.slice(0, 3).map((l) => `${title(l.name)} (${l.qty})`).join(", ")}.`,
          bars: lines.map((l) => ({ label: title(l.name), value: l.qty })),
          note: "The plan's recommended send with any adjustments folded in — top lines shown. Open the store for the full order and to change a line.",
          sql: `select p.name, coalesce(o.qty,r.recommended) qty from store_reco r join products p on p.id=r.product_id left join store_product_overrides o on o.store_id=r.store_id and o.product_id=r.product_id where r.store_id='${hit.store_id}' order by qty desc;`,
        };
      }
    }
  }

  // ---- a specific store by name (e.g. "how's Mascot doing?") ----
  {
    // retailer and has_sales_feed are selected because the scoring rule needs
    // them. This block used to read `status` straight out of the view and map
    // green to "on track", which meant asking after any store on 10 September
    // got "on track" -- 273 of 273, none of them assessed. Same hole as the
    // Overview's on 7 September, in the one place where somebody has typed a
    // store's name specifically to be told how it is doing.
    const stores = await sql<{ name: string; store_id: string; retailer: string; has_sales_feed: boolean | null; waste_pct: number | null; stockout_days: number | null; total_sold: number; total_sent: number; status: string }[]>`
      select name, store_id::text as store_id, retailer, has_sales_feed,
             waste_pct, stockout_days, total_sold, total_sent, status
      from v_store_week`;
    const hit = matchStore(q, stores);
    if (hit) {
      const st = hit.total_sent > 0 ? Math.round((100 * hit.total_sold) / hit.total_sent) : null;
      const score = scoreStore({
        retailer: hit.retailer, has_sales_feed: hit.has_sales_feed,
        sent: hit.total_sent, sold: hit.total_sold, status: hit.status,
      });
      const verdict = isMeasured(score)
        ? (score === "red" ? "needs attention" : score === "amber" ? "one to watch" : "on track")
        : SCORE_LABEL[score].toLowerCase();
      const bits = [
        hit.waste_pct != null ? `${hit.waste_pct}% waste` : null,
        st != null ? `${st}% sell-through` : null,
        // Null is "nobody counted the shelf" and 0 is "counted, never emptied"
        // since migration 093. Neither is worth a phrase; only a real count is.
        (hit.stockout_days ?? 0) > 0 ? `sold out ${hit.stockout_days} day${hit.stockout_days === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      return {
        headline: `${hit.name}: ${verdict}${bits.length ? ` — ${bits.join(", ")}` : ""}. Sold ${hit.total_sold.toLocaleString("en-AU")} units this week.`,
        note: scoreNote(score) ?? "Open the store for its full product list and the recommended fix.",
        sql: `select name, waste_pct, stockout_days, total_sold from v_store_week where name = '${hit.name.replace(/'/g, "''")}';`,
      };
    }
  }

  return {
    headline: "I can answer waste, sell-outs, sales, best and worst stores, a specific store by name, products to cut, and regions. Try one of the suggestions.",
  };
}
