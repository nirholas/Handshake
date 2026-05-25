# three.ws Walk Avatar — Chrome Extension

Walk your three.ws avatar on any website you visit.

## Install (development / load-unpacked)

1. Build:
   ```bash
   npm run build:extension
   ```
2. Open `chrome://extensions`
3. Enable **Developer mode** (toggle top-right)
4. Click **Load unpacked**
5. Select `dist/extension/`

## Usage

- Click the extension icon in the toolbar to open the popup
- Sign in with your three.ws account to access your avatars
- Select an avatar and toggle "Enable on this site"
- The avatar appears floating in the corner of the page
- Drag the handle at the top of the avatar container to reposition it
- Click × to close on a specific page without disabling the extension

## Build for Web Store

```bash
npm run build:extension:prod
```

Outputs `dist/extension-<version>.zip` ready to upload to the Chrome Web Store.

## Structure

```
extensions/walk-avatar/
├── manifest.json      — Manifest V3 config
├── background.js      — Service worker: state, auth, message relay
├── content.js         — Content script: avatar iframe injection
├── popup.html/.js     — Extension popup: avatar picker + toggle
├── options.html/.js   — Settings page (opens from extension details)
└── icons/             — Generated from public/pwa-icon.svg
```

## Permissions

- `storage` — stores avatar selection and settings
- `activeTab` — reads current tab URL for site label display
- `scripting` — injects content.js into tabs when user enables the avatar
- `host_permissions: <all_urls>` — required to inject into any site the user visits

## Privacy

User data stays on-device in `chrome.storage`. The only outbound requests are:
- `GET three.ws/api/avatars/*` — fetch avatar list and GLB URLs (requires sign-in for private avatars)
- `GET three.ws/api/tts/speak` — only when narration is explicitly enabled
- The avatar iframe itself connects to `three.ws` to render the 3D scene
