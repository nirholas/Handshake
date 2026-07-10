# Work Order 06 — "Agent Identity Studio": 3D avatars for OKX.AI agents themselves

Read `prompts/okx-ai/00-CONTEXT.md`, `prompts/okx-ai/PROGRESS.md` (02 must be done; runs in
parallel with 04/05 otherwise), and `/workspaces/three.ws/CLAUDE.md`.

## Mission

The sharpest wedge on OKX.AI: **our customers are the other agents on the platform.** Every
registered agent has a `profilePicture`, and OKX's own identity flow includes a set-avatar
step (`onchainos agent upload` + update). Almost all current agents use flat generated
images. We sell them a distinctive 3D identity: text/brand brief → 3D avatar → posed,
lit, high-res renders sized for the OKX CDN avatar slot — plus the underlying rigged GLB
so their identity works anywhere in 3D (three.ws scenes, games, metaverse embeds).

This is a product, not a listing blurb. Build it end to end.

## Product definition

**Service: "Agent Identity Studio"** — one A2MCP service (joins the 03 catalog):

- **Input** (JSON): agent name, personality/brand description, style hints (optional),
  reference image URL (optional).
- **Pipeline** (all capabilities already exist in this codebase — wire, don't rebuild):
  1. Brief → avatar prompt (existing prompt-shaping used by the avatar lane).
  2. `forge_avatar`-equivalent chain: mesh generation + humanoid auto-rig.
  3. Pose + frame: 3-5 distinct poses from the pose/clip library (rigged, retargeted),
     rendered against clean backdrops — headshot crop for the PFP slot + full-body shot.
     Rendering: check what already exists for server-side GLB rendering (screenshot workers,
     preview pipelines) before adding anything new. Real renders of THEIR avatar — never
     stock/template output.
  4. Deliverables: PNG set (PFP-cropped square + full-body), the rigged GLB, and a three.ws
     viewer link (existing viewer URL pattern).
- **Price**: single flat price. Anchor: flagship avatar is $0.50 (03); this bundles
  generation + rig + renders → $1.00–$2.00. Confirm unit cost math (GPU lane cost per call)
  and record it; must clear cost with margin.
- **Job pattern**: async job + free status/preview polling, same contract as 03 services.

## Requirements

1. **Wired into the 03 architecture**: entry in the catalog module, own endpoint URL, own
   OKX 402, tests alongside the other services — not a parallel one-off.
2. **Output quality is the product.** Generate at least 3 full pipeline runs from genuinely
   different briefs (e.g. a finance data agent, a creative/art agent, a trading bot).
   Inspect every deliverable: PFP reads clearly at 128×128 (OKX list size), full-body is
   coherent, GLB is rigged (skeleton + skin weights verified with the repo's GLB inspection
   utils). If any output is mediocre — fix the pipeline (prompt shaping, pose choice,
   framing, lighting) and rerun. CLAUDE.md: "would someone screenshot this?" is the bar.
3. **Dogfood publicly**: run OUR agent's own brief through it and (via the okx-agent-identity
   upload/update flow, with the human confirming the on-chain write) set #2632's profile
   photo to the result. Our listing's face becomes our portfolio piece. Coordinate with 05:
   if 05 hasn't submitted yet, hand the asset to 05 via PROGRESS.md instead of racing it
   with a second update; if 05 already submitted and the listing is mid-review, do NOT touch
   the listing — record the asset and defer the swap to 07 (post-approval).
4. **Showcase page on three.ws**: a gallery page (following existing page/site conventions +
   design tokens) showing the demo identities — each with renders + embedded 3D viewer.
   This is the `link` target for the changelog entry and the proof-of-quality URL the
   listing description can reference. Register it in `data/pages.json`.

## Testing

- Full 03-style integration: unpaid 402 → pay (real, X Layer, per 04's runbook — request
  funding if the wallet is dry) → job → all three deliverable types verified real.
- Edge cases: brief in Chinese (half the marketplace is zh — output must not degrade),
   absurdly long brief (truncate/handle honestly), reference image 404 (clean actionable
  error, no charge settled for undeliverable work — consistent with 04's verified
  pay-only-on-success semantics).
- `npm test` green; preview deploy verified.

## Definition of done

- [ ] Service live on preview + production, in catalog module, tested paid E2E with a real
      X Layer payment
- [ ] 3+ demo identities generated, inspected, iterated to genuinely excellent
- [ ] #2632's own avatar produced (set live, or handed off per requirement 3's coordination
      rule — recorded either way)
- [ ] Showcase page live, in `data/pages.json`, linked from the site's nav per existing
      conventions
- [ ] Docs: service section added to `docs/okx-marketplace.md` with a runnable example
- [ ] `data/changelog.json` entry (tags: `feature`; link: the showcase page path)
- [ ] PROGRESS.md appended (incl. unit-cost math, price decision, demo asset URLs, and the
      catalog delta for 05/07 to fold into the listing)
- [ ] Self-reviewed diff; committed (explicit paths) + pushed to `threews` (only push target)

## Anti-laziness gates

- The demo briefs must be REAL runs of the full pipeline, saved with their inputs — not
  cherry-picked outputs from manual retries you can't reproduce. If it took prompt-shaping
  fixes to get quality reliably, those fixes live in code now.
- Renders at final crop size are the acceptance test — a beautiful 1024px render that turns
  to mud at 128px fails requirement 2.
- "GLB is rigged" means you verified bones + weights programmatically, not that the
  generator lane usually rigs things.
