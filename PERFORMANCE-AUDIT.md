# Performance and caching audit — Jesse's Bakery OS

Date: 10 September 2026. Branch `ianmuico/taniwha`. Read-only: no source file was changed. Every finding names a file, an exact line, and the hook, function, or library that would address it. Nothing here is code.

Scope: `apps/web` (Next.js 16.3, React 19.2, postgres.js, Supabase Auth, deployed on Netlify with the database in Singapore), `db/migrations`, `services/forecast`.

Goals the audit was measured against:

| Goal | What it means here |
|---|---|
| Runs quickly | Fewer Pacific round trips per request (each is ~130 ms, serialised inside `withUser`), less re-render work on the 265-row screens, fonts that do not block first paint. |
| Preserves data | Floor and driver writes survive a failed request, a refresh, and two tablets working the same day. |
| No server costs | Everything recommended runs on the existing Netlify + Supabase free/pro tiers: React `cache()`, `unstable_cache` (Netlify Blobs), Postgres materialised views, module-level TTL caches. No Redis, no extra services. |
| Addresses all issues | 300+ notes across every file in the web app, the query layer, actions, routes, CSS, migrations and the forecast service. |

---

## 1. The existing skills to use

gstack does not ship a "memoisation audit" skill. The pieces that cover this request live in two places:

| Need | Skill | Where | How to run |
|---|---|---|---|
| Measure before/after: page load, Core Web Vitals, bundle and resource sizes, regression tracking on every PR | gstack `/benchmark` | `~/.claude/skills/benchmark/SKILL.md` | `/benchmark` against `npm run start` on this branch, then again after each fix batch. |
| The React/Next rulebook this audit applies (64 rules: `async-*`, `bundle-*`, `server-cache-react`, `server-cache-lru`, `rerender-memo`, `rerender-use-deferred-value`, `js-index-maps`, `rendering-content-visibility`, …) | Vercel plugin `react-best-practices` (also surfaced as the `vercel:react-best-practices` skill and the `vercel:performance-optimizer` agent) | `~/.claude/plugins/cache/claude-plugins-official/vercel/0.48.0/skills/react-best-practices/upstream/rules/*.md` | Invoke `vercel:react-best-practices` when reviewing a component; the rule ids quoted below map one-to-one to files in that folder. |
| Composite code-quality score and trend (types, lint, dead code) | gstack `/health` | `~/.claude/skills/health/SKILL.md` | `/health` once fixes land. |
| Pre-merge review of the fix PRs | gstack `/review` | `~/.claude/skills/review/SKILL.md` | `/review` on each PR. |
| Next 16 caching semantics (`unstable_cache`, `cacheLife`, `after`) | bundled docs | `apps/web/node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md`, `.../03-api-reference/04-functions/unstable_cache.md`, `.../after.md` | Read before touching caching; this Next differs from training data. |

---

## 2. Decisions this audit respects (do not reverse)

These are documented and measured in the repo. Every recommendation below fits inside them.

- **Every page is `force-dynamic` + `maxDuration = 60`.** Build-time prerender against Supabase was flaky. Static/ISR page rendering is not recommended anywhere.
- **No `loading.tsx`, no Suspense streaming, no PPR, no `cacheComponents: true`.** Commit 8c8e748 removed all 22 loading files after Netlify never resumed React POSTPONED boundaries (pages rendered, ignored taps). `"use cache"` requires Cache Components, which turns PPR on, so it is out. Skeletons already work via `components/RouteFrame.tsx` + `nav-pending.ts` (`useLinkStatus`).
- **No `revalidatePath` in actions.** One save produced 46 serverless renders and 503s on 27 Aug. Actions return, the client calls `router.refresh()`. Findings below only ask to *narrow* refreshes to local state where the server row mirrors client state.
- **Sidebar links are `prefetch={false}`.** Each prefetch is a serverless render.
- **`withUser()` opens one transaction per request and pins one connection.** `Promise.all` inside it gives no parallelism. The win is fewer statements, never more concurrency. Queries *outside* `withUser` pay BEGIN / set_config / COMMIT per statement under `AUTH_ENFORCED=1`.
- **`unstable_cache` cannot read `cookies()` inside its scope.** `q()` under `AUTH_ENFORCED` calls `getSessionClaims()` which reads cookies, so a cached helper must run on the raw `sql` client and is therefore only appropriate for reference data that is not user-scoped (settings, runs, products, weekday shape, feed health). User-scoped reads use React `cache()` (per-request) or a module-level TTL map keyed on role.
- **React Compiler is not enabled** (no `reactCompiler` in `next.config.ts`, no `babel-plugin-react-compiler` installed). Manual memo notes below are kept because they show *where* re-render cost lives; each is tagged when the compiler would cover it.

---

## 3. The eleven changes that matter most

Ranked by measured or estimated effect on request time, interaction latency, data safety, or function minutes.

1. **Verify the session locally instead of calling Supabase Auth twice per request.** `lib/supabase/proxy.ts:61` calls `getUser()` on every matched request, then `lib/supabase/server.ts:110` calls it again inside the page. Each is a ~500–680 ms Singapore round trip. supabase-js 2.112 ships `auth.getClaims()` (local JWKS verification, keys cached in process); `lib/auth.ts:32` already says this is the plan. Saves roughly a second on every navigation.
2. **Enable the React Compiler.** `next.config.ts` — add `reactCompiler: true` (with `experimental.turbopackRustReactCompiler: true` on 16.3 so no Babel plugin is needed). Automatically memoises every "compiler covers" note below across 37 client components.
3. **Self-host the fonts.** `app/globals.css:7` runtime `@import` of Google Fonts is a render-blocking three-hop chain with no preconnect. `next/font/google` (Fraunces with `axes:['opsz']`, Inter) in `app/layout.tsx`, exposed as `--serif` / `--sans` so the design tokens are untouched.
4. **Cache `v_store_week` once, not once per page.** `lib/queries.ts:75` `getStoreWeek` is the heaviest view (~1 s measured in migration 051) and is evaluated by ten pages plus four product queries. Either a `mv_store_week` materialised view refreshed by the nightly engine and after each ingest (`db/migrations/050_asof_as_a_constant.sql:77`), or `unstable_cache` on the raw client with a `store-week` tag revalidated from `lib/feeds/ingest.ts`. Wrap in React `cache()` as well so the store page's `getStoreById` + `getStoreWeek` pair dedupes.
5. **Collapse the store page's 18 statements.** `app/store/[id]/page.tsx:91`. Four reads of the same `store_settings` row (queries.ts 794, 805, 862, 1021), three of the same `stores` row (1007, 1252, 3046), a whole-network `getStoreRevenueWeek` for one `.get(id)`, and `getStoreById` duplicating `getStoreWeek`. One `stores ⋈ store_settings` statement plus the cached store-week takes this to about 8. Roughly 1.3 s off every store view.
6. **Stop shipping the store photo inline.** `app/store/[id]/page.tsx:139` puts a base64 data URL up to 1.4 MB into the RSC payload *and* the SSR HTML (`StoreProfile.tsx:411`). Serve it from a route handler with `Cache-Control`/ETag or Supabase Storage, and pass a has-photo flag.
7. **Make floor writes survive failure.** `PackingApp.tsx:142` posts the whole day's map on every tick with no debounce and no in-flight guard; `:170` a failed save leaves ticks on screen that vanish on reload. `DriverApp.tsx:107` drops the delta on failure. `ProductionBoard.tsx:217` and `DeliveriesBoard.tsx:89` ignore the write result. `run-state-actions.ts:154` replaces the day wholesale so two iPads erase each other. Fix set: debounce with a request id, an IndexedDB / localStorage outbox replayed on mount and `online` (`idb-keyval`), `mergeRunState` with a tombstone for untick, check `res.ok`.
8. **Wrap the seven bare pages and the multi-statement actions in `withUser`.** Pages: `/products`, `/region/[name]`, `/benchmarks`, `/opportunities`, `/lost-sales`, `/archive`, `/accuracy` (see `lib/db.ts:181`). Actions: `app/store/actions.ts:262` (5+N statements, non-atomic), `:453`, `app/map/actions.ts:55` (2 + added + removed statements, non-atomic), `app/driver-proof-actions.ts:56`, `app/new-store/actions.ts:92`, `:176`, `app/new-product/actions.ts:96`. Each goes from four round trips per statement to one transaction and becomes atomic.
9. **Cache slow-changing reference reads across requests.** `getWeekdayShape` (queries.ts:2348, 91-day scan on four pages plus an action), `getFeedHealth` (:930, runs in the root layout on every route via `FeedAlarm.tsx:46` and again on `/feeds`), `getForecastAccuracy` (:2173, two 182-day aggregates per view), `getAppSettings`, `getEngineProjection`, `getTraySizes`, `getRuns`, `getRegionNames`, picklists, `getStoreAddresses`. `unstable_cache` with a tag revalidated by the writing action, or a module-level TTL map.
10. **Stop the root layout opening its own transactions.** `lib/app-role.ts:36` (`runAsUser`, 4 round trips) and `components/FeedAlarm.tsx:46` (outside `withUser`) both run on every route before the page's own transaction starts. Read the role inside the page's ambient transaction or `unstable_cache` it per `claims.sub`; React `cache()` + `unstable_cache` for feed health.
11. **Fix the forecast engine's N+1.** `services/forecast/app.py:113` runs three statements per store×product (~15,000+ per plan). Three set-based queries up front and a dict join in Python; `functools.lru_cache` on `event_uplift` as a first step.

