---
name: documentary-brutalist-agency
description: Create or redesign creative agency, production studio, architecture, culture, and portfolio websites with billboard typography, hard black-and-white chapters, exposed grids, documentary imagery, irregular collages, restrained parallax, brutalist navigation, and accessible FAQ controls.
---

# Documentary Brutalist Agency

Use hard typography to establish a point of view, then let real project imagery carry the proof.

## Establish the Story

1. Open with a billboard-scale positioning line and minimal navigation.
2. Cut directly into selected work on black.
3. Use a sparse white philosophy chapter to explain how the studio thinks.
4. Build one documentary collage as a paced process story.
5. Add verified testimonials or updates on pale proof surfaces.
6. Resolve objections in a minimal FAQ before the oversized footer wordmark.

Replace source names, projects, people, photography, quotes, claims, and links. Use original or licensed documentary material.

## Build the Visual System

- Use hard black and warm white with occasional pale mint or pink proof surfaces.
- Pair one compressed display face with one neutral grotesk.
- Expose grid lines, use square corners, and avoid glass, glow, and decorative gradients.
- Let type and photography create hierarchy; keep icons and ornament minimal.
- Use line breaks as composition. Test them at every breakpoint.
- Maintain strong contrast without making every element equally loud.

## Compose the Page

- Header: use a compact identity, current section, and a decisive menu trigger.
- Hero: set one compressed headline near billboard scale; keep supporting copy small.
- Work: use black chapters with large titles, role labels, and documentary media.
- Philosophy: cut to warm white with fewer words and more breathing room.
- Collage: vary image scale and alignment while preserving narrative DOM order.
- Testimonials: use pale proof cards only for verified quotes.
- Updates: set compact editorial entries with date, category, and action.
- FAQ: use hard rules and predictable disclosure behavior.
- Footer: finish with an oversized wordmark and a clear contact route.

## Implement the Documentary Collage

- Use CSS Grid and reserve every image box before media loads.
- Keep DOM order aligned with narrative order even when the visual grid is irregular.
- Map shallow transforms to scroll progress and cap parallax below 5%.
- Reveal captions on both hover and focus; keep them available to touch and assistive technology.
- Retain the grid when an image fails or is absent.
- Use a short pinned handoff only when it clarifies the story and never overlap contact or footer.

## Implement Menu and FAQ Controls

- Use semantic buttons and native `details`/`summary` or an accessible disclosure pattern.
- Update `aria-expanded`; preserve deep links and browser history.
- Trap focus only inside a true modal menu and restore it on close.
- Make hover, focus, pressed, open, disabled, loading, and current states distinct without color alone.
- Keep navigation and FAQ fully usable when motion is disabled.

## Motion Defaults

- Use 160–220ms for controls and 500–760ms for masks and section entrances.
- Favor slow collage parallax, sticky contrast changes, and decisive black/white cuts.
- Animate one reading transition at a time.
- Pause offscreen observers and media; clean up route timelines.
- Do not use constant floating, smooth-scroll theater, or scroll hijacking.

## Validate

- Read the page in DOM order with CSS and motion disabled.
- Test the menu, FAQ, collage captions, and project links with keyboard and touch.
- Check compressed headline wrapping at 320px, tablet, desktop, and 200% zoom.
- Verify image dimensions, alt text, contrast, focus, reduced motion, and failed-media states.
- Remove invented projects, clients, quotes, awards, or results.

## Avoid

- Brutalism as random misalignment or inaccessible contrast.
- Decorative masonry with no narrative order.
- Rounded SaaS cards, glass, glow, or many gradients.
- Continuous parallax that competes with the work.
- Modal focus traps on non-modal navigation.
