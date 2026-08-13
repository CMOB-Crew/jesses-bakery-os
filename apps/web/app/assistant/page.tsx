import AssistantBoard, { type AssistantFacts } from "@/components/AssistantBoard";
import { getNetwork, getEngineProjection } from "@/lib/queries";

export const metadata = { title: "Assistant · Jesse's Bakery OS" };
export const revalidate = 120; // cache the fact-card numbers ~2 min

async function loadFacts(): Promise<AssistantFacts> {
  try {
    const [net, scenarios] = await Promise.all([getNetwork(), getEngineProjection()]);
    const balanced = scenarios.find((s) => s.scenario === "balanced");
    return {
      wastePct: net.waste_pct == null ? null : Number(net.waste_pct),
      storesAttention: (Number(net.red) || 0) + (Number(net.amber) || 0),
      savedWk: balanced ? Number(balanced.units_saved_wk) || 0 : null,
    };
  } catch {
    // No feed yet — the card shows em dashes rather than crashing the page.
    return null;
  }
}

export default async function AssistantPage() {
  const facts = await loadFacts();
  return (
    <>
      <div className="head"><h1>Assistant</h1><div className="meta">Your bakery, on tap</div></div>
      <AssistantBoard facts={facts} />
    </>
  );
}
