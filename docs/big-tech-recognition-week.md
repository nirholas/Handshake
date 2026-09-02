# Big-tech recognition: the dispatch week of 2026-08-17

The goal for this week is a published mention of three.ws by a major technology
company: on their own website, in their own directory, or from their own social
account.

This doc is the cross-vendor dispatch board. Every other outreach doc in `docs/`
is one vendor deep ([nvidia-visibility-map.md](./nvidia-visibility-map.md),
[partners.md](./partners.md), [listings.md](./listings.md),
[aws-marketplace.md](./aws-marketplace.md), [ibm.md](./ibm.md)). This one is the
only place that ranks all of them against each other by the single question that
matters this week: **what is the probability of a published big-tech mention
within seven days, and what exactly is standing in the way?**

Compiled 2026-08-17 (Monday). Statuses were read from the source of truth for
each surface, not restated from memory. See [Verification log](#verification-log).

---

## The finding that should reorder the week

**Nothing on this board is blocked on strategy, research, capability, or
approval from a big tech company. Six surfaces are sitting at
`ready-to-submit`, and each one is blocked on a single human action that takes
minutes.**

The submission tracker
([`prompts/store-submissions/_generated/TRACKER.md`](../prompts/store-submissions/_generated/TRACKER.md))
carries the OpenAI App Directory at `ready-to-submit` with exactly one open item:
`[HUMAN: final submit in the partner portal / App Directory flow]`. The package is
finalized, the OpenAI Partner Network accepted us on 2026-07-14, the organization
is identity-verified, the GPT Store listing is already live and public, and the
free connector was re-verified against production. The Official MCP Registry is in
the same shape: the `mcp-publisher` commands are staged and the only blocker
recorded is operator approval. The NVIDIA Inception request email is written,
addressed, and its own doc says `**Sent:** not yet sent`.

This is not a pipeline problem. It is a dispatch problem. The company has been
building and researching the surfaces instead of firing them.

The second finding, which follows from the first:

**Big tech does not discover you on X. They reshare you on X after you are
already on their property.** Every big-tech relationship three.ws holds came from
joining the program and then publishing on the company's own developer surface.
There are four such publications live right now (one AWS Builder Center article,
one IBM Community blog post, two NVIDIA Developer Forums posts), and all four were
self-serve. That is a proven, repeatable, gatekeeper-free channel that the company
stopped using. Treat the X mention as the downstream effect, not the campaign.

---

## Tier 1: dispatch this week

Ranked by expected value, which is payoff multiplied by the honest probability of
landing inside seven days. Every row here is self-serve or already accepted, and
none of them waits on a decision from the other company.

| # | Surface | What a win looks like | Blocked on | Effort |
|---|---|---|---|---|
| 1 | **OpenAI App Directory** | three.ws listed inside ChatGPT, on OpenAI's own surface | One portal submit. Package finalized. | Minutes |
| 2 | **NVIDIA Developer Forums, post 3** | Published on `forums.developer.nvidia.com`, NVIDIA's domain, same day | The post is not written. See [The one asset to write](#the-one-asset-to-write). | Half a day |
| 3 | **AWS Builder Center, article 2** | Published on `builder.aws.com`, 5M monthly visitors | Draft exists but is the wrong genre. See note below. | Hours |
| 4 | **Official MCP Registry** | Listed in Anthropic's registry | Operator approval to run the staged publish | Minutes |
| 5 | **IBM Community blog, post 2** | Published on `community.ibm.com` under the existing author account | No post drafted | Hours |
| 6 | **Claude plugin marketplace** | Listed in Anthropic's plugin directory | One submit at `platform.claude.com/plugins/submit` | Minutes |

### 1. OpenAI App Directory (highest payoff on the board)

This is the single most valuable item in this document and it is one action away.

An App Directory listing puts three.ws in front of ChatGPT's user base on OpenAI's
own product surface. Nothing else on this board reaches that audience. The
submission target is the free keyless connector at
`https://three.ws/api/mcp-studio` plus its inline widget and the custom-GPT
Actions surface, all of which are live and re-verified.

- **Package:** [`prompts/store-submissions/_generated/openai-submission.md`](../prompts/store-submissions/_generated/openai-submission.md) (7/7 policy PASS, real screenshots, real captured tool responses)
- **Pre-submission verification pack:** [`prompts/finish/openai-pr-00-START-HERE.md`](../prompts/finish/openai-pr-00-START-HERE.md), with task 07 as the go/no-go gate
- **Standing status:** Partner Network accepted 2026-07-14; organization verified; GPT Store listing live and public
- **Open item:** the final submit in the partner portal

Before the submit, run [`prompts/finish/openai-pr-07-final-verification-and-submit.md`](../prompts/finish/openai-pr-07-final-verification-and-submit.md) against the currently deployed
revision. Its checklist exists precisely because the answer sheet asserts
"verified live" facts dated 2026-07-14 and deployments move. That is a
one-session job, not a blocker.

### 2. NVIDIA Developer Forums, post 3

The only NVIDIA channel with a proven track record, self-serve, and it publishes
on NVIDIA's own domain. Two posts, both live, both landed:

- [How Nemotron made three.ws text-to-3D pipeline usable](https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445)
- [How three.ws translates a web app into 100 languages with NVIDIA NIM](https://forums.developer.nvidia.com/t/how-three-ws-translates-a-web-app-into-100-languages-with-nvidia-nim-an-llm-powered-i18n-pipeline/377379)

Post 3 should be the browser-native digital human, because it is the piece nobody
else has written and it maps exactly onto what NVIDIA's ACE team promotes. See
[The one asset to write](#the-one-asset-to-write) for why this specific topic and
what backs it.

### 3. AWS Builder Center, article 2 (read this before publishing the existing draft)

three.ws has a live Builder Center profile at
[builder.aws.com/community/@threews](https://builder.aws.com/community/@threews)
and one published article, [How we metered a SaaS product through AWS Marketplace
with the AWS SDK for JavaScript v3](https://builder.aws.com/content/3ESpll50BdSp9eiCEIxcfG9pGUN/how-we-metered-a-saas-product-through-aws-marketplace-with-the-aws-sdk-for-javascript-v3)
(2026-05-30). Publishing is self-serve. This is a repeatable win, and
[aws-builder-center.md](./aws-builder-center.md) already carries the checklist for
publishing the next one.

**The caveat.** The obvious candidate for article 2 is
[aws-partner-spotlight.md](./aws-partner-spotlight.md), which is written and
unpublished. It is a company profile, not a technical article. The one that
landed was technical: real code, real API calls, and "the five things that bit
us." Builder Center rewards the second genre and the audience there is builders,
not buyers. Publishing the spotlight piece as-is risks a flat result on the one
AWS channel that is currently working.

Recommended: publish a technical article and keep the spotlight for a venue that
wants a company profile (the APN partner surface, or a pitch to an AWS partner
marketing contact). If the spotlight goes up on Builder Center anyway, that is a
defensible call, just make it knowingly.

### 4 and 6. The Anthropic surfaces, and the gap nobody has named

Two Anthropic surfaces are `ready-to-submit` (Official MCP Registry, Claude plugin
marketplace) and a third, the Claude Connectors Directory, is blocked only on
provisioning an `MCP_REVIEW_SECRET` and a reviewer-credential decision.

Worth naming plainly: **[partners.md](./partners.md) lists eight partners and
Anthropic is not one of them**, even though the platform's agent brain defaults to
Claude models and there are three Anthropic-surface submissions sitting ready.
That is the most underdeveloped big-tech relationship on the board relative to how
much the product already depends on it. Filing the two ready submissions is the
cheapest possible first move, and it costs one approval each.

---

## Tier 2: the one email, sent this week, answered later

The NVIDIA Inception membership carries benefits that have never been requested.
From NVIDIA's own [program page](https://www.nvidia.com/en-us/startups/):
co-marketing assets ("official badges, co-branded social content, and customizable
assets for events") and a Startup Showcase feature ("member spotlights and story
opportunities").

These are entitlements, not favors. They have never been asked for.

**The co-marketing kit is the specific unlock for the X goal.** NVIDIA's social
team can only reshare a post that uses the official badge, tags the right account,
and carries `#NVIDIAInception`. A post that merely names NVIDIA in prose is not
resharable by them. Without the kit, the X ambition has no mechanism behind it.

Send one email to `inceptionprogram@nvidia.com` carrying all five asks. The
existing [Apps Catalog request](./nvidia-apps-catalog-request.md) is already
written and already addressed there; extend that draft rather than opening a
second thread. A program manager who receives one clear email with five asks
answers it. Five separate emails read as noise.

The five asks:

1. Accelerated Apps Catalog inclusion (the existing body of the email)
2. Inception Startup Showcase nomination
3. The co-marketing kit, including the official badge
4. A redirect to the ACE / digital-human team
5. Whether the GTC Inception Startup Pavilion has a slot, and which other events carry startup slots

**One dependency, and it gates the whole email.** The Inception portal product
record currently describes three.ws as a CUDA consumer, which is wrong and which
gates both the Showcase and the Apps Catalog. Correct it at
`programs.nvidia.com/phoenix/application` first. The correction is already
specified in step 1 of [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md).
Nothing in this email lands well while the record misdescribes the product.

---

## Tier 3: ours to drive, no gatekeeper

### The membership post that never happened

[announcement-coverage.md](./announcement-coverage.md) tracks an "announced on X"
column per surface. `/openai` has a real post behind it. **`/nvidia`, added
2026-07-30, has that column empty.** The single biggest NVIDIA credential the
company holds has never been posted on its own channel.

Post it with the official badge (Tier 2 ask #3), `#NVIDIAInception`, and the right
handle for the topic. Handle routing, verified from NVIDIA's
[social directory](https://www.nvidia.com/en-us/contact/social/):

| Topic | Account | Platform |
|---|---|---|
| Digital humans, Audio2Face, Riva, avatars | `@NVIDIAAIDev`, `@NVIDIADeveloper` | X |
| Inception membership, founder story, milestones | NVIDIA for Startups | LinkedIn |
| Nemotron, NIM, inference pipeline | `@NVIDIAAI`, `@NVIDIAAIDev` | X |
| 3D, OpenUSD, scene work | `@NVIDIAOmniverse` | X, LinkedIn, Discord |

Sequence one per week rather than four in a day. Each post is a separate chance
for a reshare, and four in a day collapses four chances into one.

### Recover the Jensen Huang receipt

[`data/timeline.json`](../data/timeline.json) carries event
`2026-07-18-jensen-huang`: NVIDIA's CEO interacted with three.ws content. Its
`source_url` is `null`. Four other NVIDIA timeline events are also nulled,
including the Inception acceptance itself.

An engagement from NVIDIA's CEO is the first line of any Showcase pitch, podcast
nomination, or press approach, and right now it cannot be shown to anyone. This is
the highest-value social proof the company owns and it is currently unciteable.
Recovering the link is a five-minute job for whoever has the account history.
Archive it to `web.archive.org` the same minute it is found, because a deleted
post takes the proof with it.

---

## The one asset to write

**Browser-native Audio2Face-3D is the most differentiated technical story three.ws
has, the demo is already live, and it has never been pointed at NVIDIA.**

The capability is real and deep. [`api/_lib/a2f-nvidia.js`](../api/_lib/a2f-nvidia.js)
implements NVIDIA's ACE `A2FControllerService` as a bidirectional gRPC stream
against `grpc.nvcf.nvidia.com`, with the protos vendored and loaded from a
generated descriptor, audio resampled to the 16 kHz mono PCM the model is trained
on, and the returned blendshape time codes sampled against the original Magpie
audio so the lips track the real voice rather than a resampled copy.
[`src/voice/a2f-player.js`](../src/voice/a2f-player.js) drives it in the browser.
It is wired into the live avatar embed ([`src/avatar-embed.js`](../src/avatar-embed.js))
and the screen anchor, and shipped as the `@three-ws/voice` package.

Most Audio2Face work in the world lives in Unreal or Omniverse. A face lip-syncing
in a browser tab with no install is rare, and it is exactly what NVIDIA's ACE team
promotes.

**There is nothing to build.** The demo is live and public at
[three.ws/demos/audio2face](https://three.ws/demos/audio2face) (and the
`/audio2face` alias), served from
[`public/demos/audio2face.html`](../public/demos/audio2face.html) and documented in
[demo-routes.md](./demo-routes.md). Both routes returned 200 on 2026-08-17. You
type text, hear it in NVIDIA Magpie's voice, and watch the face animate through
ARKit blendshapes, in a browser tab, with no install.

Note for anyone auditing this surface: the demo lives under `public/demos/` rather
than `data/pages.json` or `pages/`, so a grep of the page manifest will report it
missing. It is not missing. Check `docs/demo-routes.md` before concluding
otherwise.

So the dependency under four separate items (the forum post, the ACE team
conversation, the X clip, and next year's GTC abstract) is already satisfied. What
is missing is not the artifact. It is that the artifact has never been pointed at
NVIDIA: no forum post, no clip, no tag to `@NVIDIAAIDev`. A 15-second screen
capture of that page is the most resharable asset the company owns and it costs
one recording.

Write the forum post against the two files named above so every claim has code
behind it, and follow the house style the existing two posts follow: real numbers,
real latencies, no marketing voice. The substance is streaming Audio2Face-3D
blendshape tracks over gRPC into a WebGL avatar, mapping ARKit-52 onto whatever
morph convention the visitor's model ships (ARKit, VRM vowels, Oculus visemes),
with Riva ASR in and Magpie TTS out.

Do not overclaim: three.ws consumes ACE microservices and does not self-host NIM.

---

## Do not chase these this week

Recorded so nobody spends the week on a closed door.

| Surface | Why not |
|---|---|
| **IBM TechXchange 2026** | The call for sessions closed 2026-05-22 and acceptances ran through July. The event is 2026-10-26 to 10-29 in Atlanta. Attendance and hallway conversations are a Q4 play, not a this-week one. |
| **NVIDIA GTC** | The GTC 2026 call for submissions is closed. NVIDIA's own FAQ is already titled for GTC San Jose 2027. Put the [call for submissions](https://www.nvidia.com/gtc/call-for-submissions/) page on a weekly watch, because for a March event recent cycles opened in summer and closed in early fall, which is this month. Missing that window costs a full year. |
| **NVIDIA Technical Blog** | No public guest-submission process. It is editorially controlled. The realistic path is a forum post that performs, then a pitch, which is why Tier 1 #2 comes first. |
| **Omniverse Exchange** | Correctly blocked. OpenUSD interop is roadmap, not shipping. |
| **NVIDIA Connect for ISVs** | Retired. The page 301-redirects to `developer.nvidia.com`; the program folded into the Developer Program. |
| **A self-serve NVIDIA "list my product" form** | None exists on any NVIDIA surface. Every listing runs through the portal record plus a human at `inceptionprogram@nvidia.com`. Stop looking for a form. |
| **AWS Community Builders** | A different program from Builder Center publishing, and its application window opens in January. Publishing on Builder Center needs no membership. |

---

## The week

Ordered so that the items with the longest external latency go out first.

| Day | Action | Owner |
|---|---|---|
| Mon 08-17 | Run [openai-pr task 07](../prompts/finish/openai-pr-07-final-verification-and-submit.md) against the live revision, then **submit the OpenAI App Directory package** | Owner (portal) |
| Mon 08-17 | Approve and run the staged **MCP Registry** publish; submit **`three-ws-3d`** to the Claude plugin marketplace | Owner (approval), agent (commands) |
| Tue 08-18 | Correct the **NVIDIA Inception portal product record** | Owner |
| Tue 08-18 | Send the **five-ask Inception email** to `inceptionprogram@nvidia.com` | Owner |
| Tue 08-18 | Recover and archive the **Jensen Huang receipt** | Whoever has account history |
| Wed 08-19 | Record a 15-second capture of the **live Audio2Face demo**; write **NVIDIA Developer Forums post 3** against it | Agent |
| Thu 08-20 | Publish **forums post 3**; post the clip on X tagging `@NVIDIAAIDev` | Owner posts |
| Thu 08-20 | Post the **Inception membership** on X with the official badge and `#NVIDIAInception` | Owner |
| Fri 08-21 | Publish **AWS Builder Center article 2** (technical genre) | Agent writes, owner posts |
| Fri 08-21 | Draft **IBM Community post 2** for the existing author account | Agent |

Publishing, posting, and sending are owner-gated under stop-and-ask gate 2 in
[`CLAUDE.md`](../CLAUDE.md). Everything upstream of the send is an agent task.

---

## Verification log

| Claim | Checked how | Result |
|---|---|---|
| OpenAI App Directory is one action from submission | Read `prompts/store-submissions/_generated/TRACKER.md` | `ready-to-submit`; sole open item is `[HUMAN: final submit in the partner portal / App Directory flow]`; Partner Network accepted 2026-07-14; org verified |
| GPT Store listing is live | TRACKER row, published 2026-07-14 | Live and public at `chatgpt.com/g/g-6a563a3b49a88191abf346245491a444-three-ws-3d-studio` |
| MCP Registry and Claude plugin marketplace are ready | TRACKER submission-status table | Both `ready-to-submit`, each blocked on one human/operator action |
| Anthropic absent from the partners page | Read `docs/partners.md` | Eight cards: OpenAI, IBM, AWS, Google Cloud, Alibaba Cloud, NVIDIA, HackerNoon, Quicknode. No Anthropic. |
| three.ws publishes on AWS's own domain | Web search plus `docs/aws-builder-center-marketplace-x402.md` frontmatter | Profile at `builder.aws.com/community/@threews`; article `status: published`, 2026-05-30, URL recorded |
| IBM Community post is live | `docs/listings.md` Media and Content Partners table | Live at `community.ibm.com/.../nich8/2026/06/08/...` |
| Both NVIDIA forum posts live | Verified in `docs/nvidia-visibility-map.md` the same day via HTTP status check | Both 200 |
| Inception email never sent | Read `docs/nvidia-apps-catalog-request.md` | `**Sent:** not yet sent.` |
| `/nvidia` never announced on X | Read `docs/announcement-coverage.md` | Column empty for `/nvidia`, populated for `/openai` |
| Jensen Huang engagement is unciteable | `data/timeline.json`, event `2026-07-18-jensen-huang` | `source_url: null`, as are four other NVIDIA events |
| Audio2Face is implemented and its demo is live | Read `api/_lib/a2f-nvidia.js`, `src/voice/a2f-player.js`, `docs/demo-routes.md`; `curl` on both routes | Implementation real and wired into `src/avatar-embed.js`. Demo served from `public/demos/audio2face.html`; `/demos/audio2face` and `/audio2face` both returned 200 |
| IBM TechXchange 2026 CFP closed | Web search | Closed 2026-05-22; event 2026-10-26 to 10-29, Atlanta |
| AWS Builder Center is self-serve publishing | Web search | `builder.aws.com`, launched July 2025 consolidating community.aws; ~5M monthly visitors; builders publish to a public profile |

---

## Related

- [NVIDIA visibility map](./nvidia-visibility-map.md): every NVIDIA surface in depth, and the dead ends
- [Partners](./partners.md): the eight programs, and the independence language that must survive any rewrite
- [Listings and distribution](./listings.md): the canonical program and directory inventory
- [Announcement coverage](./announcement-coverage.md): which surfaces have been announced on X and which have not
- [Press kit](./press-kit.md): marks, boilerplate, and the rules governing co-branded graphics
- [OpenAI submission handoff pack](../prompts/finish/openai-pr-00-START-HERE.md): the pre-submission task briefs
