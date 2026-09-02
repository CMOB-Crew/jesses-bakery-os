"use server";

// NO revalidatePath in this file. See the long note in app/map/actions.ts for
// the measurement: every page here except the two prototypes is force-dynamic,
// so there is no cached server render to invalidate. All revalidatePath does is
// clear the CLIENT router cache, and the router then re-prefetches all 23
// sidebar links. One Save on /map with eight of them fired 46 requests and drew
// three 503s. Components refresh themselves — local state, a toast, or an
// explicit router.refresh().

import { q as sql } from "@/lib/db";

// ---------------------------------------------------------------------------
// New product. Section 9 of the 1 Sept call, triggered by a live need:
//
//   "I had this conversation yesterday with Woolies Metro, and they want us to
//    make a new product for this."
//
// WHY THE EXISTING BUTTON IS NOT ENOUGH. /products already has "+ New product
// launch", and it writes exactly three columns: name, category, launched_at.
// It leaves NULL in every column that makes a product work:
//
//   coles_code / woolworths_code / harris_farm_code
//       The feed loader (migration 039, jb_load_feed_upload) resolves a sales
//       row to a product ONLY through these. A product with no article number
//       never matches a Coles or Woolworths line, so it records no sales, so
//       the engine has nothing to forecast from. It is invisible to the plan in
//       exactly the way a store with no run was invisible — same class of bug.
//   baking_uom / baking_qty
//       Production sheets divide by these. A tray product with no tray size
//       cannot be turned into trays to bake.
//   pack_size
//       A retailer sales qty of 1 means one SOLD unit, which for a 5-pack bagel
//       is five items. Left at the default of 1, the tray maths under-bakes by
//       the pack size.
//
// So this action collects what Simona named on the call — name, tray or single,
// how many on a tray, the article numbers per supermarket, and optionally which
// stores it goes to — and writes all of it in one place.
// ---------------------------------------------------------------------------

const CATEGORIES = new Set(["sourdough", "bagel", "challah", "pita", "pastry", "cake", "other"]);

export type CreateProductInput = {
  name: string;
  category: string;
  uom: "UNIT" | "TRAY";
  bakingQty?: number | null;   // items per tray; required when uom = TRAY
  packSize?: number | null;    // items inside one SOLD unit (a 5pk bagel = 5)
  colesCode?: string;
  woolworthsCode?: string;
  harrisFarmCode?: string;
  trackLaunch: boolean;
  launchedAt?: string;         // YYYY-MM-DD; defaults to today
  ranging: "all" | "some";
  storeIds?: string[];         // used when ranging = "some"
};

export type CreateProductResult =
  | { ok: true; id: string; name: string; rangedTo: number | null }
  | { ok: false; error: string };

const clean = (v?: string | null) => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};

