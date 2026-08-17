import type { Status } from "@/lib/queries";

// "nodata" is a store/region with no loaded feed yet (nothing delivered or sold)
// — neutral, explicitly NOT "on track".
export type TagKind = Status | "nodata";
const ICON: Record<TagKind, string> = { red: "●", amber: "▲", green: "✓", nodata: "◦" };
const LABEL: Record<TagKind, string> = { red: "Needs attention", amber: "Watch", green: "On track", nodata: "No data" };

// Status is always colour + icon + label — never colour alone (colour-blind safe).
export default function StatusTag({ status }: { status: TagKind }) {
  return <span className={`tag ${status}`}>{ICON[status]} {LABEL[status]}</span>;
}
