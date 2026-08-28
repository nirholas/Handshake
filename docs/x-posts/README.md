# X post drafts

Ready-to-paste X (Twitter) announcement copy and the video prompts that go with it. Internal
staging only: nothing here is posted automatically, and posting is owner-gated per
[`CLAUDE.md`](../../CLAUDE.md) (`git push` / publishing / posting to external channels needs
explicit approval). Each file states what it's for and what has already been verified true.

> **`@nichxbt` is suspended (reported 2026-08-27).** Nine of the drafts below pair a
> `@trythreews` post with a personal-voice quote tweet from `@nichxbt`, and that second half
> cannot be posted right now. Post the `@trythreews` half as written and hold the other one;
> do not move its copy onto the platform account. [`x-accounts.md`](../x-accounts.md) has the
> account status and the full rule.

## How these are written

- **Paste-ready, not outlines.** No placeholders, no "insert link here". Every link in a draft
  resolved when it was written. The one class that has since rotted is links into `@nichxbt`
  posts, which now serve X's suspension interstitial; check any `x.com/nichxbt/status/...` link
  before you paste a draft.
- **Character counts are measured, not guessed**, against X's rule that any URL counts as 23
  characters regardless of length. Where a draft states a count, it was computed.
- **Each file opens with a verified-claims block** and, where it matters, a "do not claim" list.
  That list is the useful part: it records what someone could disprove in ten minutes.
- **No em-dashes and no emoji**, matching the repo's writing rules.

## Product and infrastructure launches

| File | What it announces |
| --- | --- |
| [`onchain-agent-wallets-x-post.md`](onchain-agent-wallets-x-post.md) | Agent wallets with an on-chain spending allowance instead of a private key: SPL Token delegation, guardrails, x402, revocable custody |
| [`mcp-registry-fleet-x-post.md`](mcp-registry-fleet-x-post.md) | The fleet as a whole: 72 MCP servers under one namespace in the official registry, all current |
| [`metaplex-agent-mcp-launch.md`](metaplex-agent-mcp-launch.md) | The open-source agent infrastructure announcement covering `@three-ws/metaplex-agent-mcp` and `@three-ws/onchain-agent-wallets`, and why the integrations are bullish for $THREE |
| [`metaplex-agent-mcp-x-post.md`](metaplex-agent-mcp-x-post.md) | The MCP server that mints an agent into the Metaplex Agent Registry with its own wallet and EIP-8004 identity |
| [`metaplex-agent-deployer-x-post.md`](metaplex-agent-deployer-x-post.md) | The browser deployer at nirholas.github.io/metaplex-agent-mcp |
| [`3d-ar-studio-launch.md`](3d-ar-studio-launch.md) | 3D AR Studio, the AR studio extracted from three.ws and published as an open-source package |
| [`ar-quick-look-fix-x-post.md`](ar-quick-look-fix-x-post.md) | AR Forge and AR Studio now open real Apple Quick Look / Google Scene Viewer on a phone, matching what `/avatars/:id/ar` already did. Shipped to `main` locally, **not yet deployed**: do not post until verified live on a real iPhone |
| [`threews-avatar-launch.md`](threews-avatar-launch.md) | The three.ws avatar pipeline launch copy |
| [`oracle-trading-mcp-x-post.md`](oracle-trading-mcp-x-post.md) | The oracle trading MCP server launch |
| [`sperax-staking-in-chat-x-post.md`](sperax-staking-in-chat-x-post.md) | SperaxOS chat-native staking, balance, and buy-SPA tool calls. The embedded `/staking` page is not working yet: do not announce until the blockers in the file clear |
| [`news-archive-x-post.md`](news-archive-x-post.md) | The news archive |
| [`proof-of-life-x-post.md`](proof-of-life-x-post.md) | A shipping-evidence post for the platform account: what landed this week, with public verification links. Names nothing about the personal account |
| [`pumpfun-article-x-post.md`](pumpfun-article-x-post.md) | The pump.fun article |

## Video and narration scripts

| File | What it covers |
| --- | --- |
| [`metaplex-agent-mcp-veo-script.md`](metaplex-agent-mcp-veo-script.md) | Shot-by-shot Veo (image-to-video) prompts for the agent infrastructure clip, built from a three.ws 3D avatar as the reference frame |
| [`metaplex-agent-deployer-video-script.md`](metaplex-agent-deployer-video-script.md) | Spoken narration for the deployer clip |
| [`threews-avatar-video-script.md`](threews-avatar-video-script.md) | Shot list for the avatar clip |
| [`3d-ar-studio-video-script.md`](3d-ar-studio-video-script.md) | Narration and shot prompts for the AR Studio launch video |

## Events and community

| File | What it covers |
| --- | --- |
| [`osf-issue-reply.md`](osf-issue-reply.md) | The reply to Andrea Griffiths closing the loop on the Open Source Friday request (open-source-friday#254), in a Premium-length and a 280-character form |
| [`event-x-posts.md`](event-x-posts.md) | Event campaign copy, split by account (`@trythreews` institutional, `@nichxbt` personal) |
| [`x-meetup-posts.md`](x-meetup-posts.md) | The in-platform community meetup announcement |
| [`ibm-skillsbuild-x-post.md`](ibm-skillsbuild-x-post.md) | The IBM SkillsBuild badge |
| [`fomo-verified-x-post.md`](fomo-verified-x-post.md) | FOMO verification |

## Conventions

Posting is manual and owner-gated. **X delivery of the changelog is retired** (owner directive
2026-07-18): `scripts/changelog-x.mjs` still exists but no cron calls it, so nothing in this folder
is on an automated lane. Treat every file here as copy waiting for a human to send.

Not registered in `data/pages.json`, and doesn't need to be: `scripts/audit-docs.mjs` only checks
direct `docs/*.md` files for a page entry, not files under a `docs/` subdirectory, so a nested
folder like this one is the convention for internal drafts that shouldn't be crawlable. When a
draft moves in here from the top level, drop its slug from `UNPUBLISHED_DOCS` in that script: the
entry is dead once the file is no longer routed.
