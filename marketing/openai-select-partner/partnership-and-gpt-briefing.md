# three.ws and OpenAI: the full briefing

Everything three.ws has with OpenAI, in one place: the partnership itself, what
the Select tier does and does not grant, the custom GPT that is live on
chatgpt.com, the free MCP connector behind the ChatGPT app, the contracts both of
them call, the compliance posture that got them there, the brand rules that
govern how we talk about it, and the items that are still open.

Written 2026-08-15. Every live claim in the "Live verification" section was
probed against production the same day; every historical claim cites the artifact
in this repo that records it.

---

## 1. Executive summary

three.ws is an **OpenAI Select Partner** in the OpenAI Partner Network. The
application was accepted on **2026-07-14** (welcome email to nich@three.ws), the
three.ws organization was verified on platform.openai.com the same day, and the
status was announced publicly on **2026-07-25** across `/openai`, a blog post, the
partner directory, the timeline, and the holder changelog.

The partnership sits on top of a real, shipped product surface rather than a
logo swap. three.ws ships **four live surfaces on OpenAI platforms**, all free,
all keyless, all open source:

1. **The three.ws 3D Studio connector** (Apps SDK / MCP) at
   `https://three.ws/api/mcp-studio`, ten tools, no authentication.
2. **The "three.ws 3D Studio" custom GPT**, published publicly in the GPT Store
   since 2026-07-14, calling a REST Actions contract at `/api/3d/studio`.
3. **AR from the conversation**: every generation carries a one-tap
   place-in-your-room link that routes to Quick Look on iOS, Scene Viewer on
   Android, and the WebGL viewer on desktop.
4. **Spatial MCP**, an open CC0 response shape that makes a live 3D scene a
   first-class tool result instead of a URL in a text blob. three.ws is the
   reference implementation.

Two things are still open, both human-gated: the **final submit** of the app to
the OpenAI App Directory (the package is complete and audited), and the **press
release**, which OpenAI must approve in writing before it can be published.

---

## 2. The partnership itself

**Tier.** Select, the entry tier of the OpenAI Partner Network. The correct way
to write it in copy is exactly "OpenAI Select Partner". Not "OpenAI partner" as a
description of status, not "partnered with OpenAI on <product>", and never a tier
above Select.

**Dates that matter.**

| Date | Event | Source of record |
| --- | --- | --- |
| 2026-06-28 | Free 3D Studio connector ships, five tools | `data/changelog.json` |
| 2026-07-07 | Persona tools land (three more); App Directory submission package assembled | `data/changelog.json`, `prompts/store-submissions/_generated/openai-submission.md` |
| 2026-07-14 | Accepted into the OpenAI Partner Network; organization verified on platform.openai.com; custom GPT published publicly in the GPT Store | `openai-submission.md` §0, `TRACKER.md` |
| 2026-07-15 | Partner Network + ChatGPT presence recorded on the public timeline | `data/timeline.json` |
| 2026-07-25 | Named an OpenAI Select Partner; `/openai` page, blog post, partner card, changelog entry all go live | `data/changelog.json`, `data/timeline.json`, `data/pages.json` |
| 2026-07-28 | Announcement graphics and the X wording decision ("OpenAI Partner" on X only) | `badge-usage.md`, `social-copy.md` |
| 2026-07-29 | Custom GPT QA pass; three builder-config defects found and fixed | `docs/chatgpt-3d-studio-gpt.md` |
| 2026-08-06 | Tier story re-verified live; docs reconciled to the ten-tool surface | `forge-free-tier-evidence.json`, `data/changelog.json` |

**What the Select tier grants.** Use of the OpenAI Partner Network badge under
the rules in `badge-usage.md`, OpenAI's approved starter messaging and approved
hashtags (`#OpenAISelectPartner`, `#OpenAIPartnerNetwork`), access to the partner
portal, and access to PartnerU (role-based enablement and badging) plus the OPN
Policy Guide.

**What it does not grant.** It is not an endorsement of any three.ws product.
Every surface that carries the badge also carries an independence line, and that
line is load-bearing: "three.ws is an independent member of the OpenAI Partner
Network at the Select tier. This page describes three.ws products that integrate
with OpenAI platforms; it is not an OpenAI product and is not endorsed by OpenAI
beyond the partner designation shown." It also does not put three.ws in the
**Partner Locator**, which is a benefit of the Advanced and Elite tiers only. The
requirements for progressing tiers are in the OPN Policy Guide in the portal.

---

## 3. The custom GPT on chatgpt.com