---

## 4. Where each hook belongs

| Hook / API | Apply to | Why |
|---|---|---|
| `useMemo` | `TodayDashboard.tsx:65,90,152,199`; `StoresList.tsx:34`; `DeliveriesBoard.tsx:138`; `DeliverySheet.tsx:91`; `NetworkMap.tsx:159`; `SeasonalityCalendar.tsx:139,189`; `NewProductSetup.tsx:90`; `ProductionBoard.tsx:248`; `WasteChart.tsx:10`; `StoreDeliveryPanel.tsx:78`; `LostSales.tsx:18` | Derived tables, totals, medians and lookup maps over 265 stores or 40×265 cells are rebuilt on every keystroke or click. |
| `memo()` on an extracted row | `StoresList.tsx:299`; `PackingApp.tsx:341`; `ProductionBoard.tsx:514`; `DeliveriesBoard.tsx:404`; `DeliverySheet.tsx:91`; `NetworkMap.tsx:159` (Dot); `SeasonalityCalendar.tsx:326` (DayCell); `NewProductSetup.tsx:277`; `StoreProfile.tsx:720`; `StandingOrderPanel.tsx:353`; `ProductsList.tsx:204` | Rows are inline JSX with fresh closures, so one tick re-renders every sibling. Pair with `useCallback` handlers. |
| `useCallback` | Handlers passed into the memoised rows above; `DriverApp.tsx` already does this at 107, 225, 359 | Stable identity so `memo()` actually bails out. |
| `useDeferredValue` | Search boxes: `StoresList.tsx:92`; `ProductionBoard.tsx:467`; `DeliveriesBoard.tsx:353`; `NewProductSetup.tsx:99` | Typing stays responsive while a 265-row filter catches up. |
| `useTransition` | Already used correctly in most panels; `AskBar.tsx:27` should gate like `AssistantBoard` | Non-urgent updates and pending state. |
| `useOptimistic` / local state instead of `router.refresh()` | `StoreProfile.tsx:219,242,285,322,340,366,584`; `StandingOrderPanel.tsx:157,187,221,235,256,282`; `StoreDeliveryPanel.tsx:107`; `ProductsList.tsx:311`; `RunBoard.tsx:168`; `SeasonalityCalendar.tsx:258`; `NewProductSetup.tsx:156`; `Launches.tsx:294` | Each refresh re-runs the whole page (18 queries on the store page) to mirror a value the client already holds. |
| Lazy `useState(() => …)` | `SeasonalityCalendar.tsx:116`; `NetworkMap.tsx:51` | Expensive initial values computed every render. |
| Derive during render, not `useEffect` | `NewStoreSetup.tsx:227` | `rerender-derived-state-no-effect`. |
| `useSyncExternalStore` | Already correct in `RouteFrame.tsx:53` | No change. |
| `cache()` from `react` (per-request) | `getFeedHealth`, `getStoreWeek`, `getFeedStatus` → `getFeedHealth`, `getWeekdayShape` | Layout and page, or two helpers, call the same query in one request. Already used for `getSessionClaims`, `getDisplayUser`, `getAppRole`. |
| `unstable_cache` from `next/cache` (cross-request, Netlify Blobs) | Reference data listed in §3 item 9, via the raw `sql` client | Changes nightly or on an admin save; tag and `revalidateTag` from the writing action. |
| Module-level TTL `Map` | `getStoreWeek` when it must stay RLS-scoped; `getAppRole` per `sub` | Warm-instance win where cookies are needed. |
| `after()` from `next/server` | `app/api/feeds/[retailer]/route.ts:129` storage remove; `lib/feeds/ingest.ts:158` staging delete | Non-blocking cleanup after the response. |
| CSS `content-visibility: auto` | `globals.css:186` table rows; `StoresList.tsx:290`; `DeliverySheet.tsx:127`; `NewProductSetup.tsx:378`; `FeedUpload.tsx:394`; `ForecastAccuracy.tsx:188` | Free skip of layout/paint for off-screen rows before reaching for `@tanstack/react-virtual`. |
| `idb-keyval` (IndexedDB outbox) | `DriverApp.tsx:107`; `PackingApp.tsx:170`; `ProductionBoard.tsx:213`; `DeliveriesBoard.tsx:85` | Writes that must survive a dead signal or a refresh. |
| `AbortSignal.timeout` | `lib/driver-proof.ts:63`; `AskBar.tsx:27` | Hung requests never reject on one bar of signal. |
| `next/font/google` | `app/layout.tsx` replacing `globals.css:7` | Self-hosted, non-blocking fonts. |
| `auth.getClaims()` / `jose` JWKS | `lib/supabase/proxy.ts:61`; `lib/supabase/server.ts:110`; `lib/auth.ts:41`; `app/login/reset/page.tsx:31` | Local token verification. |
| `reactCompiler: true` | `next.config.ts` | Covers every note tagged "compiler covers". |

---

## 5. Data preservation — findings that can lose work

These are pulled out because "preserves data" is a stated goal and they are not performance items.

- `apps/web/components/PackingApp.tsx:142` — [P1] Full-map save on every tick, no debounce, no in-flight guard; a late response overwrites a newer one.
- `apps/web/components/PackingApp.tsx:170` — [P1] Failed save toasts only; ticks look saved and are gone on reload. Persist pending map per `day` locally and replay.
- `apps/web/app/run-state-actions.ts:154` — [P1] `setPackingState` replaces the whole day; two iPads on different runs erase each other's ticks. Use `mergeRunState` with a per-store delta and a tombstone for untick.
- `apps/web/components/DriverApp.tsx:107` — [P1] `persist` drops the delta on failure; `recordDelivery` (:403) and `sendProof` (:415) likewise. Outbox in IndexedDB, replay on mount and `online`.
- `apps/web/components/ProductionBoard.tsx:217` — [P1] Write result ignored; a failed save shows as saved. `:213` nudges and baked ticks are memory-only.
- `apps/web/components/DeliveriesBoard.tsx:89` — [P1] Same as ProductionBoard. `:85` quantity nudges lost on refresh.
- `apps/web/lib/driver-proof.ts:63` — [P2] No timeout on mint or PUT; a hung request means proof is silently lost.
- `apps/web/components/DriverApp.tsx:239` — [P2] Camera stream leaks if ✕ is tapped while `getUserMedia` is pending.
- `apps/web/app/store/actions.ts:262`, `:453`; `app/map/actions.ts:55`; `app/new-store/actions.ts:176`; `app/new-product/actions.ts:96` — [P1/P2] Multi-statement writes outside a transaction can half-succeed. `withUser` makes them atomic.
- `apps/web/components/StandingOrderPanel.tsx:78` — [P2] Period start mixes browser-local `Date` with `toISOString()` (UTC); on an AEST browser Monday serialises as Sunday and the idempotency key can land on the wrong week. Compute on the server next to `today`.

---

## 6. Per-file notes

