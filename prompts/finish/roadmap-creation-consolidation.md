# RM-CONSOL: Creation surface consolidation, the remaining three

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/roadmap-creation-consolidation.md`".
It is complete on its own. Also read `prompts/finish/roadmap-00-README.md` and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end with a question, a plan you did not execute, or "should I proceed?".
2. These are live production routes with real traffic. Additive first, redirect last, and never
   ship a redirect whose destination loses a capability the old route had. Two redirects were
   deliberately NOT shipped for exactly that reason; the reasons are recorded below and they
   are the work, not an excuse.
3. CLAUDE.md hard rules: no mocks, no TODO comments, no commented-out code, no em-dash or
   en-dash characters. Stage explicit paths only.

## Where this stands (verified through 2026-07-29, re-verify before acting)

Shipped: `/create` is the intent hub, nav restructured, `/agent/new` 301s to `/create-agent`
(with `has`-gated rewrites preserving the `avatar_id` / `avatar_glb` handoff), `/scan` 301s to
`/create/selfie`, `/create/character` and `/create-character` 301 to `/play`, the standalone
`/avatar-edit` landing 301s to `/avatars`, `/bulk-launch` is admin-only, and every pipeline
handoff in the target IA is wired (photo to avatar to agent to voice, embed, world, token).

One mechanical fact that governs every remaining redirect: `server/index.mjs` matches
`vercel.json` `routes` against the pathname only and emits `Location` verbatim, so a
status-only route **drops the query string**. Any retired route carrying meaningful params
needs a `has`-gated rewrite for the param form plus a 301 for the bare form.

## Task 1: Avatar Studio edit-mode parity, then retire `/avatar-edit` for real

The redirect was unsafe because Avatar Studio's edit mode **lost data**, not merely features.
**Steps 1 and 2 shipped 2026-08-02; steps 3 and 4 remain, and the redirect stays unshipped
until they land.**

Ship, in this order:

1. **DONE (2026-08-02).** Appearance round-trip fidelity. `collapseAppearance` /
   `hydrateAppearance` / `cloneAppearance` in `src/avatar-studio-utils.js` now carry `outfit`
   and `garments` verbatim (garment entries deep-copied), so the wardrobe survives a Studio
   save. `resetAll()` clears only what Studio controls and leaves the wardrobe alone; the
   history stack round-trips both because it clones. Covered in
   `tests/avatar-studio-save.test.js`: a dressed appearance round-trips to deep equality, a
   dressed avatar equals its own clone (so loading one does not read as dirty), and losing the
   garments registers as a real difference.
2. **DONE (2026-08-02).** Non-destructive save. Edit mode no longer exports the live scene:
   `saveAvatar()` branches to `patchEditedAvatar()`, which PATCHes `{ name, appearance }` and
   lets the server bake rebuild the dressed GLB from the pristine base, exactly like
   `avatar-edit`. This also removed a double-application bug that predated the garment issue:
   the old path uploaded an already-dressed scene export over the base and the appearance PATCH
   that followed baked the same appearance onto it a second time (doubled colour multiplies,
   duplicated accessories). `uploadEditedAvatar()` is deleted. The base body cannot be switched
   in edit mode (`bindBaseSwitch` hides the control), so there was never new geometry to upload.
   Two adjacent fixes fell out: a name-only edit now saves (the old dirty check compared
   appearance only, and `handleGlbPatch` dropped the `name` field it was sent), and the
   thumbnail snapshot is skipped when the avatar wears layers Studio does not draw, so a save
   cannot replace a dressed thumbnail with an undressed one.
3. Port the missing panels: the wardrobe and closet (8 garment slots with occlusion masking,
   resolved on arbitrary GLBs by `src/avatar-wardrobe.js`, not hardcoded material names), the
   auto-rig tab, the walk preview and the "Play as this" handoff, and `?equip-*` support.
4. Only then: 301 the bare `/avatar-edit` path to the studio and keep a `has`-gated rewrite for
   the legacy `?id=` form. Verify with `curl -I` and by opening a real dressed avatar, saving,
   and confirming the garments survive.

## Task 2: `/embed` to `/studio`, the four structural gaps

The parity work already shipped (ground disc, gesture buttons, badge, responsive snippet on the
`walking-avatar` type), but `/studio` still cannot do `/embed`'s job. Close these, then redirect:

1. **No-account snippet generation.** `/embed` is fully client-side: configure, copy, leave.
   `/studio` must persist a widget row before `openEmbedModal` can emit anything. Build a guest
   mode so the snippet works with no sign-in.
2. **Chat mode.** `/embed`'s `chat` mode emits `<iframe src="/a/<agentId>?embed=1">`. Studio's
   `talking-agent` is a different runtime and cannot produce that URL. Add a chat widget type.
   `src/dashboard-next/pages/agents.js` links `/embed?avatar=...&mode=chat` today.
3. **Deep-linkable config.** `/embed` reflects every control into `location.search` and
   rehydrates from it, so a configured editor URL is itself a shareable artifact. `/studio`
   reads only `edit`, `template`, `type`, `model`, `avatar`. Add a config-URL layer that reads
   and writes the same params `/embed` uses, so the `has`-gated rewrite can carry them.
4. **Raw GLB or VRM URL as the avatar**, plus the platform paste instructions (HTML, React,
   WordPress, Webflow, Shopify), have no Studio equivalent. Port them.
5. Mechanical detail that must land in the same change: `walk-sdk/src/config.js` suppresses the
   corner companion on paths prefixed `/embed`; moving the editor under `/studio` needs that
   list updated or the companion appears inside the editor.

Only after all five: 301 the bare path, `has`-gated rewrite for the param-carrying form, and
verify every saved `/embed?...` URL shape still lands somewhere that reproduces its config.

## Task 3: the two open placement decisions

Decide both yourself using the most reversible option, implement it, and record the decision
plus the alternative in the report. Do not ask.

1. **`/start`**: keep it as guided onboarding that wraps the canonical `/create-agent` wizard
   (never a parallel implementation), or retire it now that the hub exists. Check its real
   traffic and inbound links first.
2. **`/pose`**: it currently appears in both Build and Labs in `public/nav-data.js`. It is a
   tool, not an intent, so it belongs in Labs only unless the data says otherwise.

## Definition of done

- [ ] Every redirect you ship returns 301 to a live page (`curl -I`), and every param-carrying
      form still works through its rewrite.
- [ ] A real dressed avatar survives an Avatar Studio edit and save with garments and outfit
      intact, proven in a browser and by test.
- [ ] `/studio` produces a working snippet with no account, in chat mode, from a raw GLB URL,
      and from a deep-linked config URL.
- [ ] `public/nav-data.js` has no link to a retired URL, and
      `grep -rn "<retired-path>" pages/ public/ docs/ src/` finds nothing.
- [ ] `data/pages.json` updated; `npm run build:pages` green; `npm run audit:web` green on every
      touched page; `npm run audit:links` clean.
- [ ] `data/changelog.json` entry for each user-visible merge.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| A redirect would lose a capability | Then it is not ready. Build the capability first, in the same session, and ship the redirect after. That is this whole work order. |
| Uncertain which surface wins a merge | Pick the one the code already favors (what users actually reach today), implement it, and record the alternative. |
| A page under `public/*.html` is not in the Vite graph | Test that it still renders after any change; the raw-`/src` import trap silently kills such pages. |
| Traffic data is unavailable | Use inbound-link count from `grep -rn` across `pages/`, `public/`, `docs/`, `src/` as the proxy and say so. |
| Another agent is editing a page you need | Re-read the file immediately before each edit; stage only your own paths. |

## Appendix: the target information architecture (unchanged)

```
/create
├── Build an AI agent          -> /create-agent
├── Make a 3D avatar
│   ├── From a photo           -> /create/selfie (camera + upload, canonical)
│   ├── From scratch           -> Avatar Studio
│   ├── From a text prompt     -> /forge (avatar preset)
│   └── From a file or URL     -> upload (absorbs /import/rpm)
├── Generate a 3D model        -> /forge
└── Launch a token world       -> /launchpad (and /play for worlds)
```

Completion states hand off to the next stage: avatar to agent, agent to voice, embed, world and
token, voice to agent, studio snippet to playground, avatar detail to editor. All of those are
shipped; keep them working.
