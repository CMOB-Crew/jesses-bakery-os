// Route-level loading skeletons. Next renders these automatically (via each
// route's loading.tsx) while the server component fetches, so a cold/slow load
// shows a composed placeholder instead of a blank flash. Pure presentation —
// no data, no client state.

import type { CSSProperties } from "react";

type Variant = "dashboard" | "table" | "board" | "profile" | "cards" | "generic";

const bar = (w: number | string, h = 14, style: CSSProperties = {}) => (
  <span className="sk" style={{ width: w, height: h, display: "inline-block", ...style }} />
);

function Head({ crumbs = false }: { crumbs?: boolean }) {
  return crumbs ? (
    <div style={{ marginBottom: 14 }}>{bar(200, 12)}</div>
  ) : (
    <div className="head">
      {bar(190, 26)}
      <div style={{ marginLeft: "auto" }}>{bar(150, 13)}</div>
    </div>
  );
}

function Tiles({ n = 4 }: { n?: number }) {
  return (
    <div className="sk-tiles">
      {Array.from({ length: n }).map((_, i) => (
        <div className="sk-tile" key={i}>
          {bar(64, 26)}
          <div style={{ marginTop: 10 }}>{bar("70%", 10)}</div>
        </div>
      ))}
    </div>
  );
}

function Rows({ n = 9 }: { n?: number }) {
  return (
    <div className="sk-panel">
      {Array.from({ length: n }).map((_, i) => (
        <div className="sk-row" key={i}>
          {bar(26, 26, { borderRadius: 8, flex: "none" })}
          <div style={{ flex: 1 }}>{bar(`${45 + ((i * 7) % 40)}%`, 13)}</div>
          {bar(48, 13, { flex: "none" })}
          {bar(40, 13, { flex: "none" })}
        </div>
      ))}
    </div>
  );
}

export default function Skeleton({ variant = "generic" }: { variant?: Variant }) {
  return (
    <div className="skwrap" aria-hidden="true">
      {variant === "profile" ? <Head crumbs /> : <Head />}

      {variant === "dashboard" && (
        <>
          <div className="sk-hero" style={{ height: 150 }} />
          <Tiles n={4} />
          <div className="sk-cols">
            <Rows n={6} />
            <Rows n={6} />
          </div>
        </>
      )}

      {variant === "table" && (
        <>
          <div className="sk-chips">{Array.from({ length: 5 }).map((_, i) => <span className="sk" key={i} style={{ width: 80, height: 30, borderRadius: 999 }} />)}</div>
          <Rows n={11} />
        </>
      )}

      {variant === "board" && (
        <>
          <div className="sk-hero" style={{ height: 130 }} />
          <div className="sk-chips">{Array.from({ length: 4 }).map((_, i) => <span className="sk" key={i} style={{ width: 110, height: 34, borderRadius: 10 }} />)}</div>
          <Rows n={10} />
        </>
      )}

      {variant === "profile" && (
        <>
          <div className="sk-hero" style={{ height: 92 }} />
          <Tiles n={5} />
          <Rows n={8} />
        </>
      )}

      {variant === "cards" && (
        <>
          <div className="sk-hero" style={{ height: 120 }} />
          <div className="sk-grid">{Array.from({ length: 12 }).map((_, i) => <div className="sk-card" key={i} />)}</div>
        </>
      )}

      {variant === "generic" && (
        <>
          <div className="sk-hero" style={{ height: 110 }} />
          <Rows n={7} />
        </>
      )}

      <style>{`
        .skwrap .sk{position:relative;overflow:hidden;background:var(--surface);border-radius:8px}
        .skwrap .sk::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent);animation:skwave 1.5s infinite}
        @keyframes skwave{100%{transform:translateX(100%)}}
        .skwrap .sk-hero{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);margin-bottom:16px;position:relative;overflow:hidden}
        .skwrap .sk-hero::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(250,246,238,.6),transparent);animation:skwave 1.6s infinite}
        .skwrap .sk-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
        @media(max-width:820px){.skwrap .sk-tiles{grid-template-columns:1fr 1fr}}
        .skwrap .sk-tile{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--sh);padding:16px 18px}
        .skwrap .sk-chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
        .skwrap .sk-panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
        .skwrap .sk-row{display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--line2)}
        .skwrap .sk-row:last-child{border-bottom:none}
        .skwrap .sk-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
        @media(max-width:820px){.skwrap .sk-cols{grid-template-columns:1fr}}
        .skwrap .sk-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
        @media(max-width:1000px){.skwrap .sk-grid{grid-template-columns:repeat(3,1fr)}}
        .skwrap .sk-card{height:118px;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--sh);position:relative;overflow:hidden}
        .skwrap .sk-card::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(250,246,238,.6),transparent);animation:skwave 1.6s infinite}
      `}</style>
    </div>
  );
}
