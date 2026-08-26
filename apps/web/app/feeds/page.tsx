import { getFeedHealth, getFeedUploads } from "@/lib/queries";
import FeedUpload from "@/components/FeedUpload";

export const dynamic = "force-dynamic";

const RETAILER: Record<string, string> = {
  woolworths: "Woolworths", coles: "Coles", harris_farm: "Harris Farm", invoice: "Invoice customers",
};
const STATUS_LABEL: Record<string, string> = { ok: "Up to date", late: "Running late", stopped: "Stopped" };

const nf = (n: number | string) => (Number(n) || 0).toLocaleString("en-AU");
const fmtDay = (d: string | null) =>
  d ? new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short" }).format(new Date(d)) : "—";
const fmtWhen = (d: string | null) =>
  d ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(d)) : "—";

export default async function FeedsPage() {
  const [health, uploads] = await Promise.all([getFeedHealth(), getFeedUploads()]);
  const stopped = health.filter((h) => h.status === "stopped");

  return (
    <>
      <div className="head">
        <h1>Sales feeds</h1>
        <div className="meta">where the retailers&apos; numbers come in</div>
      </div>

      {/* The one thing their system could not do. Every row in Jesse's ETL log
          says Success — including the three weeks Coles was writing nothing. So
          this page opens with freshness, not with an upload box. */}
      <div className="fh">
        {health.map((h) => (
          <div key={h.retailer} className={`fh-c ${h.status}`}>
            <div className="fh-r">{RETAILER[h.retailer] ?? h.retailer}</div>
            <div className="fh-d">{h.days_behind <= 0 ? "Today" : `${nf(h.days_behind)} ${h.days_behind === 1 ? "day" : "days"} behind`}</div>
            <div className="fh-s"><span className="dot" />{STATUS_LABEL[h.status] ?? h.status}</div>
            <div className="fh-l">Last sales {fmtDay(h.last_sale)}</div>
          </div>
        ))}
        {health.length === 0 && <div className="fh-none">No sales loaded yet.</div>}
      </div>

      {stopped.length > 0 && (
        <div className="fstop">
          <b>
            {stopped.map((s) => RETAILER[s.retailer] ?? s.retailer).join(" and ")}{" "}
            {stopped.length === 1 ? "has" : "have"} stopped reporting.
          </b>{" "}
          Every waste, sell-through and lost-sales figure for those stores is frozen at the
          last day we received. They are not performing badly — we cannot see them at all.
          Upload the latest report below and they come back.
        </div>
      )}

      <div className="sh-top" style={{ marginTop: 26 }}>
        <h3>Upload a Coles report</h3>
      </div>
      <FeedUpload />

      <div className="sh-top" style={{ marginTop: 30 }}>
        <h3>Recent uploads</h3>
      </div>
      {uploads.length === 0 ? (
        <div className="fh-none">Nothing uploaded yet — the history of every file lands here.</div>
      ) : (
        <table className="ftab">
          <thead>
            <tr>
              <th>File</th><th>Covering</th><th className="r">Read</th>
              <th className="r">Loaded</th><th className="r">Not loaded</th><th>When</th>
            </tr>
          </thead>
          <tbody>
            {uploads.map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.filename}</b>
                  <small>{RETAILER[u.retailer] ?? u.retailer}{u.status === "failed" ? ` · failed: ${u.error ?? "unknown error"}` : ""}</small>
                </td>
                <td>{u.period_from ? `${fmtDay(u.period_from)} → ${fmtDay(u.period_to)}` : "—"}</td>
                <td className="r">{nf(u.rows_read)}</td>
                <td className="r"><b>{nf(u.rows_loaded)}</b></td>
                <td className={`r${Number(u.rows_rejected) > 0 ? " warn" : ""}`}>{nf(u.rows_rejected)}</td>
                <td>{fmtWhen(u.uploaded_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <style>{`
        .fh{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:14px}
        .fh-c{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--green);border-radius:var(--r);padding:14px 16px;box-shadow:var(--sh)}
        .fh-c.late{border-left-color:var(--amber)}
        .fh-c.stopped{border-left-color:var(--red)}
        .fh-c .fh-r{font-weight:600;font-size:13.5px}
        .fh-c .fh-d{font-family:var(--serif);font-size:22px;font-weight:600;letter-spacing:-.3px;margin-top:6px}
        .fh-c .fh-s{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ink2);margin-top:6px}
        .fh-c .dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex:none}
        .fh-c.late .dot{background:var(--amber)} .fh-c.stopped .dot{background:var(--red)}
        .fh-c .fh-l{font-size:11.5px;color:var(--muted);margin-top:4px}
        .fh-none{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px;font-size:13px;color:var(--muted)}

        .fstop{background:var(--red-b);border:1px solid #eab9a8;border-left:3px solid var(--red);color:var(--red-t);border-radius:11px;padding:12px 15px;font-size:13.5px;line-height:1.6;margin-bottom:6px}
        .fstop b{color:var(--red-t)}

        .ftab{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;box-shadow:var(--sh)}
        .ftab td small{display:block;color:var(--muted);font-weight:400;font-size:11.5px;margin-top:2px}
        .ftab .r{text-align:right;font-variant-numeric:tabular-nums}
        .ftab .warn{color:var(--amber-t);font-weight:700}
      `}</style>
    </>
  );
}
