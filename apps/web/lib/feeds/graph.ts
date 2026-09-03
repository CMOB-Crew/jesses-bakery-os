import "server-only";

// ---------------------------------------------------------------------------
// Microsoft Graph, read-only, for one job: fetch the morning sales reports out
// of Jesse's mailbox so nobody has to forward them by hand.
//
// The app registration is "Jesse's Bakery Sales Ingest" in Jesse's tenant, with
// Mail.Read (application) and an App RBAC scope restricting it to accounts@ and
// systemadmin@ and nothing else in the tenant. Application permissions, not
// delegated: there is no signed-in user at 9am.
//
// CREDENTIALS LIVE IN THE ENVIRONMENT, NEVER IN THIS REPO. The repo is public.
// Set them in Netlify (live scope):
//   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, FEED_MAILBOX
//
// THE CLIENT SECRET EXPIRES 01/09/2028. When it lapses this stops and nothing
// announces it -- the feed just quietly goes stale, which is the exact failure
// mode that let Coles report Success 259,303 times into silence. isStale on the
// /feeds page is what catches it; this file only makes the noise honest.
// ---------------------------------------------------------------------------

const GRAPH = "https://graph.microsoft.com/v1.0";

export type GraphConfig = { tenant: string; clientId: string; secret: string; mailbox: string };

/** Null rather than throwing when unset, so a deployment without the app
 *  registration degrades to manual upload instead of erroring. Mirrors
 *  supabaseAdmin(). */
export function graphConfig(): GraphConfig | null {
  const tenant = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const secret = process.env.GRAPH_CLIENT_SECRET;
  // accounts@ is the only mailbox that receives BOTH feeds. systemadmin@ is not
  // on the Coles Power BI subscription -- see the 2 Sept mailbox measurement.
  // Defaulted rather than required so a missing var cannot silently poll the
  // wrong mailbox and report "no mail" forever.
  const mailbox = process.env.FEED_MAILBOX || "accounts@jessesbakery.com.au";
  if (!tenant || !clientId || !secret) return null;
  return { tenant, clientId, secret, mailbox };
}

export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "GraphError";
  }
}

/** Say what actually went wrong, in words that point at the fix.
 *
 *  The two failures that will actually happen here are consent never being
 *  granted and the 2028 secret lapsing, and Azure's own messages for both are
 *  opaque enough that someone would go looking in the wrong place. */
function explain(status: number, code: string, raw: string): string {
  if (code === "Authorization_RequestDenied" || status === 403) {
    return "Microsoft refused the request. The most likely cause is that admin consent for Mail.Read was never granted, or the mailbox is outside the app's allowed scope. Simona holds Global Administrator and can grant it.";
  }
  if (code === "InvalidAuthenticationToken" || status === 401) {
    return "Microsoft rejected our credentials. If this started on its own, the client secret has expired -- it was set to lapse 01/09/2028 and renewing it takes two minutes in the portal.";
  }
  if (code === "ResourceNotFound" || status === 404) {
    return "That mailbox does not exist, or the app is not scoped to it. FEED_MAILBOX should be accounts@jessesbakery.com.au.";
  }
  if (status === 429) {
    return "Microsoft is rate-limiting us. Nothing is wrong; the next run will pick these up.";
  }
  return `Microsoft Graph returned ${status}. ${raw.slice(0, 300)}`;
}

async function graphFail(res: Response): Promise<GraphError> {
  const raw = await res.text().catch(() => "");
  let code = "";
  try {
    code = String((JSON.parse(raw) as { error?: { code?: string } })?.error?.code ?? "");
  } catch { /* not JSON; the status still carries the meaning */ }
  return new GraphError(explain(res.status, code, raw), res.status, code);
}

/** Client-credentials token. Not cached: this runs a few times a day, and a
 *  cache that outlives a deploy is a way to keep using a secret that has been
 *  rotated. */
