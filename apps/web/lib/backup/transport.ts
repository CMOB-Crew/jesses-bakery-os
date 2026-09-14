import "server-only";
import { graphConfig, graphToken, GraphError } from "@/lib/feeds/graph";
import { r2Config, r2Missing, putObject, contentTypeFor } from "@/lib/r2";
import type { BackupTransport } from "./sync";

/* ------------------------------------------------------------------ *
 * Where the photographs go.
 *
 * THIS FILE IS THE UNTESTED SURFACE, AND IT IS DELIBERATELY SMALL.
 *
 * Everything in lib/backup/sync.ts is asserted against fakes in
 * scripts/backup-sync-check.ts with no credentials and no network. What
 * cannot be asserted is a real PUT into Jesse's SharePoint, because that
 * needs a consent only Jesse can grant. So the untestable part is ONE
 * function of a dozen lines rather than logic spread through the module, and
 * the seam it sits behind is the thing the checks exercise.
 *
 * WHY SHAREPOINT AND NOT R2
 *
 * Both were live on 14 September. R2 needs a card on file even on the free
 * tier, because usage is not hard-capped -- a commercial step on a client's
 * account, and no CMOB card goes on one. SharePoint needs one admin consent
 * and it is storage they already pay for. @Fred agreed at 12:37 and had
 * already added Sites.Selected to the app registration.
 *
 * He also found that SharePoint is not merely available, it is IN USE: three
 * operational sites, and the legacy Function Apps already publish to it via
 * Graph. That is cutover scope that was on no list.
 *
 * The R2 transport stays because the signer already shipped (4543450) and is
 * asserted against AWS's own published test vectors. It costs nothing to keep
 * and it is the fallback if the consent stalls.
 *
 * THE SECRET IS THE FAILURE MODE, NOT THE NETWORK
 *
 * @Fred, and he is right: "The secret on this app expires and when it does
 * the backup silently stops - same way TriggerForecastRefreshADF died." Four
 * of the eight app registrations in Jesse's tenant already have expired
 * secrets, and this one is recorded as expiring 01/09/2028.
 *
 * A certificate instead of a secret is the real answer and it is not built
 * here. What IS built is the half that makes the failure loud rather than
 * silent: graphToken already names an expired secret specifically rather than
 * returning a bare 401, and backup_runs records every attempt so a backup
 * that has stopped cannot look like one with nothing to do. See
 * stalenessVerdict in ./sync.
 * ------------------------------------------------------------------ */

export type SharePointConfig = {
  /** The site holding the Backups library. Sites.Selected scopes the app to
   *  this one site and nothing else in the tenant. */
  siteId: string;
  /** The document library. Named rather than looked up, so a renamed library
   *  fails loudly instead of writing into whichever drive came back first. */
  driveId: string;
};

/** null when the backup is not switched on. Never throws: an unconsented app
 *  is a configuration state, not an error, and the caller says so in words
 *  rather than crashing a weekly job. Mirrors r2Config(). */
export function sharePointConfig(): SharePointConfig | null {
  const siteId = process.env.BACKUP_SHAREPOINT_SITE_ID ?? "";
  const driveId = process.env.BACKUP_SHAREPOINT_DRIVE_ID ?? "";
  if (!siteId || !driveId) return null;
  // The Graph app registration itself is shared with the mail feed, so if
  // that is unset this cannot work either.
  if (!graphConfig()) return null;
  return { siteId, driveId };
}

/** Which names are missing, for a message a person can act on. Names only,
 *  never values. */
export function sharePointMissing(): string[] {
  const missing = ([
    ["BACKUP_SHAREPOINT_SITE_ID", process.env.BACKUP_SHAREPOINT_SITE_ID],
    ["BACKUP_SHAREPOINT_DRIVE_ID", process.env.BACKUP_SHAREPOINT_DRIVE_ID],
    ["GRAPH_TENANT_ID", process.env.GRAPH_TENANT_ID],
    ["GRAPH_CLIENT_ID", process.env.GRAPH_CLIENT_ID],
    ["GRAPH_CLIENT_SECRET", process.env.GRAPH_CLIENT_SECRET],
  ] as const).filter(([, v]) => !v).map(([k]) => k);
  return missing;
}

/**
 * One PUT per file. 56 kB an object, so no upload sessions -- Graph's simple
 * upload covers anything under 250 MB and an upload session for a photograph
 * would be three round trips to save nothing.
 *
 * The path is percent-encoded segment by segment rather than whole, because
 * the colons in Graph's addressing syntax are structural and encoding them
 * breaks the URL. A storage path is our own generated UUIDs today, but
 * encoding it is what stops that being load-bearing.
 */
export function sharePointTransport(cfg: SharePointConfig): BackupTransport {
  return {
    name: "sharepoint",
    async put(remotePath, bytes, contentType) {
      const gcfg = graphConfig();
      if (!gcfg) throw new GraphError("The Graph app registration is not configured.", 500);
      const token = await graphToken(gcfg);

      const encoded = remotePath.split("/").map(encodeURIComponent).join("/");
      const url =
        `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(cfg.siteId)}` +
        `/drives/${encodeURIComponent(cfg.driveId)}/root:/${encoded}:/content`;

      const res = await fetch(url, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        body: bytes as unknown as BodyInit,
        cache: "no-store",
      });

      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        // Named specifically, because these three are the ones that will
        // actually happen and they are indistinguishable in a bare status.
        if (res.status === 403) {
          throw new GraphError(
            "SharePoint refused the write. Either Jesse has not granted consent on Sites.Selected, " +
            "or the app has not been granted write on this site (POST /sites/{id}/permissions).",
            403,
          );
        }
        if (res.status === 404) {
          throw new GraphError(
            "That site or drive does not exist. Check BACKUP_SHAREPOINT_SITE_ID and " +
            "BACKUP_SHAREPOINT_DRIVE_ID — a renamed library changes the drive id.",
            404,
          );
        }
        throw new GraphError(
          `SharePoint rejected the upload (${res.status}). ${raw.slice(0, 200)}`,
          res.status,
        );
      }
    },
  };
}

/** The R2 fallback, on the signer that shipped 12 September. */
export function r2Transport(): BackupTransport | null {
  const cfg = r2Config();
  if (!cfg) return null;
  return {
    name: "r2",
    async put(remotePath, bytes) {
      await putObject({ cfg, key: remotePath, body: Buffer.from(bytes), contentType: contentTypeFor(remotePath) });
    },
  };
}

export type TransportChoice =
  | { transport: BackupTransport; why: string }
  | { transport: null; why: string; missing: string[] };

/**
 * Which destination this deployment writes to.
 *
 * SharePoint first because it is the decision; R2 second because its signer
 * exists and works. Neither configured is reported in words rather than as a
 * crash, because "the backup is not switched on yet" is the true state today
 * and a weekly job should say that plainly, not fail.
 */
export function chooseTransport(): TransportChoice {
  const sp = sharePointConfig();
  if (sp) return { transport: sharePointTransport(sp), why: "SharePoint, the agreed destination" };

  const r2 = r2Transport();
  if (r2) return { transport: r2, why: "Cloudflare R2, the fallback — SharePoint is not configured" };

  return {
    transport: null,
    why:
      "No backup destination is configured, so nothing is being copied anywhere. " +
      "This is the true state until Jesse grants consent on Sites.Selected and the Backups library exists.",
    missing: [...sharePointMissing(), ...r2Missing()],
  };
}
