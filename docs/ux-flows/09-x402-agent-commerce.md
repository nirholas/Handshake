# x402 & Agent Commerce

UX Flow Atlas — cluster 09. Traced end-to-end from real source: page HTML, imported
JS modules, and backend API handlers. Routing is path-based via the `vercel.json`
route table (the live route/cron config the Cloud Run server reads); in dev the
`vite.config.js` `historyApiFallback` map mirrors it. Clean URLs resolve to
files under `pages/` or `public/`.

The cluster's spine is the **x402 pay-per-call** loop: hit a paid endpoint → get
`402 Payment Required` with `paymentRequirements` → pay (server-held agent wallet,
or the user's Phantom/MetaMask wallet via the shared `/x402.js` modal) → re-send the
request with an `X-PAYMENT` header → facilitator verifies + settles on-chain →
endpoint runs and returns the result. The "agent economy" demos wrap this loop in a
choreographed two-agent narrative driven by Server-Sent Events.

---

### Pay-per-call (x402) — `/pay`
- **Source:** `public/pay/index.html` (route → `public/pay/index.html`; inline module scripts hold all app logic), backend `api/x402-pay.js`, `api/mcp`, `api/x402-checkout`, `api/_lib/x402-bsc-direct.js`; agent wallet via `api/agents/[id]/solana`.
- **Entry point:** Chat-style page. Left = conversation + quick-tool chips + prompt input ("Pay & Run"); right = "x402 settlement timeline"; footer = live "recent paid calls" ticker. First visit shows a 3-step walkthrough overlay (dismissed → `localStorage x402:seen-walk`).
- **Prerequisites / gates:** No signup to use the **shared demo wallet** (platform-funded). Three payer modes: (a) **platform/agent server-payer** (default) — optional sign-in loads the user's own agents via `/api/x402-pay?agents=1` (401 → "Sign in" CTA, falls back to demo wallet); selecting an agent with no wallet opens the **generate-wallet overlay** (`POST /api/agents/{id}/solana`, or grind a vanity address at `/vanity-wallet`). (b) **Phantom** (Solana USDC, user signs). (c) **MetaMask/EVM** on the "BNB Chain" tab (user signs `approve` + `pay(bytes32)`). Wallet must hold ≥ $0.001 USDC for the chosen mode.
- **Steps (4 required + several optional):**
  1. (optional) Read/dismiss the "How this works" walkthrough overlay.
  2. (optional) Pick a payer: sign in and select an agent, generate/import its wallet, or select Phantom / MetaMask card; otherwise the shared demo wallet is used.
  3. Choose a tool: click a quick chip (`/list_tools`, `/validate DamagedHelmet.glb`, `/inspect`, `/optimize`, `/search_avatars`) **or** type a prompt (e.g. `validate https://…/model.glb`) and click **Pay & Run** / Enter. (Deep links `/pay?validate=<glb>`, `?inspect=`, `?optimize=`, `?list=1` auto-fire.)
  4. System POSTs `/api/x402-pay` (SSE) — timeline advances `challenge → built → verified → dispatched → settled`, each stage showing real ms timings and the settle tx prefix.
  5. On `result`: receipt rendered (amount, payment, durations), MCP output rendered in chat — `tools/list` lists tools, `inspect/validate/optimize` show JSON/cards, model-processing tools render an actual `<model-viewer>` GLB. Ticker bumps; balance + feed refresh.
- **Decision points / branches:** payer mode (server agent vs Phantom vs EVM — `run()` dispatches to `runPhantomPayment` / `runEvmPayment` / SSE path); agent has wallet vs not (gen overlay); prompt parse (`parsePrompt`) into a tool call; stream error vs `result` vs "stream ended without result".
- **External calls / dependencies:** `/api/x402-pay` (SSE payer + `?agents=1`, `?balance=1`, `?feed=1`, `/og`), `/api/mcp` (402 probe + dispatch), `/api/x402-checkout?action=prepare|encode`, `/api/agents/{id}/solana`, Solana mainnet RPC (`api.mainnet-beta.solana.com`), x402 facilitator (verify/settle), Solscan for tx links; BSC path uses `ThreeWSPayments` contract `0x…1B72Cc`.
- **Success state:** receipt card + rendered MCP result (incl. live 3D model), Solscan tx link, balance ticks down, feed prepends the call, page title shows elapsed ms.
- **Empty / error states:** not-signed-in → demo-wallet note; no agents → "Create your first agent"; agent has no wallet → gen overlay; `402`/network failure → timeline stage flips to error + `x402 call failed` / `Network error` message; stream ends without result → explicit error; wallet underfunded surfaces from server error.
- **Step count:** 4 required (+ ~4 optional).

### Paid-call permalink — `/pay/calls`
- **Source:** `public/pay/calls/index.html` (static share/OG view).
- **Entry point:** Shareable permalink for a single completed paid call (linked from the `/pay` ticker / OG image rendered by `/api/x402-pay/og`).
- **Prerequisites / gates:** None — read-only.
- **Steps (1):**
  1. Open the link → page renders the recorded call (tool, MCP result card, Solscan tx) and sets the document title/OG metadata for social preview.
- **Decision points / branches:** result renderer branches by tool (`tools/list`, `validate_model`, `inspect_model`, `optimize_model`, generic).
- **External calls / dependencies:** record payload (embedded / fetched), Solscan, `/api/x402-pay/og` for the share image.
- **Success state:** rendered call summary with explorer link.
- **Empty / error states:** missing record → falls back to generic card / JSON dump.
- **Step count:** 1 required.

### Hosted x402 checkout — `/pay/c/<slug>`
- **Source:** `public/pay/c/index.html` + `/x402.js`; backend `api/x402-skus.js`, `api/x402-checkout-record.js`.
- **Entry point:** Hosted checkout for a merchant-defined SKU (`/pay/c/<slug>`), branded with merchant + action name.
- **Prerequisites / gates:** A valid `?slug`/path slug resolving to a SKU; a wallet (Phantom/EVM) with USDC to pay.
- **Steps (3 required):**
  1. Page loads SKU via `/api/x402-skus?slug=…` and renders merchant/action; probes the target endpoint for its live `402` price + networks.
  2. User clicks pay → `window.X402.pay({ endpoint: sku.target_endpoint, … })` opens the shared modal (wallet connect + sign + settle).
  3. On success the page re-calls the endpoint with the payment and records the call via `/api/x402-checkout-record`; result shown.
- **Decision points / branches:** no slug → error; endpoint not returning 402 → "endpoint may have changed"; modal not loaded → error; Base vs Solana network.
- **External calls / dependencies:** `/api/x402-skus`, target merchant endpoint, `/x402.js` modal, `/api/x402-checkout-record`, Solana/Base settlement.
- **Success state:** payment settled + result rendered + call recorded.
- **Empty / error states:** missing slug, endpoint unreachable, non-402 response, modal load failure, payment cancel.
- **Step count:** 3 required.

---

### x402 Bazaar — `/bazaar`
- **Source:** `public/bazaar.html` + `public/bazaar.js` + `/x402.js`; backend `api/bazaar/list`, `api/bazaar/search`, `api/bazaar/context`.
- **Entry point:** Directory of live x402-paid endpoints (merged across facilitators) as a card grid with filters.
- **Prerequisites / gates:** None to browse; a wallet only when paying ("Try it").
- **Steps (5 required + 2 optional):**
  1. Page loads → `GET /api/bazaar/list` → renders endpoint cards.
  2. (optional) Filter by type (HTTP/MCP), network (EVM/Solana), max price, extension, sort.
  3. (optional) Search (`/api/bazaar/search?query=`) or scroll.
  4. Click a card action: HTTP → **Try it** (pay flow); MCP tool → **Inspect tool** (details only — JSON-RPC, not auto-callable); **Details** → modal + `/api/bazaar/context?resource=`.
  5. On **Try it**: `window.X402.pay({ endpoint, method, merchant, action, … })` opens the modal; pay → settle.
  6. Inline `.receipt` on the card shows status + on-chain tx + explorer link.
- **Decision points / branches:** HTTP vs MCP (MCP = inspect only); pay success/cancel/error → distinct receipt states; explorer chosen from endpoint network (Solscan/Basescan/Arbiscan/etc.).
- **External calls / dependencies:** `/api/bazaar/list|search|context`, `/x402.js`, merchant endpoint, multi-chain explorers.
- **Success state:** green receipt with tx hash + explorer link + result JSON; SR announcement "Payment succeeded for <service>".
- **Empty / error states:** no results → "No matching services…"; catalog unreachable → "Couldn't reach the catalog… Retry"; modal load fail → "Payment module failed to load"; cancel → receipt hidden; error → red receipt.
- **Step count:** 5 required (+2 optional).

### x402 Arbitrage — `/arbitrage`
- **Source:** `public/arbitrage.html` + `public/arbitrage.js` + `/x402.js` (loaded on-demand); backend `api/bazaar/arbitrage`.
- **Entry point:** Cross-provider price-disparity board — one card per capability, ranked providers, spread %.
- **Prerequisites / gates:** None to browse; wallet only to pay.
- **Steps (3 required + 3 optional):**
  1. Page loads → `GET /api/bazaar/arbitrage?minSpreadPct=0&limit=200` → skeleton then arb cards (spread %, up to 5 providers cheapest-first, metrics).
  2. (optional) Filter type All/HTTP/MCP; (optional) search by capability/host.
  3. Click **Pay cheapest · $X** → lazy-loads `/x402.js`, then `window.X402.pay({ endpoint: cheapest.resource, method:'GET', merchant: host, action: capability })`.
  4. Result shows on the button: "✓ Paid" (auto-revert 4s) / "Failed: …" / revert on cancel.
  5. (optional) Click **Avoid · $Y** → navigates to `/bazaar?q=<capability>` to see the full spectrum.
- **Decision points / branches:** MCP capability → "Pay" redirects to `/bazaar?q=` (can't call MCP directly); on-demand x402 load; button state management.
- **External calls / dependencies:** `/api/bazaar/arbitrage`, `/x402.js`, the cheapest live endpoint, Solscan/Basescan.
- **Success state:** "✓ Paid" on the cheapest provider; payment settled on-chain.
- **Empty / error states:** no opportunities → "No arbitrage opportunities right now…"; timeout (20s) → "Request timed out… Retry"; feed error → "Couldn't reach the arbitrage feed…"; modal fail → "Payment modal failed to load".
- **Step count:** 3 required (+3 optional).

### x402 Providers — `/providers`
- **Source:** `public/providers.html` + `public/providers.js`; backend `api/bazaar/providers`.
- **Entry point:** Two modes from one file — **directory** (`/providers`) and **profile** (`/providers?host=<host>`). No payment surface; navigation hub into `/bazaar`.
- **Prerequisites / gates:** None.
- **Steps (2 required + 3 optional):**
  1. Directory load → skeleton → `GET /api/bazaar/providers?limit=500` → provider cards (service count, median/min price, tags, networks).
  2. (optional) Sort (most services / cheapest / most expensive / most networks); (optional) search by host/tag.
  3. Click a card → `/providers?host=…` → profile fetch `GET /api/bazaar/providers?host=` → sidebar (metrics, "Visit site", "Open in catalog") + category/network charts + sorted services table.
  4. (optional) Click a listing row → `/bazaar?q=<service>`.
- **Decision points / branches:** directory vs profile keyed on `?host`; sort order; real-time search.
- **External calls / dependencies:** `/api/bazaar/providers` (list + single host), facilitator URLs, downstream explorers via `/bazaar`.
- **Success state:** cards / profile render and are navigable.
- **Empty / error states:** timeout (20s) + retry; directory unreachable; profile 404 → "Failed to load provider" + back link; no search matches; no tags message.
- **Step count:** 2 required (+3 optional).

---

### x402 Live Demo (IBM × three.ws) — `/ibm/x402-demo`
- **Source:** `pages/ibm/x402-demo.html` (self-hosted IBM Plex fonts) + `https://three.ws/x402.js` + `https://three.ws/agent-3d/latest/agent-3d.js`; backend `api/x402/forge.js` (forge-v2/models), `api/x402/symbol-availability.js`.
- **Entry point:** Marketing/live-demo page with 5 stacked sections — two **paid** (Forge, Symbol Check) and three **free/watch** (Agent, Play, IRL); each lazy-boots via IntersectionObserver.
- **Prerequisites / gates:** Free demos: none. Paid demos: MetaMask (Base) or Phantom (Solana) with mainnet USDC — Forge $0.05–$0.50 by tier, Symbol Check $0.001.
- **Steps (Forge: 5 required +1 optional; Symbol Check: 4 required):**
  1. (Forge) Enter a prompt (default "a brass steampunk owl, full body").
  2. Page fetches the live `402` challenge (`GET /api/x402/forge-v2/models?tier=draft`) and shows live price + networks + pay address.
  3. (optional) Pick tier Draft/Standard/High → price updates.
  4. Click **Pay $X & forge** → `window.X402.pay({ endpoint:'/api/x402/forge-v2/models?tier=…&prompt=…', method:'GET', … })` → wallet signs gasless USDC auth → settle.
  5. Endpoint returns a GLB → `<model-viewer>` renders it (orbit/download); the autonomous `<agent-3d>` below celebrates (`expressEmotion('celebration')` + `playEmote('cheer')`).
  - (Symbol Check) Enter ticker (default "GRANITE") → fetch `402` from `/api/x402/symbol-availability?ticker=` → **Pay $0.001 & run** → result panel shows availability pill + similar matches.
  - (Agent/Play/IRL) Scroll into view → 3D avatar auto-reacts / `/play` + `/irl` iframes lazy-load with "Full screen" / "Open on your phone".
- **Decision points / branches:** Forge vs Symbol Check (different endpoints/prices); paid vs free sections; agent reacts autonomously to settlement events; embeds load lazily.
- **External calls / dependencies:** `/api/x402/forge-v2/models`, `/api/x402/symbol-availability`, `/x402.js`, `/agent-3d/latest/agent-3d.js`, `/play`, `/irl` iframes, model-viewer bundle, Base/Solana settlement, explorers.
- **Success state:** Forge → GLB rendered + agent celebrates; Symbol Check → availability result + agent reacts; receipt with tx + explorer link.
- **Empty / error states:** offline → "live price will load when you reconnect"; insufficient balance → "Top up USDC… then try again"; 402 preview fail → "Payment button still works"; modal fail → reload prompt; cancel → result clears; embed timeout (15s) → "Open it in a new tab".
- **Step count:** Forge 5 required (+1 optional tier); Symbol Check 4 required; free sections auto-play.

---

### Endpoint Shopper — `/shopper`
- **Source:** `pages/shopper.html` + `src/shopper-app.js`; backend `api/agents/endpoint-shopper-run.js` (x402, $0.01 base + downstream budget) + the Bazaar registry.
- **Entry point:** "Endpoint Shopper" — describe a task, set a budget, watch an agent discover + chain + call x402 endpoints to answer.
- **Prerequisites / gates:** No auth. Non-empty task and budget ≥ $0.01 to enable **Run Task**; a wallet only if the run hits a `402` paywall.
- **Steps (5 required + 3 optional):**
  1. Enter a task in `#task-input` (or click an example chip).
  2. (optional) Adjust budget slider ($0.10–$2.00, default $0.50).
  3. Click **Run Task** → button "Running…", skeleton cards shown.
  4. `POST /api/agents/endpoint-shopper-run` with `{ task, maxCostUsd }` → agent emits a step trace: **discover** 🔍 → **plan** 🗺 → **call** ⚡ (per endpoint, with URL + USDC cost + snippet) → **synthesize** 🧠.
  5. Timeline renders all steps; **Total spent** row ("$0.00…" or "Free"); **Final Answer** card with synthesized text. Button re-enabled.
- **Decision points / branches:** empty task / budget < $0.01 → button disabled + hint; `402` → paywall card "Pay with Wallet" → `/paywall.html?req=…&return=/shopper`; `400`/`5xx`/network → error card + retry.
- **External calls / dependencies:** `/api/agents/endpoint-shopper-run`, downstream x402 endpoints discovered via the Bazaar, `/paywall.html`.
- **Success state:** full step timeline + final answer + total cost; ready for a new task.
- **Empty / error states:** initial skeleton/empty hint ("Enter a task…"); `402` warning card with CTA; red error card with retry; "Free (no paid calls executed)" if only free steps ran.
- **Step count:** 5 required (+3 optional).

### Fact Checker — `/fact-checker`
- **Source:** `pages/fact-checker.html` + `src/fact-checker-app.js`; backend `api/x402/fact-check.js` ($0.10, 7-day Redis cache).
- **Entry point:** Enter a claim, pick strictness, get a verdict + sources + cost breakdown + verifiable attestation.
- **Prerequisites / gates:** No auth. Non-empty claim ≤ 1000 chars; wallet only on `402`.
- **Steps (4 required + 3 optional):**
  1. Enter a claim in `#claim-input` (or click an example chip); live char counter.
  2. (optional) Pick strictness Low/Medium(default)/High.
  3. Click **Check This Fact** → validate → skeleton + "Searching sources…".
  4. `POST /api/x402/fact-check` with `{ claim, strictness }`.
  5. On `402` → payment panel (Base USDC $0.10 / Solana USDC $0.10) + "Connect wallet to pay →" (`/marketplace`). On `200` → verdict banner (SUPPORTED/CONTRADICTED/MIXED/INSUFFICIENT + confidence), sources grid (stance/authority), cost breakdown, expandable SHA-256 attestation.
- **Decision points / branches:** empty claim → no submit; `402` → payment panel; `429` → "Too many checks…"; `5xx` → internal-error message; retry button re-runs same claim. Cached result returns `200` instantly.
- **External calls / dependencies:** `/api/x402/fact-check` (3 search queries → multi-source retrieval → LLM stance → weighted verdict → attestation; optional vision for image evidence, fail-open), Base/Solana USDC, Redis cache (7-day TTL).
- **Success state:** verdict banner + sources + cost breakdown + attestation toggle.
- **Empty / error states:** initial example chips; skeleton loading; error card (title/msg/code + retry); payment panel with network badges.
- **Step count:** 4 required (+3 optional).

### Unstoppable Agent — `/unstoppable`
- **Source:** `pages/unstoppable.html` + `src/unstoppable-dashboard.js` + `/x402.js`; backend `api/agents/unstoppable-status.js` ($0.01 optional payment per live query).
- **Entry point:** A live dashboard of an autonomous agent that must earn to survive — balance, runway, status (RUNNING/CONSERVING/HALTED), activity feed, latest reflection.
- **Prerequisites / gates:** None to view (cached data from `localStorage unstoppable_last_reading`). To unlock **live** data, donate $0.01 USDC via x402; wallet needed only for the donation.
- **Steps (2 required + 1 recurring optional):**
  1. Load page → render cached data (or skeletons) → auto-poll `GET /api/agents/unstoppable-status` immediately, then every 60s (exponential backoff to 5 min on transient errors).
  2. View data: `200` → hero balance + status + runway, 24h earnings/costs, lifetime net, activity feed (THINK/EARN/REFLECT/IDLE/…), latest reflection. `402` → payment notice + cached data + "Unlock live data — $0.01".
  3. (optional, repeatable) Click **Donate $0.01** → `window.X402.pay({ endpoint: status, method:'GET', action:'Fund the … runway' })` → on success toast + fresh live data; each donation funds one live query and directly funds the agent.
- **Decision points / branches:** cache present vs not; `200` (unlocked) vs `402` (paywalled); `5xx` → backoff + keep cache; donation low-balance → retry with link to `/pay`; donation cancel → no charge.
- **External calls / dependencies:** `/api/agents/unstoppable-status` (free 402 challenge + optional paid query), `/x402.js`, Base/Solana settlement.
- **Success state:** live hero + stats + non-empty activity feed + reflection + "Updated X ago".
- **Empty / error states:** initial skeleton "Fetching live data…"; `402` notice with cached data; no-cache `402` → zeroed state ("Pay $0.01 to see live data").
- **Step count:** 2 required (+1 recurring optional donation).

### Pay-As-You-Learn Tutor — `/tutor`
- **Source:** `public/tutor.html` + `public/tutor.js` + `/x402.js`; backend `api/x402/tutor.js` ($0.01/question) + `api/tutor/session.js` (free resume).
- **Entry point:** Chat tutor that charges per answer; session total accrues; "End & invoice" produces an itemized, attested invoice.
- **Prerequisites / gates:** No auth. Session id auto-minted to `localStorage three-tutor-session-id`. Wallet connect happens lazily on the first paid question. Question 5–2000 chars.
- **Steps (4 required + 4 optional):**
  1. (optional) Click a suggestion chip, or type a question in `#q` (live char counter).
  2. (optional) Pick expertise level Beginner/Intermediate(default)/Expert.
  3. Click send (or Cmd+Enter) → spinner; question added to thread.
  4. `window.X402.pay({ endpoint:'/api/x402/tutor', body:{ sessionId, question, level }, merchant:'three.ws Tutor', action:'Explain' })`; first time → paywall modal connect + sign + settle.
  5. On success → tutor bubble with answer + key points + example + follow-up; meta row (cost · level · model); session tab updates total + answer count.
  6. (optional) Click a follow-up suggestion to ask again (cost stacks). (optional) **End & invoice** → modal with per-question line items, running total, SHA-256 session attestation.
- **Decision points / branches:** < 5 chars → ignored; `X402.pay` not ready (6s) → error + retry; payment cancel → "no charge"; payment fail → retry; reload → session resumed via `localStorage` + free `GET /api/tutor/session`.
- **External calls / dependencies:** `/api/x402/tutor` (per-question charge, server-side session accrual + attestation), `/api/tutor/session` (resume), `/x402.js`, Base/Solana settlement.
- **Success state:** stacked Q&A thread, session total + count, invoice with attestation.
- **Empty / error states:** initial title + 4 suggestion chips; spinner loading; error bubble in thread; invoice modal on demand.
- **Step count:** 4 required (+4 optional).

### Forever (etch a message into Bitcoin) — `/forever`
- **Source:** `public/forever.html` + `public/forever.js`; backend `api/forever/inscribe.js` (creates a real OrdinalsBot Taproot text inscription on Bitcoin **mainnet**) + `api/forever/status.js` (polling).
- **Entry point:** Compose a message → pay Bitcoin → it's inscribed onto a single satoshi, permanently. NOT an x402/USDC flow — payment is native BTC to a generated charge address (Lightning invoice offered too).
- **Prerequisites / gates:** No auth. Message 1–1500 bytes UTF-8. Optional Taproot (`bc1p…`) receive address (else platform vault `BTC_INSCRIPTION_RECEIVE_ADDRESS`). Fee rate 3/8/20/50 sats/vB. **User must hold BTC in their own wallet** — a confirm dialog shows the estimated cost before the order is created.
- **Steps (6 required + 6 optional):**
  1. Type the message (live char + byte counters; orange warning > 1500 bytes).
  2. (optional) Enter a Taproot receive address.
  3. (optional) Select fee rate → live fee estimate (`#feeEstimate`) with sats / BTC / ≈USD (CoinGecko best-effort).
  4. Click **Inscribe forever** → native `confirm()` showing estimated BTC cost + address ("payment is final once broadcast. Continue?").
  5. `POST /api/forever/inscribe` `{ message, receiveAddress, feeRate }` → creates OrdinalsBot order → returns charge address, amount (sats), Lightning invoice, mempool URL; order persisted to `sessionStorage forever:order` → **pay view**.
  6. Pay view: QR (BIP-21), amount, pay-to/Lightning/receive/order-id rows, "Open in wallet" / "View on mempool" / "Cancel". User sends BTC from their own wallet.
  7. Auto-poll `GET /api/forever/status?id=<orderId>` every 6s → `waiting-payment → payment-received → inscribing → inscribed`.
  8. On `inscribed` → **win view**: large message, Inscription link (ordinals.com), reveal-tx link (mempool.space), receive address, "Bitcoin mainnet"; share to X / copy permalink / inscribe another.
- **Decision points / branches:** empty / > 1500 bytes / invalid Taproot / invalid fee rate → inline errors; confirm-dialog cancel → stays in compose; order-create `502/503` → "Inscription failed. Try again."; status `failed` → OrdinalsBot contact note; reload mid-payment → `resumeIfAny()` restores the pay view + resumes polling.
- **External calls / dependencies:** `/api/forever/inscribe` + `/api/forever/status` → **OrdinalsBot** (`api.ordinalsbot.com`, Bitcoin mainnet Taproot inscription), CoinGecko (USD, best-effort), QR server, mempool.space + ordinals.com for verification.
- **Success state:** win view with permanent inscription + reveal-tx links + share buttons.
- **Empty / error states:** compose validation errors; inscribe failure banner; pay-view polling states; order `failed` message with support info.
- **Step count:** 6 required (+6 optional).

---

### Agent Exchange — `/agent-exchange`
- **Source:** `pages/agent-exchange.html` + `src/agent-exchange.js`; backend `api/x402-pay.js` (SSE payer), `api/x402/crypto-intel.js` (the paid endpoint).
- **Entry point:** Two 3D avatars (Intel Agent seller, Buyer Agent) face off; topic chips (SOL/BTC/ETH/DOGE/BNB) + **Buy intel — $0.01 USDC** + on-chain transaction feed. Real USDC settles per buy.
- **Prerequisites / gates:** No user auth/wallet. Server-side agent wallet (`X402_AGENT_SOLANA_SECRET_BASE58`) must be funded ≥ $0.01; pre-flight `checkWallet()` (`/api/x402-pay?balance=1`) disables the pay button if unconfigured/underfunded.
- **Steps (2 required; rest auto):**
  1. **[auto]** Avatars load + greet (scripted speech via postMessage).
  2. **[user]** Select a topic chip (default SOL) → buyer agent reacts.
  3. **[user]** Click **Buy intel — $0.01 USDC** → button "Paying…".
  4. **[auto SSE from `/api/x402-pay`]** six narrated stages: `challenge → built → verified → dispatched → settled → done`, each with stage chip + agent animation + narration.
  5. **[auto]** Receipt card (Confirmed on-chain · amount, payer/payee, Solana mainnet, Solscan tx, headline + signal badge + 24h change); session total flashes. Bubbles auto-hide ~5.5s. Repeat with a new topic.
- **Decision points / branches:** topic selection feeds the intel request; wallet pre-flight gate; SSE `error`/timeout (30s) → stage error + red receipt + reset + retry.
- **External calls / dependencies:** `/api/x402-pay` (POST SSE, tool `crypto_intel`, endpoint `/api/x402/crypto-intel`), `/api/x402-pay?balance=1`, `/api/x402/crypto-intel`, Solana RPC settlement, Solscan.
- **Success state:** all 6 stages + receipt with on-chain tx + agents celebrate + session total increments.
- **Empty / error states:** "Demo wallet not configured" (button disabled), "Agent wallet low on USDC" + fund address, timeout/SSE error with "No funds were moved", initial narration describing the flow.
- **Step count:** 2 required (auto SSE pipeline thereafter).

### Agent Commerce — `/agent-trade`
- **Source:** `pages/agent-trade.html` + `src/agent-trade.js`; backend `api/agent-trade/demo` (SSE), guarded by `api/_lib/agent-trade-guards.js`.
- **Entry point:** Three.js scene with two geometric agents (Nexus buyer, Oracle seller) on platforms; topic dropdown + **▶ Run Trade Demo**; central card + step log. Cinematic camera, particle beam, burst on confirm.
- **Prerequisites / gates:** No user auth. Server agent keypairs `AGENT_BUYER_SECRET` + `AGENT_SELLER_SECRET` (+ `AGENT_TRADE_PRICE_SOL`, `AGENT_TRADE_NETWORK`) must be configured + funded. Pre-flight `checkConfig()` (`/api/agent-trade/demo?check=1`); if unconfigured → modal overlay walkthrough + env instructions, Run disabled.
- **Steps (2 required; rest auto):**
  1. **[user]** Select a topic from the dropdown.
  2. **[user]** Click **▶ Run Trade Demo** → "⏳ Running…".
  3. **[auto SSE `/api/agent-trade/demo?topic=`]** ordered events with choreography: `init` (addresses/balances, camera fly) → `request` (buyer asks) → `challenged` (402 card, SOL price) → `paying` (particle beam buyer→seller) → `confirmed` (burst, Solscan tx card, balance debited) → `delivering` ("Analyzing with <model>…") → `delivered` (final analysis card + model + tx link).
  4. Button re-enabled ("Run again"); idle animation resumes.
- **Decision points / branches:** topic feeds the request payload; config gate (dismiss only hides overlay); `error` event → red chip + toast + retry; 35s safety timeout closes the stream.
- **External calls / dependencies:** `/api/agent-trade/demo` (`?check=1` + `?topic=` SSE), real SOL settlement on Solana mainnet/devnet, AI model inference for the delivered analysis, Solscan.
- **Success state:** all 7 SSE stages + final delivered-skill card with model-generated content + on-chain tx.
- **Empty / error states:** not-configured modal overlay; stream error toast + retry; timeout auto-finish; idle empty scene.
- **Step count:** 2 required (auto SSE thereafter).

### Agent Economy (Live) — `/agent-economy`
- **Source:** `pages/agent-economy.html` + `src/agent-economy.js`; backend `api/agent-economy/status` + `api/agent-economy/transact`.
- **Entry point:** Three-column layout — buyer Nova (3D iframe) | service catalog + transaction feed | seller Oracle (3D iframe). Catalog: Market Analysis ($0.001), On-Chain Insight ($0.002), Risk Score ($0.003) + optional topic input.
- **Prerequisites / gates:** No user auth. Server wallet (`AVATAR_WALLET_SECRET`) must be configured + funded; `refreshWalletStatus()` (`/api/agent-economy/status`) on init + after each trade shows fund alert / pause banner.
- **Steps (2 required + 1 optional; rest auto):**
  1. **[auto]** Avatars load + greet.
  2. **[user]** Select a service button.
  3. **[user, optional]** Enter a topic (≤120 chars).
  4. **[auto]** Buyer Nova requests + pays (column flash, feed item 📡), `POST /api/agent-economy/transact { service, topic }`.
  5. **[auto ~900ms]** Oracle "receives" — payment particle buyer→seller, feed item 💸 with receipt + Solscan link; balances refresh.
  6. **[auto ~400ms]** Oracle delivers (speech via LLM, feed item ✅ with content). Status "Transaction complete". Repeat.
- **Decision points / branches:** service price tier; optional topic; wallet states — `wallet_unconfigured` ("Live transactions paused"), `insufficient_balance` ("Not enough funds" + Add funds), `no_recipient`, generic error.
- **External calls / dependencies:** `/api/agent-economy/status`, `/api/agent-economy/transact`, Solana RPC settlement, LLM for buyer/seller speech, `/a-embed` avatar iframes (postMessage), Solscan.
- **Success state:** 3 feed items (request / payment+receipt / delivery) + updated balances + ready for next service.
- **Empty / error states:** unconfigured pause; underfunded fund banner + "Add funds"; network error feed item; initial empty feed ("Pick a service above…").
- **Step count:** 2 required (+1 optional topic; auto orchestration thereafter).

### Agent Economy — NOVA & ORACLE — `/demo`
- **Source:** `pages/demo-economy.html` + `src/demo-economy.js`; backend `api/demo-economy` (SSE).
- **Entry point:** Single Three.js scene — NOVA (blue) + ORACLE (gold) on platforms with a TV screen between them; **Run demo** button; sidebar wallet chips + payment details + activity log.
- **Prerequisites / gates:** No user auth. Server agents configured + funded for live settlement; no pre-flight overlay — the stream emits error/demo_mode events if not configured. Unsigned-in/anonymous users get a **simulated** payment path.
- **Steps (1 required; rest auto):**
  1. **[auto]** Idle scene renders (TV idle, particles, auto-rotate, wallet chips).
  2. **[user]** Click **Run demo** → "Running…", log cleared, scene reset.
  3. **[auto SSE `/api/demo-economy`]** typed events: `step` (e.g. agents_ready → camera fly) → `bazaar` (TV draws x402 service list) → `wallet` (chips updated) → `payment` (pay card; SOL amount; signature link or "SIMULATED" badge; mobile sheet slides up) → `content` (TV draws ORACLE market briefing with pools) → `done`.
  4. Button re-enabled ("Run again").
- **Decision points / branches:** configured+funded vs underfunded (error w/ fund notice) vs not-configured (error, prompts anon to sign in); `simulated=true` → "Simulated payment — sign in for live" + sim row. 35s hard timeout.
- **External calls / dependencies:** `/api/demo-economy` (SSE), Solana RPC settlement (if live), market-data source, Solscan.
- **Success state:** TV shows final briefing with markets + prices + 24h changes; full activity log; "Run again".
- **Empty / error states:** not-configured error; underfunded fund notice; simulated mode; initial idle scene with "not configured" wallet chips.
- **Step count:** 1 required (auto SSE thereafter).

### Agent Economy — Live — `/live`
- **Source:** `pages/live.html` (inline module) + `src/live-economy.js`; backend `api/demo/economy` (`?status=1` + `?trade=1` SSE) + `api/chat` (LLM dialogue).
- **Entry point:** Full-screen Three.js scene — Oracle + Trader on pedestals + TV; CSS-overlaid name tags, balance chips, speech bubbles, HUD with **▶ Agent Trader pays Oracle for Solana market data** + event log. Agents speak LLM-generated lines.
- **Prerequisites / gates:** Viewing is open; the **live trade** stream `/api/demo/economy?trade=1` is **auth-gated** — anonymous users get a "Sign in to run a live on-chain trade" notice. Server agents must be configured + funded. `refreshStatus()` polls `?status=1` every 10s.
- **Steps (1 required; rest auto + LLM):**
  1. **[auto]** Scene renders; Oracle greets (~3s, LLM via `/api/chat`), Trader greets (~5.5s).
  2. **[user]** Click the trade button → "⏳ Trade in progress…", Trader waves + LLM intro line.
  3. **[auto SSE `?trade=1`]** events: `thinking` → (`demo_mode` if unsigned/unconfigured → "No real payment in demo mode") → `paying` (beam Trader→Oracle + LLM line) → `paid` (white flash, Oracle pedestal flash, balances refresh, Solscan log link, LLM lines) → `fetching` → `delivering` (TV draws market grid, reverse beam, LLM lines) → `done`.
  4. Button re-enabled ("▶ Run Another Trade"). 45s hard timeout.
- **Decision points / branches:** signed-in + funded (live SOL) vs not-configured/underfunded (`error` with fund address + Copy/View/Retry) vs anonymous (`error` → "Sign in" notice) vs `demo_mode` (data only, no payment).
- **External calls / dependencies:** `/api/chat` (LLM), `/api/demo/economy?status=1` (poll) + `?trade=1` (auth-gated SSE), Solana RPC settlement, market-data source, `/avatar-embed.html` iframes (postMessage), Solscan.
- **Success state:** paid + delivered, TV market grid, log with Solscan link, balances updated, "Run Another Trade".
- **Empty / error states:** not-signed-in notice; underfunded fund notice; stream interrupted; demo-mode (no real SOL); initial idle TV + greetings.
- **Step count:** 1 required (auto SSE + LLM thereafter).

---

### Sniper Arena — `/play/arena`
- **Source:** `pages/play/arena.html` + `src/play/arena.js`; backend `api/sniper/leaderboard`, `api/sniper/stream` (SSE), `api/sniper/trader`, `api/oracle/agent-stats`.
- **Entry point:** A 3D world where **autonomous** AI agents trade real pump.fun tokens on Solana mainnet, live. Left = live leaderboard; right = live trade tape; bottom = movement hints. **No x402 micropayments here** — agents have pre-funded wallets and trade autonomously.
- **Prerequisites / gates:** None to watch. Picking an avatar is local (`localStorage arena:avatar:v1`), no payment. Agents trade with their own funded Solana wallets.
- **Steps (4 required + 3 optional):**
  1. **[auto]** Page boots `ArenaWorld` (Three.js 60fps), loads animation manifest + default avatar GLB, fetches `/api/sniper/leaderboard?network=mainnet`, opens SSE `/api/sniper/stream`.
  2. **[auto]** Agents spawn (deterministic avatar by `agent_id` hash, arc formation, floating DOM labels with rank/name/P&L).
  3. **[auto/live]** SSE `buy`/`sell`/`update` events → agent emotes + particle burst, trade tape prepends (BUY/SELL ▲▼, symbol, Solscan link), big-win banner, board refresh.
  4. **[user, optional]** **Choose your avatar** → modal → select → spawn player (saved to localStorage).
  5. **[user, optional]** Move with WASD / drag look / scroll zoom / touch joystick.
  6. **[user, optional]** Click an agent label → camera focus + right drawer profile (equity sparkline, stats grid, recent closed trades with on-chain proof, Oracle conviction section) → **Full proof & copy ↗** → `/trader/<agent_id>` new tab.
- **Decision points / branches:** fully autonomous trading — user only watches/moves/inspects; SSE vs periodic board refresh; avatar selection local; focus/unfocus; big-win banner threshold (≥0.4◎ or ≥100%).
- **External calls / dependencies:** `/api/sniper/leaderboard`, `/api/sniper/stream` (SSE), `/api/sniper/trader`, `/api/oracle/agent-stats`, `/animations/manifest.json`, avatar GLBs, Solscan, `/trader/<id>`. Solana mainnet (real pump.fun trades).
- **Success state:** agents render + leaderboard + live tape; user can move + inspect; real trades animate in real time.
- **Empty / error states:** no live agents → "No agents are live yet… arm a trader and enter"; SSE drop → "Reconnecting…" (retry 2.5s); board fetch fail → keep last good; drawer fail → "Couldn't load this trader"; avatar load fail → mono-initial tile.
- **Step count:** 4 required (auto boot) + 3 optional (avatar, move, inspect).

### Agent Exchange (feature page) — `/features/agent-exchange`
- **Source:** `pages/features/agent-exchange.html` (static marketing landing; `/nav.js` + `/footer.js`).
- **Entry point:** Static feature page explaining the Agent Exchange concept. NOT a demo — it links to the live demo at `/agent-exchange`.
- **Prerequisites / gates:** None.
- **Steps (1 required):**
  1. Read the page (hero, "How it works" 3-step, highlights, FAQ).
  2. (optional) Click **Watch live →** (`/agent-exchange`) to run the real demo, or **All features** (`/features`).
- **Decision points / branches:** none (static).
- **External calls / dependencies:** none beyond nav/footer includes.
- **Success state:** user navigates to the live `/agent-exchange` demo.
- **Empty / error states:** none (static content).
- **Step count:** 1 required (+1 optional CTA).

---

## Notes

- **Routing:** all clean URLs resolve through the `vercel.json` route table — read directly by the Cloud Run server (`server/index.mjs`) in production and mirrored by the `vite.config.js` `historyApiFallback` map in dev. `/pay`, `/bazaar`, `/arbitrage`, `/providers`, `/forever`, `/tutor` live under `public/`; the rest under `pages/`.
- **Shared payment modal:** `/x402.js` (`public/x402.js`, ~1.5k LOC) is the drop-in `window.X402.pay()` modal used by `/pay/c`, `/bazaar`, `/arbitrage`, `/ibm/x402-demo`, `/shopper` (paywall), `/fact-checker`, `/unstoppable`, `/tutor`. It handles wallet connect (Phantom/Solana, MetaMask/Base via EIP-3009), the 402→sign→retry loop, and SIWX re-entry.
- **Server-payer vs user-payer:** the "agent economy" narratives (`/agent-exchange`, `/agent-trade`, `/agent-economy`, `/demo`, `/live`) pay from **server-held agent wallets** and stream the choreography over SSE — the user only triggers/selects, then watches. The "showcase" apps (`/shopper`, `/fact-checker`, `/tutor`, `/bazaar`, `/arbitrage`, `/ibm`) make the **user** pay via the `/x402.js` modal.
- **Auto-play demos:** `/agent-exchange`, `/agent-trade`, `/agent-economy`, `/demo` need one user click to start, then auto-play. `/live` adds an auth gate for real settlement. `/play/arena` is fully autonomous (agents trade themselves; user only watches/moves/inspects) and uses **no x402** — real pre-funded Solana trades.
- **Forever** is the only **non-x402** payment in the cluster: native Bitcoin (or Lightning) to an OrdinalsBot charge address, inscribing a real Taproot text inscription on Bitcoin mainnet.
- **Source coverage:** all 17 routes located and traced from real source. `/tutor` resolves to `public/tutor.html` + `public/tutor.js` (served statically; no explicit vite map entry needed). No source was missing.
