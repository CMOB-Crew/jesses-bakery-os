"use server";

import { sql } from "@/lib/db";
import { revalidatePath } from "next/cache";

// Retailer ids used by the New store form -> the DB retailer_type enum.
const RETAILER_MAP: Record<string, string> = {
  woolworths: "woolworths", coles: "coles", harris_farm: "harris_farm", direct: "invoice",
};
const SIZES = new Set(["small", "medium", "large", "xlarge"]);

export type CreateStoreInput = {
  name: string;
  retailer: string;      // form id (woolworths | coles | harris_farm | direct)
  region: string;        // display label from the form
  storeNo?: string;      // supplier / location code
  size: string;          // small | medium | large | xlarge
  cap?: number;          // shelf_max
  timing: "upcoming" | "live";
  goLiveDate?: string;   // YYYY-MM-DD (planned go-live when upcoming; actual when live)
};
export type CreateStoreResult = { ok: true; id: string } | { ok: false; error: string };

// Create a store from the New store form. "upcoming" seeds it inactive with a
// planned go-live (go_live_at) so it lands in Launches > Coming up; "live" marks
// it active with an onboarded_at so it lands in Launches > Live now. This is the
// no-SQL path for adding a rollout.
export async function createStore(input: CreateStoreInput): Promise<CreateStoreResult> {
  try {
    const name = (input.name ?? "").trim();
    if (!name) return { ok: false, error: "Store name is required." };

    const retailer = RETAILER_MAP[input.retailer];
    if (!retailer) return { ok: false, error: "Pick a retailer." };

    const size = SIZES.has(input.size) ? input.size : "small";
    const cap = Number.isFinite(input.cap) && (input.cap as number) > 0 ? Math.round(input.cap as number) : null;
    const storeNo = (input.storeNo ?? "").trim() || null;
    const live = input.timing === "live";
    const date = (input.goLiveDate ?? "").trim() || null; // null date + live => defaults to today in SQL

    if (!live && !date) return { ok: false, error: "Set a planned go-live date, or choose 'Go live now'." };

    // Match the form's region label to a real region: exact name first, else a
    // loose match on the leading word ("Canberra / ACT" -> CANBERRA). Unmatched
    // (e.g. a QLD region not yet in the DB) leaves region_id null.
    const token = (input.region ?? "").split("/")[0].trim().split(/\s+/)[0] || "";

    const rows = await sql<{ id: string }[]>`
      insert into stores
        (name, retailer, region_id, supplier_code, size_category, shelf_max, active, go_live_at, onboarded_at)
      values (
        ${name},
        ${retailer}::retailer_type,
        (select id from regions
           where upper(name) = upper(${input.region ?? ""})
              or (${token} <> '' and name ilike ${"%" + token + "%"})
           order by name limit 1),
        ${storeNo},
        ${size}::store_size,
        ${cap},
        ${live},
        (case when ${live} then null else ${date}::date end),
        (case when ${live} then coalesce(${date}::date, current_date) else null end)
      )
      returning id::text as id`;

    revalidatePath("/launches");
    revalidatePath("/archive");
    revalidatePath("/stores");
    return { ok: true, id: rows[0].id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not create the store.";
    return { ok: false, error: msg };
  }
}
