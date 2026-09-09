import type { Status } from "@/lib/queries";

// Two different kinds of "we cannot score this", and they are not the same
// problem. "nodata" means the retailer's sales report has not reached us --
// chase the retailer. "nodelivery" means the sales ARE arriving and what is
// missing is our own delivery record -- nothing to chase, it fills in as the
// drivers confirm. Both neutral, both explicitly NOT "on track".
//
// They were one tag until 9 September, when every delivery run on the Overview
// read "No data · 20 awaiting feed" on a morning when all three feeds were
// current to the day before.
export type TagKind = Status | "nodata" | "nodelivery";
const ICON: Record<TagKind, string> = { red: "●", amber: "▲", green: "✓", nodata: "◦", nodelivery: "◦" };
const LABEL: Record<TagKind, string> = { red: "Needs attention", amber: "Watch", green: "On track", nodata: "No data", nodelivery: "No delivery yet" };

// Status is always colour + icon + label — never colour alone (colour-blind safe).
export default function StatusTag({ status }: { status: TagKind }) {
  return <span className={`tag ${status}`}>{ICON[status]} {LABEL[status]}</span>;
}
