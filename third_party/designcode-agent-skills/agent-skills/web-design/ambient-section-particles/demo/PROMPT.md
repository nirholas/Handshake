# Ambient Section Particles Demo Prompts

## Minimal prompt

Use $ambient-section-particles to add a restrained, visibility-aware particle atmosphere behind this section without competing with its content.

## Recreate the demo

Use $ambient-section-particles to recreate **Seedfall — A Quiet Weather System** as a complete standalone HTML document. Treat `demo/index.html` as the visual, interaction, responsive, accessibility, and performance reference.

### Experience

- Build a full-viewport dark botanical chapter with an original canvas field of softly falling seed fragments.
- Vary size, opacity, sway, rotation, gravity, wind, and depth while reserving a quiet reading zone behind the main copy.
- Let pointer movement gently disturb nearby particles without making the canvas interactive or blocking controls.
- Start only while the section is visible, pause when it leaves or the document is hidden, and reuse particles after they exit.
- Include a real control that creates one restrained gust and updates a silent visual status.

### Implementation contract

- Deliver `demo/index.html` with all CSS and JavaScript inline and no required external assets.
- Use one canvas loop, ResizeObserver, IntersectionObserver, requestAnimationFrame, and a device-pixel-ratio cap.
- Scale density from container area with strict minimum and maximum counts.
- Keep canvas decorative, pointer transparent, and behind semantic content with visible focus.
- Under reduced motion, render one sparse deterministic still and do not run a continuous loop.

## Remix prompt

Use $ambient-section-particles and the included demo as the quality bar, but replace the particle shape, palette, mood, copy, forces, and section composition. Preserve the bounded layer, quiet content zone, visibility pausing, one-loop architecture, responsive density, pointer restraint, and reduced-motion fallback.