Format: `path:line — [P1|P2|P3] note`. P1 = measurable win on load, interaction or server cost. P2 = worthwhile. P3 = nit or only at scale. "Compiler covers" means enabling the React Compiler makes the manual hook unnecessary.

### 6.1 Root, layout, auth, data access

- `apps/web/next.config.ts:13` — [P1] Add `reactCompiler: true` (+ `experimental.turbopackRustReactCompiler: true`); no other config change needed.
- `apps/web/app/layout.tsx:55` — [P2] `getDisplayUser` + `getAppRole` are correctly parallel and per-request cached; the cost is inside `getAppRole` (below). Move the font declaration here once `next/font/google` replaces the CSS import.
- `apps/web/app/globals.css:7` — [P1] Runtime Google Fonts `@import`: render-blocking three-hop chain, no preconnect, Fraunces opsz 9..144 × 4 weights + Inter × 5. Replace with `next/font/google` and expose `--serif`/`--sans` via `variable`.
- `apps/web/app/globals.css:44` — [P2] `body::before` is a fixed full-viewport `feTurbulence` SVG with `mix-blend-mode:multiply`, re-blended on every scroll frame; measurable jank on phones. Pre-rasterised PNG tile with plain `opacity`, or disable under `@media (pointer: coarse)`.
- `apps/web/app/globals.css:186` — [P2] Add `content-visibility:auto; contain-intrinsic-block-size:auto 48px` on `.tablewrap tbody tr` (and `.rl-row` :152, `.rtile` :158); reset under `@media print` :217.
- `apps/web/app/globals.css:110` — [P3] `.bento`, `.col-work/.col-side`, `.rl-row` (:149-156), `.backlink` (:205), `.kpis` (:200-204) match no component; dead blocks.
- `apps/web/app/page.module.css:1` — [P3] create-next-app leftover, imported by nothing; zero runtime cost, delete for hygiene.
- `apps/web/proxy.ts:8` — [P1] Runs `updateSession` on every matched request; see `lib/supabase/proxy.ts:61`.
- `apps/web/lib/supabase/proxy.ts:61` — [P1] `getUser()` network verify on every request including API calls; use `getClaims()` (local JWKS) and only refresh near expiry, or forward verified claims via a request header so the page never re-verifies.
- `apps/web/lib/supabase/server.ts:110` — [P1] `getSessionClaims` repeats the `getUser()` trip the proxy just made; `getClaims()` with `cache()` kept for per-request memo.
- `apps/web/lib/supabase/server.ts:75` — [P3] `getDisplayUser` reads the cookie locally; no change.
- `apps/web/lib/auth.ts:41` — [P1] `verifyAccessToken` also uses `getUser(token)`; its comment at :32 names the fix — `jose` `jwtVerify` against the project JWKS, key set cached at module scope, giving one local path for pages, proxy and routes.
- `apps/web/lib/app-role.ts:36` — [P1] Opens its own `runAsUser` transaction (4 round trips) in the root layout on every route; read `current_app_role()` inside the page's ambient `withUser` transaction, or `unstable_cache` keyed on `claims.sub` with tag `role:<sub>` revalidated by the admin role action.
- `apps/web/lib/db.ts:181` — [P1] Per-statement fallback path is hit by `/products`, `/region/[name]`, `/benchmarks`, `/opportunities`, `/lost-sales`, `/archive`, `/accuracy`, `FeedAlarm` and `getAppRole` on every route; wrap those in `withUser`.
- `apps/web/lib/db.ts:144` — [P2] `withUser` awaits `getSessionClaims()` (~500–680 ms) before `sql.begin`; with local verification this is microseconds.
- `apps/web/lib/db.ts:24` — [P2] `max: 8` per function instance pins one connection per request anyway; `max: 4` + `connect_timeout: 10` so a stalled pooler handshake fails inside Netlify's budget.
- `apps/web/lib/db.ts:25` — [P3] Add `max_lifetime` (~300) so a thawed instance rotates sockets instead of retrying a dead one.
- `apps/web/lib/db.ts:156` — [P3] `BEGIN` + `set_config` are two round trips; with `prepare:false` a single multi-statement batch saves one crossing per request.
- `apps/web/lib/db.ts:28` — [P3] `prepare:false` is required for the pooler; no change.
- `apps/web/components/FeedAlarm.tsx:46` — [P1] `getFeedHealth()` in the root layout on every route, outside `withUser`, and again on `/feeds`; React `cache()` + `unstable_cache` (revalidate 600, tag `feed-health` revalidated from ingest).
- `apps/web/components/Sidebar.tsx:64` — [P3] Correct as is: `prefetch={false}`, module-level `NAV` and `EMBLEM`. The inline `<style>` at :156 could move to `globals.css`.
- `apps/web/components/RouteFrame.tsx:53` — [P3] `useSyncExternalStore` is the right tool; no change.
- `apps/web/components/nav-pending.ts:106` — [P3] No change; timers are cleared and the store is stable.
- `apps/web/components/LinkPending.tsx:16` — [P3] No change.
- `apps/web/components/RouteGuard.tsx:30` — [P3] No change.
- `apps/web/components/Skeleton.tsx:1` — [P3] Header comment still says `loading.tsx`; it is mounted by `RouteFrame:66`. Pure static JSX; hoisting variant trees is optional.
- `apps/web/components/DemoTour.tsx:142` — [P3] (demo only) `waitFor`'s 120 ms `setInterval` is untracked so cleanup at :198 cannot clear it; keep the handle or use `MutationObserver`. `:183` scroll listener should be `{ passive: true }`.

### 6.2 Overview and list screens

