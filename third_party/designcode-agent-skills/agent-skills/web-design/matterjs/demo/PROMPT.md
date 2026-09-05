# Matter.js Demo Prompts

## Minimal prompt

Use $matterjs to create a polished standalone HTML example that clearly demonstrates the skill.

## Recreate the demo

Use $matterjs to build a responsive reference demo for this capability:

> Use when implementing 2D physics interactions with Matter.js, including Engine/World setup, Render/Runner configuration, adding bodies and constraints, and scroll/interaction-friendly canvas scenes.

### Direction

Demonstrate contained 2D bodies with gravity, collision, and a clear reset state.

Use an art-directed composition with one clear focal point, restrained supporting copy, and enough surrounding interface to show how the technique behaves in a real product or landing page.

### Canonical example

- Simulate fourteen differently sized bodies under gravity inside a bounded canvas.
- Use restrained bounce and friction so the system settles instead of exploding.

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
- Keep simulated bodies inside visible bounds and provide a deterministic reset.
- Pause or throttle the simulation when the page is hidden.

## Remix prompt

Use $matterjs and keep the same implementation contract, but change the subject, copy, palette, and content hierarchy. Preserve the core technique, accessibility behavior, responsive rules, and performance constraints demonstrated by the reference.
