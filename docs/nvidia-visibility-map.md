# NVIDIA visibility map: every surface, and how to get on it

Inception membership is the door, not the result. This doc is the complete map of
every NVIDIA surface where three.ws can earn recognition, what each one actually
requires, and the honest status of each today.

Scope note: the **Accelerated Apps Catalog** already has its own two docs and is
not re-litigated here. See [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md)
for the listing kit and [nvidia-apps-catalog-request.md](./nvidia-apps-catalog-request.md)
for the inclusion email. This doc covers everything else and links to them where
they overlap.

Researched and verified 2026-08-17. Every intake URL and email below was fetched
or searched the same day; the ones that turned out to be dead are recorded in
[Dead ends](#dead-ends-do-not-spend-time-here) so nobody re-chases them.

---

## The two facts that should reorder priorities

Before any new outreach, two things about our existing position:

**1. The Inception membership was never announced on X.** [announcement-coverage.md](./announcement-coverage.md)
tracks an "announced on X" column per surface. `/nvidia` (added 2026-07-30) has
that column empty, while `/openai` has a real post behind it. The single biggest
NVIDIA credential we hold has had no social push on our own channels. Everything
in the [Social](#social-surfaces-ours-to-drive) section is blocked on nothing and
costs nothing.

**2. Jensen Huang already interacted with three.ws content, and we have no
receipt.** [data/timeline.json](../data/timeline.json) carries
`2026-07-18-jensen-huang`: "NVIDIA CEO Jensen Huang interacts with three.ws
content, amplifying the NVIDIA Inception announcement." Its `source_url` is
`null`. Five of the seven NVIDIA timeline events have a null `source_url`,
including the Inception acceptance and its public announcement.

That is the highest-value social proof this company has and it is currently
unciteable. An engagement from NVIDIA's CEO is the first line of any Showcase
pitch, podcast nomination, or press approach, and right now it cannot be shown to
anyone. **Recovering that link is the highest-leverage single action on this
page**, and it is a five-minute job for whoever has the account history. Archive
it to `web.archive.org` the moment it is found, because a deleted post takes the
proof with it.

---

## Tier 1: act now, no dependencies

Everything here can be done today. Nothing waits on NVIDIA, a build, or a date.

| # | Surface | Intake | Why it is Tier 1 |
|---|---|---|---|
| 1 | **Our own X, LinkedIn, and Telegram** | Ours | The membership post that never happened. See [Social](#social-surfaces-ours-to-drive). |
| 2 | **Inception co-marketing kit** | Portal benefit request, or `inceptionprogram@nvidia.com` | An entitlement we have never claimed. See [Benefits we are owed](#benefits-we-are-entitled-to-and-have-never-requested). |
| 3 | **Portal product record correction** | `programs.nvidia.com/phoenix/application` | Gates the Showcase AND the Apps Catalog. Already specified in [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md) step 1. Nothing else in this doc lands well while the record says "CUDA consumer". |
| 4 | **Inception Startup Showcase** | `inceptionprogram@nvidia.com` | NVIDIA's own wording is "member spotlights and story opportunities". Curated from the portal record, so do #3 first. |
| 5 | **AI Podcast guest nomination** | Embedded form at [ai-podcast.nvidia.com](https://ai-podcast.nvidia.com) | Free, one form, and a founder-shaped story. Fields: name, business email, organization, industry, job title, location, preferred language, and a description of the proposal. |
| 6 | **NVIDIA Developer Forums, post 3** | [forums.developer.nvidia.com](https://forums.developer.nvidia.com) | We are 2 for 2 on posts that landed. This is the one channel with a proven track record, and it is self-serve. **Drafted 2026-09-02: [nvidia-forum-browser-digital-human.md](./nvidia-forum-browser-digital-human.md).** Owner-gated on the external-channel rule, then paste and post. See [Technical publishing](#technical-publishing-the-proven-channel). |
| 7 | **NVIDIA Developer Discord** | [discord.com/invite/nvidiadeveloper](https://discord.com/invite/nvidiadeveloper) | NVIDIA engineers and product staff are in there. The browser Audio2Face demo is a conversation starter with the actual ACE team, not a marketing ask. |
| 8 | **Fix `docs/listings.md`** | Ours | The "Startup & Credit Programs" table lists Quicknode and Google Cloud and has **no NVIDIA row at all**, which is the one canonical place a reader looks for our program memberships. Fixed in this change. |
| 9 | **"Maximize Your Membership" benefits webinar** | Region registration from the Inception member mailer (Americas / EMEA / APAC) | Announced to members 2026-09-02. NVIDIA's own walkthrough of requesting and managing benefits through the portal, which is the exact mechanism gating items 2, 3 and 4 on this list. Attend it before sending the batched email, and use the Q&A to ask the co-marketing and Showcase questions live rather than waiting on an inbox. |

## Tier 2: needs a build first

Real listings, real effort, honest gates. Do not pitch these before the code exists.

| Surface | Intake | The gate |
|---|---|---|
| **NGC Catalog** (via the [NGC Software Partner program](https://www.nvidia.com/en-us/gpu-cloud/ngc-software-partners/)) | A **self-serve "Become an NGC Software Partner" form** on that page, then the partner legal agreement, a push to an NGC private staging repo, security scanning and QA, final sign-off | **The closest Tier 2 surface to reachable, and the only NVIDIA directory with a self-serve door.** It now has its own kit: [nvidia-ngc-listing.md](./nvidia-ngc-listing.md) audits all four prerequisites against the code, names the publishable container ([model-trellis](../workers/model-trellis), MIT upstream, no baked weights, no telemetry), and carries the paste-ready listing copy. The EULA prerequisite is closed ([/legal/nvidia-ngc-eula](https://three.ws/legal/nvidia-ngc-eula)). What remains is one Cloud Build run to make the image runnable outside our GCP project, plus the owner-signed legal agreement. |
| **ACE / digital-human ecosystem** | No public form found. Ask for the redirect in the Showcase email | Genuinely strong: Riva, Magpie, and Audio2Face-3D are shipping, and a **browser-native** A2F demo is rare (most A2F work lives in Unreal or Omniverse). This is our most differentiated technical story. Do not overclaim: we consume ACE microservices, we do not self-host NIM. |
| **NVIDIA Technical Blog** ([developer.nvidia.com/blog](https://developer.nvidia.com/blog/)) | No public guest-submission process. Route via the forum Technical Blog category and the program team | Editorially controlled by NVIDIA. The realistic path is a forum post that performs, then a pitch. Our two live forum posts are the audition tape. |
| **Omniverse Exchange** | [Omniverse Exchange Publishing Portal](https://developer.nvidia.com/omniverse-exchange-publishing-portal) (early access), plus a GitHub repo tagged with the `omniverse-kit-extension` topic | **Blocked and should stay blocked.** OpenUSD interop is roadmap, not shipping, and [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md) already rules that Omniverse Kit stays under "Considering". Note the Omniverse Launcher was deprecated 2025-10-01, so old guides mislead. |

## Tier 3: time-gated, and the clock is running

**GTC is the single largest recognition surface NVIDIA operates, and the window
for the next one is open approximately now.**

GTC 2026 (San Jose, March 16 to 19) ran an Inception Startup Pavilion with 55+
startups, "NVIDIA Inception Presents: Startup Pitches" sessions, and 25 Startup
Spotlight sessions. NVIDIA's own startup page for the event is
[nvidia.com/gtc/startups](https://www.nvidia.com/gtc/startups).

Status as of 2026-08-17: the [call for submissions](https://www.nvidia.com/gtc/call-for-submissions/)
page reads "The Poster Call for Submissions and Content Interest Survey are now
closed" for GTC 2026. NVIDIA's own FAQ page is already titled for **GTC San Jose
2027**, and third-party event trackers report 2027-03-14 to 2027-03-18. Treat the
dates as unconfirmed until NVIDIA states them, but treat the **submission window
as imminent**: for a March event, recent cycles opened submissions in the summer
and closed in early fall, which is the month we are in.

**Re-checked 2026-09-02.** Still closed: the call-for-submissions page carries the
same GTC 2026 "now closed" copy, and no 2027 CFP or registration has opened.
Third-party trackers have converged on **2027-03-15 to 2027-03-18, San Jose**,
one day later than the dates recorded above, which is a reminder that none of
these dates are NVIDIA-stated yet. Nothing to submit to this week. Keep the
weekly watch running; the abstracts in step 2 below are what should be written
while the window is shut.

Actions, in order:

1. **Put [nvidia.com/gtc/call-for-submissions](https://www.nvidia.com/gtc/call-for-submissions/)
   on a weekly watch.** Missing this window costs a full year. It is the one item
   on this page with a hard, externally-set deadline.
2. **Write the poster and session abstracts before the form opens.** The strongest
   submission we have is the browser-native digital human: Audio2Face-3D plus Riva
   plus Nemotron driving a rigged avatar in a tab with no install, on a fleet of
   L4s and one Blackwell. Second-strongest is the L4-and-Blackwell engineering
   material already published on our blog.
3. **Ask about the Inception Startup Pavilion separately.** Pavilion placement is
   an Inception benefit negotiated with the program team, not a CFP submission.
   Fold the question into the Showcase email so it costs no extra round trip.
4. **Do not forget the Content Interest Survey.** It closes alongside the CFP and
   is a low-effort way to signal topic fit before sessions are locked.

Also date-driven, lower stakes: NVIDIA lists Inception exposure at Oracle AI
World, KubeCon, Supercomputing, Microsoft Ignite, AWS re:Invent, and NeurIPS.
Worth asking which of those have startup slots we qualify for.

---

## Social surfaces (ours to drive)

This is the section with no gatekeeper, and it is the one we have used least.

**The mechanics that actually get amplified:** NVIDIA's Inception co-marketing
benefit is explicitly "official badges, co-branded social content, and
customizable assets for events". Posts that use the official badge, tag the right
account, and carry `#NVIDIAInception` are the ones NVIDIA's social team can
reshare. A generic post naming NVIDIA in prose is not resharable.

Pick the account by topic rather than blasting the main handle. Verified from
[NVIDIA's official social directory](https://www.nvidia.com/en-us/contact/social/):

| Our content | Account to tag | Platform |
|---|---|---|
| Digital humans, Audio2Face, Riva, avatars | `@NVIDIAAIDev`, `@NVIDIADeveloper` | X |
| Inception membership, founder story, milestones | **NVIDIA for Startups** (82k+ followers) | LinkedIn |
| Nemotron, NIM, inference pipeline | `@NVIDIAAI`, `@NVIDIAAIDev` | X |
| 3D, OpenUSD, scene work | `@NVIDIAOmniverse` | X, LinkedIn, Discord |
| GTC submissions and attendance | `@NVIDIAGTC` | X |
| General company news | `@NVIDIA`, `@NVIDIANewsroom` | X |

Also live and worth using: NVIDIA Developer on YouTube, Instagram, and Threads,
plus the two Discords (NVIDIA Developer, NVIDIA Omniverse).

**The content we already have and have never posted:**

- The membership itself, with the official badge. Never posted.
- The browser Audio2Face demo at `/demos/audio2face`. A 15-second screen capture
  of a face lip-syncing in a browser tab with no install is the most
  screenshot-friendly asset on the platform, and it maps exactly to what the ACE
  team promotes.
- The two NVIDIA Developer Forums posts. Published on NVIDIA's own property and
  never amplified from ours.
- The L4-and-Blackwell engineering post, including the `sm_120` kernel and
  regional-quota material that GPU engineers actually reply to.
- [readme-3d](../packages/readme-3d): an interactive 3D model rendered natively
  in a GitHub README. Genuinely novel, and the model in it was generated on the
  NVIDIA lane.

Sequence it: badge post, then demo clip, then the forum posts, then the
engineering deep dive. One per week beats four in a day, and each one is a
separate chance for a reshare.

## Technical publishing (the proven channel)

Two forum posts, both live, both landed:

- [How Nemotron made three.ws text-to-3D pipeline usable](https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445)
- [How three.ws translates a web app into 100 languages with NVIDIA NIM](https://forums.developer.nvidia.com/t/how-three-ws-translates-a-web-app-into-100-languages-with-nvidia-nim-an-llm-powered-i18n-pipeline/377379)

This is the only NVIDIA channel where we have a track record, it is self-serve,
and it feeds everything else: forum posts are what a Technical Blog pitch and a
GTC abstract are built on.

Post 3 should be the browser digital human, because it is the piece nobody else
has written: streaming Audio2Face-3D blendshape tracks over gRPC into a WebGL
avatar, mapping ARKit-52 onto whatever morph convention the visitor's model
ships (ARKit, VRM vowels, Oculus visemes), with Riva ASR in and Magpie TTS out.
Write it against [api/_lib/a2f-nvidia.js](../api/_lib/a2f-nvidia.js) and
[src/voice/a2f-player.js](../src/voice/a2f-player.js) so every claim has code
behind it, and follow the house rule the existing two follow: real numbers,
real latencies, no marketing voice.

**It is written: [nvidia-forum-browser-digital-human.md](./nvidia-forum-browser-digital-human.md)** (drafted
2026-09-02). It covers the NVCF bidirectional stream, the 44.1 kHz to 16 kHz
resampling contract and why playback must use the original audio, the derived
blendshape path that lets a VRM or Oculus-viseme rig lip-sync from an ARKit-52
track, the double-stacking and 30-to-60 fps interpolation bugs that only appear
on real uploads, and the function-id rotation that took the lane down once.
Latencies in it were measured against the live endpoint the day it was written,
not estimated. It is owner-gated under the external-channel rule: paste and post
when approved.

## Benefits we are entitled to and have never requested

Straight from NVIDIA's [Inception program page](https://www.nvidia.com/en-us/startups/).
These are membership benefits, not favors, and they are requested through the
portal or the program email.

| Benefit | NVIDIA's wording | Status |
|---|---|---|
| Co-marketing assets | "Amplify your brand with official badges, co-branded social content, and customizable assets for events." | **Never requested.** Ask for the kit. |
| Startup Showcase feature | "Feature in the NVIDIA Inception Startup Showcase with member spotlights and story opportunities." | Never requested. Tier 1 #4. |
| Member-only newsletter | Product releases and offers | Confirm we are subscribed. Also the likeliest place a member spotlight surfaces. |
| Event exposure | GTC, Oracle AI World, KubeCon, Supercomputing, Microsoft Ignite, AWS re:Invent, NeurIPS | Never asked which have startup slots. |
| Capital Connect / VC Alliance | Eligibility-based investor introductions | [Program page](https://www.nvidia.com/en-us/startups/venture-capital/). Owner's call, not an engineering task. |
| Cloud credits and preferred pricing | Free credits from NVIDIA and partners | Separate from the GCP credits already in use. Worth auditing against [ops/gcp-credits-plan.md](./ops/gcp-credits-plan.md). |

On tiers: third-party write-ups describe a **Premier** tier above entry with a
larger DGX allocation and more co-marketing, promoted on usage and traction
signals. NVIDIA does not document this publicly, so treat it as unconfirmed and
never claim a tier. It is a fair question to ask the program team, and the answer
is worth having, because "more co-marketing" is exactly what this page is about.

## Dead ends: do not spend time here

Recorded so the next person does not repeat the search.

- **NVIDIA Connect for ISVs.** `nvidia.com/en-us/programs/isv/` 301-redirects to
  `developer.nvidia.com`. The standalone ISV program has been folded into the
  Developer Program. There is no separate ISV listing to apply for.
- **A self-serve "list my product" form, on the marketing surfaces.** None
  exists for the Apps Catalog, the Showcase, or any other surface on this page:
  each runs through the portal record plus a human at
  `inceptionprogram@nvidia.com`. The single exception is NGC, which does publish
  a partner intake form; see [nvidia-ngc-listing.md](./nvidia-ngc-listing.md).
  Stop looking for a form anywhere else.
- **Omniverse Launcher guides.** Deprecated 2025-10-01. Any tutorial routing
  through it is stale.
- **build.nvidia.com as a publishing target.** It is where we *get* our
  `nvapi-` key and consume hosted models. Publishing goes through NGC, not there.

---

## Contacts, in one place

| Purpose | Address |
|---|---|
| All Inception matters, Showcase, co-marketing, GTC pavilion | `inceptionprogram@nvidia.com` |
| China-based startups (not us, recorded for completeness) | `inception_cn@nvidia.com` |
| Member portal | `programs.nvidia.com/phoenix/application` |
| Live phone support (Mon to Fri, 8:00 to 17:00 PT) | +1 (408) 486-2056 |
| Program FAQ and benefits webinar registration | Linked from the Inception member mailer; region-specific (Americas, EMEA, APAC) |

One thread, one address. Every ask in Tier 1 goes to the same inbox, so batch
them into a single email rather than sending four.

**Sent 2026-09-04.** [nvidia-apps-catalog-request.md](./nvidia-apps-catalog-request.md)
carries all five asks (catalog listing, Showcase nomination, co-marketing kit,
ACE redirect, GTC pavilion and event slots) and went to the inbox in one thread
from support@three.ws. **Do not start a second thread.** Tier 1 items 2 and 4
above are now pending NVIDIA rather than pending us. Reply routing for each ask,
and the 2026-09-25 follow-up date, live in the request doc.

Still ours to finish regardless of the reply: the portal record correction (step 1
of [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md)), because a
curator who opens the record after reading the email should not find a CUDA
consumer with DeepVariant checked, and the second product record for the
`<agent-3d>` embed, which targets the Digital Humans workload filter the main
record does not.

## Verification log

| Claim | Checked how | Result |
|---|---|---|
| GTC 2026 CFP closed; 2027 is next | Fetched [call-for-submissions](https://www.nvidia.com/gtc/call-for-submissions/) | "now closed" for GTC 2026; NVIDIA's FAQ page already titled GTC San Jose 2027 |
| GTC 2027 CFP still shut (2026-09-02) | Re-fetched the same page, plus a search across event trackers | Same "now closed" GTC 2026 copy; no 2027 CFP or registration open; trackers report 2027-03-15 to 2027-03-18 San Jose |
| A2F lane live and its latency (2026-09-02) | Three POSTs each to `https://three.ws/api/a2f`, audio-in and text-in | 200 on all six; 4.64 s of speech animates in 1.29 to 2.26 s, text-to-speech-to-animation in 1.88 to 3.41 s; 140 frames at 30 fps, 55 blendshapes |
| Inception benefit wording | Fetched [nvidia.com/en-us/startups](https://www.nvidia.com/en-us/startups/) | Quoted verbatim above |
| Social handles | Fetched [NVIDIA social directory](https://www.nvidia.com/en-us/contact/social/) | Full list; the table above is the topic-relevant subset |
| AI Podcast guest form | Fetched [ai-podcast.nvidia.com](https://ai-podcast.nvidia.com) | Embedded "Submit Guest Ideas" form, fields recorded above |
| NGC publishing prerequisites | Searched the [NGC Software Partner page](https://www.nvidia.com/en-us/gpu-cloud/ngc-software-partners/) | Legal agreement, staging repo, security scan, QA, sign-off |
| ISV program retired | `WebFetch` on `nvidia.com/en-us/programs/isv/` | HTTP 301 to `developer.nvidia.com` |
| Both forum posts live | `curl -o /dev/null -w '%{http_code}'` | Both 200 |
| `/nvidia` never announced on X | Read [announcement-coverage.md](./announcement-coverage.md) inventory | Column empty for `/nvidia`, populated for `/openai` |
| Jensen Huang engagement has no source | `data/timeline.json`, event `2026-07-18-jensen-huang` | `source_url: null`, as are 4 other NVIDIA events |
| GPU fleet shape | `gcloud run services list` across all regions, filtered to accelerator node selectors | 8 workers, 12 deployments, 11 L4 + 1 RTX PRO 6000 |
| GPU fleet shape, re-counted 2026-09-02 | Same command, isolated `CLOUDSDK_CONFIG` | Unchanged: 8 services, 12 deployments, 11 L4 + 1 RTX PRO 6000. `model-trellis` is live in `us-central1` and `us-east4`. |

Recount the fleet before quoting it anywhere:

```bash
gcloud run services list --project aerial-vehicle-466722-p5 \
  --format="csv[no-heading](metadata.name,region,spec.template.spec.nodeSelector)" \
  | grep -i accelerator
```

## Related

- [Big-tech recognition dispatch board](./big-tech-recognition-week.md): this map ranked against every other big-tech surface (OpenAI, Anthropic, AWS, IBM) by the odds of a published mention this week. Read that first if you are deciding where a week goes, and this one once NVIDIA is the answer.
- [NVIDIA Inception membership](./nvidia-inception.md): what membership is, and the rule that it is a program and not a partnership or an endorsement
- [Apps Catalog listing kit](./nvidia-apps-catalog-listing.md) and [inclusion request](./nvidia-apps-catalog-request.md): the curated marketing listing
- [NGC Catalog listing kit](./nvidia-ngc-listing.md): the self-serve software listing, its prerequisite audit, and the container that clears it
- [NVIDIA models on three.ws](./nvidia-models.md): the source of truth for every NVIDIA technical claim made in any pitch
- [Listings and distribution](./listings.md): the canonical program and directory inventory
- [Announcement coverage](./announcement-coverage.md): which surfaces have been announced and which have not
- [Partners](./partners.md): the independence and no-endorsement language that must survive any rewrite
