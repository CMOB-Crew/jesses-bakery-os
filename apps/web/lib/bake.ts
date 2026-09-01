// How a product is SOLD is not how it is BAKED.
//
// Jesse's catalogue carries the pack size in the name -- BAGEL - PLAIN (X 5),
// MINI CHALLAH - PLAIN (X 4), BAGEL - MINI (X 6) -- because that is the unit
// the supermarket scans. The floor does not bake bags. Simona, 1 Sept 41:08:
// "so production, remove the bracket times five and leave, and that's fine."
//
// Shared rather than private to the board, because the production page header
// has to fold the same names together to reach the same count. Kept out of
// lib/queries.ts on purpose: that module pulls the database client, and a
// client component importing it would drag server code into the browser.
//
// Anchored to the end of the name, so it can only ever take a trailing suffix.
export const stripPack = (product: string) => product.replace(/\s*\(X ?\d+\)\s*$/i, "").trim();
