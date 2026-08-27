"use server";

// NO revalidatePath in this file. See the long note in app/map/actions.ts for
// the measurement: every page here except the two prototypes is force-dynamic,
// so there is no cached server render to invalidate. All revalidatePath does is
// clear the CLIENT router cache, and the router then re-prefetches all 23
// sidebar links. One Save on /map with eight of them fired 46 requests and drew
// three 503s. Components refresh themselves — local state, a toast, or an
// explicit router.refresh().

import { q as sql } from "@/lib/db";

const CATEGORIES = new Set([
  "sourdough", "bagel", "challah", "pita", "pastry", "cake", "other",
]);

export type CreateProductLaunchInput = {
  name: string;
  category: string;
  launchedAt?: string; // YYYY-MM-DD; defaults to today
};
export type ProductActionResult = { ok: true; id?: string } | { ok: false; error: string };

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s);

// Add a new product line and tag it as a launch in one step -- the no-SQL path
// for "track this new product from day one". It appears in Launches > New
// products immediately, and fills with units/sell-through as the plan and sales
// come in.
export async function createProductLaunch(input: CreateProductLaunchInput): Promise<ProductActionResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true };
  try {
    const name = (input.name ?? "").trim();
    if (!name) return { ok: false, error: "Product name is required." };
    const category = CATEGORIES.has(input.category) ? input.category : "other";
    const date = (input.launchedAt ?? "").trim() || null; // null => today in SQL

    const existing = await sql<{ id: string }[]>`select id::text as id from products where lower(name) = lower(${name})`;
    if (existing.length) return { ok: false, error: "A product with that name already exists." };

    const rows = await sql<{ id: string }[]>`
      insert into products (name, category, active, launched_at)
      values (${name}, ${category}::product_category, true, coalesce(${date}::date, (now() at time zone 'Australia/Sydney')::date))
      returning id::text as id`;
    return { ok: true, id: rows[0].id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not add the product." };
  }
}

// Tag an existing product as a launch (set its launch date).
export async function setProductLaunch(productId: string, dateStr?: string): Promise<ProductActionResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true };
  try {
    if (!isUuid(productId)) return { ok: false, error: "Unknown product." };
    const date = (dateStr ?? "").trim() || null;
    const rows = await sql<{ id: string }[]>`
      update products
         set launched_at = coalesce(${date}::date, (now() at time zone 'Australia/Sydney')::date)
       where id = ${productId}::uuid
      returning id::text as id`;
    if (!rows.length) return { ok: false, error: "Product not found." };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not tag the launch." };
  }
}

// Stop tracking a product as a launch (clear its launch date).
export async function clearProductLaunch(productId: string): Promise<ProductActionResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true };
  try {
    if (!isUuid(productId)) return { ok: false, error: "Unknown product." };
    await sql`update products set launched_at = null where id = ${productId}::uuid`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not update the product." };
  }
}
