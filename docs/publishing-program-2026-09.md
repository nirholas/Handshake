---
title: "Publishing program, September 2026"
description: "The full venue matrix for the September 2026 writing push: eleven long-form drafts and eight short-form entries across developer, cloud, AI, 3D, home-automation and crypto communities, with each venue's own rules, the angle, the status, and the one action that unblocks it."
status: index. Every draft it lists is unposted and owner-gated.
---

# Publishing program, September 2026

Eleven long-form drafts and one short-form kit, written in this repo, covering the recent feature wave (smart home, Drive, Materialize, Knock, agent vitals, simulation readiness, the vision loop, the mobile shells) and every partner and listing status.

**Nothing here is posted.** Publishing to an external channel is owner-gated (CLAUDE.md, stop-and-ask gate 2), and the drafts that reference a crypto project other than $THREE additionally need approval before they can be committed. This page is the map, the running order, and the per-venue rules that the drafts were written against.

Two rules that apply to every entry, because both have burned publishing programs before:

- **Match the venue's register, not our own.** A forum post that reads like a launch announcement gets ignored at best. Every draft here opens with a specific technical claim and a link that backs it.
- **Never post the same body twice.** Cross-posting is done with a canonical link and a rewritten opening, never a copy.

---

## Long-form drafts

| # | Venue | Draft | Angle | Length | Unblocked by |
|---|---|---|---|---|---|
| 1 | OpenAI Developer Community | [openai-community-physical-world-post.md](./openai-community-physical-world-post.md) | The follow-up to the 3D Studio connector: tools that spend money or move matter, the vision loop, the 72-server fleet problem | ~5,650 words | Owner approval |
| 2 | AWS Builder Center | [aws-builder-center-agent-commerce-spine.md](./aws-builder-center-agent-commerce-spine.md) | The authorization spine for autonomous commerce: Concurrent Agreements, budgets instead of credentials, preflight, receipts, physical fulfillment | ~4,000 words | Owner approval |
| 3 | IBM Community (Three.ws User Group) | [ibm-community-governed-agents-post.md](./ibm-community-governed-agents-post.md) | Granite Guardian as an action veto once agents touch homes, cars and manufacturing, plus the full watsonx.ai surface and a build-it-yourself walkthrough | ~4,900 words | Owner approval |
| 4 | CoinMarketCap Community | [coinmarketcap-article-2026-09-agent-economy.md](./coinmarketcap-article-2026-09-agent-economy.md) | What an agent can actually buy now, with the on-chain and payment infrastructure behind it and the honest numbers | ~4,150 words | Owner approval, plus the other-coin commit gate |
| 5 | Home Assistant Community | [home-assistant-community-post.md](./home-assistant-community-post.md) | A HACS integration that dials out, an MCP server whose lock tools refuse over stdio, household roles enforced server-side | ~1,750 words | Owner approval |
| 6 | three.js Forum | [threejs-forum-post.md](./threejs-forum-post.md) | Five open-sourced pieces: retargeting with no rig allowlist, progressive GLB, glTF diffing, physics grade, terminal renderer | ~1,470 words | Owner approval |
| 7 | NVIDIA Developer Forums | [nvidia-forum-gpu-fleet-post.md](./nvidia-forum-gpu-fleet-post.md) | The production GPU fleet: cold weight loads, min-instances as a quota decision, keep-warm crons, chains with no empty rung | ~1,480 words | Owner approval |
| 8 | Hugging Face community article | [huggingface-agent-feedback-loop.md](./huggingface-agent-feedback-loop.md) | Closing the agentic-3D feedback loop: perceive, grade, diff, retarget, on open models | ~1,690 words | Owner approval |
| 9 | dev.to (canonical back to three.ws) | [devto-mcp-fleet-post.md](./devto-mcp-fleet-post.md) | 72 MCP servers, four traps, four rules, and the one change that mattered more than the fleet | ~1,290 words | Owner approval |
| 10 | Google Cloud Community | [google-cloud-community-post.md](./google-cloud-community-post.md) | One container, 115 scheduled jobs, a GPU fleet that sleeps, and three deploy gates each written the day after an outage | ~1,530 words | Owner approval |
| 11 | NVIDIA Developer Forums (already drafted, earlier) | [nvidia-forum-browser-digital-human.md](./nvidia-forum-browser-digital-human.md) | Audio2Face-3D streamed onto a rig the visitor generated ninety seconds ago | existing draft | Owner approval |

## Short-form entries

All in [short-form-venue-kit-2026-09.md](./short-form-venue-kit-2026-09.md), paste-ready with each venue's constraints applied:

