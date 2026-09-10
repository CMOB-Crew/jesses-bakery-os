# Jesse's Bakery OS — project rules

These rules apply to everyone and every AI agent working in this repo. They exist because each one was learned the hard way, either from a production incident or from the September 2026 performance audit (`PERFORMANCE-AUDIT.md`, plan in `PERFORMANCE-FIXES.md`, skill `/perf-fixes`). Follow them for new code and keep them true when editing old code.

## Stack facts that shape every rule

- Next.js 16 App Router, React 19, TypeScript, postgres.js, Supabase Auth. Deployed on Netlify as serverless functions. The database is in a different region from the app server, so **one database trip costs about 130 ms** and trips inside a request run one after another.
- Read `apps/web/node_modules/next/dist/docs/` before using a Next API. This Next version differs from training data.

## Decisions already made from production measurements (do not reverse)

- Every page is `export const dynamic = "force-dynamic"` with `maxDuration = 60`. Do not add static rendering, ISR, or `revalidate` on pages.
- **No `loading.tsx`, no Suspense streaming, no PPR, no `cacheComponents`.** Netlify never resumed React's postponed boundaries and pages rendered but ignored taps. Skeletons are done in `components/RouteFrame.tsx` and `nav-pending.ts`.
- **No `revalidatePath` in server actions.** One save produced 46 serverless renders and 503s. Actions return a result; the client updates its own state, or calls `router.refresh()` only when something else on the page genuinely changed.
- All sidebar links are `prefetch={false}`. Do not enable prefetch broadly.
- The brand PNG uses a plain `<img>` on purpose. Leave it.

## Database access

- **Every page and every server action reads and writes inside one `withUser()` call** from `lib/db.ts`. Never call query helpers bare from a page. Never run more than one statement in an action outside `withUser`. This gives one transaction per request and all-or-nothing writes.
- **Fewer statements beats parallel statements.** Inside `withUser`, `Promise.all` gives no speed-up because statements share one connection. Combine reads of the same row into one query. Never read a whole table to use one row; pass the id.
- **No N+1.** Never run a query inside a loop. Use one set-based statement (`unnest`, `= any(...)`, a `with` CTE) and merge in JavaScript with a `Map`.
- **Do not change the database schema without an explicit yes** from the person you are working with. No migrations, indexes, materialised views, or data moves as a side effect of a feature. Ask first, in plain words.

## Caching

- A query that the root layout and a page both need is wrapped in React `cache()` so it runs once per request. Examples: feed health, session claims, app role.
- **Reference data that changes daily or on an admin save is read through `unstable_cache`.** Examples: runs, products, tray sizes, settings, region names, addresses, the weekday sales curve, feed health, the store-week table.
- **The claims-as-argument recipe is the only way to write `unstable_cache` here.** The cached function cannot read cookies, and the app connects as `jbo_app` under row-level security, so a bare query inside it returns zero rows. The caller passes `await getSessionClaims()` in as an argument and the cached function runs `runAsUser(claims, tx => tx\`...\`)`. Cast date columns to text in the SQL so cached and fresh results match. The cache is per person; that is fine.
- Invalidate feed-driven caches from **route handlers** (ingest, mail poll) with `revalidateTag(tag, "max")`. Do not call `revalidateTag` or `updateTag` from server actions; that triggers the client-side refresh storm described in `app/map/actions.ts`. Admin-saved lists use a short `revalidate` time instead.

## Auth on the request path

- Verify the session **locally** (`supabase.auth.getClaims()` or JWKS verification in `lib/auth.ts`). Do not call `supabase.auth.getUser()` per request in the proxy, in pages, or in actions. It is a network trip to the auth server on every request.
- `getSessionClaims()` and `getDisplayUser()` are per-request memoised. Use them; do not create new Supabase clients in a page.

## React components

- The React Compiler is on (`reactCompiler: true`). Still: **rows of a long list live in their own component**, not inline JSX inside the screen. Handlers passed into rows come from `useCallback`.
- Search and filter inputs over more than about 50 rows pass their value through `useDeferredValue` before filtering.
- Derived values are computed during render (or `useMemo`), never set in state from a `useEffect`.
- After a save that only mirrors what the screen already shows, update local state (`useState` / `useOptimistic`). Do not `router.refresh()`.
- Every `setTimeout` / `setInterval` / event listener added in a component is cleared in the effect cleanup.
- Component CSS lives in `app/globals.css` or a module-level constant, never in a template literal inside the component body.
- Build `Intl.DateTimeFormat` / `Intl.NumberFormat` once at module scope. Dates are always formatted with `timeZone: "Australia/Sydney"`, including any "start of week" arithmetic, which is done on the server.
- Long tables (stores, delivery sheet, product pickers) get `content-visibility: auto` on rows via `globals.css`.

## Data sent to the browser

- Pass a client component only the fields it reads. Map rows before passing them.
- Never put binary or base64 data (photos, files) in props or in the HTML. Serve it from a route with caching headers, or a storage URL.
- Do not send whole lists (all addresses, all detail rows) when the screen shows a subset. Filter on the server or load on expand.

## Floor screens (Packing, Driver, Production, Deliveries)

- A tap is saved to the device first, then sent. Failed sends stay in an outbox and are resent on load and on `online`. The screen never shows a tick as saved unless the server said `ok`.
- Writes merge per store (`mergeRunState`). Never replace a whole day's state from one device.
- Every `fetch` to storage or an external API has `AbortSignal.timeout(...)`.
- Camera and media streams are stopped in every exit path, including a cancel during setup.

## Feeds and long-running work

- Parse a file before opening a database transaction. Only the writes run inside `runAsUser` / `withUser`.
- Bulk inserts use `COPY` or large chunks, never thousands of small statements.
- Cleanup that the response does not need (deleting a temp upload, logging) goes in `after()` from `next/server`.

## When you finish a change

- Run `npm run lint` and `npm run build` in `apps/web`. Run the relevant `apps/web/scripts/*-check.ts` if one covers the area.
- One change, one commit, named for what it does.
- If the change is one of the cards in `PERFORMANCE-FIXES.md`, tick the card there.