- `apps/web/app/page.tsx:58` — [P1] 13 statements serialise on the pinned connection (~16 round trips ≈ 2 s before a byte renders). Collapse `getNetwork`/`getAsOf`/`getEngineHealth` into one statement and `getStoreStates`+`getShelfCapOverrides`+`getPeakDaySold` into one stores-keyed query.
- `apps/web/app/page.tsx:59` — [P1] `getStoreWeek` re-read on `/`, `/stores`, `/opportunities`, `/lost-sales`, `/benchmarks`, `/launches` per request though it changes daily; cache per §3 item 4.
- `apps/web/app/page.tsx:61` — [P2] `getAppSettings`, `getEngineProjection`, `getFeedStatus` are reference reads paid per request; TTL / `unstable_cache`.
- `apps/web/app/page.tsx:307` — [P3] `capOverrides` and `peakDay` exist only to feed `isCapStale`; precompute a per-row `capStale` boolean and drop the two maps from the client payload.
- `apps/web/app/page.tsx:141` — No change: one pass with Map lookups.
- `apps/web/components/TodayDashboard.tsx:65` — [P2] `rows` (265-row map with `Number()` coercions) rebuilt on every band/state click; `useMemo` on `[stores, states, stateF]` (compiler covers).
- `apps/web/components/TodayDashboard.tsx:90` — [P2] Seven separate passes over rows through :149 on every click; one `useMemo` keyed on `[rows, revByStore, net, revenue]`.
- `apps/web/components/TodayDashboard.tsx:152` — [P2] Five filter passes plus `isCapStale` per row, independent of `band`; one reduce in `useMemo`.
- `apps/web/components/TodayDashboard.tsx:199` — [P2] `bandStats` 3× filter plus two median sorts per band per render; `useMemo` on `[rows, th]`.
- `apps/web/components/TodayDashboard.tsx:62` — [P3] `stateOpts` rebuilt per render; `useMemo` on `[states]`.
- `apps/web/components/TodayDashboard.tsx:241` — [P3] Sorts per render; `useMemo` on `[rows, band]`.
- `apps/web/components/TodayDashboard.tsx:421` — [P3] ~100-line inline `<style>` shipped in RSC payload and HTML each render; module const or `globals.css`.
- `apps/web/components/TodayDashboard.tsx:290` — No change: ≤8 buttons.
- `apps/web/app/stores/page.tsx:19` — [P2] `getStoreStates` + `getShelfCapOverrides` + `getPeakDaySold` can be one statement (or fold `state`/`peak_day_sold` into the store-week view), saving two round trips here and on the Overview.
- `apps/web/components/StoresList.tsx:34` — [P2] `effOf` (`scoreStore`) runs per row in filter, twice per comparison in sort (~4k calls), three times per row in render and again in CSV; `useMemo` a `Map<store_id, Eff>` on `[stores]` (`js-index-maps`).
- `apps/web/components/StoresList.tsx:92` — [P2] Each keystroke synchronously re-filters and re-renders up to 265 rows; `useDeferredValue` on the term.
- `apps/web/components/StoresList.tsx:299` — [P2] Inline row JSX with fresh `router.push` closure per row; extract a `memo()`'d `StoreRow` (compiler covers).
- `apps/web/components/StoresList.tsx:290` — [P3] 265-row table with no windowing; `content-visibility:auto` first, `@tanstack/react-virtual` only if measured.
- `apps/web/components/StoresList.tsx:98` — No change: already memoised.
- `apps/web/app/products/page.tsx:18` — [P3] One heavy statement outside `withUser`; wrap for a uniform auth path.
- `apps/web/components/ProductsList.tsx:311` — [P2] `router.refresh()` after a launch toggle re-runs the heavy `getProducts` aggregate to flip one boolean; `useOptimistic` from the action's `ok`.
- `apps/web/components/ProductsList.tsx:204` — [P3] Every keystroke re-renders all rows each carrying `useRouter` + `useTransition` + three `useState`; `memo()` the row (compiler covers).
- `apps/web/components/ProductsList.tsx:357` — [P3] Refresh after new product is needed; acceptable.
- `apps/web/components/ProductsList.tsx:50` — No change: memoised.
- `apps/web/app/archive/page.tsx:15` — [P3] One statement outside `withUser`; wrap for consistency.
- `apps/web/components/StoreArchive.tsx:36` — [P3] Toast timer never cleared on unmount; `useEffect` cleanup. `:34` `retailerLabel` recreated per render; hoist. `:43` no change.
- `apps/web/app/opportunities/page.tsx:15` — [P2] Three statements via `Promise.all` outside `withUser` = three transactions on three connections (12 round trips, competing); wrap in `withUser`.
- `apps/web/components/OpportunityFinder.tsx:31` — [P3] Toast timer cleanup. `:27` no change.
- `apps/web/app/lost-sales/page.tsx:15` — [P2] Same shape as opportunities; wrap in `withUser`.
- `apps/web/components/LostSales.tsx:18` — [P3] `open` is a fresh array each render so the four `useMemo`s keyed on it never hit; memoise `open` on `[data.losses, resolved]`. `:54` good pattern (local state, no refresh). `:31` toast cleanup.
- `apps/web/app/benchmarks/page.tsx:22` — [P2] `data.rows` serialised to the client but never read by `StoreBenchmarks`; strip before passing. `:15` wrap in `withUser`.
- `apps/web/components/StoreBenchmarks.tsx:107` — [P3] Array spread per render; trivial. `:18` no change.
- `apps/web/app/accuracy/page.tsx:15` — [P1] Two 182-day `sales_daily` aggregates run sequentially (queries.ts 2187 then 2285), outside `withUser`, on every view, for data that changes nightly; cache the whole result (`unstable_cache` on the raw client or a `mv_weekly_sales` view) and at least `Promise.all` the two.
- `apps/web/components/ForecastAccuracy.tsx:188` — [P3] "Show all" renders every scored store with an inline SVG; `content-visibility:auto` or keep paging. `:249` good: CSS hoisted.
- `apps/web/app/launches/page.tsx:20` — [P2] `getLaunches` awaits pipeline then live stores sequentially, and the latter pulls all 265 store-week rows to enrich a handful; filter in SQL or read the cached store-week.
- `apps/web/components/Launches.tsx:294` — [P3] Refresh after `markStoreLive` is acceptable; `useOptimistic` could move the row immediately. `:56` all metrics precomputed, components module-level.
- `apps/web/components/EnginePanel.tsx:16` — No change (server component, 4 rows).
- `apps/web/components/RecCard.tsx:7` — No change.
- `apps/web/components/StatusTag.tsx:17` — No change.
- `apps/web/components/RetailerBadge.tsx:67` — [P3] `next/image` with `unoptimized` adds per-row hook/srcset overhead on 265 rows for nothing a plain `<img loading="lazy">` would not do.
- `apps/web/components/AskBar.tsx:27` — [P3] No `AbortController` and chips not disabled while loading, so two quick clicks race; abort the previous request or gate on `loading`.
- `apps/web/components/AssistantBoard.tsx:113` — [P3] Bar-max IIFE per exchange per render; compiler covers. `:47` no change.
- `apps/web/app/assistant/page.tsx:17` — [P3] Two statements inside `withUser`; `engine_projection` is a static seed table (reference cache).
- `apps/web/app/api/ask/route.ts:16` — [P2] `answerQuestion` runs outside `withUser`, so 1–3 statements each open their own transaction on an interactive path; wrap in `withUser`.
- `apps/web/lib/ask.ts:223` — [P2] This branch and the fallback at :248 read the full `v_store_week` to match a store name; read `id, name from stores` (cached), match, then query one store. `:441`, `:469`, `:487` — [P3] two statements → one each.

### 6.3 Store, product, region

