"use client";

// Guided pop-up tour for the read-only demo build ONLY. Rendered from the root
// layout when NEXT_PUBLIC_DEMO === "1"; on the live site the flag is unset so this
// never mounts. Anchors to existing stable class names, and centres the tooltip
// gracefully if an anchor isn't on the current page. Zero effect on app behaviour.
import { useEffect } from "react";

type Step = { sel: string; title: string; body: string; next?: string };

const TOURS: Record<string, Step[]> = {
  "/": [
    { sel: ".hero", title: "Your morning glance", body: "Open this first each day. It tells you how many stores need attention today — the rest are running themselves. Exception-first: you only look at what needs you." },
    { sel: ".enghero", title: "Waste this week vs. the plan", body: "Their old system runs ~32.5% waste. Sized to what actually sells, the plan takes it toward 22.5% — thousands of loaves a week saved. Slide the dial between Lean, Balanced and Service." },
    { sel: ".today", title: "Today, and the action list", body: "Live coverage for the day, then the to-do list underneath — high wastage, stock-outs, sudden drops and strong sellers, worst first." },
    { sel: ".side", title: "Everything's a click away", body: "Stores, Deliveries, Production, the Assistant and the rest live in the sidebar. Open Stores next.", next: "/stores" },
  ],
  "/stores": [
    { sel: ".head", title: "Every store, sorted by who needs you", body: "All 265 active stores, worst-first. Filter to just the red “needs attention” ones, or flip to your best performers." },
    { sel: ".slist", title: "Click any store to open it", body: "Each row opens that store's full profile — the single screen where you range products, set service level and adjust deliveries.", next: "/deliveries" },
  ],
  "/deliveries": [
    { sel: ".head", title: "This week's run sheet", body: "Every store's delivery for the week. “Sending now” is the current standing order; the plan sizes it to real sales, so far less comes back at day's end." },
    { sel: ".main", title: "Nothing goes out until you approve", body: "Happy with a store? Tick it. Disagree? Nudge the number or reset. You're always in control.", next: "/production" },
  ],
  "/production": [
    { sel: ".head", title: "The bake plan", body: "The same idea for the factory — what to bake this week per line, sized to real demand instead of habit, grouped by Sourdough, Bagel, Challah." },
    { sel: ".pcalm", title: "Shabbat shape is kept on purpose", body: "The Challah and Babka lines hold their Wed/Thu shape for Friday — real Shabbat demand, modelled explicitly. Confirm a line to lock it.", next: "/assistant" },
  ],
  "/assistant": [
    { sel: ".askhero", title: "Ask the bakery anything", body: "Plain-English questions on your live data — “where is my waste worst?”, “what should we bake less of?”. Real numbers, never guessed." },
    { sel: ".acalm", title: "Always on your live data", body: "It reads this week's real feed as you ask. That's the tour — click around anything, it's all real." },
  ],
  "/store": [
    { sel: ".sprof", title: "Your single source of truth", body: "For one store: what each product sold, what's going now, and what the plan recommends — with a score against real peers. Range a product in or out, or tap Adjust to change a delivery." },
  ],
};

const CSS = `
.dt-hole{position:fixed;border-radius:14px;box-shadow:0 0 0 9999px rgba(28,20,12,.58);z-index:9970;transition:all .25s ease;pointer-events:none}
.dt-tip{position:fixed;z-index:9971;width:320px;background:#fff;border-radius:14px;padding:18px 18px 14px;box-shadow:0 18px 46px #0005;transition:all .2s ease;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}
.dt-tip .s{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a4f14;font-weight:700;margin-bottom:7px}
.dt-tip .s i{width:20px;height:20px;border-radius:50%;background:#a7611c;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-style:normal}
.dt-tip h4{font-family:Georgia,"Times New Roman",serif;font-size:18px;margin:0 0 6px;font-weight:600;color:#2c2118}
.dt-tip p{margin:0 0 14px;font-size:14px;color:#4b4034;line-height:1.5}
.dt-tip .n{display:flex;align-items:center;gap:10px}
.dt-tip button{font:inherit;cursor:pointer}
.dt-tip .skip{background:0;border:0;color:#9a8d78;font-size:13px;padding:0}
.dt-tip .sp{margin-left:auto}
.dt-tip .bk{background:0;border:0;color:#7c7060;font-size:14px;margin-right:6px}
.dt-tip .nx{background:#2c2118;color:#fff;border:0;border-radius:8px;padding:9px 18px;font-weight:600;font-size:14px}
.dt-launch{position:fixed;right:20px;bottom:20px;background:#2c2118;color:#fff;border:0;border-radius:999px;padding:11px 18px;font:600 14px -apple-system,system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 22px #0004;z-index:9960;display:flex;align-items:center;gap:8px}
.dt-launch .p{color:#e0a53a}
`;

