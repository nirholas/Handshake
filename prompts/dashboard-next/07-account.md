# 07 — Account page

**Read `prompts/dashboard-next/_shared.md` first.** Then build the slice below.

## Your slice

Build the Account page at **`/dashboard-next/account`** — consolidates profile, wallets, SNS domains, delegation, action log, and settings.

## Layout

1. **Header** — `.dn-h1` "Account" / `.dn-h1-sub` "Profile, wallets, and the audit trail."

2. **Profile section** — `.dn-panel`:
   - Avatar / initials circle (use `initialsOf(me)`) on the left
   - Display name (editable inline — pencil hover → input → blur saves via `PATCH /api/auth/me`)
   - Handle (`@…`), email (verified chip if `email_verified`)
   - Member since (`relTime(created_at)`) and current plan name (link to `/dashboard-next/monetize`)
   - Sign-out button (`.dn-btn.ghost`) on the right → POST `/api/auth/logout` then redirect to `/`

3. **Wallets section** — `.dn-panel`:
   - Subtitle: "Linked addresses that can claim royalties, pay for subscriptions, or sign as you."
   - Table: chain (chip — `.dn-tag` Solana / Base / Ethereum / Polygon, color-coded) · address (mono, truncated `0x123…abc` with copy-on-click) · linked when (`relTime`) · primary chip (if `is_primary`) · disconnect button
   - "+ Link wallet" → opens chain picker → fires the existing connect flow (read `src/wallet/connect-button.js` and `src/wallet-auth.js` for the sign-in handshake — match it)
   - "Make primary" action on rows that aren't primary

4. **SNS / handle domains** — `.dn-panel`:
   - List the user's SNS (Solana name service) domains owned + which point at this account
   - Each row: domain · status (`.dn-tag.success` "Active" / `.dn-tag.warn` "Pending") · expiry
   - "+ Register a domain" → links to `/vanity-wallet` or the existing SNS flow under `public/dashboard/sns.html` — match that page's behavior

5. **Delegation** — `.dn-panel`:
   - Subtitle: "Let another wallet sign on behalf of one of your agents."
   - Per-agent delegation row: agent name · delegate address · expires · revoke
   - "+ New delegation" → modal with agent dropdown + delegate address + expiry

6. **Action log** — `.dn-panel`:
   - Table of last 50 events: when · category (Auth · Avatar · Widget · Payment · Settings) · description · IP (truncated) · agent string (truncated)
   - "Export full log (CSV)" button → triggers download via `GET /api/audit-log?format=csv` (or the existing path)
   - Pagination: cursor or "Load older"

## Files you create

- `pages/dashboard-next/account.html`
- `src/dashboard-next/pages/account.js`

Do not modify any other file.

## API endpoints

Read these existing files for the canonical patterns:
- `public/dashboard/account.html` (profile + sign-out)
- `public/dashboard/wallets.html` (wallet list/link)
- `public/dashboard/sns.html` (SNS domains)
- `public/dashboard/delegation.html` (delegation)
- `public/dashboard/actions.html` (action log)
- `src/wallet-auth.js`, `src/wallet/connect-button.js` (wallet linking handshake)

Likely:
- `GET /api/auth/me`, `PATCH /api/auth/me`, `POST /api/auth/logout`
- `GET /api/wallets` / `POST /api/wallets` / `DELETE /api/wallets/:id`
- `GET /api/sns/domains?owner=me`
- `GET /api/agents/:id/delegations` / `POST /api/agents/:id/delegations` / `DELETE /api/agents/:id/delegations/:delegateId`
- `GET /api/audit-log?cursor=…&limit=50` / `GET /api/audit-log?format=csv`

## Empty / loading / error states

- No wallets: `.dn-empty` inside the section with "+ Link wallet" CTA
- No delegations: short prose explainer with CTA
- Action log empty: `.dn-empty` "Audit log will appear here as you make changes."

## Visual quality bar

- Chain chips color-coded: Solana purple, Base blue, Ethereum gray, Polygon magenta, Optimism red — use semi-transparent accents over the panel background
- Wallet addresses use `font-family: 'JetBrains Mono', ui-monospace, monospace`, copy-on-click with toast "Copied"
- "Primary" badge is a small star icon left of the chain chip

## Verification

```bash
node scripts/_dn-shot.mjs http://127.0.0.1:3010/dashboard-next/account /tmp/dn-account.png
```
Verify:
- Profile loads with real user data
- Wallets table renders or empty state
- Action log shows real events
- No console errors

`npx vite build` passes.

## Commit message

`dashboard-next: account page — profile + wallets + SNS + delegation + action log`