- `apps/web/app/store/[id]/page.tsx:91` — [P1] 18 statements on the pinned connection (≈2.3 s of RTT); comments at :88–90 and :96–100 claiming concurrency are stale under `AUTH_ENFORCED`.
- `apps/web/app/store/[id]/page.tsx:94` — [P1] Four separate reads of the same `store_settings` row (queries.ts 794/805/862/1021) and three of the same `stores` row (1007/1252/3046); one `stores ⋈ store_settings` statement.
- `apps/web/app/store/[id]/page.tsx:93` — [P1] `getStoreById` evaluates the full view for one row while `getStoreWeek` already returns it; `.find` it, or one SQL peer-median query (`percentile_cont`) so 265 rows are not shipped for two medians.
- `apps/web/app/store/[id]/page.tsx:101` — [P1] `getStoreRevenueWeek()` reads every store then `.get(id)` at :123; add a `where store_id =` parameter.
- `apps/web/app/store/[id]/page.tsx:101` — [P2] `getRunPicklist` and `getProductPicklist` are reference lists; `unstable_cache` with a tag from the run/product actions.
- `apps/web/app/store/[id]/page.tsx:101` — [P2] Invoice-only reads (standing order, product picklist, Xero contact) and feed-only reads (recos, overrides, ranging, day grid, sellouts) are both fetched for every store; two-phase on `store.retailer` cuts 5–8 statements.
- `apps/web/app/store/[id]/page.tsx:139` — [P1] `photo` base64 up to 1.4 MB in RSC payload and SSR HTML; route handler with `Cache-Control`/ETag or Supabase Storage URL, pass a has-photo flag.
- `apps/web/app/store/[id]/page.tsx:139` — [P3] `dayGrid[].sellout_lines` never read by the client; drop from the select.
- `apps/web/app/store/[id]/page.tsx:130` — [P3] `Intl.DateTimeFormat` built per request here and in `actions.ts:156`; one module-level `sydneyToday()`.
- `apps/web/app/store/[id]/page.tsx:35` — [P3] `computePeer` five filter passes; cheap at 265 rows.
- `apps/web/components/StoreProfile.tsx:219` — [P1] `router.refresh()` after every small save (also 242, 285, 322, 340, 366, 584) re-runs the 18-query page to mirror state the client holds; drop for shelf cap, visit, photo, override, ranging, service level.
- `apps/web/components/StoreProfile.tsx:411` — [P2] `<img src={pic}>` inlines the data URL in server HTML; becomes a cacheable image request with the route-handler approach.
- `apps/web/components/StoreProfile.tsx:256` — [P3] `resizeToDataUrl` decodes on the main thread with sync `toDataURL`; `createImageBitmap(file, {resizeWidth})` + `canvas.toBlob`, upload a Blob not a 1.4 MB string.
- `apps/web/components/StoreProfile.tsx:148` — [P3] `nameById` built twice (:148, :159); rows keyed by name force `rows.find` at :360; one `Map<pid,row>`.
- `apps/web/components/StoreProfile.tsx:350` — [P3] Derived rows/metrics (:350–384) recomputed per render including toasts; `useMemo` (compiler covers).
- `apps/web/components/StoreProfile.tsx:720` — [P3] Fresh inline handlers per row (:729, :743, :751–753), no memoised row; extract `ProductRow` (compiler covers). `AdjustEditor` correctly module-level.
- `apps/web/components/StoreProfile.tsx:177` — [P3] Toast timer cleanup.
- `apps/web/components/StoreProfile.tsx:777` — [P3] 160-line `<style>` literal re-created per render; module const or CSS module.
- `apps/web/components/StoreProfile.tsx:12` — [P3] `toLocaleString("en-AU")` builds an `Intl.NumberFormat` per call (same `StoreWeekPanel:33`, `ProductProfile:11`); hoist one formatter.
- `apps/web/components/StoreProfile.tsx:144` — No change: lazy initialisers and `rows` memo are correct.
- `apps/web/components/StoreWeekPanel.tsx:149` — [P3] `sellouts.filter` inline when a day is open; trivial. `:170` static `<style>` hoist. `:56` no change.
- `apps/web/components/StoreDeliveryPanel.tsx:107` — [P2] `router.refresh()` after save re-runs the 18-query page so view-mode stops reading stale props; keep saved rows as local source of truth. `:78` `buildRows` per render, `useMemo` (compiler covers). `:149` fine at 7 rows.
- `apps/web/components/StandingOrderPanel.tsx:157` — [P1] `router.refresh()` after each line save (also 187, 221, 235, 256, 282); day-grid saves on every cell blur (:445–447) fire five full page renders across five boxes. Local `lines` state / `useOptimistic`.
- `apps/web/components/StandingOrderPanel.tsx:78` — [P2] Period start timezone bug (see §5).
- `apps/web/components/StandingOrderPanel.tsx:299` — [P3] Four passes over `lines` per keystroke; one reduce in `useMemo`. `:353` ~8 inline closures per line, no memoised row (compiler covers). `:433` `DOW.filter(runsOn)` per open line; `useMemo`. `:125` no change.
- `apps/web/components/WasteChart.tsx:10` — [P3] Points, smoothing, path strings recomputed on every mousemove render; `useMemo` on `[vals]`, hoist axis labels. `:36` cache `getBoundingClientRect()` scale instead of SVGPoint + CTM per move.
- `apps/web/components/StoreBars.tsx:10` — No change: server-rendered SVG.
- `apps/web/components/ProductProfile.tsx:20` — [P3] JS re-sort of rows the query already ordered; order by waste in SQL.
- `apps/web/app/product/[id]/page.tsx:18` — [P2] `getProductById` and `getProductStores` each join `v_store_week`, so the network view is evaluated twice; one statement and reduce the header in JS.
- `apps/web/app/region/[name]/page.tsx:21` — [P3] Outside `withUser`; wrap. `:45` `scoreStore` evaluated up to five times per store; one pass. `:78` full `StoreWeek[]` serialised; trim to fields read.
- `apps/web/app/store/actions.ts:262` — [P1] `saveStoreSchedule` issues 5+N statements through bare `q`, each its own transaction and non-atomic (the "seven little writes that can half-succeed" its own comment warns about); wrap in `withUser`.
- `apps/web/app/store/actions.ts:453` — [P1] `setStoreDay` up to 5 statements each in its own transaction; `withUser`.
- `apps/web/app/store/actions.ts:487` — [P1] `getWeekdayShape` 91-day scan on every first-day write; cache per §3 item 9.
- `apps/web/app/store/actions.ts:298` — [P2] Per-override insert loop; one multi-row insert via `unnest` as `setStoreDay` does at :496–500.
- `apps/web/app/store/actions.ts:87` — [P2] `applyStockoutFixes` N sequential upserts; one multi-row upsert inside `withUser`.
- `apps/web/app/store/actions.ts:172` — [P2] `setStorePhoto` accepts 1.4 MB base64 into a Postgres column read on every view; Supabase Storage / Netlify Blobs, persist the URL.
- `apps/web/app/store/actions.ts:156` — [P3] Shared Sydney formatter. `:36` single-statement actions need no change.
- `apps/web/app/store/xero-actions.ts:67` — [P2] `xeroTenantId` fetched from Xero before every invoice though fixed for a Custom Connection; module-level constant after first success. `:44` no change.
- `apps/web/lib/xero.ts:151` — [P2] `GET /connections` per invoice; cacheable. `:111` token stays uncached by documented decision.
- `apps/web/lib/xero-invoice.ts:94` — [P3] `weekQty(l)` computed twice per line; map once.
- `apps/web/lib/shelfcap.ts:56`, `lib/store-scoring.ts:87` — No change: O(1) pure.
- `apps/web/lib/dayshare.ts:38` — [P3] `wsum` recomputed with `indexOf` per element on every call; expose `weekWeights()` once per line and a day→index `Map`. `:26` trivial.
- `apps/web/lib/bake.ts:14` — [P3] Regex literal inside the arrow; hoist (`js-hoist-regexp`).

### 6.4 Floor apps and boards

