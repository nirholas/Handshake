# Marketplace & Skills

UX Flow Atlas, cluster 6. Traced against real source in `/workspaces/three.ws`. The marketplace is a path + query-param SPA served by one HTML shell (`marketplace.html`) driven by `src/marketplace.js` (8.9k lines). `/skills` is a redirect into that SPA. `/collection` and `/marketplace/analytics` are standalone pages. The critical path (browse → buy → unlock → collection) spans two purchase endpoints (`/api/marketplace/purchase` for individual skills, `/api/marketplace/buy-asset` for whole avatars/agents/plugins), both Solana-Pay-by-reference with optional gasless sponsorship and an EVM/USDC fallback.

Routing facts confirmed in `vercel.json` (line numbers shift too often to pin; grep the route `src` instead):
- `/marketplace`, `/marketplace/` → `/marketplace.html`
- `/marketplace/(tools|skills|animations|onchain)/:id` → `/marketplace.html` (SPA handles detail)
- `/marketplace/agents/:id` → **301 redirect to `/agents/:id`** (canonical agent page)
- `/marketplace/avatars/:id` → **301 redirect to `/avatars/:id`**
- `/marketplace/analytics` → `/pages/marketplace-analytics.html`
- `/collection` → `/pages/collection.html`
- `/skills` → `/skills.html`, which client-redirects to `/marketplace?tab=skills`
- `/api/marketplace/purchase/:ref/confirm` → `purchase.js?reference&op=confirm`
- `/api/marketplace/buy-asset/:ref/confirm` → `buy-asset.js?reference&op=confirm`
- `/api/marketplace/purchase-bundle/:id/confirm` → `purchase-bundle.js?purchase_id&op=confirm`

---

### Marketplace browse & discovery — `/marketplace`
- **Source:** `src/marketplace.js` (entry `init()` ~L7730), `pages/marketplace.html`, `src/marketplace-lobby.js` (3D hero podium), `src/marketplace-detail.js` (detail render/preview), backend `api/marketplace/[action].js`
- **Entry point:** `init()` → `bindEvents()` → `loadCategories()` → `loadList(true)` → `loadTheme()` → `loadCurrentUser()` → `fetchUserPurchases()` → `render()`. Initial fetches: `/api/marketplace/categories`, `/api/marketplace/agents`, `/api/explore?source=avatar` and `?source=onchain`, `/api/marketplace/theme`, `/api/auth/me`, `/api/users/me/purchased-skills`.
- **Prerequisites / gates:** None to browse. `/api/auth/me` is best-effort (anonymous users still browse; owner-only price-edit panels stay hidden). Wallet/auth only gate the purchase actions.
- **Steps (N):**
  1. User opens `/marketplace`; SPA shell loads, skeleton cards render (`skeletonHTML(8)`).
  2. System fetches categories, agents, public avatars, onchain agents, weekly theme, current user, and the user's owned skills in parallel.
  3. Hero renders a 3D lobby (`marketplace-lobby.js` `mountLobby()`, max 5 featured avatars on a podium) auto-rotating every 8s; pauses on hover/focus.
  4. Weekly theme strip renders a horizontally-scrollable set of featured 3D picks.
  5. Main grid renders agent cards + avatar cards + onchain cards with section headers and counts.
  6. (optional) User clicks a category in the sidebar or a top-bar chip → `state.category` set → `loadList(true)` refetches `/api/marketplace/agents?category=…`.
  7. (optional) User types in the search box → debounced 250ms → `state.q` set → `loadList(true)` refetches with `?q=…` (also applied to `/api/explore` avatar/onchain calls).
  8. (optional) User changes the sort dropdown (recommended / newest / popular / trending) → `loadList(true)` with `?sort=…`.
  9. (optional) User clicks a Free/Paid price chip → `state.priceFilter` → refetch agents with `?pricing=free|paid` (avatars/onchain re-filtered client-side).
  10. (optional) User clicks a tag pill on a card → `navTo(/marketplace?tag=X)` → `render()` re-filters the in-memory grid.
  11. User scrolls to the grid bottom → IntersectionObserver fires `loadList(false)` (append) with `?cursor=…`; a manual "Load more" button maps to the same handler.
  12. User clicks a card → `navTo()`: agent → `/marketplace/agents/:id` (301 → `/agents/:id`), avatar → `/marketplace/avatars/:id` (301 → `/avatars/:id`), onchain → `/marketplace/onchain/:id` (SPA detail) or external fallback link.