| Venue | Entry | Constraint the copy was written against |
|---|---|---|
| Show HN | Free physics-readiness grade plus a CC0 spec | Title describes, never sells; the URL is the thing itself |
| Product Hunt | Materialize launch | 60-character tagline, ~260-character description, the maker comment carries the launch |
| r/homeassistant | The dial-out integration and the stdio refusal | Ends on a genuine open question |
| r/threejs | Pointer to the forum post, retargeting quoted in full | Community rewards the artifact, not the announcement |
| r/LocalLLaMA | Binaries an agent cannot read, and the fix | Generalised past 3D so it is useful to non-3D readers |
| r/3Dprinting | The free printability report | Leads with the free endpoint, discloses the paid lane |
| r/robotics | The four verdicts and a request for adversarial review | Asks for criticism, not clicks |
| LinkedIn | "The quarter our AI agents left the browser tab" | 900 words, no code, one link, preview-optimised opening |
| Alibaba Cloud developer community | Qwen as a first-class lane in a multi-provider router | Technical, tied to the existing marketplace listing |
| Khronos glTF discussion | Is a machine-readable simulability claim wanted at all | A discussion that accepts "no" as a useful answer |

---

## The running order

Sequencing matters because several of these link to each other, and because the venues with the slowest review should start first.

**Week 1, the ones with a review queue or a partner relationship.** AWS Builder Center (2), IBM Community (3), Hugging Face (8). Each is an account we already publish under, and each has an existing index page in this repo that must be updated with the canonical URL after publication.

**Week 1, same day as the others, the ones that are pure community goodwill.** three.js forum (6), Home Assistant (5). These are the two venues where the audience is most likely to become contributors, and neither has a queue.

**Week 2, the developer-audience posts.** OpenAI Developer Community (1), dev.to (9), NVIDIA (7), Google Cloud Community (10). Post 1 and 9 both discuss the MCP fleet, so they must not run on the same day and each needs its own opening.

**Week 2, gated separately.** CoinMarketCap (4), which needs the other-coin approval as well as the channel approval.

**Week 3, short-form.** Show HN, then Product Hunt on a Tuesday to Thursday, then the subreddits spread across separate days. Reddit is the only channel here where posting two of ours within a day looks like a campaign, which is exactly what it must not look like.

**No date pressure on the Khronos discussion.** It is a question, not a launch, and it should be opened when someone can watch the thread for a week.

---

## After each one lands

The same five steps every time, because a published article that nothing points at is half a publication:

1. **Record the canonical URL** in the venue's index page in this repo: [aws-builder-center.md](./aws-builder-center.md), [ibm-community.md](./ibm-community.md), [huggingface.md](./huggingface.md), [openai-listing-channels.md](./openai-listing-channels.md), or [listings.md](./listings.md) for a venue with no index of its own.
2. **Add the news item** to the curated feed so it becomes a page under `/news/<slug>` and enters RSS, which is also how it reaches HackerNoon (their import is automatic and needs no per-post action).
3. **Log a `data/changelog.json` entry** with the `docs` tag.
4. **Answer the thread.** Every draft here ends with a real question, and the value of these venues is in the replies rather than the post.
5. **Update the draft** if the discussion invalidates a claim. A draft that has been contradicted in public and left unedited in the repo is worse than no draft.

---

## Venues considered and not pursued yet

Written down so the next person does not re-derive it:

- **Medium as a primary venue.** Fine as a cross-post with a canonical link, weak as a destination. The former in-app push lanes for Dev.to and Medium were removed with the admin surface, so both are manual.
- **Stack Overflow.** No, in every form. Answering questions there is legitimate; publishing is not.
- **Blender Artists and the ComfyUI community.** Real fits (we ship a Blender addon and ComfyUI nodes) and both deserve their own drafts by someone who uses those tools daily. Writing a forum post about a tool you do not personally use is detectable in the first paragraph.
- **Solana ecosystem developer venues.** Worth a dedicated draft, gated behind the same other-coin approval as the CoinMarketCap piece.
- **A second CoinGecko listing update.** The existing dated notes cover it; nothing new to say until a listing state changes.
- **X threads.** Handled by the existing announcement flow, not by this program.

---

## Related

- [Syndication](./syndication.md): how the RSS feed reaches HackerNoon and any other subscriber, with no per-post action
- [Listings and distribution](./listings.md): every marketplace, directory and media partner with its per-listing status
- [Partner ecosystem](./partners.md): the eight partner programmes and the exact wording each one requires
- [Press kit](./press-kit.md): marks, boilerplate at four lengths, and the rules for both
