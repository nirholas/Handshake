# Account & Dashboard

UX Flow Atlas — cluster 11. Traced end-to-end against real source in `/workspaces/three.ws`.

## Routing summary

Resolved from `vercel.json` (`routes`) and `vite.config.js` (`vercel-rewrites` dev middleware):

| Route | Resolves to | Page module(s) |
| --- | --- | --- |
| `/login` | `public/login.html` | inline JS + `public/wallet-login.js` + `src/privy-login.js` |
| `/register` | `public/register.html` | inline JS + `public/wallet-login.js` + `src/privy-login.js` |
| `/forgot-password` | `public/forgot-password.html` | inline JS |
| `/reset-password` | `public/reset-password.html` | inline JS (atlas-adjacent; documented as the completion of forgot-password) |
| `/dashboard` | `pages/dashboard-next/index.html` | `src/dashboard-next/pages/home.js` |
| `/dashboard/account` | `pages/dashboard-next/account.html` | `src/dashboard-next/pages/account.js` |
| `/dashboard/analytics` | `pages/dashboard-next/analytics.html` | `src/dashboard-next/pages/analytics.js` |
| `/dashboard/settings` | `pages/dashboard-next/settings.html` | `src/dashboard-next/pages/settings.js` |
| `/settings` | `public/settings/index.html` | inline module script |

`/login` and `/register` are **dedicated full pages, not modals**. Both share the same auth backend (`/api/auth/*`), the same Privy module (`src/privy-login.js`), and the same wallet-button loader (`public/wallet-login.js`). The shared client helpers live in `src/auth/email-auth.js` (`signInWithEmail`, `registerWithEmail`, `getCurrentUser`, `signOut`, `requireAuth`).

Shared auth concepts:
- **Session:** a `__Host-sid` cookie minted server-side by `createSession()`, identical across email/password, SIWE (EVM), SIWS (Solana), Privy, and SAML.
- **Post-auth redirect:** `?next=` query param → `sessionStorage.login_redirect` → default (`/dashboard` for login, `/create` for register). On `/login`, an already-authenticated visitor is bounced to `next` via a `GET /api/auth/me` probe on load.
- **Auth hint:** every successful auth writes `localStorage['3dagent:auth-hint']` so other surfaces render a logged-in chrome optimistically.

---

### Sign in — `/login`
- **Source:** `public/login.html` (inline `<script>` for email/password + already-auth guard), `public/wallet-login.js` (EVM SIWE + Solana SIWS connect buttons in the on-chain drawer), `src/privy-login.js` (Privy email-OTP + Privy SIWE/SIWS), `src/auth/email-auth.js` (shared helpers).
- **Entry point:** Direct nav to `/login`; from "Sign in" links in nav/footer; via `requireAuth()` / `requireUser()` redirects (`/login?return=…` or `?next=…`) from any gated page.
- **Prerequisites / gates:** None to view. An existing account is required for the email/password path; wallet paths can sign in an existing wallet-linked user. If `GET /api/auth/me` resolves with a user on load, the page `location.replace(next)` immediately (skipped on back/forward navigation).
- **Steps (N):**
  1. Page loads; theme boot script applies dark/light; nav injected from `/nav.js`; login avatar (`@three-ws/agent-ui`) renders on the side panel.
  2. On load, fire `GET /api/auth/me` (credentials included). If `{user}` → `location.replace(next)` (already signed in). If 401 → stay on form. If transport error → show "Couldn't verify your session…" notice but keep form usable.
  3. (optional) Email is prefilled from `?email=` or `localStorage['3dagent:last-email']`; if present, focus jumps to password.
  4. **Email/password path:** type email-or-username into `#email`, password into `#password`. Avatar covers its eyes while a credential field is focused. (optional) toggle show/hide password; Caps-Lock warning shows live.
  5. (optional) tick "Remember me".
  6. Click **Sign in** (`#submit`). Client validates both fields are non-empty (inline field errors + avatar facepalm on empty).
  7. `POST /api/auth/login` with `{ email, password, remember }`, credentials included. Button shows "Signing in…".
  8. On `!res.ok`: 429 → "Too many attempts…", else "Email or password is incorrect." — inline error on password field, avatar facepalm, button re-enabled.
  9. On success: persist `3dagent:last-email` + auth-hint; button "Signed in — redirecting…"; avatar plays a dance; after one dance cycle (700–1800ms) `location.replace(next)`.
  10. **(optional) Privy email-OTP path:** type email in `#privy-email-input` → click **Send code**. If the Privy app has CAPTCHA, a Cloudflare Turnstile challenge resolves first. `privy.auth.email.sendCode()` sends the code; UI advances to the code step.
  11. Enter the 6-digit code → **Verify** → `privy.auth.email.loginWithCode()` returns an `identity_token` → `POST /api/auth/privy/verify` mints the session → `location.href = next`. (optional **← Back** returns to email step.)
  12. **(optional) Privy EVM wallet:** click the **EVM** chain button → `eth_requestAccounts` → `privy.auth.siwe.init()` builds the message → `personal_sign` in wallet → `privy.auth.siwe.loginWithSiwe(signature)` → `POST /api/auth/privy/verify` → redirect. Status text walks through "Requesting accounts… / Generating message… / Sign… / Signing in…".
  13. **(optional) Privy Solana wallet:** click the **Solana** chain button → `provider.connect()` (Phantom/Backpack/Solflare) → `GET /api/auth/siws/nonce` → build SIWS message → `provider.signMessage` → `POST /api/auth/siws/verify` (with `x-csrf-token`) → redirect.
  14. **(optional) On-chain features drawer:** click "Connect wallet" to expand `#onchain-section`; Solana/EVM tabs mount the native connect buttons from `public/wallet-login.js` (full SIWE/SIWS via `/wallet/connect-button*.js`). Drawer state persists in `sessionStorage['login:onchain']`.
  15. **(optional) Enterprise SSO:** if `GET /api/config` returns `samlEnabled`, the **SSO** button reveals and navigates to `/api/auth/saml/login?next=…`.
