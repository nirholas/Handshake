# 04 — Library page (animations · memory · strategy · voice)

**Read `prompts/dashboard-next/_shared.md` first.** Then build the slice below.

## Your slice

Build the Library page at **`/dashboard-next/library`** — a single page that consolidates the four "creator inputs" today scattered across separate routes: Animations, Memory, Strategy, and Voice. Tabs at the top switch between them. URL hash drives the active tab (`#tab=animations` default).

## Layout

1. **Header row** — `.dn-h1` "Library" / `.dn-h1-sub` "Animations, memories, strategy notes, and voices your agents can draw on."

2. **Tab strip** — four pills under the header, click to switch tabs, ARIA `role="tablist"`:
   - Animations · Memory · Strategy · Voice
   - Sticky to the top of the main scroll area
   - URL hash updates on switch (`history.replaceState` so refresh-able)
   - Active tab uses `.dn-tag.success` styling (accent background)

3. **Active tab content** — render inside a single `<div data-slot="tab-body">`. Each tab is its own render function.

## Per-tab content

### Animations tab
- Grid of every animation in the user's library (`GET /api/animations`)
- Each card shows: clip name, duration (rounded to 0.1s), tags, source (uploaded / preset / mocap), and a tiny waveform / preview thumb if available
- "Upload .glb / .fbx" button at the top of the tab — wires to `/api/animations/presign` flow (read `src/dashboard/dashboard.js` for the existing animation-upload code — copy that pattern exactly)
- Empty state: `.dn-empty` with copy: "No animations yet. Upload a .glb or pick from our mocap library." with two CTAs: [Upload] [Browse presets → `/walk`]

### Memory tab
- A list of every persistent memory entry across all the user's agents (`GET /api/agents/me` to list agents, then per-agent `GET /api/agents/:id/memory` — match existing dashboard.js)
- Each entry: timestamp, agent name (chip), short content preview, source (which conversation it came from). Click to expand the full text inline.
- "+ Add a note" button at top — opens a small inline editor that POSTs to `/api/agents/:id/memory` (let the user pick which agent the note attaches to via a dropdown)
- Empty state: "No memories yet. Your agents will save notes here from their conversations — or you can add one yourself."

### Strategy tab
- A single editable strategy document per agent (current dashboard has `/dashboard/strategy`). Dropdown at top picks agent; below, a `<textarea>` that loads `GET /api/agents/:id/strategy` and saves on blur via `PUT /api/agents/:id/strategy` (debounce 800ms). Auto-save indicator chip ("Saving…" → "Saved · `relTime`")
- If the user has no agents, show `.dn-empty` "You don't have any agents yet" with CTA to `/dashboard-next/account` or `/create`

### Voice tab
- Voice picker for each agent: dropdown of available voices (poll `GET /api/voices/list` if it exists, otherwise fall back to whatever `public/dashboard/voice.html` uses)
- For each agent, show: current voice name, a 12-second sample audio player (`<audio controls>` pointed at `GET /api/voices/sample?voice=<id>`), and a "Test with custom text" input that POSTs to `/api/voices/preview` (text-to-speech preview)
- "Save" button per agent that PATCHes `/api/agents/:id` with `{ voice: <id> }`

## Files you create

- `pages/dashboard-next/library.html`
- `src/dashboard-next/pages/library.js`
- Optional: `src/dashboard-next/pages/library/animations.js`, `memory.js`, `strategy.js`, `voice.js` if you want per-tab split (recommended for readability — keep each under 250 lines)

Do not modify any other file.

## API endpoints

Inspect `src/dashboard/dashboard.js`, `public/dashboard/memory.html`, `public/dashboard/strategy.html`, `public/dashboard/voice.html` for the canonical endpoint paths the existing code uses. **Reuse those paths verbatim** — do not invent new ones.

Likely:
- `GET /api/animations`, `POST /api/animations/presign`
- `GET /api/agents`, `GET /api/agents/me`, `GET /api/agents/:id/memory`, `POST /api/agents/:id/memory`
- `GET /api/agents/:id/strategy`, `PUT /api/agents/:id/strategy`
- `GET /api/voices/list`, `POST /api/voices/preview`

## Empty / loading / error states

Every tab needs all three. A failed fetch in one tab must not break the others — they each have isolated try/catch blocks.

## Verification

Smoke-test each tab (one screenshot per tab):
```bash
for tab in animations memory strategy voice; do
  node scripts/_dn-shot.mjs "http://127.0.0.1:3010/dashboard-next/library#tab=$tab" "/tmp/dn-library-$tab.png"
done
```
Open all four images. Verify:
- Tab strip highlights the active tab in each shot
- Real data is present (animations list, memories, etc.) if the test user has any
- No console errors across any tab

`npx vite build` must pass.

## Commit message

`dashboard-next: library page — animations + memory + strategy + voice tabs`
