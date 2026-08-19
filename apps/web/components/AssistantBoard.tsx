"use client";

import { useRef, useState } from "react";

const nf = (n: number) => n.toLocaleString("en-AU");

type Bar = { label: string; value: number; suffix?: string };
type Answer = { headline: string; bars?: Bar[]; note?: string; sql?: string };
type Exchange = { q: string; a: Answer | null }; // a === null while thinking

export type AssistantFacts = { wastePct: number | null; storesAttention: number | null; savedWk: number | null } | null;

const SPARK = (
  <svg viewBox="0 0 24 24"><path d="M12 2l1.9 5.6L19.5 9l-5.6 1.4L12 16l-1.9-5.6L4.5 9l5.6-1.4z" /></svg>
);

// Suggestion cards — same questions the assistant already handles.
const QCARDS: { key: string; q: string; label: string; tag: string; bg: string; stroke: string; icon: React.ReactNode }[] = [
  { key: "save", q: "How much can you save us?", label: "How much can you save us?", tag: "Savings", bg: "var(--green-b)", stroke: "#356630", icon: <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /> },
  { key: "waste", q: "Where is my waste worst?", label: "Where is my waste worst?", tag: "Waste", bg: "var(--red-b)", stroke: "#9c3520", icon: <><path d="M10.3 3.9l-8 13.8A1.5 1.5 0 0 0 3.6 20h16.8a1.5 1.5 0 0 0 1.3-2.3l-8-13.8a1.5 1.5 0 0 0-2.6 0z" /><path d="M12 9v4M12 17h.01" /></> },
  { key: "cut", q: "What should we cut?", label: "What should we cut?", tag: "Products", bg: "#f0e2cc", stroke: "#8a5714", icon: <path d="M4 7c0-2 2-3 4-3s4 1 4 3-2 3-4 3-4-1-4-3zM12 7c0-2 2-3 4-3s4 1 4 3-2 3-4 3-4-1-4-3zM4 7v8a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4V7" /> },
  { key: "stores", q: "Which stores need attention?", label: "Which stores need attention?", tag: "Stores", bg: "var(--amber-b)", stroke: "#7c5308", icon: <path d="M3 9l1-5h16l1 5M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9M4 9h16M9 20v-6h6v6" /> },
  { key: "stockouts", q: "Any Sunday sell-out risk?", label: "Any Sunday sell-out risk?", tag: "Sell-outs", bg: "var(--amber-b)", stroke: "#7c5308", icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> },
  { key: "bake", q: "What should we bake less of?", label: "What should we bake less of?", tag: "Production", bg: "#e7efe1", stroke: "#356630", icon: <path d="M3 21h18M4 21V9l5-3 5 3v12M14 21V11l6-3v13" /> },
];