- **Decision points / branches:** email+password (legacy `/api/auth/login`) **vs** Privy email-OTP (`/api/auth/privy/verify`) **vs** Privy EVM SIWE **vs** Privy Solana SIWS **vs** native on-chain drawer SIWE/SIWS (`wallet-login.js`) **vs** SAML SSO. Solana chain tab auto-disables and falls back to EVM when no Solana provider is detected.
- **External calls / dependencies:** `GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/privy/verify`, `GET /api/auth/siws/nonce`, `POST /api/auth/siws/verify`, `GET /api/config`, `/api/auth/saml/login`; Privy JS SDK (`@privy-io/js-sdk-core`, app id from `/api/config`), Cloudflare Turnstile, browser wallet providers (`window.ethereum`, `window.solana`/Phantom/Backpack/Solflare), `@three-ws/agent-ui` (avatar), model-viewer CDN.
- **Success state:** Session cookie set; auth-hint persisted; `location.replace`/`href` to `next` (default `/dashboard`).
- **Empty / error states:** Per-field inline errors with shake + avatar facepalm; transport-failure banner on the session probe; SSO error codes from the URL (`sso_unavailable`, `saml_invalid`, `account_deleted`, `rate_limited`, etc.) and `?signed_out` notice; Privy/wallet errors map "reject/denied/cancel" to "Signature cancelled."; wallet-module load failure shows a connection error; wallet skeleton shimmer while connect buttons mount.
- **Step count:** 9 required (+6 optional)

---

