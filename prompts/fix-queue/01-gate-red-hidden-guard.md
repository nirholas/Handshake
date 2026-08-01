# 04. The repo gate is RED: one page has no `[hidden]` guard

**Severity: P0 for the repo.** Small fix, but it is currently the thing standing
between this worktree and a green gate, which means every other agent's
"gate before and after" check starts dirty. Read [00-INDEX.md](00-INDEX.md)
first.

## Symptom (reproduced 2026-08-01)

```
$ npm run gate
...
> audit:hidden-guard

x 1 page(s) do not resolve a [hidden]{display:none} guard:

  pages/docs-freshness.html

gate exit=1
```

Every other stage of the gate passes: `test:gate`, `test:gate-3d`, `audit:mcp`,
`audit:mcp-golden`, `audit:routes`, `audit:handlers` (1888 handlers),
`audit:pages` (161 routes), `audit:docs` (1236 markdown files),
`check:tutorials` (69/69), `audit:x402-catalog`, `audit:tokens`.

## Why this rule exists

The `hidden` attribute only hides an element if some stylesheet actually
declares `[hidden]{display:none}`. Without it, a component that sets `display`
on a class or id (a full-screen modal, for example) renders on top of the page
and blocks all interaction. This is a real broken-page class, not a lint
preference.

[pages/docs-freshness.html](../../pages/docs-freshness.html) links only
`/fonts/fonts.css` and `/docs-freshness.css`, neither of which carries the
guard, and it has no inline guard.

## The job

1. Decide which fix is right for this page rather than reflexively stamping it.
   The audit accepts either an inline guard or a link to `/tokens.css`,
   `/style.css`, or `/nav.css`. A page in the docs family should almost
   certainly be inheriting the design tokens the rest of the site uses, so check
   what its siblings link and whether this page is an accidental orphan. If it
   is, linking the shared stylesheet fixes the guard AND the visual drift; if it
   is deliberately standalone, stamp the inline guard with
   `node scripts/inject-hidden-guard.mjs --write`.
2. Load the page in a browser after the change (`npm run dev`, then
   `/docs-freshness`) and confirm you did not restyle it by accident. Check that
   nothing is now double-styled and that no console errors appear.
3. Re-run the full gate, not just the one audit.

## Verification

```bash
npm run audit:hidden-guard   # via: node scripts/audit-hidden-guard.mjs
npm run gate                 # must exit 0
```

## Done when

`npm run gate` exits 0 on a clean checkout of this worktree, the page renders
identically or better, and [00-INDEX.md](00-INDEX.md)'s "the gate is currently
RED" note is deleted because it is no longer true.