- `apps/web/components/PackingApp.tsx:142` — [P1] See §5. Debounce ~400 ms trailing in a ref, latest-request id, flush on `pagehide`/`visibilitychange`.
- `apps/web/components/PackingApp.tsx:170` — [P1] See §5. Persist pending map per `day`, replay on mount/`online`.
- `apps/web/components/PackingApp.tsx:341` — [P2] Every store row and its line buttons are inline JSX with fresh closures; one tick re-renders ~27 rows. `memo()`'d `StoreRow` + `useCallback` (compiler covers).
- `apps/web/components/PackingApp.tsx:450` — [P2] Hidden print slip (every store × item) rebuilt on every tick; `memo()`'d `PackSlip` keyed on `run.run_id`.
- `apps/web/components/PackingApp.tsx:200` — [P3] Toast timer cleanup. `:297` no change (already memoised).
- `apps/web/app/packing/page.tsx:48` — [P2] Two separate `withUser()` calls in `Promise.all` plus a third at :61 = three transactions per request; one closure.
- `apps/web/app/packing/page.tsx:52` — [P1] `getWeekdayShape()` per render; `unstable_cache` revalidate 3600 tag `weekday-shape`, called outside `withUser`.
- `apps/web/app/packing/page.tsx:50` — [P2] `getPackingDays()` changes nightly; same treatment, tag `plans`.
- `apps/web/app/packing/page.tsx:32` — [P3] `Intl.DateTimeFormat` per planned day; hoist.
- `apps/web/components/DriverApp.tsx:107` — [P1] See §5. IndexedDB outbox (`idb-keyval`) written before the action, replayed on mount and `online`.
- `apps/web/components/DriverApp.tsx:239` — [P2] Stream leak on ✕ during pending `getUserMedia`; cancelled flag, stop immediately if the cam screen is gone.
- `apps/web/components/DriverApp.tsx:301` — [P3] Photo round-trips through base64; `canvas.toBlob` + `URL.createObjectURL`.
- `apps/web/components/DriverApp.tsx:181` — [P3] `readAsDataURL` on a 3–5 MB licence photo; `createImageBitmap(file)`.
- `apps/web/components/DriverApp.tsx:196` — No change: localStorage licence read is the right pattern under SSR. `:591`, `:432` no change.
- `apps/web/app/driver/page.tsx:21` — [P2] `getStoreAddresses()` ships all 265 addresses though only the stops in `runs` are read; join into `getPackingRuns` or filter before passing. `:16` hoist formatters.
- `apps/web/app/driver-proof-actions.ts:56` — [P1] `saveDeliveryProof` and `recordDelivery` run two `q()` statements each outside `withUser`; one delivery with photo + signature = 6 transactions across 3 requests. `withUser` per action.
- `apps/web/app/driver-proof-actions.ts:91` — [P2] Upsert + child insert as one `with d as (insert … returning id)` statement.
- `apps/web/app/driver-proof-actions.ts:182` — [P2] `recordDelivery` re-runs the identical upsert `saveDeliveryProof` runs seconds later; return the id, or merge into one action per stop.
- `apps/web/lib/driver-proof.ts:63` — [P2] No timeout on mint fetch or storage PUT; `AbortSignal.timeout(20000)`, treat abort as the no-signal branch. `:18` `fetch(dataUrl).blob()` or hand over a Blob.
- `apps/web/lib/driver-day.ts:73` — No change.
- `apps/web/app/api/driver/proof/upload-url/route.ts:52` — [P3] `supabaseAdmin()` builds a new client per request (`lib/supabase/admin.ts:33`); memoise at module scope. `:30` no change.
- `apps/web/components/ProductionBoard.tsx:217` — [P1] See §5. Check `res.ok`, revert on failure, debounce bursts.
- `apps/web/components/ProductionBoard.tsx:213` — [P2] Nudges and baked ticks memory-only; mirror to localStorage keyed by ISO week/day.
- `apps/web/components/ProductionBoard.tsx:514` — [P2] ~70 inline rows; each stepper keystroke (:535) or search (:467) re-renders all; `memo()`'d `ProductRow`, `useDeferredValue(term)` (compiler covers the memo half).
- `apps/web/components/ProductionBoard.tsx:248` — [P3] Four passes per render; one `useMemo`. `:260` toast cleanup.
- `apps/web/app/production/page.tsx:18` — [P1] `getWeekdayShape()` and `getTraySizes()` re-queried every render; `unstable_cache` both. `:44` no change.
- `apps/web/components/DeliveriesBoard.tsx:27` — [P1] `detail` (~2,500 store×product rows) serialised on every load but only shown on expand, and `product_id` never read; trim, and load per-store detail lazily on expand.
- `apps/web/components/DeliveriesBoard.tsx:138` — [P1] Seven totals each walk 265 lines calling `dayShare` on every render and keystroke; `useMemo` on `[lines, eng, approved, day, DOWMULT]`, `useDeferredValue(term)`, `memo` a `StoreRow`.
- `apps/web/components/DeliveriesBoard.tsx:89` — [P1] See §5.
- `apps/web/components/DeliveriesBoard.tsx:85` — [P2] Draft nudges lost on refresh; localStorage keyed by week.
- `apps/web/components/DeliveriesBoard.tsx:404` — [P2] Inline row + product-row JSX; extract `memo()`'d rows (compiler covers). `:180` toast cleanup.
- `apps/web/app/deliveries/page.tsx:20` — [P1] `getWeekdayShape()` and `getRuns()` reference reads; `unstable_cache` (`weekday-shape`, `runs` tag revalidated by `saveRunDays`).
- `apps/web/app/deliveries/page.tsx:20` — [P2] `getDeliveryPlan()` and `getDeliveryDetail()` rebuild the same `reco` CTE and aggregate twice; one query grouped server-side.
- `apps/web/components/DeliverySheet.tsx:91` — [P1] `rowTotal`/`colTotal` recomputed from scratch per render; one keystroke does ~4×(40×265) additions and re-renders ~10,000 inputs. `useMemo` totals on `[cells, products, stores]`, `memo` a `SheetRow`.
- `apps/web/components/DeliverySheet.tsx:127` — [P1] ~10k live inputs with no windowing; `content-visibility:auto; contain-intrinsic-size` on rows, or `@tanstack/react-virtual` if measured.
- `apps/web/components/DeliverySheet.tsx:68` — [P2] `setFlash` per keystroke forces a full-grid re-render to animate one cell; CSS `:focus` animation or scope to the row. `:27` trim unread plan fields.
- `apps/web/app/delivery-sheet/page.tsx:18` — [P2] Same duplicated `reco` CTE; the sheet only needs `detail` + store name/region/pm.
- `apps/web/components/RunBoard.tsx:168` — [P2] `router.refresh()` after saving run days re-renders `/map` including the full `getMapStores()` view; patch `sel.days` from the action's `added`/`removed`. `:116` no change.
- `apps/web/components/NetworkMap.tsx:159` — [P1] `onMouseMove` sets state per pointer move and each render recomputes `worst`, `counts`, `byRegion`, `regionList` and the full `placed` layout (:68–124) before re-rendering 265 dots; `useMemo` on `[stores]`, throttle the tooltip with a ref + `requestAnimationFrame`, `memo` a `Dot`.
- `apps/web/components/NetworkMap.tsx:155` — [P2] `effOf` up to four times per dot per render; precompute `kind` into `placed`. `:51` fold `worst` into the memo.
- `apps/web/app/map/page.tsx:24` — [P2] `getMapStores()` reads the full `v_store_week` for a diagram that changes daily; cached store-week. `:26` no change.
- `apps/web/app/map/actions.ts:55` — [P1] `saveRunDays` 2 + added + removed statements via `q()` with no transaction; mid-loop failure leaves stores half-migrated. `withUser`.
- `apps/web/app/map/actions.ts:86` — [P2] Per-day loops → two set-based array statements returning touched ids once.
- `apps/web/app/run-state-actions.ts:154` — [P1] See §5. `mergeRunState` with a per-store delta and tombstone.
- `apps/web/app/run-state-actions.ts:153` — [P2] `getDisplayUser()` per action call, and the floor clients call an action per tap; combine `recordDelivery` + `setDriverState`, debounce packing writes. `:38` no change.
- `apps/web/lib/today-lists.ts:84` — No change.

### 6.5 Setup, settings, feeds, login