### Create account — `/register`
- **Source:** `public/register.html` (inline JS: username/password submit + already-auth guard + password-strength + on-chain drawer), `src/privy-login.js` (same Privy email-OTP/wallet paths as login), `public/wallet-login.js`, `src/auth/email-auth.js` (`registerWithEmail`).
- **Entry point:** "Create one" link from `/login`; "Create account" / "Sign up" CTAs; gated-flow redirects.
- **Prerequisites / gates:** None. Already-signed-in visitors are bounced to `next` (default `/create`) via the `GET /api/auth/me` guard (skipped on back/forward).
- **Steps (N):**
  1. Page loads; register avatar (`/avatars/cz.glb` model-viewer) renders with mouse-parallax look-around.
  2. On load, `GET /api/auth/me`; if `{user}` → `location.replace(next)`; 401 stays; transport error shows a notice.
  3. Type a **Username** (`#username`, 3–30 chars, `[a-zA-Z0-9_-]`); inline hint validates live ("✓ Looks good" / specific error).
  4. Type a **Password** (`#password`, min 10 chars); strength meter updates (Too short → Very strong); Caps-Lock warning; (optional) show/hide toggle.
  5. Click **Create account** (`#submit`); button shows "Creating account…".
  6. `POST /api/auth/register` with `{ username, password }`, credentials included.
  7. On `!res.ok`: 429 → "Too many attempts…"; 409 → "That username is taken."; 400 → field guidance; 422 → "…isn't allowed — try another."; 5xx → server-fault copy; network `TypeError` → "Couldn't reach the server…". Error banner shown, button re-enabled.
  8. On success: server creates the account **and an immediate session** (signed in on register); persist auth-hint; `location.replace(next)` (default `/create`).
  9. **(optional) Privy email-OTP / EVM / Solana wallet** registration — identical flows to `/login` (shared `src/privy-login.js`): Send code → Verify, or EVM SIWE, or Solana SIWS → session → redirect.
  10. **(optional) On-chain features drawer** — same Solana/EVM native connect buttons; state persists in `sessionStorage['register:onchain']`.
- **Decision points / branches:** username+password (`/api/auth/register`) **vs** Privy email-OTP **vs** Privy EVM SIWE **vs** Privy Solana SIWS **vs** native on-chain drawer SIWE/SIWS. (Note: the primary form here collects **username** + password, whereas `/login` accepts email-or-username; the shared `registerWithEmail()` helper supports an email+displayName variant used by other surfaces.)
- **External calls / dependencies:** `GET /api/auth/me`, `POST /api/auth/register`, `POST /api/auth/privy/verify`, `GET /api/auth/siws/nonce`, `POST /api/auth/siws/verify`, `GET /api/config`; Privy SDK, Turnstile, browser wallets, model-viewer CDN.
- **Success state:** Account created, session minted, redirect to `next` (default `/create`); user is logged in.
- **Empty / error states:** Live username/password validation; status-mapped error banner (taken username, rate-limit, server fault, offline); Privy/wallet cancellation handling; ToS/Privacy legal copy below the button.
- **Step count:** 8 required (+2 optional)

---

### Forgot password — `/forgot-password`
- **Source:** `public/forgot-password.html` (inline JS). Completion happens at `/reset-password` (`public/reset-password.html`).
- **Entry point:** "Forgot password?" link in the `/login` remember-row.
- **Prerequisites / gates:** None. Privacy-preserving: never reveals whether an account exists.
- **Steps (N):**
  1. Page loads; avatar look-around; email field focus lights its label.
  2. Type email (`#email`); inline hint validates format live ("✓ Looks valid" / "Enter a valid email address.").
  3. Click **Send reset link** (`#submit`); button shows "Sending…".
  4. `POST /api/auth/forgot-password` with `{ email }`.
  5. Server always answers 200 with a privacy-preserving body. On status `< 500` → show success notice: "If an account exists for that email, a reset link has been sent."; on `>= 500` → error notice "Something went wrong on our end…"; on fetch rejection → "Couldn't reach the server…".
  6. Button re-enabled ("Send reset link") regardless, so the user can retry.
  7. **(completion, separate route) `/reset-password?token=…`:** user clicks the emailed link → `public/reset-password.html` reads `?token`. If no token → error + disabled submit. Enter new password + confirm (both min 10, must match) → **Reset password** → `POST /api/auth/reset-password` with `{ token, password }` → on success swap to "Password reset. You can now log in." with a link back to `/login`; on error show message and re-enable.
- **Decision points / branches:** Single path (email). The reset-completion step is a distinct page reached from email, not a branch within `/forgot-password`.
- **External calls / dependencies:** `POST /api/auth/forgot-password`; (completion) `POST /api/auth/reset-password`; model-viewer CDN.
- **Success state:** Privacy-preserving "reset link sent" notice (request side); on the completion page, "Password reset" confirmation with a sign-in link.
- **Empty / error states:** Inline email-format hint; 5xx error notice; offline/transport error notice; reset page guards a missing/invalid token and enforces match + length.
- **Step count:** 6 required (+1 completion step on a separate route)

---

