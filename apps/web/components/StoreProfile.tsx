"use client";

import { useMemo, useRef, useState, useTransition, type ChangeEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import StoreBars from "@/components/StoreBars";
import RetailerBadge from "@/components/RetailerBadge";
import type { StoreWeek, StoreReco, DailyBar, StoreOverride } from "@/lib/queries";
import { setStoreOverride, clearStoreOverride, setStoreRanging, setStoreServiceLevel, setStoreLastVisit, setStorePhoto, setStoreShelfCap } from "@/app/store/actions";

const nf = (n: number) => n.toLocaleString("en-AU");

type Adj = { qty: number; mode: "perm" | "temp"; from?: string; to?: string };
type Row = { pid: string; name: string; sold: number; now: number; rec: number };

const SCORE = {
  green: { dot: "🟢", label: "High performer", cls: "g" },
  amber: { dot: "🟡", label: "Opportunity", cls: "a" },
  red: { dot: "🔴", label: "Underperformer", cls: "r" },
  nodata: { dot: "◦", label: "No data yet", cls: "nd" },
} as const;

// Simona's "most important screen": the store profile as the single source of
// truth. Range products in/out, set this store's service level, and make
// temporary (date-ranged, auto-resetting) or permanent adjustments — with the
// shelf cap enforced. Editing is live here; persisting to the backend profile
// is the next build phase (flagged honestly in the UI).
export type PeerStat = {
  basis: string;      // e.g. "medium stores" / "SOUTH EAST stores" / "all stores"
  count: number;      // peers compared against (excludes this store)
  medWaste: number | null;
  medSellThrough: number | null;
  betterPct: number | null; // % of peers this store beats on waste (lower = better)
  verdict: "high" | "opportunity" | "under" | null; // relative to the peer group, not an absolute target
};

export default function StoreProfile({
  store,
  recos,
  daily,
  peer,
  overrides = [],
  ranging = [],
  serviceLevel = null,
  lastVisit = null,
  today = "",
  photo = null,
  address = null,
  shelfCap = null,
  noCap = false,
}: {
  store: StoreWeek;
  recos: StoreReco[];
  daily: DailyBar[];
  peer?: PeerStat;
  overrides?: StoreOverride[];
  ranging?: { product_id: string; ranged: boolean }[];
  serviceLevel?: string | null;
  lastVisit?: string | null;
  today?: string;
  photo?: string | null;
  address?: string | null;
  shelfCap?: number | null;
  noCap?: boolean;
}) {
  // Coerce every DB number up front (waste_pct/shelf_max arrive as strings).
  const wastePct = store.waste_pct == null ? null : Number(store.waste_pct);
  const soldWk = Number(store.total_sold) || 0;
  const sentWk = Number(store.total_sent) || 0;
  const soldPrev = Number(store.total_sold_prev) || 0;
  const stockouts = Number(store.stockout_days) || 0;
  // The size-band shelf max Simona confirmed. Per-store overrides (below) can
  // replace it or mark the store "no fixed limit" (e.g. Mascot DC picks to order).
  const baseMax = store.shelf_max == null ? null : Number(store.shelf_max);
  const sellThrough = sentWk > 0 ? Math.round((1000 * soldWk) / sentWk) / 10 : null;
  const growth = soldPrev > 0 ? Math.round((1000 * (soldWk - soldPrev)) / soldPrev) / 10 : null;
  // No loaded feed yet (nothing delivered or sold) — this store is NOT a "high
  // performer", it simply has no data. Same neutral rule as the dashboards.
  const hasData = sentWk > 0 || soldWk > 0;
  const score = hasData ? SCORE[store.status] : SCORE.nodata;

  const rows: Row[] = useMemo(
    () => recos.map((r) => ({ pid: r.product_id, name: r.product_name, sold: Number(r.sold) || 0, now: Number(r.sent) || 0, rec: Number(r.recommended) || 0 })),
    [recos],
  );

  const router = useRouter();
  const [, startSave] = useTransition();
  const [dial, setDial] = useState<"lean" | "balanced" | "service">(
    serviceLevel === "lean" || serviceLevel === "service" ? serviceLevel : "balanced",
  );
  const [visit, setVisit] = useState<string>(lastVisit ?? "");
  // Per-store shelf-cap override (migration 022). capOver = a hand-set cap that
  // replaces the size-band default; noLimit = the store picks to order and has no
  // real ceiling (Simona's Mascot DC example). Both live here optimistically and
  // persist via saveShelfCap.
  const [capOver, setCapOver] = useState<number | null>(shelfCap);
  const [noLimit, setNoLimit] = useState<boolean>(noCap);
  const [capBusy, setCapBusy] = useState(false);
  const [ranged, setRanged] = useState<Record<string, boolean>>(() => {
    // Default everything ranged, then apply saved choices (migration 015),
    // keyed by product name to match the row map.
    const base = Object.fromEntries(rows.map((r) => [r.name, true]));
    const nameById = new Map(recos.map((r) => [r.product_id, r.product_name]));
    for (const rg of ranging) {
      const name = nameById.get(rg.product_id);
      if (name) base[name] = rg.ranged;
    }
    return base;
  });
  // Hydrate saved overrides (migration 011) as the starting adjustments, keyed by
  // product name to match the row map. So a change Simona made yesterday is
  // already showing when she opens the profile today.
  const [adj, setAdj] = useState<Record<string, Adj>>(() => {
    const nameById = new Map(recos.map((r) => [r.product_id, r.product_name]));
    const init: Record<string, Adj> = {};
    for (const o of overrides) {
      const name = nameById.get(o.product_id);
      if (!name) continue;
      init[name] = { qty: Number(o.qty) || 0, mode: o.mode, from: o.starts_on ?? undefined, to: o.ends_on ?? undefined };
    }
    return init;
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A suggestion routed in from Lost sales / Opportunities via
  // ?stage=<productId>&to=<qty>. Shown as a confirm-first banner rather than
  // auto-applied, so the cap guard + Simona's review stay in the loop.
  const search = useSearchParams();
  const [stageDone, setStageDone] = useState(false);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  // Effective shelf cap: a "no limit" store has no ceiling (picks to order);
  // otherwise a per-store override wins over the size-band default. capStale
  // flags a cap below weekly sales — impossible to hit, so it's bad data, not a
  // real limit — and can never apply to a no-limit store.
  const cap = noLimit ? null : (capOver ?? baseMax);
  const capStale = !noLimit && cap != null && soldWk > 0 && cap < soldWk;

  // Persist the shelf-cap override (migration 022). Optimistic + revert on
  // failure, like the service dial and visit date.
  function saveShelfCap(next: { cap: number | null; noLimit: boolean }) {
    const prevCap = capOver, prevNo = noLimit;
    setCapOver(next.cap); setNoLimit(next.noLimit); setCapBusy(true);
    startSave(async () => {
      const res = await setStoreShelfCap(store.store_id, next.cap, next.noLimit);
      setCapBusy(false);
      if (res.ok) {
        if ("readonly" in res && res.readonly) showToast("Read-only demo — not saved");
        else {
          showToast(next.noLimit ? "Set to no fixed limit — saved"
            : next.cap == null ? "Reverted to the size-band cap — saved"
            : `Shelf cap set to ${next.cap} — saved`);
          router.refresh();
        }
      } else { setCapOver(prevCap); setNoLimit(prevNo); showToast(`Couldn't save the shelf cap: ${res.error}`); }
    });
  }

  // Last-visit date. Optimistic + revert on failure, like the dial. `today` comes
  // in from the server (the page is force-dynamic, so it's this request's date) —
  // reading the clock during a client render is impure and the React-compiler lint
  // rejects it. `new Date("YYYY-MM-DD")` is pure, so the day-delta is fine here.
  const OVERDUE_DAYS = 30;
  const visitDays =
    visit && today
      ? Math.floor((new Date(today + "T00:00:00").getTime() - new Date(visit + "T00:00:00").getTime()) / 86_400_000)
      : null;
  const visitOverdue = visitDays != null && visitDays > OVERDUE_DAYS;
  function saveVisit(v: string) {
    const prev = visit;
    setVisit(v);
    startSave(async () => {
      const res = await setStoreLastVisit(store.store_id, v);
      if (res.ok) {
        if (res.readonly) showToast("Visit date noted — preview only (this demo doesn't save changes)");
        else { showToast(v ? `Last visit set to ${v} — saved` : "Visit date cleared — saved"); router.refresh(); }
      } else { setVisit(prev); showToast(`Couldn't save the visit date: ${res.error}`); }
    });
  }

  // Store profile photo (migration 020). Simona picks an image; we resize it in
  // the browser to a small JPEG data URL (so the DB row stays light and there's
  // no storage bucket to stand up), then save. Optimistic + revert like the rest.
  const [pic, setPic] = useState<string | null>(photo);
  const [picBusy, setPicBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Draw the chosen file onto a canvas capped at 640px on its long edge and
  // export a compressed JPEG. Keeps a phone photo down to ~100KB.
  function resizeToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const MAX = 640;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) { reject(new Error("no canvas")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });
  }

  function savePhoto(next: string | null) {
    const prev = pic;
    setPic(next);
    startSave(async () => {
      const res = await setStorePhoto(store.store_id, next ?? "");
      if (res.ok) {
        if (res.readonly) showToast("Photo added — preview only (this demo doesn't save changes)");
        else { showToast(next ? "Store photo saved" : "Store photo removed"); router.refresh(); }
      } else { setPic(prev); showToast(`Couldn't save the photo: ${res.error}`); }
    });
  }

  async function onPickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    if (!file.type.startsWith("image/")) { showToast("Please choose an image file."); return; }
    if (file.size > 20_000_000) { showToast("That image is very large — try one under 20MB."); return; }
    setPicBusy(true);
    try {
      const dataUrl = await resizeToDataUrl(file);
      savePhoto(dataUrl);
    } catch {
      showToast("Couldn't read that image — try a different one.");
    } finally {
      setPicBusy(false);
    }
  }

  // Persist an adjustment to the store record. Optimistic: reflect it in the UI
  // immediately, then write it, and only surface a message if the save fails.
  function applyOverride(r: Row, next: Adj) {
    setAdj((s) => ({ ...s, [r.name]: next }));
    setEditing(null);
    startSave(async () => {
      const res = await setStoreOverride({
        storeId: store.store_id, productId: r.pid,
        qty: next.qty, mode: next.mode, from: next.from, to: next.to,
      });
      if (res.ok) {
        if (res.readonly) {
          showToast(`${r.name} set to ${next.qty} — preview only (this demo doesn't save changes)`);
        } else {
          showToast(`${r.name} set to ${next.qty} (${next.mode === "perm" ? "permanent" : `resets after ${next.to || "the end date"}`}) — saved`);
          router.refresh();
        }
      } else {
        showToast(`Couldn't save ${r.name}: ${res.error}`);
      }
    });
  }

  function clearOverride(r: Row) {
    setAdj((s) => { const n = { ...s }; delete n[r.name]; return n; });
    setEditing(null);
    startSave(async () => {
      const res = await clearStoreOverride(store.store_id, r.pid);
      if (res.ok) {
        if (res.readonly) {
          showToast(`${r.name} back to the recommended order — preview only (this demo doesn't save changes)`);
        } else {
          showToast(`${r.name} back to the recommended order — saved`);
          router.refresh();
        }
      } else {
        showToast(`Couldn't remove ${r.name}: ${res.error}`);
      }
    });
  }

  const isRanged = (name: string) => ranged[name] !== false;
  const eff = (r: Row) => adj[r.name]?.qty ?? r.rec; // effective "final delivery"
  const rangedRows = rows.filter((r) => isRanged(r.name));
  const rangedCount = rangedRows.length;
  const capTotal = rangedRows.reduce((a, r) => a + eff(r), 0);
  // Only a real over-cap violation when the cap on file is plausible. A stale
  // (too-low) cap is a data problem, not an over-supply the user should action.
  const overCap = cap != null && !capStale && capTotal > cap;

  function toggleRanged(name: string) {
    const next = !isRanged(name);
    setRanged((s) => ({ ...s, [name]: next }));
    const pid = rows.find((r) => r.name === name)?.pid;
    if (!pid) return;
    startSave(async () => {
      const res = await setStoreRanging(store.store_id, pid, next);
      if (res.ok) {
        if (res.readonly) showToast(`${name} ${next ? "ranged in" : "ranged out"} — preview only (this demo doesn't save changes)`);
        else { showToast(`${name} ${next ? "ranged in" : "ranged out"} — saved`); router.refresh(); }
      } else {
        setRanged((s) => ({ ...s, [name]: !next })); // revert on failure
        showToast(`Couldn't update ranging for ${name}: ${res.error}`);
      }
    });
  }

  // Simona's store-profile summary (Session 2 UAT): the outcome in one box
  // (sell-through + waste), the volume in the next (sent + sold — she wanted Sent
  // shown right beside Sold, which was missing), and a plan box (how many lines
  // still differ from the recommendation). Secondary signals stay in mgrid below.
  const wasteUnits = Math.max(sentWk - soldWk, 0);
  const recoRows = rows.filter((r) => r.rec > 0);
  const linesToReview = recoRows.filter((r) => r.rec !== r.now).length;

  // Secondary tiles — the dollar/accuracy figures move to a single "unlocks
  // with the cost feed" line below rather than sitting as dead "$ —" tiles.
  const metrics: { k: string; v: string; cls?: string }[] = [
    { k: "Sold-out days", v: stockouts ? `${stockouts}` : "0", cls: stockouts ? "a" : undefined },
    { k: "Sales growth", v: growth == null ? "—" : `${growth >= 0 ? "▲" : "▼"} ${Math.abs(growth)}%`, cls: growth == null ? undefined : growth >= 0 ? "g" : "r" },
  ];

  const stagePid = search.get("stage");
  const stageTo = Number(search.get("to"));
  const stageRow = !stageDone && stagePid && Number.isFinite(stageTo) ? rows.find((r) => r.pid === stagePid) : undefined;

  return (
    <section className="sprof">
      {stageRow && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "var(--amber-b)", border: "1px solid var(--amber)", borderRadius: 12, padding: "12px 16px", marginBottom: 14 }}>
          <div style={{ fontSize: 13.5, color: "var(--ink2)" }}>
            <b style={{ color: "var(--amber-t)" }}>Suggested fix</b> — set <b>{stageRow.name}</b> to <b>{stageTo}</b> <span style={{ color: "var(--muted)" }}>(now {eff(stageRow)})</span>. Applies as an adjustment on this store, capped at the shelf limit.
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button type="button" onClick={() => { applyOverride(stageRow, { qty: stageTo, mode: "perm" }); setStageDone(true); }} style={{ font: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: "7px 14px", borderRadius: 8, border: "1px solid var(--ink)", background: "var(--ink)", color: "#fff" }}>Apply</button>
            <button type="button" onClick={() => setStageDone(true)} style={{ font: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "7px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "#fff", color: "var(--ink2)" }}>Dismiss</button>
          </div>
        </div>
      )}
      <div className="hero">
        <div className="storephoto">
          <input ref={fileRef} type="file" accept="image/*" onChange={onPickPhoto} hidden aria-hidden="true" />
          {pic
            // eslint-disable-next-line @next/next/no-img-element -- data: URL, next/image can't optimise it
            ? <img className="sp-img" src={pic} alt={`${store.name} storefront`} />
            : <button type="button" className="sp-ph" onClick={() => fileRef.current?.click()} disabled={picBusy} aria-label="Add store photo">
                <span className="sp-ico">＋</span><span className="sp-cap">{picBusy ? "Working…" : "Add photo"}</span>
              </button>}
          {pic && (
            <div className="sp-btns">
              <button type="button" onClick={() => fileRef.current?.click()} disabled={picBusy}>{picBusy ? "Working…" : "Change"}</button>
              <button type="button" className="sp-rm" onClick={() => savePhoto(null)} disabled={picBusy}>Remove</button>
            </div>
          )}
        </div>
        <div className="hero-l">
          <div className="nm">{store.name}</div>
          <div className="sub">
            {store.size_category ? <span className="chip">{store.size_category}</span> : null}
            {noLimit ? <span className="chip">no shelf limit</span>
              : cap == null ? <span className="chip soft">cap not set</span>
              : capStale ? <span className="chip warn">shelf cap {nf(cap)} · check</span>
              : <span className="chip">shelf cap {nf(cap)}{capOver != null ? " · set" : ""}</span>}
            {store.region ? <span className="reg">{store.region}</span> : null}
            <RetailerBadge retailer={store.retailer} size="sm" />
          </div>
          {address ? <div className="addr">📍 {address}</div> : null}
        </div>
        <div className={`scorebadge ${score.cls}`}>
          <span className="sd">{score.dot}</span>
          <span className="st">{score.label}
            <small>
              {!hasData
                ? "Awaiting this store's retailer feed"
                : peer && peer.count > 0 && peer.betterPct != null
                ? `Waste beats ${peer.betterPct}% of ${peer.basis}`
                : "vs same-size stores"}
            </small>
          </span>
        </div>
      </div>

      <div className="sumrow">
        <div className="sumbox">
          <div className="sb-h">This week</div>
          <div className="sb-pair">
            <div className="sb-one"><div className={`sb-v ${sellThrough != null && sellThrough >= 85 ? "g" : ""}`}>{sellThrough == null ? "—" : `${sellThrough}%`}</div><div className="sb-l">Sell-through</div></div>
            <div className="sb-one"><div className={`sb-v ${wastePct == null ? "" : wastePct < 20 ? "g" : wastePct > 30 ? "r" : "a"}`}>{wastePct == null ? "—" : `${wastePct}%`}</div><div className="sb-l">Waste{wasteUnits > 0 ? ` · ${nf(wasteUnits)}u` : ""}</div></div>
          </div>
        </div>
        <div className="sumbox">
          <div className="sb-h">Units</div>
          <div className="sb-pair">
            <div className="sb-one"><div className="sb-v">{sentWk > 0 ? nf(sentWk) : "—"}</div><div className="sb-l">Sent</div></div>
            <div className="sb-one"><div className="sb-v">{nf(soldWk)}</div><div className="sb-l">Sold</div></div>
          </div>
        </div>
        <div className="sumbox">
          <div className="sb-h">Recommendation</div>
          <div className="sb-pair one">
            {recoRows.length === 0 ? (
              <div className="sb-one"><div className="sb-v soft">—</div><div className="sb-l">fills with the plan</div></div>
            ) : linesToReview > 0 ? (
              <div className="sb-one"><div className="sb-v a">{linesToReview}</div><div className="sb-l">{linesToReview === 1 ? "line to review" : "lines to review"}</div></div>
            ) : (
              <div className="sb-one"><div className="sb-v g">✓</div><div className="sb-l">all lines on plan</div></div>
            )}
          </div>
        </div>
      </div>

      <div className="mgrid">
        {metrics.map((m) => (
          <div className="m" key={m.k}>
            <div className={`mv ${m.cls ?? ""}`}>{m.v}</div>
            <div className="ml">{m.k}</div>
          </div>
        ))}
      </div>

      {peer && peer.count > 0 && (
        <div className="peerbar">
          <span className="pb-h">vs {peer.count} {peer.basis}</span>
          {peer.verdict && (
            <span className={`pb-v ${peer.verdict}`}>
              <span className="pb-vdot" />
              {peer.verdict === "high" ? "High performer" : peer.verdict === "opportunity" ? "Opportunity" : "Underperformer"}
            </span>
          )}
          {peer.medWaste != null && (
            <span className="pb-i">
              Waste <b>{wastePct == null ? "—" : `${wastePct}%`}</b>
              <span className="pb-m">median {peer.medWaste}%</span>
              {wastePct != null && (
                <span className={`pb-d ${wastePct <= peer.medWaste ? "good" : "bad"}`}>
                  {wastePct <= peer.medWaste ? "▼" : "▲"} {Math.abs(Math.round((wastePct - peer.medWaste) * 10) / 10)} pts
                </span>
              )}
            </span>
          )}
          {peer.medSellThrough != null && (
            <span className="pb-i">
              Sell-through <b>{sellThrough == null ? "—" : `${sellThrough}%`}</b>
              <span className="pb-m">median {peer.medSellThrough}%</span>
              {sellThrough != null && (
                <span className={`pb-d ${sellThrough >= peer.medSellThrough ? "good" : "bad"}`}>
                  {sellThrough >= peer.medSellThrough ? "▲" : "▼"} {Math.abs(Math.round((sellThrough - peer.medSellThrough) * 10) / 10)} pts
                </span>
              )}
            </span>
          )}
        </div>
      )}

      <div className="mlocked">
        <span className="lk">🔒 Unlocks with the cost feed</span>
        <span className="lkm">Weekly sales</span>
        <span className="lkm">Estimated waste $</span>
        <span className="lkm">Forecast accuracy</span>
        <span className="lknote">the per-unit figures already sit in the retailer data</span>
      </div>

      {daily.length > 0 && (
        <div className="chartcard">
          <div className="cc-h">Daily units this week <span>sold vs delivered · no running totals</span></div>
          <StoreBars data={daily} />
          <div className="cc-leg">
            <span><i style={{ background: "#2a2019" }} />Sold</span>
            <span><i style={{ background: "#e7ddca" }} />Delivered</span>
          </div>
        </div>
      )}

      <div className="dialrow">
        <div className="dial-l">
          <div className="dl-t">Service level · this store</div>
          <div className="dl-s">Sets the waste-vs-selling-out trade-off for every product here — not just loaves. The plan re-sizes each line to match.</div>
        </div>
        <div className="seg">
          {(["lean", "balanced", "service"] as const).map((s) => (
            <button key={s} type="button" className={dial === s ? "on" : ""} onClick={() => {
              const prev = dial;
              setDial(s);
              startSave(async () => {
                const res = await setStoreServiceLevel(store.store_id, s);
                if (res.ok) {
                  if (res.readonly) showToast(`Service level set to ${s} for ${store.name} — preview only (this demo doesn't save changes)`);
                  else { showToast(`Service level set to ${s} for ${store.name} — saved`); router.refresh(); }
                } else { setDial(prev); showToast(`Couldn't save service level: ${res.error}`); }
              });
            }}>
              {s[0].toUpperCase() + s.slice(1)}
              {s === "balanced" && <small>default</small>}
            </button>
          ))}
        </div>
      </div>

      <div className="visitrow">
        <div className="dial-l">
          <div className="dl-t">Last store visit</div>
          <div className="dl-s">Record when you last visited this store — it flags overdue after {OVERDUE_DAYS} days so none slip through.</div>
        </div>
        <div className="visit-ctl">
          <input
            className="visit-date"
            type="date"
            value={visit}
            max={today || undefined}
            onChange={(e) => saveVisit(e.target.value)}
            aria-label="Last store visit date"
          />
          {visit
            ? visitDays == null
              ? <span className="visit-chip ok">Recorded</span>
              : <span className={`visit-chip ${visitOverdue ? "over" : "ok"}`}>{visitOverdue ? `Overdue · ${visitDays}d` : `Visited ${visitDays}d ago`}</span>
            : <span className="visit-chip over">Not recorded</span>}
          {visit && <button type="button" className="visit-clear" onClick={() => saveVisit("")}>Clear</button>}
        </div>
      </div>

      <div className="visitrow">
        <div className="dial-l">
          <div className="dl-t">Shelf cap · this store</div>
          <div className="dl-s">
            Default is the {store.size_category ? <b>{store.size_category}</b> : "size-band"} shelf max{baseMax != null ? <> (<b>{nf(baseMax)}</b> units)</> : ""}. Override it for a store that runs bigger or smaller, or set no fixed limit for a pick-to-order store like a DC.
          </div>
        </div>
        <div className="visit-ctl">
          <input
            className="visit-date cap-in"
            type="number"
            min={0}
            step={5}
            placeholder={baseMax != null ? String(baseMax) : "cap"}
            value={noLimit ? "" : (capOver ?? "")}
            disabled={noLimit || capBusy}
            onChange={(e) => { const v = e.target.value.trim(); saveShelfCap({ cap: v === "" ? null : Math.max(0, Math.round(Number(v))), noLimit: false }); }}
            aria-label="Shelf cap override"
          />
          <label className="cap-nolimit">
            <input type="checkbox" checked={noLimit} disabled={capBusy} onChange={(e) => saveShelfCap({ cap: capOver, noLimit: e.target.checked })} />
            No fixed limit
          </label>
          {!noLimit && capOver != null && (
            <button type="button" className="visit-clear" onClick={() => saveShelfCap({ cap: null, noLimit: false })}>Reset</button>
          )}
        </div>
      </div>

      <div className="ph">
        <div className="ph-t">Products &amp; ranging <span className="cnt">{rangedCount}/{rows.length} ranged</span></div>
        <div className="ph-cap">
          {noLimit ? (
            <span className="ok">{nf(capTotal)} units · no fixed limit</span>
          ) : cap == null ? (
            <span className="soft">shelf cap not set for this store</span>
          ) : capStale ? (
            <span className="stale">shelf cap on file is {nf(cap)}, but this store sells {nf(soldWk)}/wk — likely stale, please verify</span>
          ) : (
            <span className={overCap ? "over" : "ok"}>
              {overCap ? "⚠ " : ""}{nf(capTotal)} / {nf(cap)} units{overCap ? " — over shelf cap" : ""}
            </span>
          )}
        </div>
      </div>

      {capStale && (
        <div className="stalewarn">
          <b>The shelf cap on file ({nf(cap!)}) looks out of date.</b> This store has sold {nf(soldWk)} units this week, so a cap of {nf(cap!)} can&apos;t be its real shelf limit — it&apos;s almost certainly a stale figure. We&apos;re not enforcing it until it&apos;s confirmed; update it in the store record when you can.
        </div>
      )}

      {overCap && (
        <div className="capwarn">
          <b>This exceeds the store&apos;s shelf cap of {nf(cap!)}.</b> A store can&apos;t hold more than it fits — untick a product, trim an adjustment, or keep it as a one-off override. Nothing goes out over cap without your OK.
        </div>
      )}

      {rows.length > 0 ? (
        <div className="sheet">
          <div className="colhead"><div className="grid">
            <div className="c">Ranged</div>
            <div>Product</div>
            <div className="r">Sold</div>
            <div className="r soft">Now</div>
            <div className="r">Final delivery</div>
            <div className="r">Adjust</div>
          </div></div>
          {rows.map((r) => {
            const on = isRanged(r.name);
            const a = adj[r.name];
            const v = eff(r);
            const isEdit = editing === r.name;
            return (
              <div className={`row ${on ? "" : "off"}`} key={r.name}>
                <div className="grid">
                  <div className="c">
                    <button type="button" className={`sw ${on ? "on" : ""}`} aria-label={`toggle ranging ${r.name}`} onClick={() => toggleRanged(r.name)}>
                      <span className="knob" />
                    </button>
                  </div>
                  <div className="pn">
                    {r.name}
                    {!on && <span className="notr">not ranged · driver diverts today</span>}
                    {a && on && <span className={`apill ${a.mode}`}>{a.mode === "perm" ? "permanent" : `until ${a.to || "—"}`} · {v}</span>}
                  </div>
                  <div className="r">{on ? nf(r.sold) : "—"}</div>
                  <div className="r soft">{on ? nf(r.now) : "—"}</div>
                  <div className="r fd">{on ? nf(v) : "—"}</div>
                  <div className="r">
                    {on ? (
                      <button type="button" className="adjbtn" onClick={() => setEditing(isEdit ? null : r.name)}>{a ? "Edit" : "Adjust"}</button>
                    ) : "—"}
                  </div>
                </div>
                {isEdit && on && (
                  <AdjustEditor
                    row={r}
                    current={a}
                    onCancel={() => setEditing(null)}
                    onClear={() => clearOverride(r)}
                    onApply={(next) => applyOverride(r, next)}
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <div className="e-t">Per-product plan is warming up for this store</div>
          <div className="e-b">The plan writes line-by-line ranging and orders for stores on a live sales feed (Woolworths today). This store&apos;s totals are above; its product rows light up as its retailer feed fills the ledger.</div>
        </div>
      )}

      <div className="foot">
        This profile is the single source of truth — ranging, service level and adjustments set here shape the plan, with the shelf cap enforced and a warning on anything over it. <b>Adjustments, ranging and service level all save to the store record</b> now and are here when you come back.
      </div>

      {toast && <div className="toast">{toast}</div>}

      <style>{`
      .sprof{display:block;padding-bottom:40px}
      .sprof .hero{display:flex;align-items:flex-start;gap:16px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:20px 24px;margin-bottom:14px;flex-wrap:wrap}
      .sprof .storephoto{display:flex;flex-direction:column;align-items:center;gap:6px}
      .sprof .sp-img{width:76px;height:76px;border-radius:14px;object-fit:cover;border:1px solid var(--line);display:block;box-shadow:var(--sh)}
      .sprof .sp-ph{width:76px;height:76px;border-radius:14px;border:1px dashed var(--line);background:var(--surface);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:var(--muted);font:inherit;transition:border-color .15s,color .15s}
      .sprof .sp-ph:hover:not(:disabled){border-color:var(--ink);color:var(--ink2)}
      .sprof .sp-ph:disabled{cursor:default;opacity:.7}
      .sprof .sp-ico{font-size:20px;line-height:1}
      .sprof .sp-cap{font-size:10.5px;font-weight:600;letter-spacing:.02em}
      .sprof .sp-btns{display:flex;gap:8px}
      .sprof .sp-btns button{font:inherit;font-size:11px;font-weight:600;cursor:pointer;background:0;border:0;color:var(--ink2);padding:0;text-decoration:underline;text-underline-offset:2px}
      .sprof .sp-btns button:disabled{cursor:default;opacity:.6;text-decoration:none}
      .sprof .sp-btns .sp-rm{color:var(--muted)}
      .sprof .hero-l{flex:1;min-width:220px}
      .sprof .nm{font-family:var(--serif);font-size:24px;font-weight:600;letter-spacing:-.3px}
      .sprof .sub{display:flex;align-items:center;gap:9px;margin-top:9px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}
      .sprof .chip{background:#efe6d3;color:var(--ink2);border-radius:999px;font-size:11.5px;font-weight:700;padding:3px 10px}
      .sprof .chip.soft{background:var(--line2);color:var(--faint)}
      .sprof .reg{color:var(--ink2);font-weight:600}
      .sprof .rtl{margin-left:auto;color:var(--faint);text-transform:capitalize}
      .sprof .addr{margin-top:7px;font-size:12.5px;color:var(--ink2);line-height:1.35}
      .sprof .scorebadge{display:flex;align-items:center;gap:10px;border-radius:12px;padding:10px 14px;border:1px solid var(--line)}
      .sprof .scorebadge.g{background:var(--green-b)}.sprof .scorebadge.a{background:var(--amber-b)}.sprof .scorebadge.r{background:var(--red-b)}
      .sprof .scorebadge.nd{background:var(--line2)}
      .sprof .scorebadge.nd .st{color:var(--muted)}
      .sprof .scorebadge.nd .sd{color:var(--muted)}
      .sprof .scorebadge .sd{font-size:16px}
      .sprof .scorebadge .st{font-weight:700;font-size:13.5px;line-height:1.2;color:var(--ink)}
      .sprof .scorebadge .st small{display:block;font-weight:500;font-size:10.5px;color:var(--ink2);opacity:.75;margin-top:2px}
      .sprof .sumrow{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:12px;margin-bottom:12px}
      @media(max-width:760px){.sprof .sumrow{grid-template-columns:1fr}}
      .sprof .sumbox{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--sh);padding:12px 15px 13px}
      .sprof .sb-h{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:9px}
      .sprof .sb-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .sprof .sb-pair.one{grid-template-columns:1fr}
      .sprof .sb-v{font-family:var(--serif);font-size:23px;font-weight:600;letter-spacing:-.4px;font-variant-numeric:tabular-nums;line-height:1}
      .sprof .sb-v.g{color:var(--green-t)}.sprof .sb-v.a{color:var(--amber-t)}.sprof .sb-v.r{color:var(--red-t)}
      .sprof .sb-v.soft{color:var(--faint);font-weight:500}
      .sprof .sb-l{font-size:11px;color:var(--muted);margin-top:6px}
      .sprof .mgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--line2);border:1px solid var(--line2);border-radius:12px;overflow:hidden}
      @media(max-width:560px){.sprof .mgrid{grid-template-columns:repeat(2,1fr)}}
      .sprof .mlocked{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin:12px 2px 18px}
      .sprof .mlocked .lk{font-size:11.5px;font-weight:700;color:var(--muted);letter-spacing:.2px}
      .sprof .mlocked .lkm{font-size:11.5px;color:var(--faint);border:1px dashed var(--line2);border-radius:6px;padding:2px 8px}
      .sprof .mlocked .lknote{font-size:11px;color:var(--faint);font-style:italic}
      .sprof .chip.warn{background:var(--amber-b);color:var(--amber-t)}
      .sprof .m{background:var(--card);padding:13px 15px}
      .sprof .mv{font-family:var(--serif);font-size:22px;font-weight:600;letter-spacing:-.4px;font-variant-numeric:tabular-nums;line-height:1}
      .sprof .mv.g{color:var(--green-t)}.sprof .mv.a{color:var(--amber-t)}.sprof .mv.r{color:var(--red-t)}
      .sprof .mv.soft{color:var(--faint);font-weight:500}
      .sprof .ml{font-size:11px;color:var(--muted);margin-top:6px}
      .sprof .peerbar{display:flex;align-items:center;gap:18px;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-top:12px}
      .sprof .peerbar .pb-h{font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);font-weight:700}
      .sprof .peerbar .pb-i{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ink2)}
      .sprof .peerbar .pb-i b{font-family:var(--serif);font-size:16px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
      .sprof .peerbar .pb-m{font-size:12px;color:var(--muted)}
      .sprof .peerbar .pb-d{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
      .sprof .peerbar .pb-d.good{color:var(--green-t)} .sprof .peerbar .pb-d.bad{color:var(--red-t)}
      .sprof .peerbar .pb-v{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;letter-spacing:.2px;padding:3px 9px;border-radius:999px;border:1px solid}
      .sprof .peerbar .pb-v .pb-vdot{width:7px;height:7px;border-radius:50%}
      .sprof .peerbar .pb-v.high{color:var(--green-t);background:var(--green-b);border-color:var(--green)}
      .sprof .peerbar .pb-v.high .pb-vdot{background:var(--green)}
      .sprof .peerbar .pb-v.opportunity{color:var(--amber-t);background:var(--amber-b);border-color:var(--amber)}
      .sprof .peerbar .pb-v.opportunity .pb-vdot{background:var(--amber)}
      .sprof .peerbar .pb-v.under{color:var(--red-t);background:var(--red-b);border-color:var(--red)}
      .sprof .peerbar .pb-v.under .pb-vdot{background:var(--red)}
      .sprof .softnote{font-size:11.5px;color:var(--faint);line-height:1.5;margin:8px 2px 18px}
      .sprof .chartcard{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px;margin-bottom:16px}
      .sprof .cc-h{font-size:12.5px;color:var(--ink2);font-weight:600;margin-bottom:10px}
      .sprof .cc-h span{color:var(--muted);font-weight:400;margin-left:6px}
      .sprof .cc-leg{display:flex;gap:16px;font-size:11.5px;color:var(--ink2);margin-top:8px}
      .sprof .cc-leg i{width:10px;height:10px;border-radius:3px;display:inline-block;margin-right:5px;vertical-align:-1px}
      .sprof .dialrow{display:flex;align-items:center;gap:18px;background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:14px 18px;margin-bottom:18px;flex-wrap:wrap}
      .sprof .dial-l{flex:1;min-width:240px}
      .sprof .dl-t{font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);font-weight:700}
      .sprof .dl-s{font-size:12.5px;color:var(--ink2);margin-top:4px;line-height:1.5;max-width:520px}
      .sprof .seg{display:flex;background:#ece3d1;border-radius:10px;padding:3px;gap:3px}
      .sprof .seg button{border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:var(--muted);padding:9px 16px;border-radius:8px;cursor:pointer;transition:.15s}
      .sprof .seg button:hover{color:var(--ink2)}
      .sprof .seg button.on{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(60,45,30,.16)}
      .sprof .seg button small{display:block;font-size:10px;font-weight:600;color:var(--green-t);margin-top:1px}
      .sprof .visitrow{display:flex;align-items:center;gap:18px;background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:14px 18px;margin-bottom:18px;flex-wrap:wrap}
      .sprof .visit-ctl{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .sprof .visit-date{font-family:inherit;font-size:13px;font-weight:600;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 11px;cursor:pointer}
      .sprof .visit-chip{font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;white-space:nowrap}
      .sprof .visit-chip.ok{background:var(--green-b);color:var(--green-t)}
      .sprof .visit-chip.over{background:var(--amber-b);color:var(--amber-t)}
      .sprof .visit-clear{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:8px 12px;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit}
      .sprof .visit-clear:hover{color:var(--ink2);background:#f6f0e6}
      .sprof .cap-in{width:96px;font-variant-numeric:tabular-nums}
      .sprof .cap-in:disabled{opacity:.5}
      .sprof .cap-nolimit{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--ink2);cursor:pointer;white-space:nowrap}
      .sprof .cap-nolimit input{width:15px;height:15px;cursor:pointer;accent-color:var(--crust-deep,#a7611c)}
      .sprof .ph{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap}
      .sprof .ph-t{font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);font-weight:700;display:flex;align-items:center;gap:10px}
      .sprof .ph-t .cnt{background:#efe6d3;color:var(--ink2);border-radius:999px;font-size:11px;letter-spacing:0;padding:2px 9px;font-weight:700}
      .sprof .ph-cap{font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums}
      .sprof .ph-cap .ok{color:var(--green-t)}.sprof .ph-cap .over{color:var(--red-t)}.sprof .ph-cap .soft{color:var(--faint);font-weight:500}
      .sprof .ph-cap .stale{color:var(--amber-t);font-weight:600}
      .sprof .capwarn{background:var(--red-b);border:1px solid #eab9a8;color:var(--red-t);border-radius:11px;padding:11px 15px;font-size:13px;line-height:1.5;margin-bottom:14px}
      .sprof .capwarn b{color:var(--red-t)}
      .sprof .stalewarn{background:var(--amber-b);border:1px solid #e6d3a8;color:var(--amber-t);border-radius:11px;padding:11px 15px;font-size:13px;line-height:1.5;margin-bottom:14px}
      .sprof .stalewarn b{color:var(--amber-t)}
      .sprof .sheet{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
      .sprof .grid{display:grid;grid-template-columns:78px minmax(160px,1fr) 74px 74px 120px 92px;align-items:center}
      .sprof .colhead{background:var(--surface);border-bottom:1px solid var(--line)}
      .sprof .colhead .grid>div{font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);font-weight:700;padding:11px 16px}
      .sprof .r{text-align:right}.sprof .c{text-align:center}
      .sprof .soft{color:var(--faint)}
      .sprof .row{border-top:1px solid var(--line2);transition:background .12s}
      .sprof .row:hover{background:#faf6ee}
      .sprof .row.off{background:#faf7f1}
      .sprof .row.off .pn{color:var(--faint)}
      .sprof .row>.grid>div{padding:12px 16px}
      .sprof .pn{font-weight:600;letter-spacing:-.1px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
      .sprof .notr{font-size:10.5px;font-weight:600;color:var(--amber-t);background:var(--amber-b);border-radius:999px;padding:2px 8px}
      .sprof .apill{font-size:10.5px;font-weight:700;border-radius:999px;padding:2px 8px}
      .sprof .apill.perm{color:var(--crust-deep);background:#f0e2cc}
      .sprof .apill.temp{color:var(--amber-t);background:var(--amber-b)}
      .sprof .fd{font-weight:700;font-variant-numeric:tabular-nums}
      .sprof .sw{width:38px;height:22px;border-radius:999px;border:1px solid var(--line);background:#e7ddca;position:relative;cursor:pointer;transition:.15s;padding:0}
      .sprof .sw.on{background:var(--green);border-color:var(--green)}
      .sprof .sw .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:.15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
      .sprof .sw.on .knob{left:18px}
      .sprof .adjbtn{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit}
      .sprof .adjbtn:hover{border-color:var(--crust);color:var(--ink)}
      .sprof .editor{border-top:1px dashed var(--line);background:var(--surface);padding:14px 16px;display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}
      .sprof .editor .fld{display:flex;flex-direction:column;gap:5px}
      .sprof .editor label{font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:700}
      .sprof .editor .step{display:inline-flex;align-items:center;gap:8px}
      .sprof .editor .step button{width:28px;height:28px;border:1px solid var(--line);background:var(--card);border-radius:7px;font-size:16px;cursor:pointer;color:var(--ink2);font-family:inherit}
      .sprof .editor .step input{width:64px;text-align:center;border:1px solid var(--line);border-radius:7px;padding:6px;font-size:15px;font-weight:700;font-family:inherit;font-variant-numeric:tabular-nums}
      .sprof .editor .modes{display:inline-flex;gap:6px}
      .sprof .editor .mode{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit}
      .sprof .editor .mode.on{background:var(--espresso);border-color:var(--espresso);color:#f4ecdc}
      .sprof .editor input[type=date]{border:1px solid var(--line);border-radius:7px;padding:6px 8px;font-family:inherit;font-size:12.5px;color:var(--ink)}
      .sprof .editor .sp{margin-left:auto;display:flex;gap:8px}
      .sprof .editor .apply{background:var(--espresso);border:1px solid var(--espresso);color:#f4ecdc;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
      .sprof .editor .ghost{background:transparent;border:1px solid var(--line);color:var(--ink2);border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
      .sprof .editor .clear{background:transparent;border:none;color:var(--red-t);font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
      .sprof .empty{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:22px 24px}
      .sprof .empty .e-t{font-family:var(--serif);font-size:17px;margin-bottom:6px}
      .sprof .empty .e-b{color:var(--ink2);max-width:640px;line-height:1.6}
      .sprof .foot{margin-top:20px;font-size:11.5px;color:var(--faint);line-height:1.6}
      .sprof .foot b{color:var(--ink2);font-weight:600}
      .sprof .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--espresso);color:#f6eddb;padding:12px 18px;border-radius:12px;box-shadow:var(--sh-pop);font-size:13px;font-weight:500;z-index:60;max-width:88vw}
      @media(max-width:760px){.sprof .grid{grid-template-columns:60px minmax(120px,1fr) 60px 96px 76px}.sprof .grid .soft{display:none}}
      `}</style>
    </section>
  );
}

function AdjustEditor({
  row,
  current,
  onApply,
  onCancel,
  onClear,
}: {
  row: Row;
  current?: Adj;
  onApply: (a: Adj) => void;
  onCancel: () => void;
  onClear: () => void;
}) {
  const [qty, setQty] = useState(current?.qty ?? row.rec);
  const [mode, setMode] = useState<"perm" | "temp">(current?.mode ?? "perm");
  const [from, setFrom] = useState(current?.from ?? "");
  const [to, setTo] = useState(current?.to ?? "");

  return (
    <div className="editor">
      <div className="fld">
        <label>Final delivery</label>
        <span className="step">
          <button type="button" onClick={() => setQty((q) => Math.max(0, q - 1))}>−</button>
          <input value={qty} inputMode="numeric" onChange={(e) => setQty(Math.max(0, parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0))} />
          <button type="button" onClick={() => setQty((q) => q + 1)}>+</button>
        </span>
      </div>
      <div className="fld">
        <label>Type</label>
        <span className="modes">
          <button type="button" className={`mode ${mode === "perm" ? "on" : ""}`} onClick={() => setMode("perm")}>Permanent</button>
          <button type="button" className={`mode ${mode === "temp" ? "on" : ""}`} onClick={() => setMode("temp")}>Temporary</button>
        </span>
      </div>
      {mode === "temp" && (
        <>
          <div className="fld"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="fld"><label>Until (auto-resets)</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </>
      )}
      <div className="sp">
        {current && <button type="button" className="clear" onClick={onClear}>Remove</button>}
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="apply" onClick={() => onApply({ qty, mode, from: from || undefined, to: to || undefined })}>Apply</button>
      </div>
    </div>
  );
}
