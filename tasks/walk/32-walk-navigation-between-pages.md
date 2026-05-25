# Task 32 — Walk Navigation: Avatar "Walks" Between Pages

## Priority: HIGH

## Objective
When walk mode is on (task 31) and the user clicks a link, the avatar visibly walks off the current page and walks onto the next one — creating the illusion of a single continuous environment that spans the whole site.

## Scope
- Module: `src/walk-companion.js` (extend from task 31)
- Click interception:
  - Intercept clicks on internal links (`<a href="/...">`) via document-level delegate
  - Compute direction from avatar's current screen position to link element
  - Avatar walks toward link, plays `wave` 200 ms before navigation triggers
  - Smoothly fade the companion canvas to a transparent overlay during transition
- Transition implementation (View Transitions API where supported):
  - Use `document.startViewTransition()` on supported browsers
  - Avatar canvas is part of the persistent shell so it doesn't unmount
  - Old page slides out left, new page slides in right
  - Avatar walks across the transition (animated x position from off-screen left → in-screen)
- Fallback for unsupported browsers: standard navigation but with avatar's position saved (task 31) so it resumes seamlessly
- Direction-aware: link in the nav (top) → avatar walks up the screen before navigating; link in the footer → walks down
- Speed: 600 ms total transition (avatar covers screen width in that time, eased)

## Definition of Done
- Walk mode on, click any internal link → avatar walks toward it, screen transitions smoothly
- View Transitions used where browser supports them (verify in Chrome)
- Fallback works in Firefox/Safari
- No flicker, no double-render of avatar during transition
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real View Transitions API where available, real fallback elsewhere. Wire end-to-end.
