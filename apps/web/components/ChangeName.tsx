"use client";

import { useState, useTransition } from "react";
import { changeMyName, type ChangeResult } from "@/app/account/account-actions";
import { nameHint, MAX_NAME } from "@/lib/people-rules";

/* ------------------------------------------------------------------ *
 * Your own name.
 *
 * This is the field that ends up on a delivery receipt. Since
 * 10 September proof of delivery is signed with the name rather than
 * the login, and the drivers were set up with first names only -- so
 * the evidence a retailer sees in a dispute currently says "Ankit".
 *
 * The single-word hint appears as you type and NEVER blocks. Some
 * people have one name, and refusing theirs to catch a missing surname
 * would be the wrong trade by a mile.
 * ------------------------------------------------------------------ */

const CSS = `
.cn { display:flex; flex-direction:column; gap:12px; max-width:420px; }
.cn label { display:flex; flex-direction:column; gap:5px; font-size:13.5px; font-weight:600; }
.cn input { font:inherit; font-size:16px; padding:9px 11px; border-radius:5px;
  border:1px solid rgba(128,128,128,.45); background:transparent; color:inherit; }
.cn input:focus-visible { outline:2px solid #1F5F5B; outline-offset:1px; }
.cn small { font-weight:400; opacity:.72; font-size:12.5px; }
.cn button { font:inherit; font-size:15px; padding:9px 16px; border-radius:5px; cursor:pointer;
  border:1px solid rgba(128,128,128,.45); background:transparent; color:inherit; align-self:flex-start; }
.cn button:disabled { opacity:.5; cursor:not-allowed; }
.cn .msg { padding:10px 12px; border-radius:5px; border:1px solid rgba(128,128,128,.3); font-size:14px; }
.cn .msg.bad { border-left:3px solid #A32B21; }
.cn .msg.good { border-left:3px solid #1F6F43; }
`;

export default function ChangeName({ current }: { current: string | null }) {
  const [name, setName] = useState(current ?? "");
  const [msg, setMsg] = useState<ChangeResult | null>(null);
  const [pending, start] = useTransition();

  const hint = nameHint(name);
  const unchanged = name.trim() === (current ?? "").trim();

  return (
    <form
      className="cn"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        start(async () => setMsg(await changeMyName(name)));
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <label htmlFor="cn-name">
        Your name
        <input
          id="cn-name" type="text" required maxLength={MAX_NAME} autoComplete="name"
          value={name} onChange={(e) => setName(e.target.value)}
        />
        <small>
          {hint ?? "This is the name a store sees on the delivery you sign. Ones already signed keep the name they were signed with."}
        </small>
      </label>

      <button type="submit" disabled={pending || unchanged || !name.trim()}>
        {pending ? "Saving…" : "Save name"}
      </button>

      {msg && (
        <div className={`msg ${msg.ok ? "good" : "bad"}`}>
          {msg.ok ? msg.message : msg.error}
        </div>
      )}
    </form>
  );
}
