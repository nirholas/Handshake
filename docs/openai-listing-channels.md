# OpenAI listing channels: every surface three.ws can be listed on

Every route to getting three.ws published on an OpenAI-owned surface, ranked by leverage, with the concrete blocker on each. Written 2026-08-17 after auditing the stalled Cookbook PR.

Related docs: [listings.md](./listings.md) (every listing across all vendors), [mcp.md](./mcp.md) (the hosted MCP server a plugin submission depends on), [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md) (the same kind of kit for NVIDIA).

---

## Summary: the Cookbook was the weakest of five channels, and we led with it

The Cookbook is a docs repo with no distribution guarantee. The **plugin directory** is a product listing inside ChatGPT and Codex with real installs. We have 37 MCP packages and a hosted OAuth 2.1 MCP server already shipping, which is the exact hard requirement most plugin submitters fail. That is the channel to lead with.

| Channel | Owner | Effort | What it gets us | Status |
|---|---|---|---|---|
| **Plugin directory** (ChatGPT + Codex) | OpenAI | Medium | A listed, installable product inside ChatGPT and Codex | Not submitted. We already meet the MCP prerequisite. |
| **Showcase Gallery** | OpenAI | Low | Editorial feature on openai.com | Not submitted. Open web form. |
| **Cookbook** | OpenAI | Done, then stalled | A docs page on cookbook.openai.com | PR [#2874](https://github.com/openai/openai-cookbook/pull/2874) open since 2026-07-21, currently unmergeable. |
| **Customer stories** | OpenAI | High | Case study on openai.com/stories | Sales-led. Needs usage numbers, not a form. |
| **Grove** | OpenAI | Low | $50k API credits, SF cohort | Wrong stage. Program is pre-idea to pre-seed. |

---

## 1. Plugin directory (the real opportunity)

On **2026-07-09 OpenAI migrated the App directory into the Plugin directory**, a single universal directory shared by ChatGPT and Codex. You publish once and appear in both. This replaced the app-submission flow OpenAI opened to third-party developers on 2025-12-17.

Docs: [developers.openai.com/plugins](https://developers.openai.com/plugins) · [submission guide](https://developers.openai.com/plugins/deploy/submission.md) · [MCP server review requirements](https://developers.openai.com/plugins/deploy/app-review.md) · [plugin guidelines](https://developers.openai.com/plugins/app-guidelines.md) · [submission errors](https://developers.openai.com/plugins/deploy/submission-errors.md)

### Why we are unusually well positioned

The gating requirement is a public, production MCP server. Most submitters have to build one. We already run it:

| Requirement | What we already have |
|---|---|
| Public MCP server | `https://three.ws/api/mcp`, Streamable HTTP, MCP `2025-06-18` ([mcp.md](./mcp.md)) |
| Auth | OAuth 2.1 end-user flow, with `api/mcp/.well-known/oauth-protected-resource` discovery already routed in `vercel.json` |
| Verified website | three.ws, live on Cloud Run behind the production LB |
| Privacy policy and terms | Live pages, already declared in `data/pages.json` |
| Well-scoped tools | 37 MCP packages under `packages/*-mcp`, plus `mcp-server/` and `mcp-bridge/` |
| Screenshots and UI | The avatar viewer and studio surfaces render inline already |

### Prerequisites before the form opens

1. **"Apps Management" write access** on the OpenAI Platform organization role. Without it the submission portal will not let you create a draft.
2. **Verified developer or business identity.** Every public submission requires it. Complete individual or business verification in organization settings first, because verification is its own review and will otherwise become the long pole.

### What the form asks for

Six sections: **Info** (name, short and long description, logo, category, URLs, publisher fields), **MCP** (server URL, authentication, domain verification, tool scanning), **Skills** (upload a bundle or import from the MCP server), **Prompts** (starter examples), **Testing**, **Global** (country availability). Plus release notes.

**The testing section is the one to budget for: at least five positive test cases and three negative ones.** Positive cases need a user prompt, expected behavior, result shape, and any required test data. Negative cases have to demonstrate an appropriate refusal or a safe fallback.

### Scoping decision: submit one plugin, not thirty-seven

The guidelines reject "overly generic single-word names unlinked to your brand" and reward apps that are "tightly scoped." Thirty-seven separate MCP servers submitted individually reads as directory spam and most would fail the tightly-scoped test on their own. Submit **one three.ws plugin whose tools are the text-to-3D and avatar pipeline**, which is the thing no one else in the directory does. The rest stay available as direct MCP connections documented in [mcp.md](./mcp.md).

### Known rejection reasons to design against

Trial or demo versions and incomplete functionality; missing or misleading tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint` must be set and accurate); unauthorized third-party integrations or API circumvention; deceptive commerce, which includes digital goods, subscriptions, and upsells; unauthorized data collection. Content must suit users 13 to 17.

Two of those need real attention in our case. **Tool annotations** must be audited across the submitted server, because generation tools that spend credits are not `readOnlyHint`. And **deceptive commerce**: the x402 payment path has to be transparently disclosed, never presented as free and then charged.

### Review flow

Submit, OpenAI reviews, they approve, then **you** publish, then it appears in the directory. It does not go live on approval. OpenAI's own wording is that "review timelines may vary as OpenAI builds and scales the review process," so treat the date as unknown and do not build a launch announcement around a specific week.

---

## 2. Showcase Gallery (lowest effort, do it this week)

Form: [openai.com/form/showcase-submission/](https://openai.com/form/showcase-submission/)

OpenAI's Showcase Gallery takes submissions of apps, demos, and **open-source projects** built with OpenAI models, APIs, or Codex, to be featured as inspiration for the developer community. three.ws qualifies on all three counts: it is open source, it is a live app, and `api/chat.js`, `api/vision.js`, `api/concierge.js`, `api/agent-ask.js`, and the TTS lanes all call OpenAI in production.

It is a plain web form with no repo gate, no CODEOWNERS review, and no merge conflict to lose to. Curation is still OpenAI's call, but the cost of asking is fifteen minutes. There is no reason this was not submitted before the Cookbook PR.

---

## 3. Cookbook: PR #2874 is fixable, but it is not the channel to bet on

[PR #2874](https://github.com/openai/openai-cookbook/pull/2874), "Add example: build a self-correcting 3D collectible set with three.ws text-to-3D, function calling, and vision," opened 2026-07-21. 1,903 additions across a notebook, six images, an SVG diagram, `registry.yaml`, and `authors.yaml`.

### Why it never landed

Four independent reasons, and the first is decisive:

1. **It has merge conflicts right now.** GitHub reports the PR as `CONFLICTING` / `DIRTY`. Nobody can merge it in this state regardless of how much they like it. The conflicts are in `registry.yaml` and `authors.yaml`, the two shared metadata files that **every** Cookbook PR touches, so any PR left open for weeks conflicts by default. This was self-inflicted by waiting rather than rebasing.

2. **No OpenAI reviewer has ever formally reviewed it.** `reviewDecision` is `REVIEW_REQUIRED` with zero reviews. The repo's `.github/CODEOWNERS` is one line: `* @openai/developer-experience`. Every file needs Developer Experience team approval. That gate landed in PR #2920 on 2026-08-05, and a mandatory `docs-editor` review gate landed in PR #2862 on 2026-07-17, four days before we opened. We submitted into a review regime that had just tightened.

3. **The `docs-editor` gate was not visibly satisfied.** `AGENTS.md` requires running the repo's `docs-editor` skill on every changed notebook markdown cell before merge, and resolving or explicitly documenting all remaining P0 and P1 findings in the PR. The thread resolves the Codex bot's findings thoroughly, and the bot's final verdict was clean, but the Codex bot is not the `docs-editor` gate. A reviewer scanning for that checklist does not find it.

4. **The repo does not promise merges.** `CONTRIBUTING.md` says, verbatim: "Contributions are reviewed on a best-effort basis - we can't provide guarantees around when or if content contributions will be reviewed or merged." There are 165 open PRs and the oldest dates to 2024-07-06. Of the last 60 merges, 35 came from OpenAI staff accounts, and most of the external ones are affiliated partners shipping vendor integrations.

### To revive it

In order: rebase onto `main` and resolve `registry.yaml` and `authors.yaml` by hand, taking both sides; re-run `python .github/scripts/check_notebooks.py`; run the `docs-editor` skill over every markdown cell and post the P0/P1 resolution list as a comment so the gate is visibly met; then leave it alone.

**One thing to stop doing.** The thread contains repeated @-mentions of individual OpenAI staff, an "I guess this will just fade into the abyss" comment, asking `@codex` to merge the PR three times, and a signoff of "Well i tried. GGWP OpenAI." That is a permanent public record on OpenAI's repo attached to our project name, and it is now the most visible three.ws artifact in OpenAI's GitHub org. It does not read as a maintainer's problem, it reads as ours. Rebase, post one clean status comment, and let the work carry it.

---

## 4. Customer stories: real, but not a form

[openai.com/business/customer-stories/](https://openai.com/business/customer-stories/) and [openai.com/stories/](https://openai.com/stories/) are editorial, sales-led, and curated. There is no self-serve submission. The path is a relationship with OpenAI's go-to-market team, and the currency is usage numbers plus a named outcome. Park this until the plugin listing is live and producing install and call volume worth citing, then it becomes a natural follow-on ask rather than a cold one.

The nearest self-serve adjacent surface is the [OpenAI Developer Community](https://community.openai.com) "Use cases and examples" category. No gate, indexed by search, and legitimate to post a build writeup to.

Two drafts are written and waiting for that surface: [openai-community-3d-studio-post.md](./openai-community-3d-studio-post.md) (the original Apps SDK plus Actions build writeup) and [openai-community-physical-world-post.md](./openai-community-physical-world-post.md) (the follow-up: the eleven keyless tools, the vision and simulation-readiness surfaces built on top of them, and the design rules for tools that spend money or move physical objects).

---

## 5. Grove: wrong stage, note it and move on

[Apply to OpenAI Grove](https://openai.com/index/openai-grove/). Five-week program at OpenAI's SF HQ, roughly fifteen participants per cohort, $50k in API credits, in-person sessions in the first and last week. Cohort 2 ran 2026-01-22 to 2026-02-27.

Explicitly aimed at "technical talent at the very start of their company-building journey" and "pre-idea individuals." three.ws is a shipping production platform with cloud marketplace listings, which is past the target stage. Worth watching for a cohort-3 call in case the criteria widen, but it is not a listing channel and should not consume effort.

---

## Non-OpenAI registries that actually merge

Not OpenAI-owned, so they do not answer the original question, but they are where MCP discovery genuinely happens and unlike the Cookbook they merge in days:

| Registry | Scale | Notes |
|---|---|---|
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | 89.6k stars | The reference MCP server list. The single highest-traffic MCP index. |
| [hashgraph-online/awesome-codex-plugins](https://github.com/hashgraph-online/awesome-codex-plugins) | 818 stars | Curated Codex and ChatGPT plugin list. Directly downstream of the plugin directory. |
| mcp.so | ~20k servers | Self-registration. |
| smithery.ai, glama.ai/mcp | Large | Form or self-registration. |

---

## Order of operations

1. Submit the **Showcase Gallery** form. Lowest cost, no gate, do it first.
2. Start **developer or business identity verification** on the OpenAI Platform, because it is a review that blocks the plugin submission and nothing else depends on us.
3. Audit tool annotations and x402 payment disclosure on the MCP server we intend to submit, then write the five positive and three negative test cases.
4. Submit the **plugin**.
5. **Rebase #2874**, post one clean status comment, stop pinging.
6. List on the MCP registries above in parallel. They cost minutes and do not depend on any OpenAI review.
