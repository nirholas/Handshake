# Browser Video Recording Demo Prompts

## Minimal prompt

Use $browser-video-recording to create a polished standalone HTML example that clearly demonstrates the skill.

## Recreate the demo

Use $browser-video-recording to build a responsive reference demo for this capability:

> Create polished 60 fps 4:3 4K browser screen-recording style videos from Codex in-app browser captures, with browser-only crop, natural macOS cursor styling, deliberate click choreography, zoom-follow framing, ffprobe/thumbnail verification, and optional native recording compatibility checks. Use when the user asks to record or re-record browser actions, show cursor clicks and zooms, make Dribbble/UI inspiration or product demo recordings, or asks whether Codex, Playwright, or an MCP can produce a natural browser demo video.

### Direction

Present the workflow as a compact evidence-first input and output handoff.

Use an art-directed composition with one clear focal point, restrained supporting copy, and enough surrounding interface to show how the technique behaves in a real product or landing page.

### Canonical example

- Use demo/input.md as the fictional source packet.
- Present demo/expected-output.md as the verified handoff beside it.

### Deliverable

- Create demo/index.html as a standalone document.
- Keep CSS and JavaScript inline.
- Put any required images, fonts, models, textures, or vendor files in demo/assets/.
- Do not add a framework, package manager, build step, or node_modules.
- Add controls only when they help inspect or replay the technique.

### Acceptance checks

- Keep the demo responsive from 390px through 1440px.
- Use semantic HTML, visible focus states, and reduced-motion handling.
- Keep all HTML, CSS, and JavaScript inside demo/index.html.
- Use only relative local asset paths.
- Show a realistic input and expected output without exposing real customer or account data.
- Make authorization boundaries and verification status explicit.

## Remix prompt

Use $browser-video-recording and keep the same implementation contract, but change the subject, copy, palette, and content hierarchy. Preserve the core technique, accessibility behavior, responsive rules, and performance constraints demonstrated by the reference.