export async function createProduct(input: CreateProductInput): Promise<CreateProductResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, id: "demo", name: (input.name ?? "").trim(), rangedTo: null };
  try {
    const name = (input.name ?? "").trim();
    if (!name) return { ok: false, error: "Product name is required." };
    if (name.length > 120) return { ok: false, error: "That name is too long." };

    const category = CATEGORIES.has(input.category) ? input.category : "other";
    const uom = input.uom === "TRAY" ? "TRAY" : "UNIT";

    // A tray product with no tray size cannot be baked from the production
    // sheet, so this is a hard stop rather than a null we discover later.
    const qtyRaw = Number(input.bakingQty);
    const bakingQty = uom === "TRAY" ? (Number.isFinite(qtyRaw) ? Math.round(qtyRaw) : 0) : null;
    if (uom === "TRAY" && (!bakingQty || bakingQty < 1)) {
      return { ok: false, error: "Say how many go on a tray — the production sheet divides by it." };
    }
    if (bakingQty !== null && bakingQty > 500) return { ok: false, error: "That tray size looks wrong. Check the number." };

    // products_pack_size_sane: check (pack_size between 1 and 24).
    const packRaw = Number(input.packSize);
    const packSize = Number.isFinite(packRaw) && packRaw >= 1 ? Math.round(packRaw) : 1;
    if (packSize > 24) return { ok: false, error: "Pack size has to be between 1 and 24." };

    const coles = clean(input.colesCode);
    const woolies = clean(input.woolworthsCode);
    const harris = clean(input.harrisFarmCode);

    const existing = await sql<{ name: string }[]>`
      select name from products where lower(name) = lower(${name}) limit 1`;
    if (existing.length) return { ok: false, error: `There is already a product called ${existing[0].name}.` };

    // THE AMBIGUITY GUARD, moved forward to the point of entry.
    //
    // jb_load_feed_upload rejects a sales row whose article number sits on two
    // products, because joining it would DOUBLE the units — migration 039 has
    // the croissant case where coles_code 3451243 was on both ALMOND and
    // CHOCOLATE. That reject is correct but it lands days later, on a feed, as
    // a number in a rejects table nobody is watching.
    //
    // It is cheaper to refuse the duplicate here, while the person who typed it
    // is still looking at the screen. Compared with jb_norm_code_safe, not the
    // raw text, because that is the function the loader actually joins on:
    // '0819' and '819' are the same code to it.
    const clash = await sql<{ name: string; which: string }[]>`
      select p.name,
             case
               when public.jb_norm_code_safe(p.coles_code)       = public.jb_norm_code_safe(${coles}::text)  then 'Coles'
               when public.jb_norm_code_safe(p.woolworths_code)  = public.jb_norm_code_safe(${woolies}::text) then 'Woolworths'
               else 'Harris Farm'
             end as which
        from products p
       where p.active
         and (   public.jb_norm_code_safe(p.coles_code)      = public.jb_norm_code_safe(${coles}::text)
              or public.jb_norm_code_safe(p.woolworths_code) = public.jb_norm_code_safe(${woolies}::text)
              or public.jb_norm_code_safe(p.harris_farm_code) = public.jb_norm_code_safe(${harris}::text))
       limit 1`;
    if (clash.length) {
      return {
        ok: false,
        error: `That ${clash[0].which} article number is already on "${clash[0].name}". Two products on one number makes the sales feed reject the row rather than guess, so it has to be unique.`,
      };
    }

    const date = clean(input.launchedAt);
    const track = input.trackLaunch !== false;

    const rows = await sql<{ id: string; name: string }[]>`
      insert into products
        (name, category, active, baking_uom, baking_qty, pack_size,
         coles_code, woolworths_code, harris_farm_code, launched_at)
      values (
        ${name},
        ${category}::product_category,
        true,
        ${uom},
        ${bakingQty},
        ${packSize},
        ${coles},
        ${woolies},
        ${harris},
        (case when ${track} then coalesce(${date}::date, (now() at time zone 'Australia/Sydney')::date) else null end)
      )
      returning id::text as id, name`;

    const id = rows[0].id;

    // RANGING. store_product_ranging (migration 015) treats ABSENCE as ranged,
    // so a brand new product is live at all 264 active stores the moment it exists. That
    // is right for a line Jesse's sells everywhere and wrong for the Woolworths
    // Metro one-off that started this.
    //
    // "Everywhere" therefore writes nothing (absence = ranged, unchanged
    // behaviour). "Only these stores" writes an explicit row for EVERY active
    // store — true for the picked ones, false for the rest — because a false
    // has to be written down to be respected.
    let rangedTo: number | null = null;
    if (input.ranging === "some") {
      const picked = [...new Set((input.storeIds ?? []).map((s) => String(s)).filter(Boolean))];
      if (!picked.length) return { ok: false, error: "Pick at least one store, or choose Every store." };
      // CSV -> string_to_array rather than passing a JS array, matching the
      // pattern already used in app/map/actions.ts and app/store/actions.ts.
      // Store ids are uuids, so a comma separator is safe.
      const csv = picked.join(",");
      const wrote = await sql<{ n: string }[]>`
        with w as (
          insert into store_product_ranging (store_id, product_id, ranged, updated_at, updated_by)
          select s.id, ${id}::uuid,
                 (s.id::text = any(case when ${csv} = '' then '{}'::text[] else string_to_array(${csv}, ',') end)),
                 now(), 'app'
            from stores s
           where s.active
          on conflict (store_id, product_id) do update
            set ranged = excluded.ranged, updated_at = now(), updated_by = excluded.updated_by
          returning ranged
        )
        select count(*)::text as n from w where ranged`;
      rangedTo = Number(wrote[0]?.n ?? 0);
    }

    return { ok: true, id, name: rows[0].name, rangedTo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not add the product." };
  }
}
