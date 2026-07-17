# SEO keyword plan

Verified keyword landscape and content calendar for three.ws across its product clusters: 3D generation, AI agents/MCP, Solana/x402/crypto, and enterprise AI (watsonx/Granite). Built 2026-07-17 from a deep-research pass (24 sources fetched, 25 claims adversarially verified, 23 confirmed) plus a live audit of the IBM Community publishing surface. Every SERP observation is dated 2026-07-17; re-verify before acting on this doc more than a quarter later.

Related: [page-audit.md](./page-audit.md) covers on-site quality; this doc covers what to write and where to publish it.

---

## The two publishing surfaces

### three.ws (own domain)

331 indexable pages across 10 sections (crypto 113, learn 68, build 47, blog 31, main 29, others 43). The blog at `/blog` already carries partnership and feature posts. Every page gets a per-page OG card from `/api/page-og` (the `?v=carbon` variant renders an IBM-adjacent light card for content shared into IBM contexts).

### IBM Community user group

three.ws runs a user group at [community.ibm.com](https://community.ibm.com/community/user/usergroup?CommunityKey=e71510cc-d953-408f-9a1c-019f5c0a7016). Verified properties of its blog posts (live HTML audit, 2026-07-17):

- Outbound links carry `rel="noopener"` only: no `nofollow`, no `ugc`. They are ordinary editorial links.
- Posts get self-canonical, keyword-slugged URLs and are indexable (no `noindex`).
- The editor exposes Meta Title, Meta Description, Featured Image, Canonical Url, and Additional Meta fields per post.

### The authority-inheritance caveat (verified, load-bearing)

Do NOT plan around "publish on ibm.com, inherit DA 92." Two Google policies, both verified against Google's own documentation ([site reputation abuse](https://developers.google.com/search/blog/2024/11/site-reputation-abuse), effective 2024-11-19):

1. Third-party content published mainly to exploit a host's ranking signals is classified as spam, and no business arrangement (white-label, licensing, formal contributor status) exempts it.
2. Google runs systems that detect site sections independent from the host and measures them as standalone sites, so a community.ibm.com post does not automatically inherit ibm.com's domain-level authority.

What this means in practice: IBM Community posts are worth writing when they are genuinely on-topic for IBM's audience (watsonx, Granite, MCP, enterprise AI) and valuable independent of any ranking inheritance. The durable value channels are the referral audience, dofollow editorial links earned by genuinely useful content, SERP presence the post earns on its own merits, and AI-search citation (assistants cite ibm.com-hosted content heavily). Off-topic content (pump.fun, token launches, generic 3D marketing) does not belong there: it would be the exact pattern the spam policy targets, and it would burn the IBM partnership. Publish crypto-cluster content on three.ws/blog instead.

Cadence: one post per week maximum on IBM Community, tutorials only, each useful to an IBM developer who never clicks through to three.ws.

---

## Verified cluster landscape

Confidence labels are from the adversarial-verification pass (3-vote refutation panels per claim).

### 1. 3D generation (text-to-3D, image-to-3D, GLB)

- **Head terms are unwinnable.** "Text to 3D" is owned by Meshy: year-stamped title ("Free Text to 3D AI Generator 2026"), 10M+ claimed creators (~$30M ARR corroborated), and an on-page FAQ that captures the question-style long-tail (generation time, ownership, export formats, engine compatibility). Incumbents also defend "X vs Y" comparison SERPs with dedicated /compare/ pages. High confidence.
- **Winnable long-tails** are the queries Meshy's page does not serve: rigged/animation-ready avatars from text, embeddable 3D agents, free-no-account generation.
- **Unexamined:** Tripo, Luma, Spline SERPs and the image-to-3D cluster were not directly verified. Treat the 3D map as Meshy-centric and incomplete.

### 2. AI agents and MCP

- **"Build an MCP server" is anchored by modelcontextprotocol.io** (weather-server quickstart, Claude Desktop host, eight languages as tabs on one page). High confidence.
- **Two verified gaps:** (a) dedicated per-language tutorials; the SERP for "MCP server in Rust tutorial" is exclusively third-party blogs (shuttle.dev, oneuptime.com, dev.to), no official page; (b) use-case-differentiated tutorials (an MCP server for 3D generation, an MCP server with paid tools). three.ws ships real packages for both (`packages/ibm-watsonx-mcp`, `packages/x402-mcp`, `packages/avatar-agent-mcp`).
- High-DA educational publishers (freeCodeCamp, Baeldung) are actively entering the generic MCP tutorial space; the generic quickstart lane is closing.

### 3. Solana, x402, agent payments (strongest opportunity)

- **Definitional head terms are protocol-owned:** x402.org #1 and solana.com #2 for "what is x402", with Coinbase/Ledger/Crossmint/QuickNode/Cloudflare filling page one. Do not target definitional queries. High confidence.
- **The co-ranking tooling ecosystem is thin:** solana.com's own agentic-payments doc names pay.sh, Corbits, MCPay.tech, PayAI, ACK, and Google's A2A x402 as the ecosystem. That is a small enough set for tutorial and tooling content to rank. High confidence.
- **Citable adoption stats:** 35M+ Solana x402 transactions and $10M+ volume per solana.com (conservative floor; third parties report 45M+ Solana transactions and 165M/~$50M ecosystem-wide via Coinbase, April 2026). Medium confidence; pair the solana.com figure with the fresher third-party numbers and re-check before citing.
- **Unexamined:** pump.fun/token-launch and agent-wallet keyword clusters have no verified findings yet; Virtuals Protocol and ai16z/Eliza SERPs were never checked.

### 4. Enterprise AI (watsonx, Granite, Guardian)

- **IBM first-party content saturates Granite tutorial head terms** ("Granite agentic RAG", "Granite function calling"): developer.ibm.com tutorials plus official cookbooks hold multiple top-10 positions across four IBM properties. Two presumed gaps were REFUTED in verification: IBM already publishes MCP-with-Granite content, so "Granite + MCP" broadly is NOT open. High confidence.
- **The one verified open angle is host surface:** IBM's official MCP+watsonx tutorial (ranks #1 for its head query) demonstrates only Claude Desktop as the MCP host. Nothing IBM publishes covers embedding a watsonx/Granite-backed agent in a web page or a 3D embeddable agent. That is precisely three.ws's product. High confidence.
- **Guardian bridge:** Granite Guardian 4.1's documented agent-specific capabilities (function-calling hallucination detection, RAG/tool-call hallucination detection) make "agent guardrails" and "guardrails for MCP servers" legitimate extension topics; IBM's four Guardian cookbooks cover none of that applied angle. High confidence.

### Methodology note

No quantitative keyword data was collected (volumes, KD, CPC). Winnability here is inferred from SERP composition, which is the better signal anyway: Ahrefs KD is computed solely from referring-domain counts of the current top-10, so it understates difficulty against entrenched incumbents and overstates it on thin long-tails. When a SERP's top ten is third-party blog posts, that is the green light.

---

## Content calendar

Ordered by expected impact. "Host" is where the canonical piece lives. IBM Community posts must stand alone as useful to IBM developers; three.ws posts can sell harder.

| # | Piece (working title) | Target query cluster | Host | Why winnable (verified basis) |
|---|---|---|---|---|
| 1 | Text to 3D with AI: prompt to embeddable GLB, free, no account | "generate 3D model from text free no account", "embeddable 3D model" | IBM Community + cross-post summary on /blog | Long-tail Meshy's page does not serve; "free, no account" differentiator |
| 2 | Build an MCP server with paid tools (x402 agent payments) | "MCP server payments", "monetize MCP server", "x402 MCP" | three.ws /blog or docs tutorial | Use-case MCP gap plus thin x402 tooling SERP; we ship `packages/x402-mcp` |
| 3 | Embed a watsonx/Granite-backed agent in any web page | "embed watsonx agent website", "Granite web agent" | IBM Community | The one verified IBM content gap (host surface beyond Claude Desktop); perfectly on-topic for the host |
| 4 | Agent payments on Solana: x402 in production (with adoption numbers) | "x402 Solana", "agent payments Solana" | three.ws /blog | Thin co-ranking set (PayAI, Corbits, MCPay.tech); we run x402 rails in production |
| 5 | Granite Guardian for autonomous agents: allow, review, block | "agent guardrails", "function calling hallucination detection" | IBM Community | Extends (not duplicates) IBM's four Guardian cookbooks with the applied agent/MCP angle. BLOCKED until WATSONX_* env vars are set on Cloud Run and the /ibm showcase decision lands |
| 6 | MCP server in Rust (or Go): a complete walkthrough | "MCP server Rust tutorial", "MCP server Go example" | three.ws /blog or docs | Verified per-language gap; SERP is all third-party blogs today |
| 7 | Rigged, animation-ready avatars from a text prompt | "text to 3D avatar rigged", "animation-ready avatar generator" | three.ws /blog | Meshy FAQ territory ends at static models; rigging is our differentiator |
| 8 | Launch directory / pump.fun cluster piece | TBD | three.ws only, never IBM Community | Cluster unverified; research volumes first. Commit gate applies to any non-$THREE coin references |

Per-post mechanics (IBM Community): keyword front-loaded in the title (it becomes the slug), Meta Title/Description filled, Featured Image = `/api/page-og?v=carbon&...` card, Canonical blank for original posts, canonical to the three.ws original when syndicating. 3-5 deep links per post with descriptive anchors to the specific matching three.ws page.

---

## Open questions (from the research pass, unresolved)

1. Actual volumes/difficulty for the chosen long-tails; nothing tool-measured yet. Worth a Semrush/Ahrefs pull if we get access.
2. The unexamined competitor SERPs: Tripo/Luma/Spline (3D), ElevenLabs (embeddable agents), Virtuals/ai16z (Solana agent frameworks).
3. Whether IBM Community posts measurably rank today (i.e. whether Google's independent-section detection fires on community.ibm.com in practice). Test empirically: publish posts 1 and 3, track their SERP positions for their target queries over 4-6 weeks.
4. Conversion: does traffic from per-language MCP tutorials or x402 tooling queries reach product surfaces? Wire UTM params on deep links (`?utm_source=ibm-community`) so the answer is measurable.

## Verified sources (primary)

- https://www.meshy.ai/features/text-to-3d
- https://modelcontextprotocol.io/docs/develop/build-server
- https://solana.com/x402/what-is-x402
- https://solana.com/docs/payments/agentic-payments
- https://developer.ibm.com/tutorials/mcp-watsonx/
- https://developer.ibm.com/components/granite-models/tutorials/
- https://www.ibm.com/granite/docs/use-cases/all-cookbooks
- https://www.ibm.com/granite/docs/models/guardian
- https://github.com/ibm-granite/granite-guardian
- https://developers.google.com/search/blog/2024/11/site-reputation-abuse
- https://ahrefs.com/blog/keyword-difficulty/
