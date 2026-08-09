# Hosting the Group's First Meetup Inside three.ws: My Recap

_By nich (nich8), posted as a blog entry in the [Three.ws User Group on IBM
Community](https://community.ibm.com/community/user/usergroup?CommunityKey=e71510cc-d953-408f-9a1c-019f5c0a7016),
the team's own side of the meetup recap, alongside Jessica's [live
reaction](./ibm-community-live-reaction-jessica.md) and [recap](./ibm-community-recap-jessica.md)
on the same group. Two different people, two honest accounts of the same day; this one is mine,
written the way I wrote the [Forge walkthrough](https://community.ibm.com/community/user/discussion/type-a-sentence-get-a-3d-model-a-hands-on-walkthrough-of-the-threews-forge-user-perspective)
and the [10 features post](https://community.ibm.com/community/user/blogs/nich8/2026/07/16/threews-the-free-ai-3d-model-generators-10-best),
first person, no marketing voice. Companion piece for three.ws/blog:
[ibm-user-group-first-in-world-meetup-recap.html](../blog/ibm-user-group-first-in-world-meetup-recap.html),
also written in my voice, for readers who came from that side instead of this group._

_[Fill in before posting: the standout demo or Q&A moment, same gap as Jessica's recap. Don't
publish with it left generic. The final headcount is filled in below: peak concurrency was 3,145.]_

Yesterday I hosted the first meetup of this group, nine hours, 8 AM to 5 PM Pacific, entirely
inside three.ws itself. The group is small and the world was not gated to its members: anyone with
the link could walk in, and the open world peaked at 3,145 concurrent avatars at once over the
course of the day. I want to write down how it actually went while it is still fresh, from the side
of the person who built the thing everyone was standing in.

## Why we did it this way

This group is the only one of its kind I know of: a dedicated IBM Community group for a single
project. That did not happen from a pitch deck either. Our timelines crossed in public first. IBM's
own account traded posts with us on X that went a little viral (see
[here](https://x.com/IBM/status/2061418285896269952) and
[here](https://x.com/IBM/status/2061488909264040194)), and people inside IBM who have nothing to do
with this group started bringing us up unprompted. Once the group existed, a first meetup that just
described the product on a call felt like it would have wasted the whole premise. Neither IBM nor
three.ws is the slow, boring-enterprise thing people assume from the outside, and the only honest
way to prove that was to hold the meetup inside the actual product, not next to it.

## What the day looked like from where I was standing

The program ran the way we planned it: a live tour from inside the world, community demos from
people who brought what they had built, and open Q&A, including real questions about
`@three-ws/ibm-watsonx-mcp` and `@three-ws/ibm-x402-mcp`, the two open-source connectors into
watsonx.ai and Granite. [Name the sharpest question or the best demo here once it's clear which one
that was.]

But most of what I remember from the day did not happen during the agenda. I spent a big chunk of
it fishing, cooking what we caught, and driving the cars around the map with Broke Boi and BigB. No
slides, no pitch, just people in a place. At some point Jessica, who organizes this group on IBM's
side, was doing the same thing, and I remember thinking that was the entire argument for the format
in one sentence: an IBM Community organizer spending her afternoon fishing in our product instead of
sitting through a deck about it.

## The rest of the platform got demoed too

The MCP connectors were the official agenda item, but the Q&A wandered into everything else people
wanted to poke at, and I was glad it did. Forge came up a lot: free text-to-3D, type a sentence, get
a textured model, no account required. So did Avatar Studio, which is Forge's rigged sibling, it
doesn't just generate a mesh, it skeletonizes it, so whatever comes out can walk and sit down like
everyone else in the world. Someone asked whether that only works on avatars made in our own tool,
and the honest answer is no: the retargeting layer reads whatever bone naming convention a GLB
arrives with, Mixamo, Avaturn, Unreal, VRM and VRM 1.0, Daz/Genesis, MakeHuman, Blender's own `.L`
suffix convention, and maps it onto a canonical skeleton, so an avatar someone made somewhere else
entirely still walks and waves correctly the moment it loads. We also walked through the wardrobe
and cosmetics layer, which is shared across every coin's world rather than scoped to one, and the
agent-3d web component, which is the piece that lets a site that isn't three.ws at all embed one of
these avatars and drive its animation state from outside code.

## What it proved as an engineer, not just as a host

Strip the fun away and a nine-hour meetup held entirely inside a live multiplayer world is a real
stress test, in front of exactly the audience that would notice if it broke: an authoritative
Colyseus server on Cloud Run, 15 Hz binary delta sync, proximity-gated spatial voice, carrying real
conversations for a full workday, with concurrency climbing past a thousand early and topping out at
3,145 at once. It held. I do not say that lightly; that is the kind of claim I would want proven in
front of me too, and yesterday it was.

None of the event dressing around the meetup was hand-built for the day either, and that mattered
more than I expected once people started asking about it. The live countdown that turned into
fireworks at 8 AM was worked out from a shared clock rather than pushed over the network, so the show
held together no matter how many of us were watching or how good anyone's connection was. Everyone
who walked in while the event was live got a Meetup Laurel, a small gold circlet with three pearl
berries, permanently, for free, decided server-side, and it will never be granted again once the
window closes: the only way to have one is to have actually been there. There was an event-only jobs
board too, four repeatable tasks that paid better than the everyday ones and fed a live leaderboard,
which is what Broke Boi and BigB and I were actually racing each other on between the fishing trips.
None of that is a demo built to impress a partner; it's the same event infrastructure every /play
world gets when its coin runs a scheduled event, and yesterday was the first time it ran at this
scale in front of an audience that would notice if it didn't.

## What I'd tell the next community trying this

Every world here is a shareable URL, and every pump.fun coin already has one derived from its mint.
The mechanics that carried a nine-hour, formal, all-day meetup are the same mechanics any community
gets for free. If your group is deciding between another call and an afternoon inside a world your
members can actually walk around in, I know which one I would pick, and now I have a day's worth of
uptime to back that up.

## Where I want to take this partnership next

One meetup doesn't make a partnership, it's the proof that the partnership is worth investing in
further, and that's how we're treating it. Jessica and I are already talking about making this a
rhythm rather than a one-off: more joint blog posts on both sides instead of one recap each, and more
of what we actually ship getting a shoutout through IBM's own channels instead of staying inside our
own. There's also a bigger swing we're now looking at seriously. IBM opened up its Partner Plus
marketplace motions to business partners this month: Microsoft Multiparty Private Offers across 35
countries and Google Cloud Marketplace Channel Private Offers across 43, on top of AWS reseller
transactions that are already integrated with automatic rebates. We're now pursuing what it would
take for three.ws to be eligible and approved to sell through those hyperscaler marketplaces
alongside IBM software. Nothing here is confirmed yet, that approval is IBM's to grant, not mine to
claim, but it's a real conversation growing directly out of yesterday, and I'll post an update the
moment there's something concrete to report.

## What's next

The world stays open at [three.ws/play](https://three.ws/play). The group stays open too.
[Add the next meetup date here once one is set, or say plainly that we are still deciding rather
than implying a date that does not exist yet.]

## Links

- Platform: [three.ws](https://three.ws)
- The worlds: [three.ws/play](https://three.ws/play)
- Free text-to-3D: [three.ws/create](https://three.ws/create)
- watsonx.ai MCP server: [`@three-ws/ibm-watsonx-mcp`](https://www.npmjs.com/package/@three-ws/ibm-watsonx-mcp)
- x402 Granite MCP server: [`@three-ws/ibm-x402-mcp`](https://www.npmjs.com/package/@three-ws/ibm-x402-mcp)
- Open source: [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)
- X: [@nichxbt](https://x.com/nichxbt), [@trythreews](https://x.com/trythreews)
- The team's side, also written by me, on three.ws/blog: [ibm-user-group-first-in-world-meetup-recap](https://three.ws/blog/ibm-user-group-first-in-world-meetup-recap)
- Jessica's side of the same day: her recap on this group's [recent blogs page](https://community.ibm.com/community/user/groups/community-home/recent-community-blogs?communitykey=e71510cc-d953-408f-9a1c-019f5c0a7016)

---

## Rules for posting this

- **Post from nich's own IBM Community profile (nich8)**, as a new blog entry, the same surface he
  used for the [10 features post](https://community.ibm.com/community/user/blogs/nich8/2026/07/16/threews-the-free-ai-3d-model-generators-10-best)
  and the [Forge walkthrough](https://community.ibm.com/community/user/discussion/type-a-sentence-get-a-3d-model-a-hands-on-walkthrough-of-the-threews-forge-user-perspective).
  Keep it distinct from Jessica's recap; do not merge the two into one post under either name.
- **Fill both bracketed sections before publishing**, same rule as Jessica's recap: no invented
  specifics for the standout moment or the next-meetup date.
- **Confirm how Broke Boi and BigB actually go by on IBM Community today** before posting, so any
  mentions resolve correctly. Match the spelling used in Jessica's recap (BigB, capitalized) for
  consistency across both posts.
- Once the three.ws/blog companion piece at
  [ibm-user-group-first-in-world-meetup-recap.html](../blog/ibm-user-group-first-in-world-meetup-recap.html)
  is actually deployed, its link in this draft resolves live; until then it is a same-repo link that
  works once shipped, not before.
- Once posted, add it to the catalog in [ibm-community.md](./ibm-community.md) as the group's next
  blog entry, following the same fields (author, published date, activity, URL, summary) as the
  existing entries, and cross-link it against Jessica's recap entry.
