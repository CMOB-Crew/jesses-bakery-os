# Performance fix plan — generator

One source, two outputs.

| File | What it is |
|---|---|
| `items.js` | The only file you edit. Every card (title, problem, fix, where, check, example), the phase descriptions, the stop-and-ask text for optional groups, and the glossary. |
| `build.js` | Reads `items.js` and writes `PERFORMANCE-FIXES.md` at the repo root and `checklist.html` here. |
| `template.html` | The page shell. Layout and styling only; no card text lives in it. |
| `checklist.html` | Generated. The shared checklist page. Do not edit. |

## Change the wording of a card

```
# edit docs/perf/items.js
node docs/perf/build.js
```

Ticks already made in `PERFORMANCE-FIXES.md` are kept. Each card carries a `<!-- card:id -->` marker and the script reads the `- [x] Done` state back before rewriting the file. Never change a card's `id`; that is what the tick is keyed on.

## Republish the page

The live page is a Claude artifact. After running the build, republish `docs/perf/checklist.html` to the same link so open views reload:

- From the conversation that created it: publish the same file path.
- From any other conversation: publish with the artifact's URL passed as `url`. The current link is https://claude.ai/code/artifact/eb42ced5-919f-4259-9db2-9208ab13768f

Status clicks on the page (To do / Doing / Done / Skip) are stored inside the page itself and are shared with everyone who has the link. A republish from the build replaces the page but keeps its status block only if you republish the live version; when in doubt, read the live artifact first and copy its `<script id="state">` block into the new file before publishing.

## Rules

- No card may change the database. Database ideas go in the Parked group with `optional: true` and a `gate` sentence.
- Groups with `optional: true` get a stop-and-ask box on the page and a STOP note in the markdown automatically.
- Do not mention hosting regions in card text. Say "server".
- Keep each paragraph to four sentences or fewer, and one fix per card.

The rules that keep the fixed problems from coming back are in the repo-root `CLAUDE.md`. The agent workflow is the `/perf-fixes` skill in `.claude/skills/perf-fixes/SKILL.md`.