**Live URL:**
`https://chatgpt.com/g/g-6a563a3b49a88191abf346245491a444-three-ws-3d-studio`

Published publicly (Share to Everyone) on 2026-07-14 and returning HTTP 200 to a
logged-out visitor as of today. The builder profile name attribution is set to
"three.ws", and domain verification for the clickable byline was completed through
the Manage Domain flow (the modal rendered blank on the first attempt; reopening
it fixed that).

**What it does.** The user describes an object and the GPT calls the three.ws
generation Action, which returns a real, downloadable GLB plus a browser viewer
link and an AR link. There is no account, no key, and nothing to pay: the
generation lane is operator-funded.

**Builder configuration** (canonical copy in `docs/chatgpt-3d-studio-gpt.md`,
because the GPT is configured by hand in the ChatGPT builder UI):

| Setting | Value |
| --- | --- |
| Name | three.ws 3D Studio |
| Web Search | Off |
| Apps (Beta) | Off |
| **Image Generation** | **Off. This is load-bearing.** |
| Code Interpreter & Data Analysis | Off |
| Action | Imported from URL: `https://three.ws/.well-known/3d-studio-openapi.yaml` |
| Action auth | None |
| Privacy policy | `https://three.ws/legal/privacy` |
| Conversation starters | Four, each naming exactly one concrete subject |

**Why Image Generation being off is load-bearing.** QA on 2026-07-29 ran the four
suggested prompts and three of them failed. "Make me a low-poly fox for my game"
produced a DALL-E picture and never called the Action. "Create a dragon
miniature" produced a picture plus two fabricated links (`three.ws/models/<id>.glb`
and `three.ws/preview/<id>`), neither of which is a real route; both 404ed. "Create
a 3D mascot" stalled on clarifying questions. Only "Surprise me" worked end to
end. Three root causes, all configuration rather than code:

1. With DALL-E available, the model sometimes satisfied a 3D request by painting
   an image. Instruction text telling it not to return a PNG did not reliably
   stop it. Only unchecking the capability did.
2. An instruction reading "Always return GLB file links from https://three.ws"
   pushed the model to invent three.ws-hosted URLs, because real GLB downloads
   live on a `pub-*.r2.dev` CDN host. The corrected instructions say the
   opposite: present URLs exactly as the Action returned them, and the R2 host is
   correct.
3. The builder held a hand-pasted, stale copy of the Action schema with no
   `arUrl`, `previewImageUrl`, `tier`, `etaSeconds`, or title-carrying poll path.
   The rule now is to re-import from the served URL after any spec change and
   never hand-edit the schema inline.

**The starter design rule.** Every conversation starter must name one concrete
subject so the GPT can generate immediately without asking a question. "Create a
3D mascot for my community" was dropped for stalling. At least one starter should
surface the AR link.

**The instruction text** (checked in verbatim so the builder can be re-pasted)
encodes: one iron rule that the Action is the only way to produce a model; never
show a URL an Action did not return; rewrite vague requests into one concrete
subject; every generation is a new model (no in-place editing, fold the change
into the prompt and regenerate); present three labeled links on a finished model
(download GLB, browser viewer, AR); on a pending response hand the user the
`watchUrl` immediately and keep polling the returned poll path verbatim; the
age-13+ safety posture; and a standing rule never to mention pricing, because
this GPT is simply free.

**Known behaviors we do not control.** Free-tier ChatGPT renders third-party ads
directly beneath the GPT's replies (Meshy AI was observed during QA). Nothing on
our side changes that.

**Housekeeping still open.** An earlier draft GPT exists at
`g-6a5672fbf3f48191b559e482c7fcbf51` and should be deleted from My GPTs so it
cannot be confused with the published one.

---

## 4. The Actions contract the GPT calls

The GPT imports `https://three.ws/.well-known/3d-studio-openapi.yaml`, which is
served from `public/.well-known/3d-studio-openapi.yaml` and is the single source
of truth. The custom-GPT Action file in the submission kit
(`prompts/store-submissions/_generated/openai-actions.yaml`) is regenerated from
the served schema by `npm run sync:studio-openapi`, and drift between them fails
`npm run check:studio-openapi`, which is wired into `npm run gate`.

Submit:

```bash
curl -s -X POST https://three.ws/api/3d/studio \
  -H 'content-type: application/json' \
  -d '{"prompt":"a small ceramic robot figurine"}'
```

The response is either the finished model or a job to poll, and the design
decisions behind that are deliberate:

- **Store-clean responses.** The payload carries model URLs and job state only.
  No pricing, no upgrade hints, no internal identifiers, no wallet or token
  surface. That is what makes it publishable as a GPT Store action. The
  agent-facing twin, `POST /api/3d/generate`, returns the same core fields plus
  `free` and `upgrade`.
- **The title-carrying poll.** ChatGPT Actions never resend context, so the
  submit response embeds the prompt in the poll URL as `&title=`. When the poll
  finally returns done, the `arUrl` and `viewerUrl` arrive labeled with the
  original prompt without the GPT doing anything but calling the poll path
  verbatim.
- **Timeout honesty.** Actions calls time out around 45 seconds and generation
  takes longer, so the endpoint holds the request as long as it safely can and
  falls back to `pending` plus a poll handle rather than dying mid-request. A
  `watchUrl` gives the user a live countdown page, and `previewImageUrl` shows
  the painted concept art while the mesh is still being sculpted.
- **Tiers.** `draft`, `standard`, `high`. **Standard is the default** on both the
  Actions and MCP surfaces, and an attempt to make high the default
  (`d97e8e94d`) was rolled back (`b39d6e2f7`). Evidence recorded live on
  2026-08-06 and read back from the durable `forge_creations` row rather than
  inferred from response text: a no-tier call took 164s on `trellis_selfhost` and
  produced a 5.07 MB GLB; an explicit `tier:"high"` call took 144s on the
  self-hosted `hunyuan3d` worker and produced a 2.69 MB GLB. High degrades to
  standard on a 402 or a submit timeout rather than failing the conversation.
- **Safety before GPU.** Every prompt passes an age-13+ appropriateness gate
  (`api/_mcp-studio/safety.js`) before any provider work. Refusals return
  `400 prompt_rejected` with a plain-language message, and the GPT is instructed
  never to reword a prompt to slip past it.

---

## 5. The free MCP connector (the ChatGPT app)

Endpoint `https://three.ws/api/mcp-studio`. Transport is streamable HTTP,
JSON-RPC 2.0 over POST (GET returns 405). Protocol version `2025-06-18`.
`serverInfo` is `three-ws-3d-studio-free` 1.0.0. Auth mode: **none**. Because the
app is anonymous and free, OpenAI's "provide a demo account with test
credentials" requirement does not apply, and the submission form says so
explicitly.

**Ten tools**, verified live today: six generation tools (`forge_free`,
`text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`, `refine_model`), the
read-only `check_job` collector that picks up a generation which outran its tool
call, and three persona tools (`create_agent_persona`, `get_agent_persona`,
`persona_say`) that give an assistant a persistent, lip-syncing body in the
panel.

**The inline widget** is the `<model-viewer>` skybridge component built in
`api/_mcp-studio/component.js`, resource `ui://widget/three-studio-model.html`,
with a persona sibling `ui://widget/three-studio-persona.html`. It is linked to
every generation tool through the tool's `_meta["openai/outputTemplate"]`. That is
the widget an OpenAI reviewer sees. It renders the GLB, frames it, casts a ground
shadow, auto-rotates until dragged, and offers Download, Spin, Recenter, and Open
in three.ws, with a graceful download-or-open fallback where WebGL is
unavailable.

**Funding and limits.** Generation is operator-funded and routing is free-first
through a health-aware router, so the marginal cost per generation is normally
zero and the caller is never asked for anything. Real per-IP abuse protection
still applies: 4 generations per minute, 30 per hour, 20 persona writes per
minute, 300 transport requests per minute, plus a platform-wide breaker across
all free-studio callers. Discovery calls and `check_job` never consume generation
quota. Per-IP caps fail open on a limiter outage because a Redis blip must not
dead-end a free feature; the platform-wide breaker deliberately fails closed,
since a limiter outage is exactly when unbounded global spend would do damage.

**Compliance posture** (full audit in
`prompts/store-submissions/_generated/openai-submission.md`, 7/7 policy items
PASS):

- **Zero crypto or payment surface.** The endpoint, its handlers, the widget, and
  every reviewer-facing JSON artifact contain no coin, token, wallet, x402, or
  payment string, and `tests/mcp-studio.test.js` pins that with a regex assertion
  in CI. The paid, wallet-enabled studio is a completely separate endpoint at
  `/api/mcp-3d` and shares none of this surface.