### Dashboard overview — `/dashboard`
- **Source:** `pages/dashboard-next/index.html` → `src/dashboard-next/pages/home.js`; shell from `src/dashboard-next/shell.js` (sidebar/topbar/drawer/palette); data helpers from `src/dashboard-next/api.js`.
- **Entry point:** Nav/footer "Dashboard" links; post-login redirect default; `getting-started.js` guide.
- **Prerequisites / gates:** **Signed-in required.** `requireUser()` (in `api.js`) calls `getMe()` → `GET /api/auth/me`; on 401 it navigates to `/login?return=<path>` and returns a never-resolving promise so the page halts cleanly. `/dashboard-classic/*` and legacy sub-routes 301 to canonical `/dashboard/*` (vercel.json + dev middleware).
- **Steps (N):**
  1. `home.js` boots → `mountShell()` renders sidebar + topbar + live-event drawer + command palette; the active nav item pulses "you are here".
  2. `requireUser()` resolves the session (or redirects to login).
  3. Greeting renders ("Welcome back, &lt;name&gt;."); new-account detection (< 30 days) and dismissal flags (`twx_onboarding_dismissed`, `twx_forge_announce_dismissed`) decide which banners show.
  4. Skeletons render across hero / KPI / activity slots.
  5. Parallel fetch: `GET /api/avatars?limit=50`, `GET /api/widgets`, `GET /api/agents?limit=20` (each `Promise.allSettled`, degrades independently).
  6. Hero strip shows live 3D avatar previews; KPI row (revenue, views, transcripts, avatars) with sparklines over a 7-day window; trading + world-health sections; 2×2 quick-actions grid; agent/avatar directory; recent-activity feed (stitched transcripts + revenue events).
  7. The onboarding guide (`getting-started.js`) is reconciled against authoritative server state (avatars/agents/widgets) on every visit.
  8. KPIs + activity re-poll every 30s; relative timestamps tick every 60s.
  9. (optional) Use the sidebar to navigate to sub-pages (account, analytics, settings, agents, avatars, tokens, monetize, etc.); open the command palette; open the live-event drawer (pulses on new events); dismiss onboarding/announce banners.
  10. (optional) If the user arrived via a referral link, `claimPendingReferral()` attributes it now that a session exists (no-op otherwise).
- **Decision points / branches:** New vs returning user (onboarding banner); each data slot renders, empties, or errors independently; referral-claim runs only with a pending code.
- **External calls / dependencies:** `GET /api/auth/me`, `GET /api/avatars`, `GET /api/widgets`, `GET /api/agents`, plus KPI/activity polling endpoints; shared `tour.js`, `crypto-optional.js`, `log.js`.
- **Success state:** Authenticated overview rendered with live KPIs, hero avatars, and activity; navigation chrome fully wired.
- **Empty / error states:** Per-slot skeletons during load; new-user onboarding panel as the "empty" guidance; failed data fetches degrade per slot (empty arrays) rather than failing the page; unauthenticated → redirect to `/login`.
- **Step count:** 8 required (+2 optional)

---

### Account management — `/dashboard/account`
- **Source:** `src/dashboard-next/pages/account.js` (+ shell + `api.js`).
- **Entry point:** Sidebar "Account"; quick-links; `/dashboard/wallets`, `/dashboard/actions`, `/dashboard/sns`, `/dashboard/delegation` all 301 here.
- **Prerequisites / gates:** Signed-in required (`requireUser()` → `/login?return=…` on 401).
- **Steps (N):**
  1. Boot: `mountShell()` then `requireUser()`.
  2. Page renders sections: **Profile** (display name, username, sign out), **AI Provider Keys**, **Linked Wallets**, **SNS / .sol handle domains**, **Vanity Wallets** (Solana + ETH CREATE2), **Delegation** console, **Action Log / audit trail**, and quick links to settings/storage/usage/ERC-8004.
  3. **(optional) Update profile:** click edit on the name row → inline input (max 60) → **Save** → `PATCH /api/auth/profile` `{ display_name }` → toast "Saved", profile re-renders. Username edit → `PATCH /api/auth/profile` `{ username }` → toast "Username saved".
  4. **(optional) Provider keys:** enter a key → **Save** → `PATCH /api/user/provider-keys` `{ [provider]: value }` → toast "Key saved"; clear → `PATCH …` `{ [provider]: null }` → toast "Key removed".
  5. **(optional) Linked wallets:** list from `GET /api/auth/wallets`. "Make primary" → `POST /api/auth/wallets/primary` `{ address }` → toast "Primary wallet updated" + refresh. "Disconnect" → confirm → `DELETE /api/auth/wallets/{address}` → toast "Wallet disconnected" + row removed. "+ Link wallet" routes to the wallet-linking flow.
  6. **(optional) SNS / vanity:** "Register domain" → `/vanity-wallet`; "Manage" → external `sns.id`; vanity tools open `/vanity-wallet` and `/eth-vanity`.
  7. **(optional) Delegation:** open console → pick target agent + message (max 8000) → **Run delegation** → `POST /api/agent-delegate` `{ toAgentId, message }` → response box with model tag; status-specific errors (429/404/503).
  8. **(optional) Audit log:** "Export CSV" → `GET /api/audit-log?format=csv` → toast "CSV downloaded"; "Load older" paginates `GET /api/audit-log`.
  9. **(optional) Sign out:** `POST /api/auth/logout` → redirect to `/`.
