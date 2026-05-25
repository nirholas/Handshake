# 05 — API & Embed page

**Read `prompts/dashboard-next/_shared.md` first.** Then build the slice below.

## Your slice

Build the API & Embed page at **`/dashboard-next/api`** — the developer / integrator surface. API keys, MCP integration, ready-to-paste embed snippets, embed-policy controls, and webhook config (if any).

## Layout

1. **Header** — `.dn-h1` "API & embed" / `.dn-h1-sub` "Issue keys, configure MCP clients, embed agents anywhere."

2. **Section: API keys** — `.dn-panel`:
   - Table of keys: name · prefix (e.g. `tws_…abc12`) · scopes (chips) · created · last used (`relTime` or "never") · Revoke button
   - "+ New key" button → opens modal: name input, scopes multi-select (pull scopes list from the existing dashboard.js — likely `avatars:read avatars:write agents:read agents:write widgets:read widgets:write`), expiry dropdown (Never · 30d · 90d · 1y)
   - On create, show the full secret ONCE in a copy-to-clipboard modal with a warning "This is the only time you'll see this key. Store it somewhere safe."
   - Revoke is destructive — confirm modal required

3. **Section: MCP setup** — `.dn-panel`:
   - Subtitle: "Point Claude Desktop, Cursor, or any MCP client at your agents."
   - Three tabs: Claude Desktop · Cursor · Generic JSON
   - Each tab shows the exact config block to paste, with the user's actual API key pre-filled (use a placeholder `tws_yourkeyhere` and an inline "Pick which key" dropdown that swaps the displayed secret)
   - Copy button per snippet
   - "Test connection" button that calls a real endpoint (likely `/api/mcp/health` — check existing dashboard.js for the actual MCP test endpoint) and shows pass/fail inline

4. **Section: Embed snippets** — `.dn-panel`:
   - Dropdown: pick one of the user's avatars OR widgets
   - Three tabs: Script tag · iframe · Web component (`<threews-avatar>`)
   - Live preview pane next to the snippets (320×320 iframe) so the user sees what they're about to paste
   - Each snippet has knobs that update both the code and the preview:
     - Width · Height · Background (transparent / dark / light) · Reveal mode (auto / interaction) · Hide chrome (checkbox)
   - Copy button per snippet

5. **Section: Embed policy** — `.dn-panel`:
   - Origin allowlist per avatar — table of avatar → allowed origins (one per line), saved via PATCH to `/api/embed-policy/:avatarId` (read `api/_lib/embed-policy.js` for shape — `api/_mcp/embed-policy.js` exists). Default is `*` (anywhere). User can lock down to specific origins.
   - Per-row Save button (debounced auto-save on blur, indicator chip)
   - Help link: "Why does this matter?" → tooltip / inline explainer

## Files you create

- `pages/dashboard-next/api.html`
- `src/dashboard-next/pages/api.js` (the file, not the directory — `api.js` is fine because it's under `pages/`)

Do not modify any other file.

## API endpoints

Inspect `src/dashboard/dashboard.js`, `public/dashboard/storage.html`, and `public/dashboard/embed-policy.html` for the exact endpoint paths and request/response shapes — match them exactly.

Likely:
- `GET /api/keys` / `POST /api/keys` / `DELETE /api/keys/:id`
- `GET /api/embed-policy?avatar_id=…` / `PUT /api/embed-policy/:avatar_id`
- `GET /api/mcp/config` if it exists, otherwise build the JSON client-side from the user's session
- `GET /api/avatars` and `GET /api/widgets` for the dropdowns

## Empty / loading / error states

- Keys empty: `.dn-empty` "No keys yet. Issue one to start hitting the API." + [+ New key]
- MCP test failure: red chip inline next to the button
- Embed-policy save failure: revert local state, toast with server error

## Visual quality bar

- Code snippets use a `<pre><code>` block with a dark inner background (`#0a0a10`), 1px stroke, monospace, soft accent line on the left
- Copy buttons sit absolute top-right of the code block, become more visible on hover
- Tab strips use the same pill style as the Library page

## Verification

```bash
node scripts/_dn-shot.mjs http://127.0.0.1:3010/dashboard-next/api /tmp/dn-api.png
```
Verify:
- All four sections visible
- Real keys list (if test user has any) or empty state
- Embed snippet preview iframe actually renders
- No console errors

`npx vite build` passes.

## Commit message

`dashboard-next: api & embed page — keys + MCP setup + live embed snippets + policy`
