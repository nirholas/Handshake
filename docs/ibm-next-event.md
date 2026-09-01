# The second IBM community event: options and recommendation

The first one is done. On 2026-06-23 three.ws ran **Building 3D AI Agents Live: From
Prompt to Embeddable Agent in Minutes** in IBM's Global AI & Data Science community: a
one-hour live-build webinar with an IBM guest, ending in a Q&A. It worked, and it set the
ceiling. Details and the framing rules that govern anything IBM-facing are in
[ibm.md](./ibm.md).

This document is the proposal for the second one. It exists so the conversation with IBM
starts from a concrete run of show rather than a format debate, and so the engineering work
is scoped before a date is promised.

**The goal is not another audience. It is usage.** A webinar is measured in registrations
and a recording. This event is measured in how many people typed something into three.ws
who never had before, and how many of them came back the next day. Everything below is
chosen against that number.

**Read this first: the failure mode.** The obvious second event is the first event with a
new topic, and the obvious upgrade is a developer hackathon. Both quietly select for people
who were already going to use us. A developer jam's funnel is: read the rules, get
credentials, build something over a weekend, submit a repo. Most entrants die at
credentials, and the ones who finish are the ones who needed no encouragement. A
non-technical contest has a funnel one page deep, and its addressable audience is everyone.

---

## What we can build on that nobody else can

Every candidate below is scored against what already runs in production today, because an
event format that needs six weeks of new engineering is a format that slips.

| Capability | Where it lives | State |
| --- | --- | --- |
| **A weekly, community-voted creation contest, already running**: the Forge-Off board, Monday to Monday UTC, most-voted first | `api/_lib/forge-store.js` (`forgeOffWeekStart`, `listShowcase`), `/api/forge-gallery?scope=community&sort=top&window=week` | Shipped |
| **Entry with no account, no wallet, no install**: `/forge` is auth-free, and a creation publishes to the community board | `/forge`, `api/forge-gallery.js` | Shipped |
| **Voting with no login**: one upvote per browser per creation, idempotent, rate limited, tallied authoritatively | `api/forge-vote.js`, `api/_lib/rate-limit.js` | Shipped |
| Weekly winners crowned and auto-distributed to the official Sketchfab account with backlinks and UTM attribution | `forge_board_winners`, `api/cron/sketchfab-showcase.js` | Shipped |
| Safety gate that makes a public, no-login contest survivable: brand denylist in the selection SQL plus a classifier layer before anything is shown | `api/cron/sketchfab-showcase.js`, `publish-safety.js`, Granite Guardian in `api/_lib/granite-guardian.js` | Shipped |
| Scheduled live events inside the 3D world: countdown chip, agenda drawer, go-live banners, synchronized fireworks, all from one config file | `public/event.json`, [play-live-events.md](./play-live-events.md) | Shipped |
| Free commemorative wearable granted to everyone present during a live event, never purchasable afterwards | [event-souvenirs.md](./event-souvenirs.md) | Shipped |
| Public event landing page with countdown, run of show in the visitor's timezone, add-to-calendar, live presence | `/event`, `src/event-page.js` | Shipped |
| Realtime multiplayer worlds: movement, chat, spatial voice, a plaza-sized crowd | [`multiplayer/`](../multiplayer/README.md) | Shipped |
| Living Stages: an embodied AI host performing in a 3D venue, reading the room and taking questions | `/stage` | Shipped |
| Text prompt to rigged, animated, embeddable 3D agent | `/create`, the Forge | Shipped |
| AR: place a 3D agent in a real room, visible only to people physically near it | `/irl`, [irl.md](./irl.md) | Shipped |
| IBM Granite on watsonx.ai as the agent brain, plus Granite with no IBM account over x402 | `/api/ibm-mcp`, `@three-ws/ibm-watsonx-mcp` | Shipped |
| Immersive VR (`immersive-vr`) walk-in to the multiplayer world on a headset | not present: `src/xr.js` and `src/ar/webxr.js` are `immersive-ar` only | **Would be new work** |

Two rows carry the whole proposal. The first is that **the contest mechanic already exists
and runs every week**: a themed event on top of it is promotion, prizes and a finale, not a
build. The second is that **entry and voting both need no login**, which is the single
biggest reason a non-technical contest can outperform a developer one on usage.

---

## The three candidates

### Option A: The Forge-Off Open (recommended)

**The pitch.** A one-week, open creation contest that anyone can enter in under a minute
with one sentence and no account. Go to `/forge`, type a description of a thing, get a real
textured 3D model, publish it to the board. Anyone can vote, no login. Highest voted wins.
It opens with a live "make one with me" session in the IBM Community group and closes with
a crowning ceremony held inside the three.ws world.

