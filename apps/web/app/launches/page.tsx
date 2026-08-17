import { getLaunches } from "@/lib/queries";
import LaunchesView from "@/components/Launches";

export const metadata = { title: "Launches · Jesse's Bakery OS" };
export const revalidate = 120;

export default async function LaunchesPage() {
  const launches = await getLaunches();
  return (
    <>
      <div className="head">
        <h1>Launches</h1>
        <div className="meta">New store rollouts, tracked from day one</div>
      </div>
      <LaunchesView launches={launches} />
    </>
  );
}