- `apps/web/components/SeasonalityCalendar.tsx:139` — [P2] `eventsOn()` linear-filters all events and the 42-cell grid (:321–322) calls it twice per cell plus `dayMult` (:177); ~90 scans per keystroke in the add form. `Map<dateKey, Evt[]>` in `useMemo` on `[events, year, month]`.
- `apps/web/components/SeasonalityCalendar.tsx:326` — [P2] 42 cells with fresh `onClick` and `style` objects re-render on every form keystroke; `memo()`'d `DayCell` + `useCallback`.
- `apps/web/components/SeasonalityCalendar.tsx:258` — [P2] `router.refresh()` after `addSeasonalEvent` re-runs `getWeekdayShape`'s 91-day aggregate to pick up one row; action `returning id`, append locally.
- `apps/web/components/SeasonalityCalendar.tsx:116` — [P3] `nowSyd` built per render but only read by initialisers; lazy `useState(() => …)`. `:189` `cells`/`monthEvents` per render, `useMemo` (compiler covers). `:271` toast cleanup. `:478` 85-line `<style>` hoist.
- `apps/web/app/seasonality/page.tsx:16` — [P2] `getWeekdayShape` per visit; TTL / `unstable_cache`. `Promise.all` inside `withUser` fine.
- `apps/web/app/seasonality/actions.ts:50` — [P3] Add `returning id::text` so the client can skip the refresh. `:29` no change.
- `apps/web/components/NewStoreSetup.tsx:227` — [P2] `rangedOut`/`basket` reset via `useEffect` on `[size, type, autoKey]` causes a stale render then a second; derive during render or `key` the section (`rerender-derived-state-no-effect`).
- `apps/web/components/NewStoreSetup.tsx:259` — [P3] `grouped` from module constants rebuilt per render; hoist. `:402` tiny list, no memo needed. `:523` static `<style>` hoist.
- `apps/web/app/new-store/page.tsx:18` — [P2] `getRegionNames` + `getRuns` reference data per request; TTL cache. `regions` is only a fallback when no run is picked (`NewStoreSetup:156`), so skip when `runs.length > 0`.
- `apps/web/app/new-store/actions.ts:92` — [P2] `createStore` three statements through `q`, each its own transaction (~12 round trips); one `withUser`, fold the run lookup into the insert.
- `apps/web/app/new-store/actions.ts:176` — [P2] `createRun` same shape; one transaction also makes regions/runs atomic (today a failed runs insert orphans a region).
- `apps/web/components/NewProductSetup.tsx:90` — [P2] `codeClash` runs `normCode` over every product three times per keystroke; three `Map<normCode, product>` in `useMemo` on `[products]`.
- `apps/web/components/NewProductSetup.tsx:99` — [P2] `byRun` regroups ~265 stores per filter keystroke; `useDeferredValue(filter)`, memo the grouped base on `[stores]`.
- `apps/web/components/NewProductSetup.tsx:277` — [P2] ~265 store buttons with fresh `onClick` re-render on every keystroke anywhere in the form; `memo()`'d `StoreRow` + stable toggle; `content-visibility:auto` on `.prow` (:378).
- `apps/web/components/NewProductSetup.tsx:156` — [P3] `router.refresh()` after create re-fetches two statements to add one product; append the returned row.
- `apps/web/app/new-product/page.tsx:13` — [P2] `getProductCodes` serialises `category/pack/uom/qty` the component never reads; trim. Both lists reference data; TTL cache.
- `apps/web/app/new-product/actions.ts:96` — [P2] Up to four statements each in its own transaction; one `withUser` (also makes insert + ranging atomic), merge the two checks into one select.
- `apps/web/components/NewRunSetup.tsx:36` — [P3] ≤34 runs; negligible. `:46` refresh to add one row could be a local append.
- `apps/web/app/new-run/page.tsx:12` — No change.
- `apps/web/components/SettingsPanel.tsx:145` — [P3] Toast cleanup. `:349` 75-line `<style>` hoist. `:107` correct already.
- `apps/web/app/settings/page.tsx:16` — [P2] Comment claims parallel round trips but `withUser` serialises them (comment wrong, code fine). `getEngineProjection`/`getAppSettings` → TTL cache; `getFeedStatus` → read via `cache()`'d `getFeedHealth`.
- `apps/web/app/settings/actions.ts:38` — No change.
- `apps/web/components/FeedUpload.tsx:72` — [P3] Constants recreated per render; hoist. `:136` refresh is needed here; keep. `:339` up to 200 reject `<li>`; `content-visibility:auto` on `.fu-rej li` (:394). `:353` static `<style>` hoist.
- `apps/web/app/feeds/page.tsx:33` — [P2] `getFeedHealth` runs twice per request (layout `FeedAlarm` + here); React `cache()`. `getFeedGaps` is a second 14-day scan per visit; one view returning health + gaps, or refresh after ingest. `:108` no windowing needed.
- `apps/web/app/api/feeds/[retailer]/route.ts:66` — [P2] `runAsUser` wraps the whole handler, so the multipart read (:132) and the ~4 s ExcelJS parse (`ingest.ts:95`) hold a pooled connection inside an open transaction; parse first, then open the transaction.
- `apps/web/app/api/feeds/[retailer]/route.ts:129` — [P2] `await admin.storage.remove()` on the response path before the parse; `after()` from `next/server`.
- `apps/web/app/api/feeds/[retailer]/route.ts:117` — [P3] Blob → `arrayBuffer()` → `Buffer.from` = three copies of up to 15 MB; pipe `dl.data.stream()` into the `WorkbookReader`.
- `apps/web/app/api/feeds/[retailer]/upload-url/route.ts:40` — [P3] `getSessionClaims()` network verify after proxy verified the same token (global auth item).
- `apps/web/app/api/feeds/mail-poll/route.ts:221` — [P2] `ingestWorkbook` inside `db()` so the 4.9 MB parse (~4.3 s, 276 MB) holds a pooler connection in a transaction; split parse (outside) from write (inside). `:181` three transactions per message is deliberate; no change.
- `apps/web/app/api/feeds/harris-farm-pull/route.ts:124` — [P3] Weeks fetched strictly sequentially; `Promise.all` the CSV fetches for backfills, ingest sequentially. `:127` same parse-inside-transaction note.
- `apps/web/lib/feeds/ingest.ts:121` — [P1] Staging inserts in 2,000-row chunks, one round trip each: a 100,501-row Woolworths file is ~51 sequential statements ≈ 6.6 s of pure latency out of a 60 s budget. postgres.js `COPY … FROM STDIN` (`sql\`copy …\`.writable()`), or raise `CHUNK` to ~8,000 (under the 65,535-param cap).
- `apps/web/lib/feeds/ingest.ts:95` — [P2] Export `parseReport()` and `writeParsed()` separately so parsing never holds a connection.
- `apps/web/lib/feeds/ingest.ts:158` — [P3] Four sequential post-load statements; have `jb_load_feed_upload` return counts + rejects, move the staging delete to `after()`.
- `apps/web/lib/feeds/coles.ts:272` — [P2] Streaming reader is right, but every non-empty row is rebuilt into ExcelJS `Row`/`Cell` objects (+488 MB at 500k rows, forcing the 15 MB cap); keep rows as plain `unknown[][]` for a 5–10× memory cut.
- `apps/web/lib/feeds/coles.ts:248` — [P3] `Buffer.from(bytes)` copies; wrap with `Buffer.from(bytes.buffer, byteOffset, byteLength)`. `:436` header scans negligible.
- `apps/web/lib/feeds/harrisfarm.ts:203` — [P3] `cols.includes(k)` per key per row; use a `Set` (backfills only). `:120` login once per run; no change.
- `apps/web/lib/feeds/graph.ts:82` — [P3] Token fetched every run by design; module cache keyed on `clientId+secret` with `expires_in` is safe under rotation. `:251` Graph `$batch` only helps backfills; `$select` already excludes `contentBytes`.
- `apps/web/lib/feeds/mailbox.ts:52` — No change.
- `apps/web/app/launches/actions.ts:25` — No change.
- `apps/web/app/products/actions.ts:38` — [P3] Two statements = two transactions; `insert … where not exists` or one `runAsUser`.
- `apps/web/app/login/page.tsx:92` — [P3] Same ~40-line `.login*` `<style>` inlined in login, forgot (:79) and reset (:101); `NotFoundPanel:35` depends on those classes and is unstyled. Move to `globals.css`.
- `apps/web/app/login/reset/page.tsx:31` — [P2] Raw `supabase.auth.getUser()` network trip after proxy already verified; use the `cache()`'d helpers.
- `apps/web/app/login/actions.ts:20`, `SubmitButton.tsx:17`, `forgot/page.tsx:24`, `auth/callback/route.ts:18`, `auth/signout/route.ts:8`, `lib/nav-access.ts:71`, `lib/safe-next.ts:22`, `app/manifest.ts:25`, `app/not-found.tsx:9` — No change.
- `apps/web/components/NotFoundPanel.tsx:35` — [P3] See login note.

### 6.6 Query layer (`apps/web/lib/queries.ts`)

Each line: statement count, callers, and the one action: (a) React `cache()`, (b) cross-request cache, (c) combine statements, (d) N+1 → set-based, (e) move work to SQL / materialised view, (f) no change.

