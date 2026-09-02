import { withUser } from "@/lib/db";
import NewRunSetup from "@/components/NewRunSetup";
import { getRunsWithCounts } from "@/lib/queries";

export const metadata = { title: "New run · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. See the
// note in app/new-store/page.tsx.
export const maxDuration = 60;

export default async function NewRunPage() {
  const runs = await withUser(() => getRunsWithCounts());
  return (
    <>
      <div className="head">
        <h1>New run</h1>
        <div className="meta">A run has to exist before a store can be put on it</div>
      </div>
      <NewRunSetup runs={runs} />
    </>
  );
}
