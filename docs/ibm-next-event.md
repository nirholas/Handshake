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

---

# Appendix: the wider idea bank

The Forge-Off Open above is the recommendation because it is the cheapest path to the most
new users. It is not the only good event, and a few of the ideas below beat it on other
axes: press, partner fit, retention, or sheer novelty. Everything here rides a surface that
already runs in production, so any of them can be the next one rather than a someday.

## The one structural point: a season beats an event

An event is a spike. Three days later the graph is where it was. The pattern that actually
moves usage is three things running at once, and we already own all three:

- **A daily habit.** `/daily` is a new 3D creative challenge every day, free, no sign-up,
  with a streak. That is the retention engine, and it is already built.
- **A recurring show.** `/stage` puts an embodied AI host in a 3D venue with spatial voice
  that reads the room and takes audience questions. A monthly show is a reason to come back
  on a date.
- **One headline event per quarter.** The Open, or any of the ideas below.

Pick the headline event to recruit, the daily challenge to retain, and the show to keep a
rhythm. Judging any single event on its own spike is how good programs get cancelled.

## The ideas

| # | Idea | Rides | Audience | Lift | Why it might beat the Open |
| --- | --- | --- | --- | --- | --- |
| 1 | **Sign Week** | `/sign-language`, `/asl-alphabet`, `/sign-mirror` | Anyone, plus the deaf and accessibility communities | Low | The best partner fit on this list, and nothing like it exists anywhere |
| 2 | **The 30-Day Forge Streak** | `/daily` | Anyone with a browser | Almost none | Retention rather than a spike: a daily habit with a streak, no sign-up |
| 3 | **World Lines: the global hunt** | `/world-lines`, `/irl` | Anyone with a phone, city by city | Medium | Physically real, genuinely novel, and it photographs itself |
| 4 | **Portal Day** | `/portal` | Anyone who has a website they care about | Low | The entry action is pasting a URL, which is the lowest bar we can offer |
| 5 | **Opening Night** | `/compose`, `/play`, `/creations` | Art and design audiences, press | Medium | Reframes AI output as an exhibition, which press covers and a contest is not |
| 6 | **Mascot Week** | `/create`, `/studio`, `/glance` | Companies, including IBM's enterprise base | Low | The only idea here that converts directly into embeds on other companies' sites |
| 7 | **Crews Cup** | `/crews` | Teams, chapters, user groups, offices | Low | A team layer that multiplies any other idea on this list |
| 8 | **The Living Stage show** | `/stage` | The existing community, monthly | Low | Not an event: a rhythm, and the cheapest recurring reason to return |
| 9 | **The Family Portrait drive** | `/create/selfie`, `/dad`, `/create/video` | The most non-technical audience there is | Low | Emotional rather than competitive, and it produces gifts people actually send |
| 10 | **The Collective Drop** | `/drops`, `/creations` | Creators and collectors | Medium | The community co-authors one supply-capped collection instead of competing |
| 11 | **Build Night in the plaza** | `/play` voxel building, `multiplayer/` | Anyone who has played a building game | Low | Collaborative rather than competitive: one landmark, built together, live |
| 12 | **The 60-Second Speedrun** | `/forge`, `/studio` | Livestream audiences | Almost none | A perfect stream segment, not a whole event: use it inside another one |

### 1. Sign Week

**What happens.** Five days, one signed word a day. The avatar forms the letter, your camera
watches your hand, and the page grades the handshape live and names the finger that is off.
Everything runs on-device and no video is ever uploaded, which is the part that makes a
public learning event with a webcam ethically simple rather than a privacy negotiation. It
closes with a signed-word relay in the world.

**Why it is the best partner fit on this list.** Accessibility is one of the few areas where
IBM's institutional history is genuinely deep, and an AI avatar that teaches fingerspelling
with live on-device feedback is a demonstrably useful thing rather than a demo. It is also
the one idea here that a journalist would write about without being asked, and the one most
likely to attract collaborators (schools, deaf educators, accessibility orgs) who bring
their own audiences.

**Watch out for.** Sign language is a real language with real communities and a long history
of hearing people building tools for it badly. Any version of this needs deaf collaborators
involved before it is announced, not after, and it should teach fingerspelling honestly as
one narrow slice of ASL rather than implying the avatar signs the language.

### 2. The 30-Day Forge Streak

**What happens.** `/daily` already posts a new creative challenge every day and tracks a
streak, free and with no sign-up. Wrap thirty days of it in a public leaderboard, a prize
per week, and a badge for a perfect month. The whole event is a page, a schedule of themes
and a prize list.

**Why it matters more than it looks.** A daily challenge with a visible streak is the
strongest retention mechanic consumer software has, and the surface is already shipped. Run
this underneath whatever headline event we pick, permanently. It is the difference between a
spike and a line that goes up.

### 3. World Lines: the global hunt

**What happens.** Agents are placed at real coordinates in a set of cities. Walk to one,
complete its AR challenge on your phone, and earn an agent-signed proof of presence that
only ever records an approximate area, never your exact position. Cities compete on a
leaderboard. Anyone with a phone can play, and every capture is a photo someone posts.

