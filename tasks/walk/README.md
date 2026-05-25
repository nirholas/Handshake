# Walking Avatar — Task Index

All 50 tasks for the walking avatar feature set. Every task must be completed 100% — no stubs, no mocks, no TODOs. Each task includes its own Definition of Done; do not mark done unless every item in it genuinely passes in a real browser.

Execute in numerical order where there are dependencies (e.g., task 03 before task 04, task 14 before task 15). Independent tracks (Chrome extension 05–10, site integration 21–30) can be parallelized.

---

## Track 1 — Core Walk Page & API (foundation, do first)

| # | Task | Priority |
|---|------|----------|
| [01](01-walk-avatar-url-param.md) | Walk page: `?avatar=` URL parameter support | URGENT |
| [02](02-walk-homepage-hero.md) | Homepage hero: live walking avatar | URGENT |
| [03](03-walk-embed-iframe.md) | Walk embed: iframe-ready `/walk-embed` page | URGENT |
| [04](04-walk-embed-sdk.md) | Walk embed SDK: one-line JS script tag embed | URGENT |

## Track 2 — Chrome Extension (parallel with Track 3)

| # | Task | Priority |
|---|------|----------|
| [05](05-chrome-extension-scaffold.md) | Chrome extension: scaffold & Manifest V3 | URGENT |
| [06](06-chrome-extension-content-script.md) | Chrome extension: content script avatar injection | URGENT |
| [07](07-chrome-extension-popup-picker.md) | Chrome extension: popup avatar picker (full) | URGENT |
| [08](08-chrome-extension-settings.md) | Chrome extension: settings page | HIGH |
| [09](09-chrome-extension-page-narrator.md) | Chrome extension: avatar reads the page aloud | HIGH |
| [10](10-chrome-extension-store-release.md) | Chrome extension: Web Store release package | HIGH |

## Track 3 — Walk Page Features (depends on Track 1)

| # | Task | Priority |
|---|------|----------|
| [11](11-walk-keyboard-controls.md) | Keyboard controls: WASD, run, jump, pointer lock | HIGH |
| [12](12-walk-mobile-joystick.md) | Mobile joystick polish + haptics | HIGH |
| [13](13-walk-camera-modes.md) | Camera modes: third / first / orbit / cinematic | HIGH |
| [14](14-walk-avatar-gestures.md) | Avatar gestures: wave, dance, sit, point, cheer | HIGH |
| [15](15-walk-speech-bubbles.md) | Speech bubbles & chat overlay | HIGH |
| [16](16-walk-voice-chat.md) | Two-way voice chat with the avatar | HIGH |
| [17](17-walk-multiplayer.md) | Multiplayer via Colyseus rooms | HIGH |
| [18](18-walk-environment-selector.md) | Environment selector: 6 real scenes | HIGH |
| [19](19-walk-npc-companions.md) | NPC companion avatars | MEDIUM |
| [20](20-walk-capture-screenshot-gif.md) | Screenshot + GIF export + social share | MEDIUM |

## Track 4 — Site-Wide Integration (depends on Track 1)

| # | Task | Priority |
|---|------|----------|
| [21](21-embed-page-walking-avatar.md) | `/embed` page: walking avatar mode | URGENT |
| [22](22-widget-studio-walking-widget.md) | Widget Studio: walking avatar widget type | URGENT |
| [23](23-agent-detail-walk-mode.md) | Agent detail page: "Walk with this agent" | HIGH |
| [24](24-agent-embed-walking-mode.md) | Agent embed: `mode=walking` | HIGH |
| [25](25-features-page-walking-demo.md) | Features page: walking avatar section | MEDIUM |
| [26](26-pricing-page-walking-mascot.md) | Pricing page: walking mascot | MEDIUM |
| [27](27-dashboard-topbar-walking-avatar.md) | Dashboard topbar: walking avatar | MEDIUM |
| [28](28-profile-page-walking-avatar.md) | Profile page: walking hero stage | MEDIUM |
| [29](29-marketplace-walk-browse.md) | Marketplace: walk-browse mode | MEDIUM |
| [30](30-avatar-edit-walk-preview.md) | Avatar editor: live walk preview tab | MEDIUM |

## Track 5 — Walk-Through-Website Mode (depends on Track 1 + 3)

| # | Task | Priority |
|---|------|----------|
| [31](31-site-wide-walk-mode-toggle.md) | Site-wide walk mode: persistent companion | URGENT |
| [32](32-walk-navigation-between-pages.md) | Avatar walks between pages (View Transitions) | HIGH |
| [33](33-walk-aware-page-transitions.md) | Themed page transitions per destination | MEDIUM |
| [34](34-section-narration-as-avatar-walks.md) | Section narration: avatar reads page sections | MEDIUM |
| [35](35-click-to-walk-navigation.md) | Click-to-walk: navigate by pointing | MEDIUM |
| [36](36-walk-path-visualization.md) | Footstep trails & path visualization | LOW |
| [37](37-walk-minimap.md) | Mini-map: top-down view | LOW |
| [38](38-walk-session-persistence.md) | Session persistence: resume where you left off | MEDIUM |
| [39](39-walk-leaderboard.md) | Leaderboard: distance walked, sites visited | LOW |
| [40](40-walk-analytics-dashboard.md) | Analytics dashboard for embedded avatars | MEDIUM |

## Track 6 — Polish, Performance & Product (run late)

| # | Task | Priority |
|---|------|----------|
| [41](41-walk-performance-optimization.md) | Performance: LOD, culling, asset compression | HIGH |
| [42](42-walk-pwa-install.md) | PWA: installable native-feel app | MEDIUM |
| [43](43-walk-ar-mode-webxr.md) | AR mode: real WebXR immersive-ar | HIGH |
| [44](44-walk-embed-snippet-generator-ui.md) | Embed snippet generator `/embed/walk` | HIGH |
| [45](45-walk-shareable-links-og-image.md) | Shareable links + dynamic OG image generation | HIGH |
| [46](46-walk-landing-marketing-page.md) | Walk landing / marketing page | HIGH |
| [47](47-walk-api-programmatic-control.md) | Programmatic control REST API | MEDIUM |
| [48](48-walk-postmessage-events-spec.md) | postMessage events: full spec & implementation | MEDIUM |
| [49](49-walk-documentation-page.md) | Full developer + user documentation | MEDIUM |
| [50](50-walk-qa-launch-checklist.md) | QA pass + launch checklist (do last) | URGENT |

---

## Global Rules (apply to every task in this directory)

1. **No mocks. No fake data. No placeholders.** Use real APIs, real endpoints, real data.
2. **No TODO comments. No stub functions.** If you write it, finish it.
3. **No commented-out code.** Delete or implement.
4. **Errors handled at real boundaries** — network, user input. Internal code trusts itself.
5. **Wire to real UI** — every feature must be reachable by a real user in a real browser.
6. **Dev server first** — run `npm run dev`, exercise the feature, check the network tab.
7. **No claiming done** without every bullet in the task's Definition of Done genuinely passing.