**The daily drip is the actual design.** A single week with one theme produces one visit.
Five daily themes, each three minutes of work, produce five visits and walk a newcomer
through the entire product without a single sentence of documentation:

| Day | Theme prompt | Surface it teaches |
| --- | --- | --- |
| 1 | The object your job wishes existed | `/forge`: prompt to 3D model |
| 2 | Give it a face and a name | `/create`: prompt to rigged avatar |
| 3 | Make it move | Choreographer and the animation library |
| 4 | Put it in your actual room | `/irl`: AR placement, and a photo to share |
| 5 | Bring it to the party | `/play`: walk into the world with it |

Each day is its own board and its own small prize, so a person who finds us on Wednesday
has not missed the event. The week ends with an overall winner across all five.

**Why it beats a developer hackathon on the stated goal.** The entry funnel is one page
deep and auth-free, so the drop-off between "saw the post" and "made something" is close to
zero. The addressable audience is not developers, it is anyone who can describe an object
in words, which includes the entire non-technical half of IBM's community that has never
had an event aimed at it. And the artifact count is the metric that compounds: hundreds of
public creations, each with a share card and a permanent page, is a better outcome than
twelve repositories nobody clones.

**Why IBM says yes.** It gives their community something it structurally does not get,
which is a creative program with no prerequisite. The technical story underneath is the
interesting half and it is genuinely theirs: **an open, no-login, public creation contest is
only survivable because every entry passes a safety classifier before another human ever
sees it.** That is Granite Guardian and the publish-safety layer doing unglamorous
load-bearing work, and it is a far better responsible-AI story than a slide about
responsible AI. Winners also flow automatically to a public Sketchfab account with
attribution, so the program's output stays visible long after the week ends.

**What we build:** an event landing page, and the daily theme copy. The board, the voting,
the tallying, the crowning and the distribution already run.

**Risk:** vote brigading, and a thin first day. Votes are already one-per-browser with IP
hashing and rate limits, and the daily reset means a brigade wins one small prize rather
than the event. The thin-first-day risk is handled by the kickoff session ending with the
board on screen and everyone making one live.

### Option B: Two Rooms, One Stage (the finale upgrade)

**The pitch.** IBM provides a physical room for the crowning ceremony. The same event runs
in two places at once and they are wired together: people in the room point their phones at
the floor and see the winning creations standing in it (`/irl` anchors an agent to a real
place, visible only to people physically near it), while everyone else walks into the same
venue as an avatar in the browser and appears on the screen at the front of the room.

**Why it is genuinely new.** Not a hybrid event in the ordinary sense of a camera pointed at
a stage. The physical room and the virtual room are the same room, and the winning objects
exist in both. It also photographs extremely well, which matters more than it should.

**What we build:** the bridge between the `irl_world` geocell and the `walk_world` plaza, so
presence in one room renders in the other, plus a front-of-room display mode. Roughly two
weeks of real work.

**Risk:** the single point of failure is IBM's room, its wifi, and a date bound to a physical
calendar. Everything is fine until forty phones share one guest network. Treat it as an
upgrade to Option A's last day, never as the event itself.

### Option C: Granite Agent Jam (the developer division)

**The pitch.** The two-week build competition: ship a 3D AI agent that thinks on Granite,
judged on a demo night. This was the earlier recommendation, and it is a good event. It is
demoted here for one reason only: it optimizes for depth in an audience we already reach,
while the goal this time is breadth in one we do not.

**Where it belongs.** As an optional builders division running alongside Option A for anyone
who wants to go further than a prompt, sharing the same week, the same finale and the same
stream. Entrants need no IBM account to use Granite (`/api/ibm-mcp` prices it per call over
x402), so the division adds no prerequisite to the main event. If the Open works, this is
the natural standalone follow-up in the quarter after.

### Not recommended: a live model-versus-model showdown

The Arena could host agents on different brains competing live, and the surface already
exists. Skip it. A public model-versus-model spectacle invites a benchmark reading of the
result, and an event where Granite might place second is not one IBM can co-host. Fixing
that by rigging the ladder is worse.

---

## Recommendation

**Run Option A. Add Option C as a side division if we want the developer audience too, and
make the last day Option B if IBM can supply a room.**

Structuring it that way means every hard dependency is optional. No room, the ceremony runs
in-world. No builders division, the Open is untouched. No IBM listing, we promote it
ourselves.

### Why this one does not depend on IBM

Worth being explicit, because it changes how the ask is made. We are an IBM Business Partner
and we own every surface this event runs on: the venue, the contest, the voting, the
gallery, the prize pool, the stream, and the date. A creation contest benefits most from
that, because every piece IBM might contribute is upside rather than a dependency.

