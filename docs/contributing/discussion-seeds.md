# Discussion seeds

Three ready-to-post GitHub Discussions that turn an empty Discussions tab into a live community front door. Written 2026-08-21 for the Open Source Friday application (see [../open-source-friday-plan.md](../open-source-friday-plan.md)), where a community conversation channel is a preference criterion and an empty tab reads as nobody being home.

**These are not posted yet.** The automation token in this workspace has `issues: write` but not `discussions: write`, so a human has to paste them. Each takes about 20 seconds:

| Post | Category | New-discussion link |
|---|---|---|
| Welcome | Announcements | [new](https://github.com/nirholas/three.ws/discussions/new?category=announcements) |
| Show and tell | Show and tell | [new](https://github.com/nirholas/three.ws/discussions/new?category=show-and-tell) |
| Roadmap | Ideas | [new](https://github.com/nirholas/three.ws/discussions/new?category=ideas) |

Pin the Welcome post after publishing it. Delete this file once all three are live, or leave it as the record of what was posted.

---

## 1. Welcome (Announcements, pin it)

**Title:** `Welcome to three.ws: start here, and introduce yourself`

```markdown
Welcome. This is the front door for the three.ws community, so start here and say hello.

**three.ws** is an open framework for 3D AI agents on the web. A text prompt becomes a rigged, animation-ready avatar, and one `<agent-3d>` tag drops it into any page with an LLM brain, memory, and moods behind it. Browser-native: Three.js and glTF, no plugin, no game engine.

## Introduce yourself

Reply with:

- What you build, or what brought you here
- What you would use a 3D agent for
- One thing that is currently harder than it should be

That last one is the most useful thing you can give us. The best issues in this repo started as somebody saying a thing felt wrong.

## Where everything is

| | |
|---|---|
| Try it | [three.ws](https://three.ws) |
| Will my avatar animate? | [Rig Doctor](https://three.ws/rig-doctor), drop a `.glb` and find out |
| First contribution, 15 minutes | [docs/first-contribution.md](https://github.com/nirholas/three.ws/blob/main/docs/first-contribution.md) |
| Curated starter work | [`good first issue`](https://github.com/nirholas/three.ws/labels/good%20first%20issue) |
| How we triage and how fast we answer | [docs/triage.md](https://github.com/nirholas/three.ws/blob/main/docs/triage.md) |
| Every channel we are in | [docs/community.md](https://github.com/nirholas/three.ws/blob/main/docs/community.md) |
| Real-time chat | [Telegram](https://t.me/three_ws_community) |
| Demos and avatars people built | [X community](https://x.com/i/communities/1923523161230078106) |
| Enterprise and integration talk | [IBM Community group](https://community.ibm.com/community/user/usergroup?CommunityKey=e71510cc-d953-408f-9a1c-019f5c0a7016) |
| Every user-visible change | [changelog](https://three.ws/changelog) and [t.me/three_ws](https://t.me/three_ws) |

## Two house rules

The [Code of Conduct](https://github.com/nirholas/three.ws/blob/main/CODE_OF_CONDUCT.md) applies in every room, not just this one. Beyond it:

- **No trading talk in the technical channels.** There are on-chain surfaces in this project. Price chat still does not belong anywhere near a bug thread.
- **Share the file.** Rendering and rigging bugs are nearly impossible to guess at and trivial to diagnose from the actual GLB.

Welcome aboard.
```

---

## 2. Show and tell (Show and tell)

**Title:** `Show and tell: what have you built with three.ws?`

```markdown
Show us what you built with three.ws. Avatars, embeds, agents, weird experiments, half-finished things you are not sure about. All of it.

**A good post has:**

- A screenshot or a screen recording. This is a 3D project. Pixels or it did not happen.
- One line on what it is
- A link, if it is live somewhere

**We will:**

- Repost the good ones from [@trythreews](https://x.com/trythreews) and in the [X community](https://x.com/i/communities/1923523161230078106), with credit
- Turn anything that broke on the way into a real issue

**Things worth showing even if they feel small:** an avatar embedded in a site you already run, a rig that came from an unusual tool, a mood or animation sequence driven from your own page code, an agent doing something we did not design for.

That last category is the most interesting one. If you found a use we did not anticipate, that is a product direction, not a curiosity.

Broke something instead of building something? That is also worth posting. Open an [issue](https://github.com/nirholas/three.ws/issues/new/choose) and link it here.
```

---

## 3. Roadmap (Ideas)

**Title:** `Roadmap: what should we build next, and what is in your way?`

```markdown
What should we build next, and what is currently in your way?

This thread is deliberately open. We ship fast and publish every user-visible change to the [changelog](https://three.ws/changelog), which means the roadmap is genuinely steerable by whoever shows up with a good argument.

## The best kind of reply

Not "add feature X", but:

> I was trying to do **[thing]**. I got as far as **[point]**. Then **[what stopped me]**.

That format tells us the shape of the gap instead of one guess at its solution, and it is how most of the good decisions in this project got made.

## Where we think the sharp edges are

Tell us if we are wrong about any of these. Being wrong here is expensive, so an argument against one of them is more valuable than agreement.

- **Rig coverage.** Every humanoid GLB in the wild names bones differently, and we map them to one canonical skeleton so the shared clip library retargets onto anything. Rigs we do not recognise fall back to a default body. If yours does that, [Rig Doctor](https://three.ws/rig-doctor) will tell you exactly which joints we missed, and that list is a contribution: see [#115](https://github.com/nirholas/three.ws/issues/115).
- **The embed story.** One `<agent-3d>` tag is meant to be all it takes. If integrating into your framework needed more than that, say what.
- **The agent runtime.** Memory, moods, tools, brains. What is missing for the agent you actually want to build?
- **Docs.** If you had to read source to answer something, that is a docs bug and we want the specific question.

## What happens to replies here

Anything concrete becomes an issue, linked back to this thread. Anything shipped shows up in the changelog and gets a reply here saying so. Nothing gets quietly dropped.
```
