# Creation Surface Consolidation — Audit & Plan

**Status:** Phase 1 (additive hub) shipped 2026-07-08. Phase 2 executed 2026-07-16 for everything that survived re-verification against the live tree; several table rows turned out stale or unsafe (see the 07-16 note). Phase 3 (§3.3 pipeline handoffs) executed 2026-07-16 (see the Phase 3 note).
**Audited:** 2026-06-12

---

## Progress note — 2026-07-08

**Phase 1 (§4, step 1–3: rebuild `/create` as the intent hub) is shipped.** `pages/create.html`
now opens with a "What do you want to create?" section — four intent cards (Build an AI agent →
`/create-agent`, Make a 3D avatar → same-page anchor, Generate a 3D model → `/forge`, Launch a
token world → `/launchpad`, with a footnote pointing at `/play` for live worlds) — one question
deep, matching §3.1 exactly. The page's original content (hero "Customize a base avatar" editor
card + the full secondary grid: describe-to-3D, template picker, selfie scan, talking video,
Cosmos, GLB upload, Avatar Studio) is **untouched and still fully wired** — it now lives under the
"Make a 3D avatar" anchor as that intent's answer, exactly as §3.1 specifies ("The current
template-picker content of `/create` survives as the 'From scratch / templates' path"). No JS
handlers, IDs, or existing behavior were changed — only new markup/CSS was added above it.
`data/pages.json`'s `/create` entry and the page's meta/OG/JSON-LD were updated to describe the
hub instead of the stale "agent wizard" copy that predated this pass. A changelog entry was added
(`data/changelog.json`, tag `improvement`, dated 2026-07-08, title "/create is now the front door
for everything you can build").

**Phase 2 (§4 steps 4–10: kill duplicates per clusters C1–C6, plus all 301 redirects in the
redirect table) is deliberately NOT done.** Nothing was deleted, merged, or redirected — every
page named in §1/§2 (`/scan`, `/create/selfie`, `/agent/new`, `/create/character`,
`/create-character`, `/avatar-edit`, `/import/rpm`, `/embed.html`, `/create-prompt`,
`/create-review`, `/avatar-studio-demo`, `/avatar-embed`, `/bulk-launch`, etc.) is exactly as it
was before this pass, still live, still linked from wherever it was linked from. `vercel.json` was
not touched. This phase touches live production routes with real traffic and hard-to-reverse
redirects — it needs a dedicated pass with explicit owner review of the C1–C5 merge decisions
(especially the open decisions in §5: which photo→avatar implementation wins, what happens to
`/start`, where `/pose` lives) before any code changes. A future session should pick up Phase 2
here, not assume this consolidation is fully executed.
## Progress note: 2026-07-16 (Phase 2 pass)

Every §2/§4 cluster was re-verified against the tree before acting; the June audit had gone stale in several places. What was executed, and what was deliberately not:

**Executed:**
- **C3:** `/create/character` and `/create-character` had already been deleted (no pages, no routes; both hit the designed 404). The redirect-table 301s to `/play` now exist in `vercel.json`, so old links land on the character-capable worlds surface instead of a 404.
- **C2 (links, not the 301):** the table's `301 /agent/new -> /create-agent` is unsafe and was NOT added. The §1.1 claim "(routes to same flow)" is stale: `/agent/new` routes to `pages/agent-edit.html`, which immediately creates a draft agent, and it is the target of the marketplace "Start an agent with this avatar" handoff (`/agent/new?avatar_id=&avatar_glb=&avatar_name=`, `startAgentFromAvatar()` in `src/marketplace.js`). A 301 breaks that handoff. Instead every generic "create an agent" entry link now converges on the canonical wizard: the marketplace "+ Create Agent" / "+ New Agent" CTAs (`pages/marketplace.html`, three call sites in `src/marketplace.js`) and the search-page agent CTA (`src/search-page.js`) point at `/create-agent`; the avatar handoff keeps `/agent/new`. Bonus fix: the search-page avatar CTA pointed at `/create-avatar`, a route that has never existed (dead link); it now points at `/create#avatar-options`.
- **C1 (cross-link, not the merge):** both photo->avatar surfaces stay. Re-inspection shows they are distinct input methods, not duplicates: `/scan` is live-camera real-time reconstruction, `/create/selfie` is single-photo upload; the same "different input methods" logic §2 already applies to `/mocap-studio` vs `/pose`. Each hero now cross-links the other (`.alt-path` line under the subtitle), so they behave as one product with two input modes. Nav links `/create/selfie`; `/scan` stays reachable via `/features/scan`, search, tutorials, and the new cross-link. The §5.1 hard merge (one implementation at one URL) remains an owner decision.
- **Nav (finishes Phase 1 step 2):** the `/create` hub itself was missing from the nav. Build > Start here now opens with "Create anything" -> `/create`. The `/create-agent` item was also relabeled from "Create an avatar" (a mislabel that collided with the avatar column) to "Create an agent".
- **C6 (cross-link, not the merge):** the `/studio` "Your widget is live" modal now links `/playground` (§3.3 handoff). The `/embed` -> `/studio` 301 was NOT done: `/embed` is a live editor linked from 10+ surfaces (`features`, `create-next`, `marketplace`, `search`, `feature-discovery`, `getting-started`, `coincommunities-ui`) and `/studio` has no equivalent of its mode/size/position tuning, so the redirect would destroy working UX.

**Found already done or stale (no action):**
- **Step 10:** `/bulk-launch` is already admin-gated at `/admin/bulk-launch`; no public route exists.
- **C5:** `/create-prompt` is not stranded; it is the nav-linked "Describe it to 3D" surface served at `/create/prompt`. `/create-review` is the live review step of the create flow (`src/create.js` navigates to it). `/avatar-studio-demo` is already deleted (no page, no route). `/avatar-embed` is the iframe target behind `/embed/avatar` used by SDK embeds; it must not be retired.
- **C4:** `/avatar-edit` is orphaned but Avatar Studio has no edit mode (`avatar-studio.html` reads no URL params), so `301 /avatar-edit -> /avatar-studio?mode=edit&id=` has no working destination; redirecting would silently lose edit-by-id for bookmarked URLs. Left live. `/import/rpm` stays as a page: the hub links it as the import option and it supports URL import the hub's upload card does not.

**Still open for future passes:** the `/agent/new` 301 (blocked until `/create-agent` supports the avatar handoff params), the C1 single-URL merge (§5.1 owner decision), `/avatar-edit` retirement (needs an Avatar Studio edit mode), the `/embed` -> `/studio` merge (needs feature parity in `/studio`).

## Progress note: 2026-07-16 (Phase 3 pass — pipeline handoffs, §3.3)

Phase 3 wires the completion-state handoffs from §3.3 that were still missing, all additive (new CTAs on existing "done" states; no routes, redirects, or existing behavior changed):

**Executed:**
- **Row 1 (photo->avatar -> agent):** the `/create/selfie` done state gains a "Turn this into an agent" button that PATCHes the avatar name (when set) then navigates to `/agent/new?avatar_id=&avatar_name=&avatar_glb=` with the just-built body pre-selected, reusing the exact hand-off the marketplace's `startAgentFromAvatar()` already uses (agent-edit.js consumes those params). `/scan` inherits this automatically since it now `location.replace()`s to `/create/selfie`.
- **Row 2 (agent -> deploy):** the `/create-agent` wizard success screen gains a "Take it further" row with four next-stage links: "Give it a voice" -> `/voice`, "Embed it anywhere" -> `/studio` (pre-loaded with the agent's 3D body via `?model=` when publicly readable), "Put it in a world" -> `/play`, "Launch its token" -> `/launchpad`.
- **Row 3 (voice -> agent):** the `/voice` clone-done state gains an "Add to an agent" link to `/dashboard`, where any agent's editor voice tab picks up the new clone.

**Found already done (no action):**
- **Row 4 (studio snippet -> playground + agent detail):** `/studio` already links `/playground` (shipped in the 07-16 Phase 2 commit).
- **Row 5 (avatar detail -> edit):** `avatar-page.js` already offers an owner "Edit avatar" button to `/create/studio?edit=ID` (Avatar Studio's edit mode), plus Voice Lab and "Open in Studio" CTAs.

**Still open:** the same route-level items listed in the Phase 2 note (the `/agent/new` 301, the C1 single-URL merge, `/avatar-edit` retirement, and the `/embed` -> `/studio` merge) all remain owner/parity-gated and were not touched.

---

**Problem:** 28 creation-related surfaces (18 nav-linked, 10 orphaned) presented as a flat menu of peer options. Users can't tell which tools are products, which are steps, and which are duplicates. The platform has no creation funnel — it has a pile of doors.

**Goal:** One front door (`/create` hub organized by user intent), one canonical surface per capability, every tool's "done" state handing off to the next stage of the pipeline: **avatar → agent → deploy (embed / world / token)**.

---

## 1. Full inventory

Every user-facing surface where something gets created. "Nav" reflects `public/nav-data.js` as of audit date.

### 1.1 AI agent creation

| Surface | Path | File | What it does | Backend | Nav |
|---|---|---|---|---|---|
| Create an Agent | `/create-agent` | `pages/create-agent.html` | 5-step wizard: name, 3D body, skills, personality, voice, on-chain identity | `POST /api/agents` | Build ▸ |
| New Agent | `/agent/new` | (routes to same flow) | Appears to duplicate `/create-agent` | `POST /api/agents` | — |
| Get Started | `/start` | — | 5-step onboarding: avatar → name → skills → embed → monetization | multiple | — (hidden onboarding) |

### 1.2 3D avatar building

| Surface | Path | File | What it does | Backend | Nav |
|---|---|---|---|---|---|
| Create avatar | `/create` | `pages/create.html` | Pick template avatar or upload GLB; feeds agent workflow | `/api/avatars/*` | Build ▸ |
| Avatar Studio | `/avatar-studio` | `pages/avatar-studio.html` | Full character creator (M3-org/CharacterStudio fork): sculpt, outfits, export GLB | internal Three.js | Build ▸ |
| Customize avatar | `/avatar-edit` | `pages/avatar-edit.html` | Edit existing avatar attributes/accessories | `/api/avatars/{id}` | — (orphaned) |
| Import avatar | `/import/rpm` | — | Import GLB/glTF from URL or file upload | `/api/avatars` | Build ▸ |
| Avatar Studio demo | `/avatar-studio-demo` | `pages/avatar-studio-demo.html` | Demo variant of Avatar Studio | internal | — (orphaned) |

### 1.3 Photo/selfie → 3D avatar

| Surface | Path | File | What it does | Backend | Nav |
|---|---|---|---|---|---|
| Selfie to avatar | `/create/selfie` | `pages/create-selfie.html` | One photo → rigged 3D avatar (~60s) | `/api/avatars/{id}` | Build ▸ |
| Scan | `/scan` | `pages/scan.html` | Real-time camera reconstruction → rigged avatar (~60s) | `/api/config`, `/api/avatars/{id}` | — (only via `/features/scan`) |
| Scan feature page | `/features/scan` | — | Marketing/feature overview of Scan | read-only | Discover ▸ |

### 1.4 Prompt → 3D model generation

| Surface | Path | File | What it does | Backend | Nav |
|---|---|---|---|---|---|
| Forge | `/forge` | `pages/forge.html` | Text prompt → textured GLB (Flux + TRELLIS); viewer, AR preview, download | `/api/forge*` (13 endpoints) | Build ▸ "Text to 3D" |
| Forge feature page | `/features/forge` | — | Marketing/feature overview of Forge | read-only | Discover ▸ |

### 1.5 Character creation (worlds)

| Surface | Path | File | What it does | Backend | Nav |
|---|---|---|---|---|---|
| Play (coin worlds) | `/play` | — | 3D worlds per token; character creation is an integrated subflow | multiplayer backend | Build ▸ "Worlds" |
| Character creator | `/create/character` | `pages/create/` | Standalone character builder referencing `/play` worlds | internal | — (orphaned; linked from `/play`) |
| Create character | `/create-character` | `pages/create-character.html` | Lightweight character creation variant | unknown | — (orphaned) |

### 1.6 Motion & pose

| Surface | Path | File | What it does | Backend | Nav |
|---|---|---|---|---|---|
| Mocap Studio | `/mocap-studio` | `pages/mocap-studio.html` | Webcam face/body capture → save clip → replay on any avatar | internal media capture | Labs ▸ |
| Pose Studio | `/pose` | — | Click-to-pose mannequin, presets, props, export PNG/animation | internal Three.js | Build ▸ + Labs ▸ |

### 1.7 Voice

| Surface | Path | File | What it does | Backend | Nav |
|---|---|---|---|---|---|
| Voice Lab | `/voice` | — | Record → voice clone; compare models; use in agents/TTS | TTS/cloning APIs | Build ▸ |

### 1.8 Embed / widget creation

| Surface | Path | File | What it does | Backend | Nav |
|---|---|---|---|---|---|
| Widget Studio | `/studio` | — | Pick avatar, configure voice/knowledge, copy embed snippet | config generation | Embed ▸ |
| Embed editor | `/embed.html` | — | Tune embed mode, size, position | config UI | Embed ▸ |
| Avatar SDK | `/avatar-sdk` | `pages/avatar-sdk.html` | Reference/demo for `@three-ws/avatar` + `<agent-3d>` component | docs | Embed ▸ |
| Playground | `/playground` | — | Viewer + environment + embed code | — | Build ▸ |

### 1.9 Token / launchpad

| Surface | Path | File | What it does | Backend | Nav |
|---|---|---|---|---|---|
| Launchpad Studio | `/launchpad` | `pages/launchpad.html` | Build hosted white-label 3D token launchpad (Pump.fun-powered) | `/api/launchpad/*` | Labs ▸ |
| Bulk Launch | `/bulk-launch` | `pages/bulk-launch.html` | Admin batch launcher for agent tokens | internal/admin | — (orphaned, admin-only) |

### 1.10 Stranded internal steps & demo variants (orphaned pages)

| Path | File | Likely purpose | Disposition needed |
|---|---|---|---|
| `/create-prompt` | `pages/create-prompt.html` | Internal prompt-input step | Fold into parent flow or delete |
| `/create-review` | `pages/create-review.html` | Review step of a creation flow | Fold into parent flow or delete |
| `/avatar-studio-demo` | `pages/avatar-studio-demo.html` | Demo variant | Delete or gate behind docs |
| `/avatar-embed` | `pages/avatar-embed.html` | Embed demo variant | Fold into `/studio` or docs |
| `/avatar-page` | `pages/avatar-page.html` | Avatar detail (read-only, not creation) | Keep; add "Edit" link → canonical editor |
| `/avatar-wallet-chat` | `pages/avatar-wallet-chat.html` | Feature demo | Keep as demo, out of creation scope |
| `/avatar-artifact` | `pages/avatar-artifact.html` | Standalone artifact viewer | Keep (Labs), out of creation scope |

**Totals: 18 nav-discoverable + 10 orphaned = 28 surfaces.**

---

## 2. Duplication clusters & canonical decisions

For each cluster: the surfaces involved, the chosen canonical, and what happens to the rest.

| # | Cluster | Surfaces | Canonical | Action for the rest |
|---|---|---|---|---|
| C1 | Photo→avatar | `/scan`, `/create/selfie` | **Merge into one** (decision needed: which UX wins — `/scan`'s real-time tracking appears more sophisticated; `/create/selfie`'s URL fits the hub) | 301 the loser → winner; `/features/scan` links to winner |
| C2 | Agent creation | `/create-agent`, `/agent/new`, `/start` | **`/create-agent`** | 301 `/agent/new`; keep `/start` as guided onboarding that *wraps* the canonical wizard (no parallel implementation) |
| C3 | Character creation | in-`/play` flow, `/create/character`, `/create-character` | **`/play` integrated flow** | Fold `/create/character` into `/play` (modal or subroute); delete `/create-character`; 301 both |
| C4 | Avatar building | `/create`, `/avatar-studio`, `/avatar-edit`, `/import/rpm` | **`/create` as router → `/avatar-studio` as editor** | `/avatar-edit` becomes the edit mode of Avatar Studio (reachable from avatar detail pages, not standalone); `/import/rpm` becomes an upload option inside `/create` |
| C5 | Stranded steps | `/create-prompt`, `/create-review`, `/avatar-studio-demo`, `/avatar-embed` | n/a | Fold into parent flows or delete; 301 or 410 |
| C6 | Embed | `/studio`, `/embed.html`, `/avatar-sdk`, `/playground` | **`/studio`** for building; `/avatar-sdk` stays as docs | Merge `/embed.html` tuning options into `/studio`; clarify `/playground` as preview, link it from `/studio` |

Not duplicates — keep as-is (complementary, single-purpose):
- `/forge` (prompt→3D) — most mature tool on the platform (13 API endpoints)
- `/mocap-studio` vs `/pose` — different input methods (capture vs manual)
- `/voice` — single surface
- `/launchpad` (public) vs `/bulk-launch` (admin; remove from public routing)

---

## 3. Target information architecture

### 3.1 The `/create` hub (new front door)

`/create` stops being "avatar template picker" and becomes the intent router. Four intents, each one question deep:

```
/create
├── Build an AI agent          → /create-agent (wizard; avatar step links to avatar intents below)
├── Make a 3D avatar
│   ├── From a photo           → canonical photo→avatar surface (C1 winner)
│   ├── From scratch           → /avatar-studio
│   ├── From a text prompt     → /forge (avatar preset)
│   └── From a file/URL        → upload option (absorbs /import/rpm)
├── Generate a 3D model        → /forge
└── Launch a token world       → /launchpad (and /play for worlds)
```

The current template-picker content of `/create` survives as the "From scratch / templates" path.

### 3.2 Nav after consolidation

**Build dropdown** shrinks from 8+ tool links to ~4 intent links (mirroring the hub) plus Worlds. **Embed dropdown** keeps `/studio` + `/avatar-sdk` docs. **Labs** keeps genuinely experimental: Mocap, Pose, Launchpad live feeds. All menus live in `public/nav-data.js` (single source of truth — never hand-edit nav markup).

### 3.3 The pipeline (cross-links that turn tools into a product)

Every tool's completion state hands off to the next stage:

| When user finishes… | Offer… |
|---|---|
| Photo→avatar, Avatar Studio, Forge (avatar output), import | "Turn this into an agent" → `/create-agent` with avatar pre-selected |
| `/create-agent` wizard | "Give it a voice" → `/voice` · "Embed it" → `/studio` · "Put it in a world" → `/play` · "Launch its token" → `/launchpad` |
| `/voice` clone | "Attach to an agent" → agent picker |
| `/studio` snippet | Link to `/playground` preview + agent detail |
| Avatar detail page | "Edit" → Avatar Studio edit mode (replaces orphaned `/avatar-edit`) |

---

## 4. Migration plan

### Phase 1 — Front door & nav (fixes the overwhelm; no tool internals touched)
1. Rebuild `/create` as the intent hub (3.1). Existing template picker becomes a sub-path of the avatar intent.
2. Restructure `public/nav-data.js` per 3.2.
3. Update `data/pages.json`; add changelog entry (user-visible).

### Phase 2 — Kill duplicates (one cluster per task; each independently shippable)
4. **C2:** 301 `/agent/new` → `/create-agent`; rewire `/start` to wrap the canonical wizard.
5. **C1:** pick the photo→avatar winner, merge the better pieces of both implementations, 301 the loser, add winner to nav.
6. **C3:** fold character creation into `/play`; delete/301 the two orphans.
7. **C4:** retire standalone `/avatar-edit` (edit mode lives in Avatar Studio, linked from avatar detail); absorb `/import/rpm` into the hub.
8. **C5:** fold or delete stranded steps and demo variants.
9. **C6:** merge `/embed.html` into `/studio`; cross-link `/playground`.
10. Remove `/bulk-launch` from public routing (admin-only access).

### Phase 3 — Pipeline handoffs (turns breadth into a journey)
11. Implement every completion-state handoff in 3.3.
12. End-to-end walkthrough: photo → avatar → agent → voice → embed → world → token, with no dead ends.

### Redirect table (cumulative)

| Old URL | New URL | Type |
|---|---|---|
| `/agent/new` | `/create-agent` | 301 |
| `/scan` *or* `/create/selfie` (loser of C1) | C1 winner | 301 |
| `/create/character` | `/play` (character subflow) | 301 |
| `/create-character` | `/play` (character subflow) | 301 |
| `/avatar-edit` | `/avatar-studio?mode=edit&id=…` | 301 |
| `/import/rpm` | `/create` (upload intent) | 301 |
| `/embed.html` | `/studio` | 301 |
| `/create-prompt`, `/create-review` | parent flow or 410 | per-case |
| `/avatar-studio-demo` | `/avatar-studio` | 301 |
| `/bulk-launch` | admin-gated, removed from public routes | — |

Redirects live in `vercel.json` routes. Also update `data/pages.json` (feeds sitemap + changelog) and any internal links found via grep before removing a page.

### Per-phase definition of done
- All redirects return 301 to a live page (verify with `curl -I`).
- `public/nav-data.js` has no link to a retired URL; `grep -r` across `pages/`, `public/`, `docs/` finds no internal links to retired URLs.
- `data/pages.json` updated; `npm run build:pages` green.
- Changelog entries for user-visible changes (Phase 1 hub + nav; each cluster merge that users would notice).
- Page audit (`scripts/page-audit.mjs`) green on touched pages.

---

## 5. Open decisions

1. **C1 winner:** `/scan` (real-time tracking UX) vs `/create/selfie` (URL fits the hub). Recommendation: keep `/scan`'s implementation at `/create/selfie`'s URL — best UX, best IA.
2. **`/start` scope:** keep as marketing onboarding wrapping the wizard, or retire entirely once the hub exists?
3. **`/pose` placement:** currently in both Build and Labs; after consolidation it should live in Labs only (it's a tool, not an intent).

---

*Related: [generation-suite.md](generation-suite.md) (prompt/image→3D roadmap — Forge is the canonical surface for that work; nothing in this consolidation conflicts with it).*
