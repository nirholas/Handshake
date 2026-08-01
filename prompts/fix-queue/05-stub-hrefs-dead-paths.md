# 08. 108 stub `#` links: buttons that exist and go nowhere

**Severity: P2 by count, higher by principle.** CLAUDE.md: "If a button exists,
it must work. If a link exists, it must go somewhere." Read
[00-INDEX.md](00-INDEX.md) first.

## Symptom (reproduced 2026-08-01)

```
$ npm run audit:links
Link audit - scanned 1996 files
Broken internal links : 0
Stub hrefs (#, void(0)) : 108
exit=1
```

Broken internal links are at zero, which is the good news: nothing points at a
missing file. The 108 are anchors whose `href` is `#` or `javascript:void(0)`.

The heaviest concentrations, from the audit output:

- [pages/agent-edit.html](../../pages/agent-edit.html): 11 (lines 1194, 1195,
  1424, 1550, 1581, 1788, 1803, 2172, 2176, 2188, 2192)
- [pages/create-agent.html](../../pages/create-agent.html): 4 (1773, 1776, 1779,
  1782)
- [pages/agent-detail.html](../../pages/agent-detail.html): 3;
  [pages/agent-detail-classic.html](../../pages/agent-detail-classic.html): 3
- [pages/genesis.html](../../pages/genesis.html): several, starting at 265
- Singles across `alpha-copilot`, `arm`, `avatar-wallet-chat`, `billing`,
  `communities`, `create-prompt`, `dad`, `embed-walk`, `events/*`, and more.
  Run the audit for the current full list; do not work from this excerpt.

## Triage rule: not every `#` is a defect

Sort every one of the 108 into exactly one bucket and record which:

1. **A real anchor with a JS handler attached** (a tab, a toggle, a menu). It
   works, but `<a href="#">` is the wrong element: it puts a junk history entry
   in the back button and reads as a link to assistive tech. Convert to
   `<button type="button">` with the appropriate ARIA, keeping the handler and
   the visual style. This is most of them, and it is an accessibility fix, not
   busywork.
2. **A genuine dead path**: a link whose destination was never built. Either
   wire it to the surface it promises or remove the affordance. Do not leave a
   control that lies.
3. **A same-page jump** that lost its target id. Restore the id.

## The job

1. Run the audit, capture the full list to a file, and classify all 108.
2. Fix them by bucket, starting with `agent-edit.html` and `create-agent.html`,
   which are authoring surfaces where a dead control costs a user real work.
3. For every element you convert, verify keyboard operation: focus ring visible,
   Enter and Space both activate, tab order unchanged.
4. Re-run `npm run audit:a11y` afterwards, because bucket 1 changes markup that
   audit reads.
5. If any control turns out to be dead because a feature was never finished,
   that is a separate finding: write it into [PROGRESS.md](PROGRESS.md) with the
   page and line rather than quietly deleting the button.

## Verification

```bash
npm run audit:links          # Stub hrefs: 0
npm run audit:a11y
npm run gate
```
plus a keyboard-only pass over `agent-edit` and `create-agent` in a browser.

## Done when

The stub count is zero, every former stub is either a real button or a real
link, keyboard operation is verified on the two authoring pages, and any
unfinished feature found behind a dead control is logged rather than hidden.
