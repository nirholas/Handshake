# The First Three.ws User Group Meetup: How It Actually Went

_By Jessica Swanson, posted as a follow-up blog in the [Three.ws User Group on IBM
Community](https://community.ibm.com/community/user/usergroup?CommunityKey=e71510cc-d953-408f-9a1c-019f5c0a7016),
closing out the arc that started with [Join the Three.ws User Group's First In-World Meetup This
Friday](./ibm-community-blog-meetup-jessica.md) and continued mid-day with [LIVE at the Meetup: My
Honest Take So Far](./ibm-community-live-reaction-jessica.md). Header image: reuse
[media/ibm-x-threews-lockup.png](./media/ibm-x-threews-lockup.png), or swap in a real photo from
the day once one is ready; do not paste this note into the published post._

_[Fill in once picked: the strongest single moment from the day, named specifically, whether that's
a demo, a build, or a conversation. Do not publish this post with that left generic. The final
in-world headcount is filled in below: peak concurrency was 3,145.]_

I wrote a live post in the middle of the meetup because I wanted the group to have my honest
reaction while it was happening, not a cleaned-up version after the fact. Now that the day is over,
here's the close of that arc.

Going in, I already knew this was a unique situation. Three.ws is the only project I know of with
its own dedicated user group here on IBM Community, and that group exists because the project had
already been on our radar before it launched. Some of that is because our timelines crossed in
public first: IBM's own account traded posts with three.ws on X that went a little viral (see
[here](https://x.com/IBM/status/2061418285896269952) and
[here](https://x.com/IBM/status/2061488909264040194)), and people inside IBM who have nothing to do
with this group noticed. That's not the usual thing I get to say about a partner.

What made the day itself work is the same thing I said mid-event: neither IBM nor three.ws is the
slow, boring-enterprise thing people assume from the outside. We both like trying things that are
actually new, and a nine-hour user-group meetup held entirely inside a 3D world, instead of on a
call, is exactly that kind of thing. It held up. This group is still small, but the open world we
held it in is not gated to members: anyone with the link could walk in, and a lot of people did.
Peak concurrency in the world hit 3,145 avatars at once over the course of the day, well past
anything a call could have seated, even though most of that crowd came for the open world itself
rather than being User Group members.

## What the day actually looked like

The agenda ran the way it was supposed to: a live tour of the platform from inside the world,
community demos from people who brought what they'd built, and open Q&A with the three.ws team,
including real questions about `@three-ws/ibm-watsonx-mcp` and `@three-ws/ibm-x402-mcp`, the two
open-source connectors into watsonx.ai and Granite. [Name the standout demo or Q&A exchange here
once known.]

But the part I keep coming back to is everything that happened around the agenda, not in it. I
spent a big chunk of the day with Broke Boi and bigB: we went fishing, cooked what we caught, and
drove the cars around the map for no reason other than it was fun. No pitch deck, no slides, just
people, in a place, doing things together. That's not a sentence I expected to write about a work
event, and it's exactly why it's the one I'm leading with.

## What people actually showed off

The Q&A wasn't just about the two connectors. People walked through the rest of the platform too,
and it's more than I expected going in. There's Forge, the free text-to-3D tool: type a sentence
and a textured model comes out the other end, no download, no account. There's Avatar Studio on top
of that, which doesn't just generate a mesh, it rigs it, so whatever you make can walk, wave, and sit
down like everyone else in the room. Someone asked how that works across avatars people already had
from other tools, and the answer surprised me: the platform doesn't keep an allowlist of rigs it
supports, it reads whatever skeleton the file came in with, Mixamo, VRM, Daz, Blender, and maps it
onto a common set of bones so the same animations work on all of them. A couple of people had
brought avatars from completely different pipelines and they moved the same as everyone else's.
There was also a wardrobe and cosmetics layer that carries across every coin's world, not just the
one you're standing in, and a live look at the agent-3d web component, which is how a site outside
three.ws entirely can embed one of these avatars and drive its mood or animation from its own code.

## Under the hood, from what I understood of it

I'm not the engineer in the room, but enough of the Q&A was technical that I picked some of it up.
The world runs on an authoritative server that every client's position and action gets checked
against, syncing sixteen times a second, and voice is spatial: it's carried over the same real-time
channel, gated by literal distance, so a conversation across the plaza doesn't bleed into yours. None
of the event dressing was a slide either. A countdown at the top of the screen turned into fireworks
when the day started, worked out from the clock rather than pushed over the network so it stayed in
sync no matter how many of us were watching, and everyone who walked in while it was live got a
Meetup Laurel, a small gold circlet, permanently, for free, and it will never be handed out again
once an event ends. That detail is the one I keep thinking about: the platform's answer to "prove you
were there" isn't a screenshot, it's something the server itself decided you earned.

## The part I don't usually put in a work post

I was never really into crypto before this partnership. I'm not going to soften that for the sake
of the group. Three.ws is what changed it for me, and it didn't happen through a pitch. It happened
through spending real time in and around what they've built, today especially.

I know how lucky I am to have a role where a day like this is the actual job. Not many people get to
say "went fishing with Broke Boi and bigB" and mean it as a line item in their week.

## Where this partnership goes from here

A meetup is a moment, not the whole plan. Nich and I have already been talking about turning
yesterday into a rhythm instead of a one-off: more joint posts on this group, more of three.ws's
actual shipped work surfaced through IBM's own channels instead of staying inside their own blog,
and a standing invite for the next build session to happen in-world again rather than back on a
call. On three.ws's side, they're now looking closely at what IBM's newly expanded Partner Plus
marketplace motions could mean for a partner their size: IBM opened up Microsoft Multiparty Private
Offers and Google Cloud Marketplace Channel Private Offers to business partners this month, on top
of the AWS reseller integration that's already live. Nothing there is confirmed yet, eligibility and
approval are IBM's call, not mine to promise on this post, but it's a real conversation and one I
expect to have more to say about in a future update here.

## What's next

The world stays open at [three.ws/play](https://three.ws/play), and the group stays open too.
[Add the date or plan for the next meetup here once one is set; if nothing is confirmed yet, say
plainly that the team is deciding and members should watch this space rather than implying a date
that doesn't exist.]

If you were there today, thank you for making it a real room and not just an announcement people
clicked past. If you missed it, the recording and the best clips [link once available] are the
closest thing to having been there, and the world itself never closes.

## Links

- Platform: [three.ws](https://three.ws)
- Free text-to-3D: [three.ws/create](https://three.ws/create)
- The worlds: [three.ws/play](https://three.ws/play)
- Docs: [three.ws/docs](https://three.ws/docs)
- Blog: [three.ws/blog](https://three.ws/blog)
- GitHub: [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)
- X: [@trythreews](https://x.com/trythreews)
- The team's own recap, from the other side of the day: [three.ws/blog/ibm-user-group-first-in-world-meetup-recap](https://three.ws/blog/ibm-user-group-first-in-world-meetup-recap)

---

## Rules for posting this

- **Post from Jessica's own IBM Community profile**, as a new blog entry in the Three.ws User
  Group, the same surface as her announcement post and her mid-day live reaction. This closes a
  three-part arc; don't fold it into an edit of either earlier post.
- **Fill both bracketed sections before publishing.** The standout-moment placeholder and the
  next-meetup placeholder are the two claims in this draft that need a real answer, not a
  confident-sounding guess. If there's no next date yet, say so plainly rather than implying one.
- **Let Jessica edit freely.** This is a starting draft in her established voice, not a final
  script; she should change anything that doesn't match how the day actually felt to her.
- Confirm how Broke Boi and bigB actually go by on IBM Community today before posting, so any
  mentions or tags resolve correctly.
- Once posted, add it to the catalog in [ibm-community.md](./ibm-community.md) as the group's next
  blog entry, following the same fields (author, published date, activity, URL, summary) as the
  existing three entries, and cross-link it from the live-reaction catalog entry if that post was
  published too.
