"use client";
import { useState } from "react";

type Bar = { label: string; value: number; suffix?: string };
type Answer = { headline: string; bars?: Bar[]; note?: string; sql?: string };

const CHIPS = [
  "Where is my waste worst?",
  "Which stores need attention?",
  "Sunday stockouts",
  "Sales this week vs last",
];

export default function AskBar() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);

  async function ask(question: string) {
    const query = (question ?? q).trim();
    if (!query) return;
    setQ(query);
    setLoading(true);
    setAnswer(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: query }),
      });
      setAnswer(await res.json());
    } catch {
      setAnswer({ headline: "Couldn't reach the data just now — try again." });
    } finally {
      setLoading(false);
    }
  }

  const max = answer?.bars ? Math.max(...answer.bars.map((b) => b.value), 1) : 1;

  return (
    <div className="ask">
      <div className="askrow">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask(q)}
          placeholder="Ask anything…  e.g. where is my waste worst this week?"
        />
        <button className="askbtn" onClick={() => ask(q)} disabled={loading}>
          {loading ? "…" : "Ask"}
        </button>
      </div>
      <div className="chips">
        {CHIPS.map((c) => (
          <span key={c} className="chip" onClick={() => ask(c)}>{c}</span>
        ))}
      </div>

      {answer && (
        <div className="answer show">
          <div className="a-head">{answer.headline}</div>
          {answer.bars && (
            <div style={{ marginTop: 12 }}>
              {answer.bars.map((b) => (
                <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 12, margin: "5px 0" }}>
                  <div style={{ width: 150, fontSize: 12.5, textAlign: "right", color: "var(--ink2)" }}>{b.label}</div>
                  <div style={{ flex: 1, background: "#f0e9db", borderRadius: 5, overflow: "hidden" }}>
                    <div style={{ width: `${Math.max(5, (100 * b.value) / max)}%`, background: "var(--espresso)", height: 15, borderRadius: 5 }} />
                  </div>
                  <div style={{ width: 52, fontSize: 12.5, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {b.value.toLocaleString("en-AU")}{b.suffix ?? ""}
                  </div>
                </div>
              ))}
            </div>
          )}
          {answer.note && <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8 }}>{answer.note}</div>}
          {answer.sql && (
            <details style={{ marginTop: 11, fontSize: 12, color: "var(--muted)" }}>
              <summary style={{ cursor: "pointer", color: "var(--ink2)", fontWeight: 600 }}>How I got this</summary>
              <div style={{ marginTop: 6, color: "var(--ink2)" }}>
                Deterministic query over read-only reporting views — no guesswork.
                <code style={{ display: "block", whiteSpace: "pre-wrap", marginTop: 7, padding: 11, background: "#faf6ee", border: "1px solid var(--line)", borderRadius: 8, fontSize: 11.5, color: "#5a5044" }}>
                  {answer.sql}
                </code>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
