"use client";
import { useEffect, useMemo, useState } from "react";
import { createStore } from "@/app/new-store/actions";

/* ------------------------------------------------------------------ *
 * New-store setup — Simona's SOP: "enter once, set the ceiling, let it
 * fill." A new store has no sales history, so we seed Simona's baseline
 * stock bundle (her 14 Aug spec, active until sales data builds), sized
 * to the store, on the real Jesse's product lines with their Woolworths
 * product numbers. Capped at shelf max; the plan takes over as real
 * sales come in. Front-end prototype wired to the real bundle.
 * ------------------------------------------------------------------ */

type Cat = "sourdough" | "bagel" | "minichallah" | "pita";
type Size = "small" | "medium" | "large";
type SType = "standard" | "sourdough" | "bagel";

// Real Jesse's lines + Woolworths / WW Metro product numbers (Simona, 14 Aug).
const PRODUCTS: { id: string; name: string; code: string; cat: Cat; w: number }[] = [
  { id: "sd-white", name: "White Sourdough 900g", code: "12140", cat: "sourdough", w: 0.32 },
  { id: "sd-whole", name: "Wholemeal Sourdough 800g", code: "12148", cat: "sourdough", w: 0.22 },
  { id: "sd-rye", name: "Rye Sourdough 900g", code: "12157", cat: "sourdough", w: 0.16 },
  { id: "sd-spelt", name: "Spelt Sourdough 900g", code: "12128", cat: "sourdough", w: 0.12 },
  { id: "sd-soy", name: "Soy & Linseed Sourdough 900g", code: "12178", cat: "sourdough", w: 0.1 },
  { id: "sd-darkrye", name: "Dark Rye Seeded 800g", code: "113947", cat: "sourdough", w: 0.08 },
  { id: "bg-sesame", name: "Bagels Sesame 550g", code: "875671", cat: "bagel", w: 0.3 },
  { id: "bg-mixed", name: "Bagels Mixed Seed 550g", code: "877105", cat: "bagel", w: 0.28 },
  { id: "bg-boiled", name: "Boiled Bagels 550g", code: "684707", cat: "bagel", w: 0.22 },
  { id: "bg-poppy", name: "Bagels Poppyseed 550g", code: "877104", cat: "bagel", w: 0.2 },
  { id: "mc-plain", name: "Mini Challah Rolls 400g", code: "684711", cat: "minichallah", w: 0.5 },
  { id: "mc-sesame", name: "Mini Challah Rolls Sesame 400g", code: "877940", cat: "minichallah", w: 0.5 },
  { id: "pt-pita", name: "Pita Bread 400g", code: "113124", cat: "pita", w: 1 },
];

// Simona's baseline bundle — category totals per store size (14 Aug).
const BUNDLE: Record<Size, Record<Cat, number>> = {
  small: { sourdough: 30, bagel: 15, minichallah: 4, pita: 3 }, // 52
  medium: { sourdough: 32, bagel: 25, minichallah: 8, pita: 5 }, // 70
  large: { sourdough: 60, bagel: 40, minichallah: 10, pita: 8 }, // 118
};
const CAP_DEFAULT: Record<Size, number> = { small: 60, medium: 90, large: 140 };
const SIZE_META: Record<Size, { label: string; shelf: string; seeded: number }> = {
  small: { label: "Small", shelf: "50–60 shelf", seeded: 52 },
  medium: { label: "Medium", shelf: "60–90 shelf", seeded: 70 },
  large: { label: "Large", shelf: "82–140 shelf", seeded: 118 },
};

const CAT_LABEL: Record<Cat, string> = { sourdough: "Sourdough", bagel: "Bagels", minichallah: "Mini challah", pita: "Pita" };
const CAT_COLOR: Record<Cat, string> = { sourdough: "#b0741c", bagel: "#8a5aa0", minichallah: "#5f8f5a", pita: "#4f7396" };
const CAT_ORDER: Cat[] = ["sourdough", "bagel", "minichallah", "pita"];

