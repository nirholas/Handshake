# The second IBM community event: options and recommendation

The first one is done. On 2026-06-23 three.ws ran **Building 3D AI Agents Live: From
Prompt to Embeddable Agent in Minutes** in IBM's Global AI & Data Science community: a
one-hour live-build webinar with an IBM guest, ending in a Q&A. It worked, and it set the
ceiling. Details and the framing rules that govern anything IBM-facing are in
[ibm.md](./ibm.md).

This document is the proposal for the second one. It exists so the conversation with IBM
starts from a concrete run of show rather than a format debate, and so the engineering
work is scoped before a date is promised.

**Read this first: the failure mode.** The obvious second event is the first event with a
new topic. Another hour, another slide-free live build, another Q&A. It would be fine, and
fine is the whole problem: the audience that showed up once has already seen the trick, and
nobody screenshots a webinar. The second event has to be a thing that could not have
happened on Zoom, because three.ws is the only partner IBM has whose product is a place
people can stand in together.

---

## What we can build on that nobody else can

Every candidate below is scored against what already runs in production today, because an
event format that needs six weeks of new engineering is a format that slips.

| Capability | Where it lives | State |
| --- | --- | --- |
| Scheduled live events inside the 3D world: countdown chip, agenda drawer, go-live banners, synchronized fireworks, all from one config file | `public/event.json`, [play-live-events.md](./play-live-events.md) | Shipped |
| Free commemorative wearable granted to everyone present during a live event, never purchasable afterwards | [event-souvenirs.md](./event-souvenirs.md) | Shipped |
| Public event landing page with countdown, run of show in the visitor's timezone, add-to-calendar, live presence | `/event`, `src/event-page.js` | Shipped |
| Realtime multiplayer worlds: movement, chat, spatial voice, up to a plaza-sized crowd | [`multiplayer/`](../multiplayer/README.md) `walk_world`, `stage_world` | Shipped |
| Living Stages: an embodied AI host performing in a 3D venue with spatial voice and lip-sync, reading the room and taking questions | `/stage` | Shipped |
| Arena: time-boxed competitions with live rankings and on-chain attested standings | `/play/arena`, `/arena` | Shipped |
| Text prompt to rigged, animated, embeddable 3D agent | `/create`, the Forge | Shipped |
| IBM Granite on watsonx.ai as the agent brain, plus Granite Guardian as the safety gate | `api/_lib/granite-guardian.js`, `/api/ibm-mcp`, `@three-ws/ibm-watsonx-mcp` | Shipped |
| Granite with no IBM account required, paid per call over x402 | `/api/ibm-mcp` (6 tools) | Shipped |
| AR: place a 3D agent in a real room, visible only to people physically near it | `/irl`, [irl.md](./irl.md) | Shipped |
| Immersive VR (`immersive-vr`) walk-in to the multiplayer world on a headset | not present: `src/xr.js` and `src/ar/webxr.js` are `immersive-ar` only | **Would be new work** |

That last row is the honest one. We ship AR today, not VR. A headset lane is buildable, but
it is a build, so no proposal below depends on it to be a success.

---

## The three candidates

### Option A: Granite Agent Jam (recommended)

**The pitch.** A two-week build competition, co-hosted with IBM, where developers ship a 3D
AI agent that thinks on IBM Granite. Entry is a single URL: an agent anyone can walk up to
and talk to in a browser. It opens with a 45-minute kickoff webinar in the IBM Community
group (the format that already worked, now with a purpose), runs for two weeks in the open,
and closes with a live demo night held **inside** the three.ws world rather than on a
video call.

**Why IBM says yes.** It converts an audience into Granite integrations. Every entry is a
developer who has authenticated against watsonx.ai, or called Granite over x402 without an
account and then wanted one. The output is a public gallery of working Granite applications
with IBM's name on the program, plus a fortnight of daily community activity in a group IBM
owns. A webinar produces a recording. A jam produces artifacts, and artifacts are the thing
IBM's developer advocacy is measured on.

**Why builders show up.** The barrier is close to zero: the Forge turns a prompt into a
rigged agent in minutes, `/api/ibm-mcp` gives them Granite with no IBM signup at all, and
the finished entry is an embed they can put on their own site the same day. They leave with
a portfolio piece, not a certificate.

