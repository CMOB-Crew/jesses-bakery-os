"use client";

import { useState, useTransition } from "react";
import {
  createPerson, resetPassword, setActive, setRole, loadPeople,
  type PeopleResult,
} from "@/app/people/people-actions";
import type { Person } from "@/lib/people";
import { ROLES, MANAGER_MAY_TOUCH, mayActOn, mayGrant } from "@/lib/people-rules";

/* ------------------------------------------------------------------ *
 * The People screen.
 *
 * Every refusal shown here is a COPY of a rule enforced on the server.
 * Hiding a button a manager may not press is politeness, not security --
 * lib/nav-access.ts carries the same warning for the sidebar and it is
 * worth repeating: this runs in the browser and can be walked around.
 * app/people/people-actions.ts re-reads the role and the target from the
 * database and decides again, every time.
 *
 * What the browser DOES decide is what to show, and that matters for a
 * different reason: a button that always refuses teaches people the app
 * is unreliable.
 *
 * THE PASSWORD IS SHOWN ONCE. It is never stored, never logged and never
 * in the audit row, so there is no second chance to read it. The panel
 * says so next to it rather than letting somebody find out.
 * ------------------------------------------------------------------ */

const CSS = `
.pp { display:flex; flex-direction:column; gap:26px; max-width:960px; }
.pp h2 { margin:0 0 4px; font-size:19px; }
.pp p.lede { margin:0; color:var(--muted,#5C625F); max-width:62ch; font-size:14px; }
.pp table { border-collapse:collapse; width:100%; font-size:14px; }
.pp th, .pp td { text-align:left; padding:9px 10px; border-bottom:1px solid rgba(128,128,128,.22); vertical-align:middle; }
.pp th { font-size:11px; letter-spacing:.06em; text-transform:uppercase; opacity:.62; font-weight:600; }
.pp tr.off td:not(.act) { opacity:.45; }
.pp .who { font-weight:600; }
.pp .em { display:block; opacity:.62; font-size:12.5px; }
.pp .act { text-align:right; white-space:nowrap; }
.pp button { font:inherit; font-size:13px; padding:5px 10px; border-radius:4px; cursor:pointer;
  border:1px solid rgba(128,128,128,.4); background:transparent; color:inherit; margin-left:6px; }
.pp button:hover:not(:disabled) { border-color:currentColor; }
.pp button:disabled { opacity:.4; cursor:not-allowed; }
.pp button.primary { border-color:transparent; background:#1F5F5B; color:#fff; }
.pp select, .pp input { font:inherit; font-size:14px; padding:6px 8px; border-radius:4px;
  border:1px solid rgba(128,128,128,.4); background:transparent; color:inherit; }
.pp form.new { display:flex; flex-wrap:wrap; gap:9px; align-items:center; }
.pp .msg { padding:11px 13px; border-radius:4px; border:1px solid rgba(128,128,128,.3); font-size:14px; }
.pp .msg.bad { border-left:3px solid #A32B21; }
.pp .msg.good { border-left:3px solid #1F6F43; }
.pp .pw { margin-top:9px; padding:11px 13px; border-radius:4px; border:1px dashed rgba(128,128,128,.55); }
.pp .pw code { font-family:ui-monospace,Menlo,monospace; font-size:17px; font-weight:600; letter-spacing:.02em; }
.pp .pw small { display:block; margin-top:5px; opacity:.7; font-size:12.5px; }
@media (max-width:620px) {
  .pp td.act { text-align:left; }
  .pp button { margin:4px 6px 0 0; }
}
`;

export default function PeoplePanel({ me, people }: { me: Person | null; people: Person[] }) {
  const [rows, setRows] = useState(people);
  const [msg, setMsg] = useState<PeopleResult | null>(null);
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRoleValue] = useState("driver");

  const myRole = String(me?.role ?? "");
  const isAdmin = myRole === "admin";
  const grantable = ROLES.filter((r) => mayGrant(myRole, r).ok);

  function run(fn: () => Promise<PeopleResult>, after?: (r: PeopleResult) => void) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r);
      if (r.ok) after?.(r);
    });
  }

  // Optimism is wrong here. A role change or a switch-off can be refused by a
  // rule the browser does not know about -- the last-admin check needs a count
  // from the database -- so the list is only updated from what the server
  // actually did, by reloading the page data.
  function refresh() {
    start(async () => {
      const r = await loadPeople();
      if (r.ok) setRows(r.people);
    });
  }

  return (
    <div className="pp">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div>
        <h2>Add somebody</h2>
        <p className="lede">
          They can sign in straight away. The password is shown once, here, and is never
          stored — so hand it over before you close the page.
          {!isAdmin && ` As a manager you can add ${MANAGER_MAY_TOUCH.join("s and ")}s.`}
        </p>
      </div>

      <form
        className="new"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => createPerson({ email, fullName: name, role }), () => {
            setEmail(""); setName(""); refresh();
          });
        }}
      >
        <input
          id="pp-email" type="email" required placeholder="email address" value={email}
          onChange={(e) => setEmail(e.target.value)} size={28} aria-label="Email address"
        />
        <input
          id="pp-name" placeholder="name" value={name}
          onChange={(e) => setName(e.target.value)} size={18} aria-label="Name"
        />
        <select id="pp-role" value={role} onChange={(e) => setRoleValue(e.target.value)} aria-label="Role">
          {grantable.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button className="primary" type="submit" disabled={pending}>
          {pending ? "Working…" : "Create account"}
        </button>
      </form>

      {msg && (
        <div className={`msg ${msg.ok ? "good" : "bad"}`}>
          {msg.ok ? msg.message : msg.error}
          {msg.ok && msg.password && (
            <div className="pw">
              <code>{msg.password}</code>
              <small>
                For {msg.email}. Shown once — it is not saved anywhere and nobody,
                including us, can look it up later.
              </small>
            </div>
          )}
        </div>
      )}

      <div>
        <h2>Everyone</h2>
        <p className="lede">
          Switching somebody off does not delete anything. They can still sign in and every
          screen will be empty, because a role only counts while the account is active.
        </p>
      </div>

      <table>
        <thead>
          <tr><th>Person</th><th>Role</th><th>State</th><th className="act">&nbsp;</th></tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const touchable = mayActOn(myRole, p.role).ok;
            const isMe = p.id === me?.id;
            return (
              <tr key={p.id} className={p.is_active ? "" : "off"}>
                <td>
                  <span className="who">{p.full_name || p.email.split("@")[0]}</span>
                  <span className="em">{p.email}{isMe ? " · you" : ""}</span>
                </td>
                <td>
                  {touchable && !isMe ? (
                    <select
                      aria-label={`Role for ${p.email}`}
                      value={p.role ?? ""}
                      disabled={pending}
                      onChange={(e) => run(() => setRole(p.id, e.target.value), refresh)}
                    >
                      {p.role == null && <option value="">no role</option>}
                      {ROLES.filter((r) => mayGrant(myRole, r).ok).map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  ) : (
                    <span>{p.role ?? "no role"}</span>
                  )}
                </td>
                <td>{p.is_active ? "active" : "switched off"}</td>
                <td className="act">
                  <button
                    disabled={pending || !touchable}
                    onClick={() => run(() => resetPassword(p.id), refresh)}
                  >
                    Reset password
                  </button>
                  <button
                    disabled={pending || !touchable || isMe}
                    onClick={() => run(() => setActive(p.id, !p.is_active), refresh)}
                  >
                    {p.is_active ? "Switch off" : "Switch on"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
