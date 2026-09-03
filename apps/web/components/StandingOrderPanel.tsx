"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setStoreOverride, clearStoreOverride, setStorePrice, setStoreDay, clearStoreDays } from "@/app/store/actions";
import type { StandingLine, ProductPick } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * The standing order for an invoice customer.
 *
 * WHY THIS EXISTS. An invoice store has no sales feed, so there is no
 * forecast for it. What the system shows is last week's deliveries
 * carried forward by the "no plan, leave it alone" rail in
 * jb_rebuild_store_reco. That works, but it is a reflection of what
 * happened, not a definition of what should happen -- and until now
 * there was nowhere to change it. The number would echo last week
 * indefinitely.
 *
 * Everything here writes store_product_overrides, the same table and
 * the same server action the store profile's Adjust control uses. No
 * new mechanism: a standing order IS a permanent override, which is
 * what migration 011's own comment says ("mode perm = standing").
 *
 * The one-off order is the same row with mode 'temp' and a date. That
 * is the Lennox Street case from the 1 Sept call -- a customer who
 * "orders when they need", currently handled by Simona emailing an
 * invoice by hand and texting the production chat.
 * ------------------------------------------------------------------ */

type Props = {
  storeId: string;
  storeName: string;
  lines: StandingLine[];
  products: ProductPick[];
  today: string; // YYYY-MM-DD, Sydney
  /** The store's own delivery days, so the grid never offers a day with no van. */
  deliveryDays?: string[];
};

const CAT_LABEL: Record<string, string> = {
  sourdough: "Sourdough", bagel: "Bagels", challah: "Challah",
  pita: "Pita", pastry: "Pastry", cake: "Cake", other: "Other",
};

const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DOW_LABEL: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