export default function DemoTour() {
  useEffect(() => {
    const path = window.location.pathname;
    const key = TOURS[path] ? path : path.startsWith("/store/") ? "/store" : path.startsWith("/region/") ? "" : path;
    const steps = TOURS[key] || [];
    if (!steps.length) return;

    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    let i = 0;
    let hole: HTMLDivElement | null = null;
    let tip: HTMLDivElement | null = null;
    const q = (s: string) => (s ? (document.querySelector(s) as HTMLElement | null) : null);

    function done() {
      hole?.remove(); tip?.remove(); hole = null; tip = null;
      try { sessionStorage.setItem("jb_demo_tour", "1"); } catch {}
    }
    function place(t: HTMLElement | null, s: Step) {
      if (!hole || !tip) return;
      const pad = 8;
      const r = t ? t.getBoundingClientRect() : { top: innerHeight / 2 - 40, left: innerWidth / 2 - 160, width: 320, height: 80, bottom: innerHeight / 2 + 40, right: innerWidth / 2 + 160 } as DOMRect;
      hole.style.top = r.top - pad + "px"; hole.style.left = r.left - pad + "px";
      hole.style.width = r.width + pad * 2 + "px"; hole.style.height = r.height + pad * 2 + "px";
      hole.style.opacity = t ? "1" : "0";
      tip.innerHTML =
        `<div class="s"><i>✦</i>STEP ${i + 1} OF ${steps.length}</div><h4>${s.title}</h4><p>${s.body}</p>` +
        `<div class="n"><button class="skip">Skip tour</button><span class="sp"></span>` +
        (i > 0 ? `<button class="bk">Back</button>` : "") +
        `<button class="nx">${i === steps.length - 1 ? "Done" : "Next"}</button></div>`;
      (tip.querySelector(".skip") as HTMLElement).onclick = done;
      const bk = tip.querySelector(".bk") as HTMLElement | null;
      if (bk) bk.onclick = () => { i--; render(); };
      (tip.querySelector(".nx") as HTMLElement).onclick = () => {
        if (i === steps.length - 1) { if (s.next) { location.href = s.next; return; } done(); }
        else { i++; render(); }
      };
      const tw = 320, th = tip.offsetHeight || 190, m = 14;
      let top: number, left: number;
      if (!t) { top = innerHeight / 2 - th / 2; left = innerWidth / 2 - tw / 2; }
      else {
        left = Math.min(Math.max(r.left, m), innerWidth - tw - m);
        if (r.bottom + th + m < innerHeight) top = r.bottom + m;
        else if (r.top - th - m > 0) top = r.top - th - m;
        else { top = innerHeight - th - m; left = Math.min(r.right + m, innerWidth - tw - m); }
      }
      tip.style.top = top + "px"; tip.style.left = left + "px";
    }
    // Poll for an element up to maxMs before giving up — the data pages render
    // their content after a DB fetch, so an anchor may not exist the instant the
    // tour tries to start. This keeps the spotlight reliable on slow/cold loads.
    function waitFor(sel: string, maxMs: number, cb: (el: HTMLElement | null) => void) {
      const first = q(sel);
      if (first) { cb(first); return; }
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = q(sel);
        if (el || Date.now() - t0 > maxMs) { clearInterval(iv); cb(el); }
      }, 120);
    }
    function render() {
      if (!hole) { hole = document.createElement("div"); hole.className = "dt-hole"; document.body.appendChild(hole); }
      if (!tip) { tip = document.createElement("div"); tip.className = "dt-tip"; document.body.appendChild(tip); }
      const s = steps[i];
      waitFor(s.sel, 8000, (t) => {
        if (t) t.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => place(t, s), t ? 300 : 0);
      });
    }
    function start() { i = 0; render(); }

    const onResize = () => { if (hole) place(q(steps[i].sel), steps[i]); };
    window.addEventListener("resize", onResize);

    const launch = document.createElement("button");
    launch.className = "dt-launch";
    launch.innerHTML = `<span class="p">▶</span> Guided tour`;
    launch.onclick = start;
    document.body.appendChild(launch);

    if (path === "/") {
      let seen = false;
      try { seen = sessionStorage.getItem("jb_demo_tour") === "1"; } catch {}
      // Wait for the first anchor (the hero) to actually render before starting,
      // so step 1 spotlights it instead of floating while the page data loads.
      if (!seen) waitFor(steps[0].sel, 12000, () => start());
    }
    return () => { window.removeEventListener("resize", onResize); done(); launch.remove(); style.remove(); };
  }, []);
  return null;
}
