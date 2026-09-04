# NVIDIA Inception Capital Connect: the three.ws application

The Capital Connect form is what VCs read before they decide whether to ask for a meeting, so every field here is answered from something verifiable in this repo or in production. Nothing below is aspirational.

Portal: Inception Portal > Capital Connect > Inception Capital Connect Form.

## Field by field

| Form field | Answer | Where it comes from |
| --- | --- | --- |
| Funding Round | **Pre-Seed** | Owner, 2026-09-04. |
| Proposed Raise Amount | **Under $1M** | Owner, 2026-09-04. |
| Board Seat Allocation | **No board seat** | Standard for a sub-$1M pre-seed on a SAFE. Change to "Negotiable" only if you intend to offer one. |
| Term Sheet | **No** | No signed or circulated term sheet as of 2026-09-04. |
| Annual Recurring Revenue (ARR) | **Under $100K** | See "What counts as ARR" below. The pump.fun creator-fee revenue is real but it is not ARR. |
| Year-over-year growth rate | **Lowest band, and say "under a year old" on the call** | There is no year of data: `forge_creations` starts 2026-06-11. Month over month is the real story (August nearly doubled July). See "Growth" below. |
| Lead investor for this round | **No** | Confirm before submitting. Capital Connect is being used to find one. |
| Proposed funding close date | **Nov 30, 2026** | Placeholder, roughly 90 days out. Set it to your real target; VCs treat a date already in the past as a dead round. |
| Why are you raising capital? | See the block below (under the 1,000-character cap). | Written from the live product surface. |
| Summary slide deck (PDF, 15 slides max, under 5MB) | [`three-ws-inception-deck.pdf`](three-ws-inception-deck.pdf) | Built by `npm run deck:inception` from [`three-ws-inception-deck.html`](three-ws-inception-deck.html). |
| Two-business-day response commitment | **Check it** | Inbound VC mail lands on the founder inbox; Companion can triage it (`three.ws/companion`). |

## What counts as ARR

Roughly $400K in cumulative pump.fun creator-fee rewards is real money and it belongs in the deck, but it is not ARR, and a VC who catches it in the ARR box will discount everything else on the form. ARR means contracted, recurring, annualized revenue: subscriptions and committed contracts. Creator fees are transaction-derived, non-contracted, and correlated with token volume, so they are cumulative revenue, not recurring revenue.

Report it this way and you get credit for it without a credibility hit:

- **ARR field:** Under $100K.
- **Deck, traction slide:** the $400K sits beside the usage numbers, labelled non-recurring and volume-correlated in the same sentence. Saying it before a VC asks is worth more than the number is.
- **First VC call:** lead with the $400K as proof this audience pays, then pivot immediately to the twelve-week usage curve, because that is what the round actually compounds.

## Growth: what the database says

Answered from the production database on 2026-09-04, so nothing here needs guessing.

**There is no year-over-year number, because there is no year of data.** `forge_creations` starts 2026-06-11. The instrumented history is twelve weeks. Select the band that reflects the operating period, and open the first VC call by saying the product is under a year old rather than letting them discover it in diligence.

What the twelve weeks actually show:

| Month | Generations | Unique users | Paid (x402) |
| --- | --- | --- | --- |
| June 2026 (from the 11th) | 6,975 | 6,519 | 0 |
| July 2026 | 5,245 | 2,800 | 125 |
| August 2026 | 10,165 | 7,443 | 315 |
| September 2026 (first 4 days) | 3,350 | 2,706 | 0 |

- **25,735 generations and 19,412 unique users** since 2026-06-11.
- **August nearly doubled July** (5,245 to 10,165) after a July dip.
- **September is running at about 838 generations a day against August's 328 a day**, roughly 2.5x. The last eight days ran 600 to 1,400 a day.

Month over month is the honest growth story here, and it is a good one. Lead with it.

### Two numbers that must not go in the deck as revenue

1. **x402 agent payments total $64.20.** 428 settled paid generations all-time, at $0.15 each on the standard tier. The rail works end to end, which matters, but it is not a revenue line and the first VC to ask will find that out. The deck now says the rail is proven and early, which is true.
2. **The last paid x402 generation was 2026-08-31**, and the August 13 cluster fired at almost exactly 30-minute intervals, which reads like an automated caller rather than organic demand. Worth understanding before someone asks who those buyers are.

