"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RunCard, RunMember, RunVisitor } from "@/lib/queries";
import { saveRunDays } from "@/app/map/actions";

/* ------------------------------------------------------------------ *
 * The Delivery Runs board — item 5 of Simona's 26 Aug brief.
 *
 * [32:01] "Click a run card, see every store on that run and the order they go
 * out in, see what days that run goes out, add a day, change a day. On save it
 * must talk to production, talk to packing slips, and readjust the forecast."
 *
 * [29:23] the layout, in her words: click the run, the store list plus the run
 * days appear on the right, click another day to add it. So this is a
 * master-detail on ONE page, not a card that navigates away.
 *
 * [33:43] the bare minimum she'd accept: click a run, see its stores, tweak the
 * days. Everything past that is a bonus, so that part is built first and built
 * properly.
 *
 * [23:01] and the hard limit, which is why there is not a single unit or dollar
 * on this screen: "you could actually adjust the number here... but then if we
 * do it here it's all those numbers affect the production numbers. I don't want
 * to play with numbers too much. I think playing with numbers is really
 * dangerous." Days and membership only.
 *
 * [31:42] is why this REPLACES the status map as the purpose of the page:
 * "this whole concept of tracking which region has errors isn't functional,
 * because all it's telling us is data about it and then we've got to open up
 * the store to get to it." The old map told her something was wrong and gave
 * her nowhere to go. This screen is where she changes it.
 *
 * [06:10] is why it has to be good rather than adequate: she has ~30 new stores
 * landing, is creating a new run called City 2, moving stores off the over-full
 * South East run and pulling East Village off Hills. Queensland churns after
 * that. This screen gets used constantly; it is not set-and-forget.
 *
 * ONE THING SHE ASKED FOR THAT IS NOT HERE, said plainly rather than faked:
 * "the order they go out in". No stop sequence exists anywhere — not in the
 * runs table, not in stores, not in the legacy Stores_Master. Sorting the list
 * alphabetically and letting it look like a driving order would be worse than
 * useless on a screen she uses to rebalance vans. Stores are listed A-Z and
 * labelled as such.
 * ------------------------------------------------------------------ */

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const SHORT: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};
const LONG: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};
const RETAILER: Record<string, string> = {
  woolworths: "Woolworths", coles: "Coles", harris_farm: "Harris Farm", invoice: "Invoice",
};
const order = (ds: string[]) => DAYS.filter((d) => ds.includes(d));
const list = (ds: string[]) => order(ds).map((d) => SHORT[d]).join(", ");
// Same list, with the evening days marked. Used wherever a run's days are
// printed, so the run cards and the detail heading can never say different
// things about the same run.
function DayList({ days, pm }: { days: string[]; pm: string[] }) {
  const ds = order(days);
  if (ds.length === 0) return null;
  return (
    <>
      {ds.map((d, i) => (
        <span key={d} className={pm.includes(d) ? "evd" : undefined}>
          {i ? ", " : ""}{SHORT[d]}{pm.includes(d) ? " pm" : ""}
        </span>
      ))}
    </>
  );
}