- **Decision points / branches:** Each section is independent; wallet/SNS sections show empty states when nothing is linked; delegation requires at least one agent.
- **External calls / dependencies:** `GET /api/auth/me`, `PATCH /api/auth/profile`, `PATCH /api/user/provider-keys`, `GET /api/auth/wallets`, `POST /api/auth/wallets/primary`, `DELETE /api/auth/wallets/{address}`, `POST /api/agent-delegate`, `GET /api/audit-log`, `POST /api/auth/logout`.
- **Success state:** Toasts on each mutation (Saved / Username saved / Key saved / Primary wallet updated / Wallet disconnected / CSV downloaded); sections re-render with fresh data.
- **Empty / error states:** "No wallets linked", "No Solana wallets linked", "No primary .sol domains found", "No agents to delegate", "Audit log is empty"; load-failure toasts ("Couldn't load &lt;section&gt;"); audit 404 ("endpoint not deployed yet"), 401 ("Sign in required").
- **Step count:** 2 required (boot + render) (+7 optional management flows)

---

### Analytics — `/dashboard/analytics`
- **Source:** `src/dashboard-next/pages/analytics.js` (+ shell + `api.js` + shared `state-kit`). `/dashboard/usage` 301s here.
- **Entry point:** Sidebar "Analytics"; "View analytics" links.
- **Prerequisites / gates:** Signed-in required (`requireUser()`; 401 → `/login?return=…`).
- **Steps (N):**
  1. Boot: `mountShell()` → `requireUser()`; title "Analytics" + subtitle render.
  2. Skeletons render (4 KPI bones + 3 panel bones).
  3. Parallel fetch for the selected range (default **30 days**): `GET /api/billing/revenue?from&to&granularity`, `GET /api/agents?limit=50`, `GET /api/widgets`, `GET /api/billing/summary` (+ `GET /api/monetization/revenue?period=…`).
  4. Secondary fetches: per-widget `GET /api/widgets/{id}/stats` (up to 20) and `GET /api/agents/{id}/payments?direction=received&limit=5` for the top 5 agents.
  5. Render: **range bar** (7d / 30d / 90d / 12mo), **KPI cards** (Total Revenue, Total Callers, Avg Price/Call, Top Agent), **Revenue Over Time** canvas line chart (animated, hover tooltip), **Revenue by Skill** horizontal bars (top 8), **Agent Performance** table (Views / Chats / Conv.%), **Recent Activity** table (latest 20 payments with Settled/Failed/Pending badges).
  6. **(optional)** Click a range button → refetch with new `from/to/granularity` → re-render with chart re-animation.
- **Decision points / branches:** Time-range selection drives granularity (day vs week). Critical error only when all four primary surfaces fail; individual fetches degrade silently via a `safe()` wrapper.
- **External calls / dependencies:** `GET /api/auth/me`, `/api/billing/revenue`, `/api/agents`, `/api/widgets`, `/api/billing/summary`, `/api/monetization/revenue`, `/api/widgets/{id}/stats`, `/api/agents/{id}/payments`.
- **Success state:** Fully rendered metrics dashboard with live charts and tables for the chosen window.
- **Empty / error states:** Panel-level empties — "No revenue data for this period. Set up monetization" (→ `/dashboard/monetize`), "No skill revenue yet", "No agents yet. Create one" (→ `/dashboard/agents`), "No revenue events yet…"; global "Couldn't load analytics" with a Reload button when all primary surfaces fail; skeletons during load.
- **Step count:** 5 required (+1 optional)

