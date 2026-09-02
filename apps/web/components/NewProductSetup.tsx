"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProduct } from "@/app/new-product/actions";
import type { StorePick, ProductCodeRow } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * New product — section 9 of the 1 Sept call. Simona named the fields:
 * name, tray or single, how many on a tray, the article number for
 * Coles and for Woolworths (they differ per supermarket), and
 * optionally which stores it goes to.
 *
 * The article numbers are the part that matters most and the part that
 * looks the most like admin. They are the ONLY way the sales feed finds
 * this product (migration 039). A product without them is a name in a
 * table: it records no sales, so it gets no forecast, so it never
 * appears on a packing sheet. The screen says so rather than leaving
 * three optional-looking boxes.
 * ------------------------------------------------------------------ */

const CATEGORIES: { id: string; label: string }[] = [
  { id: "sourdough", label: "Sourdough" },
  { id: "bagel", label: "Bagels" },
  { id: "challah", label: "Challah" },
  { id: "pita", label: "Pita" },
  { id: "pastry", label: "Pastry" },
  { id: "cake", label: "Cake" },
  { id: "other", label: "Other" },
];

const RETAILER_LABEL: Record<string, string> = {
  woolworths: "Woolworths", coles: "Coles", harris_farm: "Harris Farm", invoice: "Invoice",
};

// The client-side twin of public.jb_norm_code_safe (migration 039). Same rules,
// so the duplicate warning on screen matches the one the server will give:
// blank -> null, all zeros -> '0', digits -> leading zeros stripped, else upper.
function normCode(v: string): string | null {
  const s = v.trim();
  if (s === "") return null;
  if (/^0+$/.test(s)) return "0";
  if (/^[0-9]+$/.test(s)) return s.replace(/^0+/, "");
  return s.toUpperCase();
}