const REGIONS = [
  "Eastern Suburbs", "Inner West", "North Shore", "Northern Beaches", "North West", "South", "South East", "Central Coast", "Canberra / ACT",
  "Brisbane Central", "Brisbane North", "Gold Coast", "Northern NSW", "Sunshine Coast",
];
const RETAILERS: { id: string; label: string }[] = [
  { id: "woolworths", label: "Woolworths" }, { id: "coles", label: "Coles" },
  { id: "harris_farm", label: "Harris Farm" }, { id: "direct", label: "Direct / invoice" },
];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Ranging exclusions (Simona, 14 Aug). A store doesn't stock every line — a
// product it doesn't range shouldn't be seeded into its bundle. Keyed off
// region + retailer, plus the Mascot DC store rule. Excluded SKUs drop out and
// the category total redistributes across the lines that ARE ranged, so e.g.
// ACT still gets its full sourdough count, just none of it rye / dark rye.
type RangeRule = { label: string; match: (region: string, retailer: string, name: string) => boolean; exclude: string[] };
const RANGING: RangeRule[] = [
  {
    label: "Woolworths ACT doesn't range rye, dark rye or mini challah",
    match: (region, retailer) => retailer === "woolworths" && /canberra|\bact\b/i.test(region),
    exclude: ["sd-rye", "sd-darkrye", "mc-plain", "mc-sesame"],
  },
  {
    label: "Woolworths Mascot DC doesn't range sesame mini challah, dark rye, spelt or pita",
    match: (_region, retailer, name) => retailer === "woolworths" && /mascot/i.test(name),
    exclude: ["mc-sesame", "sd-darkrye", "sd-spelt", "pt-pita"],
  },
];
function rangingFor(region: string, retailer: string, name: string): { excluded: Set<string>; reasons: string[] } {
  const excluded = new Set<string>();
  const reasons: string[] = [];
  for (const rule of RANGING) {
    if (rule.match(region, retailer, name)) {
      rule.exclude.forEach((id) => excluded.add(id));
      reasons.push(rule.label);
    }
  }
  return { excluded, reasons };
}

// Largest-remainder allocation so category totals land exactly on Simona's numbers.
function allocate(total: number, items: { id: string; w: number }[]): Record<string, number> {
  const sumW = items.reduce((a, i) => a + i.w, 0) || 1;
  const raw = items.map((i) => ({ id: i.id, x: (i.w / sumW) * total }));
  const out: Record<string, number> = {};
  let used = 0;
  raw.forEach((r) => { const f = Math.floor(r.x); out[r.id] = f; used += f; });
  const byFrac = [...raw].sort((a, b) => (b.x - Math.floor(b.x)) - (a.x - Math.floor(a.x)));
  for (let i = 0; i < total - used; i++) out[byFrac[i % byFrac.length].id] += 1;
  return out;
}

function catTotals(size: Size, type: SType): Record<Cat, number> {
  const t = { ...BUNDLE[size] };
  if (type === "sourdough") { const s = Math.round(t.bagel * 0.25); t.sourdough += s; t.bagel -= s; }
  else if (type === "bagel") { const s = Math.round(t.sourdough * 0.18); t.bagel += s; t.sourdough -= s; }
  return t;
}

function seed(size: Size, type: SType, excluded: Set<string> = new Set()): Record<string, number> {
  const totals = catTotals(size, type);
  const out: Record<string, number> = {};
  for (const cat of CAT_ORDER) {
    const items = PRODUCTS.filter((p) => p.cat === cat && !excluded.has(p.id)).map((p) => ({ id: p.id, w: p.w }));
    if (items.length) Object.assign(out, allocate(totals[cat], items));
  }
  // Excluded lines pinned to 0 so the grid can show them as "not ranged here".
  for (const p of PRODUCTS) if (excluded.has(p.id)) out[p.id] = 0;
  return out;
}

