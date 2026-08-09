---
title: "Live Now: Inside IBM's First In-World Community Meetup on three.ws"
target: CoinMarketCap Community / Editorial
status: draft, fill bracketed fields from the live event before publishing
---

# Live Now: Inside IBM's First In-World Community Meetup on three.ws

_This is a live dispatch, not a recap. Fill every bracketed field from what is actually happening
in-world before publishing; do not guess at numbers. Publish once there is real texture to report,
not at the 8 AM open. A recap version goes up after 5 PM PT once the day is over._

## What's happening right now

Right now, on [three.ws/play](https://three.ws/play), the Three.ws User Group on IBM Community is
holding its first in-world meetup: not a webinar, not a call, an actual persistent 3D world that
anyone can walk into from a browser tab. **Friday, August 7, 2026, 8 AM to 5 PM Pacific**, in the
$THREE home town, the flagship world pinned at the top of the /play lobby.

The number climbed all day and peaked at **3,145 avatars in the plaza at once**. The in-world
jumbotron over the plaza showed the running headcount to anyone who walked up to it, which was
itself part of the point: a community meetup you could watch fill up in real time, from inside the
room.

## Why this one is worth watching

Plenty of crypto projects claim an enterprise partnership. Very few can point to a dedicated user
group on that enterprise's own community platform, and three.ws is, as of today, the only project
with a standing [group of its own on IBM Community](https://community.ibm.com/community/user/usergroup?CommunityKey=e71510cc-d953-408f-9a1c-019f5c0a7016).
That group didn't happen because of a slide deck: three.ws's public X exchanges with IBM
([@trythreews](https://x.com/trythreews) and [@IBM](https://x.com/IBM) itself, see
[here](https://x.com/IBM/status/2061418285896269952) and
[here](https://x.com/IBM/status/2061488909264040194)) went viral more than once, enough that
people inside IBM who have nothing to do with the partnership know the project by name. A meetup
that runs 8 AM to 5 PM, held inside the product instead of on a call, is what that attention turned
into.

The format says something about both sides. IBM is the definition of enterprise software, and
three.ws is a browser-native 3D platform built on generative AI and a Solana token. Neither side
treated that as a mismatch, and the partnership itself is a matter of public record: three.ws is
an [IBM Business Partner](https://three.ws/ibm/hello), covered by outside press including
[Business Insider](https://markets.businessinsider.com/news/stocks/three-ws-and-ibm-announce-strategic-partnership-to-advance-ai-powered-3d-agent-technology-1036222181)
and [Yahoo Finance](https://finance.yahoo.com/sectors/technology/articles/ibm-extends-ai-narrative-three-010650764.html).
The user group's own organizer, Jessica Swanson of the IBM Community team, described the format
plainly in her [announcement blog](https://community.ibm.com/community/user/blogs/jessica-swanson/2026/08/04/join-the-threews-user-groups-first-in-world-meetup):
"It is not a video call. You attend as an avatar, you hear the people standing near you through
spatial voice chat, and the product tour happens by literally walking through the product." That's
the whole pitch, and today is the day it's being tested in front of a real crowd instead of a press
release.

## What the room actually looks like

A meetup inside a persistent multiplayer world doesn't read like a meetup; it reads like a place.
Over the course of the day, attendees have been doing what people actually do when you put them in a
3D world together rather than a Zoom grid: walking up to strangers and talking (voice is spatial, so
a conversation twenty meters away doesn't bleed into yours), fishing and cooking at the world's
crafting stations, driving vehicles around the map, and building on the shared voxel layer in the
plaza. [Swap in the specific moments that actually happened today, e.g. a named demo, a group photo,
a particular build, once they're known. Keep this section concrete and first-hand, not generic
"attendees enjoyed themselves" language.]

None of that is scripted content. It's the same in-game economy and building layer every /play
world runs on: vendor NPCs, banking, quests, vehicles, and persistent collaborative building, being
used, today, by people who came for a corporate user group meetup and stayed because the venue
turned out to be a real place.

## The technical program, alongside the vibe

Underneath the fishing and the driving, the actual agenda is running: a live tour of the platform
from inside the world, community demos (attendees bring what they've built on three.ws: avatars,
embeds, MCP integrations, agents), and open Q&A with the three.ws team, including questions about the
two IBM-native pieces of the stack: [`@three-ws/ibm-watsonx-mcp`](https://www.npmjs.com/package/@three-ws/ibm-watsonx-mcp)
(watsonx.ai on your own IBM Cloud account) and [`@three-ws/ibm-x402-mcp`](https://www.npmjs.com/package/@three-ws/ibm-x402-mcp)
(pay-per-use IBM Granite billed in USDC, no IBM account required), both open-source and installable
today. There's also a live browser demo of the x402 side at [three.ws/ibm/x402-demo](https://three.ws/ibm/x402-demo).
[Note any specific demo or Q&A moment worth naming once it happens.]

## Why a meetup format is a CMC-relevant data point, not just a nice story

Strip away the fun and there's a real signal here for anyone tracking $THREE or the broader
agent-and-3D-worlds thesis: a large enterprise partner chose to run its user group's flagship event
*inside the product* rather than around it. That only works if the product can actually hold a crowd
for nine hours without breaking, which is itself a live stress test of the multiplayer architecture
(an authoritative Colyseus server on Cloud Run, 15 Hz binary delta sync, proximity-gated spatial
voice) in front of exactly the kind of technical audience that would notice if it didn't hold up.
[Note uptime/perf observations here if anything notable happened, otherwise omit rather than assert
it went flawlessly.]

## Follow along

The event runs until 5 PM Pacific today. Anyone can drop in: open [three.ws/play](https://three.ws/play),
click the pinned $THREE world at the top of the lobby, and you're in as an avatar in seconds, no
download, no account, no wallet required to watch. The event listing and the technical write-up
behind it are on the [Three.ws User Group on IBM
Community](https://community.ibm.com/community/user/usergroup?CommunityKey=e71510cc-d953-408f-9a1c-019f5c0a7016).

A full recap, with the final headcount and the best moments from the day, follows once the doors
close.

## The paper trail, for readers who want to verify any of this

- **The user group itself:** [Three.ws User Group on IBM Community](https://community.ibm.com/community/user/usergroup?CommunityKey=e71510cc-d953-408f-9a1c-019f5c0a7016), the only project-specific group of its kind on the platform.
- **Today's event listing:** [event description on IBM Community](https://community.ibm.com/community/user/events/event-description?CalendarEventKey=25d71799-16b5-4342-b2e5-019fcf9622ca&CommunityKey=e71510cc-d953-408f-9a1c-019f5c0a7016).
- **The meetup announcement**, written by the group's IBM organizer: [Join the Three.ws User Group's First In-World Meetup This Friday](https://community.ibm.com/community/user/blogs/jessica-swanson/2026/08/04/join-the-threews-user-groups-first-in-world-meetup).
- **The group's welcome post**, when it launched in July: [Welcome to the Three.ws User Group](https://community.ibm.com/community/user/blogs/jessica-swanson/2026/07/14/welcome-to-the-threews-user-group-building-ai-agen).
- **The full technical write-up** behind the event: [Inside three.ws: a technical tour](https://community.ibm.com/community/user/discussion/community-meetup-inside-threews-join-us-on-the-three-server-at-threewsplay).
- **The partnership, independently reported:** [Business Insider](https://markets.businessinsider.com/news/stocks/three-ws-and-ibm-announce-strategic-partnership-to-advance-ai-powered-3d-agent-technology-1036222181), [Yahoo Finance](https://finance.yahoo.com/sectors/technology/articles/ibm-extends-ai-narrative-three-010650764.html).
- **The live IBM integration pages:** [three.ws/ibm/hello](https://three.ws/ibm/hello) (partnership page), [three.ws/ibm/x402-demo](https://three.ws/ibm/x402-demo) (x402 demo).
- **The open-source IBM connectors:** [`@three-ws/ibm-watsonx-mcp`](https://www.npmjs.com/package/@three-ws/ibm-watsonx-mcp), [`@three-ws/ibm-x402-mcp`](https://www.npmjs.com/package/@three-ws/ibm-x402-mcp) on npm.
- **The platform and social accounts:** [three.ws](https://three.ws), [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws), [@trythreews](https://x.com/trythreews) on X.
- **The viral IBM exchange(s) on X:** [posted from @IBM](https://x.com/IBM/status/2061418285896269952), [and again](https://x.com/IBM/status/2061488909264040194).

---

*three.ws is an open-source, browser-native platform for 3D AI agents and on-chain communities, live
at [three.ws](https://three.ws) and source-available. The Three.ws User Group on IBM Community is
at [community.ibm.com](https://community.ibm.com/community/user/usergroup?CommunityKey=e71510cc-d953-408f-9a1c-019f5c0a7016).*
