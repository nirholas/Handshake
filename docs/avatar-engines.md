# Avatar Engines Atlas

A factual map of the open-source and commercial systems that build high-quality and photoreal 3D human avatars: Gaussian-splat heads, single-photo humans, text-to-avatar generators, and the production rig formats three.ws already animates. For each engine the atlas states what it makes, what it eats, what it runs on, what its license permits, and exactly how (or whether) three.ws can use it today.

Page: [/avatar-engines](https://three.ws/avatar-engines)

This is a reference surface, not an endorsement and not a leaderboard. It exists because the answer to "which engine should I use for a realistic avatar?" is almost never about output quality alone. The best-looking research engines in this field ship under non-commercial research licenses, and the honest answer for a commercial builder is usually a different engine than the one topping the benchmarks. The atlas puts the license and the integration reality next to the technique so that trade-off is visible in one glance.

## What the atlas covers

24 engines across 5 families. The source of truth is [`src/avatar-engines-data.js`](../src/avatar-engines-data.js); the page ([`src/avatar-engines.js`](../src/avatar-engines.js)) renders straight from it with no network call, so the page and the data can never disagree.

| Family | Entries | What it collects |
| --- | --- | --- |
| Photoreal head avatars | 5 | Gaussian-splat and neural-field heads reconstructed from video, the current state of the art for realistic faces |
| Image to 3D human | 5 | One photo (or a few) into a posed, clothed, textured 3D human you can rig |
| Text / image to 3D avatar | 5 | Generative pipelines that author a whole avatar from a prompt, the lane three.ws Forge lives in |
| Parametric body and face models | 4 | The statistical human models nearly every method above is built on, the foundation layer |
| Production and interop | 5 | Battle-tested avatar formats and platforms, the rigs three.ws already loads and animates |

The counters in the page header are derived, not typed: total entries, family count, how many are live in three.ws, and how many permit commercial use.

## How entries are classified

Each entry carries six classification fields plus its links.

**Family.** Which of the five groups above it belongs to. The page groups by family by default, in the order listed.

**Representation.** What the engine actually outputs, which is what determines whether the three.ws animation pipeline can drive it at all:

| Representation | Meaning |
| --- | --- |
| `mesh` | A skinned or standard polygon mesh. Riggable, exportable as GLB. |
| `gltf` | A standard rigged avatar format (glTF or VRM). Loads directly in the viewer. |
| `parametric` | A statistical body or face model (the SMPL family) that other methods build on. |
| `gaussian` | A Gaussian-splat radiance field. Photoreal, and needs a splat renderer. |
| `nerf` | A neural or volumetric field. Photoreal, rendered by ray marching, not rigged. |

Mesh and glTF output can be animated by the skinned-mesh pipeline. Gaussian and neural-field output cannot: it needs the splat or volume renderer instead.

**License** is the project's own license string, recorded as the project states it, and **commercial** is a boolean shorthand for "this license permits commercial use as-is". The two are separate fields on purpose: the string carries the nuance (a project can be MIT for code and research-only for its released weights), while the boolean is what the "commercial-use only" filter and the card badge read.

**Compute** is the honest runtime profile: cloud API, client-side, CPU or GPU real-time, GPU inference, or per-subject and per-prompt GPU training. For several of the photoreal engines this is the real gate rather than the license, because a per-subject training run is not something you put behind a button.

**Venue and year** record where the work was published (a conference, a preprint, an open standard, or a commercial service) and when, which is what the "newest" sort uses.

**Links** point at the project's own repository, paper, docs, and demo, plus an optional call-to-action into the three.ws surface that consumes its output. `docs` exists so that official documentation is labelled "Docs" on the card: before it, a documentation site parked in the `paper` field rendered as a "Paper" button and misstated what the reader was about to open. A link is only recorded once, so an entry whose repository, docs, and demo are all the same URL renders one button, not three.

**Status** is optional and has one value, `retired`, meaning the project or the service behind it no longer operates. A retired entry keeps its card and gains a Retired badge, because deleting it would strand the builders who still hold assets it produced; what it loses is any claim on the present tense. A retired entry can never be `live` or `forge`, its `integrationNote` has to say what happened and what still works, and if the shutdown ended commercial availability then `commercial` goes to `false` with it. [Ready Player Me](https://github.com/readyplayerme) is the current example: Netflix acquired it and closed the public avatar creator and developer API on 31 January 2026, while the rigged glTF files it exported before then still load and animate in the three.ws viewer exactly as they always did.

## How integration status is defined

`integration` is the answer to one question: can a reader click something on three.ws today and get a result from this engine? Five values, ordered from most to least wired:

| Status | Label on the page | What it means |
| --- | --- | --- |
| `live` | Live on three.ws | Already wired into a three.ws product surface you can use right now. |
| `forge` | Generate in Forge | Commercially licensed and reachable through the live text and image to GLB pipeline at [/forge](https://three.ws/forge). |
| `splat` | View in Splat Viewer | Produces Gaussian-splat or radiance-field output you can drop into the three.ws [splat viewer](./splat.md). |
| `interop` | Interop | Emits a standard rigged format (glTF, VRM, FBX) that the three.ws viewer and animation pipeline already understand. |
| `reference` | Reference / self-host | Run it yourself. Its license or its compute profile keeps it out of the commercial pipeline. It is listed here for builders. |

Each entry also carries an `integrationNote`, one sentence naming the specific three.ws surface or bone-mapping involved, so `reference` never reads as a shrug.

The current distribution is 2 `live`, 3 `interop`, 3 `splat`, and 16 `reference`. That last number is the point of the atlas: most of the highest-fidelity work in this field is research code under a non-commercial license, and three.ws deliberately does **not** wire any of it into the paid generation backend. Only commercial-use mesh engines deep-link into the live pipeline. Non-commercial research engines are surfaced with their repository and paper for self-hosted and academic use, and that is the whole extent of the relationship.

## The registry

Every field below is reproduced from [`src/avatar-engines-data.js`](../src/avatar-engines-data.js). "Commercial" is the entry's own `commercial` flag, meaning the license permits commercial use as-is.

### Photoreal head avatars

| Engine | Org | Year | Output | License | Commercial | Integration | Runs on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GaussianAvatars | Qian et al. · TU Munich / Toyota | 2024 | gaussian | Non-commercial research (Gaussian-Splatting + FLAME) | No | splat | GPU training, per-subject |
| Gaussian Head Avatar | Xu et al. · NeRSemble | 2024 | gaussian | Non-commercial research | No | splat | GPU training, per-subject |
| INSTA | Zielinski et al. · MPI | 2023 | nerf | Non-commercial research | No | reference | GPU training (minutes) |
| IMavatar | Zheng et al. · ETH / MPI | 2022 | nerf | Non-commercial research | No | reference | GPU training, per-subject |
| GeneFace++ | Ye et al. · Zhejiang Univ. | 2023 | nerf | MIT (code) · research models | No | reference | GPU training + inference |

### Image to 3D human

| Engine | Org | Year | Output | License | Commercial | Integration | Runs on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PIFuHD | Saito et al. · Meta AI | 2020 | mesh | CC BY-NC 4.0 (non-commercial) | No | reference | GPU inference (Colab available) |
| ECON | Xiu et al. · Max Planck | 2023 | mesh | Non-commercial research (Max Planck) | No | reference | GPU inference |
| ICON | Xiu et al. · Max Planck | 2022 | mesh | Non-commercial research (Max Planck) | No | reference | GPU inference |
| SiTH | Ho et al. · ETH Zürich | 2024 | mesh | Non-commercial research | No | reference | GPU inference (diffusion) |
| PIFu | Saito et al. · USC / Meta | 2019 | mesh | Custom research (non-commercial) | No | reference | GPU inference |

### Text / image to 3D avatar

| Engine | Org | Year | Output | License | Commercial | Integration | Runs on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TRELLIS | Microsoft Research | 2024 | mesh | MIT | Yes | live | Cloud API (NVIDIA NIM / self-host) |
| TADA! | Liao et al. · MPI / ETH | 2024 | mesh | Non-commercial research (SMPL-X) | No | reference | GPU optimization (per-prompt) |
| HumanGaussian | Liu et al. · NTU / Shanghai AI Lab | 2024 | gaussian | Non-commercial research | No | splat | GPU optimization (per-prompt) |
| AvatarCLIP | Hong et al. · NTU | 2022 | nerf | Non-commercial research | No | reference | GPU optimization |
| DreamHuman | Kolotouros et al. · Google | 2023 | nerf | Research (paper + page; no official weights) | No | reference | GPU optimization |

### Parametric body and face models

| Engine | Org | Year | Output | License | Commercial | Integration | Runs on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SMPL-X | Pavlakos et al. · Max Planck | 2019 | parametric | Non-commercial research (Max Planck) | No | reference | CPU/GPU (real-time) |
| SMPL | Loper et al. · Max Planck | 2015 | parametric | Non-commercial research (Max Planck) | No | reference | CPU/GPU (real-time) |
| FLAME | Li et al. · Max Planck | 2017 | parametric | Non-commercial research (Max Planck) | No | reference | CPU/GPU (real-time) |
| STAR | Osman et al. · Max Planck | 2020 | parametric | Non-commercial research (Max Planck) | No | reference | CPU/GPU (real-time) |

### Production and interop

| Engine | Org | Year | Output | License | Commercial | Integration | Runs on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mixamo | Adobe | 2008 | gltf | Free for use (Adobe terms) | Yes | live | Cloud service |
| Ready Player Me (retired) | Ready Player Me (Netflix) | 2020 | gltf | Commercial SDK (service discontinued) | No | reference | Cloud API (offline) |
| VRM / UniVRM | VRM Consortium · pixiv | 2018 | gltf | MIT | Yes | interop | Client |
| three-vrm | pixiv | 2020 | gltf | MIT | Yes | interop | Client (Three.js) |
| Avaturn | Avaturn | 2022 | gltf | Commercial SDK | Yes | interop | Cloud API |

## Using the page

The atlas is a filterable catalog, and every filter reflects into the URL query, so any view you can build is a link you can send.

- **Search** matches the engine name, org, blurb, input, output, license, and venue. It is debounced, so typing does not thrash the render.
- **Family** and **integration** dropdowns narrow to one group or one integration status.
- **Sort** is by family (grouped, the default), newest, or A to Z. Picking an explicit sort flattens the grouping into a single grid.
- **Commercial-use only** is a toggle that drops every entry whose license does not permit commercial use as-is.
- **Reset filters** clears everything, and the empty state offers it directly when a filter combination matches nothing.

The page has no network call of its own, so its failure mode is the registry script not arriving at all. Until that script renders, the results area holds a skeleton grid; if six seconds pass after load with nothing rendered, or the render throws, the skeleton is replaced by an error state that offers a reload and a link to this document. With JavaScript disabled entirely, the same document is offered in place of the atlas.

Query parameters, for building links by hand:

```
# Only the photoreal head engines.
https://three.ws/avatar-engines?family=photoreal-head

# Everything whose output drops straight into the splat viewer.
https://three.ws/avatar-engines?int=splat

# Commercial-use engines, newest first.
https://three.ws/avatar-engines?commercial=1&sort=newest

# A text search.
https://three.ws/avatar-engines?q=smpl
```

`family` accepts `photoreal-head`, `image-to-human`, `text-to-avatar`, `parametric`, `production`. `int` accepts `live`, `forge`, `splat`, `interop`, `reference`. `sort` accepts `family`, `newest`, `name`. `commercial=1` enables the toggle. `q` is free text.

## Accuracy rules for this atlas

The atlas makes claims about other people's projects and other people's licenses. Those claims have to stay conservative, because a reader may act on them.

- **Every fact comes from the project's own repository or paper**, never from a summary, a blog post, or a recollection. If the upstream project does not state it, the atlas does not claim it.
- **Never upgrade a license claim.** Do not translate an ambiguous license into `commercial: true`, do not simplify "MIT code, research weights" into "MIT", and do not treat a permissive code license as permission to use restricted released models. When in doubt the entry stays `commercial: false` and the license string keeps its nuance.
- **Never upgrade an integration claim.** `integration` describes what is wired *today*, not what could be wired. An engine only becomes `live` or `forge` when a user can reach it from a three.ws surface right now, and the `integrationNote` has to name that surface.
- **License summaries are guidance, not legal advice.** The page says so in its footer, and so does this doc: confirm terms with the upstream project before any commercial use.
- **A project that dies is marked, not deleted.** Set `status: 'retired'`, move the entry off any live claim, and say in the `integrationNote` what shut down, when, and what still works. Silently dropping the row would leave every reader holding its output with no explanation, and silently leaving the row as it was would be a false claim that the service still answers.
- **Re-check the links, not just the prose.** Every entry's links were verified to resolve on 11 August 2026. Two of them had rotted since the atlas was compiled (a project page that had moved, and a paper link pointing at an unrelated preprint), and neither was visible from the text of the entry.
- Listings were compiled from upstream sources current as of June 2026, with link and status verification on 11 August 2026. When you touch an entry, re-check it against the upstream project rather than assuming the recorded value still holds.

To add an engine, append an entry to `ENGINES` in [`src/avatar-engines-data.js`](../src/avatar-engines-data.js) with every field populated (an entry with a missing license or integration note is worse than no entry), and pick its family from the existing five. The page picks it up with no further wiring, and the header counters update themselves.

## Related

- [Splat Viewer](./splat.md): where the Gaussian-splat output of the `splat` engines actually renders in the browser.
- [Scene Capture](./capture.md): the three.ws side of reconstruction, turning real video into 3D, adjacent to the photoreal-head family here.
- [Forge](./forge.md): the live commercial generation pipeline, which the one `live` text-to-avatar engine powers.
- [Agent Identity Studio](./agent-identities.md): that pipeline applied end to end, brand brief to rigged avatar plus studio renders.
- [Animations](./animations.md): the retargeting and clip library that drives the production rigs in the last family.
- [Avatar pipeline](./avatar-pipeline.md) and [avatar creation](./avatar-creation.md): how three.ws produces and processes its own mesh avatars.