- **Decision points / branches:** filter type (All / Agents / Avatars / Onchain); price (Any / Free / Paid); 3D model category chips; sort mode; tab via `?tab=` (agents | avatars | onchain | skills | tools | memory | earn | purchases | mine).
- **External calls / dependencies:** `api/marketplace/[action].js` (categories, agents, theme, agents/:id, /versions, /similar), `/api/explore`, `/api/auth/me`, `/api/users/me/purchased-skills`. 3D via model-viewer + Three.js (lobby).
- **Success state:** Populated grid with featured 3D hero, theme strip, and per-section counts; cards navigable to detail.
- **Empty / error states:** `renderEmptyState()` ("No results" + "Browse categories" CTA); `renderCategoriesError()` with retry in sidebar; `renderErrorState('agents'|'avatars'|'skills')` with retry; per-card model-viewer load error message.
- **Step count:** 6 required (+6 optional)

---

### Agent / avatar listing detail — `/marketplace/agents/:id` (301 → `/agents/:id`), `/marketplace/avatars/:id` (301 → `/avatars/:id`)
- **Source:** `src/marketplace.js` (`loadDetail()` ~L4581, `loadAvatarDetail()` ~L4717), `src/marketplace-detail.js` (3D stage, live chat preview, creator modal), canonical pages `/agents/:id` and `/avatars/:id` reuse `marketplace-detail.js`
- **Entry point:** Card click in the grid, or direct URL. SPA path form renders inline via `loadDetail(id)`; canonical paths get a 301 redirect to the dedicated agent/avatar page. `loadDetail()` fetches `/api/marketplace/agents/:id`, plus best-effort `/api/marketplace/agents/:id/versions` and `/similar`.
- **Prerequisites / gates:** None to view, preview-chat, or open the creator modal (all anonymous-friendly). Buying a skill or the whole asset requires auth + wallet (see purchase flows below).
- **Steps (N):**
  1. User lands on detail; cached card renders optimistically, then full API data replaces it.
  2. 3D avatar renders in the hero (`renderDetailAvatar()`); a full-width interactive 3D model stage offers orbit, fullscreen, GLB download, and "Open in world".
  3. System lists the agent's skills with price/trial badges; owned skills show "Installed ✓", paid show "Unlock", trial-eligible show "Try free (N left)".
  4. (optional) User opens the live chat preview → `startPreviewSession()` POSTs an SSE stream to `/api/marketplace/agents/:id/preview` and streams the agent's reply.
  5. (optional) User clicks the creator name → `openCreatorModal()` fetches `/api/creators/:id` and shows the creator's agents/avatars.
  6. (optional) User starts a trial (see Trial flow), unlocks a skill (see Skill purchase flow), or buys the whole asset (see Asset purchase flow).
  7. (optional, owner only) If `currentUserId === agent.owner_id`, a price editor panel appears; save/clear posts to `/api/marketplace/asset-price`.