## Why are you raising capital? (form text, 1,000-character cap)

Paste this verbatim.

> three.ws turns one sentence into a rigged, animated 3D character that runs in any browser, then gives it an LLM brain, an on-chain identity, and a one-line embed. The generation pipeline is ours, not an API reseller's: eight self-hosted models on an NVIDIA L4 and RTX PRO 6000 fleet, plus auto-rig, retexture, restyle and remesh workers. It is live, open source under Apache-2.0, and already earning: a free tier, a pay-per-call agent API priced in USDC, and about $400K in cumulative on-chain creator-fee revenue.
>
> This pre-seed converts usage into contracted revenue. It funds three things: GPU capacity so a generation takes seconds at 100x today's volume; two engineers to ship the enterprise embed tier (SSO, SLA, private models, on-prem); and go-to-market for the developer and brand customers already asking. We want an investor who understands GPU infrastructure and developer platforms, not only consumer 3D.

## Deck outline (15 slides)

The built PDF follows this exactly. Every claim maps to a file or a live URL so nothing in it can be walked back in diligence.

1. **Title.** three.ws, give your AI a body. Pre-seed. Live at three.ws.
2. **The problem.** Every AI product is a text box. Embodiment is locked behind a 3D artist, a game engine, and a six-week pipeline.
3. **The insight.** The browser is already a 3D runtime. WebGL 2.0 plus glTF means no plugin, no install, no upload.
4. **The product.** Prompt to textured GLB in about 30 to 90 seconds, then rig, animate, embed, and give it a brain.
5. **Demo.** Forge, Scene Studio, the `<agent-3d>` embed, and the Companion desktop character, in one flow.
6. **The pipeline is the moat.** Eight self-hosted generation models on our own NVIDIA fleet, with health-checked failover lanes.
7. **NVIDIA stack.** L4 and RTX PRO 6000 on Cloud Run, cross-region GPU capacity routing, and a capacity tool that ports a service between regions in minutes.
8. **Distribution.** 795 public routes, 90 published npm packages, an MCP server in the public registry, and an x402-listed paid API.
9. **Open source as go-to-market.** Apache-2.0, the whole stack in one public repo, 1,351 test files, developer-first docs.
10. **Business model.** Free tier, pay-per-call agent API in USDC, creator-fee revenue, and the enterprise embed tier this round funds.
11. **Traction.** 19,412 unique users and 25,735 generations in twelve weeks, September running about 2.5x August's daily rate, plus the $400K in cumulative creator-fee revenue labelled honestly. Every figure measured from the production database on 2026-09-04.
12. **Market.** Every brand, game, and AI product that needs a face, plus the agent-to-agent economy paying per generation.
13. **Why now.** Generation quality crossed the usable line, browsers got fast enough, and agents acquired wallets.
14. **The ask.** Pre-seed under $1M. Use of funds is stated as a split: 45% GPU capacity, 35% two engineers, 20% go-to-market. Change those three numbers in the HTML if your plan differs; a VC will hold you to them.
15. **Team and contact.** Founder, what has shipped, and how to reach us.

## Editing the deck

The deck is HTML, not a slide binary, so it diffs in git and rebuilds in one command.

```sh
npm run deck:inception
```

Source: [`three-ws-inception-deck.html`](three-ws-inception-deck.html). One `<section class="slide">` per slide, 1280x720 (16:9), rendered to PDF with the Playwright already in this repo. The build script ([`scripts/build-inception-deck.mjs`](../../scripts/build-inception-deck.mjs)) refuses to write a deck that breaks a portal limit, so a bad edit fails at build time rather than at upload time:

- more than 15 slides,
- a PDF over 5MB,
- any slide whose content overflows its own 720px frame (the failure names the slide and the overflow in pixels).

## Before you submit

- [ ] Set a real close date, not the placeholder.
- [ ] Select the lowest year-over-year band and be ready to say the product is under a year old.
- [ ] Confirm lead investor and term sheet are still both "No".
- [ ] Build the deck: `npm run deck:inception`, then confirm the PDF is under 5MB and 15 pages.
- [ ] Read the deck once for anything confidential. NVIDIA distributes it to third-party VCs.
- [ ] Check the two-business-day response box.
