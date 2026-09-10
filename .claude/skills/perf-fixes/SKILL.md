---
name: perf-fixes
description: Work the performance fix plan in PERFORMANCE-FIXES.md one card at a time, verify each, tick it, and stop before the optional phases. Use when asked to make the app faster, fix a performance card, continue the perf plan, or when the user types /perf-fixes.
---

# Performance fix plan

You are working a checklist that a code review produced. The checklist is `PERFORMANCE-FIXES.md` at the repo root. The rules that stop these problems coming back are in `CLAUDE.md` at the repo root. Read both before doing anything.

## Steps, every time

1. Read `CLAUDE.md` in full. Read the **Instructions for the agent** section of `PERFORMANCE-FIXES.md`.
2. Find the first card whose checkbox is `- [ ]`, going top to bottom. If the user named a card, use that one instead.
3. If that card is in **Phase 4** or **Parked**, do not start. Say, in one sentence: "The next card is in an optional group (Phase 4 or Parked). It carries more risk and Parked would change the database. Do you want to continue, and with which cards?" Wait for a yes for that group. A general "go ahead" from earlier does not count.
4. Read every file listed under **Where** on the card, in full, before editing. Line numbers are from 10 September 2026 and may have drifted; find the code by what it does.
5. Make the change described under **Fix**. The **Example** is a made-up snippet showing the shape; write the real change for the real code. Keep the diff to that card only.
6. Run the **Check** on the card. Then run `npm run lint` and `npm run build` in `apps/web`. If a `scripts/*-check.ts` covers the area, run it too.
7. If everything passes: change the card's `- [ ]` to `- [x]`, commit with the card title as the message, and stop. Tell the user which card is done, show the diff summary, and remind them to tick the same card on the shared checklist page.
8. If anything fails or the fix needs something the card does not say: undo, stop, and explain in plain words. Do not improvise a different fix.

## Never

- Never change the database: no migrations, schema, indexes, views, or data moves. If a card seems to need one, stop and ask.
- Never add `revalidatePath`, `loading.tsx`, Suspense streaming, `cacheComponents`, or link prefetching. See `CLAUDE.md` for why.
- Never do more than one card per run unless the user asks for a batch. Small diffs are the point.
- Never mark a card done without running its Check and the build.

## When all of Phases 1 to 3 are ticked

Say so, list what changed, and ask whether to run `/benchmark` to measure before and after. Then ask about Phase 4 and Parked as described in step 3.
