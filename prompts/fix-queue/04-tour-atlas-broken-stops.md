# 07. The guided tour has 17 broken stops, 6 of them pointing at nothing

**Severity: P1.** This is a first-run surface: the tour is what a new visitor is
handed, and a third of it is broken. Read [00-INDEX.md](00-INDEX.md) first.

## Symptom (reproduced 2026-08-01)

```
$ npm run audit:tour-atlas
audit:tour-atlas found 17 problem(s):
exit=1
```

Two distinct classes.

**Class A: the stop points at a route that answers nothing (6).** The tour sends
the visitor to a dead end.

| Stop | Target |
|---|---|
| `diorama` | `/diorama` |
| `mocap-studio` | `/mocap-studio` |
| `temporary` | `/temporary` |
| `scene` | `/scene` |
| `create-prompt` | `/create/prompt` |
| `three-live` | `/three-live` |

**Class B: the stop has no working spotlight anchor (11).** The guide dims the
whole page and points at nothing, which reads as a broken overlay rather than a
tour: `skills` (`/skills`), `agora` (`/agora`), `compose` (`/compose`),
`x402-studio` (`/x402/studio`), `terminal` (`/terminal`), `play-arena`
(`/play/arena`), `play-agent-wallet` (`/play/agent-wallet`), `demo` (`/demo`),
`unstoppable` (`/unstoppable`), `pump-visualizer` (`/pump-visualizer`),
`viewer` (`/viewer`).

Both classes are defined in
[scripts/build-tour.mjs](../../scripts/build-tour.mjs) (stops, and the `TARGETS`
selector map).

## The job

1. **Class A: decide per stop, do not bulk-delete.** For each of the six, find
   out whether the route was renamed, was never built, or is dynamic. A renamed
   route gets its stop repointed; a route that was never built gets its stop
   dropped from `build-tour.mjs`. Check `data/pages.json` and the route table in
   `vercel.json` before concluding a page does not exist, because a page can be
   real and simply not answer a naive HEAD.
2. **Class B: give each stop a selector that exists.** Open the page, pick a
   stable anchor (prefer an id or a data attribute that the page owns, not a
   generated class), and add it to `TARGETS`. If a page genuinely has no
   meaningful anchor, that is a signal about the page, not about the tour: add
   the anchor to the page.
3. **Walk the tour end to end in a browser** (`npm run dev`), not just the
   audit. A selector can exist and still be off-screen, zero-sized, or hidden
   behind a modal, and the audit cannot see that. Confirm the spotlight lands on
   something meaningful at every stop.
4. **Make the audit part of a stage** if it is not already, and register it in
   `data/guards.json` with a `why`, so 17 broken stops cannot accumulate again.
5. Add a `data/changelog.json` entry: this is a user-visible fix.

## Verification

```bash
npm run audit:tour-atlas     # 0 problems
npm run gate                 # no worse than the 00-INDEX.md baseline
```
plus a manual walkthrough of every stop at 1440px and at 390px.

## Done when

Every tour stop resolves to a live page and spotlights a real element, verified
in a browser at two viewport widths, with the changelog entry written.
