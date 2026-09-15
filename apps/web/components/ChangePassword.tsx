"use client";

import { useState, useTransition } from "react";
import { changeMyPassword, type ChangeResult } from "@/app/account/account-actions";
import { MIN_PASSWORD } from "@/lib/people-rules";

/* ------------------------------------------------------------------ *
 * Change your own password.
 *
 * Deliberately plain. Whoever uses this most is a driver on a phone at
 * 4am who has been handed a password by somebody else and wants his
 * own. Three boxes and a button.
 *
 * Every rule shown here is enforced again on the server -- see
 * lib/people-rules.ts, asserted in scripts/people-check.ts. What the
 * browser does is say the rule BEFORE the person types, because a rule
 * you only learn by breaking it is a rule that makes people feel stupid.
 * ------------------------------------------------------------------ */

const CSS = `
.cp { display:flex; flex-direction:column; gap:16px; max-width:420px; }
.cp label { display:flex; flex-direction:column; gap:5px; font-size:13.5px; font-weight:600; }
.cp input { font:inherit; font-size:16px; padding:9px 11px; border-radius:5px;
  border:1px solid rgba(128,128,128,.45); background:transparent; color:inherit; }
.cp input:focus-visible { outline:2px solid #1F5F5B; outline-offset:1px; }
.cp small { font-weight:400; opacity:.7; font-size:12.5px; }
.cp button { font:inherit; font-size:15px; padding:9px 16px; border-radius:5px; cursor:pointer;
  border:1px solid transparent; background:#1F5F5B; color:#fff; align-self:flex-start; }
.cp button:disabled { opacity:.5; cursor:not-allowed; }
.cp .msg { padding:11px 13px; border-radius:5px; border:1px solid rgba(128,128,128,.3); font-size:14px; }
.cp .msg.bad { border-left:3px solid #A32B21; }
.cp .msg.good { border-left:3px solid #1F6F43; }
`;

export default function ChangePassword({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<ChangeResult | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="cp"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        start(async () => {
          const r = await changeMyPassword({ current, next, confirm });
          setMsg(r);
          if (r.ok) { setCurrent(""); setNext(""); setConfirm(""); }
        });
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {/* Not shown to the user as an editable field, but browsers and password
          managers behave far better when the username is in the form. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />

      <label htmlFor="cp-current">
        The password you use now
        <input
          id="cp-current" type="password" autoComplete="current-password" required
          value={current} onChange={(e) => setCurrent(e.target.value)}
        />
      </label>

      <label htmlFor="cp-next">
        New password
        <input
          id="cp-next" type="password" autoComplete="new-password" required
          value={next} onChange={(e) => setNext(e.target.value)}
        />
        <small>
          At least {MIN_PASSWORD} characters. No rules about capitals or symbols —
          length is the part that helps, and a long one you can actually type beats
          a short one you write down.
        </small>
      </label>

      <label htmlFor="cp-confirm">
        New password again
        <input
          id="cp-confirm" type="password" autoComplete="new-password" required
          value={confirm} onChange={(e) => setConfirm(e.target.value)}
        />
      </label>

      <button type="submit" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </button>

      {msg && (
        <div className={`msg ${msg.ok ? "good" : "bad"}`}>
          {msg.ok ? msg.message : msg.error}
        </div>
      )}
    </form>
  );
}