- **Data minimization.** The raw internal generation record has fourteen fields;
  the tool response returns five. Stripped: `creation_id`, `job_id`, `status`,
  `mode`, `path`, `tier`, `backend`, `durable`, `eta_seconds`,
  `estimated_credits`, `preview_image_url`, `reference_image_urls`. No session id,
  trace id, user id, or PII. Inputs are minimal too, with
  `additionalProperties: false` on every schema.
- **Correct tool annotations** on all ten tools (read-only, destructive,
  idempotent, open-world hints), with the rationale for each documented.
- **Clear utility not native to ChatGPT.** ChatGPT cannot turn language into a
  manipulable, downloadable 3D asset. That is the whole value proposition.

**Submission state.** Ready to submit. Both historical blockers are resolved and
re-verified live: the rate-limiter store outage that made every generation return
429 (fixed permanently by moving to self-hosted Redis) and the `/viewer?src=`
404 that made the `viewerUrl` in every tool response a dead link. What remains is
the owner's **final submit in the partner portal**, plus a re-capture of the two
landscape screenshots against the shipped inline widget (the earlier captures
were taken against a standalone viewer bundle that has since been deleted and
must not be reused).

---

## 6. AR and Spatial MCP

Every generation on both surfaces carries an `arUrl` of the form
`https://three.ws/api/ar?src=<glbUrl>&title=<name>`, built by one shared
constructor. ChatGPT's only job is to print the link. `GET /api/ar` reads the
User-Agent server-side and branches: iPhone and iPad get a launch page whose
button opens Apple Quick Look, with the USDZ generated from the GLB on the fly in
the page (no server-side USD tooling exists or is needed); Android gets a 302
straight into Google Scene Viewer through an ARCore intent, with a browser
fallback; desktop falls back to the WebGL viewer, so the link is never a dead
end. Rigged avatars carry `kind=avatar`, which swaps the flow to a "Bring it to
life" handoff into `/irl`, where the avatar walks, animates, and talks through the
user's camera. Shared AR links unfurl with a real render of that exact model,
produced by a public GLB-to-PNG renderer at `/api/render/glb`.

**Spatial MCP** is the open, CC0 response shape for returning a live 3D scene as
a first-class MCP result: scene GLB, camera, environment, animation, AR handoff.
It is renderer-agnostic, carries no payment or coin surface, and three.ws is the
reference implementation. It is one of the four things the `/openai` page claims,
and it is the piece that makes the partnership a standards play rather than a
single integration.

---

## 7. Brand, badge, and messaging rules

The badge assets are OpenAI's, supplied unmodified, and ship with the site at
`https://three.ws/partners/openai/openai-select-partner.svg` (preferred) and
`@3x.png`. The rules that came with them: use the badge as provided (no recolor,
crop, rotation, effects, or rebuilding from parts; on a dark surface put it on a
white plate rather than inverting it), keep clear space of roughly half its cap
height on every side, write the status as "OpenAI Select Partner" in copy, never
imply OpenAI endorses a three.ws product, and never use the badge as a product
logo, favicon, or app icon.

For social posts and link previews we attach an announcement card rather than the
bare badge, because the badge alone reads as OpenAI's mark rather than our
announcement and carries none of the required independence line. Five cards exist
(announcement, announcement with the short "OpenAI Partner" phrasing for X, the
Studio product card with no badge, and two-mark lockups on white and black). All
are regenerated from `cards/social-card.html` with `npm run build:openai-cards`.

One caveat carries real risk and must not be dropped: the **two-mark lockups use
OpenAI's logomark, not the partner badge**. OpenAI's brand guidelines govern the
logomark separately, and a co-branded lockup is the kind of use those guidelines
normally expect a partner to clear first. This was the owner's call on
2026-07-28. For a compliant announcement graphic, use
`social-card-announcement.png`.

---

## 8. Where this is live on the site

| Surface | Path |
| --- | --- |
| Partner page | `/openai` (`pages/openai/index.html`) |
| Announcement post | `/blog/three-ws-openai-select-partner` |
| Partner directory card | `/partners` |
| Timeline marker | `/timeline` |
| Changelog entries | `/changelog` |
| Press kit (journalist-ready assets) | `/press` |

---

## 9. The press release: the one blocking step

