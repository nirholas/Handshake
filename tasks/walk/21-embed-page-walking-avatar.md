# Task 21 — Embed Page: Walking Avatar Mode for /embed

## Priority: URGENT

## Objective
Extend the existing `/embed` page (`pages/embed.html` → `public/embed/`) to support a "walking avatar" embed mode in addition to whatever current modes exist. The embed snippet generator UI must offer a "Walking" option alongside Static/Idle/Chat.

## Scope
- Files: `pages/embed.html`, `pages/a-embed.html`, `pages/agent-embed.html`, `pages/avatar-embed.html`, `src/agent-embed-modal.js` (audit all and apply changes consistently)
- Add new embed mode `walking` to whatever mode enum exists in the embed system
- Walking mode embed snippet:
  ```html
  <iframe src="https://three.ws/walk-embed?avatar=<id>&controls=joystick&autoplay=true" width="320" height="480" style="border:0;border-radius:16px"></iframe>
  ```
  (uses the embed page from task 03)
- Generator UI:
  - Mode toggle (Static | Idle | Chat | Walking)
  - When Walking selected, expose: controls (joystick/keyboard/none), background (color picker), size (S/M/L/custom), autoplay (toggle), environment (dropdown from task 18)
  - Live preview pane on the right showing the embed exactly as it would render
  - "Copy snippet" button → real copy to clipboard via `navigator.clipboard.writeText`
- Add a second snippet variant for the JS embed SDK from task 04:
  ```html
  <script src="https://three.ws/walk-embed-sdk.js" data-avatar="<id>"></script>
  ```

## Definition of Done
- Open `https://three.ws/embed?avatar=<id>` → Walking mode is selectable
- Live preview accurately reflects the snippet
- Snippet copies to clipboard
- Pasting snippet into a fresh `index.html` renders the walking avatar correctly
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real preview, real copy, real embed. Wire end-to-end.