---

### Dashboard settings (app preferences) — `/dashboard/settings`
- **Source:** `src/dashboard-next/pages/settings.js` (+ shell + `api.js`). `/dashboard/sessions`, `/dashboard/voice`, `/dashboard/storage` and several legacy routes 301 here.
- **Entry point:** Sidebar "Settings"; quick-links from `/dashboard/account`.
- **Prerequisites / gates:** Signed-in required (`requireUser()`; 401 → `/login?return=…`).
- **Steps (N):**
  1. Boot: `mountShell()` → `requireUser()`; 4 skeletons while data loads.
  2. Parallel fetch: `GET /api/auth/sessions`, `GET /api/notifications?limit=20`, `GET /api/notifications/preferences`, `GET /api/billing/summary` (storage), `GET /api/usage/summary` (LLM usage), plus dashboard prefs.
  3. Render sections: **Appearance/theme**, **Active sessions**, **Notifications**, **Notification preferences**, **Default payment network**, **Storage usage**, **LLM usage**, **Vanity wallet tools**, **Preferences**, **Data export**, **About**.
  4. **(optional) Theme:** click Dark/Light/Auto → `localStorage['twx_theme']` (+ `window.threeTheme.set`) → toast "Theme applied" (no API).
  5. **(optional) Sessions:** "Revoke" → `DELETE /api/auth/sessions/{id}` → toast + row removed; "Revoke all other" → `POST /api/auth/sessions/revoke-others` → toast.
  6. **(optional) Notifications:** "Mark all read" → `POST /api/notifications/read-all` → toast. The inbox covers the full bell vocabulary (sales, purchases, follows, remixes, DMs, coin-launch graduations, IRL, market, account).
  6b. **(optional) Notification preferences:** the category × channel matrix (categories: sales, purchases, social, IRL, market, account; channels: in-app, push, email, Telegram) → `PATCH /api/notifications/preferences` per toggle → toast. The in-app channel is always on and rendered disabled.
  7. **(optional) Default network:** Base/Solana/Polygon → `localStorage['twx_default_network']` + best-effort `PATCH /api/dashboard/prefs` `{ prefs: { default_network } }` → toast.
  8. **(optional) Preferences:** toggle email notifications / show tips / compact sidebar → **Save preferences** → `PATCH /api/dashboard/prefs` `{ prefs }` → toast "Preferences saved".
  9. **(optional) Data export:** Agents / Avatars / All → fetch `GET /api/agents`, `GET /api/avatars?limit=100`, `GET /api/widgets` → build JSON blob → browser download → toast "Data exported".