**What we build:** a jam landing page at `/events/granite-agent-jam` (entry form, live
entry gallery, rules, timezone-aware schedule), a Granite lane preset so an entry declares
Granite as its brain in one click, and a judging view that ranks entries. Everything else
is assembly of surfaces that already run.

**Risk:** a jam with six entries is a bad look. Mitigated by seeding: the three.ws agent
catalog already contains public agents, and the kickoff webinar ships two complete reference
entries built live, so the gallery is never empty on day one.

### Option B: Two Rooms, One Stage (hybrid IRL plus in-world)

**The pitch.** IBM provides a physical room at one of its locations. The same event runs in
two places at once and they are wired to each other: people in the room point their phones
at the floor and see the 3D agents standing in it (`/irl` anchors agents to a real place,
and they are visible only to people physically near it), while remote attendees walk into
the same venue as avatars in the browser and appear on the screen at the front of the
physical room. The AI host on the Living Stage takes questions from both rooms in one queue.

**Why it is genuinely new.** Not a hybrid event in the ordinary sense of a camera pointed at
a stage. The physical room and the virtual room are the same room, and the agents exist in
both. Nobody in IBM's community programming has run this, and it photographs extremely well,
which matters more than it should.

**What we build:** the bridge between the `irl_world` geocell and the `walk_world` plaza
(presence in one room rendering in the other), and a front-of-room display mode. Call it two
weeks of real work.

**Risk:** the single point of failure is IBM's room, its wifi, and a date that depends on a
physical calendar. Everything is fine until forty phones share one guest network. This is
the highest-ceiling option and the lowest-certainty one.

### Option C: The Granite Arena (live agent-vs-agent showdown)

**The pitch.** A spectator event. Agents on different brains, one of them Granite, compete
live on the same task ladder in front of an audience, with the Arena's existing live
rankings and on-chain attested standings driving the scoreboard.

**Why it is tempting:** the Arena already exists, so the lift is small, and competitive
formats hold attention better than demos do.

**Why it is not recommended:** a model-versus-model spectacle invites a benchmark reading of
the result, and a public event where Granite might place second is not an event IBM can
co-host. Fixing that by rigging the ladder is worse. Keep the Arena as a segment inside
Option A's demo night, where the competition is between builders rather than between
vendors.

---

## Recommendation

**Run Option A, and make its closing night Option B if IBM can supply a room.**

The jam is the event. The hybrid room is a finale upgrade, and structuring it that way means
the physical logistics can fail without the event failing: if there is no room, demo night
still happens in-world and streams into the IBM Community group exactly as the first event
did. One decision by IBM, made late, changes the finale and nothing else.

### Why this one does not depend on IBM

Worth being explicit, because it changes how the ask is made. We are an IBM Business
Partner and we own every surface this event runs on: the venue, the build tooling, the
gallery, the judging, the prize pool, the stream, and the date. A hackathon is the format
that benefits most from that, because every piece IBM might contribute is upside rather
than a dependency.

| IBM contribution | If it does not happen |
| --- | --- |
| The community group as the front door and the event listing | We run the kickoff on our own stream and the jam is promoted from three.ws, the blog, Telegram and the social lane |
| Judges from the Granite or advocacy side | Our own judges score it, and the public gallery is the real verdict either way |
| watsonx.ai credits for entrants | `/api/ibm-mcp` already gives entrants Granite with no IBM account and no credit grant |
| A physical room for the finale | Demo night runs in-world exactly as designed |

So the ask to IBM is not "will you approve this format". It is "here is a program with a
date, here is what it produces for Granite, pick the parts you want in". That is a much
easier conversation, it cannot stall on their calendar, and it means the event ships even
if the partnership side goes quiet for a fortnight.

The one thing worth waiting on: an IBM Community listing has a real lead time, and it is
the single highest-leverage thing they can give us. Set the date far enough out to make
that listing possible, then treat everything else as optional.

### Run of show