export default function RunBoard({
  runs,
  members,
  visitors,
}: {
  runs: RunCard[];
  members: RunMember[];
  visitors: RunVisitor[];
}) {
  const router = useRouter();
  const [selId, setSelId] = useState<string>(runs[0]?.id ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  const byRun = useMemo(() => {
    const m = new Map<string, RunMember[]>();
    for (const s of members) {
      const arr = m.get(s.run_id) ?? [];
      arr.push(s);
      m.set(s.run_id, arr);
    }
    return m;
  }, [members]);

  const visByRun = useMemo(() => {
    const m = new Map<string, RunVisitor[]>();
    for (const v of visitors) {
      const arr = m.get(v.run_id) ?? [];
      arr.push(v);
      m.set(v.run_id, arr);
    }
    return m;
  }, [visitors]);

  const sel = runs.find((r) => r.id === selId) ?? null;
  const mem = sel ? byRun.get(sel.id) ?? [] : [];
  const vis = sel ? visByRun.get(sel.id) ?? [] : [];
  const days = editing ? draft : sel?.days ?? [];

  // What the save will actually do to stores, worked out here so it can be said
  // out loud BEFORE she presses Save rather than reported after.
  const added = sel ? order(draft).filter((d) => !sel.days.includes(d)) : [];
  const removed = sel ? order(sel.days).filter((d) => !draft.includes(d)) : [];
  const willAdd = added.length
    ? mem.filter((s) => added.some((d) => !s.days.includes(d))).length
    : 0;
  const willRemove = removed.length
    ? mem.filter((s) => removed.some((d) => s.days.includes(d))).length
    : 0;
  // How many stores on this run do not take every day it goes out. Her Edgecliff
  // and Metro Paddington point, as one number in the heading rather than a chip
  // on almost every row.
  const partial = sel ? mem.filter((s) => order(sel.days).some((d) => !s.days.includes(d))).length : 0;
  // Removing a day that a visiting store rides leaves that store's exception
  // pointing at a day this run no longer goes out. Her data, so it is flagged
  // rather than quietly deleted.
  const strandedVisitors = removed.length
    ? vis.filter((v) => removed.some((d) => v.days.includes(d)))
    : [];

  function open() {
    if (!sel) return;
    setDraft(order(sel.days));
    setErr(null);
    setNote(null);
    setEditing(true);
  }

  function toggle(d: string) {
    setDraft((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  function save() {
    if (!sel) return;
    setErr(null);
    startSave(async () => {
      const res = await saveRunDays(sel.id, order(draft));
      if (!res.ok) { setErr(res.error); return; }
      setEditing(false);
      setNote(
        res.storesChanged === 0
          ? "Saved. No store's delivery days needed changing."
          : `Saved. ${res.added.length ? `Added ${res.added.map((d) => LONG[d]).join(", ")}. ` : ""}` +
            `${res.removed.length ? `Removed ${res.removed.map((d) => LONG[d]).join(", ")}. ` : ""}` +
            `${res.storesChanged} ${res.storesChanged === 1 ? "store" : "stores"} updated — production, packing and the forecast now follow it.`,
      );
      router.refresh();
    });
  }

  if (!runs.length) {
    return (
      <div className="rb">
        <div className="rb-none">
          No delivery runs with days set yet. A run needs at least one day before
          stores can go out on it.
        </div>
        <style>{`.rb .rb-none{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px;font-size:13.5px;color:var(--muted)}`}</style>
      </div>
    );
  }

  return (
    <div className="rb">
      <div className="rb-grid">
        {/* LEFT — every run */}
        <div className="rb-list">
          {runs.map((r) => (
            <button
              type="button"
              key={r.id}
              className={`rb-card${r.id === selId ? " on" : ""}`}
              onClick={() => { setSelId(r.id); setEditing(false); setNote(null); setErr(null); }}
            >
              <span className="rb-n">{r.name}</span>
              <span className="rb-d"><DayList days={r.days} pm={r.pm} /></span>
              <span className="rb-m">
                {r.stores} {r.stores === 1 ? "store" : "stores"}
                {r.visitors > 0 && <> · {r.visitors} visiting</>}
              </span>
            </button>
          ))}
        </div>

        {/* RIGHT — the selected run */}
        {sel && (
          <div className="panel rb-det">
            <div className="rb-h">
              <div>
                <div className="rb-t">{sel.name}</div>
                <div className="rb-s">
                  {editing
                    ? "Pick the days this run goes out"
                    : sel.days.length === 0
                      ? "Goes out — no days set"
                      : <>Goes out <DayList days={sel.days} pm={sel.pm} /></>}
                </div>
              </div>
              {!editing ? (
                <button type="button" className="rb-edit" onClick={open}>Edit days</button>
              ) : (
                <span className="rb-acts">
                  <button type="button" className="rb-cancel" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                  <button type="button" className="rb-save" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
                </span>
              )}
            </div>

            <div className="rb-days">
              {DAYS.map((d) => {
                const on = days.includes(d);
                // Evening styling only on a day the run actually goes out. An
                // off day is off; it is never "off, in the evening".
                const evening = on && sel.pm.includes(d);
                if (!editing) return <span key={d} className={`rb-day${on ? " on" : ""}${evening ? " pm" : ""}`}>{SHORT[d]}{evening ? " pm" : ""}</span>;
                return (
                  <button
                    type="button"
                    key={d}
                    className={`rb-day tap${on ? " on" : ""}${evening ? " pm" : ""}`}
                    onClick={() => toggle(d)}
                    disabled={saving}
                    aria-pressed={on}
                  >
                    {SHORT[d]}
                  </button>
                );
              })}
            </div>

            {/* What the evening mark means, and what it does NOT claim.
                Only shown on a run that has one — a note on a run with no
                evening days would read as a denial that it has any, and three
                of the five runs are UNKNOWN rather than daytime. */}
            {!editing && sel.pm.length > 0 && (
              <div className="rb-pmnote">
                <b>pm</b> marks an <b>evening</b> run — the van goes out that night.
                Whether it lands the same night or the next morning is still open
                with Sahil, so nothing here assumes either.
              </div>
            )}

            {/* Say what Save will do before she presses it. */}
            {editing && (added.length > 0 || removed.length > 0) && (
              <div className="rb-will">
                {added.length > 0 && (
                  <div>
                    Adding <b>{added.map((d) => LONG[d]).join(", ")}</b> — this gives{" "}
                    <b>{willAdd}</b> {willAdd === 1 ? "store" : "stores"} on this run an extra delivery day.
                  </div>
                )}
                {removed.length > 0 && (
                  <div>
                    Removing <b>{removed.map((d) => LONG[d]).join(", ")}</b> — this takes a delivery day off{" "}
                    <b>{willRemove}</b> {willRemove === 1 ? "store" : "stores"}.
                  </div>
                )}
                <div className="rb-will-f">
                  Production, packing slips and the forecast all follow delivery days, so they change with it.
                </div>
              </div>
            )}

            {editing && strandedVisitors.length > 0 && (
              <div className="rb-warn">
                <b>{strandedVisitors.length} {strandedVisitors.length === 1 ? "store rides" : "stores ride"} this run on a day you&apos;re removing.</b>{" "}
                Their exception isn&apos;t deleted — it will point at a day this run no longer goes out, so fix it on the store page:{" "}
                {strandedVisitors.map((v) => v.name).join(", ")}.
              </div>
            )}

            {err && <div className="rb-err">{err}</div>}
            {note && !editing && <div className="rb-ok">{note}</div>}

            {/* STORES ON THIS RUN */}
            <div className="rb-sec">
              <span>On this run</span>
              <em>
                {mem.length} {mem.length === 1 ? "store" : "stores"}
                {partial > 0 && <> · {partial} {partial === 1 ? "does" : "do"} not take every day the run goes out</>}
                {" · listed A\u2013Z, not in driving order \u2014 the stop sequence isn\u2019t recorded anywhere yet"}
              </em>
            </div>
            {mem.length === 0 ? (
              <div className="rb-empty">No stores on this run yet.</div>
            ) : (
              <ul className="rb-stores">
                {mem.map((s) => {
                  // The run's headline days are not true for every store on it —
                  // Edgecliff and Metro Paddington were her example. Each store
                  // therefore shows its OWN days, in the column on the right.
                  //
                  // What is NOT shown per row is "not on Tue, Wed, Thu, Fri,
                  // Sat, Sun". Opening Eastern Suburbs on the live site made
                  // that obvious: the run goes out seven days, most of its 32
                  // stores take three or four, so nearly every row carried a
                  // long grey chip that was the exact arithmetic complement of
                  // the days printed beside it. It read as noise and buried the
                  // two flags that DO matter. The count moves to the heading.
                  //
                  // `extra` stays, and it is the opposite of noise: a store
                  // taking a delivery on a day its own run does not go out.
                  const extra = order(s.days).filter((d) => !sel.days.includes(d));
                  return (
                    <li key={s.store_id}>
                      <Link prefetch={false} href={`/store/${s.store_id}`} className="rb-store">
                        <span className="rb-sn">{s.name}<i>{RETAILER[s.retailer] ?? s.retailer}</i></span>
                        <span className="rb-sd">
                          {s.days.length === 0 ? <em className="none">no delivery days set</em> : list(s.days)}
                        </span>
                      </Link>
                      {(extra.length > 0 || s.away.length > 0) && (
                        <div className="rb-flags">
                          {extra.length > 0 && <span className="f extra">delivered {extra.map((d) => SHORT[d]).join(", ")} — this run doesn&apos;t go out then</span>}
                          {s.away.map((a) => (
                            <span className="f away" key={a.day}>{SHORT[a.day]} rides {a.run}</span>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {/* STORES THAT VISIT */}
            {vis.length > 0 && (
              <>
                <div className="rb-sec">
                  <span>Also rides this run</span>
                  <em>{vis.length} {vis.length === 1 ? "store" : "stores"} that live on another run</em>
                </div>
                <ul className="rb-stores">
                  {vis.map((v) => (
                    <li key={v.store_id}>
                      <Link prefetch={false} href={`/store/${v.store_id}`} className="rb-store">
                        <span className="rb-sn">{v.name}<i>home run {v.home_run}</i></span>
                        <span className="rb-sd">{list(v.days)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      <style>{`
        .rb{display:block;margin-bottom:24px}
        .rb .rb-grid{display:grid;grid-template-columns:250px 1fr;gap:14px;align-items:start}

        .rb .rb-list{display:flex;flex-direction:column;gap:6px}
        .rb .rb-card{text-align:left;font:inherit;background:var(--card);border:1px solid var(--line);border-left:3px solid transparent;border-radius:10px;padding:10px 13px;cursor:pointer;display:flex;flex-direction:column;gap:2px;transition:border-color .12s,background .12s}
        .rb .rb-card:hover{border-color:var(--ink2)}
        .rb .rb-card.on{border-color:var(--crust,#c98a34);border-left-color:var(--crust,#c98a34);background:var(--crust-b,rgba(201,138,52,.07))}
        .rb .rb-card .rb-n{font-weight:700;font-size:13.5px}
        .rb .rb-card .rb-d{font-size:11.5px;color:var(--ink2);font-variant-numeric:tabular-nums}
        .rb .rb-card .rb-m{font-size:11px;color:var(--muted)}

        .rb .rb-det{padding:18px 20px}
        .rb .rb-h{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
        .rb .rb-t{font-family:var(--serif);font-size:22px;font-weight:600;letter-spacing:-.3px}
        .rb .rb-s{font-size:12.5px;color:var(--muted);margin-top:3px}
        .rb .rb-edit,.rb .rb-cancel,.rb .rb-save{font:inherit;font-size:12px;font-weight:600;border-radius:7px;padding:5px 12px;cursor:pointer;border:1px solid var(--line)}
        .rb .rb-edit,.rb .rb-cancel{background:transparent;color:var(--ink2)}
        .rb .rb-edit:hover,.rb .rb-cancel:hover{border-color:var(--ink2)}
        .rb .rb-save{background:var(--crust,#c98a34);border-color:var(--crust,#c98a34);color:#fff}
        .rb .rb-save:disabled,.rb .rb-cancel:disabled{opacity:.55;cursor:default}
        .rb .rb-acts{display:flex;gap:7px;flex:none}

        .rb .rb-days{display:flex;gap:6px;margin:14px 0 4px;flex-wrap:wrap}
        .rb .rb-day{font-size:12px;font-weight:700;padding:7px 13px;border-radius:8px;background:var(--bg2,rgba(0,0,0,.04));color:var(--muted);border:1px solid transparent}
        .rb .rb-day.on{background:var(--green-b);color:var(--green-t);border-color:#cadfc3}
        /* Same evening palette as the Deliveries board and the packing sheet,
           so one mark means one thing across every surface. */
        .rb .rb-day.on.pm{background:#3f3a56;color:#e8e3f2;border-color:#3f3a56}
        .rb .evd{color:#3f3a56;font-weight:700}
        .rb .rb-pmnote{margin:2px 0 10px;font-size:12px;color:var(--muted);line-height:1.55}
        .rb .rb-day.tap{cursor:pointer;font-family:inherit}
        .rb .rb-day.tap:hover{border-color:var(--ink2)}
        .rb .rb-day.tap:disabled{opacity:.55;cursor:default}

        .rb .rb-will{margin-top:12px;background:var(--bg2,rgba(0,0,0,.025));border:1px solid var(--line2);border-radius:9px;padding:10px 13px;font-size:12.5px;line-height:1.65;display:flex;flex-direction:column;gap:3px}
        .rb .rb-will-f{color:var(--muted);font-size:11.5px;margin-top:3px}
        .rb .rb-warn{margin-top:10px;background:var(--amber-b);border:1px solid #e8d5a6;border-left:3px solid var(--amber);color:var(--amber-t);border-radius:9px;padding:10px 13px;font-size:12.5px;line-height:1.6}
        .rb .rb-err{margin-top:10px;background:var(--red-b);border:1px solid #eab9a8;border-radius:9px;padding:9px 13px;font-size:12.5px;color:var(--red-t)}
        .rb .rb-ok{margin-top:10px;background:var(--green-b);border:1px solid #cadfc3;border-radius:9px;padding:9px 13px;font-size:12.5px;color:var(--green-t)}

        .rb .rb-sec{display:flex;align-items:baseline;gap:10px;margin:22px 0 10px;padding-top:14px;border-top:1px solid var(--line2)}
        .rb .rb-sec span{font-size:13px;font-weight:700;letter-spacing:.02em}
        .rb .rb-sec em{font-style:normal;font-size:11.5px;color:var(--muted)}
        .rb .rb-empty{font-size:12.5px;color:var(--muted)}

        .rb .rb-stores{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
        .rb .rb-stores li{padding:2px 0}
        .rb .rb-store{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:7px 10px;border-radius:8px;text-decoration:none;color:inherit}
        .rb .rb-store:hover{background:var(--bg2,rgba(0,0,0,.03))}
        .rb .rb-sn{font-size:13px;font-weight:600}
        .rb .rb-sn i{font-style:normal;font-weight:400;font-size:11px;color:var(--muted);margin-left:8px}
        .rb .rb-sd{font-size:12px;color:var(--ink2);font-variant-numeric:tabular-nums;white-space:nowrap}
        .rb .rb-sd .none{font-style:normal;color:var(--red-t)}
        .rb .rb-flags{display:flex;gap:6px;flex-wrap:wrap;padding:0 10px 6px}
        .rb .rb-flags .f{font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:5px}
        .rb .rb-flags .miss{background:var(--bg2,rgba(0,0,0,.05));color:var(--muted)}
        .rb .rb-flags .extra{background:var(--red-b);color:var(--red-t)}
        .rb .rb-flags .away{background:var(--amber-b);color:var(--amber-t)}

        @media (max-width:900px){ .rb .rb-grid{grid-template-columns:1fr} }
      `}</style>
    </div>
  );
}