| IBM contribution | If it does not happen |
| --- | --- |
| The community group as the front door and the event listing | We run the kickoff on our own stream and promote from three.ws, the blog, Telegram and the social lane |
| A guest host or judges | Our own host runs it, and the community vote is the real verdict either way |
| watsonx.ai credits | Entry never touches an IBM account, and `/api/ibm-mcp` covers the builders division |
| A physical room for the finale | The ceremony runs in-world exactly as designed |

So the ask is not "will you approve this format". It is "here is a program with a date, here
is what it produces, pick the parts you want in". That is a much easier conversation, it
cannot stall on their calendar, and the event ships even if the partnership side goes quiet
for a fortnight.

The one thing worth pacing for is an IBM Community listing, which has real lead time and is
the highest-leverage thing they can give us. Set the date far enough out to make it
possible, then treat everything else as optional.

### Run of show

| Phase | When | Where | What happens |
| --- | --- | --- | --- |
| Kickoff | Day 0, 45 min | IBM Community group, streamed | No slides. The host types one sentence, a 3D object appears, and it is on the board inside two minutes. Then the audience does it live while the board fills on screen. Ends with the week's five themes and the prize list. |
| Days 1 to 5 | One theme per day | `/forge` and the daily board | A theme drops each morning. Entries and votes run continuously. A daily winner is crowned from the board every evening. |
| Crowning | Day 6, 60 min | In-world, streamed, plus the IBM room if there is one | Doors open in the plaza with the countdown and agenda everyone can see. The week's winners are shown at scale on the stage, the overall winner is announced, fireworks close it, and everyone present earns the commemorative wearable. |
| After | Ongoing | Sketchfab, `/creations`, the home page | Winners flow to the official Sketchfab account with attribution and backlinks through the existing cron. The board keeps running the following Monday, because it always does. |

### What entrants get

A commemorative `tier: event` wearable for everyone in the world at the ceremony, granted
once, never sold. A $THREE prize pool split across the five daily winners and the overall
winner, settled on Solana. Winning creations placed on the three.ws home page for the
following month and pushed to the official Sketchfab account with credit. Every entrant
keeps a real, downloadable GLB regardless of where they place, which is the part that makes
losing fine.

### Framing rules that apply to every word of this

The distinctions in [ibm.md](./ibm.md) hold without exception. The public Granite showcase is
community-built, not an IBM product, not endorsed by IBM, and not a partnership deliverable.
This is an event hosted by three.ws in IBM's community with IBM's participation. It is not
"an IBM hackathon", and no promotional copy may upgrade it into one. Copy for the event
page, the community posts and the social lane gets read against those rules before it ships.

---

## Engineering plan

Ordered so the event is runnable even if the last item never lands.

1. **The event landing page** at `/events/<slug>`: countdown, the five themes with their
   drop times in the visitor's local timezone, add-to-calendar, prize list, rules, a live
   entry count, and the current top-voted grid read from
   `/api/forge-gallery?scope=community&sort=top&window=week`. Follows the existing
   `pages/events/build-3d-agents-live.html` and reuses the countdown and timezone logic
   already proven on `/event`. This is the only substantial build.
2. **Daily theme copy and the drop schedule**, written once and read by the page, so a
   theme going live needs no deploy.
3. **Ceremony config**: write the window, the agenda and the souvenir cosmetic id into
   `public/event.json` per [play-live-events.md](./play-live-events.md). A config change
   plus a deploy, and that is the entire in-world event.
4. **A daily crowning read** over the existing board so the evening winner is a query, not a
   person scrolling. The weekly crowning already exists; this is the same window narrowed to
   a day.
5. **Prize payout**, on-chain and owner-gated per the confirmation rules in
   [CLAUDE.md](../CLAUDE.md). Manual by design: a contest prize is not an automated transfer.
6. **Optional, only if IBM confirms a room**: the `irl_world` to `walk_world` presence bridge
   and the front-of-room display mode from Option B.

Items 1 through 3 are the event. Item 4 is a convenience a query could replace by hand. Item
6 is the upgrade.

## What the owner needs to decide

1. A date for the kickoff, which sets everything else. We can set it unilaterally, so the
   only reason to wait is leaving IBM enough lead time to list it in their community. That
   is a promotion lane, not a dependency.
2. Whether to run the builders division (Option C) alongside the Open, or hold it back as
   the standalone follow-up event.
3. Whether to ask IBM for a room for the ceremony, which is the difference between a very
   good event and one nobody in that community has seen before.
4. The size of the $THREE prize pool, and the split between the five daily winners and the
   overall winner.

Everything else in this document proceeds without an answer.
