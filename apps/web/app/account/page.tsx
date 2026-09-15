import { withUser } from "@/lib/db";
import { getMe, myEvents, type AdminEvent } from "@/lib/people";
import ChangePassword from "@/components/ChangePassword";
import ChangeName from "@/components/ChangeName";

/* ------------------------------------------------------------------ *
 * Your account.
 *
 * Open to EVERY signed-in role, including drivers and packers, which is
 * the whole point: the people most likely to be using a password
 * somebody else chose are the ones with one screen and no mailbox.
 * lib/nav-access.ts lets /account through for them for the same reason
 * it lets /auth through -- a person who cannot change their own
 * password is a person who has to ring somebody.
 *
 * Three things, and nothing else. A profile page fills up with
 * decoration very easily; each of these earns its place:
 *
 *   YOUR NAME       ends up on the delivery receipt a retailer sees
 *   YOUR PASSWORD   the only way to stop using one somebody read out
 *   WHAT WAS DONE   the first thing that reads user_admin_events at all
 * ------------------------------------------------------------------ */

export const dynamic = "force-dynamic";
export const metadata = { title: "Your account · Jesse's Bakery" };

const WORDING: Record<string, string> = {
  created: "account created",
  password_reset: "password reset",
  password_changed: "password changed",
  deactivated: "account switched off",
  reactivated: "account switched back on",
  role_changed: "role changed",
};

function said(e: AdminEvent, myEmail: string): string {
  const what = WORDING[e.action] ?? e.action;
  const who = e.actor_email === myEmail ? "you" : e.actor_email;
  const detail =
    e.action === "role_changed" && e.detail && e.detail.to
      ? ` to ${String(e.detail.to)}`
      : "";
  return `${what}${detail} · by ${who}`;
}

const H2 = { fontSize: 18, margin: "0 0 4px" } as const;
const LEDE = { margin: "0 0 16px", opacity: 0.72, maxWidth: "58ch", lineHeight: 1.6 } as const;

export default async function AccountPage() {
  let me = null;
  let events: AdminEvent[] = [];
  try {
    const got = await withUser(async () => {
      const m = await getMe();
      return { m, e: m ? await myEvents() : [] };
    });
    me = got.m;
    events = got.e;
  } catch {
    me = null;
  }

  if (!me) {
    return (
      <main style={{ padding: "28px 22px", maxWidth: "58ch" }}>
        <h1 style={{ fontSize: 22, margin: "0 0 10px" }}>Your account</h1>
        <p style={{ margin: 0, opacity: 0.75, lineHeight: 1.6 }}>
          We could not work out who you are signed in as. Sign out and back in, and if
          it happens again tell Javonte — it is worth knowing about.
        </p>
      </main>
    );
  }

  return (
    <main style={{ padding: "28px 22px", display: "flex", flexDirection: "column", gap: 34 }}>
      <div>
        <h1 style={{ fontSize: 23, margin: "0 0 6px" }}>Your account</h1>
        <p style={{ margin: 0, opacity: 0.72, maxWidth: "58ch", lineHeight: 1.6 }}>
          Signed in as <strong>{me.email}</strong>
          {me.role ? <> · {me.role}</> : null}
        </p>
      </div>

      <section>
        <h2 style={H2}>Your name</h2>
        <p style={LEDE}>
          Deliveries are signed with your name rather than your login, so this is what a
          store sees if they ever query a drop.
        </p>
        <ChangeName current={me.full_name} />
      </section>

      <section>
        <h2 style={H2}>Your password</h2>
        <p style={LEDE}>
          If somebody handed you your password, change it here. Nobody else can see what
          you pick, including whoever gave you the first one.
        </p>
        <ChangePassword email={me.email} />
      </section>

      <section>
        <h2 style={H2}>What has been done to your account</h2>
        <p style={LEDE}>
          Anybody creating your account, resetting your password, switching you off or
          changing your role leaves a line here. Yours only — you cannot see anybody
          else&apos;s, and they cannot see yours.
        </p>
        {events.length === 0 ? (
          <p style={{ margin: 0, opacity: 0.6, fontSize: 14 }}>
            Nothing yet. Anything from here on will be listed.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, maxWidth: "58ch" }}>
            {events.map((e, i) => (
              <li
                key={`${e.at}-${i}`}
                style={{
                  padding: "10px 0",
                  borderBottom: i === events.length - 1 ? "none" : "1px solid rgba(128,128,128,.2)",
                  fontSize: 14,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 16,
                  flexWrap: "wrap",
                }}
              >
                <span>{said(e, me.email)}</span>
                <span style={{ opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>
                  {e.at.slice(0, 16).replace("T", " ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
