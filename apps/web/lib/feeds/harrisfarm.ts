/* ------------------------------------------------------------------ *
 * Harris Farm PartnerAPI.
 *
 * The one feed with no email. Until now the only way to load it was a
 * person logging into partnerhub.harrisfarm.com.au, exporting a CSV and
 * uploading it -- and for a while, a Python script in between.
 *
 * There has been an API the whole time. Fred read it out of Jesse's own
 * Azure Data Factory on 26 August and posted it: the portal is
 * partnerhub, the API is partnerapi, a different host, which is why it
 * was never visible from the portal no matter how carefully you looked.
 *
 *   POST /api/Authenticate/Login                     -> a token
 *   GET  /api/Reports/VendorSales/GetVendorSales     -> the week
 *          vendorCode      6086      (Jesse's vendor id)
 *          weekEndingDate  20260913  (YYYYMMDD, the Sunday)
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not parse the sales itself. The response is turned into a CSV
 * and handed to the same ingestWorkbook() the upload screen uses, so the
 * store and product code matching, the reject reasons, the audit row in
 * feed_uploads and the "a blank is not a zero" rule are all the ones
 * already in use. A second path to the same table is a second place for
 * the two to drift apart.
 *
 * That also means the response can come back in either shape -- wide,
 * like the portal export, with a Qty column per day; or tall, a row per
 * day -- and the parser handles both. Fred's note gave us the URL and the
 * parameters, not the response body, and this is written so that not
 * knowing it is not a blocker.
 *
 * CREDENTIALS
 *
 * Supabase secrets, never the repo -- the repo is public. Fred flagged on
 * 26 August that the Key Vault credential was created 23 Aug 2024, has no
 * expiry and has never been rotated. Nothing here logs or returns the
 * username or the password, including in an error.
 * ------------------------------------------------------------------ */

export type HarrisFarmConfig = {
  base: string;
  username: string;
  password: string;
  vendorCode: string;
};

export class HarrisFarmError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "HarrisFarmError";
    this.status = status;
  }
}

/** null when the feed is not switched on for this site. */
export function harrisFarmConfig(): HarrisFarmConfig | null {
  const username = process.env.HARRIS_FARM_USERNAME ?? "";
  const password = process.env.HARRIS_FARM_PASSWORD ?? "";
  if (!username || !password) return null;
  return {
    base: (process.env.HARRIS_FARM_BASE ?? "https://partnerapi.harrisfarm.com.au").replace(/\/+$/, ""),
    username,
    password,
    vendorCode: process.env.HARRIS_FARM_VENDOR_CODE ?? "6086",
  };
}

/** Their weeks end on a Sunday -- every value in the portal's dropdown is one.
 *  Returns the current week first, then the one before it, as YYYYMMDD.
 *  The previous week is pulled every time on purpose: a late correction to
 *  Friday is invisible if we only ever ask for the week we are standing in,
 *  and sales_daily upserts, so re-reading a settled week costs nothing. */
export function weekEndingsToPull(now: Date = new Date(), count = 2): string[] {
  const syd = new Date(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(now) + "T00:00:00Z",
  );
  // 0 = Sunday. Days forward to the coming Sunday; today if it is Sunday.
  const forward = (7 - syd.getUTCDay()) % 7;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(syd.getTime() + (forward - i * 7) * 86400_000);
    out.push(
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
    );
  }
  return out;
}

