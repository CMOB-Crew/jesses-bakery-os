import { withUser } from "@/lib/db";
import { getMe } from "@/lib/people";
import ChangePassword from "@/components/ChangePassword";

/* ------------------------------------------------------------------ *
 * Your account.
 *
 * Open to EVERY signed-in role, including drivers and packers, which is
 * the whole point: the people most likely to be using a password
 * somebody else chose are the ones with one screen and no mailbox.
 * lib/nav-access.ts lets /account through for them for the same reason
 * it lets /auth through -- a person who cannot change their own
 * password is a person who has to ring somebody.
 * ------------------------------------------------------------------ */

export const dynamic = "force-dynamic";
export const metadata = { title: "Your account · Jesse's Bakery" };

export default async function AccountPage() {
  let me = null;
  try {
    me = await withUser(getMe);
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
    <main style={{ padding: "28px 22px" }}>
      <h1 style={{ fontSize: 23, margin: "0 0 6px" }}>Your account</h1>
      <p style={{ margin: "0 0 8px", opacity: 0.72, maxWidth: "58ch", lineHeight: 1.6 }}>
        Signed in as <strong>{me.email}</strong>
        {me.role ? <> · {me.role}</> : null}
      </p>
      <p style={{ margin: "0 0 26px", opacity: 0.72, maxWidth: "58ch", lineHeight: 1.6 }}>
        If somebody handed you your password, change it here. Nobody else can see what
        you pick, including whoever gave you the first one.
      </p>
      <ChangePassword email={me.email} />
    </main>
  );
}
