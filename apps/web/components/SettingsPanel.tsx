"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import type { EngineScenario, AppSettings, FeedStatus } from "@/lib/queries";
import { saveSetting } from "@/app/settings/actions";

const RETAILER: Record<string, string> = {
  woolworths: "Woolworths",
  coles: "Coles",
  harris_farm: "Harris Farm",
  invoice: "Invoice customers",
};
const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "long" });

const nf = (n: number) => n.toLocaleString("en-AU");
// Null-safe first word. Guards prerender: if the plan_projection feed is slow
// or a row lands without a label during a Netlify build, this returns "" instead
// of throwing on undefined.split() and failing the whole build.
const firstWord = (s?: string | null) => (s ? String(s).split(" ")[0] : "");

const CORE_BASKET = [
  "Sourdough – White", "Sourdough – Wholemeal", "Sourdough – Soy & Linseed", "Sourdough – Spelt", "Sourdough – Rye",
  "Dark Rye", "Bagel – Plain", "Bagel – Sesame", "Bagel – Mixed Seeds", "Bagel – Poppy Seed",
  "Mini Challah – Plain", "Mini Challah – Sesame", "Pita – White", "Large Challah – Plain", "Large Challah – Sesame",
];

type Size = { key: "S" | "M" | "L"; label: string; cap: number; fill: number };
const SIZES0: Size[] = [
  { key: "S", label: "Small", cap: 45, fill: 30 },
  { key: "M", label: "Medium", cap: 80, fill: 55 },
  { key: "L", label: "Large", cap: 120, fill: 85 },
];

type Factor = { key: string; name: string; note: string; weight: string; on: boolean };
const FACTORS0: Factor[] = [
  { key: "weekend", name: "Weekend uplift", note: "Sat–Sun run well above weekday; the max pushes to the high end automatically.", weight: "High", on: true },
  { key: "school", name: "School holidays", note: "≈ −30% most regions; holiday-destination regions (Central Coast) can rise instead.", weight: "Per-region", on: true },
  { key: "public", name: "Public holidays", note: "Christmas ≈ +40%, Easter relevant. Set per date on the calendar.", weight: "Med", on: true },
  { key: "jewish", name: "Jewish holidays", note: "Rosh Hashanah (~11 Sep): large-challah spike at ~6 Jewish-demographic stores.", weight: "Targeted", on: true },
  { key: "weather", name: "Weather", note: "Cold snaps lift bread (toasties, soup). Needs a weather feed — off until wired.", weight: "Low", on: false },
];