const titleCaseRegion = (s: string) => (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export default function NewStoreSetup({ regions = [] }: { regions?: string[] }) {
  // Real regions from the DB when available; otherwise the built-in fallback.
  const regionOpts = regions.length ? regions : REGIONS;
  const [name, setName] = useState("");
  const [retailer, setRetailer] = useState("woolworths");
  const [storeNo, setStoreNo] = useState("");
  const [region, setRegion] = useState(regionOpts[0]);
  const [run, setRun] = useState("1");
  const [days, setDays] = useState<Record<string, boolean>>({ Mon: true, Tue: false, Wed: true, Thu: false, Fri: true, Sat: false, Sun: false });
  const [size, setSize] = useState<Size>("small");
  const [type, setType] = useState<SType>("standard");
  const [cap, setCap] = useState(CAP_DEFAULT.small);
  const [service, setService] = useState<"lean" | "balanced" | "generous">("balanced");
  const [source, setSource] = useState<"profile" | "copy">("profile");
  const [timing, setTiming] = useState<"upcoming" | "live">("upcoming");
  const [goLiveDate, setGoLiveDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ ok: boolean; msg: string } | null>(null);

  async function submit() {
    setSaving(true);
    setSaved(null);
    const res = await createStore({
      name, retailer, region, storeNo, size, cap, timing,
      goLiveDate: goLiveDate || undefined,
      service,
    });
    setSaving(false);
    setSaved(res.ok
      ? { ok: true, msg: timing === "live" ? "Store created and marked live." : "Store created — it's tracked under Coming up." }
      : { ok: false, msg: res.error });
  }

  const { excluded, reasons } = useMemo(() => rangingFor(region, retailer, name), [region, retailer, name]);
  const excludedKey = useMemo(() => [...excluded].sort().join(","), [excluded]);
  const [basket, setBasket] = useState<Record<string, number>>(() => seed("small", "standard"));

  // Reseed when the store context that defines the bundle changes — size, type,
  // or the ranging set. Manual (+/-) edits don't touch these deps, so they
  // survive; changing region/retailer/size/type intentionally starts fresh.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reseed the bundle on a store-context change; manual basket edits reset by design here
    setBasket(seed(size, type, rangingFor(region, retailer, name).excluded));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- region/retailer/name feed excludedKey; depending on the key avoids a reseed on every name keystroke
  }, [size, type, excludedKey]);

  function pickSize(s: Size) { setSize(s); setCap(CAP_DEFAULT[s]); }
  function pickType(t: SType) { setType(t); }
  function bump(id: string, d: number) { if (excluded.has(id)) return; setBasket((b) => ({ ...b, [id]: Math.max(0, (b[id] ?? 0) + d) })); }
  function reseed() { setBasket(seed(size, type, excluded)); }
  function toggleDay(d: string) { setDays((x) => ({ ...x, [d]: !x[d] })); }

  const total = useMemo(() => Object.values(basket).reduce((a, b) => a + b, 0), [basket]);
  const fill = Math.min(100, Math.round((total / cap) * 100));
  const over = total > cap;
  const byCat = useMemo(() => {
    const m: Record<Cat, number> = { sourdough: 0, bagel: 0, minichallah: 0, pita: 0 };
    for (const p of PRODUCTS) m[p.cat] += basket[p.id] ?? 0;
    return m;
  }, [basket]);

  const grouped = CAT_ORDER.map((c) => ({ cat: c, items: PRODUCTS.filter((p) => p.cat === c) }));
  const deliveryDays = DAYS.filter((d) => days[d]);

  return (
    <div className="nstore">
      <div className="panel intro">
        <div className="itxt">
          <b>Enter once, set the ceiling, let it fill.</b> A new store has no sales history, so we seed
          <b> Simona&apos;s baseline stock bundle</b> — sized to the store — then cap it at the shelf max and let the plan
          take over as real sales come in. The bundle is her spec (active until data lands), on the real Jesse&apos;s lines
          with their Woolworths product numbers. No per-product guessing, and no override that gets forgotten.
        </div>
      </div>

      <div className="grid2">
        <div className="main">
          {/* 1. Identity */}
          <div className="sec">
            <div className="sec-h"><span className="no">1</span>Store identity</div>
            <div className="fgrid">
              <label className="fld f-2">
                <span>Store name <i className="req">required</i></span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Woolworths Metro Bonner" />
              </label>
              <label className="fld">
                <span>Store number <i className="opt">optional</i></span>
                <input value={storeNo} onChange={(e) => setStoreNo(e.target.value)} placeholder="e.g. 1457" />
              </label>
              <div className="fld f-3">
                <span>Retailer</span>
                <div className="seg">
                  {RETAILERS.map((r) => (
                    <button key={r.id} className={retailer === r.id ? "on" : ""} onClick={() => setRetailer(r.id)}>{r.label}</button>
                  ))}
                </div>
              </div>
              <label className="fld">
                <span>Region</span>
                <select value={region} onChange={(e) => setRegion(e.target.value)}>
                  {regionOpts.map((r) => <option key={r} value={r}>{titleCaseRegion(r)}</option>)}
                </select>
              </label>
              <label className="fld">
                <span>Delivery run</span>
                <select value={run} onChange={(e) => setRun(e.target.value)}>
                  {["1", "2", "3", "4", "5", "6", "7", "8"].map((r) => <option key={r}>Run {r}</option>)}
                </select>
              </label>
              <div className="fld f-3">
                <span>Delivery days</span>
                <div className="days">
                  {DAYS.map((d) => (
                    <button key={d} className={days[d] ? "on" : ""} onClick={() => toggleDay(d)}>{d}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 2. Size & capacity */}
          <div className="sec">
            <div className="sec-h"><span className="no">2</span>Size &amp; shelf capacity</div>
            <div className="fld">
              <span>Store size — sets Simona&apos;s bundle</span>
              <div className="seg big">
                {(["small", "medium", "large"] as Size[]).map((s) => (
                  <button key={s} className={size === s ? "on" : ""} onClick={() => pickSize(s)}>
                    <b>{SIZE_META[s].label}</b>
                    <small>{SIZE_META[s].shelf} · ~{SIZE_META[s].seeded} seeded</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="fld" style={{ marginTop: 14 }}>
              <span>Store type — skews the sourdough / bagel split</span>
              <div className="seg big">
                {([["standard", "Standard", "Simona's baseline"], ["sourdough", "Sourdough-led", "Bread-heavy"], ["bagel", "Bagel-led", "Bagel-heavy"]] as [SType, string, string][]).map(([t, l, d]) => (
                  <button key={t} className={type === t ? "on" : ""} onClick={() => pickType(t)}>
                    <b>{l}</b><small>{d}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="fld caprow" style={{ marginTop: 14 }}>
              <span>Shelf max — the hard ceiling the plan never exceeds</span>
              <div className="capstep">
                <button onClick={() => setCap((c) => Math.max(total, c - 5))} aria-label="Lower cap">−</button>
                <div className="capval">{cap}<small>units</small></div>
                <button onClick={() => setCap((c) => c + 5)} aria-label="Raise cap">+</button>
              </div>
            </div>
          </div>

          {/* 3. Starting basket */}
          <div className="sec">
            <div className="sec-h"><span className="no">3</span>Starting bundle
              <div className="seedsrc">
                <button className={source === "profile" ? "on" : ""} onClick={() => setSource("profile")}>Simona&apos;s bundle</button>
                <button className={source === "copy" ? "on" : ""} onClick={() => setSource("copy")}>Copy a similar store</button>
              </div>
            </div>
            {source === "copy" && (
              <div className="copynote">
                Copies the basket of the closest same-size store on this run as the starting point — then you tweak. (Prototype uses Simona&apos;s bundle below.)
              </div>
            )}
            {reasons.length > 0 && (
              <div className="rangenote">
                <b>Ranging applied.</b> {reasons.join("; ")}. Those lines are left out of the bundle and their
                units redistribute across what this store does range.
              </div>
            )}
            <div className="basket">
              {grouped.map((g) => (
                <div className="bgroup" key={g.cat}>
                  <div className="bgh"><i style={{ background: CAT_COLOR[g.cat] }} />{CAT_LABEL[g.cat]}<span className="bgt">{byCat[g.cat]}</span></div>
                  {g.items.map((p) => (
                    excluded.has(p.id) ? (
                      <div className="brow off" key={p.id}>
                        <span className="bn">{p.name}<span className="pcode">#{p.code}</span></span>
                        <span className="notranged">Not ranged here</span>
                      </div>
                    ) : (
                      <div className="brow" key={p.id}>
                        <span className="bn">{p.name}<span className="pcode">#{p.code}</span></span>
                        <div className="bstep">
                          <button onClick={() => bump(p.id, -1)} aria-label="less">−</button>
                          <span className="bq">{basket[p.id] ?? 0}</span>
                          <button onClick={() => bump(p.id, +1)} aria-label="more">+</button>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              ))}
            </div>
            <button className="reseed" onClick={reseed}>↺ Reset to Simona&apos;s {SIZE_META[size].label.toLowerCase()} bundle{type === "standard" ? "" : ` (${type}-led)`}</button>
          </div>
        </div>

        {/* Right rail — live preview */}
        <div className="rail">
          <div className="panel card">
            <div className="cardh">
              <div className="ch-name">{name || "New store"}</div>
              <span className="newtag">● New — learning</span>
            </div>
            <div className="ch-meta">
              {RETAILERS.find((r) => r.id === retailer)?.label} · {region} · Run {run}
            </div>
            <div className="ch-meta2">
              {SIZE_META[size].label} · {type === "standard" ? "Standard" : type === "sourdough" ? "Sourdough-led" : "Bagel-led"}
              {deliveryDays.length > 0 && <> · {deliveryDays.join(" ")}</>}
            </div>

            <div className="meter">
              <div className="meter-top">
                <span className="m-big">{total}<small> / {cap} units</small></span>
                <span className={`m-pct${over ? " over" : ""}`}>{over ? "over cap" : fill + "% filled"}</span>
              </div>
              <div className="bar"><span style={{ width: fill + "%", background: over ? "var(--red)" : "var(--crust)" }} /></div>
              <div className="m-note">
                {over
                  ? "Over the shelf max — trim the bundle or raise the ceiling before go-live."
                  : `Simona's bundle at ${fill}% of shelf — room to grow as real sales come in.`}
              </div>
            </div>

            <div className="catsplit">
              {CAT_ORDER.map((c) => (
                <div className="cs" key={c}><i style={{ background: CAT_COLOR[c] }} /><span>{CAT_LABEL[c]}</span><b>{byCat[c]}</b></div>
              ))}
            </div>

            <div className="fld" style={{ marginTop: 16 }}>
              <span>Service level at go-live</span>
              <div className="seg">
                {([["lean", "Lean"], ["balanced", "Balanced"], ["generous", "Generous"]] as [typeof service, string][]).map(([s, l]) => (
                  <button key={s} className={service === s ? "on" : ""} onClick={() => setService(s)}>{l}</button>
                ))}
              </div>
            </div>

            <div className="fld" style={{ marginTop: 18 }}>
              <span>Launch timing</span>
              <div className="seg">
                {([["upcoming", "Upcoming launch"], ["live", "Go live now"]] as [typeof timing, string][]).map(([t, l]) => (
                  <button key={t} className={timing === t ? "on" : ""} onClick={() => { setTiming(t); setSaved(null); }}>{l}</button>
                ))}
              </div>
            </div>
            {timing === "upcoming" ? (
              <div className="fld" style={{ marginTop: 10 }}>
                <span>Planned go-live date</span>
                <input type="date" value={goLiveDate} onChange={(e) => { setGoLiveDate(e.target.value); setSaved(null); }} />
                <div className="timingnote">Tracked in Launches under Coming up until it goes live — never lost in the archive.</div>
              </div>
            ) : (
              <div className="timingnote" style={{ marginTop: 10 }}>Marks the store active from today and starts its 6-week launch tracking. Set a date below to backdate it.
                <input type="date" value={goLiveDate} onChange={(e) => setGoLiveDate(e.target.value)} style={{ marginTop: 8 }} />
              </div>
            )}
            <button
              className="create"
              disabled={!name || over || saving || (timing === "upcoming" && !goLiveDate)}
              onClick={submit}
            >
              {saving ? "Saving…" : timing === "live" ? "Create & go live" : "Create store"}
            </button>
            {!saving && (!name || over || (timing === "upcoming" && !goLiveDate)) ? (
              <div className="createhint">
                {!name
                  ? "Add a store name to continue."
                  : over
                  ? "The bundle is over the shelf max — trim it or raise the cap first."
                  : "Set a planned go-live date to continue."}
              </div>
            ) : null}
            <div className="savescope">Creates the store and its go-live. The starting bundle, run and delivery days are the plan it launches with — saved to the plan as the feed comes online.</div>
            {saved && (
              <div className={`savemsg ${saved.ok ? "ok" : "err"}`}>
                {saved.msg}{saved.ok && <> <a href="/launches">Open Launches →</a></>}
              </div>
            )}
            <div className="learnnote">
              First few weeks the plan holds close to Simona&apos;s bundle while it learns the store&apos;s real demand — then
              it takes over sizing every order, capped at the {cap}-unit shelf max. Challah, babka and specialty lines add
              on as the store picks them up.
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .nstore .intro{margin-bottom:16px}
        .nstore .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
        .nstore .intro b{color:var(--ink);font-weight:600}
        .nstore .grid2{display:grid;grid-template-columns:1.55fr 1fr;gap:18px;align-items:start}
        .nstore .main{display:flex;flex-direction:column;gap:16px}
        .nstore .sec{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:18px 20px}
        .nstore .sec-h{font-family:var(--serif);font-size:16px;font-weight:600;display:flex;align-items:center;gap:10px;margin-bottom:14px}
        .nstore .no{width:22px;height:22px;border-radius:50%;background:var(--espresso);color:#f0e6d2;font-family:var(--sans);font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:none}
        .nstore .fgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
        .nstore .fld{display:flex;flex-direction:column;gap:6px}
        .nstore .fld>span{font-size:12px;font-weight:600;color:var(--ink2)}
        .nstore .f-2{grid-column:span 2}.nstore .f-3{grid-column:span 3}
        .nstore input,.nstore select{border:1px solid var(--line);border-radius:9px;padding:9px 11px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink);outline:none;width:100%}
        .nstore input:focus,.nstore select:focus{border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.13)}
        .nstore .seg{display:flex;gap:0;border:1px solid var(--line);border-radius:9px;overflow:hidden;flex-wrap:wrap}
        .nstore .seg button{flex:1;border:none;background:var(--card);padding:9px 10px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit;border-right:1px solid var(--line);min-width:70px}
        .nstore .seg button:last-child{border-right:none}
        .nstore .seg button.on{background:var(--espresso);color:#f7efdd}
        .nstore .seg.big button{flex-direction:column;gap:2px;display:flex;align-items:flex-start;padding:11px 13px;line-height:1.2}
        .nstore .seg.big button b{font-size:13.5px}
        .nstore .seg.big button small{font-size:11px;color:var(--muted);font-weight:500}
        .nstore .seg.big button.on small{color:#d8c9a6}
        .nstore .days{display:flex;gap:6px;flex-wrap:wrap}
        .nstore .days button{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:8px 12px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit}
        .nstore .days button.on{background:var(--crust);border-color:var(--crust);color:#fff}
        .nstore .caprow{flex-direction:row;align-items:center;justify-content:space-between;gap:16px}
        .nstore .capstep{display:flex;align-items:center;gap:2px;border:1px solid var(--line);border-radius:10px;overflow:hidden;flex:none}
        .nstore .capstep button{width:36px;height:44px;border:none;background:var(--card);cursor:pointer;font-size:18px;color:var(--ink2);font-family:inherit}
        .nstore .capstep button:hover{background:#f3ecdd}
        .nstore .capval{min-width:64px;text-align:center;font-family:var(--serif);font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;display:flex;flex-direction:column;line-height:1}
        .nstore .capval small{font-size:10px;color:var(--muted);font-family:var(--sans);font-weight:600;margin-top:2px}
        .nstore .seedsrc{margin-left:auto;display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
        .nstore .seedsrc button{border:none;background:var(--card);padding:6px 11px;font-size:11.5px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit;border-right:1px solid var(--line)}
        .nstore .seedsrc button:last-child{border-right:none}
        .nstore .seedsrc button.on{background:var(--surface);color:var(--crust-deep)}
        .nstore .copynote{font-size:12.5px;color:var(--muted);background:var(--surface);border:1px solid var(--line2);border-radius:9px;padding:10px 12px;margin-bottom:12px;line-height:1.5}
        .nstore .basket{display:grid;grid-template-columns:1fr 1fr;gap:10px 22px}
        .nstore .bgh{display:flex;align-items:center;gap:7px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);font-weight:700;padding:6px 0;border-bottom:1px solid var(--line2);margin-bottom:4px}
        .nstore .bgh i{width:9px;height:9px;border-radius:3px}
        .nstore .bgh .bgt{margin-left:auto;color:var(--ink);font-size:13px;font-variant-numeric:tabular-nums}
        .nstore .rangenote{font-size:12.5px;color:var(--ink2);background:var(--amber-b);border:1px solid var(--amber);border-radius:9px;padding:10px 12px;margin-bottom:12px;line-height:1.5}
        .nstore .rangenote b{color:var(--amber-t);font-weight:700}
        .nstore .brow{display:flex;align-items:center;gap:8px;padding:4px 0}
        .nstore .brow.off .bn{opacity:.55}
        .nstore .notranged{margin-left:auto;font-size:11px;font-weight:600;color:var(--muted);background:var(--line2);border-radius:999px;padding:3px 10px;white-space:nowrap}
        .nstore .bn{font-size:13px;color:var(--ink2);display:flex;flex-direction:column;line-height:1.25}
        .nstore .pcode{font-size:10.5px;color:var(--faint);font-variant-numeric:tabular-nums}
        .nstore .bstep{margin-left:auto;display:flex;align-items:center;gap:1px;border:1px solid var(--line);border-radius:8px;overflow:hidden;flex:none}
        .nstore .bstep button{width:24px;height:26px;border:none;background:var(--card);cursor:pointer;font-size:14px;color:var(--ink2);font-family:inherit}
        .nstore .bstep button:hover{background:#f3ecdd}
        .nstore .bq{min-width:26px;text-align:center;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
        .nstore .reseed{margin-top:14px;border:1px solid var(--line);background:var(--surface);border-radius:9px;padding:9px 14px;font-size:12.5px;font-weight:600;color:var(--crust-deep);cursor:pointer;font-family:inherit}
        .nstore .reseed:hover{background:#f3ecdd}

        .nstore .rail{position:sticky;top:16px}
        .nstore .card{padding:20px}
        .nstore .cardh{display:flex;align-items:center;gap:10px}
        .nstore .ch-name{font-family:var(--serif);font-size:19px;font-weight:600;letter-spacing:-.3px}
        .nstore .newtag{margin-left:auto;font-size:11px;font-weight:700;color:var(--amber-t);background:var(--amber-b);padding:3px 9px;border-radius:999px;white-space:nowrap}
        .nstore .ch-meta{font-size:13px;color:var(--ink2);margin-top:6px}
        .nstore .ch-meta2{font-size:12.5px;color:var(--muted);margin-top:3px}
        .nstore .meter{margin-top:18px;padding-top:16px;border-top:1px solid var(--line2)}
        .nstore .meter-top{display:flex;align-items:baseline;justify-content:space-between}
        .nstore .m-big{font-family:var(--serif);font-size:30px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
        .nstore .m-big small{font-size:14px;color:var(--muted);font-family:var(--sans);font-weight:500}
        .nstore .m-pct{font-size:12.5px;font-weight:700;color:var(--crust-deep)}
        .nstore .m-pct.over{color:var(--red-t)}
        .nstore .bar{height:9px;border-radius:6px;background:var(--line2);overflow:hidden;margin:10px 0 8px}
        .nstore .bar span{display:block;height:100%;border-radius:6px;transition:width .2s}
        .nstore .m-note{font-size:12px;color:var(--muted);line-height:1.5}
        .nstore .catsplit{margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
        .nstore .cs{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--ink2)}
        .nstore .cs i{width:9px;height:9px;border-radius:3px;flex:none}
        .nstore .cs b{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--ink)}
        .nstore .create{width:100%;margin-top:18px;background:var(--espresso);color:#f7efdd;border:none;border-radius:10px;padding:13px;font-size:14.5px;font-weight:600;cursor:pointer;font-family:inherit}
        .nstore .create:hover{background:#3a2c22}
        .nstore .create:disabled{opacity:.45;cursor:not-allowed}
        .nstore .learnnote{font-size:11.5px;color:var(--muted);margin-top:12px;line-height:1.55}
        .nstore .timingnote{font-size:11.5px;color:var(--muted);line-height:1.5}
        .nstore .savemsg{margin-top:12px;font-size:12.5px;font-weight:600;border-radius:9px;padding:10px 12px;line-height:1.45}
        .nstore .savemsg.ok{background:var(--green-b);color:var(--green-t);border:1px solid var(--green)}
        .nstore .savemsg.err{background:var(--red-b,#f7e4e0);color:var(--red-t,#a4372a);border:1px solid var(--red,#c0563f)}
        .nstore .savemsg a{color:inherit;text-decoration:underline}
        .nstore .req,.nstore .opt{font-style:normal;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:999px;margin-left:6px;vertical-align:1px}
        .nstore .req{color:var(--red-t,#a4372a);background:var(--red-b,#f7e4e0)}
        .nstore .opt{color:var(--muted);background:var(--line2)}
        .nstore .createhint{font-size:11.5px;color:var(--muted);text-align:center;margin-top:8px;line-height:1.4}
        .nstore .savescope{font-size:11px;color:var(--muted);margin-top:10px;line-height:1.5}

        @media (max-width:1080px){ .nstore .grid2{grid-template-columns:1fr} .nstore .rail{position:static} }
      `}</style>
    </div>
  );
}
