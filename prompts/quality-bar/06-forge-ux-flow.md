# 06: Forge UX, from prompt to proud screenshot

Read `prompts/quality-bar/_shared.md` first. Its operating clause applies: finish 100%, never ask.

## Mission

Make /forge feel like a flagship product: the flow from typing a prompt to holding a
share-worthy 3D result should be legible, alive, and impossible to dead-end. The failover
plumbing exists (3e22c3e82: poll-time lane failover, one-click engine switching); this prompt
is about the experience wrapped around it.

## Tasks

1. **Walk the flow as a first-time user** (`npm run dev`, real browser, also 320px). Log every
   moment of confusion: what is happening now, how long will it take, what do I do with the
   result. Fix what you find; the list below is the floor, not the ceiling.
2. **Generation timeline.** Replace passive waiting with a real stage timeline (enhancing
   prompt, generating reference views, sculpting mesh, painting textures, finishing) driven by
   the actual poll states the API already returns, with elapsed time and the honest ETA from
   `api/_lib/forge-lane-health.js`. Show the reference images as they are produced (prompt 01
   makes them); watching the concept appear kills perceived latency.
3. **Result moment.** When the GLB lands: camera intro move, quality viewer (prompt 05 module),
   and immediate actions with zero hunting: download GLB/USDZ, view in AR (/ar handoff), rig it
   (auto-rig lane), refine it (`refine_model` conversational iteration), restyle materials,
   place it IRL (/irl), share link with a real og-image of THIS model. Every action wired to
   the existing feature, no dead buttons.
4. **History and comparison.** A signed-in user's generations persist (check the existing
   storage; wire if half-built). Side-by-side compare two generations of the same prompt
   (engine A vs engine B), which also showcases the engine-switch feature.
5. **Prompt help.** Subtle prompt-improvement affordance: show the director's enhanced prompt
   after generation ("what we actually asked the model"), one-click "try a variation". Good
   empty state: 6 curated example prompts with thumbnails that users can fire instantly.
6. **Error and retry UX.** Every failure path renders a designed state: what failed in plain
   language, the automatic recovery that already happened (failover), and the one-click manual
   options (switch engine buttons from 3e22c3e82). No raw error strings, no dead ends. Session
   expiry mid-generation must preserve the job and resume after re-auth.
7. **Keyboard + a11y.** Cmd/Ctrl+Enter submits, Esc collapses panels, focus states everywhere,
   ARIA labels on the viewer controls, prefers-reduced-motion respected on the intro move.

## Definition of done

- The full walk-through repeated clean: no confusion points left, no console errors, all states
  (loading/empty/error/success) designed at 320/768/1440.
- Every result-moment action clicked through to its destination feature and back.
- `npm test` green (respect the vitest-masks-e2e gotcha); `npm run audit:web` clean on /forge.
- Changelog entry in holder language. Screenshots of the result moment in the report; apply the
  pride check before calling it done.

## Anticipated blockers, pre-answered

- Poll payloads missing a stage you want to display: extend the API response in `api/forge.js`
  (additive field, keep old clients working) rather than faking states client-side.
- USDZ availability: the bake pipeline exists (iOS AR work, 8b23b8d9e); if a model lacks USDZ,
  generate on demand through that path, show a brief "preparing AR file" state.
- Persistence store choice: use whatever `api/` already uses for user artifacts (R2 +
  database rows); do not introduce new storage.
