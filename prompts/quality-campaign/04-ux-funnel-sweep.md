# 04 - UX sweep: the core funnels feel like a top-tier product

Read `README.md` in this directory first (never-stop contract, standing approvals, shared
context). Never end a turn with a question.

## Mission

Walk the five funnels a real user actually takes, find every rough edge, and fix all of them:
missing loading/empty/error states, dead buttons, layout jank, unlabeled controls, confusing
copy, broken mobile layouts. The bar is CLAUDE.md's UI/UX standards section (every state
designed, transitions, responsive, accessibility, microinteractions). This is a fix-everything
sweep, not an audit report.

## The five funnels (in priority order)

1. **Text -> 3D**: home -> /forge -> generate -> result viewer -> download / AR / send-to-scene.
2. **Create an agent**: /create or /create-agent -> avatar generation -> agent profile -> embed code.
3. **Markets**: /markets -> /markets/news -> article reader -> /coin/:id detail.
4. **Worlds**: /play (join, move, interact) and /walk.
5. **Wallet-money paths**: premium pass purchase page rendering and x402 paywall UX (UI states
   only; never execute real payments without the confirmation gate).

## Tooling you already have (use it, do not rebuild it)

- `npm run dev` (port 3000). Real browser verification is mandatory per CLAUDE.md.
- `npm run audit:web`: authed console sweep across 300+ pages; QA account creds already in
  `.env`. Run it before AND after; your after-run must show strictly fewer errors.
- Playwright is in the repo (e2e stage of `npm test`); write throwaway drive-the-funnel scripts
  in `scripts/` if manual walking is too slow, delete them before committing (repo-hygiene rule)
  or keep them only if they earn a place as real e2e tests in `tests/`.
- Crawler gotcha (memory 07-10): high crawler concurrency produces false texture errors; keep
  concurrency modest before believing an error.

## Method (per funnel)

1. Walk it on desktop (1440), tablet (768), and phone (320-390) viewports, signed out AND
   signed in (QA account).
2. Record every defect in a working list: state, element, expected vs actual, severity.
3. Fix them all. Patterns to hold:
   - Loading: skeletons over spinners (CLAUDE.md), no layout shift on resolve.
   - Empty: what this is + one action to take, never a blank void.
   - Error: what failed + how to recover; network errors get a retry action.
   - Interactive elements: hover/active/focus states, keyboard reachable, ARIA labels.
   - Copy: plain language, no jargon, no dead-end messages.
4. Re-walk after fixing. Then `npm run audit:web` for the regression sweep.

## Known live issues to verify fixed or fix now

- Re-check the 07-14 console-sweep fixes deployed cleanly (memory: fixes committed, deploy was
  pending; if still undeployed, deploying them is part of this prompt).
- /forge engine-switch UX shipped 07-16 (never-dead-end failover): confirm the switch control
  is discoverable and announces what happened (a lane failing over silently confuses users).
- Session-expiry mid-flow: exercise an authed page after clearing the session cookie; the UX
  must be a reauth prompt, not a silent 401 spiral (pattern from the /play 4002 fix).

## Guardrails

- Stage explicit paths only; concurrent agents share the worktree.
- No visual redesigns of brand surfaces; this is polish and correctness, not a new design
  language. Use existing design tokens/CSS variables; if a page has none, adopt the nearest
  surface's tokens.
- Every fix must hold at 320px. If a fix needs layout surgery, do the surgery.

## Acceptance criteria

- [ ] Defect list in the report: found -> fixed status for every item (target: zero open).
- [ ] `npm run audit:web` after-run error count < before-run (both counts in the report).
- [ ] Every funnel walked clean on 3 viewports, signed in and out; no console errors from platform code.
- [ ] All five funnels' interactive elements keyboard-navigable with visible focus.
- [ ] Committed with changelog entries for user-noticeable fixes; `npm test` green.