export default function StandingOrderPanel({ storeId, storeName, lines, products, today, deliveryDays = [] }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Local edits, so a stepper feels instant and one save does not re-render
  // the whole list. Keyed by product id; absent means "unchanged".
  const [draft, setDraft] = useState<Record<string, number>>({});

  // Price is edited as text, not a number: a half-typed "5." is a valid thing
  // to be in the middle of typing and must not be coerced to 5 under the cursor.
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});
  // Which line has its day grid open. One at a time: this is a thing you do
  // because a customer just rang about one product, not a thing you scan.
  const [openDays, setOpenDays] = useState<string | null>(null);
  const [dayDraft, setDayDraft] = useState<Record<string, string>>({});

  const [adding, setAdding] = useState(false);
  const [addPid, setAddPid] = useState("");
  const [addQty, setAddQty] = useState("");
  const [addMode, setAddMode] = useState<"perm" | "temp">("perm");
  const [addFrom, setAddFrom] = useState(today);
  const [addTo, setAddTo] = useState(today);

  const onList = useMemo(() => new Set(lines.map((l) => l.product_id)), [lines]);
  const addable = useMemo(
    () => products.filter((p) => !onList.has(p.id)),
    [products, onList],
  );

  // What the store actually gets for a line: the override if there is one,
  // otherwise the carried-forward figure.
  const effective = (l: StandingLine) =>
    draft[l.product_id] ?? (l.override_qty != null ? l.override_qty : l.sent);

  const isSet = (l: StandingLine) => l.override_qty != null;
  const dirty = (l: StandingLine) =>
    draft[l.product_id] != null && draft[l.product_id] !== (l.override_qty ?? l.sent);

  function bump(l: StandingLine, by: number) {
    const next = Math.max(0, effective(l) + by);
    setDraft((d) => ({ ...d, [l.product_id]: next }));
  }

  function save(l: StandingLine) {
    const qty = effective(l);
    setMsg(null);
    setBusy(l.product_id);
    start(async () => {
      const res = await setStoreOverride({
        storeId, productId: l.product_id, qty, mode: "perm",
      });
      setBusy(null);
      if (res.ok) {
        setDraft((d) => { const n = { ...d }; delete n[l.product_id]; return n; });
        setMsg({ ok: true, text: `${titleCase(l.name)} set to ${qty} a week.` });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });
  }

  const priceOf = (l: StandingLine) =>
    priceDraft[l.product_id] ?? (l.unit_price == null ? "" : l.unit_price.toFixed(2));
  const priceDirty = (l: StandingLine) => {
    const d = priceDraft[l.product_id];
    if (d == null) return false;
    const now = l.unit_price == null ? "" : l.unit_price.toFixed(2);
    return d.trim() !== now;
  };

  function savePrice(l: StandingLine) {
    const raw = (priceDraft[l.product_id] ?? "").trim();
    const val = Number(raw);
    if (raw === "" || !Number.isFinite(val) || val < 0) {
      setMsg({ ok: false, text: "That price is not a number." });
      return;
    }
    setBusy(l.product_id);
    start(async () => {
      const r = await setStorePrice({ storeId, productId: l.product_id, price: val });
      setBusy(null);
      if (r.ok) {
        setPriceDraft((d) => { const n = { ...d }; delete n[l.product_id]; return n; });
        setMsg({ ok: true, text: `${titleCase(l.name)} is now $${val.toFixed(2)} for ${storeName}.` });
        router.refresh();
      } else {
        setMsg({ ok: false, text: r.error ?? "Could not save that price." });
      }
    });
  }

  // The store's own delivery days. A number against a day with no van is not a
  // delivery, so those boxes are not offered at all.
  const runsOn = (d: string) => deliveryDays.length === 0 || deliveryDays.includes(d);
  const dayKey = (pid: string, d: string) => pid + ":" + d;
  const dayValue = (l: StandingLine, d: string) => {
    const k = dayKey(l.product_id, d);
    if (dayDraft[k] != null) return dayDraft[k];
    const v = l.days?.[d];
    return v == null ? "" : String(v);
  };

  function saveDay(l: StandingLine, d: string) {
    const raw = (dayDraft[dayKey(l.product_id, d)] ?? "").trim();
    const qty = Number(raw);
    if (raw === "" || !Number.isFinite(qty) || qty < 0) return;
    setBusy(l.product_id);
    start(async () => {
      const r = await setStoreDay({ storeId, productId: l.product_id, dow: d, qty });
      setBusy(null);
      if (r.ok) {
        setDayDraft((x) => { const n = { ...x }; delete n[dayKey(l.product_id, d)]; return n; });
        setMsg({
          ok: true,
          text: qty === 0
            ? `${titleCase(l.name)} is off on ${DOW_LABEL[d]} for ${storeName}.`
            : `${titleCase(l.name)} set to ${qty} on ${DOW_LABEL[d]} for ${storeName}.`,
        });
        router.refresh();
      } else {
        setMsg({ ok: false, text: r.error ?? "Could not save that day." });
      }
    });
  }

  function backToWeekly(l: StandingLine) {
    setBusy(l.product_id);
    start(async () => {
      const r = await clearStoreDays(storeId, l.product_id);
      setBusy(null);
      if (r.ok) {
        setMsg({ ok: true, text: `${titleCase(l.name)} is back on the weekly number.` });
        router.refresh();
      } else {
        setMsg({ ok: false, text: r.error ?? "Could not clear those days." });
      }
    });
  }

  function remove(l: StandingLine) {
    setMsg(null);
    setBusy(l.product_id);
    start(async () => {
      const res = await clearStoreOverride(storeId, l.product_id);
      setBusy(null);
      if (res.ok) {
        setDraft((d) => { const n = { ...d }; delete n[l.product_id]; return n; });
        setMsg({
          ok: true,
          text: l.sent > 0
            ? `${titleCase(l.name)} is back to its carried-forward ${l.sent} a week.`
            : `${titleCase(l.name)} removed from the order.`,
        });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });
  }

  function addLine() {
    const qty = Number(addQty);
    if (!addPid || !Number.isFinite(qty) || qty <= 0) return;
    setMsg(null);
    start(async () => {
      const res = await setStoreOverride({
        storeId, productId: addPid, qty, mode: addMode,
        from: addMode === "temp" ? addFrom : undefined,
        to: addMode === "temp" ? addTo : undefined,
      });
      if (res.ok) {
        const nm = products.find((p) => p.id === addPid)?.name ?? "That line";
        setMsg({
          ok: true,
          text: addMode === "perm"
            ? `${titleCase(nm)} added at ${qty} — it will appear on every delivery day.`
            : `${titleCase(nm)} added as a one-off, ${qty} between ${addFrom} and ${addTo}.`,
        });
        setAdding(false); setAddPid(""); setAddQty("");
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });
  }

  const grouped = useMemo(() => {
    const g = new Map<string, StandingLine[]>();
    for (const l of lines) {
      const k = l.category;
      const a = g.get(k);
      if (a) a.push(l); else g.set(k, [l]);
    }
    return [...g.entries()];
  }, [lines]);

  const total = lines.reduce((a, l) => a + effective(l), 0);
  const setCount = lines.filter(isSet).length;
  // Deliberately only the priced lines. An unpriced line is unknown, not free,
  // and folding it in as zero would dress this up as a complete weekly figure.
  const weekValue = lines.reduce(
    (a, l) => a + (l.unit_price == null ? 0 : l.unit_price * effective(l)), 0);
  const unpriced = lines.filter((l) => l.unit_price == null && effective(l) > 0).length;

  return (
    <div className="sord">
      <div className="hd">
        <div>
          <h2>Standing order</h2>
          <p className="sub">
            {storeName} has no sales feed, so nothing forecasts it. Until a line is set here, the
            system simply repeats last week&apos;s delivery — which is why these numbers have never
            changed on their own.
          </p>
        </div>
        <div className="tot">
          <b>{total.toLocaleString()}</b>
          <small>units a week{setCount > 0 ? ` · ${setCount} set` : ""}</small>
          {/* Only counts lines that HAVE a price. A line with no price is not
              worth zero, it is unknown, and quietly adding it in as zero would
              make this number look like a real total when it is not. */}
          {weekValue > 0 && (
            <small className="val">
              ${weekValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} a week
              {unpriced > 0 ? ` · ${unpriced} line${unpriced === 1 ? "" : "s"} unpriced` : ""}
            </small>
          )}
        </div>
      </div>

      {grouped.map(([cat, ls]) => (
        <div className="grp" key={cat}>
          <div className="gh">{CAT_LABEL[cat] ?? titleCase(cat)}</div>
          {ls.map((l) => {
            const eff = effective(l);
            const d = dirty(l);
            const working = busy === l.product_id && pending;
            return (
              <div className={`line ${isSet(l) ? "set" : ""} ${d ? "dirty" : ""}`} key={l.product_id}>
                <div className="nm">
                  {titleCase(l.name)}
                  <small>
                    {isSet(l)
                      ? l.mode === "temp"
                        ? `one-off${l.ends_on ? ` until ${l.ends_on}` : ""}`
                        : "set here"
                      : l.sent > 0
                        ? `carried forward from last week`
                        : "not currently sent"}
                    {l.pack_size > 1 ? ` · sold in ${l.pack_size}s` : ""}
                  </small>
                </div>
                <div className="step">
                  <button type="button" onClick={() => bump(l, -1)} disabled={working} aria-label="one fewer">−</button>
                  <span className="q">{eff}</span>
                  <button type="button" onClick={() => bump(l, +1)} disabled={working} aria-label="one more">+</button>
                </div>
                <div className="prc">
                  <span className="dollar">$</span>
                  <input
                    inputMode="decimal"
                    value={priceOf(l)}
                    placeholder="—"
                    aria-label={`price of ${titleCase(l.name)} for ${storeName}`}
                    onChange={(e) => setPriceDraft((dd) => ({ ...dd, [l.product_id]: e.target.value }))}
                    disabled={working}
                  />
                  {priceDirty(l) ? (
                    <button type="button" className="go" onClick={() => savePrice(l)} disabled={working}>
                      {working ? "…" : "Set"}
                    </button>
                  ) : l.unit_price != null ? (
                    <small className="lineval">${(l.unit_price * eff).toFixed(2)}</small>
                  ) : (
                    <small className="noprice">no price</small>
                  )}
                  {l.unit_price != null && !l.xero_code && (
                    <small className="nocode" title="This line has a price but no Xero item code, so it cannot be invoiced yet.">no Xero code</small>
                  )}
                </div>
                <div className="dayswitch">
                  <button
                    type="button"
                    className={l.days ? "onday" : ""}
                    onClick={() => setOpenDays(openDays === l.product_id ? null : l.product_id)}
                    title={l.days ? "This line is set day by day" : "Set this line day by day"}
                  >
                    {l.days ? "By day" : "Days"}
                  </button>
                </div>
                <div className="acts">
                  {d && (
                    <button type="button" className="go" onClick={() => save(l)} disabled={working}>
                      {working ? "…" : "Save"}
                    </button>
                  )}
                  {isSet(l) && !d && (
                    <button type="button" className="clr" onClick={() => remove(l)} disabled={working} title="Remove this line from the standing order">
                      Clear
                    </button>
                  )}
                </div>
                {openDays === l.product_id && (
                  <div className="daygrid">
                    <div className="dgh">
                      {l.days
                        ? "Set day by day. A zero means no delivery that day. While this is on, it replaces the weekly number entirely."
                        : `Set any day and this line moves off its weekly number onto the grid. Only ${storeName}'s delivery days are shown.`}
                    </div>
                    <div className="dgrow">
                      {DOW.filter(runsOn).map((d) => (
                        <label key={d} className="dgcell">
                          <span>{DOW_LABEL[d]}</span>
                          <input
                            inputMode="numeric"
                            value={dayValue(l, d)}
                            placeholder="—"
                            aria-label={`${titleCase(l.name)} on ${DOW_LABEL[d]}`}
                            disabled={working}
                            onChange={(e) =>
                              setDayDraft((x) => ({ ...x, [dayKey(l.product_id, d)]: e.target.value }))
                            }
                            onBlur={() => {
                              if (dayDraft[dayKey(l.product_id, d)] != null) saveDay(l, d);
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    {l.days && (
                      <button type="button" className="dgclr" onClick={() => backToWeekly(l)} disabled={working}>
                        Back to the weekly number
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {lines.length === 0 && (
        <div className="empty">Nothing on this customer&apos;s order yet. Add the first line below.</div>
      )}

      <div className="addwrap">
        {!adding ? (
          <button className="addopen" onClick={() => { setAdding(true); setMsg(null); }}>
            + Add a line
          </button>
        ) : (
          <div className="addform">
            <div className="ah">Add a line to {storeName}</div>
            <div className="arow">
              <select value={addPid} onChange={(e) => setAddPid(e.target.value)} aria-label="Product">
                <option value="">Choose a product…</option>
                {addable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {titleCase(p.name)}{p.pack_size > 1 ? ` (in ${p.pack_size}s)` : ""}
                  </option>
                ))}
              </select>
              <input
                className="aq" inputMode="numeric" value={addQty}
                onChange={(e) => setAddQty(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="Qty"
                aria-label="Quantity"
              />
            </div>
            <div className="seg">
              <button type="button" className={addMode === "perm" ? "on" : ""} onClick={() => setAddMode("perm")}>
                Every week
              </button>
              <button type="button" className={addMode === "temp" ? "on" : ""} onClick={() => setAddMode("temp")}>
                One-off order
              </button>
            </div>
            {addMode === "temp" ? (
              <>
                <div className="arow dates">
                  <label>From <input type="date" value={addFrom} onChange={(e) => setAddFrom(e.target.value)} /></label>
                  <label>To <input type="date" value={addTo} onChange={(e) => setAddTo(e.target.value)} /></label>
                </div>
                <div className="note">
                  This is the case Simona described on 1 September — a customer who orders when they
                  need rather than on a set order. It reaches the packing sheet on those days only,
                  then stops on its own. No one has to remember to take it off.
                </div>
              </>
            ) : (
              <div className="note">
                Appears on every one of this customer&apos;s delivery days until someone changes it.
              </div>
            )}
            <div className="aacts">
              <button className="acancel" onClick={() => { setAdding(false); setMsg(null); }} disabled={pending}>Cancel</button>
              <button className="aadd" onClick={addLine} disabled={pending || !addPid || !Number(addQty)}>
                {pending ? "Adding…" : "Add line"}
              </button>
            </div>
          </div>
        )}
      </div>

      {msg && <div className={`msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>}

      <style>{`
        .sord{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:18px 20px;margin-top:16px}
        .sord .hd{display:flex;align-items:flex-start;gap:18px;flex-wrap:wrap;margin-bottom:16px}
        .sord h2{font-family:var(--serif);font-size:18px;font-weight:600;margin:0 0 5px}
        .sord .sub{font-size:12.5px;color:var(--ink2);line-height:1.55;margin:0;max-width:62ch}
        .sord .tot{margin-left:auto;text-align:right;flex:none}
        .sord .tot b{font-family:var(--serif);font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;display:block;line-height:1}
        .sord .tot small{font-size:11px;color:var(--muted);display:block;margin-top:4px}
        .sord .grp{margin-bottom:14px}
        .sord .gh{font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);font-weight:700;padding:6px 0;border-bottom:1px solid var(--line2);margin-bottom:4px}
        .sord .line{display:flex;align-items:center;gap:12px;padding:8px 4px;border-radius:8px}
        .sord .line.set{background:#f7f4ec}
        .sord .line.dirty{background:var(--amber-b)}
        .sord .nm{flex:1;min-width:0;font-size:13.5px;font-weight:600;display:flex;flex-direction:column;line-height:1.3;overflow-wrap:anywhere}
        .sord .nm small{font-size:11px;color:var(--muted);font-weight:500;margin-top:2px}
        .sord .step{display:flex;align-items:center;gap:1px;border:1px solid var(--line);border-radius:9px;overflow:hidden;flex:none;background:var(--card)}
        .sord .step button{width:30px;height:32px;border:none;background:var(--card);cursor:pointer;font-size:16px;color:var(--ink2);font-family:inherit}
        .sord .step button:hover{background:#f3ecdd}
        .sord .step button:disabled{opacity:.4;cursor:default}
        .sord .q{min-width:40px;text-align:center;font-size:14px;font-weight:700;font-variant-numeric:tabular-nums}
        .sord .acts{flex:none;min-width:62px;display:flex;justify-content:flex-end}
        .sord .prc{flex:none;display:flex;align-items:center;gap:5px;min-width:150px}
        .sord .prc .dollar{opacity:.5;font-size:12.5px}
        .sord .prc input{width:60px;padding:5px 6px;border:1px solid var(--line);border-radius:8px;
          background:var(--card);color:inherit;font:inherit;font-size:13px;text-align:right}
        .sord .prc input:focus{outline:2px solid var(--accent,#8a6d3b);outline-offset:1px}
        .sord .lineval{font-size:12px;opacity:.65;font-variant-numeric:tabular-nums}
        .sord .noprice{font-size:11.5px;opacity:.55;font-style:italic}
        .sord .nocode{font-size:11px;padding:1px 6px;border-radius:999px;
          background:rgba(180,83,9,.14);color:#9a3412;white-space:nowrap}
        .sord .tot .val{display:block;font-variant-numeric:tabular-nums}
        .sord .dayswitch{flex:none}
        .sord .dayswitch button{font-size:11.5px;padding:4px 9px;border-radius:999px;
          border:1px solid var(--line);background:var(--card);color:inherit;cursor:pointer}
        .sord .dayswitch button.onday{border-color:#8a6d3b;color:#6b5327;font-weight:600}
        .sord .daygrid{flex-basis:100%;margin:6px 0 10px;padding:10px 12px;border:1px solid var(--line);
          border-radius:10px;background:var(--surface)}
        .sord .dgh{font-size:12px;opacity:.7;margin-bottom:8px;line-height:1.45}
        .sord .dgrow{display:flex;gap:8px;flex-wrap:wrap}
        .sord .dgcell{display:flex;flex-direction:column;gap:3px;font-size:11px;opacity:.85}
        .sord .dgcell input{width:52px;padding:5px 6px;border:1px solid var(--line);border-radius:8px;
          background:var(--card);color:inherit;font:inherit;font-size:13px;text-align:center}
        .sord .dgclr{margin-top:9px;font-size:11.5px;background:none;border:0;padding:0;
          color:inherit;opacity:.6;text-decoration:underline;cursor:pointer}
        .sord .go{border:none;background:var(--espresso);color:#f7efdd;border-radius:8px;padding:7px 13px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
        .sord .clr{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:8px;padding:6px 11px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit}
        .sord .clr:hover{color:var(--red-t);border-color:var(--red)}
        .sord .empty{font-size:13px;color:var(--muted);padding:14px 4px}
        .sord .addwrap{margin-top:12px;padding-top:14px;border-top:1px solid var(--line2)}
        .sord .addopen{border:1px dashed var(--line);background:var(--surface);color:var(--crust-deep);border-radius:10px;padding:10px 15px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
        .sord .addopen:hover{background:#f6f0e6}
        .sord .addform{background:var(--surface);border:1px solid var(--line2);border-radius:11px;padding:14px 15px}
        .sord .ah{font-family:var(--serif);font-size:14.5px;font-weight:600;margin-bottom:11px}
        .sord .arow{display:flex;gap:9px;flex-wrap:wrap;align-items:center}
        .sord .arow.dates{margin-top:10px;font-size:12px;color:var(--ink2)}
        .sord .arow.dates label{display:flex;align-items:center;gap:7px}
        .sord select,.sord input{border:1px solid var(--line);border-radius:9px;padding:9px 11px;font-size:13.5px;font-family:inherit;background:var(--card);color:var(--ink);outline:none}
        .sord select{flex:1;min-width:190px}
        .sord .aq{width:88px}
        .sord select:focus,.sord input:focus{border-color:var(--crust)}
        .sord .seg{display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;margin-top:10px;width:fit-content}
        .sord .seg button{border:none;background:var(--card);padding:8px 15px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit;border-right:1px solid var(--line)}
        .sord .seg button:last-child{border-right:none}
        .sord .seg button.on{background:var(--espresso);color:#f7efdd}
        .sord .note{font-size:11.5px;color:var(--muted);line-height:1.55;margin-top:10px;max-width:62ch}
        .sord .aacts{display:flex;gap:8px;justify-content:flex-end;margin-top:13px}
        .sord .acancel{border:1px solid var(--line);background:transparent;color:var(--ink2);border-radius:9px;padding:8px 14px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
        .sord .aadd{border:none;background:var(--espresso);color:#f7efdd;border-radius:9px;padding:8px 16px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
        .sord .aadd:disabled{opacity:.45;cursor:default}
        .sord .msg{margin-top:12px;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 12px;line-height:1.5}
        .sord .msg.ok{background:var(--green-b);color:var(--green-t);border:1px solid var(--green)}
        .sord .msg.err{background:var(--red-b,#f7e4e0);color:var(--red-t,#a4372a);border:1px solid var(--red,#c0563f)}
        @media (max-width:620px){
          .sord{padding:15px 14px}
          .sord .tot{margin-left:0;text-align:left}
          .sord .line{flex-wrap:wrap}
          .sord .acts{min-width:0}
          .sord .prc{min-width:0;order:3;width:100%;justify-content:flex-start}
        }
      `}</style>
    </div>
  );
}