The draft in `press-release.md` is complete and written against OpenAI's own
partner template. **OpenAI requires written approval before a partner publishes a
press release about tier status.** The process: confirm the two bracketed fields
(dateline city, currently Wilmington, Delaware, matching the governing-law
jurisdiction in our terms; and the spokesperson's name and title on the quote),
email the full release to **rachel.kim@c-openai.com** for review, wait for written
approval, and only then publish or distribute.

Nothing else in the announcement pack is gated. The badge, the site pages, and
the social copy all use OpenAI's own approved assets and approved messaging.

---

## 10. Live verification, 2026-08-15

Probed against production today:

| Check | Result |
| --- | --- |
| GPT Store page, logged out | HTTP 200 |
| `/openai` partner page | HTTP 200 |
| `/.well-known/3d-studio-openapi.yaml` | HTTP 200 |
| Badge SVG | HTTP 200 |
| MCP `tools/list` | 200, ten tools, exactly the documented set |
| `GET /api/3d/studio?job=bogus123` | 400 `invalid_job` in 0.43s, correct designed error |
| `POST /api/3d/studio` (new prompt) | **No response within 100s** |
| `POST /api/3d/generate` (new prompt) | **No response within 100s** |
| `POST /api/3d/generate` (previously generated prompt) | 200 in 0.34s with a real GLB and `arUrl` |

**The generation submit path is degraded right now, and it affects the custom
GPT.** Production logs over the last half hour show the free NVIDIA NIM text-to-3D
lane returning 504, the paid TRELLIS lane rate-limited and degrading to that same
NIM lane, and the Vertex reference-image lane returning 403. In
`api/_mcp-studio/gpt-forge-client.js`, `startForge` waits up to 90 seconds for the
job to be **accepted**, and on a timeout it retries the accept once, so a fully
blocked submit path can hold a request up to about 180 seconds before any
response. ChatGPT Actions give up at roughly 45 seconds, so in this state the GPT
shows the user a failed action rather than the documented `pending` plus watch
link. Discovery, polling, the safety gate, cached prompts, and every read path are
unaffected. The fix belongs in the accept path (fall back to `pending` well inside
the Actions deadline instead of blocking on an unhealthy upstream) and in the
lane chain (a healthy rung ahead of the 504ing NIM lane); it is not a partnership
or configuration issue.

---

## 11. Open items

| Item | Owner | Notes |
| --- | --- | --- |
| Final submit of the app in the OpenAI partner portal | Owner | Package complete, 7/7 policy PASS |
| Re-capture the two landscape widget screenshots | Owner | Must be the shipped inline widget, rendering a real generated GLB |
| Delete the draft duplicate GPT `g-6a5672fbf3f48191b559e482c7fcbf51` | Owner | Avoids confusion with the published GPT |
| Press release: fill two fields, email for OpenAI approval | Owner | rachel.kim@c-openai.com, do not publish before written approval |
| Free generation submit path degraded (see §10) | Engineering | Actions deadline vs 90s-plus-retry accept window |
| "Nine tools" drift in older copy | Engineering | See below |

**The nine-versus-ten drift.** The connector shipped with five tools, grew to
nine, and reached ten when `check_job` landed. `/openai` and `docs/mcp-studio.md`
were reconciled to ten on 2026-08-06, but three announcement-era documents still
say nine: `press-release.md`, `social-copy.md` (both the X and LinkedIn copy), and
the OpenAI section of `docs/partners.md`. The press release is the one that
matters most, because it has not been sent yet and would go out with a number
that is now wrong. Fix all three before the release is emailed for approval.

---

## 12. File map

| Piece | Path |
| --- | --- |
| Announcement pack index | `marketing/openai-select-partner/README.md` |
| Press release draft | `marketing/openai-select-partner/press-release.md` |
| Badge rules and assets | `marketing/openai-select-partner/badge-usage.md` |
| Social copy | `marketing/openai-select-partner/social-copy.md` |
| Custom GPT builder config | `docs/chatgpt-3d-studio-gpt.md` |
| AR pipeline | `docs/chatgpt-ar.md` |
| Free MCP connector docs | `docs/mcp-studio.md` |
| Paid sibling server | `docs/mcp-3d-studio.md` |
| Partner ecosystem overview | `docs/partners.md` |
| App Directory answer sheet and audit | `prompts/store-submissions/_generated/openai-submission.md` |
| Submission status tracker | `prompts/store-submissions/_generated/TRACKER.md` |
| Apps SDK handoff pack | `prompts/openai-pr/00-START-HERE.md` |
| Actions endpoint | `api/3d/studio.js` |
| MCP connector | `api/mcp-studio.js`, `api/_mcp-studio/*` |
| Inline widget | `api/_mcp-studio/component.js` |
| Served Action schema | `public/.well-known/3d-studio-openapi.yaml` |
| Partner page | `pages/openai/index.html` |