| Phase | When | Where | What happens |
| --- | --- | --- | --- |
| Kickoff | Day 0, 60 min | IBM Community group (webinar) | What the jam is, the rules, then two reference entries built live from a prompt: one on watsonx.ai with an IBM Cloud account, one on `/api/ibm-mcp` with no account at all. Ends with the entry form open on screen. |
| Build window | Days 1 to 13 | Open | Entries land continuously in the public gallery. One office-hours session mid-window. Weekly recap post in the IBM Community group, inside the one-post-per-week cadence set by [the SEO keyword plan](./ops/seo-keyword-plan.md). |
| Freeze | Day 14 | Gallery | Submissions close. Entries stay live and embeddable forever; the gallery is the lasting artifact. |
| Demo night | Day 15, 90 min | In-world, plus the IBM room if there is one, plus the webinar stream | Doors open in the plaza with the countdown chip and agenda everyone can see. Finalists demo their agent live on the Living Stage. Judges speak. Winners announced. Fireworks close it, synchronized across every client with no server traffic. Everyone present earns the commemorative wearable. |

### Division of labor

| IBM provides | three.ws provides |
| --- | --- |
| The community group as the front door, the event listing, and promotion | The entire venue, the build tooling, and the gallery |
| One or two judges from the Granite or developer advocacy side | The run of show, the live build, the hosting on demo night |
| Optionally a physical room for the finale | The in-world event, the AR layer for the room, the stream |
| Optionally watsonx.ai credits for entrants | The commemorative wearable and the $THREE prize pool |

### What the winners get

A `tier: event` commemorative wearable for everyone who is in the world during demo night,
granted once, never sold afterwards, kept forever. A $THREE prize pool for the top entries,
settled on Solana. Permanent placement in the gallery, and the winning agents embedded on
the three.ws home page for the following month. Nothing here needs IBM to spend money for
the event to be worth running.

### Framing rules that apply to every word of this

The distinctions in [ibm.md](./ibm.md) hold without exception. The public Granite showcase
is community-built and is not an IBM product, not endorsed by IBM, and not a partnership
deliverable. The jam is hosted by three.ws in IBM's community with IBM's participation. It
is not "an IBM hackathon", and no promotional copy may upgrade it into one. Every entry runs
on publicly available Granite models on watsonx.ai, nothing more. Copy for the event page,
the community posts, and the social lane gets read against those rules before it ships.

---

## Engineering plan for Option A

Ordered so the event is runnable even if the last item never lands.

1. **`/events/granite-agent-jam` landing page.** Countdown, run of show in the visitor's
   local timezone, add-to-calendar, rules, entry form, live entry gallery, schema.org
   `Event` structured data. Follows the existing `pages/events/build-3d-agents-live.html`
   and reuses the timezone and countdown logic already proven on `/event`.
2. **Entry submission and gallery.** An entry is an agent id plus a one-line pitch plus the
   declared brain. The gallery is a grid of live, walk-up-and-talk-to-them agents, not
   screenshots.
3. **Granite as a one-click brain.** An entrant picks Granite in the agent brain selector
   and it works, with the x402 path as the no-account default so a developer with no IBM
   Cloud login is never blocked at minute one.
4. **Demo night event config.** Write the window into `public/event.json` with the agenda
   and the souvenir cosmetic id, per [play-live-events.md](./play-live-events.md). This is
   a config change plus a deploy, and it is the whole in-world event.
5. **Judging view.** Ranked scoring over the entry set, visible to judges only, resolving to
   a public result page after the announcement.
6. **Optional, only if IBM confirms a room:** the `irl_world` to `walk_world` presence
   bridge and the front-of-room display mode described in Option B.

Items 1 through 4 are the event. Item 5 is a convenience that a spreadsheet could replace.
Item 6 is the upgrade.

## What the owner needs to decide

1. A date for the kickoff, which sets everything else. We can set it unilaterally, so the
   only reason to wait is leaving IBM enough lead time to list the kickoff in their
   community. That is a promotion lane, not a dependency.
2. Whether to ask IBM for a physical room for the finale, which is the difference between a
   very good event and one nobody in that community has seen before.
3. The size of the $THREE prize pool.

Everything else in this document proceeds without an answer.