// The Assistant. The look is the demo's — ask-hero, chat thread, suggestion
// rail, live fact card — but every answer comes from the real /api/ask endpoint
// (a deterministic query over the reporting views). Nothing here is canned.
export default function AssistantBoard({ facts }: { facts: AssistantFacts }) {
  const [q, setQ] = useState("");
  const [thread, setThread] = useState<Exchange[]>([]);
  const [loading, setLoading] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);

  async function ask(question?: string) {
    const query = (question ?? q).trim();
    if (!query || loading) return;
    setQ("");
    setLoading(true);
    setThread((t) => [...t, { q: query, a: null }]);
    // let the thinking bubble paint before we scroll
    requestAnimationFrame(() => threadRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
    let answer: Answer;
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: query }),
      });
      answer = (await res.json()) as Answer;
    } catch {
      answer = { headline: "Couldn't reach the data just now — try again." };
    }
    setThread((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, a: answer } : x)));
    setLoading(false);
  }

  const hasThread = thread.length > 0;

  return (
    <section className="acalm">
      <div className="askhero">
        <div className="ah-top">
          <div className="spark">{SPARK}</div>
          <div className="tt">Ask the bakery anything<small>Plain-English questions on your live data — exact numbers, never guessed</small></div>
          <div className="live"><i /> Live · Woolworths feed</div>
        </div>
        <div className="ah-input">
          <div className="field">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ask()}
              placeholder="e.g. Where is my waste worst this week?"
              autoComplete="off"
            />
          </div>
          <button className="ah-send" type="button" onClick={() => ask()} disabled={loading}>
            Ask <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </div>

      <div className="grid2">
        <div className="thread">
          {!hasThread && (
            <div className="welcome">
              <div className="wemblem">
                <svg viewBox="0 0 40 40"><defs><linearGradient id="lg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c98a34" /><stop offset="1" stopColor="#9a6414" /></linearGradient></defs><circle cx="20" cy="20" r="19" fill="url(#lg2)" /><path d="M10 25c0-6 4.5-9 10-9s10 3 10 9c0 2.2-1.6 3.4-3.4 3.4H13.4C11.6 28.4 10 27.2 10 25z" fill="#fbf0d8" /><path d="M16 21l-2 4.5M20 20l-2 5.5M24 21l-2 4.5" stroke="#b0741c" strokeWidth="1.5" strokeLinecap="round" fill="none" /></svg>
              </div>
              <h3>Hi Simona — ask me anything</h3>
              <p>I can see this week&apos;s live data across all your stores — waste, savings, what to cut, which stores need attention, Sunday sell-outs. Ask away, or tap a suggestion on the right.</p>
              <div className="tagline">Handmade fresh daily in Sydney</div>
            </div>
          )}

          {thread.map((x, i) => (
            <div className="exchange" key={i}>
              <div className="bubble user">{x.q}</div>
              <div className="bubble ai">
                <div className="av">{SPARK}</div>
                <div className="ai-body">
                  {x.a === null ? (
                    <div className="dots"><span /><span /><span /></div>
                  ) : (
                    <>
                      <div className="a-head">{x.a.headline}</div>
                      {x.a.bars && x.a.bars.length > 0 && (
                        <div className="viz"><div className="ba2">
                          {(() => {
                            const max = Math.max(...x.a.bars.map((b) => Number(b.value) || 0), 1);
                            return x.a.bars.map((b) => {
                              const val = Number(b.value) || 0;
                              return (
                                <div className="barrow" key={b.label}>
                                  <span className="bl">{b.label}</span>
                                  <span className="bt"><i style={{ width: `${Math.max(5, (100 * val) / max)}%`, background: "var(--crust)" }} /></span>
                                  <span className="bv">{nf(val)}{b.suffix ?? ""}</span>
                                </div>
                              );
                            });
                          })()}
                        </div></div>
                      )}
                      {x.a.note && <div className="a-note">{x.a.note}</div>}
                      {x.a.sql && (
                        <details className="how">
                          <summary>How I got this</summary>
                          <div className="how-body">
                            Deterministic query over read-only reporting views — no guesswork.
                            <code>{x.a.sql}</code>
                          </div>
                        </details>
                      )}
                      <div className="src"><i /> Live query · Woolworths feed</div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
          <div ref={threadRef} />
        </div>

        <aside className="rail">
          <div>
            <div className="rlabel">Try asking</div>
            <div className="qcards">
              {QCARDS.map((c) => (
                <button className="qcard" type="button" key={c.key} onClick={() => ask(c.q)}>
                  <span className="ic" style={{ background: c.bg }}>
                    <svg viewBox="0 0 24 24" stroke={c.stroke} fill="none">{c.icon}</svg>
                  </span>
                  <span className="qt">{c.label}<small>{c.tag}</small></span>
                </button>
              ))}
            </div>
          </div>
          <div className="factcard">
            <div className="fl"><i /> Reading right now</div>
            <div className="factrow"><span className="fk">Network waste · this week</span><span className="fv a">{facts?.wastePct != null ? `${facts.wastePct}%` : "—"}</span></div>
            <div className="factrow"><span className="fk">Stores needing attention</span><span className="fv">{facts?.storesAttention != null ? nf(facts.storesAttention) : "—"}</span></div>
            <div className="factrow"><span className="fk">Loaves the plan saves / wk</span><span className="fv g">{facts?.savedWk != null ? nf(facts.savedWk) : "—"}</span></div>
          </div>
        </aside>
      </div>

      <style>{`
      .acalm{display:block}
      .acalm .askhero{position:relative;overflow:hidden;border-radius:18px;padding:28px 30px;margin-bottom:22px;background:linear-gradient(135deg,#fffdf8 0%,#fbf5e8 55%,#f6eedc 100%);border:1px solid var(--line);box-shadow:var(--sh-soft)}
      .acalm .askhero::before{content:"";position:absolute;left:0;top:0;right:0;height:3px;background:linear-gradient(90deg,#e0a838,#b0741c 45%,transparent)}
      .acalm .askhero::after{content:"";position:absolute;right:-60px;top:-80px;width:320px;height:320px;border-radius:50%;background:radial-gradient(circle,rgba(214,158,46,.16),transparent 64%);pointer-events:none}
      .acalm .ah-top{display:flex;align-items:center;gap:13px;margin-bottom:16px;position:relative}
      .acalm .spark{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:linear-gradient(140deg,#e0a838,#b0741c);box-shadow:0 6px 18px -5px rgba(176,116,28,.6);flex:none}
      .acalm .spark svg{width:23px;height:23px;fill:#fff}
      .acalm .ah-top .tt{font-family:var(--serif);font-size:20px;font-weight:600;color:var(--ink);letter-spacing:-.3px}
      .acalm .ah-top .tt small{display:block;font-family:var(--sans);font-size:12.5px;font-weight:400;color:var(--muted);letter-spacing:0;margin-top:2px}
      .acalm .ah-top .live{margin-left:auto;font-size:11.5px;color:var(--green-t);font-weight:600;display:inline-flex;align-items:center;gap:6px}
      .acalm .ah-top .live i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(95,143,90,.20);animation:acpulse 2s infinite}
      @keyframes acpulse{0%,100%{opacity:1}50%{opacity:.4}}
      .acalm .ah-input{display:flex;gap:11px;position:relative}
      .acalm .ah-input .field{flex:1;display:flex;align-items:center;gap:11px;background:var(--card);border:1px solid var(--line);border-radius:13px;padding:0 10px 0 16px;box-shadow:var(--sh);transition:.15s}
      .acalm .ah-input .field:focus-within{border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.13)}
      .acalm .ah-input .field svg{width:18px;height:18px;stroke:var(--crust);stroke-width:1.9;fill:none;flex:none}
      .acalm .ah-input input{flex:1;border:none;background:transparent;padding:16px 4px;font-size:15px;font-family:inherit;outline:none;color:var(--ink)}
      .acalm .ah-input input::placeholder{color:var(--faint)}
      .acalm .ah-send{background:linear-gradient(140deg,#e0a838,#b0741c);color:#fff;border:none;border-radius:13px;padding:0 26px;font-weight:700;font-size:15px;font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:9px;box-shadow:0 6px 16px -6px rgba(176,116,28,.55)}
      .acalm .ah-send:hover{background:linear-gradient(140deg,#d69e2e,#9c6415)}
      .acalm .ah-send:disabled{opacity:.6;cursor:default}
      .acalm .ah-send svg{width:16px;height:16px;stroke:#fff;stroke-width:2.2;fill:none}
      .acalm .grid2{display:grid;grid-template-columns:1.7fr 1fr;gap:22px;align-items:start}
      @media(max-width:1000px){.acalm .grid2{grid-template-columns:1fr}}
      .acalm .thread{display:flex;flex-direction:column;gap:16px;min-height:200px}
      .acalm .welcome{background:linear-gradient(160deg,#fffdf8,#fbf5e9);border:1px solid var(--line);border-radius:16px;box-shadow:var(--sh);padding:30px 26px 24px;text-align:center;position:relative;overflow:hidden}
      .acalm .wemblem{width:62px;height:62px;margin:0 auto 15px;filter:drop-shadow(0 5px 12px rgba(120,80,20,.28));position:relative}
      .acalm .wemblem svg{width:62px;height:62px}
      .acalm .welcome h3{font-family:var(--serif);font-size:20px;font-weight:600;margin-bottom:7px;position:relative}
      .acalm .welcome p{color:var(--ink2);font-size:14px;max-width:460px;margin:0 auto;line-height:1.6;position:relative}
      .acalm .tagline{margin-top:15px;font-family:var(--serif);font-style:italic;font-size:13.5px;color:var(--muted);position:relative}
      .acalm .exchange{display:flex;flex-direction:column;gap:12px;animation:acrise .3s ease}
      @keyframes acrise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      .acalm .bubble.user{align-self:flex-end;max-width:80%;background:var(--espresso);color:#f3ece0;padding:12px 16px;border-radius:14px 14px 4px 14px;font-size:14px;font-weight:500}
      .acalm .bubble.ai{align-self:flex-start;max-width:94%;display:flex;gap:12px}
      .acalm .bubble.ai .av{width:34px;height:34px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;background:linear-gradient(140deg,#e0a838,#b0741c);box-shadow:0 4px 12px -4px rgba(176,116,28,.5)}
      .acalm .bubble.ai .av svg{width:18px;height:18px;fill:#fff}
      .acalm .ai-body{background:var(--card);border:1px solid var(--line);border-radius:4px 14px 14px 14px;box-shadow:var(--sh);padding:16px 18px;flex:1;font-size:14px;line-height:1.6;color:var(--ink2);min-width:0}
      .acalm .ai-body .a-head{color:var(--ink);font-weight:600;font-size:14.5px;line-height:1.55}
      .acalm .ai-body .a-note{font-size:12.5px;color:var(--muted);margin-top:10px;line-height:1.55}
      .acalm .ai-body .src{margin-top:12px;font-size:11px;color:var(--faint);display:inline-flex;align-items:center;gap:6px}
      .acalm .ai-body .src i{width:6px;height:6px;border-radius:50%;background:var(--green)}
      .acalm .dots{display:inline-flex;gap:5px;padding:4px 0}
      .acalm .dots span{width:8px;height:8px;border-radius:50%;background:var(--crust);opacity:.4;animation:acblink 1.2s infinite}
      .acalm .dots span:nth-child(2){animation-delay:.2s}.acalm .dots span:nth-child(3){animation-delay:.4s}
      @keyframes acblink{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
      .acalm .viz{margin-top:14px;background:var(--surface);border:1px solid var(--line2);border-radius:11px;padding:14px 16px}
      .acalm .ba2{display:flex;flex-direction:column;gap:9px}
      .acalm .barrow{display:flex;align-items:center;gap:11px}
      .acalm .barrow .bl{width:130px;font-size:12.5px;color:var(--ink2);flex:none;text-align:right}
      .acalm .barrow .bt{flex:1;height:9px;background:#f0e9db;border-radius:5px;overflow:hidden}
      .acalm .barrow .bt i{display:block;height:100%;border-radius:5px;transition:width .6s}
      .acalm .barrow .bv{width:60px;text-align:right;font-weight:700;font-size:12.5px;font-variant-numeric:tabular-nums}
      .acalm .how{margin-top:11px;font-size:12px}
      .acalm .how summary{cursor:pointer;color:var(--ink2);font-weight:600;font-size:12px;list-style:none}
      .acalm .how summary::-webkit-details-marker{display:none}
      .acalm .how summary::before{content:"▸ ";color:var(--crust)}
      .acalm .how[open] summary::before{content:"▾ "}
      .acalm .how-body{margin-top:6px;color:var(--ink2)}
      .acalm .how-body code{display:block;white-space:pre-wrap;margin-top:7px;padding:11px;background:#faf6ee;border:1px solid var(--line);border-radius:8px;font-size:11.5px;color:#5a5044}
      .acalm .rail{display:flex;flex-direction:column;gap:16px;position:sticky;top:22px}
      .acalm .rlabel{font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:2px}
      .acalm .qcards{display:flex;flex-direction:column;gap:9px}
      .acalm .qcard{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;cursor:pointer;transition:.15s;box-shadow:var(--sh);text-align:left;font-family:inherit;width:100%}
      .acalm .qcard:hover{border-color:var(--crust);transform:translateY(-1px);box-shadow:var(--sh-soft)}
      .acalm .qcard .ic{width:34px;height:34px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center}
      .acalm .qcard .ic svg{width:18px;height:18px;stroke-width:1.9;fill:none}
      .acalm .qcard .qt{font-size:13.5px;font-weight:600;color:var(--ink);line-height:1.3}
      .acalm .qcard .qt small{display:block;font-weight:400;color:var(--muted);font-size:11.5px;margin-top:1px;letter-spacing:.3px;text-transform:uppercase}
      .acalm .factcard{background:linear-gradient(135deg,#fffdf8,#f7efdd);border:1px solid var(--line);border-radius:14px;padding:16px 20px 18px;box-shadow:var(--sh);position:relative;overflow:hidden}
      .acalm .factcard::before{content:"";position:absolute;left:0;top:0;right:0;height:3px;background:linear-gradient(90deg,#e0a838,#b0741c 45%,transparent)}
      .acalm .factcard .fl{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:7px;position:relative}
      .acalm .factcard .fl i{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(95,143,90,.18)}
      .acalm .factrow{display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--line2);position:relative}
      .acalm .factrow:last-child{border-bottom:none}
      .acalm .factrow .fk{font-size:13px;color:var(--ink2)}
      .acalm .factrow .fv{font-family:var(--serif);font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink)}
      .acalm .factrow .fv.g{color:var(--green-t)}.acalm .factrow .fv.a{color:var(--amber-t)}
      @media(max-width:720px){.acalm .ah-input{flex-wrap:wrap}.acalm .ah-input .field{flex:1 1 100%}.acalm .ah-send{flex:1 1 100%;justify-content:center;padding:14px}}
      `}</style>
    </section>
  );
}
