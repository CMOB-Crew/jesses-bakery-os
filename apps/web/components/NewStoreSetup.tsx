"use client";
import { useMemo, useState } from "react";

/* ------------------------------------------------------------------ *
 * New-store setup — Simona's SOP: "enter once, set the ceiling, let it
 * fill." No sales history yet, so we seed a starting basket from the
 * store's size + type profile (the 9 basket profiles already in the
 * data), capped at shelf max, then the engine learns from real sales
 * over the first ~4 weeks and takes over. Front-end prototype — the
 * shape of the flow, wired to the real basket model.
 * ------------------------------------------------------------------ */

type Cat = "sourdough" | "bagel" | "challah" | "other";
type Size = "small" | "medium" | "large";
type SType = "standard" | "sourdough" | "bagel";

const PRODUCTS: { id: string; name: string; cat: Cat }[] = [
  { id: "sd-white", name: "White sourdough", cat: "sourdough" },
  { id: "sd-whole", name: "Wholemeal sourdough", cat: "sourdough" },
  { id: "sd-spelt", name: "Spelt sourdough", cat: "sourdough" },
  { id: "sd-rye", name: "Rye sourdough", cat: "sourdough" },
  { id: "bg-plain", name: "Plain bagel", cat: "bagel" },
  { id: "bg-sesame", name: "Sesame bagel", cat: "bagel" },
  { id: "bg-poppy", name: "Poppy bagel", cat: "bagel" },
  { id: "bg-mini", name: "Mini bagels (mixed)", cat: "bagel" },
  { id: "ch-plain", name: "Plain challah", cat: "challah" },
  { id: "ch-sesame", name: "Sesame challah", cat: "challah" },
  { id: "ch-raisin", name: "Raisin challah", cat: "challah" },
  { id: "ch-mini", name: "Mini challah", cat: "challah" },
  { id: "ot-pita", name: "Pita", cat: "other" },
  { id: "ot-babka", name: "Babka", cat: "other" },
  { id: "ot-scroll", name: "Cinnamon scroll", cat: "other" },
];

// Base basket = Medium, standard store. Scaled by size + skewed by type.
const BASE: Record<string, number> = {
  "sd-white": 14, "sd-whole": 9, "sd-spelt": 5, "sd-rye": 5,
  "bg-plain": 7, "bg-sesame": 5, "bg-poppy": 4, "bg-mini": 6,
  "ch-plain": 4, "ch-sesame": 3, "ch-raisin": 2, "ch-mini": 4,
  "ot-pita": 3, "ot-babka": 2, "ot-scroll": 2,
};
const SIZE_F: Record<Size, number> = { small: 0.55, medium: 1, large: 1.5 };
const CAP_DEFAULT: Record<Size, number> = { small: 60, medium: 110, large: 170 };
const TYPE_F: Record<SType, Record<Cat, number>> = {
  standard:  { sourdough: 1,    bagel: 1,    challah: 1,   other: 1 },
  sourdough: { sourdough: 1.4,  bagel: 0.8,  challah: 0.9, other: 0.9 },
  bagel:     { sourdough: 0.8,  bagel: 1.5,  challah: 0.9, other: 1 },
};

const CAT_LABEL: Record<Cat, string> = { sourdough: "Sourdough", bagel: "Bagels", challah: "Challah", other: "Pita & pastry" };
const CAT_COLOR: Record<Cat, string> = { sourdough: "#b0741c", bagel: "#8a5aa0", challah: "#5f8f5a", other: "#4f7396" };

const REGIONS = ["Eastern Suburbs", "Inner West", "North Shore", "Northern Beaches", "North West", "South", "South East", "Central Coast", "Canberra / ACT"];
const RETAILERS: { id: string; label: string }[] = [
  { id: "woolworths", label: "Woolworths" }, { id: "coles", label: "Coles" },
  { id: "harris_farm", label: "Harris Farm" }, { id: "direct", label: "Direct / invoice" },
];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function seed(size: Size, type: SType): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of PRODUCTS) {
    const q = BASE[p.id] * SIZE_F[size] * TYPE_F[type][p.cat];
    out[p.id] = Math.round(q);
  }
  return out;
}

