import { getAppRole } from "@/lib/app-role";
import { mayManagePeople } from "@/lib/people-rules";
import { loadPeople } from "./people-actions";
import PeoplePanel from "@/components/PeoplePanel";

/* ------------------------------------------------------------------ *
 * People.
 *
 * The screen that means the bakery does not have to ring CMOB to reset a
 * driver's password. Until 15 September that needed a terminal and the
 * service role key, so it was a CMOB job, and the Runbook said so.
 *
 * The role is read here to decide what to RENDER. It is read again,
 * from the database, inside every action -- see people-actions.ts. A
 * page-level check is not a boundary: the actions are callable directly.
 * ------------------------------------------------------------------ */

export const dynamic = "force-dynamic";
export const metadata = { title: "People · Jesse's Bakery" };

export default async function PeoplePage() {
  const role = await getAppRole();

  if (!mayManagePeople(role)) {
    return (
      <main style={{ padding: "28px 22px", maxWidth: "62ch" }}>
        <h1 style={{ fontSize: 21, margin: "0 0 10px" }}>People</h1>
        <p style={{ margin: 0, opacity: 0.75, lineHeight: 1.6 }}>
          Managing accounts is for an admin or a manager. Nothing is hidden from you
          by mistake — ask Simona or whoever holds an admin login if somebody needs
          adding, switching off, or a new password.
        </p>
      </main>
    );
  }

  const data = await loadPeople();

  if (!data.ok) {
    return (
      <main style={{ padding: "28px 22px", maxWidth: "62ch" }}>
        <h1 style={{ fontSize: 21, margin: "0 0 10px" }}>People</h1>
        <p style={{ margin: 0, opacity: 0.75, lineHeight: 1.6 }}>{data.error}</p>
      </main>
    );
  }

  return (
    <main style={{ padding: "28px 22px" }}>
      <h1 style={{ fontSize: 23, margin: "0 0 6px" }}>People</h1>
      <p style={{ margin: "0 0 22px", opacity: 0.72, maxWidth: "64ch", lineHeight: 1.6 }}>
        Everyone who can sign in. Add somebody, hand them a password, switch an account
        off when they leave. Every change here is written down — who did it, to whom,
        and when.
      </p>
      <PeoplePanel me={data.me} people={data.people} />
    </main>
  );
}
