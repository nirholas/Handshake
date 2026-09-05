---
venue: dev.to (cross-post to Hashnode and Medium with canonical back to three.ws)
account: three.ws / nichxbt
suggested_title: "We published 72 MCP servers. Here is what I would do differently."
description: "A practical post-mortem on running a large MCP fleet: why we ended up with 72 servers, the four traps that cost us the most (annotation blindness, stdio consent, OAuth discovery 404s, and free/paid entanglement), and the four rules we now build to."
tags: [mcp, ai, agents, opensource]
canonical: https://three.ws/docs/mcp
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# We published 72 MCP servers. Here is what I would do differently.

Not a brag. A confession, and then four rules.

I work on [three.ws](https://three.ws), an open-source platform where AI agents get 3D bodies. Along the way we ended up publishing **72 MCP servers in the official Model Context Protocol registry** under one namespace, and **91 npm packages**, 39 of them MCP servers in the main repo. That happened over months, one reasonable decision at a time, and the sum of those reasonable decisions is a discovery problem.

If you are about to publish your second, fifth, or fiftieth MCP server, this is what I know now that I did not know then.

## How you get to 72 without ever deciding to

Every capability that felt independently useful became its own server, because publishing a server is cheap and MCP has no first-class notion of a bundle or a namespace. Avatars, 3D generation, scenes, voice, vision, market data, notifications, billing, naming, provenance, home control, and so on. Each one was defensible. None of them was the result of a plan.

The failure is not technical. All 72 work. The failure is that **a user cannot find the right one**, and neither can an agent, and the registry alone does not fix that.

## Trap 1: tool annotations describe, they do not enforce

MCP gives you `readOnlyHint`, `destructiveHint`, `openWorldHint`. Set them accurately; reviewers check, and inaccurate annotations are a listed rejection reason on the platforms with directories.

But understand what they are: **metadata for the client's UI, not a control.** They do not stop a tool. And the vocabulary has a real gap: `destructiveHint` covers "this deletes something", and does not distinguish between "this spends forty dollars" and "this unlocks a door in a house where a child is asleep".

We now write the server-side refusal first and the interface second. If a guard exists only in prompt text or in a hidden button, it is not a guard. An assistant can be argued out of a sentence; it cannot be argued out of a 403.

## Trap 2: a stdio server cannot obtain consent, and should stop pretending

We publish a server that gives any assistant control of a real Home Assistant house: read the house, list entities, list scenes, run one, call a service.

The dangerous calls (locks, primarily) pass through a physical-action gate, and **over stdio that gate refuses outright**. Not "prompts the user". Refuses.

The reasoning took us a while to arrive at and now seems obvious. A local stdio MCP server has no user-visible surface of its own, no session, and no way to prove that a human saw a request and approved it. Any "confirm?" it emits is a string the model can read, generate, and answer by itself. That is not consent, it is theatre. So the dangerous verbs are only available on a surface where a real person can be shown a real prompt, and the local server says plainly that it will not do it and why.

The pattern generalises past homes to any stdio server that can spend money, send messages as a user, or move something physical.

## Trap 3: the OAuth discovery document nobody checks

Our hosted server sits behind OAuth 2.1. The single most common reason a technically-correct MCP server fails a client's auth handshake is that `/.well-known/oauth-protected-resource` (or its neighbours) is not actually routed and answers 404, usually because the route table and the file layout disagree in production but not locally.

Test it from outside your network, in production, with curl, after every deploy. It is a one-line check and it saves a week of "works on my machine" bug reports from users you cannot debug.

## Trap 4: free and paid entangled in one server

We ship a free 3D server and a paid one. The free one has **no payment code in it at all.** Not disabled, not feature-flagged: absent. Different origin, different codebase, different deploy.

This started as a review-friendliness decision (the directories reject anything that looks like it might charge under false pretences, and "we present a call as free and then charge" is a listed rejection reason). It turned out to be an engineering win too: a claim you can verify by reading an import list is a claim that stays true, and a flag that gates payment is a flag somebody will flip in the wrong environment eventually.

The one exception we allow runs the other way, and it is deliberate: a couple of tools on the **paid** server are permanently free, because they are assurance checks. An asset-grading tool that costs money is a tool nobody calls, and a tool nobody calls prevents nothing.

## The four rules we build to now

**1. One tightly scoped server per audience, not per capability.** Our ChatGPT-facing server is exactly the 3D tools and nothing else: eleven of them, keyless, no wallet, no account. The directories reward tightly scoped apps and reject generic ones, and thirty-seven separately submitted servers read as directory spam even when each one is good. Submit one, document the rest as direct connections.

**2. One hosted server for clients that want everything**, behind real auth, with working discovery metadata.

**3. Typed tool authoring, shared across servers.** We publish `@three-ws/tool-sdk` (`defineTool`, `defineExec`) so annotations, schemas, and error shapes cannot drift from server to server. Fifty hand-written servers will disagree about error shape by the third one, and an agent handling five different error conventions handles none of them well.

**4. Publish where clients actually look.** The official registry is necessary and not sufficient. Ours are also indexed on PulseMCP and Glama, exposed through a LobeHub plugin manifest served from our own domain, and shipped as plugins in an editor plugin marketplace. Discovery is distribution, and distribution is not automatic.

## The one thing that mattered more than all of it

If you take a single idea from this post, take this one instead of anything about fleets.

Every text-to-3D API, ours included, answered tool calls with a **URL to a binary file**. A human clicks it. An agent cannot read it. So we shipped a tool that renders a model into frames returned as MCP image content blocks, and the agent can finally look at what it made, judge it, and iterate.

It was a weekend of work and it changed what the pipeline can do, because a loop needs an error signal and a binary URL is not one.

**Any tool that hands an agent a binary needs a companion that renders it into the agent's own modality.** PDFs, spreadsheets, audio, CAD, compiled artifacts. If your agent cannot perceive its own output, it is guessing, and no amount of prompt engineering fixes that.

## Try any of it

```bash
# 11 keyless 3D tools, no account
curl -s https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Everything is Apache-2.0 at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws). The MCP docs are at [three.ws/docs/mcp](https://three.ws/docs/mcp).

If you publish MCP servers at any scale, I would like to hear how you handle namespacing and discovery. I do not think our answer is right; it is only the one that worked.