**Why it is the answer to the original brief.** This is the "genuinely new, IRL or hybrid"
idea in its strongest form: not a meetup with a video call bolted on, but a game whose board
is the actual world, with cryptographic proof you were there. If IBM has offices willing to
host a pin, the hunt has anchor points with real foot traffic and a reason for their staff
to play.

**Watch out for.** Geographic coverage. A hunt with pins in three cities is a hunt most of
the audience can only read about, so pair every physical pin with a virtual one in the world
so nobody is locked out by geography.

### 4. Portal Day

**What happens.** Paste any web address into `/portal` and walk through it in 3D: sections
become buildings sized by what they say, links become doors you step into. The event is a
day of people portaling sites they love, sites they built, and sites they hate, with a live
tour of the strangest ones on stream.

**Why it is worth a day.** The entry action is pasting a URL, which is the lowest possible
bar, and the output is instantly personal because it is *their* site. It is also the single
best demo we have for an audience that does not care about 3D generation as a category.

### 5. Opening Night

**What happens.** Curate the strongest community creations of the preceding month into a
built exhibition space, then open it on a specific night with a host, a walkthrough, and the
creators present as avatars beside their work. If IBM has a room, the same pieces stand in
it in AR.

**Why it is different from a contest.** A contest produces a winner and a leaderboard. An
exhibition produces a place, a catalog and a night, and it treats the people who made things
as artists rather than entrants. Press writes about openings. It also gives the runners-up of
every previous contest somewhere to end up.

### 6. Mascot Week

**What happens.** Companies submit their mascot, character or logo and get it back as a
rigged, talking 3D agent with a one-line embed for their own site, plus a live card for a
Slack channel or a widgets board. A week of them, published as a gallery, with a best-in-show.

**Why it is the commercial one.** Every other idea here produces creations. This one
produces *embeds on other companies' websites*, which is the actual business, and it aims at
exactly the enterprise audience IBM's community is full of. It doubles as a lead list.

### 7. Crews Cup

**What happens.** Not an event by itself: a team layer over any of the others. Found a crew,
invite your people, and the whole roster stands in one 3D headquarters, lit when they are
live. Score the contest by crew as well as by individual, so an office, a university club or
a user group can enter together.

**Why to bolt it on.** Individual contests recruit one person at a time. Team contests
recruit whoever that person can drag in, and the drag-in is done by them, not by us.

### 8. The Living Stage show

**What happens.** A monthly hour on `/stage`: an embodied AI host in a 3D venue with spatial
voice, taking audience questions live, with a human guest each month. Anyone can attend as
an avatar.

**Why it is the highest-leverage low-effort item.** It is a date on a calendar that repeats,
which is the thing a community needs most and the thing we do not currently have. Guests are
the recruitment mechanism: every guest brings their own audience once.

### 9. The Family Portrait drive

**What happens.** One photo becomes a recognizable, rigged, animated 3D avatar that idles,
walks and waves, with a permalink to send. `/dad` is this exact flow, already built, for one
occasion. Point it at a holiday, or at nothing in particular, and make the artifact a gift
rather than an entry.

**Why it reaches people no contest reaches.** Competing is a niche behavior. Sending your
mother something you made of her is not. This is the most non-technical idea on the list and
the one most likely to be used by someone who never returns, which is a fine outcome when the
thing they made has our name on the permalink.

### 10. The Collective Drop

**What happens.** Instead of competing, the community co-authors one supply-capped
collection: contributed traits, weighted layers, and the whole supply rolled from a published
seed so rarity is verifiable. Everyone who contributed a trait is in the collection.

**Why it is different.** It is the only idea here where entrants end up with a shared
artifact rather than a ranking, and shared artifacts create the group identity a leaderboard
actively prevents.

### 11. Build Night in the plaza

**What happens.** One evening, one landmark, built live and together with the voxel building
in the world, hosted on stream. It stays standing afterwards.

**Why it works.** Collaborative building is the format that made the sandbox genre, it needs
no skill to join, and the result is a permanent thing in a place people already visit. The
cheapest possible community night.

### 12. The 60-Second Speedrun

**What happens.** A timed race from a blank prompt to a live, embedded, talking agent on a
page, on stream, with a leaderboard.

**Why it is a segment, not an event.** It is a spectacle that proves the product is fast, and
it belongs in the middle of a kickoff, not on its own page.

## If we ran three of these

A defensible season, in order, and each one is independently cancellable:

1. **Now:** the 30-Day Forge Streak, running quietly underneath everything else. It is nearly
   free and it is the only item that compounds.
2. **The headline:** the Forge-Off Open, with the Crews Cup layered on so teams recruit for
   us, or Sign Week instead if the partner conversation wants the accessibility story more
   than the volume.
3. **The rhythm:** the Living Stage show, monthly from then on, with Opening Night as the
   quarter's version once there is a month of work worth exhibiting.

World Lines is the one to hold for the moment we want a story nobody else can tell, because
it is the only idea here that needs the physical world and the only one that cannot be
copied by a competitor with a text box.
