"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type { PackRun, DriverState } from "@/lib/queries";
import { setDriverState } from "@/app/run-state-actions";
import { saveDeliveryProof } from "@/app/driver-proof-actions";
import { uploadProof } from "@/lib/driver-proof";

// Driver app — phone prototype. The build that matters for drivers: dead simple,
// big taps, live-capture only (no gallery), works down the run stop by stop.
// Camera uses getUserMedia when granted, else a simulated capture so the flow
// always demos. Nothing persists yet — the offline queue + upload is next phase.

type Status = "done" | "next" | "pending" | "circle";
// sid is the real store id. Optional because the sample stops have none -- they
// are not real stores and must never write a delivery record.
type Stop = { id: number; name: string; addr: string; items: [string, number][]; status: Status; sid?: string };
type Screen = "licence" | "pickrun" | "run" | "stop" | "circle" | "cam" | "photo" | "waste" | "sign" | "done";

const INITIAL: Stop[] = [
  { id: 0, name: "Coles Bondi Junction", addr: "500 Oxford St · Bondi Junction", items: [["White Sourdough", 6], ["Plain Bagel", 8], ["Mini Challah", 4], ["Pita", 5]], status: "done" },
  { id: 1, name: "Woolworths Bondi Beach", addr: "27 Hall St · Bondi Beach", items: [["White Sourdough", 5], ["Sesame Bagel", 6], ["Pita", 4]], status: "done" },
  { id: 2, name: "Coles Randwick", addr: "The Spot · Randwick", items: [["Spelt Sourdough", 7], ["Plain Bagel", 9], ["Mini Challah", 3]], status: "done" },
  { id: 3, name: "Harris Farm Bondi", addr: "Bondi Rd · Bondi", items: [["White Sourdough", 8], ["Rye Sourdough", 4], ["Poppy Bagel", 6], ["Pita", 5]], status: "next" },
  { id: 4, name: "Coles Coogee", addr: "216 Coogee Bay Rd · Coogee", items: [["White Sourdough", 6], ["Plain Bagel", 7]], status: "pending" },
  { id: 5, name: "Woolworths Maroubra", addr: "Maroubra Junction", items: [["Spelt Sourdough", 9], ["Sesame Bagel", 8], ["Mini Challah", 5]], status: "pending" },
  { id: 6, name: "Coles Eastgardens", addr: "152 Bunnerong Rd · Eastgardens", items: [["White Sourdough", 7], ["Pita", 6]], status: "pending" },
  { id: 7, name: "Harris Farm Rose Bay", addr: "744 New South Head Rd", items: [["Rye Sourdough", 5], ["Plain Bagel", 6], ["Poppy Bagel", 4]], status: "pending" },
];

const WPRODS = ["Sourdough", "Bagels", "Challah", "Pita"];
const REASONS = ["Truck at loading dock", "Store closed", "No room on shelf", "No one to receive"];