export async function graphToken(cfg: GraphConfig): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.secret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
      cache: "no-store",
    },
  );
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // The token endpoint speaks AADSTS codes rather than Graph codes.
    if (/AADSTS7000215|invalid_client/i.test(raw)) {
      throw new GraphError(
        "Microsoft rejected the client secret. If this began on its own, it has expired -- it was set to lapse 01/09/2028.",
        401, "invalid_client",
      );
    }
    if (/AADSTS700016|unauthorized_client/i.test(raw)) {
      throw new GraphError(
        "Microsoft does not recognise this application in that tenant. Check GRAPH_CLIENT_ID and GRAPH_TENANT_ID.",
        401, "unauthorized_client",
      );
    }
    throw new GraphError(`Could not get a token from Microsoft (${res.status}).`, res.status);
  }
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new GraphError("Microsoft returned no access token.", 502);
  return j.access_token;
}

export type MailMessage = {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  hasAttachments: boolean;
};

/** Messages with attachments received since `sinceIso`, newest first.
 *
 *  Filtering is deliberately coarse here -- received date and hasAttachments
 *  only -- and the sender/subject matching happens in TypeScript against the
 *  rules in mailbox.ts. Graph's $filter on from/emailAddress/address combined
 *  with $orderby is fragile across mailbox types, and a filter that silently
 *  matches nothing looks exactly like a quiet morning. Better to pull the
 *  handful of messages and decide here, where the decision is testable. */
export async function listMessages(
  cfg: GraphConfig, token: string, sinceIso: string, top = 40,
): Promise<MailMessage[]> {
  const url =
    `${GRAPH}/users/${encodeURIComponent(cfg.mailbox)}/messages` +
    `?$select=id,subject,from,receivedDateTime,hasAttachments` +
    `&$filter=${encodeURIComponent(`hasAttachments eq true and receivedDateTime ge ${sinceIso}`)}` +
    `&$orderby=${encodeURIComponent("receivedDateTime desc")}` +
    `&$top=${top}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw await graphFail(res);
  const j = (await res.json()) as {
    value?: Array<{
      id: string; subject?: string; receivedDateTime?: string; hasAttachments?: boolean;
      from?: { emailAddress?: { address?: string } };
    }>;
  };
  return (j.value ?? []).map((m) => ({
    id: m.id,
    subject: m.subject ?? "",
    from: (m.from?.emailAddress?.address ?? "").toLowerCase(),
    receivedAt: m.receivedDateTime ?? "",
    hasAttachments: Boolean(m.hasAttachments),
  }));
}

export type MailAttachment = { id: string; name: string; size: number; contentType: string };

/** File attachments on a message, without their bytes.
 *
 *  $select excludes contentBytes on purpose: the Woolworths workbook is 4.9MB,
 *  which is 6.5MB once base64'd, and pulling that into a listing we only use to
 *  choose a file would be a needless copy in a function that has already been
 *  killed once for memory on this exact attachment. */
export async function listAttachments(
  cfg: GraphConfig, token: string, messageId: string,
): Promise<MailAttachment[]> {
  const url =
    `${GRAPH}/users/${encodeURIComponent(cfg.mailbox)}/messages/${encodeURIComponent(messageId)}` +
    `/attachments?$select=id,name,size,contentType`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw await graphFail(res);
  const j = (await res.json()) as {
    value?: Array<{ id: string; name?: string; size?: number; contentType?: string }>;
  };
  return (j.value ?? []).map((a) => ({
    id: a.id,
    name: a.name ?? "",
    size: Number(a.size ?? 0),
    contentType: a.contentType ?? "",
  }));
}

/** The attachment's raw bytes.
 *
 *  /$value rather than reading contentBytes off the JSON: same file, no base64
 *  round trip. Netlify caps an inbound REQUEST body at 4.5 MiB, which is why
 *  the browser upload needed a signed-URL detour, but an outbound fetch has no
 *  such ceiling -- so the 4.9MB Woolworths workbook comes down this path
 *  without any of that machinery. */
export async function downloadAttachment(
  cfg: GraphConfig, token: string, messageId: string, attachmentId: string,
): Promise<ArrayBuffer> {
  const url =
    `${GRAPH}/users/${encodeURIComponent(cfg.mailbox)}/messages/${encodeURIComponent(messageId)}` +
    `/attachments/${encodeURIComponent(attachmentId)}/$value`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw await graphFail(res);
  return await res.arrayBuffer();
}
