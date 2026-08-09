"use client";
import { useState } from "react";

// Placeholder for the deterministic NL assistant (semantic layer + parameterised
// queries land in a later phase). For now it captures intent; wiring it to the
// read-only reporting role is the next step.
const CHIPS = [
  "Where is my waste worst?",
  "Which stores need attention?",
  "Sunday stockouts",
  "Sales this week vs last",
];

export default function AskBar() {
  const [q, setQ] = useState("");
  return (
    <div className="ask">
      <div className="askrow">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask anything…  e.g. where is my waste worst this week?"
        />
        <button className="askbtn" onClick={() => setQ(q)}>Ask</button>
      </div>
      <div className="chips">
        {CHIPS.map((c) => (
          <span key={c} className="chip" onClick={() => setQ(c)}>{c}</span>
        ))}
      </div>
    </div>
  );
}