/** Pull the first string that looks like a token out of whatever came back. */
function findToken(payload: unknown): string | null {
  if (typeof payload === "string" && payload.length > 20) return payload;
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" && v && /token|jwt|bearer/i.test(k)) return v;
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") {
      const nested = findToken(v);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Log in.
 *
 * The ADF config gave the URL, not the request body, so the two ordinary
 * spellings are tried in order -- lowercase first, then Pascal, which is the
 * house style of the rest of their API (`vendorCode`, `weekEndingDate` are
 * camel; the report columns are Pascal). Two attempts, not a loop: a failed
 * login against a live vendor account should never be something this retries.
 * The first real run settles it and the second attempt can then be deleted.
 */
export async function harrisFarmToken(cfg: HarrisFarmConfig): Promise<string> {
  const url = `${cfg.base}/api/Authenticate/Login`;
  const bodies = [
    { username: cfg.username, password: cfg.password },
    { Username: cfg.username, Password: cfg.password },
  ];

  let lastStatus = 0;
  let lastBody = "";
  for (const body of bodies) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) {
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* a bare token is fine */ }
      const token = findToken(parsed);
      if (token) return token;
      throw new HarrisFarmError(
        "Harris Farm accepted the login but the reply had no field that looks like a token. " +
        `It came back with: ${describeShape(parsed)}. Nothing has been loaded.`,
        res.status,
      );
    }
    lastStatus = res.status;
    lastBody = text.slice(0, 200);
  }

  if (lastStatus === 401 || lastStatus === 403) {
    throw new HarrisFarmError(
      "Harris Farm refused the login. The credential in HARRIS_FARM_USERNAME / " +
      "HARRIS_FARM_PASSWORD is wrong, expired or has been revoked — it was created " +
      "23 Aug 2024 and has never been rotated. Nothing has been loaded.",
      lastStatus,
    );
  }
  throw new HarrisFarmError(
    `Harris Farm's login returned ${lastStatus}. ${lastBody || "No detail was given."} Nothing has been loaded.`,
    lastStatus,
  );
}

/** Names the shape of an unexpected payload without repeating its contents,
 *  because its contents may include a credential. */
function describeShape(v: unknown): string {
  if (v == null) return "nothing";
  if (Array.isArray(v)) return `a list of ${v.length}`;
  if (typeof v === "object") return `an object with ${Object.keys(v as object).join(", ") || "no fields"}`;
  return typeof v;
}

/** The first list of objects in the payload, wherever they wrapped it. */
function firstRowList(payload: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(payload)) {
    return payload.every((r) => r && typeof r === "object") ? (payload as Record<string, unknown>[]) : null;
  }
  if (!payload || typeof payload !== "object") return null;
  for (const v of Object.values(payload as Record<string, unknown>)) {
    const found = firstRowList(v);
    if (found && found.length) return found;
  }
  return null;
}

/** ingestWorkbook takes an ArrayBuffer. TextEncoder gives a Uint8Array over a
 *  possibly-shared buffer, so slice out exactly this string's bytes. */
function toArrayBuffer(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows -> CSV, keys in first-seen order across every row so a column that only
 *  appears on later rows is not silently dropped. */
export function rowsToCsv(rows: Record<string, unknown>[]): string {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const out = [cols.map(csvCell).join(",")];
  for (const r of rows) out.push(cols.map((c) => csvCell(r[c])).join(","));
  return out.join("\n");
}

/**
 * One week, as the bytes of a CSV ready for ingestWorkbook().
 *
 * The filename carries the week so the row in feed_uploads reads the way the
 * manual ones do and the two are comparable at a glance.
 */
export async function fetchVendorSalesCsv(
  cfg: HarrisFarmConfig,
  token: string,
  weekEndingDate: string,
): Promise<{ name: string; bytes: ArrayBuffer; rows: number }> {
  const url =
    `${cfg.base}/api/Reports/VendorSales/GetVendorSales` +
    `?vendorCode=${encodeURIComponent(cfg.vendorCode)}` +
    `&weekEndingDate=${encodeURIComponent(weekEndingDate)}`;

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new HarrisFarmError(
      `Harris Farm returned ${res.status} for the week ending ${weekEndingDate}. ` +
      `${text.slice(0, 200) || "No detail was given."} Nothing has been loaded for that week.`,
      res.status,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // Some vendor endpoints hand back a CSV directly. If it looks like one,
    // take it as it is rather than insisting on JSON.
    if (/[,\t].*\r?\n/.test(text)) {
      return {
        name: `harrisfarm-week-${weekEndingDate}.csv`,
        bytes: toArrayBuffer(text),
        rows: text.split(/\r?\n/).length - 1,
      };
    }
    throw new HarrisFarmError(
      `Harris Farm's reply for the week ending ${weekEndingDate} was neither JSON nor a CSV. Nothing has been loaded.`,
      res.status,
    );
  }

  const rows = firstRowList(payload);
  if (!rows || !rows.length) {
    throw new HarrisFarmError(
      `Harris Farm returned no sales rows for the week ending ${weekEndingDate} — ` +
      `the reply was ${describeShape(payload)}. Nothing has been loaded for that week.`,
      res.status,
    );
  }

  return {
    name: `harrisfarm-week-${weekEndingDate}.csv`,
    bytes: toArrayBuffer(rowsToCsv(rows)),
    rows: rows.length,
  };
}