export default function SettingsPanel({ scenarios, settings = {}, feeds = [] }: { scenarios: EngineScenario[]; settings?: AppSettings; feeds?: FeedStatus[] }) {
  const engines = useMemo(() => scenarios.filter((s) => s.scenario !== "current").sort((a, b) => a.ord - b.ord), [scenarios]);
  // What the network is doing TODAY, so the projection below is never read as a
  // statement of the present. Overview says 34.5%; this panel used to say 22.6%
  // with no indication it was a forecast, on the same screen a client clicks
  // between. Both numbers were right and the pair of them was misleading.
  const current = useMemo(() => scenarios.find((s) => s.scenario === "current"), [scenarios]);
  const [, startSave] = useTransition();

  // Saved config (migration 016) hydrates the controls; missing keys fall back
  // to the built-in defaults.
  const svc = (settings.service_level ?? {}) as { level?: string };
  const savedMins = (settings.product_minimums ?? {}) as Record<string, number>;
  const savedSizes = settings.size_baskets as Size[] | undefined;
  const sl = (settings.shelf_lead ?? {}) as { shelfDays?: number; pullDays?: number; sdLead?: number; otherLead?: number };
  const savedFactors = (settings.seasonality_factors ?? {}) as Record<string, boolean>;

  const [sel, setSel] = useState(svc.level ?? "balanced");
  const [scope, setScope] = useState<"network" | "store" | "product">("network");
  const [mins, setMins] = useState<Record<string, number>>(() => ({ ...Object.fromEntries(CORE_BASKET.map((p) => [p, 2])), ...savedMins }));
  const [sizes, setSizes] = useState<Size[]>(() => (Array.isArray(savedSizes) && savedSizes.length ? savedSizes : SIZES0));
  const wt = (settings.waste_thresholds ?? {}) as { small?: number; medium?: number; large?: number };
  const [wtSmall, setWtSmall] = useState(wt.small ?? 16);
  const [wtMedium, setWtMedium] = useState(wt.medium ?? 20);
  const [wtLarge, setWtLarge] = useState(wt.large ?? 25);
  const [shelfDays, setShelfDays] = useState(sl.shelfDays ?? 6);
  const [pullDays, setPullDays] = useState(sl.pullDays ?? 2);
  const [sdLead, setSdLead] = useState(sl.sdLead ?? 2);
  const [otherLead, setOtherLead] = useState(sl.otherLead ?? 1);
  const [factors, setFactors] = useState<Factor[]>(() => FACTORS0.map((f) => (f.key in savedFactors ? { ...f, on: savedFactors[f.key] } : f)));
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const eng = engines.find((e) => e.scenario === sel) ?? engines.find((e) => e.scenario === "balanced") ?? engines[0];

  function ping(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }
  // Persist one config group and report honestly (saved / preview-only / error).
  function persist(key: string, value: unknown, label: string) {
    startSave(async () => {
      const res = await saveSetting(key, value);
      if (res.ok) ping(res.readonly ? `${label} — preview only (this demo doesn't save changes)` : `${label} — saved`);
      else ping(`Couldn't save: ${res.error}`);
    });
  }
  const setMin = (p: string, d: number) => {
    const next = { ...mins, [p]: Math.max(0, (mins[p] ?? 2) + d) };
    setMins(next);
    persist("product_minimums", next, "Minimum updated");
  };
  const setSize = (k: string, field: "cap" | "fill", v: number) => setSizes((ss) => ss.map((s) => (s.key === k ? { ...s, [field]: Math.max(0, v) } : s)));
  const persistSizes = () => persist("size_baskets", sizes, "Size basket updated");
  const persistShelfLead = () => persist("shelf_lead", { shelfDays, pullDays, sdLead, otherLead }, "Shelf & lead updated");
  const persistWaste = () => persist("waste_thresholds", { small: wtSmall, medium: wtMedium, large: wtLarge }, "Waste thresholds updated");
  const toggleFactor = (k: string) => {
    const next = factors.map((f) => (f.key === k ? { ...f, on: !f.on } : f));
    setFactors(next);
    persist("seasonality_factors", Object.fromEntries(next.map((f) => [f.key, f.on])), "Factor toggled");
  };

  return (
    <section className="setp">
      <div className="lead-panel">
        The plan is not a black box — every number here is a lever you control. This is exactly how it decides what to bake and send. Nothing is guessed; defaults come from Jesse&apos;s and Simona&apos;s calls, and change the moment you say so. <b>Every change here saves to the plan&apos;s config.</b>
      </div>

      {/* SERVICE LEVEL */}
      <div className="sec"><span className="tick" />Service level</div>
      <div className="card">
        <div className="row-top">
          <div className="desc">
            The one dial that trades waste against selling out.
            {eng ? (
              <>
                {" "}Today the stores we can measure run <b>{current?.waste_pct ?? "—"}%</b> waste.
                At <b>{firstWord(eng.label)}</b> the plan <b>would</b> bring that to <b>{eng.waste_pct}%</b>,
                for <b>{eng.lost_sales_pct ?? "—"}%</b> lost sales, saving <b>{nf(Number(eng.units_saved_wk) || 0)}</b> loaves a week.
              </>
            ) : null}
            <span className="scopenote">
              Every figure on this dial is measured across the stores that send us their sales — not the whole network.
              Stores with no feed keep their standing order and are not part of these numbers.
            </span>
          </div>
          <div className="scope">
            {(["network", "store", "product"] as const).map((sc) => (
              <button key={sc} type="button" className={scope === sc ? "on" : ""} onClick={() => setScope(sc)}>{sc === "network" ? "Network" : sc === "store" ? "Per store" : "Per product"}</button>
            ))}
          </div>
        </div>
        <div className="dial">
          {engines.map((e) => (
            <button key={e.scenario} type="button" className={`dbtn ${e.scenario === sel ? "on" : ""}`} onClick={() => { setSel(e.scenario); persist("service_level", { level: e.scenario }, `Service level set to ${firstWord(e.label)}`); }}>
              <span className="dl">{firstWord(e.label)}{e.scenario === "balanced" && <small>default</small>}</span>
              <span className="dv">{e.waste_pct}% <i>waste</i></span>
              <span className="dv2">{e.lost_sales_pct ?? "—"}% lost · {nf(Number(e.units_saved_wk) || 0)}/wk</span>
            </button>
          ))}
        </div>
        <div className="hint">{scope === "network" ? "Applies to every store. Override per store or per product from a store profile." : scope === "store" ? "Pick this store's level on its profile — overrides the network default." : "Set a single product tighter or looser everywhere (e.g. run challah leaner)."}</div>
      </div>

      {/* MINIMUM PER PRODUCT */}
      <div className="sec"><span className="tick" />Minimum per product <span className="secnote">the floor a store carrying a line never drops below — 2 across the core lines by default, editable here</span></div>
      <div className="card">
        <div className="minsgrid">
          {CORE_BASKET.map((p) => (
            <div className="minrow" key={p}>
              <span className="mp">{p}</span>
              <span className="stepper">
                <button type="button" onClick={() => setMin(p, -1)} aria-label={`decrease ${p}`}>−</button>
                <span className="mv">{mins[p]}</span>
                <button type="button" onClick={() => setMin(p, 1)} aria-label={`increase ${p}`}>+</button>
              </span>
            </div>
          ))}
        </div>
        <div className="hint">A store carrying a line never gets sent below its minimum — keeps the shelf looking stocked. 15 core products; specials sit outside the minimum.</div>
      </div>

      {/* SIZE BASKETS */}
      <div className="sec"><span className="tick" />Store size baskets <span className="secnote">S / M / L shelf capacity and starter fill for a new store</span></div>
      <div className="sizes">
        {sizes.map((s) => (
          <div className="sizecard" key={s.key}>
            <div className="sh"><span className="badge">{s.key}</span>{s.label}</div>
            <label className="fld">Shelf capacity
              <input value={s.cap} inputMode="numeric" onChange={(e) => setSize(s.key, "cap", parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)} onBlur={persistSizes} />
            </label>
            <label className="fld">New-store starter fill
              <input value={s.fill} inputMode="numeric" onChange={(e) => setSize(s.key, "fill", parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)} onBlur={persistSizes} />
            </label>
            <div className="fillbar"><i style={{ width: `${s.cap > 0 ? Math.min(100, (s.fill / s.cap) * 100) : 0}%` }} /></div>
            <div className="fillnote">Seeds at {s.cap > 0 ? Math.round((s.fill / s.cap) * 100) : 0}% — headroom to grow as sales build.</div>
          </div>
        ))}
      </div>
      <div className="hint" style={{ margin: "10px 2px 0" }}>Three store types (standard, sourdough-led, bagel-led) sit on top of these sizes — nine baskets in all, already in the data. A new store: set its size once, seed the fill, it self-fulfils from there.</div>

      {/* SHELF LIFE & LEAD TIME */}
      <div className="sec"><span className="tick" />Waste thresholds by store size</div>
      <div className="card">
        <div className="fldgrid">
          <label className="fld2">Small store (% waste)<input value={wtSmall} inputMode="numeric" onChange={(e) => setWtSmall(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)} onBlur={persistWaste} /></label>
          <label className="fld2">Medium store (% waste)<input value={wtMedium} inputMode="numeric" onChange={(e) => setWtMedium(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)} onBlur={persistWaste} /></label>
          <label className="fld2">Large store (% waste)<input value={wtLarge} inputMode="numeric" onChange={(e) => setWtLarge(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)} onBlur={persistWaste} /></label>
        </div>
        <div className="hint">The waste % that flags a store as running hot, set per size — a small store sending 50 hits its limit at a lower % than a large store sending 120. These colour the size bands on the overview. Defaults are a starting point until you confirm your own.</div>
      </div>

      <div className="sec"><span className="tick" />Shelf life &amp; lead time</div>
      <div className="card">
        <div className="fldgrid">
          <label className="fld2">Total shelf life (days)<input value={shelfDays} inputMode="numeric" onChange={(e) => setShelfDays(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)} onBlur={persistShelfLead} /></label>
          <label className="fld2">Pull-off before expiry (days)<input value={pullDays} inputMode="numeric" onChange={(e) => setPullDays(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)} onBlur={persistShelfLead} /></label>
          <label className="fld2">Sourdough lead time (days)<input value={sdLead} inputMode="numeric" onChange={(e) => setSdLead(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)} onBlur={persistShelfLead} /></label>
          <label className="fld2">Everything-else lead time (days)<input value={otherLead} inputMode="numeric" onChange={(e) => setOtherLead(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)} onBlur={persistShelfLead} /></label>
        </div>
        <div className="hint">Day 1 is the day it leaves the bakery, so {shelfDays} total = {Math.max(0, shelfDays - 1)} sellable days on shelf. Daily-delivery stores pull stock with ≤{pullDays} days left; every-second-day stores pull the whole previous drop.</div>
      </div>

      {/* SEASONALITY */}
      <div className="sec"><span className="tick" />Seasonality factors <span className="secnote">what shifts demand beyond the weekly average</span></div>
      <div className="card" style={{ padding: 0 }}>
        {factors.map((f, i) => (
          <div className={`factor ${f.on ? "" : "off"}`} key={f.key} style={{ borderTop: i ? "1px solid var(--line2)" : undefined }}>
            <button type="button" className={`sw ${f.on ? "on" : ""}`} onClick={() => toggleFactor(f.key)} aria-label={`toggle ${f.name}`}><span className="knob" /></button>
            <div className="fbody">
              <div className="fname">{f.name} <span className="wchip">{f.weight}</span></div>
              <div className="fnote">{f.note}</div>
            </div>
          </div>
        ))}
      </div>

      {/* FEED COVERAGE */}
      <div className="sec"><span className="tick" />Feed coverage</div>
      <div className="card">
        {feeds.length === 0 ? (
          <div className="feed"><b className="a">● No feed readings yet</b> — this fills in as sales data lands.</div>
        ) : (
          feeds.map((f) => (
            <div className="feed" key={f.source}>
              <b className={f.status === "ok" ? "g" : "a"}>● {RETAILER[f.source] ?? f.source}</b>
              {f.status === "ok"
                ? " — sending sales. Full per-store, per-product orders on the plan."
                : ` — nothing received since ${fmtDate(f.as_of)}. These stores keep their standing order and are left out of the waste and sell-through figures until it comes back.`}
            </div>
          ))
        )}
        <div className="feednote">
          Read from the sales data itself, not from a list someone maintains by hand — so it cannot say a feed is
          healthy when it has gone quiet.
        </div>
      </div>

      {toast && <div className="settoast">{toast}</div>}

      <style>{`
      .setp{display:block;padding-bottom:40px}
      .setp .scopenote{display:block;margin-top:8px;font-size:11.5px;color:var(--muted);line-height:1.5;max-width:560px}
      .setp .feednote{margin-top:10px;font-size:11.5px;color:var(--muted);line-height:1.5}
      .setp .lead-panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:18px 22px;font-size:14.5px;line-height:1.6;color:var(--ink2)}
      .setp .lead-panel b{color:var(--ink);font-weight:600}
      .setp .sec{font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);font-weight:700;display:flex;align-items:center;gap:9px;margin:24px 2px 10px;flex-wrap:wrap}
      .setp .secnote{text-transform:none;letter-spacing:0;font-weight:400;color:var(--faint);font-size:12px}
      .setp .card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:18px 20px}
      .setp .row-top{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px}
      .setp .desc{flex:1;min-width:260px;font-size:14px;color:var(--ink2);line-height:1.6}
      .setp .desc b{color:var(--ink)}
      .setp .scope{display:flex;background:#ece3d1;border-radius:10px;padding:3px;gap:3px}
      .setp .scope button{border:none;background:transparent;font-family:inherit;font-size:12.5px;font-weight:600;color:var(--muted);padding:7px 12px;border-radius:8px;cursor:pointer}
      .setp .scope button.on{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(60,45,30,.16)}
      .setp .dial{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
      @media(max-width:640px){.setp .dial{grid-template-columns:1fr}}
      .setp .dbtn{text-align:left;border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:13px 15px;cursor:pointer;font-family:inherit;transition:.14s;display:flex;flex-direction:column;gap:5px}
      .setp .dbtn:hover{border-color:var(--crust)}
      .setp .dbtn.on{border-color:var(--crust);background:#fff;box-shadow:0 0 0 2px rgba(176,116,28,.18)}
      .setp .dbtn .dl{font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px}
      .setp .dbtn .dl small{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--green-t);background:var(--green-b);padding:2px 6px;border-radius:5px}
      .setp .dbtn .dv{font-family:var(--serif);font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
      .setp .dbtn .dv i{font-family:var(--sans);font-size:11px;color:var(--muted);font-style:normal;font-weight:500}
      .setp .dbtn .dv2{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
      .setp .hint{font-size:12px;color:var(--faint);line-height:1.5;margin-top:12px}
      .setp .minsgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:2px 22px}
      @media(max-width:640px){.setp .minsgrid{grid-template-columns:1fr}}
      .setp .minrow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line2)}
      .setp .mp{font-size:13.5px;font-weight:500}
      .setp .stepper{display:inline-flex;align-items:center;gap:10px}
      .setp .stepper button{width:28px;height:28px;border-radius:7px;border:1px solid var(--line);background:var(--card);font-size:16px;cursor:pointer;color:var(--ink2);font-family:inherit;line-height:1}
      .setp .stepper button:hover{border-color:var(--crust);background:#f6f0e6}
      .setp .stepper .mv{width:22px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums}
      .setp .sizes{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
      @media(max-width:760px){.setp .sizes{grid-template-columns:1fr}}
      .setp .sizecard{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
      .setp .sh{display:flex;align-items:center;gap:10px;font-family:var(--serif);font-size:17px;font-weight:600;margin-bottom:12px}
      .setp .badge{width:26px;height:26px;border-radius:8px;background:var(--espresso);color:#f4ecdc;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-family:var(--sans)}
      .setp .fld{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:10px}
      .setp .fld input,.setp .fld2 input{border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-size:15px;font-weight:700;font-family:inherit;font-variant-numeric:tabular-nums;color:var(--ink);background:var(--surface);outline:none;width:100%}
      .setp .fld input:focus,.setp .fld2 input:focus{border-color:var(--crust);background:#fff;box-shadow:0 0 0 3px rgba(176,116,28,.13)}
      .setp .fillbar{height:8px;background:#f0e9db;border-radius:5px;overflow:hidden;margin-top:4px}
      .setp .fillbar i{display:block;height:100%;background:var(--crust);border-radius:5px;transition:width .2s}
      .setp .fillnote{font-size:11.5px;color:var(--muted);margin-top:6px}
      .setp .fldgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
      @media(max-width:640px){.setp .fldgrid{grid-template-columns:1fr}}
      .setp .fld2{display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--muted);font-weight:600}
      .setp .factor{display:flex;align-items:flex-start;gap:14px;padding:14px 18px}
      .setp .factor.off{opacity:.62}
      .setp .sw{width:40px;height:23px;border-radius:999px;border:1px solid var(--line);background:#e7ddca;position:relative;cursor:pointer;flex:none;padding:0;margin-top:1px}
      .setp .sw.on{background:var(--green);border-color:var(--green)}
      .setp .sw .knob{position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;transition:.15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
      .setp .sw.on .knob{left:19px}
      .setp .fname{font-weight:600;font-size:14.5px;display:flex;align-items:center;gap:9px}
      .setp .wchip{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:var(--crust-deep);background:#f0e2cc;border-radius:999px;padding:2px 8px}
      .setp .fnote{font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.5}
      .setp .feed{font-size:14px;color:var(--ink2);line-height:1.7}
      .setp .feed b.g{color:var(--green)}.setp .feed b.a{color:var(--amber)}
      .setp .settoast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--espresso);color:#f6eddb;padding:12px 18px;border-radius:12px;box-shadow:var(--sh-pop);font-size:13px;font-weight:500;z-index:60;max-width:88vw;text-align:center}
      `}</style>
    </section>
  );
}
