"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { StoreSchedule, RunPick } from "@/lib/queries";
import { saveStoreSchedule, type DayPlan } from "@/app/store/actions";

/* ------------------------------------------------------------------ *
 * The delivery week for one store. Item 2 of Simona's 26 Aug brief, and it is
 * three asks that only work as one panel:
 *
 *   [25:09] "Every store shows all seven days. Days it goes out: green. Days it
 *   does not: greyed out."  Seven rows, always. A store that doesn't deliver on
 *   Tuesday and a store where nobody has set Tuesday yet look the same in a
 *   list that only prints the days that are on — and they are not the same
 *   thing.
 *
 *   [28:33] "All of it visible without clicking. Monday shows 'East Run',
 *   Tuesday shows 'South East Run', on the face of the panel. ONE Edit button
 *   that opens the whole panel, not per-day edit buttons."  So the run name is
 *   printed on every delivering day rather than hidden in a tooltip — the old
 *   panel put the overrides in a `title` attribute, which is invisible on a
 *   touchscreen and invisible to anyone reading rather than hovering.
 *
 *   [27:43] "No anomaly icon at the top of the store page, she said no. But
 *   inside that delivery box she wants something showing 'this store is on
 *   multiple runs' when it isn't all one run."  Hence the flag inside the
 *   panel and nothing added to the page header.
 *
 * Fourteen stores in Simona's Stores Master carry per-day overrides. Coles
 * Maroubra is the worst: Monday Hills, Wednesday Eastern Suburbs, Friday South,
 * Saturday Eastern Suburbs — four days a week where its base run is the wrong
 * answer. That store is what this panel is built to display correctly.
 * ------------------------------------------------------------------ */

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const LABEL: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

type Row = { day: string; on: boolean; runId: string | null };

function buildRows(schedule: StoreSchedule | null): Row[] {
  const on = new Set(schedule?.delivery_days ?? []);
  const ov = new Map((schedule?.overrides ?? []).map((o) => [o.day, o.run_id]));
  return DAYS.map((d) => ({
    day: d,
    on: on.has(d),
    // The run this day actually rides: its override if it has one, otherwise
    // the store's own run.
    runId: ov.get(d) ?? schedule?.run_id ?? null,
  }));
}