export default function DriverApp({
  runs = [],
  addresses = {},
  day = "",
  dayIso = "",
  driver = null,
  initialState = {},
}: {
  runs?: PackRun[];
  addresses?: Record<string, string>;
  day?: string;
  dayIso?: string;
  driver?: string | null;
  initialState?: DriverState;
}) {
  // Live when the engine has planned today. Otherwise the sample run stands in,
  // so the flow can still be walked through rather than showing an empty phone.
  const live = runs.length > 0;
  const [screen, setScreen] = useState<Screen>("licence");
  const [runName, setRunName] = useState<string | null>(null);
  const [stops, setStops] = useState<Stop[]>(INITIAL);
  // What has already been recorded today, so reopening the phone mid-run does
  // not start the driver from the top of the list again.
  const [record, setRecord] = useState<DriverState>(initialState);
  const [saveErr, setSaveErr] = useState(false);

  // Fire and forget, but surface a failure. A driver who taps "delivered" and
  // gets silence has no way to know the record did not save, and finding out at
  // the end of the day is finding out too late.
  // `next` is this phone's whole picture of the day, for its own display.
  // `delta` is the one stop that just changed, and is all that is sent.
  //
  // Posting the whole map is how one driver wipes another's work: this phone's
  // copy of the day is only as fresh as its last page load, so a full write
  // stamps stale entries over stops another driver recorded since. Sending just
  // the change means a phone can never write anything it did not do itself.
  const persist = useCallback(
    (next: DriverState, delta: DriverState) => {
      if (!dayIso || !live) return;
      setRecord(next);
      setDriverState(dayIso, delta)
        .then((r) => setSaveErr(!r.ok))
        .catch(() => setSaveErr(true));
    },
    [dayIso, live],
  );

  // One run's stores become the driver's stops, in the order the packing sheet
  // lists them. Not driving order -- the stop sequence is not recorded anywhere
  // in this system yet, and pretending otherwise on a phone in a van would be
  // worse than admitting it.
  function chooseRun(r: PackRun) {
    setRunName(r.name);
    const mapped: Stop[] = r.stores.map((st, i) => {
      const done = record[st.store_id];
      return {
        id: i,
        sid: st.store_id,
        name: st.name,
        addr: addresses[st.store_id] ?? (st.retailer === "invoice" ? "Invoice customer" : ""),
        items: st.items.map((it) => [it.name, it.qty] as [string, number]),
        status: (done?.s === "delivered" ? "done" : done?.s === "circled" ? "circle" : "pending") as Status,
      };
    });
    // The first stop still outstanding is the one they are on, wherever that
    // falls in the list -- not always the top, because the run may be half done.
    const nextIdx = mapped.findIndex((m) => m.status === "pending");
    if (nextIdx !== -1) mapped[nextIdx].status = "next";
    setStops(mapped);
    setScreen("run");
  }
  const [curId, setCurId] = useState<number | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [nil, setNil] = useState(false);
  const [waste, setWaste] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<string | null>(null);
  const [realCam, setRealCam] = useState(false);
  // Driver licence, captured at the start of the shift (Simona: drivers get fines
  // and have accidents, and there's no record of licences today). Prototype: held
  // in state for the session; real capture writes to the driver record next phase.
  const [licence, setLicence] = useState<string | null>(null);

  // Restore this device's licence for today. Wrapped because localStorage
  // throws outright in some private-browsing modes rather than returning null,
  // and a driver losing their run list to a storage exception would be a worse
  // bug than the one this fixes.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("jb.driver.licence");
      if (!raw) return;
      const v = JSON.parse(raw) as { day?: string; img?: string };
      // Keyed to the day so it expires on its own. A licence photographed on
      // Monday is not evidence of Tuesday's shift.
      // Reading a device store on mount is the case effects exist for --
      // "subscribe for updates from some external system". The lint's usual
      // alternative, a lazy useState initialiser, would touch window during the
      // server render and mismatch on hydration: the server has no licence, the
      // client does, and React would swap the screen out under the driver.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v?.day && v.day === dayIso && v.img) setLicence(v.img);
    } catch { /* no stored licence; the driver photographs it again */ }
  }, [dayIso]);
  const [licBusy, setLicBusy] = useState(false);
  const licRef = useRef<HTMLInputElement>(null);
  function onPickLicence(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLicBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1100;
        let w = img.width, h = img.height;
        if (w > h && w > max) { h = Math.round((h * max) / w); w = max; }
        else if (h > max) { w = Math.round((w * max) / h); h = max; }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d")?.drawImage(img, 0, 0, w, h);
        // Not `img` -- that name is already the Image() this canvas drew from.
        const dataUrl = c.toDataURL("image/jpeg", 0.8);
        setLicence(dataUrl);
        try {
          window.localStorage.setItem("jb.driver.licence", JSON.stringify({ day: dayIso, img: dataUrl }));
        } catch { /* storage full or blocked -- the shift still starts */ }
        setLicBusy(false);
      };
      img.onerror = () => { setLicBusy(false); };
      img.src = reader.result as string;
    };
    reader.onerror = () => { setLicBusy(false); };
    reader.readAsDataURL(file);
  }

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sigRef = useRef<HTMLCanvasElement | null>(null);
  // Whether anything has actually been drawn on the pad this stop. A ref, not
  // state: it changes on every pointer move and nothing renders off it.
  const sigDrawn = useRef(false);
  // One line, shown in the banner, when a photo or signature did not keep. The
  // delivery itself is saved either way -- this never blocks the run.
  const [proofNote, setProofNote] = useState<string | null>(null);
  // When the shutter fired, and where the phone said it was at that moment.
  // Both are shown on the proof screen and both are stored. null fix means the
  // phone would not give one, which the screen says rather than hiding.
  const [shotAt, setShotAt] = useState<Date | null>(null);
  const [fix, setFix] = useState<{ lat: number; lng: number; acc: number } | null>(null);

  const cur = stops.find((s) => s.id === curId) ?? null;
  const doneCount = stops.filter((s) => s.status === "done").length;

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => () => stopStream(), [stopStream]); // cleanup on unmount

  function openStop(id: number) {
    setCurId(id);
    setScreen("stop");
  }

  async function openCam() {
    setScreen("cam");
    setPhoto(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      // The <video> does not exist yet -- it renders only once realCam is true,
      // and that state has not committed. Attaching here, or in a
      // requestAnimationFrame, finds videoRef.current still null and the stream
      // is never attached: the camera light comes on, the preview stays BLACK,
      // and the shutter falls through to the simulated capture because
      // v.videoWidth is 0. Which is exactly what happened on a real iPhone on
      // 4 September. The effect below does it after the commit instead.
      setRealCam(true);
    } catch {
      setRealCam(false);
    }
  }

  // Attach the live stream once the <video> is actually in the DOM.
  //
  // Keyed on both screen and realCam because the element is conditional on
  // both. play() is called explicitly: iOS honours autoPlay for a muted inline
  // video most of the time, and silently does not when the element gains its
  // source after mount, which is precisely this case.
  useEffect(() => {
    const v = videoRef.current;
    const s = streamRef.current;
    if (screen !== "cam" || !realCam || !v || !s) return;
    if (v.srcObject !== s) v.srcObject = s;
    void v.play().catch(() => { /* a blocked play leaves the fallback visible */ });
  }, [screen, realCam]);

  function closeCam() {
    stopStream();
    setScreen("stop");
  }

  function shutter() {
    const c = document.createElement("canvas");
    c.width = 600; c.height = 800;
    const x = c.getContext("2d")!;
    const v = videoRef.current;
    if (realCam && v && v.videoWidth) {
      const cr = 600 / 800;
      let sw = v.videoWidth, sh = v.videoHeight, sx = 0, sy = 0;
      const vr = v.videoWidth / v.videoHeight;
      if (vr > cr) { sw = v.videoHeight * cr; sx = (v.videoWidth - sw) / 2; }
      else { sh = v.videoWidth / cr; sy = (v.videoHeight - sh) / 2; }
      x.drawImage(v, sx, sy, sw, sh, 0, 0, 600, 800);
    } else {
      const g = x.createLinearGradient(0, 0, 0, 800);
      g.addColorStop(0, "#e8dcc4"); g.addColorStop(1, "#cbb896");
      x.fillStyle = g; x.fillRect(0, 0, 600, 800);
      x.fillStyle = "#8a7355"; x.font = "600 34px Georgia"; x.textAlign = "center";
      x.fillText("🥖 shelf photo", 300, 390);
      x.font = "16px Inter"; x.fillText("(simulated capture)", 300, 430);
    }
    // burn a server-style stamp
    x.fillStyle = "rgba(0,0,0,.55)"; x.fillRect(0, 740, 600, 60);
    x.fillStyle = "#fff"; x.font = "500 20px Inter"; x.textAlign = "left";
    x.fillText(`Jesse's Bakery · ${cur?.name ?? ""}`, 18, 778);
    setPhoto(c.toDataURL("image/jpeg", 0.85));
    setShotAt(new Date());
    // Ask for the location at the moment of capture, not when the screen
    // renders -- by the signature screen the van may have moved, and the point
    // of the stamp is where the photo was taken.
    //
    // Fire and forget. A driver in a cool room gets no fix and must not be held
    // up waiting for one; the screen then says so rather than showing a number.
    setFix(null);
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => setFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        () => setFix(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
      );
    }
    stopStream();
    setScreen("photo");
  }

  function wstep(p: string, d: number) {
    setWaste((w) => {
      const nv = Math.max(0, (w[p] || 0) + d);
      if (nv > 0) setNil(false);
      return { ...w, [p]: nv };
    });
  }
  function toggleNil() {
    setNil((n) => {
      const next = !n;
      if (next) setWaste({});
      return next;
    });
  }

  function doCircle() {
    {
      const sid = stops.find((s) => s.id === curId)?.sid;
      if (sid) {
        const entry = { s: "circled" as const, at: new Date().toISOString(), r: reason ?? "" };
        persist({ ...record, [sid]: entry }, { [sid]: entry });
      }
    }
    setStops((ss) => ss.map((s) => (s.id === curId ? { ...s, status: "circle" } : s)));
    setScreen("run");
  }

  // Put the photo and the signature into storage, and record that they exist.
  //
  // Fired from deliver() and deliberately NOT awaited. The delivery is already
  // recorded by the time this starts; a driver in a loading dock with one bar
  // must never be held on a spinner while a 3MB photo goes up, and must never
  // lose the drop because it didn't. Anything that fails says so in the banner
  // and leaves the delivery exactly as it was.
  //
  // The signature is read from the canvas HERE, synchronously, because deliver()
  // is called from the sign screen and the canvas unmounts the moment the screen
  // changes to "done".
  const sendProof = useCallback(
    async (sid: string, sig: string | null, shot: string | null) => {
      if (!dayIso || !live) return;
      const jobs: [("photo" | "signature"), string][] = [];
      if (shot) jobs.push(["photo", shot]);
      if (sig) jobs.push(["signature", sig]);
      if (!jobs.length) return;

      const failed: string[] = [];
      for (const [kind, dataUrl] of jobs) {
        const up = await uploadProof(dataUrl, { storeId: sid, day: dayIso, kind });
        if (!up.ok) { failed.push(up.error); continue; }
        const rec = await saveDeliveryProof({
          storeId: sid, day: dayIso, kind, path: up.path, sha256: up.sha256,
          // The fix belongs to the moment the shutter fired, so it is stamped on
          // both objects for this stop -- the photo and the signature were taken
          // at the same place, seconds apart.
          lat: fix?.lat ?? null, lng: fix?.lng ?? null, accuracy: fix?.acc ?? null,
        });
        if (!rec.ok) failed.push(rec.error);
      }
      // One line, not a stack of them. The driver needs to know something did
      // not keep, not to read a log.
      setProofNote(failed.length ? failed[0] : null);
    },
    [dayIso, live, fix],
  );

  function deliver() {
    const sid = stops.find((s) => s.id === curId)?.sid;
    // Read the pad before the screen changes and unmounts it. isSigned guards
    // against storing a blank canvas as somebody's signature.
    const sig = sigRef.current && sigDrawn.current ? sigRef.current.toDataURL("image/jpeg", 0.9) : null;
    if (sid) {
      const entry = { s: "delivered" as const, at: new Date().toISOString() };
      persist({ ...record, [sid]: entry }, { [sid]: entry });
      void sendProof(sid, sig, photo);
    }
    setStops((ss) => {
      const updated = ss.map((s) => (s.id === curId ? { ...s, status: "done" as Status } : s));
      const nxt = updated.find((s) => s.status === "pending");
      return nxt ? updated.map((s) => (s.id === nxt.id ? { ...s, status: "next" as Status } : s)) : updated;
    });
    setScreen("done");
  }

  function resetForNextStop() {
    setPhoto(null); setNil(false); setWaste({}); setReason(null);
    sigDrawn.current = false;
    setScreen("run");
  }

  // signature pad — wire pointer handlers whenever the sign screen mounts
  useEffect(() => {
    if (screen !== "sign") return;
    const c = sigRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.width = r.width; c.height = r.height;
    const ctx = c.getContext("2d")!;
    ctx.strokeStyle = "#2a2019"; ctx.lineWidth = 2.4; ctx.lineCap = "round";
    let drawing = false;
    const pos = (e: MouseEvent | TouchEvent) => {
      const b = c.getBoundingClientRect();
      const t = "touches" in e ? e.touches[0] : e;
      return [t.clientX - b.left, t.clientY - b.top] as const;
    };
    const down = (e: MouseEvent | TouchEvent) => { drawing = true; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); e.preventDefault(); };
    // A blank canvas is not a signature. Without this an untouched pad would be
    // stored as proof somebody signed, which is worse than storing nothing.
    const move = (e: MouseEvent | TouchEvent) => { if (!drawing) return; sigDrawn.current = true; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); e.preventDefault(); };
    const up = () => { drawing = false; };
    c.addEventListener("mousedown", down); c.addEventListener("mousemove", move);
    c.addEventListener("mouseup", up); c.addEventListener("mouseleave", up);
    c.addEventListener("touchstart", down, { passive: false });
    c.addEventListener("touchmove", move, { passive: false });
    c.addEventListener("touchend", up);
    return () => {
      c.removeEventListener("mousedown", down); c.removeEventListener("mousemove", move);
      c.removeEventListener("mouseup", up); c.removeEventListener("mouseleave", up);
      c.removeEventListener("touchstart", down); c.removeEventListener("touchmove", move); c.removeEventListener("touchend", up);
    };
  }, [screen]);

  function clearSig() {
    const c = sigRef.current;
    if (c) c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    sigDrawn.current = false;
  }

  return (
    <div className="drvwrap">
      <div className="livenote" style={{ background: "var(--amber-b)", border: "1px solid var(--amber)", color: "var(--amber-t)", borderRadius: 10, padding: "10px 14px", margin: "0 0 12px", fontSize: 13, fontWeight: 700 }}>
        {saveErr
          ? "\u26A0 That last one did not save. Check your signal and tap it again."
          : proofNote
          ? "\u26A0 " + proofNote
          : live
          ? "Today\u2019s real runs. Deliveries, photos and signatures are all saved."
          : "\u26A0 No plan for today, so these are sample stops. Nothing you tap is saved yet."}
      </div>
      <div className="cap">Driver app · phone prototype. Live-capture only (no gallery) via the camera — grant access to see your real camera, otherwise it falls back to a simulated capture so the flow always runs.</div>
      <div className="phone">
        <div className="notch" />

        {/* START OF SHIFT — LICENCE CAPTURE */}
        {screen === "licence" && (
          <div className="screen">
            <div className="bar"><div><h1>Start your shift</h1><div className="sub">{live ? day : "Sample run"}</div></div></div>
            <div className="content">
              {driver ? (
                <div className="drv">
                  <div className="av">{driver.slice(0, 1).toUpperCase()}</div>
                  <div><div className="rn">{driver}</div><small>Signed in</small></div>
                </div>
              ) : null}
              <div className="box">
                <div className="bh">Driver licence</div>
                <div style={{ fontSize: 13.5, color: "var(--ink2)", lineHeight: 1.5, marginBottom: 12 }}>
                  Snap your licence to start your shift. One quick photo, kept on this phone for today.
                </div>
                <input ref={licRef} type="file" accept="image/*" capture="environment" onChange={onPickLicence} hidden aria-hidden="true" />
                {licence ? (
                  <div className="lic-shot">
                    {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, next/image can't optimise it */}
                    <img className="lic-img" src={licence} alt="Driver licence" />
                    <div className="lic-ok">✓ Licence captured</div>
                    <button type="button" className="lic-retake" onClick={() => licRef.current?.click()} disabled={licBusy}>Retake</button>
                  </div>
                ) : (
                  <button type="button" className="lic-add" onClick={() => licRef.current?.click()} disabled={licBusy}>
                    {licBusy ? "Working…" : "📷  Photograph licence"}
                  </button>
                )}
              </div>
            </div>
            <div className="actions">
              <button className="big" disabled={!licence} onClick={() => setScreen(live ? "pickrun" : "run")}>{licence ? "Start shift" : "Add your licence to start"}</button>
            </div>
          </div>
        )}

        {/* RUN LIST */}
        {screen === "pickrun" && (
          <div className="screen">
            <div className="bar"><div><h1>Today\u2019s runs</h1><div className="sub">{day}</div></div></div>
            <div className="content">
              <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, marginBottom: 12 }}>
                Every run is here, not just yours. Tap the one you are taking.
              </div>
              {runs.map((r) => (
                <button
                  key={r.run_id}
                  type="button"
                  className="box"
                  onClick={() => chooseRun(r)}
                  style={{ display: "block", width: "100%", textAlign: "left", cursor: "pointer", font: "inherit", marginBottom: 10 }}
                >
                  <div className="bh" style={{ marginBottom: 4 }}>{r.name}</div>
                  <div style={{ fontSize: 13, color: "var(--ink2)" }}>
                    {r.stores.length} stop{r.stores.length === 1 ? "" : "s"} · {r.units.toLocaleString()} items
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {screen === "run" && (
          <div className="screen">
            <div className="bar"><div><h1>Your run</h1><div className="sub">{runName ?? "Sample run"}{live && day ? " · " + day : " · Monday"}</div></div></div>
            <div className="content">
              {driver ? (
                <div className="drv">
                  <div className="av">{driver.slice(0, 1).toUpperCase()}</div>
                  <div><div className="rn">{driver}</div><small>On shift</small></div>
                </div>
              ) : null}
              <div className="prog"><div className="track"><div className="fill" style={{ width: `${(100 * doneCount) / stops.length}%` }} /></div><div className="lbl">{doneCount} / {stops.length}</div></div>
              {stops.map((s) => {
                const cls = s.status === "done" ? "done" : s.status === "next" ? "next" : s.status === "circle" ? "circle" : "";
                const ic = s.status === "done" ? "✓" : s.status === "circle" ? "⟲" : s.id + 1;
                return (
                  <div key={s.id} className={`stop ${cls}`} onClick={s.status === "done" ? undefined : () => openStop(s.id)}>
                    <div className="idx">{ic}</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="nm">{s.name} {s.status === "circle" && <span className="pill circle">Circle back</span>}</div>
                      <div className="ad">{s.addr}</div>
                    </div>
                    <div className="chev">{s.status === "done" ? "" : "›"}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* STOP DETAIL */}
        {screen === "stop" && cur && (
          <div className="screen">
            <div className="bar"><div className="back" onClick={() => setScreen("run")}>←</div><div><h1>{cur.name}</h1></div></div>
            <div className="content">
              <div className="addr">{cur.addr}</div>
              <div className="box"><div className="bh">Deliver to shelf</div>
                {cur.items.map((i) => <div className="li" key={i[0]}><span>{i[0]}</span><b>{i[1]}</b></div>)}
              </div>
              <div className="box"><div className="bh">Notes</div><div style={{ fontSize: 13.5, color: "var(--ink2)" }}>Shelf max 45. Merchandise front-facing, oldest to front.</div></div>
            </div>
            <div className="actions">
              <button className="big" onClick={openCam}>📷&nbsp; Take delivery photo</button>
              <button className="big ghost" onClick={() => setScreen("circle")}>Can&apos;t deliver — circle back</button>
            </div>
          </div>
        )}

        {/* CIRCLE BACK */}
        {screen === "circle" && cur && (
          <div className="screen">
            <div className="bar"><div className="back" onClick={() => setScreen("stop")}>←</div><div><h1>Can&apos;t deliver</h1><div className="sub">{cur.name}</div></div></div>
            <div className="content">
              <div className="box"><div className="bh">Why? (tap one)</div>
                <div className="chips" style={{ marginTop: 8 }}>
                  {REASONS.map((rz) => <span key={rz} className={`rchip ${reason === rz ? "on" : ""}`} onClick={() => setReason(rz)}>{rz}</span>)}
                </div>
              </div>
              <div style={{ fontSize: 13, color: "var(--ink2)", padding: "0 2px" }}>This stop stays open and moves to the end of your run so you circle back. Simona is notified it&apos;s parked.</div>
            </div>
            <div className="actions"><button className="big" onClick={doCircle}>Park &amp; circle back later</button></div>
          </div>
        )}

        {/* CAMERA */}
        {screen === "cam" && (
          <div className="screen">
            <div className="cam">
              <div className="camx" onClick={closeCam}>✕</div>
              <div className="camnote"><b>● Live capture — no gallery</b></div>
              {realCam ? (
                <video ref={videoRef} autoPlay playsInline muted />
              ) : (
                <div className="fb"><div className="ic">◉</div>Camera preview<br /><small style={{ opacity: 0.7 }}>(grant access for live camera)</small></div>
              )}
              <div className="shutwrap"><div className="shutter" onClick={shutter} /></div>
            </div>
          </div>
        )}

        {/* CONFIRM PHOTO */}
        {screen === "photo" && (
          <div className="screen">
            <div className="bar"><div className="back" onClick={openCam}>←</div><div><h1>Use this photo?</h1></div></div>
            {/* eslint-disable-next-line @next/next/no-img-element -- runtime camera data URL, not a static asset */}
            <div className="content">{photo && <img src={photo} className="thumb" style={{ height: "auto", aspectRatio: "3 / 4" }} alt="delivery" />}</div>
            <div className="actions"><button className="big green" onClick={() => setScreen("waste")}>Looks good — next</button><button className="big ghost" onClick={openCam}>Retake</button></div>
          </div>
        )}

        {/* WASTAGE */}
        {screen === "waste" && (
          <div className="screen">
            <div className="bar"><div className="back" onClick={() => setScreen("photo")}>←</div><div><h1>Wastage at shelf</h1></div></div>
            <div className="content">
              <button className={`nilbtn ${nil ? "on" : ""}`} onClick={toggleNil}>{nil ? "✓ Nil confirmed" : "✓ No wastage — nil"}</button>
              <div className="box"><div className="bh">Or count what&apos;s being pulled</div>
                {WPRODS.map((p) => (
                  <div className="step" key={p}>
                    <span className="p">{p}</span>
                    <div className="stepper">
                      <button onClick={() => wstep(p, -1)}>−</button>
                      <span className="v">{waste[p] || 0}</span>
                      <button onClick={() => wstep(p, 1)}>+</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="actions"><button className="big" onClick={() => setScreen("sign")}>Next — proof of delivery</button></div>
          </div>
        )}

        {/* SIGN */}
        {screen === "sign" && (
          <div className="screen">
            <div className="bar"><div className="back" onClick={() => setScreen("waste")}>←</div><div><h1>Proof of delivery</h1></div></div>
            <div className="content">
              {/* eslint-disable-next-line @next/next/no-img-element -- runtime camera data URL, not a static asset */}
              {photo && <img src={photo} className="thumb" alt="delivery" />}
              {/* This line used to read "7:12am · -33.89, 151.27 · ±8m · time +
                  GPS stamped" and every part of it was hardcoded. It sat under
                  a real photo claiming to be evidence of when and where the
                  drop happened, and it was the same three values at every stop
                  on every run. A stamp that is always the same is not a stamp.
                  Now it shows what was actually captured, and says plainly when
                  there is no fix rather than inventing one. */}
              <div className="meta">
                <span>🕑 {shotAt ? shotAt.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Sydney" }) : "—"}</span>
                {fix
                  ? <span>📍 {fix.lat.toFixed(4)}, {fix.lng.toFixed(4)} · ±{Math.round(fix.acc)}m</span>
                  : <span>📍 No location fix</span>}
                <span>{fix ? "✓ time + GPS stamped" : "✓ time stamped"}</span>
              </div>
              <div className="box"><div className="bh">Store signature</div>
                <canvas ref={sigRef} className="sig" />
                <div className="sighint">Receiver signs above · <a onClick={clearSig} style={{ color: "var(--crust-deep)", cursor: "pointer" }}>clear</a></div>
              </div>
            </div>
            <div className="actions"><button className="big green" onClick={deliver}>{driver ? "Confirm delivered as " + driver : "Confirm delivered"}</button></div>
          </div>
        )}

        {/* DONE */}
        {screen === "done" && (
          <div className="screen">
            <div className="done-wrap">
              <div className="ck">✓</div>
              <h3>{cur?.name} delivered</h3>
              <p>Photo, time, location &amp; signature captured.<br />On to the next stop.</p>
            </div>
            <div className="actions"><button className="big" onClick={resetForNextStop}>Continue run</button></div>
          </div>
        )}
      </div>

      <style>{`
      .drvwrap{display:flex;flex-direction:column;align-items:center;padding:8px 4px 30px}

      .drvwrap .cap{font-size:12.5px;color:var(--muted);margin-bottom:14px;text-align:center;max-width:390px;line-height:1.5}
      .drvwrap .phone{width:390px;max-width:100%;height:820px;background:var(--paper);border:11px solid #1c1610;border-radius:46px;box-shadow:0 30px 70px -20px rgba(40,25,10,.5);overflow:hidden;position:relative}
      .drvwrap .notch{position:absolute;top:0;left:50%;transform:translateX(-50%);width:130px;height:26px;background:#1c1610;border-radius:0 0 16px 16px;z-index:50}
      .drvwrap .screen{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--paper)}
      .drvwrap .bar{padding:34px 18px 12px;display:flex;align-items:center;gap:12px;background:var(--paper)}
      .drvwrap .bar .back{width:34px;height:34px;border-radius:50%;background:var(--card);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:17px;cursor:pointer;color:var(--ink2);flex:none}
      .drvwrap .bar h1{font-family:var(--serif);font-size:19px;font-weight:600;letter-spacing:-.3px}
      .drvwrap .bar .sub{font-size:12px;color:var(--muted)}
      .drvwrap .content{flex:1;overflow:auto;padding:6px 18px 16px}
      .drvwrap .content::-webkit-scrollbar{display:none}
      .drvwrap .prog{display:flex;align-items:center;gap:10px;margin:4px 0 14px}
      .drvwrap .prog .track{flex:1;height:8px;background:#e7ddca;border-radius:6px;overflow:hidden}
      .drvwrap .prog .fill{height:100%;background:var(--crust);border-radius:6px;transition:width .3s}
      .drvwrap .prog .lbl{font-size:12.5px;color:var(--ink2);font-weight:600;font-variant-numeric:tabular-nums}
      .drvwrap .stop{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:15px 16px;margin-bottom:11px;box-shadow:0 1px 2px rgba(60,45,30,.05);display:flex;align-items:center;gap:13px;cursor:pointer;transition:.15s}
      .drvwrap .stop:active{transform:scale(.99)}
      .drvwrap .stop.done{opacity:.6;cursor:default}
      .drvwrap .stop .idx{width:30px;height:30px;border-radius:50%;background:var(--surface);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:var(--ink2);flex:none}
      .drvwrap .stop.done .idx{background:var(--green);border-color:var(--green);color:#fff}
      .drvwrap .stop.next .idx{background:var(--crust);border-color:var(--crust);color:#fff}
      .drvwrap .stop.circle .idx{background:var(--amber);border-color:var(--amber);color:#fff}
      .drvwrap .stop .nm{font-weight:600;font-size:15px}
      .drvwrap .stop .ad{font-size:12.5px;color:var(--muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .drvwrap .stop .chev{margin-left:auto;color:#c9bda6;font-size:18px}
      .drvwrap .pill{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;letter-spacing:.2px}
      .drvwrap .pill.circle{background:var(--amber-b);color:var(--amber-t)}
      .drvwrap .drv{background:var(--espresso);color:#f2e9d8;border-radius:var(--r);padding:14px 16px;margin-bottom:14px;display:flex;align-items:center;gap:12px}
      .drvwrap .drv .av{width:38px;height:38px;border-radius:50%;background:#3a2c20;display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-weight:600}
      .drvwrap .drv .rn{font-weight:600;font-size:14.5px}
      .drvwrap .drv small{opacity:.7;font-size:12px;display:block}
      .drvwrap .addr{font-size:13px;color:var(--muted);margin:2px 0 16px}
      .drvwrap .box{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(60,45,30,.05)}
      .drvwrap .box .bh{font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:8px}
      .drvwrap .li{display:flex;justify-content:space-between;padding:6px 0;font-size:14px;border-bottom:1px solid var(--line2)}
      .drvwrap .li:last-child{border:none}
      .drvwrap .li b{font-variant-numeric:tabular-nums}
      .drvwrap .actions{padding:14px 18px 22px;background:var(--paper);border-top:1px solid var(--line2)}
      .drvwrap .big{display:block;width:100%;padding:15px;border:none;border-radius:14px;font-family:inherit;font-weight:700;font-size:15.5px;cursor:pointer;background:var(--espresso);color:#fff}
      .drvwrap .big:active{transform:scale(.985)}
      .drvwrap .big.green{background:var(--green)}
      .drvwrap .big.ghost{background:var(--card);color:var(--ink);border:1px solid var(--line);margin-top:9px}
      .drvwrap .big:disabled{opacity:.45;cursor:not-allowed}
      .drvwrap .lic-add{display:block;width:100%;padding:22px 15px;border:2px dashed var(--line);border-radius:14px;background:var(--surface);color:var(--ink2);font-family:inherit;font-weight:700;font-size:15px;cursor:pointer}
      .drvwrap .lic-add:disabled{opacity:.6;cursor:default}
      .drvwrap .lic-shot{display:flex;flex-direction:column;align-items:center;gap:10px}
      .drvwrap .lic-img{width:100%;max-height:200px;object-fit:cover;border-radius:12px;border:1px solid var(--line)}
      .drvwrap .lic-ok{font-size:13.5px;font-weight:700;color:var(--green-t)}
      .drvwrap .lic-retake{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 16px;font-family:inherit;font-weight:600;font-size:13px;color:var(--ink2);cursor:pointer}
      .drvwrap .cam{flex:1;background:#14100c;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}
      .drvwrap .cam video,.drvwrap .cam img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
      .drvwrap .cam .fb{color:#d8cbb4;text-align:center;padding:24px;z-index:2}
      .drvwrap .cam .fb .ic{font-size:40px;margin-bottom:10px}
      .drvwrap .camnote{position:absolute;top:44px;left:0;right:0;text-align:center;color:#fff;font-size:12px;z-index:5;text-shadow:0 1px 3px rgba(0,0,0,.6)}
      .drvwrap .camnote b{background:rgba(0,0,0,.4);padding:5px 11px;border-radius:999px}
      .drvwrap .shutwrap{position:absolute;bottom:26px;left:0;right:0;display:flex;justify-content:center;gap:20px;align-items:center;z-index:5}
      .drvwrap .shutter{width:66px;height:66px;border-radius:50%;background:#fff;border:5px solid rgba(255,255,255,.5);cursor:pointer}
      .drvwrap .shutter:active{transform:scale(.94)}
      .drvwrap .camx{position:absolute;top:40px;left:16px;color:#fff;font-size:22px;cursor:pointer;z-index:6;background:rgba(0,0,0,.35);width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center}
      .drvwrap .step{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--line2)}
      .drvwrap .step:last-child{border:none}
      .drvwrap .step .p{flex:1;font-size:14.5px;font-weight:500}
      .drvwrap .stepper{display:flex;align-items:center;gap:14px}
      .drvwrap .stepper button{width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:var(--card);font-size:18px;cursor:pointer;color:var(--ink);font-family:inherit}
      .drvwrap .stepper .v{width:22px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums}
      .drvwrap .nilbtn{width:100%;padding:13px;border:1px solid var(--green);background:var(--green-b);color:var(--green-t);border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;margin-bottom:14px;font-family:inherit}
      .drvwrap .nilbtn.on{background:var(--green);color:#fff}
      .drvwrap .thumb{width:100%;height:120px;border-radius:12px;object-fit:cover;border:1px solid var(--line);margin-bottom:6px;background:#14100c}
      .drvwrap .meta{font-size:12px;color:var(--muted);margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap}
      .drvwrap .meta span{background:var(--surface);border:1px solid var(--line2);padding:3px 9px;border-radius:999px}
      .drvwrap .sig{width:100%;height:110px;border:1px dashed #cbbfa6;border-radius:12px;background:var(--surface);cursor:crosshair;touch-action:none}
      .drvwrap .sighint{font-size:11.5px;color:var(--muted);margin:4px 0 14px}
      .drvwrap .done-wrap{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px}
      .drvwrap .done-wrap .ck{width:74px;height:74px;border-radius:50%;background:var(--green);color:#fff;display:flex;align-items:center;justify-content:center;font-size:38px;margin-bottom:18px}
      .drvwrap .done-wrap h3{font-family:var(--serif);font-size:24px;font-weight:600;margin-bottom:6px}
      .drvwrap .done-wrap p{color:var(--ink2);font-size:14px;line-height:1.5}
      .drvwrap .chips{display:flex;gap:8px;flex-wrap:wrap}
      .drvwrap .rchip{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:9px 13px;font-size:13px;cursor:pointer;font-weight:600}
      .drvwrap .rchip.on{background:var(--amber);border-color:var(--amber);color:#fff}
            /* On the device this is actually for, the app is the page. */
      @media (max-width:760px){
        .drvwrap{padding:0;display:block}
        .drvwrap .cap{display:none}
        .drvwrap .notch{display:none}
        .drvwrap .phone{
          width:100%;max-width:none;height:auto;min-height:100dvh;
          border:0;border-radius:0;box-shadow:none;position:relative
        }
        /* The screens were absolutely positioned to fill a fixed-height frame.
           With no frame they flow, and the run list scrolls the page rather
           than a box inside it. */
        .drvwrap .screen{position:static;min-height:100dvh}
        .drvwrap .content{overflow:visible}
        .drvwrap .bar{padding-top:calc(16px + env(safe-area-inset-top))}
        /* Three bands of chrome before a driver sees anything actionable: the
           page header, the banner, then the screen's own title. On a phone the
           app supplies its own heading, so the page one goes -- same as
           /packing. The banner shrinks to a line; it still has to say nothing
           is being saved, but it does not need a third of the screen. */
        .drvwrap .livenote{font-size:11.5px;padding:7px 11px;margin-bottom:10px;font-weight:600}
      }
    `}</style>
    </div>
  );
}
