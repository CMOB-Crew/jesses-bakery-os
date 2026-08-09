import type { Status } from "@/lib/queries";

const ICON: Record<Status, string> = { red: "●", amber: "▲", green: "✓" };
const LABEL: Record<Status, string> = { red: "Needs attention", amber: "Watch", green: "On track" };

// Status is always colour + icon + label — never colour alone (colour-blind safe).
export default function StatusTag({ status }: { status: Status }) {
  return <span className={`tag ${status}`}>{ICON[status]} {LABEL[status]}</span>;
}
