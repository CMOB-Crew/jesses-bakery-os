"use client";

import { useMemo, useState } from "react";
import type { DeliveryLine, DeliveryDetailLine } from "@/lib/queries";

const nf = (n: number) => n.toLocaleString("en-AU");
// short column label from a product name
function shortName(name: string) {
  return name
    .replace(/ – /g, " ")
    .replace(/Sourdough/i, "SD")
    .replace(/Bagel/i, "Bgl")
    .replace(/Challah/i, "Chal")
    .replace(/\s*\(×\d+\)/, "")
    .trim();
}
const isSourdough = (name: string) => /sourdough/i.test(name);

// The delivery sheet — the store × product cross-tab Simona knows, but live.
// Edit any cell and the row total, the column production totals and the
// production-impact panel all recalc instantly. Fed by the same plan the calm
// Deliveries sheet uses. Editing is live in this build; write-back is next phase.
export default function DeliverySheet({ plan, detail }: { plan: DeliveryLine[]; detail: DeliveryDetailLine[] }) {
  // distinct products, biggest-volume first (as columns)
  const products = useMemo(() => {
    const tot = new Map<string, number>();
    for (const d of detail) tot.set(d.product_name, (tot.get(d.product_name) || 0) + (Number(d.recommended) || 0));
    return [...tot.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [detail]);

  const stores = useMemo(() => {
    const seen = new Set(detail.map((d) => d.store_id));
    return plan.filter((p) => seen.has(p.store_id));
  }, [plan, detail]);

  // cell state: `${store_id}::${product}` -> qty
  const initial = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of detail) m[`${d.store_id}::${d.product_name}`] = Number(d.recommended) || 0;
    return m;
  }, [detail]);
  const [cells, setCells] = useState<Record<string, number>>(initial);
  const [flash, setFlash] = useState<string | null>(null);
  // Honest status: edits live in the browser only (write-back is next phase), so
  // never claim "saved" or "sent to packers & production" — that would be false.
  const [saved, setSaved] = useState("Working draft · resets on reload");

  const cell = (sid: string, p: string) => cells[`${sid}::${p}`] ?? 0;
  function setCell(sid: string, p: string, val: number) {
    const n = Math.max(0, Math.floor(Number(val) || 0));
    setCells((c) => ({ ...c, [`${sid}::${p}`]: n }));
    setFlash(`${sid}::${p}`);
    setSaved("Draft updated · not yet sent to packers & production");
  }

  const rowTotal = (sid: string) => products.reduce((a, p) => a + cell(sid, p), 0);
  const colTotal = (p: string) => stores.reduce((a, s) => a + cell(s.store_id, p), 0);
  const grand = stores.reduce((a, s) => a + rowTotal(s.store_id), 0);
  const colMax = Math.max(1, ...products.map(colTotal));

  const sdProducts = products.filter(isSourdough);
  const bkProducts = products.filter((p) => !isSourdough(p));
  const sdTotal = sdProducts.reduce((a, p) => a + colTotal(p), 0);
  const bkTotal = bkProducts.reduce((a, p) => a + colTotal(p), 0);

  if (stores.length === 0 || products.length === 0) {
    return (
      <div className="panel">
        <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>The grid warms up with the plan</div>
        <div style={{ color: "var(--ink2)", maxWidth: 560, lineHeight: 1.6 }}>The store × product sheet is built from the engine&apos;s per-store plan on the mature Woolworths feed. It fills in here as the plan is written.</div>
      </div>
    );
  }

  return (
    <section className="dsheet">
      <div className="dhead">
        <div className="save"><span>{saved}</span></div>
      </div>

      <div className="layout">
        <div className="sheetwrap">
          <table>
            <thead>
              <tr>
                <th className="store">Store</th>
                {products.map((p) => <th key={p} title={p}>{shortName(p)}</th>)}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((s) => {
                const tot = rowTotal(s.store_id);
                return (
                  <tr key={s.store_id}>
                    <td className="store"><span className="snm">{s.name}</span><small>{s.region ?? "—"}</small></td>
                    {products.map((p) => {
                      const k = `${s.store_id}::${p}`;
                      return (
                        <td key={p}>
                          <input
                            className={`cell ${cell(s.store_id, p) === 0 ? "z" : ""}${flash === k ? " flash" : ""}`}
                            value={cell(s.store_id, p)}
                            inputMode="numeric"
                            onChange={(e) => setCell(s.store_id, p, parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)}
                            onFocus={(e) => e.currentTarget.select()}
                          />
                        </td>
                      );
                    })}
                    <td className="rowtot">{nf(tot)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="store">Production total</td>
                {products.map((p) => <td key={p}>{nf(colTotal(p))}</td>)}
                <td>{nf(grand)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="prod">
          <div className="pcard">
            <h3>Production impact</h3>
            <div className="pt">What the bakery makes for this run, live</div>
            <div className="team">
              <div className="th"><span>Sourdough team</span><span className="lead">baked 2 days ahead</span></div>
              {sdProducts.map((p) => {
                const v = colTotal(p);
                return <div className="prow" key={p}><span className="nm">{p}</span><span className="bar"><i style={{ width: `${(100 * v) / colMax}%` }} /></span><span className="v">{nf(v)}</span></div>;
              })}
              {sdProducts.length === 0 && <div className="pnone">No sourdough on this run.</div>}
              <div className="sub"><span>Sourdough team total</span><span>{nf(sdTotal)}</span></div>
            </div>
            <div className="team">
              <div className="th"><span>Bakery team</span><span className="lead">baked the day before</span></div>
              {bkProducts.map((p) => {
                const v = colTotal(p);
                return <div className="prow" key={p}><span className="nm">{p}</span><span className="bar"><i style={{ width: `${(100 * v) / colMax}%` }} /></span><span className="v">{nf(v)}</span></div>;
              })}
              {bkProducts.length === 0 && <div className="pnone">Nothing else on this run.</div>}
              <div className="sub"><span>Bakery team total</span><span>{nf(bkTotal)}</span></div>
            </div>
          </div>
          <div className="note">Change any cell — the production totals update instantly. Sourdough is baked <b>2 days ahead</b> (lead time 2 days); everything else is baked the day before. Editing is live in this build; writing the run back to packers &amp; production is the next phase.</div>
        </div>
      </div>

      <style>{`
      .dsheet{display:block;padding-bottom:40px}
      .dsheet .dhead{display:flex;align-items:center;margin-bottom:14px}
      .dsheet .save{margin-left:auto;font-size:12.5px;color:var(--muted);font-weight:600}
      .dsheet .layout{display:grid;grid-template-columns:1fr 300px;gap:18px;align-items:start}
      @media(max-width:1080px){.dsheet .layout{grid-template-columns:1fr}}
      .dsheet .sheetwrap{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:auto}
      .dsheet table{width:100%;border-collapse:collapse}
      .dsheet th{font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);font-weight:700;padding:12px 10px;border-bottom:1px solid var(--line);text-align:center;white-space:nowrap}
      /* Even, breathable number columns. */
      .dsheet th:not(.store), .dsheet td:not(.store){min-width:62px}
      .dsheet th.store{text-align:left;padding-left:16px;position:sticky;left:0;background:var(--card);z-index:2;width:250px;min-width:250px;max-width:250px;border-right:1px solid var(--line)}
      .dsheet td{padding:10px 12px;border-bottom:1px solid var(--line2);text-align:center}
      /* Freeze the Store column at a fixed width and truncate the odd very-long
         name (e.g. "Woolworths Marrickville Metro Shopping Centre") so one outlier
         no longer blows the column wide and pushes every number far right. */
      .dsheet td.store{text-align:left;padding-left:16px;font-weight:600;font-size:13.5px;position:sticky;left:0;background:var(--card);white-space:nowrap;z-index:1;width:250px;min-width:250px;max-width:250px;border-right:1px solid var(--line)}
      .dsheet td.store .snm{display:block;overflow:hidden;text-overflow:ellipsis}
      .dsheet td.store small{display:block;color:var(--muted);font-weight:400;font-size:11.5px;overflow:hidden;text-overflow:ellipsis}
      .dsheet tr:last-child td{border-bottom:none}
      /* Zebra rows + dimmed zeros keep a wide, dense grid readable. Cells read as
         plain numbers on the row and only light up as editable on hover/focus. */
      .dsheet tbody tr:nth-child(even) td{background:#fbf8f1}
      .dsheet tbody tr:nth-child(even) td.store{background:#fbf8f1}
      .dsheet tbody tr:hover td{background:#f5efe3}
      .dsheet tbody tr:hover td.store{background:#f5efe3}
      .dsheet input.cell{width:52px;padding:6px 4px;border:1px solid transparent;border-radius:8px;background:transparent;font-family:inherit;font-size:14px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums;color:var(--ink);outline:none;transition:background .12s,border-color .12s}
      .dsheet input.cell.z{color:var(--faint);font-weight:400}
      .dsheet input.cell:hover{border-color:var(--line);background:var(--card)}
      .dsheet input.cell:focus{border-color:var(--crust);background:#fff;box-shadow:0 0 0 3px rgba(176,116,28,.13);color:var(--ink);font-weight:600}
      .dsheet input.cell.flash{animation:dsfl .6s}
      @keyframes dsfl{0%{background:#fbeed2}100%{background:transparent}}
      .dsheet td.rowtot{font-weight:700;font-variant-numeric:tabular-nums;font-size:13.5px}
      .dsheet tfoot td{border-top:2px solid var(--line);font-weight:700;font-variant-numeric:tabular-nums;padding:12px 8px;font-size:13.5px;background:var(--surface)}
      .dsheet tfoot td.store{background:var(--surface)}
      .dsheet .prod{position:sticky;top:16px;display:flex;flex-direction:column;gap:14px}
      .dsheet .pcard{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:18px 20px}
      .dsheet .pcard h3{font-family:var(--serif);font-size:16px;font-weight:600;margin-bottom:3px}
      .dsheet .pcard .pt{font-size:11.5px;color:var(--muted);margin-bottom:14px}
      .dsheet .team{margin-bottom:16px}
      .dsheet .team:last-child{margin-bottom:0}
      .dsheet .team .th{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--crust-deep);font-weight:700;display:flex;justify-content:space-between;align-items:baseline}
      .dsheet .team .lead{font-size:11px;color:var(--muted);text-transform:none;letter-spacing:0;font-weight:500}
      .dsheet .team .prow{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line2)}
      .dsheet .team .prow:last-child{border:none}
      .dsheet .team .prow .nm{flex:1;font-size:13.5px}
      .dsheet .team .prow .bar{width:70px;height:7px;background:#f0e9db;border-radius:5px;overflow:hidden}
      .dsheet .team .prow .bar i{display:block;height:100%;background:var(--crust);border-radius:5px;transition:width .25s}
      .dsheet .team .prow .v{width:40px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;font-size:13.5px}
      .dsheet .team .pnone{font-size:12.5px;color:var(--faint);padding:6px 0}
      .dsheet .team .sub{display:flex;justify-content:space-between;font-size:12.5px;font-weight:700;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
      .dsheet .note{background:var(--amber-b);border:1px solid #ecdcbb;border-radius:10px;padding:11px 13px;font-size:12.5px;color:var(--amber-t);line-height:1.5}
      `}</style>
    </section>
  );
}