export default function StoreDeliveryPanel({
  storeId,
  schedule,
  runs,
}: {
  storeId: string;
  schedule: StoreSchedule | null;
  runs: RunPick[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => buildRows(schedule));
  const [err, setErr] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  const runName = useMemo(() => {
    const m = new Map(runs.map((r) => [r.id, r.name]));
    if (schedule?.run_id && schedule.run_name) m.set(schedule.run_id, schedule.run_name);
    for (const o of schedule?.overrides ?? []) m.set(o.run_id, o.run);
    return m;
  }, [runs, schedule]);

  const live = editing ? rows : buildRows(schedule);
  const delivering = live.filter((r) => r.on);
  const distinctRuns = new Set(delivering.map((r) => r.runId ?? "none"));
  const multiRun = distinctRuns.size > 1;

  function open() {
    setRows(buildRows(schedule));
    setErr(null);
    setEditing(true);
  }

  function save() {
    setErr(null);
    const plan: DayPlan[] = rows.map((r) => ({ day: r.day, on: r.on, runId: r.on ? r.runId : null }));
    // A delivering day with no run named is a van nobody is driving. Say so
    // here rather than saving it and letting it fall off the Delivery Runs board.
    const orphan = plan.find((p) => p.on && !p.runId);
    if (orphan) {
      setErr(`${LABEL[orphan.day]} has no run — pick one, or turn the day off.`);
      return;
    }
    startSave(async () => {
      const res = await saveStoreSchedule(storeId, plan);
      if (!res.ok) { setErr(res.error); return; }
      setEditing(false);
      // The action deliberately does no revalidatePath (see app/map/actions.ts
      // for the measurement). Without this the panel would drop back to the
      // server props it was rendered with and show the PRE-save week — the save
      // would look like it had failed when it had not.
      router.refresh();
    });
  }

  return (
    <div className="panel sdp">
      <div className="sdp-h">
        <span>Delivery days &amp; run</span>
        {!editing ? (
          <button type="button" className="sdp-edit" onClick={open}>Edit</button>
        ) : (
          <span className="sdp-acts">
            <button type="button" className="sdp-cancel" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
            <button type="button" className="sdp-save" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </span>
        )}
      </div>

      {multiRun && !editing && (
        <div className="sdp-multi">
          This store is on <b>{distinctRuns.size} different runs</b> across the week.
        </div>
      )}

      <div className="sdp-days">
        {live.map((r, i) => {
          const name = r.runId ? runName.get(r.runId) ?? "Unknown run" : null;
          if (!editing) {
            return (
              <div key={r.day} className={`sdp-row${r.on ? " on" : " off"}`}>
                <span className="sdp-d">{LABEL[r.day]}</span>
                <span className="sdp-r">{r.on ? (name ?? "No run set") : "No delivery"}</span>
              </div>
            );
          }
          return (
            <div key={r.day} className={`sdp-row edit${r.on ? " on" : " off"}`}>
              <label className="sdp-d">
                <input
                  type="checkbox"
                  checked={r.on}
                  disabled={saving}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setRows((prev) => prev.map((p, j) => (j === i ? { ...p, on } : p)));
                  }}
                />
                {LABEL[r.day]}
              </label>
              <select
                className="sdp-sel"
                value={r.runId ?? ""}
                disabled={!r.on || saving}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setRows((prev) => prev.map((p, j) => (j === i ? { ...p, runId: v } : p)));
                }}
                aria-label={`Run for ${LABEL[r.day]}`}
              >
                <option value="">— pick a run —</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>{run.name}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      {err && <div className="sdp-err">{err}</div>}

      <div className="sdp-f">
        {delivering.length === 0
          ? "No delivery days set for this store."
          : `${delivering.length} ${delivering.length === 1 ? "delivery" : "deliveries"} a week.`}
        {!editing && schedule?.run_name && !multiRun && <> Base run <b>{schedule.run_name}</b>.</>}
      </div>

      <style>{`
        .sdp{padding:16px 18px}
        .sdp .sdp-h{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;font-weight:700;letter-spacing:.02em;margin-bottom:12px}
        .sdp .sdp-edit,.sdp .sdp-cancel,.sdp .sdp-save{font:inherit;font-size:12px;font-weight:600;border-radius:7px;padding:4px 11px;cursor:pointer;border:1px solid var(--line)}
        .sdp .sdp-edit,.sdp .sdp-cancel{background:transparent;color:var(--ink2)}
        .sdp .sdp-edit:hover,.sdp .sdp-cancel:hover{border-color:var(--ink2)}
        .sdp .sdp-save{background:var(--crust,#c98a34);border-color:var(--crust,#c98a34);color:#fff}
        .sdp .sdp-save:disabled,.sdp .sdp-cancel:disabled{opacity:.55;cursor:default}
        .sdp .sdp-acts{display:flex;gap:7px}

        .sdp .sdp-multi{background:var(--amber-b,#fdf3df);border:1px solid #e8d5a6;border-left:3px solid var(--amber,#c8912a);color:var(--amber-t,#7a5a12);border-radius:9px;padding:8px 11px;font-size:12.5px;line-height:1.5;margin-bottom:11px}

        .sdp .sdp-days{display:flex;flex-direction:column;gap:4px}
        .sdp .sdp-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px;border-radius:8px;font-size:13px;border:1px solid transparent}
        .sdp .sdp-row.on{background:var(--green-b,#e9f2e6);border-color:#cadfc3}
        .sdp .sdp-row.off{background:var(--bg2,rgba(0,0,0,.025));color:var(--muted)}
        .sdp .sdp-row .sdp-d{font-weight:600;white-space:nowrap}
        .sdp .sdp-row.off .sdp-d{font-weight:500}
        .sdp .sdp-row .sdp-r{font-size:12.5px;text-align:right}
        .sdp .sdp-row.on .sdp-r{font-weight:600;color:var(--green-t,#3c6b32)}
        .sdp .sdp-row.off .sdp-r{color:var(--muted)}

        .sdp .sdp-row.edit{display:grid;grid-template-columns:1fr;gap:6px;align-items:stretch}
        .sdp .sdp-row.edit .sdp-d{display:flex;align-items:center;gap:8px;cursor:pointer}
        .sdp .sdp-sel{font:inherit;font-size:12.5px;width:100%;padding:5px 8px;border-radius:7px;border:1px solid var(--line);background:var(--card)}
        .sdp .sdp-sel:disabled{opacity:.5}

        .sdp .sdp-err{margin-top:10px;background:var(--red-b,#fbeae5);border:1px solid #eab9a8;border-radius:8px;padding:8px 11px;font-size:12.5px;color:var(--red-t,#8d3221)}
        .sdp .sdp-f{font-size:12px;color:var(--muted);margin-top:12px;line-height:1.5}
      `}</style>
    </div>
  );
}