- **Decision points / branches:** Theme, default network, and privacy-style toggles are local-first (localStorage) with best-effort prefs sync; sessions/notifications/export hit live APIs. Read-only meters for storage/LLM usage.
- **External calls / dependencies:** `GET /api/auth/me`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{id}`, `POST /api/auth/sessions/revoke-others`, `GET /api/notifications`, `POST /api/notifications/read-all`, `GET /api/notifications/preferences`, `PATCH /api/notifications/preferences`, `GET /api/billing/summary`, `GET /api/usage/summary`, `PATCH /api/dashboard/prefs`, `GET /api/agents`, `GET /api/avatars`, `GET /api/widgets`.
- **Success state:** Toasts on each action (Theme applied / Session revoked / All notifications marked read / Default network set / Preferences saved / Data exported); sections reflect new state.
- **Empty / error states:** "No session data", "No notifications" / "You're all caught up", "No usage data"; per-action error toasts with button re-enable for retry; skeletons during load.
- **Step count:** 3 required (boot + fetch + render) (+6 optional setting flows)

---

### Account settings (profile / security hub) — `/settings`
- **Source:** `public/settings/index.html` (standalone page, inline module script). **Distinct page** from `/dashboard/settings` — neither redirects to the other.
- **Entry point:** Direct nav to `/settings`; header/account menu "Settings"; deep links to tab hashes (`#profile`, `#account`, `#privacy`, `#sessions`, `#connected-accounts`, `#danger`).
- **Prerequisites / gates:** Signed-in required. `loadUser()` → `GET /api/auth/me`; if no user / 401 → `location` to `/login?next=/settings`.
- **Steps (N):**
  1. Page loads; `GET /api/auth/me` resolves the user (or redirects to login).
  2. Tabbed UI renders (default `#profile`); fields populate from the user record + follow-up fetches.
  3. **Profile tab:** edit display name (max 80) + username (3–30, pattern-validated, live profile-URL preview) → **Save changes** → `PATCH /api/auth/profile` `{ display_name, username }` → "Saved!" inline message (4s) + URL preview update.
  4. **(optional) Account tab:** read-only email with Verified/Unverified badge (`user.email_verified`); password "Reset via email ↗" → `/forgot-password`; connected wallets count from `GET /api/auth/wallets` (→ `/dashboard/account` to manage); plan display (→ `/dashboard#billing`); **Sign out everywhere** → `POST /api/auth/logout-everywhere` → clear localStorage → redirect to `/login`.
  5. **(optional) Privacy tab:** default avatar visibility select (private/unlisted/public) → **Save** → `localStorage['3dagent:default-vis']` → "Saved preference."
  6. **(optional) Sessions tab:** list from `GET /api/auth/sessions` (device/IP/date); "Revoke" → `DELETE /api/auth/sessions/{id}` (row removed); **Revoke all other sessions** → `DELETE /api/auth/sessions` → "All other sessions revoked." + reload.
  7. **(optional) Connected Accounts tab:** GitHub status `GET /api/auth/github/status`; connect → `/api/auth/github/connect?agent_id=…`; seed agent memory → `POST /api/agents/{agentId}/memory-seed`. X status `GET /api/agents/{agentId}/memory/seed/x`; connect → `/api/auth/x/connect?agent_id=…`; seed → `POST /api/agents/{agentId}/memory/seed/x`. Supports `?agent_id=` prefill.
  8. **(optional) Danger Zone tab:** click "Delete my account…" → type "delete my account" to enable → **Permanently delete** → `DELETE /api/auth/me` → clear localStorage → redirect to `/?deleted=1`.
- **Decision points / branches:** Six hash-routed tabs; profile is the primary editable surface; privacy is local-only; account/sessions/connections/danger hit live APIs. Distinct from `/dashboard/settings` (which is app preferences, no identity/security fields).
- **External calls / dependencies:** `GET /api/auth/me`, `PATCH /api/auth/profile`, `GET /api/auth/wallets`, `POST /api/auth/logout-everywhere`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{id}`, `DELETE /api/auth/sessions`, `GET /api/auth/github/status`, `/api/auth/github/connect`, `POST /api/agents/{id}/memory-seed`, `GET`/`POST /api/agents/{id}/memory/seed/x`, `/api/auth/x/connect`, `DELETE /api/auth/me`.
- **Success state:** "Saved!" / "Saved preference." / "All other sessions revoked." inline messages (auto-hide 4s); GitHub/X "Connected" tags; account deletion redirect to `/?deleted=1`.
- **Empty / error states:** "No sessions found."; "Not connected" + connect buttons for GitHub/X; inline `.ok`/`.err` messages; delete-flow confirmation gate + error alert with button revert; "Checking…"/"Loading…" placeholders during async loads.
- **Step count:** 3 required (boot + profile load + save profile) (+5 optional tab flows)

---

## Notes on routing edge cases

- **No login/register modal:** auth is full-page (`/login`, `/register`). Other surfaces trigger it by redirect (`requireAuth()` in `src/auth/email-auth.js`, `requireUser()` in `src/dashboard-next/api.js`), preserving the origin via `?return=`/`?next=`. The dashboard chrome itself is gated, not the marketing pages.
- **Two settings surfaces, intentionally separate:** `/settings` = identity/security/connections/danger (profile hub); `/dashboard/settings` = app/dashboard preferences (theme, sessions, notifications, network, storage/LLM meters, export). They share only the concept of "sessions" (each with its own UI and revoke calls).
- **Heavy 301 consolidation:** `/dashboard-classic/*` and many legacy `/dashboard/*` slugs (wallets, sessions, actions, memory, strategy, voice, sns, delegation, x402, storage, usage, agent-pumpfun) redirect to the canonical `/dashboard/*` pages — mirrored in both `vercel.json` and the Vite dev middleware so dev matches prod.