export default function NewStoreSetup() {
  const [name, setName] = useState("");
  const [retailer, setRetailer] = useState("woolworths");
  const [storeNo, setStoreNo] = useState("");
  const [region, setRegion] = useState(REGIONS[0]);
  const [run, setRun] = useState("1");
  const [days, setDays] = useState<Record<string, boolean>>({ Mon: true, Tue: false, Wed: true, Thu: false, Fri: true, Sat: false, Sun: false });
  const [size, setSize] = useState<Size>("small");
  const [type, setType] = useState<SType>("standard");
  const [cap, setCap] = useState(CAP_DEFAULT.small);
  const [service, setService] = useState<"lean" | "balanced" | "generous">("balanced");
  const [source, setSource] = useState<"profile" | "copy">("profile");
  const [basket, setBasket] = useState<Record<string, number>>(() => seed("small", "standard"));

  function pickSize(s: Size) { setSize(s); setCap(CAP_DEFAULT[s]); setBasket(seed(s, type)); }
  function pickType(t: SType) { setType(t); setBasket(seed(size, t)); }
  function bump(id: string, d: number) { setBasket((b) => ({ ...b, [id]: Math.max(0, (b[id] ?? 0) + d) })); }
  function reseed() { setBasket(seed(size, type)); }
  function toggleDay(d: string) { setDays((x) => ({ ...x, [d]: !x[d] })); }

  const total = useMemo(() => Object.values(basket).reduce((a, b) => a + b, 0), [basket]);
  const fill = Math.min(100, Math.round((total / cap) * 100));
  const over = total > cap;
  const byCat = useMemo(() => {
    const m: Record<Cat, number> = { sourdough: 0, bagel: 0, challah: 0, other: 0 };
    for (const p of PRODUCTS) m[p.cat] += basket[p.id] ?? 0;
    return m;
  }, [basket]);

  const grouped = (["sourdough", "bagel", "challah", "other"] as Cat[]).map((c) => ({
    cat: c, items: PRODUCTS.filter((p) => p.cat === c),
  }));

  const deliveryDays = DAYS.filter((d) => days[d]);

  return (
    <div className="nstore">
      <div className="panel intro">
        <div className="itxt">
          <b>Enter once, set the ceiling, let it fill.</b> A new store has no sales history, so we seed a starting
          basket from its size and type — then cap it at the shelf max and let the engine learn from real sales over
          the first few weeks. No per-product guessing, and no override that gets forgotten.
        </div>
      </div>

      <div className="grid2">
        <div className="main">
          {/* 1. Identity */}
          <div className="sec">
            <div className="sec-h"><span className="no">1</span>Store identity</div>
            <div className="fgrid">
              <label className="fld f-2">
                <span>Store name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Woolworths Bondi Junction" />
              </label>
              <label className="fld">
                <span>Store number</span>
                <input value={storeNo} onChange={(e) => setStoreNo(e.target.value)} placeholder="e.g. 1462" />
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
                  {REGIONS.map((r) => <option key={r}>{r}</option>)}
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
              <span>Store size</span>
              <div className="seg big">
                {(["small", "medium", "large"] as Size[]).map((s) => (
                  <button key={s} className={size === s ? "on" : ""} onClick={() => pickSize(s)}>
                    <b>{s[0].toUpperCase() + s.slice(1)}</b>
                    <small>{s === "small" ? "~40 units" : s === "medium" ? "~75 units" : "~110+ units"}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="fld" style={{ marginTop: 14 }}>
              <span>Store type — sets the starting mix</span>
              <div className="seg big">
                {([["standard", "Standard", "Even spread"], ["sourdough", "Sourdough-led", "Bread-heavy"], ["bagel", "Bagel-led", "Bagel-heavy"]] as [SType, string, string][]).map(([t, l, d]) => (
                  <button key={t} className={type === t ? "on" : ""} onClick={() => pickType(t)}>
                    <b>{l}</b><small>{d}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="fld caprow" style={{ marginTop: 14 }}>
              <span>Shelf max — the hard ceiling the engine never exceeds</span>
              <div className="capstep">
                <button onClick={() => setCap((c) => Math.max(total, c - 5))} aria-label="Lower cap">−</button>
                <div className="capval">{cap}<small>units</small></div>
                <button onClick={() => setCap((c) => c + 5)} aria-label="Raise cap">+</button>
              </div>
            </div>
          </div>

          {/* 3. Starting basket */}
          <div className="sec">
            <div className="sec-h"><span className="no">3</span>Starting basket
              <div className="seedsrc">
                <button className={source === "profile" ? "on" : ""} onClick={() => setSource("profile")}>From size profile</button>
                <button className={source === "copy" ? "on" : ""} onClick={() => setSource("copy")}>Copy a similar store</button>
              </div>
            </div>
            {source === "copy" && (
              <div className="copynote">
                Copies the basket of the closest same-size store on this run as the starting point — then you tweak. (Prototype uses the size profile below.)
              </div>
            )}
            <div className="basket">
              {grouped.map((g) => (
                <div className="bgroup" key={g.cat}>
                  <div className="bgh"><i style={{ background: CAT_COLOR[g.cat] }} />{CAT_LABEL[g.cat]}<span className="bgt">{byCat[g.cat]}</span></div>
                  {g.items.map((p) => (
                    <div className="brow" key={p.id}>
                      <span className="bn">{p.name}</span>
                      <div className="bstep">
                        <button onClick={() => bump(p.id, -1)} aria-label="less">−</button>
                        <span className="bq">{basket[p.id] ?? 0}</span>
                        <button onClick={() => bump(p.id, +1)} aria-label="more">+</button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <button className="reseed" onClick={reseed}>↺ Reset to the {size} {type === "standard" ? "standard" : type + "-led"} profile</button>
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
              {size[0].toUpperCase() + size.slice(1)} · {type === "standard" ? "Standard" : type === "sourdough" ? "Sourdough-led" : "Bagel-led"}
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
                  ? "Over the shelf max — trim the basket or raise the ceiling before go-live."
                  : `Seeded at ${fill}% — room to grow as real sales come in.`}
              </div>
            </div>

            <div className="catsplit">
              {(["sourdough", "bagel", "challah", "other"] as Cat[]).map((c) => (
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

            <button className="create" disabled={!name || over}>Create store</button>
            <div className="learnnote">
              First ~4 weeks the engine holds close to this basket while it learns the store&apos;s real demand — then it
              takes over sizing every order, capped at the {cap}-unit shelf max.
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
        .nstore .bgroup{}
        .nstore .bgh{display:flex;align-items:center;gap:7px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);font-weight:700;padding:6px 0;border-bottom:1px solid var(--line2);margin-bottom:4px}
        .nstore .bgh i{width:9px;height:9px;border-radius:3px}
        .nstore .bgh .bgt{margin-left:auto;color:var(--ink);font-size:13px;font-variant-numeric:tabular-nums}
        .nstore .brow{display:flex;align-items:center;gap:8px;padding:4px 0}
        .nstore .bn{font-size:13px;color:var(--ink2)}
        .nstore .bstep{margin-left:auto;display:flex;align-items:center;gap:1px;border:1px solid var(--line);border-radius:8px;overflow:hidden}
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

        @media (max-width:1080px){ .nstore .grid2{grid-template-columns:1fr} .nstore .rail{position:static} }
      `}</style>
    </div>
  );
}
