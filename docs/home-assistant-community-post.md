---
venue: Home Assistant Community (community.home-assistant.io), category "Share your Projects!"
account: three.ws (official) / nichxbt
description: "Forum post introducing the three.ws Home Assistant integration: a HACS custom integration that dials out over one WebSocket so a LAN-only install can be reached, an MCP server whose door-opening tools refuse over stdio, household roles enforced server-side, and a 3D agent that stands in a live model of your house."
tags: [custom-integration, hacs, mcp, voice, presence]
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# I gave my Home Assistant a face, and spent most of the time making sure it cannot open my front door

_Forum post for the [Home Assistant Community](https://community.home-assistant.io), category "Share your Projects!". Written first person for people who run HA, not for people who sell things to people who run HA._

Hi all. I build [three.ws](https://three.ws), an open-source (Apache-2.0) platform for 3D AI agents: you describe a character, you get a rigged, animated 3D body that can talk, and you can embed it anywhere. For most of its life that character lived in a browser tab and the worst thing it could do was say something silly.

Then I connected it to my house, and the whole design changed. This post is what I built, and much more importantly, what I refused to build.

Short version: there is now a HACS integration that connects a LAN-only Home Assistant to a 3D agent that stands in a live model of your home and talks to you, plus an MCP server so **any** assistant (Claude, Cursor, your own) can read and drive your house. Locks are the interesting part, and the answer there is a flat no in several places on purpose.

## What Home Assistant already does, and what I did not rebuild

I wrote zero device code. Not "a thin abstraction", zero. Zigbee, Z-Wave, Matter, Thread, BLE, and the 1,500-plus integrations are the reason this project took weeks instead of years, and re-implementing any of it would have been vandalism. Since the `mcp_server` integration, HA also speaks Model Context Protocol natively, and three.ws already speaks MCP in around forty packages. The two halves met without either side inventing a protocol.

What genuinely does not exist anywhere, as far as I can tell, is the **face**: a real-time 3D presence that stands in a live model of your home, reacts to it, and speaks. That is the part I built.

## The LAN problem, and why the house dials out

Most HA installs cannot be reached from the internet. No forwarded port, no public address, nothing to dial. That is not an edge case, it is the default install, and any integration that assumes otherwise is a cloud product wearing a local-first hat.

So: **the house dials three.ws, and three.ws never dials the house.**

One integration from HACS opens a single outgoing WebSocket and keeps it open.

- Nothing listens on your network.
- No port is forwarded and no firewall rule changes.
- No tunnel daemon, no third-party service, no account anywhere else.
- **three.ws never receives a Home Assistant token.** The integration signs in to HA on your own machine with a credential it creates for itself, and that credential never leaves the house.

Install path, if you want to try it:

1. On three.ws, open `/smart-home`, choose **Connect a home that is only on my network**, and press **show me a code**. It has a ten-minute countdown.
2. In HACS, add `https://github.com/nirholas/three-ws-home-assistant` as a custom repository, category **Integration**.
3. Install **three.ws**, restart HA.
4. **Settings, Devices and services, Add integration, three.ws.** Paste the pairing code.

If your HA already has a remote https address (Nabu Casa, or your own reverse proxy), skip all of that and connect with a long-lived token instead. The relay exists for the houses that do not, not as the default path.

The threat model is written down and published rather than implied. Writing it is what produced two of the constraints above, which is an argument for writing one even when nobody asks.

## The part I care about: locks

Here is where I expect this forum to have opinions, and I would genuinely like them.

An LLM that can call `light.turn_on` is a convenience. An LLM that can call `lock.unlock` is a completely different product with a completely different failure mode, and the industry answer so far has been to put a sentence in a system prompt. **A system prompt is an argument, and an argument can be won by the other side.**

So the refusals live on the server, in four layers:

**1. The physical-action gate.** Anything that opens the house passes through one gate with one implementation (shared between the bridge and the MCP server rather than two copies that drift). It is not a naming convention or a category filter; it is a code path.

**2. Over stdio, that gate refuses outright.** The published MCP server, `@three-ws/home-mcp`, gives any assistant five tools: read the house, list entities, list the scenes your household already built, run one, call a service. Point it at your HA:

```bash
claude mcp add home \
  -e HOME_ASSISTANT_URL=https://example.ui.nabu.casa \
  -e HOME_ASSISTANT_TOKEN=... \
  -- npx -y @three-ws/home-mcp
```

Ask it to unlock a door and it will decline and tell you why. A stdio MCP server has no user-visible surface of its own, no session, and no way to prove a human saw the request and approved it. Anything that presents itself as consent in that environment is a fiction, so unlocking is available only where a real person can be shown a real prompt.

**3. Household roles, enforced server-side.** A house has more than one person in it, and the old answer was to hand over your password. There are five roles now, each stating in plain words at the moment you pick it what it can and cannot do:

- Somebody who lives there can control everything and approve unlocking a door.
- A guest can turn the lights on and **can never** approve unlocking anything, no matter what an agent asks them. That refusal is enforced on the server, so there is no version of any client that could offer them the button.
- A guest or viewer can be scoped to just the kitchen, or just three devices, and **the rooms you did not give them are removed from what they receive**, not hidden on screen. Their app never learns those rooms exist.
- Invitations work once, expire after a week, and can be withdrawn before anyone uses them.
- Removing somebody takes back every standing allowance they ever approved in the same instant, so a door cannot keep opening on the say-so of a person who has left.
- Every action in the home log is attributed to the person who took it, so "who did what" has a real answer.

**4. Voice, where consent is loosest.** Hands-free is the only interface that works when you are carrying groceries, and it is also the interface where a television in the next room can say "yeah". Confirming a physical action requires an intentional utterance, not an affirmative-sounding noise. This one took three rewrites and I still would not call it solved.

## Things I tried and did not ship

**Exposing the agent as a Matter device.** It is the obvious move, it would have been a good headline, and after measuring what it would actually cost and buy, I decided against it for now and published the reasoning rather than quietly dropping the thread. If someone here has done it and thinks I got the trade wrong, I would like to hear it.

**A cloud-first pairing flow.** The first version had the platform dial the house. It worked in my house and in almost nobody else's, for the reasons in the LAN section.

## The rest, briefly

- **A live 3D scene of your home** that the agent stands in, reacting to state as it changes. It is the reason to have a body at all: an agent that is *somewhere* in a house reads differently from a text box that mentions rooms.
- **A voice satellite face.** If you run an HA voice assistant, it can wear the agent's face instead of being a speaker grille.
- **Privacy as a page, not a policy.** See, export and delete everything a connected home stores, on one screen.
- **Honest status.** The status page can tell a dark house (yours is off, or asleep, or the internet is out at your end) from an actual outage on our side, and it says which. One unreachable home can no longer degrade the others, which was a real bug and a fair thing to be annoyed about.
- **Language and units.** The whole surface reads in your language, in your units, at a touch size that works on a wall tablet, and the wall display stays awake.
- **The car**, because it is the same design problem: a voice-first agent that can reach your house from the road, with an Android Auto app built and a CarPlay scene waiting on Apple's entitlement.

## What I would like from this forum

1. **Is the stdio refusal right, or is it paternalistic?** My reasoning is that a local server cannot prove consent. The counter-argument I keep hearing is that it is the user's own machine and their own choice. I have not been convinced yet, but I am listening.
2. **Roles.** Five felt like the smallest set that covers real households (residents, guests, house sitters, kids, view-only displays). If you run a household where those five break down, tell me where.
3. **What should an agent never be allowed to do, even for the owner?** My current list is short: nothing that unlocks without a proven human prompt, and nothing that silently changes another person's access. I suspect this list should be longer.

Everything is Apache-2.0. The integration is at [github.com/nirholas/three-ws-home-assistant](https://github.com/nirholas/three-ws-home-assistant), the MCP server is `@three-ws/home-mcp` on npm, the platform is at [three.ws/smart-home](https://three.ws/smart-home), and the docs (including the relay threat model and the Matter write-up) are at [three.ws/docs/smart-home](https://three.ws/docs/smart-home).

Happy to answer anything, including hostile questions about why a 3D avatar belongs anywhere near a house. That last one is fair and I have a real answer for it: a home has rooms and objects, and an assistant that can be *somewhere* in it is easier to talk to than one that cannot.
