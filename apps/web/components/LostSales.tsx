"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import type { LostSales } from "@/lib/queries";
import { applyStockoutFixes } from "@/app/store/actions";

/* ------------------------------------------------------------------ *
 * Lost sales / stockouts — the availability mirror of waste, live from
 * v_store_week.stockout_days. Reported waste doesn't exist (Waste_Qty is
 * all-zero), so inferred sellouts are the only read on lost demand. Sized
 * "lift" fixes come from the plan where a store is under-supplied.
 * ------------------------------------------------------------------ */

const CONF = { high: { label: "High confidence", c: "var(--green-t)", b: "var(--green-b)" }, medium: { label: "Worth a look", c: "var(--amber-t)", b: "var(--amber-b)" } };

export default function LostSales({ data }: { data: LostSales }) {
  const [resolved, setResolved] = useState<Record<string, "applied" | "dismissed">>({});
  const open = data.losses.filter((l) => !resolved[l.id]);
  const totalLostWk = useMemo(() => open.reduce((a, l) => a + l.lostWk, 0), [open]);
  const storesFlagged = useMemo(() => new Set(open.map((l) => l.store)).size, [open]);
  const repeatCount = open.filter((l) => l.repeat).length;
  // Only high-confidence sellouts that carry a store+product+sized fix can be
  // written; anything without a sized target stays a manual, per-card decision.
  const highFixable = useMemo(
    () => open.filter((l) => l.conf === "high" && l.store_id && l.product_id && l.suggested != null),
    [open],
  );
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saving, startSave] = useTransition();
  function showToast(m: string) {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }
  // Lost revenue only once every open sellout has a reading (the Invoice_Cost
  // feed is loaded); otherwise null and the tile keeps its "$ —" placeholder.
  const lostRevenueWk = useMemo(
    () => (open.length > 0 && open.every((l) => l.lostRevenueWk != null)
      ? open.reduce((a, l) => a + (l.lostRevenueWk ?? 0), 0)
      : null),
    [open],
  );

  function apply(id: string) { setResolved((r) => ({ ...r, [id]: "applied" })); }
  function dismiss(id: string) { setResolved((r) => ({ ...r, [id]: "dismissed" })); }
  // Persist every high-confidence sized fix at once — the same override write as
  // a single Adjust, so all of them flow into the delivery + production plan.
  function applyAllHigh() {
    const targets = highFixable;
    if (!targets.length) return;
    const fixes = targets.map((l) => ({ storeId: l.store_id as string, productId: l.product_id as string, qty: l.suggested as number }));
    const ids = targets.map((l) => l.id);
    startSave(async () => {
      const res = await applyStockoutFixes(fixes);
      if (res.ok) {
        setResolved((r) => { const n = { ...r }; for (const id of ids) n[id] = "applied"; return n; });
        showToast(res.readonly
          ? `Applied ${res.count} fix${res.count === 1 ? "" : "es"} — preview only (this demo doesn't save changes)`
          : `Applied ${res.count} fix${res.count === 1 ? "" : "es"} — saved to those stores' plans`);
      } else {
        showToast(`Couldn't apply: ${res.error}`);
      }
    });
  }

  return (
    <div className="losts">
      {!data.hasData ? (
        <>
          <div className="panel intro">
            <div className="itxt">
              The mirror of waste — where stores <b>sell out early</b> and turn demand away. It reads from the on-hand ledger
              (a sold-out day = the shelf hit zero with nothing left to expire). No sell-outs flagged this week; as the ledger
              accumulates across Coles and Harris Farm, sell-outs surface here with a sized fix.
            </div>
          </div>
          <div className="strip">
            <div className="tile"><div className="tn dim">—</div><div className="tl">Estimated lost sales · units/wk</div></div>
            <div className="tile"><div className="tn dim">—</div><div className="tl">Stores flagged</div></div>
            <div className="tile"><div className="tn dim">$ —</div><div className="tl">Lost revenue / wk · lights up with the price feed</div></div>
            <div className="tile"><div className="tn dim">—</div><div className="tl">Repeat sellouts · 3+ days out</div></div>
          </div>
          <div className="emptyhint">Nothing to action this week — the moment a store runs dry before its next drop, the sellout and a sized fix appear here.</div>
        </>
      ) : (
      <>
      <div className="panel intro">
        <div className="itxt">
          The mirror of waste. Waste is baking too much; <b>lost sales is selling out early</b> and turning demand away —
          invisible on the reports because retailers only send what <i>sold</i>, never what someone wanted and couldn&apos;t get.
          These come straight from the on-hand ledger: a sold-out day is the shelf hitting zero before the next drop.
        </div>
      </div>

      <div className="strip">
        <div className="tile"><div className="tn">{totalLostWk}<span className="u"> units/wk</span></div><div className="tl">Estimated lost sales</div></div>
        <div className="tile"><div className="tn">{storesFlagged}</div><div className="tl">Stores flagged</div></div>
        {lostRevenueWk != null
          ? <div className="tile"><div className="tn">${lostRevenueWk.toLocaleString("en-AU")}<span className="u"> /wk</span></div><div className="tl">Lost revenue / wk · from the Woolworths price feed</div></div>
          : <div className="tile"><div className="tn dim">$ —</div><div className="tl">Lost revenue / wk · lights up with the price feed</div></div>}
        <div className="tile"><div className="tn amber">{repeatCount}</div><div className="tl">Repeat sellouts · 3+ days out</div></div>
      </div>

      {repeatCount > 0 && (
        <div className="banner">
          <div className="bh">{repeatCount} store{repeatCount === 1 ? "" : "s"} running dry three or more days a week</div>
          <div className="bt">
            These aren&apos;t one-offs — the shelf is empty for days before the next delivery, so real demand is walking away
            unseen. Lifting the delivered quantity helps, but where it&apos;s a low-cadence run (e.g. Canberra&apos;s two-a-week),
            the real question is whether an extra run is worth it. Flagged so it&apos;s a decision, not a silent loss.
          </div>
        </div>
      )}

      <div className="bulk">
        <div className="section-h"><span className="tick" />Sellouts to fix{open.length ? <span className="cnt">{open.length}</span> : null}</div>
        {highFixable.length > 0 && (
          <button className="applyall" onClick={applyAllHigh} disabled={saving}>
            {saving ? "Applying…" : `Apply all ${highFixable.length} high-confidence fixes`}
          </button>
        )}
      </div>

      <div className="cards">
        {open.length === 0 && (
          <div className="allclear">
            <div className="ac-h">All caught up</div>
            <div className="ac-t">Every flagged sellout has been actioned. New ones surface here as the ledger detects them.</div>
          </div>
        )}
        {open.map((l) => (
          <div className={`lc${l.conf === "medium" ? " amber" : ""}`} key={l.id}>
            <div className="lc-top">
              <span className="lc-title">{l.store}</span>
              <span className="lc-conf" style={{ background: CONF[l.conf].b, color: CONF[l.conf].c }}>{CONF[l.conf].label}</span>
              <span className="lc-risk">~{l.lostWk} units/wk lost{l.lostRevenueWk != null ? ` · ~$${l.lostRevenueWk.toLocaleString("en-AU")}` : ""}</span>
            </div>
            <div className="lc-sub">{l.product} · {l.retailer} · {l.region}</div>
            <div className="lc-pattern">{l.pattern}</div>
            <div className="lc-fix">
              <span className="lbl">Suggested fix</span>
              <span className="fixline">
                {l.current !== null && l.suggested !== null
                  ? <>{l.product.toLowerCase()} <b>{l.current} → {l.suggested}</b><span className="delta"> +{l.suggested - l.current}</span></>
                  : <>Lift the send on the peak days{l.repeat ? <span className="orcad"> · or review the run cadence</span> : null}</>}
              </span>
            </div>
            <div className="lc-btns">
              {l.store_id && l.product_id && l.suggested != null ? (
                <Link className="btn approve" href={`/store/${l.store_id}?stage=${l.product_id}&to=${l.suggested}`}>Apply fix</Link>
              ) : (
                <button className="btn approve" onClick={() => apply(l.id)}>Apply fix</button>
              )}
              <button className="btn" onClick={() => dismiss(l.id)}>Dismiss</button>
            </div>
          </div>
        ))}
      </div>

      {Object.keys(resolved).length > 0 && (
        <div className="applied">
          <div className="section-h" style={{ marginTop: 8 }}><span className="tick" />Actioned this session</div>
          <div className="panel" style={{ padding: 0 }}>
            {data.losses.filter((l) => resolved[l.id]).map((l, i) => (
              <div className="arow" key={l.id} style={{ borderTop: i ? "1px solid var(--line2)" : undefined }}>
                <span className="a-check" style={{ color: resolved[l.id] === "applied" ? "var(--green-t)" : "var(--muted)" }}>{resolved[l.id] === "applied" ? "✓" : "○"}</span>
                <span className="a-store">{l.store}</span>
                <span className="a-prod">{l.product}</span>
                <span className="a-res">{resolved[l.id] === "applied" ? (l.current !== null ? `${l.current} → ${l.suggested}` : "lift") : "dismissed"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      </>
      )}

      <div className="foot" style={{ marginTop: 16 }}>
        Live from the on-hand ledger. Lost units are estimated from sell-through across the sold-out days; the sized fix
        comes from the plan where a store has one. Lost revenue turns on when the price feed lands (Invoice_Cost).
      </div>

      {toast && <div className="ltoast">{toast}</div>}

      <style>{`
        .losts .intro{margin-bottom:16px}
        .losts .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
        .losts .intro b{color:var(--ink);font-weight:600}
        .losts .strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
        .losts .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
        .losts .tn{font-family:var(--serif);font-size:30px;font-weight:600;line-height:1;letter-spacing:-.6px;font-variant-numeric:tabular-nums}
        .losts .tn .u{font-size:14px;color:var(--muted);font-family:var(--sans);font-weight:500}
        .losts .tn.dim{color:var(--muted)}
        .losts .tn.amber{color:var(--amber-t)}
        .losts .tl{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4}
        .losts .emptyhint{font-size:13px;color:var(--faint);line-height:1.6}

        .losts .banner{background:var(--amber-b);border:1px solid #e9cfa0;border-radius:var(--r);padding:16px 20px;margin-bottom:18px}
        .losts .banner .bh{font-family:var(--serif);font-size:16px;font-weight:600;color:var(--amber-t)}
        .losts .banner .bt{font-size:13.5px;color:#7c5308;line-height:1.6;margin-top:6px}

        .losts .bulk{display:flex;align-items:center;gap:14px;margin-bottom:12px}
        .losts .cnt{background:var(--red);color:#fff;border-radius:999px;font-size:11px;padding:1px 8px;font-weight:700;margin-left:9px}
        .losts .applyall{margin-left:auto;background:var(--green);border:1px solid var(--green);color:#fff;border-radius:10px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
        .losts .applyall:hover{background:#548050}
        .losts .applyall:disabled{opacity:.6;cursor:default}
        .losts .ltoast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);background:var(--espresso);color:#f6eddb;padding:12px 18px;border-radius:12px;box-shadow:var(--sh-pop);font-size:13.5px;font-weight:500;z-index:60;max-width:88vw;text-align:center}

        .losts .cards{display:grid;grid-template-columns:1fr 1fr;gap:14px}
        .losts .lc{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:18px 20px;position:relative;overflow:hidden}
        .losts .lc::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--red)}
        .losts .lc.amber::before{background:var(--amber)}
        .losts .lc-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:7px}
        .losts .lc-title{font-family:var(--serif);font-weight:600;font-size:16px;letter-spacing:-.2px}
        .losts .lc-conf{font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap}
        .losts .lc-risk{margin-left:auto;font-size:12px;color:var(--red-t);font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
        .losts .lc-sub{font-size:12.5px;color:var(--muted);margin-bottom:9px}
        .losts .lc-pattern{font-size:13.5px;color:var(--ink2);line-height:1.55;margin-bottom:11px}
        .losts .lc-fix{font-size:14px;padding:11px 13px;background:var(--surface);border:1px solid var(--line2);border-radius:10px;border-left:2px solid var(--crust);margin-bottom:13px}
        .losts .lc-fix .lbl{font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--crust-deep);font-weight:700;display:block;margin-bottom:3px}
        .losts .fixline{font-size:13.5px;color:var(--ink2)}
        .losts .fixline b{color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums}
        .losts .delta{color:var(--green-t);font-weight:700}
        .losts .orcad{color:var(--muted);font-weight:500}
        .losts .lc-btns{display:flex;gap:8px}
        .losts .btn{border:1px solid var(--line);background:var(--card);border-radius:var(--rc);padding:8px 15px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--ink)}
        .losts .btn:hover{background:#f6f0e6}
        .losts .btn.approve{background:var(--green);border-color:var(--green);color:#fff}
        .losts .btn.approve:hover{background:#548050}

        .losts .allclear{grid-column:span 2;background:var(--green-b);border:1px solid #cfe0c6;border-radius:var(--r);padding:22px}
        .losts .ac-h{font-family:var(--serif);font-size:17px;font-weight:600;color:var(--green-t)}
        .losts .ac-t{font-size:13.5px;color:#4a6a44;margin-top:5px;line-height:1.55}

        .losts .applied{margin-top:18px}
        .losts .arow{display:flex;align-items:center;gap:12px;padding:11px 16px;font-size:13px}
        .losts .a-check{font-weight:700;width:14px}
        .losts .a-store{font-weight:600}
        .losts .a-prod{color:var(--muted)}
        .losts .a-res{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--ink2);font-weight:600}

        @media (max-width:1080px){ .losts .strip{grid-template-columns:1fr 1fr} .losts .cards{grid-template-columns:1fr} .losts .allclear{grid-column:span 1} }
      `}</style>
    </div>
  );
}