- **Decision points / branches:** owner vs buyer view; skill is free / owned / paid / trial-eligible; asset is for-sale vs not.
- **External calls / dependencies:** `/api/marketplace/agents/:id` (+ `/versions`, `/similar`, `/preview`), `/api/creators/:id`, `/api/avatars/:id` (avatar detail), `/api/marketplace/asset-price` (owner price edit).
- **Success state:** Full detail with interactive 3D, skill list, live preview, and the correct action (Unlock / Buy / Try free / owner editor).
- **Empty / error states:** `showDetailState('error'|'notfound')` overlay with retry; avatar detail "Avatar not found"; 3D stage "Couldn't load the 3D model." with a 15s "still loading" hint; preview errors surfaced in the chat footer.
- **Step count:** 3 required (+4 optional)

---

### Skill purchase / unlock (critical path) — buy flow via `/api/marketplace/purchase`
- **Source:** client `src/marketplace.js` (`openPurchaseFlow()` ~L6824, `createPendingPurchase()` ~L6872, `buildSplTransferWithReference()` ~L7258, `pollConfirm()` ~L7299) and the embed widget `src/payment-modal.js` (`SkillPaymentModal` / `PaymentChip`). Backend `api/marketplace/purchase.js` → `_lib/services/MonetizationService.js` (`preparePurchaseTransaction`, `confirmPurchase`), `_lib/solana/gasless-tx.js`, `_lib/resolve-recipient.js`. Access check `api/marketplace/check-skill-access.js`.
- **Entry point:** "Unlock" button on a paid skill in the agent detail view (or the embedded agent widget's payment-required event, which opens `SkillPaymentModal`/`PaymentChip`).
- **Prerequisites / gates:** Auth required (session cookie or bearer) — `/api/marketplace/purchase` returns 401 otherwise. CSRF token required (`requireCsrf`). Rate-limited (`limits.authIp`). A connected Solana wallet (Phantom et al.) is required to sign; sufficient USDC/`$THREE` balance for the price.
- **Steps (N):**
  1. User clicks "Unlock" on a paid skill → `openPurchaseFlow(agentId, skill)` populates and shows the payment modal (skill name, agent name, price, status, QR slot).
  2. (optional) If no wallet is connected, modal shows "Connect Phantom" → `_connectWallet()` calls `window.solana.connect()`; if Phantom is absent, it links to phantom.app.
  3. User clicks "Confirm Purchase" → client POSTs `/api/marketplace/purchase` `{ agent_id, skill, [duration_hours], [buyer_public_key], [recipient (gift)] }`.
  4. Server (`MonetizationService.preparePurchaseTransaction`) resolves price, creator payout wallet, fee split, idempotent pending row, referrer attribution; returns a quote `{ reference, recipient, currency_mint, amount, creator_amount, mint_decimals, fee, chain }`. If `buyer_public_key` is supplied and chain is Solana, it also pre-builds a **gasless** fee-payer-sponsored `VersionedTransaction` (`buildGaslessPurchaseTx`).
  5. **Branch — already owned:** if `already_owned: true`, modal shows "✓ Already purchased — access granted." and resolves success without payment.
  6. Client builds the SPL transfer (`buildSplTransferWithReference`): from-ATA → creator-ATA for `creator_amount`, optional platform-fee leg to treasury, and pushes the `reference` pubkey as a read-only key so the server can find the tx on-chain. (Gasless path uses the server-prepared tx instead.)
  7. **Pre-flight balance check:** client reads the buyer's token ATA; if balance < required, it shows "Not enough USDC" + an "Add funds →" button (`showAddFunds`) and stops before prompting the wallet (insufficient-funds branch).
  8. Client sets recent blockhash, fee payer = buyer; calls `wallet.sendTransaction()` (desktop) or `signAndSendTransaction()` (mobile) → user approves in the wallet.
  9. Client waits for on-chain confirmation (`connection.confirmTransaction(txid, 'confirmed')`).
  10. Client polls `/api/marketplace/purchase/:reference/confirm` every 2.5s (60s timeout). Server (`confirmPurchase`) finds the tx by reference, validates amount + mint to the creator payout wallet, marks the row `confirmed`, records `agent_revenue_events`.
  11. **Branch — verification outcomes:** `confirmed` → success; `409 transfer_mismatch` (status `tipped` when a smaller-but-real transfer landed); `410 purchase_expired` for a stale pending row.
  12. On confirmed, modal renders a signed receipt (`buildReceiptHTML`) with a Solscan link, then resolves true.
  13. Client refreshes ownership: `fetchUserPurchases()` and reloads the detail (`loadDetail`) so the skill now shows "Installed ✓"; the purchase appears under the "My Purchases" tab and in `/collection`.
- **Decision points / branches:** gasless (wallet connected, sponsored) vs buyer-pays vs mobile QR (Solana Pay); already-owned short-circuit; insufficient funds → Add funds; gift purchase (`recipient`) resolved server-side via `resolveRecipient`; verification mismatch (tipped) vs expired. A separate agent rail exists: `POST /api/marketplace/purchase-as-agent` `{ buyer_agent_id, seller_agent_id, skill }` buys the skill FOR an owned agent from its custodial wallet (owner-authenticated, CSRF-gated, 10 autonomous purchases/hour/agent, same daily spend cap as asset purchases).
- **External calls / dependencies:** `POST /api/marketplace/purchase`, `POST /api/marketplace/purchase/:ref/confirm`, `GET /api/marketplace/purchase/:ref` (status), `GET /api/marketplace/check-skill-access`, Solana RPC via `/api/solana-rpc` (rotates lanes; when every lane dies at the wire it re-sweeps once and answers an idempotent read from its last-good body, flagged with an `x-solana-rpc-stale` header, instead of a 502), `@solana/web3.js` + `@solana/spl-token` (lazy-loaded), `@solana/pay` (server `findReference`/`validateTransfer`), gasless tx builder, `/api/users/me/purchased-skills` (post-purchase refresh), `/api/billing/receipts` (receipt download in My Purchases).
- **Success state:** Receipt with tx link; skill flips to owned; appears in My Purchases tab and `/collection`; `check-skill-access` returns `has_access: true`.
- **Empty / error states:** cancelled connect/tx ("try again"), insufficient funds (Add funds button), `verification_failed` (paid but unverified — contact support), network error, expired pending row — all with the confirm button re-enabled for retry. Re-verify (no new tx) supported when a txid exists.
- **Step count:** 9 required (+4 optional)

---

### Whole-asset purchase (avatar / agent / plugin) — buy flow via `/api/marketplace/buy-asset`
- **Source:** client `src/marketplace.js` (`openAssetPurchaseFlow()` ~L6890, `createPendingAssetPurchase()` ~L6929, `pollAssetConfirm()` ~L6936; shared engine `src/shared/skill-purchase.js`). Backend `api/marketplace/buy-asset.js` (Solana Pay `findReference`/`validateTransfer`, gasless sponsorship, EVM/USDC fallback via `_lib/evm-payment-verify.js`, receipts + notifications).
- **Entry point:** "Buy now with USDC" on an avatar modal / agent detail / plugin card.
- **Prerequisites / gates:** Auth + CSRF + rate limit; asset must have an active `asset_prices` row; seller must have a configured payout wallet for the chain (else `412 creator_wallet_missing`); buyer must not be the owner (else `400 self_purchase`); connected wallet with sufficient balance.
- **Steps (N):**
  1. User clicks "Buy now" → `openAssetPurchaseFlow({ item_type, item_id, label, price })` opens the payment modal in `mode='asset'`.
  2. (optional) Connect wallet if not connected. For signed-in users the modal also prepends a "Pay from an agent's own wallet, no popup" block (up to 4 owned agents with live USDC balances, from `/api/x402-pay?agents=1`; underfunded agents are disabled).
  3. User confirms → POST `/api/marketplace/buy-asset` `{ item_type, item_id, [buyer_public_key] }`. **Agent-wallet branch:** picking an agent instead POSTs `{ item_type, item_id, agent_id }`; the server verifies ownership, enforces the agent's daily purchase cap (`agent_identities.meta.auto_purchase_daily_limit_usdc`, summed across skill AND asset purchases by `api/_lib/agent-purchase.js`; exceeding it returns `402 spend_cap_exceeded`), signs from the agent's custodial wallet, validates the transfer on-chain, and grants in one round trip (no prepare → sign → confirm dance).
  4. Server validates price/seller/payout; **already-owned** confirmed purchase short-circuits with `already_owned: true`; otherwise reuses or inserts a pending `asset_purchases` row (30-min expiry) and returns `{ reference, recipient, amount, currency_mint, chain, mint_decimals }` (+ gasless block when applicable).
  5. **Branch — already owned:** modal jumps to the success screen, skips payment.
  6. Client builds + signs the full-amount SPL transfer (single leg, no platform fee) with the reference key; user approves in wallet.
  7. Client confirms on-chain, then polls `/api/marketplace/buy-asset/:reference/confirm` (2.5s, 60s).
  8. Server (Solana) `findReference` → `validateTransfer`; on success marks `confirmed`, writes a signed `asset_purchase_receipts` row, and notifies both seller (`asset_purchased`) and buyer (`asset_purchase_confirmed`).
  9. Modal renders the success card; primary CTA goes to `/dashboard/avatars`, `/dashboard/agents`, or `/dashboard` per asset type; `fetchUserPurchases()` refreshes ownership.
- **Decision points / branches:** chain = Solana vs EVM (EVM confirm requires a submitted `tx_hash`, verified via `verifyEvmUsdcPayment` on Base; short transfer = `tipped` 409); browser wallet (gasless vs buyer-pays) vs agent custodial wallet (server-signed, capped); already-owned; mismatch (tipped) vs expired (410).
- **External calls / dependencies:** `POST /api/marketplace/buy-asset` (+ `/:ref` status, `/:ref/confirm`), Solana RPC w/ fallback, `@solana/pay`, EVM USDC verifier, `insertNotification`, receipt HMAC signing.
- **Success state:** Asset confirmed and owned; receipt stored; both parties notified; CTA into the relevant dashboard; surfaced in `/collection`.
- **Empty / error states:** `404 not for sale`, `412 creator_wallet_missing`, `400 self_purchase`, `409 transfer_mismatch` (tipped), `410 purchase_expired`; client retry/re-verify identical to the skill flow.
- **Step count:** 7 required (+2 optional)

---

### Free trial unlock — `/api/marketplace/start-trial`
- **Source:** `src/marketplace.js` (`openTrialFlow()` ~L6794), backend `api/marketplace/start-trial.js`
- **Entry point:** "Try free (N left)" button on a trial-eligible paid skill (detail view or grid card).
- **Prerequisites / gates:** Auth (button redirects to login on 401): a browser session cookie (CSRF enforced) or an API-key bearer token (CSRF skipped for bearer callers). No wallet/payment.
- **Steps (N):**
  1. User clicks "Try free" → `openTrialFlow(agentId, skill, btn)`.
  2. Client POSTs `/api/marketplace/start-trial` `{ agent_id, skill }`.
  3. **Branch:** if already owned or trial already used, an alert explains and stops.
  4. On success, `fetchUserPurchases()` + `loadDetail()` refresh; the skill now shows in My Purchases with a "Trial (N left)" badge and works until uses are exhausted.
- **Decision points / branches:** trial available vs already-owned vs trial-used.
- **External calls / dependencies:** `POST /api/marketplace/start-trial`, `/api/users/me/purchased-skills`. Trial visibility: `GET /api/marketplace/trial-status?role=buyer|seller` reports each of the caller's trials (runs left, price to keep, state: fresh/active/running-low/exhausted) or, for sellers, per-skill trial counts (counts only, never buyer identities).
- **Where the two sides are read:** `/conversions` (`pages/conversions.html`, `src/conversions.js`) renders that endpoint as a two-tab page: "Trials I hold" and "Trials on my skills". The buyer list is capped server-side at 200 rows and the payload carries `total` + `truncated` so the page can say what it is leaving out rather than implying the cap is the whole count. Row CTAs deep-link at one skill: a buyer's row opens `/agents/:id?skill=<name>#pricing`, which scrolls the agent page's pricing card to that skill and marks the row (`focusRequestedSkill()` in `src/agent-detail-market.js`); a seller's "Edit pricing" opens `/agents/:id/edit?tab=monetization`, the panel that actually sets the price and the trial grant.
- **Success state:** Trial grant visible in My Purchases / `/collection` with a remaining-uses badge.
- **Empty / error states:** alert on already-owned / trial-used; auth redirect on 401.
- **Step count:** 3 required (+1 optional)

---

### Skills marketplace (browse / install / rate) — `/skills` → `/marketplace?tab=skills`
- **Source:** `pages/skills.html` (redirect shell), `src/marketplace.js` skills tab (`skillsState` ~L2128, `loadSkillsTab()`, `renderSkillsGrid()`/`renderSkillCard()` ~L2229, skill detail ~L2348, `toggleSkillInstall()` ~L2582). Backend `/api/skills`, `/api/skills/categories`, `/api/skills/:id`, `/api/skills/:id/install`, `/api/skills/:id/rate`. x402 per-call via `/api/x402/skill-call`. Runtime gate `src/skills/index.js`.
- **Entry point:** `/skills` client-redirects (preserving `?q=`, `?category=`, `?tag=`, `?sort=`) to `/marketplace?tab=skills`; the SPA reads those params back off the URL into `skillsState` and renders the skills grid. Without JavaScript the shell shows a heading, an explanation, and a link to the Marketplace, and a `<noscript>` refresh forwards anyway.
- **Prerequisites / gates:** Browse is open. Install and rate require auth (401 → `/login?next=…`). Installing is **free** — payment for skills is per-call via x402, separate from install.
- **Steps (N):**
  1. SPA loads the skills tab → `GET /api/skills?limit=24&q=&category=&tag=&sort=&cursor=` and `/api/skills/categories`; renders skeletons then cards (name, price-per-call or "free", description, category pill, x402 badge for paid, install/tool counts, rating, "Installed ✓").
  2. (optional) User filters by category chip → `skillsState.category` → `loadSkillsTab(true)` refetch. Search, category, tag, and sort all write back to the URL (`syncSkillsToUrl`), so the view is shareable and survives a reload and the back button.
  3. (optional) User searches → `skillsState.q` → refetch; or toggles Free/Paid (client-side `isPaidSkill`).
  3b. (optional) User clicks a tag pill on a skill detail → `/marketplace?tab=skills&tag=X` → `GET /api/skills?tag=X` (exact, case-insensitive match against the skill's `tags`); a banner names the active tag and clears it in one click.
  4. (optional) User scrolls → cursor pagination appends more cards.
  5. User clicks a card → `/marketplace/skills/:id` → `GET /api/skills/:id` renders the detail panel (header, meta pills, description, tool schemas, full content, related skills).
  6. User clicks "Install" → `toggleSkillInstall()` POSTs `/api/skills/:id/install` (DELETE to remove); 401 → login redirect; on success the detail + grid refetch, the button flips to "Installed ✓ — Remove", and the "what next" panel (`#skill-detail-next`) appears: knowledge skills get a "Chat with your agent →" CTA to `/app`, schema-only packs get the `GET /api/skills?installed=true` retrieval hint. Pre-install, `#skill-detail-how` explains what installing does.
  7. (optional) User rates 1–5 stars → `POST /api/skills/:id/rate { rating }` → detail refetches with updated counts.
  8. (optional, paid skills) Detail shows an x402 panel: endpoint `GET /api/x402/skill-call?skill=:slug`, price `$X.XXX/call`, and a copy-paste `@three-ws/x402-fetch` snippet — developers pay per call from their own wallet; the server settles to the author.
- **Decision points / branches:** free vs paid (paid = x402 per-call, not an install purchase); installed vs not; authed vs anon (install/rate gated). Marketplace skills (community tool packs with schema/content) are distinct from built-in agent skills in `src/agent-skills*.js`.
- **External calls / dependencies:** `/api/skills`, `/api/skills/categories`, `/api/skills/:id`, `/api/skills/:id/install` (POST/DELETE), `/api/skills/:id/rate`, `/api/x402/skill-call` (per-call payment), `/api/creators/:id` (author modal).
- **Success state:** Skill installed (flips to "Installed ✓" + the what-next panel), rating recorded, x402 snippet copyable. Installs take effect at chat time: `/api/chat` loads the signed-in user's installed knowledge skills (`api/_lib/installed-skills.js`, newest 8, content budget 24k chars) into the system prompt and reports them as `skills_applied` in the SSE `done` event; `GET /api/skills?installed=true` returns the full payload (content + schema_json) for external agents.
- **Empty / error states:** "No skills found", naming the search / category / tag that emptied the list, with Clear-filters / Publish-a-Skill CTAs; a failed fetch renders `renderErrorState('skills')` ("Couldn't load skills") with a working Retry; install button restores text + re-enables on error; auth redirect on 401.
- **Step count:** 3 required (+5 optional)

---

### My Collection — `/collection`
- **Source:** `pages/collection.html`, `src/collection.js`. Backend `/api/users/me/purchased-skills`, `/api/subscriptions`, `/api/billing/receipts`
- **Entry point:** Direct nav to `/collection`; auto-runs `load()` on script load.
- **Prerequisites / gates:** Auth required. Both data fetches returning 401 reveal the auth wall (`#col-auth-wall`).
- **Steps (N):**
  1. Page loads → `load()` renders skeleton grids, then `Promise.all` fetches `/api/users/me/purchased-skills` and `/api/subscriptions` (both `credentials: include`).
  2. **Branch — 401:** auth wall shown ("Sign in to see your collection"); grids cleared.
  3. On success, stats render (skills count, active subscriptions, NFT-receipt count); the Skills panel renders owned/trial cards (thumbnail, skill name, agent, Owned/Trial badge, price, optional skill-NFT mint link to Solscan, purchase date, "View agent").
  4. The Subscriptions panel renders sub cards (Active/Expired badge, amount/period, renew/expiry date, "View agent").
  5. (optional) User switches between the Skills and Subscriptions tabs (counts shown in tab labels).
  6. (optional) "View agent" links navigate to `/marketplace/agents/:id` (→ `/agents/:id`).
- **Decision points / branches:** authed vs auth-wall; skill (Owned) vs trial; subscription active vs expired; has NFT receipt vs not.
- **External calls / dependencies:** `GET /api/users/me/purchased-skills`, `GET /api/subscriptions`, Solscan/Solana Explorer links, `/api/billing/receipts` (receipt download elsewhere in the purchase flow).
- **Success state:** Populated Skills + Subscriptions grids with live stats and tab counts.
- **Empty / error states:** Per-panel empty states ("No skills yet" → marketplace link; "No subscriptions"); `renderLoadError()` with a Retry button for network/HTTP/JSON failures; skeletons never linger.
- **Step count:** 4 required (+2 optional)

---

### Marketplace analytics — `/marketplace/analytics`
- **Source:** `pages/marketplace-analytics.html`, `src/marketplace-analytics.js`. Backend `/api/marketplace/analytics`
- **Entry point:** Direct nav to `/marketplace/analytics`; auto-runs `load()`.
- **Prerequisites / gates:** None — public aggregate stats.
- **Steps (N):**
  1. Page loads → `load()` fetches `/api/marketplace/analytics`.
  2. Stat cards render: Paid skill sales, Total volume, Free trials taken, Paying buyers, Creators listing skills. Sales/volume/buyers count `status = 'confirmed'` rows only; free trials are counted on their own card so they can never read as revenue.
  3. A **trial funnel** section renders (Trials granted → used → exhausted → converted), with a diagnosis note when the funnel is broken (e.g. many exhausted trials with zero conversions) linking to `/tutorials/sell-a-skill-with-a-trial`.
  4. A 30-day volume bar chart draws on a Canvas (no charting dependency; theme-aware colors, missing days zero-filled). With no paid sales it renders an honest empty state ("No paid sales in the last 30 days") instead of a void.
  5. Top Skills ranked list renders (skill, agent, sales count or "N trials, no sales yet", revenue).
  6. Top Agents ranked list renders (agent, skill-sale count, net revenue).
- **Decision points / branches:** has-data vs empty ("No skills listed yet." / "No agents yet."); paid vs trial split everywhere; dark vs light theme chart palette.
- **External calls / dependencies:** `GET /api/marketplace/analytics` only.
- **Success state:** Stats grid, trial funnel, volume chart, and both ranked lists populated.
- **Empty / error states:** Fetch/parse failure → `#an-error` "Failed to load analytics. Please refresh." and all sections cleared; per-list empty placeholders.
- **Step count:** 6 required (+0 optional)

---

### Marketplace feature landing — `/features/marketplace`
- **Source:** `pages/features/marketplace.html` (static marketing page; `nav.js`, `footer.js`)
- **Entry point:** Direct nav or the `/features` index.
- **Prerequisites / gates:** None — public static page, no JS app, no API calls.
- **Steps (N):**
  1. User lands on the page; breadcrumb (Home / Features / Marketplace), hero ("Agents built by the community."), and a "How it works" steps section render.
  2. (optional) User clicks "Browse agents →" (hero or bottom CTA) → navigates to `/marketplace`.
  3. (optional) User clicks "All features" → `/features`.
- **Decision points / branches:** none (purely informational marketing).
- **External calls / dependencies:** none.
- **Success state:** Marketing content rendered; CTAs route into the live marketplace.
- **Empty / error states:** none (fully static).
- **Step count:** 1 required (+2 optional)

---

## Notes
- `/marketplace/agents/:id` and `/marketplace/avatars/:id` are **301 redirects** to the canonical `/agents/:id` and `/avatars/:id` pages (vercel.json). Within the SPA, the same paths render inline via `loadDetail()`/`loadAvatarDetail()` before a hard navigation would redirect; `marketplace-detail.js` powers both the SPA detail and the canonical pages.
- Two distinct purchase rails: **individual skills** (`/api/marketplace/purchase`, splits creator + platform fee, records `agent_revenue_events`) vs **whole assets** (`/api/marketplace/buy-asset`, single full-amount leg, no fee, EVM/USDC fallback). The embed widget (`payment-modal.js`) only drives the skill rail. Both rails also have an **agent-payer** variant (`/api/marketplace/purchase-as-agent`, and `buy-asset` with `agent_id`) where the server signs from an owned agent's custodial wallet under one shared daily spend cap (`api/_lib/agent-purchase.js`).
- "Skills marketplace" (`/skills`, `/api/skills/*`) sells community tool packs — **install is free, payment is per-call via x402** — which is a different mechanism from the skill *unlock* purchase on an agent's detail page (`/api/marketplace/purchase`). Both can show under a user's owned items.
- `src/marketplace-lobby.js` is not URL-routed; it's a Three.js scene mounted into the hero canvas with an `onSelect` callback back to `marketplace.js`.
- Source coverage: all referenced files were located and read. No missing sources. Line numbers for `marketplace.js` are approximate anchors from a structural read of the 8.9k-line file, not exact-verified per line.
