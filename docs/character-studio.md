# Character Studio builder

This page documents the Character Studio avatar builder that powers [Avatar Studio](/docs/avatar-studio): a browser-based tool for designing a customized humanoid avatar (body, hair, face, clothing, accessories) with a point-and-click interface and no 3D modeling experience required. The result is a GLB/VRM file that works with every three.ws feature: animations, the emotion system, AR viewing, and web embedding.

It is a rebranded fork of the open-source (MIT license) [M3-org/CharacterStudio](https://github.com/M3-org/CharacterStudio) project and lives in the `character-studio/` directory of the repo.

**Note:** the platform's primary from-scratch builder, the page served at [three.ws/avatar-studio](https://three.ws/avatar-studio) and [three.ws/create/studio](https://three.ws/create/studio), is a separate native implementation documented in [Avatar Studio (native)](/docs/avatar-studio). The Character Studio fork on this page is the trait-based builder behind the "three.ws Studio" option described below.

---

## Getting Started

Where you meet it in the product:

1. Open an agent's edit page (`https://three.ws/agents/<agent-id>/edit`)
2. Click the avatar tile and choose **three.ws Studio** ("In-browser builder: hair, clothing, body") from the create menu
3. The builder opens in a modal iframe; customize using the sections in the left panel
4. Click **Save Avatar**; the finished GLB is handed back to the agent editor automatically

It is also mounted standalone on the Avatar OS demo page at [/demo/avatar-os](https://three.ws/demo/avatar-os), and developers can run it directly with `npm run dev` inside `character-studio/`.

**Account:** No account is needed to build and export an avatar. An account is required to save your avatar to an agent and use it on the platform.

---

## The Customization Interface

The builder is trait-based. You first pick a base character class, then swap and tint the individual trait items that class defines. Every change is reflected immediately in the 3D preview.

### Character classes

The class list comes from `character-studio/public/manifest.json`. The shipped classes are:

| Class | Description | Format |
|---|---|---|
| Anata (Female) | Stylized female humanoid | VRM |
| Anata (Male) | Stylized male humanoid | VRM |
| ON1FORCE | Demon character | VRM |
| TUBBY CAT | Cute cat character | VRM |

### Traits

Each class has its own trait manifest (hair, clothing, accessories, and other slots, as that class defines them). Trait assets are the upstream [loot-assets](https://github.com/m3-org/loot-assets) library, mirrored same-origin through `GET /api/studio-assets/<path>` (`api/studio-assets/[...path].js`) so the browser never hits a vendor CDN. Selecting a trait swaps the mesh live; traits that declare color support expose a color picker.

---

## The 3D Preview

The center panel shows your avatar in real time using a Three.js WebGL renderer.

- **Rotate** — click and drag
- **Zoom** — scroll wheel
- **Animation preview**: the preview avatar plays clips from the manifest's default animation set, so you see the character in motion rather than a static T-pose

Every trait change updates the preview live from the already-loaded asset library.

---

## Exporting Your Avatar

### Standalone (running the builder directly)

The export menu offers direct downloads:

- **GLB**: a single self-contained binary glTF file
- **VRM 0** and **VRM 1**: VRM exports for VRM-native applications

### Embedded (the "three.ws Studio" flow)

When the builder runs inside the Avatar Creator iframe, the export menu shows a single **Save Avatar** button instead. It builds the GLB in the browser and hands the bytes back to the host page via `postMessage`; the agent editor adopts it as the agent's avatar. Nothing uploads until the host app saves it to your account.

### Export optimization options

The merge options panel controls how the export is assembled:

- **Texture atlas**: combine individual trait textures into shared atlases (separate standard and MToon atlases, each with configurable size)
- **KTX2 compression**: GPU-compressed textures for smaller files
- **Two-sided material**: force double-sided rendering when needed

Mesh merging and hidden-face culling run at export time (`character-studio/src/library/merge-geometry.js`, `cull-mesh.js`, `create-texture-atlas.js`), so the output is optimized for real-time use.

---

## Morph Targets and the Emotion System

Exported avatars carry whatever blendshapes their source trait assets include; VRM expression data is preserved through `@pixiv/three-vrm`. The three.ws emotion system drives ARKit-style blendshape names (`mouthSmile`, `browInnerUp`, `eyesClosed`, and similar; see the [3D Viewer](/docs/viewer) morph-target reference) whenever the loaded model exposes them, with no per-avatar configuration. If a model lacks a given target, that expression channel simply does not animate.

---

## Animation Compatibility

Exported avatars use the VRM humanoid skeleton:

```
Hips → Spine → Chest → Neck → Head
LeftUpperArm → LeftLowerArm → LeftHand
RightUpperArm → RightLowerArm → RightHand
LeftUpperLeg → LeftLowerLeg → LeftFoot
RightUpperLeg → RightLowerLeg → RightFoot
```

This means:

- **Mixamo animations work**: the fork retargets Mixamo FBX clips onto the VRM rig (`loadMixamoAnimation.js`, `VRMRigMapMixamo.js`)
- **The three.ws animation library is fully compatible**: the platform's bone-name canonicalizer (`src/glb-canonicalize.js`) maps VRM rigs (and every other humanoid convention it knows, MikuMikuDance's Japanese bone names included) to the canonical set, so all built-in clips (idle, wave, walk, and the rest) work out of the box
- **Retargeting** is handled automatically by the animation manager (`src/animation-retarget.js`)

---

## The Asset Library

The builder uses a manifest-driven asset system. `character-studio/public/manifest.json` lists the character classes; each class entry points at a per-class trait manifest that defines the trait slots and the individual VRM assets that fill them. The trait assets themselves are the open-source [loot-assets](https://github.com/m3-org/loot-assets) library, served through the three.ws proxy at `/api/studio-assets/` in production. For local development, `npm run get-assets` inside `character-studio/` clones the library into `public/`.

At export time, the selected trait meshes are merged and their textures atlased by the fork's own pipeline (`merge-geometry.js`, `create-texture-atlas.js`, `cull-mesh.js` under `character-studio/src/library/`), producing a single GLB or VRM.

### Contributing New Assets

The asset library is open-source and welcomes contributions:

1. Create your 3D asset in Blender using the relevant base mesh as reference
2. Follow the vertex group and UV conventions documented in the [CharacterStudio docs](https://m3-org.github.io/characterstudio-docs/)
3. Export in the class's format (VRM) with correct bone weights
4. Submit a pull request to the upstream [m3-org/loot-assets](https://github.com/m3-org/loot-assets) repository, adding the asset and its manifest entry

---

## Technical Architecture

For developers who want to understand the internals or self-host:

| Component | Technology |
|---|---|
| Frontend framework | React 19 + Vite |
| 3D rendering | Three.js (WebGL) |
| VRM model support | @pixiv/three-vrm |
| State management | Zustand + React context |
| GLB/VRM export | three.js GLTFExporter plus the fork's VRM exporters (`VRMExporter.js`, `VRMExporterv0.js`) |
| Optimization | Texture atlasing, mesh merging, face culling (custom modules in `src/library/`) |

The core of the system is `CharacterManager` in `character-studio/src/library/characterManager.js`. It orchestrates trait loading, mesh combining, animation playback, and VRM export. The UI layer communicates with it through React context (`SceneContext`, `ViewContext`).

**Integration with the main app:** The `AvatarCreator` class in `src/avatar-creator.js` opens the builder in an iframe at `/avatar-studio/index.html` and listens for the `characterstudio` `postMessage` export event, which the builder sends from `character-studio/src/library/embed-export.js`. When the user clicks Save Avatar inside the builder, the GLB bytes are passed back to the parent app.

The index file is addressed explicitly because the bare `/avatar-studio` path is routed to the native sculpting page; the trait builder is the static bundle beside it, mirrored into `dist/avatar-studio/` by the `copy-avatar-studio` Vite plugin and served from `character-studio/build` by the dev middleware.

**Build:** `npm run dev` inside `character-studio/` starts the dev server on port 5173 at `/avatar-studio/`. `npm run build` outputs to `./build/`, which the main repo build copies into `dist/avatar-studio/`. `npm run test:run` runs the vitest suite once. In production the trait assets are mirrored same-origin through `GET /api/studio-assets/<path>`; `npm run get-assets` clones the same loot-assets library into the public directory for offline work.

---

## Avatar Studio vs. the selfie pipeline

three.ws supports two avatar creation paths. They're complementary, not competing:

| | Avatar Studio | Selfie pipeline |
|---|---|---|
| Input | Point-and-click UI | 3 photos (photo-to-avatar) |
| Style | Stylized / illustrated | Photorealistic |
| Customization | Full control over every feature | Limited post-generation edits |
| Account needed to start | No | Yes |

**Using both together:** Generate a photorealistic avatar from a selfie to get a realistic starting point, import the resulting GLB into the three.ws editor, then adjust clothing colors and accessories manually.

---

## Character customization in `/play` (World Online)

`/play` — the GTA-style multiplayer world (`src/game/coincommunities.js`) — has its own
end-to-end character customization flow, built entirely on the systems documented above plus
a server-authoritative cosmetics economy. This section is the map for that flow.

### Creating your avatar before you drop in

The lobby's **Create your avatar** modal (`src/game/coincommunities-ui.js`, `_openCreate()`)
offers three real paths, each ending in a GLB the world adopts immediately:

1. **Design your avatar** — opens `AvatarCreator` (`src/avatar-creator.js`) in its default
   editor mode, which loads the Avaturn selfie→3D SDK (`@avaturn/sdk`). No sign-in required;
   the exported GLB is staged locally and used as your avatar instantly, then uploaded in the
   background so peers can load it too (`play-handoff.js`).
2. **Upload a model**: bring a `.glb` or `.vrm` from Blender, Mixamo, VRoid, or any tool.
   Validated client-side (`avatar-upload.js` `validateGlb`, which accepts both extensions
   since a VRM file is a glTF binary) before it becomes your avatar.
3. **Advanced studio**: opens the native Avatar Studio at `/create/studio` in a new
   tab for deep body/face/hair/clothing sculpting, then saves to your account
   (see [Avatar Studio (native)](/docs/avatar-studio)).

### The in-game wardrobe economy

Once in a world, two systems manage cosmetics, both server-authoritative — no client-trusted
purchase or equip:

- **Shop** (`src/game/cosmetics-shop.js`) — browse the real catalog
  (`/api/cosmetics/catalog`), preview any item live on your avatar, and buy premium pieces
  with real USDC via x402 (`cosmetics-purchase.js` → `/api/x402/cosmetic-purchase`). Ownership
  is recorded server-side (`api/_lib/cosmetics-ownership.js`) and validated by
  `multiplayer/src/economy.js`. Premium cosmetics are intentionally billed in USDC/`$THREE`,
  kept separate from the in-world cash economy (`multiplayer/src/shop.js`) — cash buys tools
  and consumables, cosmetics are a wallet-native collectible layer.
- **Wardrobe / "My Fits"** (`src/game/cosmetics-wardrobe.js`) — every cosmetic you own (free
  tier + unlocked premium), grouped by slot. Equipping sends `equip-cosmetic` to the
  `WalkRoom`, which validates ownership and persists the loadout to your account; the server
  echoes the authoritative profile back so the wardrobe, your local avatar, and every peer who
  can see you all agree on your look — durable across logout and world switches.

### The public ledger: `/fits`

Every premium purchase settles USDC and splits revenue with the creator of the coin world the
fit belongs to, all of it recorded in the settled-sale ledger
(`api/_lib/cosmetics-economy.js`). That ledger has a public page at
[`/fits`](https://three.ws/fits) (`pages/fits.html` + `src/fits.js`, pure helpers in
`src/fits-lib.js`), so the economy is readable without entering a world:

| Section | Source | What it shows |
|---|---|---|
| Rarest fits | `GET /api/cosmetics/leaderboard` | Premium cosmetics ranked by how few wallets own them, rarity breaking ties. Each card deep-links to `/play?coin=<mint>`. |
| Top collectors | same call | Rarity-weighted flex score per account. Guest sessions are labelled as guests with a short tail so several stay distinguishable. |
| Top creators | same call | Real settled USDC earned, with a one-click breakdown per creator. |
| Latest sales | same call | Every settled sale, newest first. |
| Creator earnings lookup | `GET /api/cosmetics/earnings?creator=<wallet>` | Lifetime and 30-day totals, paid vs pending, and the split per cosmetic and per coin world for any wallet. No account required. |

Two rules the page holds to, both covered by `tests/fits-lib.test.js`:

- **Headline numbers are derived from the rows underneath them**, never fetched separately, so
  a KPI can never disagree with the list it summarizes. The volume tile is labelled as the
  sales window the API returned, not as an all-time total.
- **Sub-cent sales keep their precision.** Cosmetic prices run below a cent; collapsing them to
  `$0.00` would misreport what a creator is owed.

Coin mints on this page are runtime ledger values. Nothing hardcodes a mint.

Both panels are also reachable from the HUD (Shop / **My Fits** buttons,
`coincommunities-ui.js`), from the in-world flex panel (`src/game/cosmetics-flex.js`, which
links out to `/fits` for the full ledger), and from two physical storefronts in the world
itself:

### The boutique — walking storefronts, not just a menu

`src/game/world-zones.js` reserves two `boutique` stall coordinates on the Downtown ring,
mirrored onto the plaza's diagonal opposite the general-store "vendor" stalls so nothing stands
on top of anything else (`boutique-se` at `(44, 44)`, `boutique-nw` at `(-44, -44)`).
`src/game/npc/npc-catalog.js` seats two townspeople on them, using the same data-driven
interactive-NPC engine (`npc.js` / `world-life.js`) every other vendor in the plaza already
uses:

| NPC | Stall | Press E → |
|---|---|---|
| Roux · Tailor | `boutique-se` | Opens the real Shop panel (`world.openShop()`) |
| Nell · Fitting Room | `boutique-nw` | Opens the real Wardrobe panel (`world.openWardrobe()`) |

Walk up, get the proximity prompt, press E (or tap on touch), and the exact same
server-validated panels above open — cosmetics customization now has a physical place to
stand in the world, the way GTA Online's clothing stores do, instead of living only behind a
HUD button.

---

## Limitations

- **Humanoid avatars only.** Avatar Studio is designed for bipedal human characters. It does not support animals, robots, or abstract shapes.
- **No clothing physics.** Cloth simulation is not available — clothing is static. Skirts and loose fabric won't move with the character.
- **Asset library scope.** Customization is limited to items in the included asset library. Adding entirely new clothing shapes requires creating a 3D asset and submitting it to the library.
- **Granular face morphing.** Individual face feature morphing (e.g., nose width, cheekbone height via sliders) is not yet available — face customization is preset-based.

For cases that need more control than the studio provides, create your avatar in Blender or another 3D tool and import the GLB directly into the three.ws editor.

## Related

- [Avatar Studio (native)](/docs/avatar-studio): the from-scratch builder at /avatar-studio
- [Avatar creation](/docs/avatar-creation): the selfie photo-to-avatar path
- [Editor Guide](/docs/editor): refine any exported GLB
- [Animations](/docs/animations): the clip library every avatar can play
