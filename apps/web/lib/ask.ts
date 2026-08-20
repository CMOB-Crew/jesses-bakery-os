import "server-only";
import { q as sql } from "./db";

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

export async function answerQuestion(qRaw: string): Promise<Answer> {
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

  // ---- most over-supplied products / what to cut ----
  if (
    q.includes("product") || q.includes("what to cut") || q.includes("what should we cut") ||
    q.includes("over-suppl") || q.includes("oversupply") || q.includes("over order") ||
    q.includes("over-order") || q.includes("which line") || q.includes("over sending") || q.includes("over-sending") ||
    q.includes("bake less") || q.includes("bake fewer") || q.includes("make less") || q.includes("cut back")
  ) {
    const rows = await sql<{ name: string; sent: number; sold: number; rec: number; trim: number }[]>`
      select p.name, sum(r.sent)::int sent, sum(r.sold)::int sold, sum(r.recommended)::int rec,
             sum(r.sent - r.recommended)::int trim
      from store_reco r join products p on p.id = r.product_id
      group by p.name order by trim desc limit 5`;
    if (rows.length) {
      const t = rows[0];
      return {
        headline: `${title(t.name)} is the most over-supplied line — sending ${t.sent.toLocaleString("en-AU")} a week across the worst stores where ${t.sold.toLocaleString("en-AU")} sells. The plan would send ${t.rec.toLocaleString("en-AU")}.`,
        bars: rows.map((r) => ({ label: title(r.name), value: r.trim })),
        note: "Ranked by units to trim across the worst-waste Woolworths stores. Open a store for its full order.",
        sql: "select name, sum(sent) sent, sum(recommended) rec from store_reco group by name order by sum(sent-recommended) desc;",
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
    const rows = await sql<{ name: string; waste_pct: number | null; st: number | null }[]>`
      select name, waste_pct,
             case when total_sent > 0 then round(100.0 * total_sold / total_sent, 0) end as st
      from v_store_week
      where status = 'green' and total_sent > 0
      order by st desc nulls last, waste_pct asc nulls last limit 5`;
    if (!rows.length) return { headline: "No standout performers flagged on track this week yet." };
    return {
      headline: `Your best performers this week: ${rows.slice(0, 3).map((r) => `${strip(r.name)} (${r.st}% sell-through)`).join(", ")}. Low waste, high sell-through — these are the ones worth learning from, not just the ones to fix.`,
      bars: rows.map((r) => ({ label: strip(r.name), value: r.st ?? 0, suffix: "%" })),
      note: "Ranked by sell-through among stores on track. Open one to see what it's doing right.",
      sql: "select name, round(100.0*total_sold/total_sent,0) sell_through from v_store_week where status='green' order by sell_through desc limit 5;",
    };
  }

  // ---- a specific store by name (e.g. "how's Mascot doing?") ----
  {
    const stores = await sql<{ name: string; store_id: string; waste_pct: number | null; stockout_days: number; total_sold: number; total_sent: number; status: string }[]>`
      select name, store_id::text as store_id, waste_pct, stockout_days, total_sold, total_sent, status
      from v_store_week`;
    const hit = matchStore(q, stores);
    if (hit) {
      const st = hit.total_sent > 0 ? Math.round((100 * hit.total_sold) / hit.total_sent) : null;
      const verdict =
        hit.status === "red" ? "needs attention" :
        hit.status === "amber" ? "one to watch" :
        hit.status === "green" ? "on track" : "no data loaded yet";
      const bits = [
        hit.waste_pct != null ? `${hit.waste_pct}% waste` : null,
        st != null ? `${st}% sell-through` : null,
        hit.stockout_days > 0 ? `sold out ${hit.stockout_days} day${hit.stockout_days === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      return {
        headline: `${hit.name}: ${verdict}${bits.length ? ` — ${bits.join(", ")}` : ""}. Sold ${hit.total_sold.toLocaleString("en-AU")} units this week.`,
        note: "Open the store for its full product list and the recommended fix.",
        sql: `select name, waste_pct, stockout_days, total_sold from v_store_week where name = '${hit.name.replace(/'/g, "''")}';`,
      };
    }
  }

  return {
    headline: "I can answer waste, sell-outs, sales, best and worst stores, a specific store by name, products to cut, and regions. Try one of the suggestions.",
  };
}
