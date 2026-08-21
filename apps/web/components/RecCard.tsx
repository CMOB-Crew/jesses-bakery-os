"use client";
import { useState } from "react";
import Link from "next/link";
import StatusTag from "./StatusTag";
import type { Recommendation } from "@/lib/queries";

export default function RecCard({ rec }: { rec: Recommendation }) {
  const [state, setState] = useState<"open" | "approved" | "dismissed">("open");
  const s = rec.store;
  return (
    <div className={`rec ${s.status === "red" ? "" : "amber"}`} style={state === "dismissed" ? { opacity: 0.45 } : undefined}>
      <div className="r-top">
        <Link className="r-title" href={`/store/${s.store_id}`} style={{ color: "inherit", textDecoration: "none" }}>{s.name}</Link>
        <StatusTag status={s.status} />
        <span className="r-risk">~{rec.atStake.toLocaleString("en-AU")} units/wk at stake</span>
      </div>
      <div className="r-body">{rec.cause}</div>
      <div className="r-fix"><span className="lbl">Recommended</span><b>{rec.fix}</b></div>
      <div className="r-impact">↓ {rec.impact}</div>
      {state === "open" && (
        <div className="btns">
          <button className="btn approve" onClick={() => setState("approved")}>Approve</button>
          <Link className="btn" href={`/store/${s.store_id}`}>Adjust</Link>
          <button className="btn" onClick={() => setState("dismissed")}>Dismiss</button>
        </div>
      )}
      {state === "approved" && (
        <div className="btns">
          <span style={{ fontSize: 12.5, color: "var(--green-t)", fontWeight: 600 }}>
            ✓ Approved
          </span>
          <span style={{ fontSize: 11.5, color: "var(--faint)" }}>saving it to the plan is the next build phase</span>
        </div>
      )}
      {state === "dismissed" && (
        <div className="btns"><span style={{ fontSize: 12.5, color: "var(--muted)" }}>Dismissed</span></div>
      )}
    </div>
  );
}