- `:56` `getAsOf` — 1 stmt; Overview. (f).
- `:66` `getNetwork` — [P2] 1 stmt re-aggregating the same window as `v_store_week`; Overview, assistant. (e) derive from the store-week rows already held.
- `:75` `getStoreWeek` — [P1] heaviest view (~1 s); ten pages + four product queries. (e)+(b)+(a) per §3 item 4.
- `:83` `getRegions` — [P2] another full re-aggregation; Overview. (e) group the fetched rows by region.
- `:96` `getRegionNames` — [P3] (b) tag `regions`.
- `:106` `getWasteTrend` — [P3] no callers; dead export.
- `:138` `getEngineProjection` — [P2] (b) tag `engine`.
- `:165` `getDeliveryPlan` — [P2] three correlated subqueries per store; deliveries, delivery-sheet. (c) take `has_sales_feed` from cached store-week; `LEFT JOIN LATERAL` for pm.
- `:227` `getDeliveryDetail` — [P3] shares the `reco` CTE verbatim with plan and production. (c).
- `:283` `getTraySizes` — [P2] (b) tag `products`.
- `:308` `getProductionPlan` — [P3] (f).
- `:370` `getProducts` — [P1] inlines the full `v_store_week` + 7-day sub-aggregate; runs outside `withUser`. (e) cached store-week for `has_sales_feed`, wrap page.
- `:454` `getProductById` / `:501` `getProductStores` — [P2] both scan `store_reco ⋈ v_store_week` for the same product. (c) one statement; P3 index `store_reco(product_id)` if it grows.
- `:555` `getProductLaunches` — [P3] (e) `has_sales_feed` from cached store-week.
- `:630` `getFeedStatus` — [P2] same as `v_feed_health` minus `last_upload`; Overview, settings. (a)+(b) read via `getFeedHealth`.
- `:717` `getRegionStores` — [P2] outside `withUser`. (e) filter cached rows; wrap page.
- `:728` `getStoreById` — [P1] full view for one row while the store page also calls `getStoreWeek`. (c) drop it.
- `:741` `getStoreRecos`, `:764` `getStoreOverrides`, `:782` `getStoreRanging` — [P3] (c) subsets of `getStoreStandingOrder` (:3056); add `ranged`/`recommended` there and drop three statements.
- `:794` `getStoreServiceLevel`, `:805` `getStoreLastVisit`, `:862` `getStoreShelfCap`, `:1021` `getStorePhoto` — [P1] four reads of one `store_settings` row. (c) one `stores ⋈ store_settings` read with `:1007` `getStoreAddress` and `:3046` `getStoreXeroContact` (~650 ms saved).
- `:818` `getStoreStates` — [P2] (b) tag `stores`, or add `state` to the store-week view.
- `:844` `getRuns` — [P2] (b) tag `runs`.
- `:881` `getShelfCapOverrides` — [P3] (f).
- `:904` `getPeakDaySold` — [P2] scans the identical window as `v_store_week`. (e) `peak_day_sold` column on the store-week view.
- `:930` `getFeedHealth` — [P1] root layout on every route outside `withUser` + `/feeds`. (a)+(b) tag `feed-health`, revalidate 600.
- `:961` `getFeedGaps` — [P3] unbounded `distinct source` over 1.15 M rows. (e) `enum_range(null::retailer_type)` or `v_feed_health`; bound `have` both ends.
- `:993` `getFeedUploads` — [P3] (f); index `feed_uploads(uploaded_at desc)` only if it grows.
- `:1034` `getAppSettings` — [P2] (b) tag `app-settings`, revalidated by the settings action.
- `:1051` `getRunState` — [P3] (f).
- `:1077` `getPackingState`, `:1100` `getPackingFinalised`, `:3150` `getDriverState` — [P3] (c) one `where surface in (…) and day=$1` read.
- `:1111` `getStoreDaily`, `:1303` `getStoreProducts` — [P3] no callers; dead exports.
- `:1148` `getStoreDayGrid`, `:1206` `getStoreSellouts` — [P2] `outs` CTE duplicates the sellouts predicate. (c) one statement, count `sellout_lines` in JS.
- `:1252` `getStoreSchedule` — [P3] (c) join into the single store-row read.
- `:1285` `getRunPicklist` — [P2] (b) tag `runs`.
- `:1371` `getRecommendations` — [P3] (f) already deduped and set-based.
- `:1449` `getBenchmarks` — [P2] outside `withUser`; (e) cached store-week, wrap page.
- `:1539` `getOpportunities` — [P2] 3 stmts outside `withUser` = 12 round trips. Wrap; cached store-week.
- `:1651` `getStoreRevenueWeek` — [P2] another 7-day aggregate; Overview, store page, opportunities, stockouts. (e) fold `revenue_wk`/`avg_unit_revenue` into the store-week view, or (b) tag `store-week`.
- `:1723` `getStockouts` — [P2] 3 stmts outside `withUser`. Wrap.
- `:1786` `getMapStores` — [P2] (e) project from cached store-week.
- `:1813` `getArchivedStores` — [P3] query fine; wrap page.
- `:2071` `getLaunches` — [P2] three serial statements. (a) cached store-week, run pipeline read concurrently.
- `:2173` `getForecastAccuracy` — [P1] two 182-day aggregates sequential + JS backtest per load, outside `withUser`. (e)/(b) `unstable_cache` around the whole function on the raw client, or `mv_weekly_sales` refreshed nightly.
- `:2348` `getWeekdayShape` — [P1] 91-day scan on four pages + an action. (b) tag `weekday-shape`, revalidate 3600.
- `:2430` `getSeasonalEvents` — [P2] joins `v_event_scope` (migration 063, heavier than it looks). (b) tag `events`.
- `:2500` `getRunBoard`, `:2553` `getRunRoster` — [P3] (b) tag `runs`; roster could be one `UNION ALL`.
- `:2640` `getPackingDays` — [P3] (c) hoist into the same `withUser` as the main read.
- `:2653` `getPackingRuns` — [P2] JS `run.stores.find()` inside the row loop is O(rows×stores); `Map` keyed by store_id (`js-index-maps`). SQL fine.
- `:2872` `getDriverDayCounts` — [P3] (f).
- `:2930` `getEngineHealth` — [P3] (b) revalidate 300.
- `:2949` `getRunsWithCounts` — [P3] (f).
- `:2969` `getStorePicklist`, `:2987` `getProductCodes`, `:3118` `getProductPicklist`, `:3132` `getStoreAddresses` — [P2/P3] (b) tags `stores` / `products`.
- `:3056` `getStoreStandingOrder` — [P2] already carries per-product sent/override/mode/dates; extend and drop recos/overrides/ranging.

### 6.7 Database and forecast service

- `db/migrations/050_asof_as_a_constant.sql:77` — [P1] Latest `v_store_week` (five 7-day aggregates + `feed` distinct); candidate for `create materialized view mv_store_week` with a unique index on `store_id`, `refresh … concurrently` from `jb_run_engine` (045) and at the end of each ingest.
- `db/migrations/051_revenue_week_asof.sql:30` — [P3] `v_store_revenue_week` scans the same window; fold into the store-week matview.
- `db/migrations/041_feed_health_materialize.sql:38` — [P3] "materialized" here is a CTE hint, not a view; no materialised views exist in the repo today.
- `db/migrations/066_feed_clock_is_the_calendar.sql:94` — [P3] `v_feed_health` bounded and index-backed; correlated `max(uploaded_at)` per retailer has no `(retailer, status, uploaded_at)` index; negligible today.
- `db/migrations/086_the_clock_was_made_of_the_wrong_table.sql:89` — [P3] `v_asof` fine.
- `db/migrations/001_init.sql:168` — [P3] Hot-path indexes on `sales_daily` exist (`(store_id, sale_date)`, `(sale_date)`, PK, 030 adds `(source, sale_date)`); nothing missing.
- `db/migrations/001_init.sql:226` — [P3] `wastage` only has its PK; index `waste_date` only if the table stops being all-zero.
- `db/migrations/033_engine_nightly_run.sql:68` — [P3] `store_reco(product_id)` index if the table grows past a few thousand rows.
- `services/forecast/app.py:113` — [P1] `build_plan` is N+1 three ways per store×product (`weekday_stats`, `event_uplift`, `on_hand_ledger`), ~15,000+ statements per plan; three set-based queries up front and a dict join.
- `services/forecast/app.py:119` — [P3] `event_uplift` depends only on `(target, state)`; `functools.lru_cache` saves thousands of identical queries before the rewrite.
- `services/forecast/app.py:40` — [P2] `psycopg.connect` per request; `psycopg_pool.ConnectionPool` at module level.

---

## 7. Cost notes

Nothing above adds a paid service. Where a choice exists, the free one is named first.

- `unstable_cache` on Netlify is backed by Netlify Blobs, included in the plan. React `cache()` and module-level maps cost nothing.
- A materialised view lives in the existing Supabase Postgres; refresh is a line in the existing pg_cron job.
- Local JWT verification removes two Supabase Auth calls per request; fewer auth API hits, shorter function durations.
- Supabase Storage for the store photo is on the free tier and cheaper than a 1.4 MB row read per view.
- The IndexedDB outbox is `idb-keyval` (~600 bytes), client-side only.
- Not recommended: Redis/Upstash for the store-week cache (a paid dependency the matview replaces), and `@tanstack/react-virtual` until `content-visibility` has been measured as insufficient.

## 8. Suggested order

1. `reactCompiler: true`, `next/font/google`, local JWT verification (proxy + server + auth). One PR, no behaviour change, biggest per-request drop.
2. `withUser` around the seven bare pages and the multi-statement actions. Correctness and atomicity as well as round trips.
3. Floor data-safety set (§5): debounce + outbox + `mergeRunState` + `res.ok`.
4. Store-week caching (matview or `unstable_cache`) and the reference-data caches; then the store page statement collapse and photo route.
5. Component memo pass only where the compiler does not reach: search inputs (`useDeferredValue`), `router.refresh()` → local state, `NetworkMap`/`DeliverySheet` layout memo, `content-visibility` on the long tables.
6. Feed ingest `COPY`, parse-outside-transaction, forecast engine N+1.

Run `/benchmark` before step 1 and after each step so the numbers, not the notes, decide what ships.