// A name like "Jesse's Mixed Seeds Bagels 5pk (X 5)" carries its own pack size.
// Migration 049 backfilled pack_size from exactly this pattern, so the form
// offers the same read rather than making someone type it twice.
function packFromName(name: string): number | null {
  const m = name.match(/\(X ?([0-9]+)\)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 && n <= 24 ? n : null;
}

type Props = { stores: StorePick[]; products: ProductCodeRow[] };

export default function NewProductSetup({ stores, products }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [name, setName] = useState("");
  const [category, setCategory] = useState("sourdough");
  const [uom, setUom] = useState<"UNIT" | "TRAY">("TRAY");
  const [bakingQty, setBakingQty] = useState("");
  const [packSize, setPackSize] = useState("1");
  const [packTouched, setPackTouched] = useState(false);
  const [woolies, setWoolies] = useState("");
  const [coles, setColes] = useState("");
  const [harris, setHarris] = useState("");
  const [ranging, setRanging] = useState<"all" | "some">("all");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [track, setTrack] = useState(true);
  const [date, setDate] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string; id?: string } | null>(null);

  // Pack size follows the name until someone sets it by hand.
  const suggestedPack = packFromName(name);
  const effPack = packTouched ? packSize : String(suggestedPack ?? packSize);

  const nameClash = useMemo(() => {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    return products.find((p) => p.name.toLowerCase() === n) ?? null;
  }, [name, products]);

  // Live article-number collision, using the same normalisation the loader
  // joins on. Shown as you type so it never gets as far as a server error.
  function codeClash(value: string, field: "coles" | "woolworths" | "harris"): ProductCodeRow | null {
    const n = normCode(value);
    if (!n) return null;
    return products.find((p) => normCode(String(p[field] ?? "")) === n) ?? null;
  }
  const wClash = codeClash(woolies, "woolworths");
  const cClash = codeClash(coles, "coles");
  const hClash = codeClash(harris, "harris");

  const byRun = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? stores.filter((s) => s.name.toLowerCase().includes(f) || (s.run ?? "").toLowerCase().includes(f)) : stores;
    const groups = new Map<string, StorePick[]>();
    for (const s of list) {
      const k = s.run ?? "No run set";
      const arr = groups.get(k);
      if (arr) arr.push(s); else groups.set(k, [s]);
    }
    return [...groups.entries()];
  }, [stores, filter]);

  const pickedCount = Object.values(picked).filter(Boolean).length;
  const noCodes = !woolies.trim() && !coles.trim() && !harris.trim();
  const trayQty = Number(bakingQty);
  const blocked =
    !name.trim() || !!nameClash || !!wClash || !!cClash || !!hClash ||
    (uom === "TRAY" && (!Number.isFinite(trayQty) || trayQty < 1)) ||
    (ranging === "some" && pickedCount === 0);

  function toggleAllIn(list: StorePick[], on: boolean) {
    setPicked((p) => {
      const next = { ...p };
      for (const s of list) next[s.id] = on;
      return next;
    });
  }

  function submit() {
    setMsg(null);
    start(async () => {
      const res = await createProduct({
        name: name.trim(),
        category,
        uom,
        bakingQty: uom === "TRAY" ? Number(bakingQty) : null,
        packSize: Number(effPack) || 1,
        colesCode: coles,
        woolworthsCode: woolies,
        harrisFarmCode: harris,
        trackLaunch: track,
        launchedAt: date || undefined,
        ranging,
        storeIds: Object.keys(picked).filter((k) => picked[k]),
      });
      if (res.ok) {
        setMsg({
          ok: true,
          id: res.id,
          text:
            `"${res.name}" is live` +
            (res.rangedTo === null ? " at every store." : ` at ${res.rangedTo} store${res.rangedTo === 1 ? "" : "s"}.`) +
            (noCodes ? " It has no article numbers yet, so the sales feed cannot find it — add them before go-live." : ""),
        });
        setName(""); setBakingQty(""); setPackSize("1"); setPackTouched(false);
        setWoolies(""); setColes(""); setHarris("");
        setRanging("all"); setPicked({}); setDate("");
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });
  }

  const trays = uom === "TRAY" && trayQty >= 1
    ? `A drop of 30 sold units is ${Math.ceil((30 * (Number(effPack) || 1)) / trayQty)} tray${Math.ceil((30 * (Number(effPack) || 1)) / trayQty) === 1 ? "" : "s"} to bake.`
    : null;

  return (
    <div className="nprod">
      <div className="grid2">
        <div className="main">

          <div className="sec">
            <div className="sec-h"><span className="no">1</span>The line</div>
            <div className="fgrid">
              <label className="fld f-2">
                <span>Product name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Turmeric Sourdough 900g" />
              </label>
              <label className="fld">
                <span>Category</span>
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
            </div>
            {nameClash && <div className="warn">There is already a product called <b>{nameClash.name}</b>. Names have to be unique.</div>}
          </div>

          <div className="sec">
            <div className="sec-h"><span className="no">2</span>How it is baked</div>
            <div className="fgrid">
              <div className="fld f-2">
                <span>Tray or single</span>
                <div className="seg big">
                  <button type="button" className={uom === "TRAY" ? "on" : ""} onClick={() => setUom("TRAY")}>
                    <b>Tray</b><small>Baked in trays — bagels, challah</small>
                  </button>
                  <button type="button" className={uom === "UNIT" ? "on" : ""} onClick={() => setUom("UNIT")}>
                    <b>Single</b><small>Baked one at a time — sourdough, pita</small>
                  </button>
                </div>
              </div>
              {uom === "TRAY" && (
                <label className="fld">
                  <span>How many on a tray</span>
                  <input inputMode="numeric" value={bakingQty} onChange={(e) => setBakingQty(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 24" />
                </label>
              )}
              <label className="fld">
                <span>Items in one sold unit <i className="opt">pack size</i></span>
                <input
                  inputMode="numeric"
                  value={effPack}
                  onChange={(e) => { setPackTouched(true); setPackSize(e.target.value.replace(/[^0-9]/g, "")); }}
                  placeholder="1"
                />
              </label>
              <div className="fld f-2 note">
                A supermarket sells one <b>unit</b>. For a 5-pack of bagels that unit is five items, so the tray maths has to
                multiply by five before it divides by the tray. Leave it at 1 for anything sold loose.
                {suggestedPack && !packTouched ? <> Read <b>{suggestedPack}</b> from the name.</> : null}
              </div>
            </div>
          </div>

          <div className="sec">
            <div className="sec-h"><span className="no">3</span>Article numbers</div>
            <div className="lead">
              These are the only thing the daily sales files match on, and each supermarket uses its own number for the same
              bread. Without them this product records no sales, so the engine never forecasts it and it never reaches a
              packing sheet.
            </div>
            <div className="fgrid">
              <label className="fld">
                <span>Woolworths</span>
                <input inputMode="numeric" value={woolies} onChange={(e) => setWoolies(e.target.value)} placeholder="e.g. 12140" />
                {wClash && <em className="clash">Already on {wClash.name}</em>}
              </label>
              <label className="fld">
                <span>Coles</span>
                <input inputMode="numeric" value={coles} onChange={(e) => setColes(e.target.value)} placeholder="e.g. 3534271" />
                {cClash && <em className="clash">Already on {cClash.name}</em>}
              </label>
              <label className="fld">
                <span>Harris Farm <i className="opt">if ranged</i></span>
                <input inputMode="numeric" value={harris} onChange={(e) => setHarris(e.target.value)} placeholder="e.g. 20781" />
                {hClash && <em className="clash">Already on {hClash.name}</em>}
              </label>
            </div>
            {noCodes && <div className="warn soft">No article numbers yet. You can still create the line — it just will not pick up sales until they are filled in.</div>}
          </div>

          <div className="sec">
            <div className="sec-h"><span className="no">4</span>Where it goes</div>
            <div className="seg">
              <button type="button" className={ranging === "all" ? "on" : ""} onClick={() => setRanging("all")}>Every store</button>
              <button type="button" className={ranging === "some" ? "on" : ""} onClick={() => setRanging("some")}>Only these stores</button>
            </div>
            {ranging === "all" ? (
              <div className="note pad">Ranged everywhere, which is what a new line defaults to today. Individual stores can still be
                switched off later from the store profile.</div>
            ) : (
              <>
                <div className="note pad">
                  Every store you leave unticked is written down as <b>not ranged</b>, so it stays off the plan and off the
                  packing sheet. This is the Woolworths Metro case — one product, a handful of stores.
                </div>
                <input className="srch" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by store or run…" />
                <div className="picker">
                  {byRun.map(([run, list]) => (
                    <div className="pgrp" key={run}>
                      <div className="pgh">
                        {run}
                        <button type="button" className="pall" onClick={() => toggleAllIn(list, true)}>all</button>
                        <button type="button" className="pall" onClick={() => toggleAllIn(list, false)}>none</button>
                      </div>
                      {list.map((s) => (
                        <button
                          type="button"
                          key={s.id}
                          className={`prow ${picked[s.id] ? "on" : ""}`}
                          aria-pressed={!!picked[s.id]}
                          onClick={() => setPicked((p) => ({ ...p, [s.id]: !p[s.id] }))}
                        >
                          <span className="pbox">{picked[s.id] ? "✓" : ""}</span>
                          <span className="pn">{s.name}</span>
                          <span className="pr">{RETAILER_LABEL[s.retailer] ?? s.retailer}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {byRun.length === 0 && <div className="note">No stores match that filter.</div>}
                </div>
              </>
            )}
          </div>

          <div className="sec">
            <div className="sec-h"><span className="no">5</span>Launch tracking</div>
            <label className="chk">
              <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
              <span>Track this as a launch — it appears in Launches and fills with units and sell-through as sales come in.</span>
            </label>
            {track && (
              <label className="fld dt">
                <span>Launch date <i className="opt">defaults to today</i></span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
            )}
          </div>
        </div>

        <aside className="rail">
          <div className="sec card">
            <div className="cardh">
              <span className="ch-name">{name.trim() || "New product"}</span>
              <span className="newtag">NEW</span>
            </div>
            <div className="ch-meta">{CATEGORIES.find((c) => c.id === category)?.label} · {uom === "TRAY" ? `tray of ${bakingQty || "?"}` : "baked single"}{Number(effPack) > 1 ? ` · sold in ${effPack}s` : ""}</div>
            {trays && <div className="ch-meta2">{trays}</div>}
            <div className="codes">
              <div className={`crow ${woolies.trim() ? "set" : ""}`}><span>Woolworths</span><b>{woolies.trim() || "—"}</b></div>
              <div className={`crow ${coles.trim() ? "set" : ""}`}><span>Coles</span><b>{coles.trim() || "—"}</b></div>
              <div className={`crow ${harris.trim() ? "set" : ""}`}><span>Harris Farm</span><b>{harris.trim() || "—"}</b></div>
            </div>
            <div className="ch-meta2 where">
              {ranging === "all" ? `Ranged at all ${stores.length} active stores.` : `Ranged at ${pickedCount} of ${stores.length} stores.`}
            </div>
            <button className="save" disabled={pending || blocked} onClick={submit}>
              {pending ? "Creating…" : "Create product"}
            </button>
            {msg && (
              <div className={`msg ${msg.ok ? "ok" : "err"}`}>
                {msg.text}
                {msg.ok && msg.id && <> <a href={`/product/${msg.id}`}>Open it →</a></>}
              </div>
            )}
          </div>
        </aside>
      </div>

      <style>{`
        .nprod .grid2{display:grid;grid-template-columns:1.55fr 1fr;gap:18px;align-items:start}
        .nprod .main{display:flex;flex-direction:column;gap:16px;min-width:0}
        .nprod .sec{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:18px 20px}
        .nprod .sec-h{font-family:var(--serif);font-size:16px;font-weight:600;display:flex;align-items:center;gap:10px;margin-bottom:14px}
        .nprod .no{width:22px;height:22px;border-radius:50%;background:var(--espresso);color:#f0e6d2;font-family:var(--sans);font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:none}
        .nprod .lead{font-size:12.5px;color:var(--ink2);line-height:1.55;margin:-4px 0 14px}
        .nprod .fgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
        .nprod .fld{display:flex;flex-direction:column;gap:6px;min-width:0}
        .nprod .fld>span{font-size:12px;font-weight:600;color:var(--ink2)}
        .nprod .opt{font-style:normal;color:var(--faint);font-weight:400}
        .nprod .f-2{grid-column:span 2}
        .nprod input,.nprod select{border:1px solid var(--line);border-radius:9px;padding:9px 11px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink);outline:none;width:100%}
        .nprod input:focus,.nprod select:focus{border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.13)}
        .nprod .seg{display:flex;gap:0;border:1px solid var(--line);border-radius:9px;overflow:hidden;flex-wrap:wrap}
        .nprod .seg button{flex:1;border:none;background:var(--card);padding:9px 10px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit;border-right:1px solid var(--line);min-width:90px}
        .nprod .seg button:last-child{border-right:none}
        .nprod .seg button.on{background:var(--espresso);color:#f7efdd}
        .nprod .seg.big button{flex-direction:column;gap:2px;display:flex;align-items:flex-start;padding:11px 13px;line-height:1.2}
        .nprod .seg.big button b{font-size:13.5px}
        .nprod .seg.big button small{font-size:11px;color:var(--muted);font-weight:500}
        .nprod .seg.big button.on small{color:#d8c9a6}
        .nprod .note{font-size:12px;color:var(--muted);line-height:1.55}
        .nprod .note b{color:var(--ink2);font-weight:600}
        .nprod .note.pad{margin-top:11px}
        .nprod .warn{margin-top:11px;background:var(--red-b,#f7e4e0);border:1px solid #eab9a8;border-radius:9px;padding:9px 12px;font-size:12.5px;color:var(--red-t,#a4372a);line-height:1.5}
        .nprod .warn.soft{background:var(--amber-b);border-color:var(--amber);color:var(--amber-t)}
        .nprod .clash{font-style:normal;font-size:11.5px;font-weight:600;color:var(--red-t,#a4372a)}
        .nprod .srch{margin-top:11px}
        .nprod .picker{margin-top:10px;max-height:340px;overflow-y:auto;border:1px solid var(--line2);border-radius:10px;padding:6px}
        .nprod .pgrp{margin-bottom:6px}
        .nprod .pgh{position:sticky;top:0;background:var(--card);display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);font-weight:700;padding:7px 8px 5px}
        .nprod .pall{margin-left:0;border:1px solid var(--line);background:var(--surface);border-radius:6px;font-family:inherit;font-size:10.5px;font-weight:700;letter-spacing:0;text-transform:none;color:var(--crust-deep);padding:2px 8px;cursor:pointer}
        .nprod .pall:first-of-type{margin-left:auto}
        .nprod .prow{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:8px;padding:7px 8px;cursor:pointer;font:inherit;color:inherit}
        .nprod .prow:hover{background:var(--surface)}
        .nprod .prow.on{background:#f4f8f2;border-color:#cfe2c6}
        .nprod .pbox{width:20px;height:20px;border-radius:6px;border:2px solid var(--line);background:var(--card);flex:none;display:flex;align-items:center;justify-content:center;font-size:12px;line-height:1;color:transparent}
        .nprod .prow.on .pbox{background:var(--green);border-color:var(--green);color:#fff}
        .nprod .pn{flex:1;min-width:0;font-size:13px;font-weight:600;overflow-wrap:anywhere}
        .nprod .pr{font-size:10.5px;color:var(--muted);font-weight:600;flex:none}
        .nprod .chk{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:var(--ink2);line-height:1.5;cursor:pointer}
        .nprod .chk input{width:17px;height:17px;flex:none;margin-top:2px;accent-color:var(--crust)}
        .nprod .fld.dt{margin-top:12px;max-width:240px}

        .nprod .rail{position:sticky;top:16px}
        .nprod .card{padding:20px}
        .nprod .cardh{display:flex;align-items:center;gap:10px}
        .nprod .ch-name{font-family:var(--serif);font-size:19px;font-weight:600;letter-spacing:-.3px;overflow-wrap:anywhere}
        .nprod .newtag{margin-left:auto;font-size:11px;font-weight:700;color:var(--amber-t);background:var(--amber-b);padding:3px 9px;border-radius:999px;white-space:nowrap}
        .nprod .ch-meta{font-size:13px;color:var(--ink2);margin-top:6px}
        .nprod .ch-meta2{font-size:12.5px;color:var(--muted);margin-top:4px;line-height:1.5}
        .nprod .codes{margin-top:16px;padding-top:14px;border-top:1px solid var(--line2);display:flex;flex-direction:column;gap:7px}
        .nprod .crow{display:flex;align-items:baseline;justify-content:space-between;font-size:12.5px;color:var(--muted)}
        .nprod .crow b{font-variant-numeric:tabular-nums;font-weight:600;color:var(--faint)}
        .nprod .crow.set b{color:var(--ink)}
        .nprod .where{margin-top:14px;padding-top:12px;border-top:1px solid var(--line2)}
        .nprod .save{margin-top:16px;width:100%;border:none;background:var(--espresso);color:#f7efdd;border-radius:10px;padding:12px 16px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
        .nprod .save:disabled{opacity:.45;cursor:default}
        .nprod .msg{margin-top:12px;font-size:12.5px;font-weight:600;border-radius:9px;padding:10px 12px;line-height:1.5}
        .nprod .msg.ok{background:var(--green-b);color:var(--green-t);border:1px solid var(--green)}
        .nprod .msg.err{background:var(--red-b,#f7e4e0);color:var(--red-t,#a4372a);border:1px solid var(--red,#c0563f)}
        .nprod .msg a{color:inherit;text-decoration:underline}

        @media (max-width:1000px){
          .nprod .grid2{grid-template-columns:1fr}
          .nprod .rail{position:static}
        }
        @media (max-width:620px){
          .nprod .fgrid{grid-template-columns:1fr}
          .nprod .f-2{grid-column:span 1}
          .nprod .sec{padding:15px 14px}
          .nprod .picker{max-height:300px}
        }
      `}</style>
    </div>
  );
}
