import "server-only";
import { sql } from "./db";

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

export async function answerQuestion(qRaw: string): Promise<Answer> {
  const q = (qRaw || "").toLowerCase().trim();
  if (!q) return { headline: "Ask about waste, stockouts, sales, or which stores need attention." };

  // ---- waste ----
  if (q.includes("waste") || q.includes("wasting") || q.includes("throwing")) {
    const rows = await sql<{ name: string; waste_pct: number; total_wasted: number }[]>`
      select name, waste_pct, total_wasted from v_store_week
      where waste_pct is not null order by waste_pct desc limit 5`;
    const [net] = await sql<{ waste_pct: number }[]>`select waste_pct from v_network_week`;
    return {
      headline: `Waste is worst at ${rows[0].name} (${rows[0].waste_pct}%) this week. Network waste is ${net.waste_pct}%.`,
      bars: rows.map((r) => ({ label: strip(r.name), value: r.waste_pct ?? 0, suffix: "%" })),
      sql: "select name, waste_pct from v_store_week order by waste_pct desc limit 5;",
    };
  }

  // ---- stockouts / sold out ----
  if (q.includes("stockout") || q.includes("stock out") || q.includes("sold out") || q.includes("sunday")) {
    const rows = await sql<{ name: string; stockout_days: number }[]>`
      select name, stockout_days from v_store_week
      where stockout_days > 0 order by stockout_days desc limit 6`;
    if (!rows.length) return { headline: "No stockouts recorded this week — supply is keeping up." };
    return {
      headline: `${rows.length}+ stores hit stockouts this week. Worst: ${rows.slice(0, 3).map((r) => `${r.name} (${r.stockout_days})`).join(", ")}.`,
      bars: rows.map((r) => ({ label: strip(r.name), value: r.stockout_days })),
      note: "A stockout day = the shelf ran to zero with nothing left to expire — likely lost sales.",
      sql: "select name, stockout_days from v_store_week where stockout_days>0 order by stockout_days desc;",
    };
  }

  // ---- sales trend ----
  if (q.includes("sales") || q.includes("selling") || q.includes("sold")) {
    const [n] = await sql<{ total_sold: number }[]>`select total_sold from v_network_week`;
    const [prev] = await sql<{ s: number }[]>`
      select coalesce(sum(total_sold_prev),0)::int s from v_store_week`;
    const delta = prev.s ? Math.round((1000 * (n.total_sold - prev.s)) / prev.s) / 10 : 0;
    return {
      headline: `Sales this week: ${n.total_sold.toLocaleString("en-AU")} units, ${delta >= 0 ? "up" : "down"} ${Math.abs(delta)}% on last week (${prev.s.toLocaleString("en-AU")}).`,
      bars: [
        { label: "This week", value: n.total_sold },
        { label: "Last week", value: prev.s },
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
    return {
      headline: `${rows[0].region} needs the most attention (${rows[0].red} stores red, ${rows[0].waste_pct}% waste).`,
      bars: rows.map((r) => ({ label: r.region, value: r.waste_pct ?? 0, suffix: "%" })),
      sql: "select region, red, amber, waste_pct from v_region_week order by red desc;",
    };
  }

  return {
    headline: "I can answer waste, stockouts, sales trends, regions, and which stores need attention. Try one of the suggestions.",
  };
}
