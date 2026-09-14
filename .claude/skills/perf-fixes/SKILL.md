---
name: perf-fixes
description: Work the performance fix plan in PERFORMANCE-FIXES.md one card at a time (or all of them when asked), verify each against the local database, tick it, and stop before the optional phases. Use when asked to make the app faster, fix a performance card, continue the perf plan, or when the user types /perf-fixes.
---

# Performance fix plan

You are working a checklist that a code review produced. The checklist is `PERFORMANCE-FIXES.md` at the repo root. The rules that stop these problems coming back are in `CLAUDE.md` at the repo root. Read both before doing anything. The card text lives in `docs/perf/items.js`; `PERFORMANCE-FIXES.md` is generated from it by `node docs/perf/build.js`, which keeps existing ticks.

## Before the first card (once per checkout)

1. `cd apps/web && npm ci`. There is no `node_modules` in a fresh worktree.
2. `apps/web/.env.local` is gitignored, so a new worktree or clone has none. Copy it from your main checkout, or ask the project owner for it. It must point `DATABASE_URL` at a local Postgres (the repo's scripts assume port 5433, database `jesses`) and keep `AUTH_ENFORCED=0`. The checks below write test rows (ticks, saves, a test feed file), so never run them against the hosted database. If the local database runs in Docker and the machine has no `psql`, query it with `docker exec <container> psql -U <user> -d jesses -Atc "..."`.
3. Run `npm run lint` and `npm run build` on the unchanged code. If either fails before you start, stop and say so; it is not a card.
4. Know the one check that may already be broken: `scripts/coles-parser-check.ts` throws an exceljs streaming-reader `TypeError` on an untouched checkout on Node 22.23.1 (`netlify.toml` records the same error on Node 24). Run it once before your first change; if it fails then, it is not a regression. Every other `scripts/*-check.ts` should pass on the unchanged code; if one does not, stop and say so before starting.
5. Auth is off locally. Anything a card says about being signed in, or about which screens a role sees, can only be checked on the preview site with `AUTH_ENFORCED=1`. Row-level security is different: it can be tested locally over a connection that is not a superuser, with claims set inside a transaction (see the row-level security rule in `CLAUDE.md`), but never through the local app if its connection is a superuser, which bypasses every policy. Do the local part and say plainly which part still needs the preview site.

## Steps, every card

1. Find the first card whose checkbox is `- [ ]`, top to bottom. If the user named a card, use that one. If the user asked for every card, work them in order, one commit each.
2. If the next card is in **Phase 4** or **Parked**, do not start. Say, in one sentence: "The next card is in an optional group (Phase 4 or Parked). It carries more risk and Parked would change the database. Do you want to continue, and with which cards?" Wait for a yes for that group. A general "go ahead" from earlier does not count.
3. Read every file under **Where** in full before editing. Line numbers are from 10 September 2026 and have drifted; find the code by what it does.
4. Make the change under **Fix**. The **Example** shows the shape only; write the real change for the real code. Keep the diff to that card.
5. Verify. Every card: `npm run lint`, `npx tsc --noEmit`, `npm run build`, and the `scripts/*-check.ts` for the area. Every card that touches a page: `npx next start -p 3456`, fetch the page with `curl` before and after, and compare the visible HTML with `<script>` and `<style>` stripped; it must be identical unless the card changes what is shown. Every card that changes an interaction: drive it in a headless browser (the `/browse` skill) and check the saved result in the database. Do not report a check you could not run as passed.
6. If everything passes: change the card's `- [ ]` to `- [x]` in `PERFORMANCE-FIXES.md`, run `node docs/perf/build.js` so the Progress lines update, commit with the card title as the message, and stage by path (`git add <files>`). Then tell the user which card is done and remind them to tick it on the shared checklist page. Do not republish the checklist page; its ticks are made by clicking.
7. If a check fails, or the fix needs something the card does not say, undo, stop, and explain in plain words. Do not improvise a different fix. If the card itself is wrong or impossible as written, say that, propose the executable version in one or two sentences, and only proceed when the user agrees (or the card text has been corrected in `docs/perf/items.js`).

## Two cards touching the same file

Commit the first card before editing for the second. If the two edits are already in the working tree, back the second card's lines out, commit the first, then reapply. Never use `git stash`; the stash is shared with other worktrees.

## What "executable" means for a fix

- It can be built from this repo and checked against the local database or a script in `scripts/`.
- It does not need a dashboard setting, a fixture that is not in the repo, a new protocol path to the database pooler, or a component rewrite the card did not ask for. If a card needs a person to do something (card 1's Supabase key switch), make the code change that is safe either way and record the human step in the report.
- The database schema never changes. No migrations, indexes, views or data moves.
- Never add `revalidatePath`, `loading.tsx`, Suspense streaming, `cacheComponents`, or link prefetching. See `CLAUDE.md`.

## Lint rules that will bite, and the accepted answers

- `react-hooks/exhaustive-deps` ("makes the dependencies of useMemo change on every render"): the function in the dependency list must be a `useCallback`.
- `react-hooks/preserve-manual-memoization`: a `useMemo` whose dependency list disagrees with what the compiler infers; list the real inputs, or drop the manual memo and let the compiler do it.
- Reading `ref.current` inside an effect cleanup: copy the ref to a local inside the effect.
- Setting state in an effect on mount from device storage: `// eslint-disable-next-line react-hooks/set-state-in-effect` with a one-line reason, the pattern the codebase already uses. Not for anything else.
- `@next/next/no-img-element`: a plain `<img>` is right for our own photo route, a data URL, or a static mark; disable it on that line with the reason.
- Do not disable a rule to make a card pass.

## Never

- Never change the database.
- Never mark a card done without running its Check and the build.
- Never claim a check that needs the preview site as passed from a local run.

## When all of Phases 1 to 3 are ticked

Say so, list what changed and what a person still has to do (dashboard steps, preview-site checks), and ask about Phase 4 and Parked as described in step 2.
