# Task: Dead path, broken link & non-working button audit + fix

CLAUDE.md: "If a button exists, it must work. If a link exists, it must go
somewhere. If a state exists, there must be a way to reach it." Make that true.

## Scope
All entry points in `pages/**/*.html` and `public/**/*.html` that are wired in
`vite.config.js` (see the `input` map and the dev `/route` map around lines
160–520), plus their `src/*.js` controllers.

## Method
1. Enumerate every `<a href>`, `<button>`, and click handler in the page set. Build a list of every navigation target and action.
2. For each link: confirm the target route/file exists (cross-reference `vite.config.js` inputs and `pages/`/`public/`). Flag 404s, `href="#"` with no handler, and dangling anchors.
3. For each button/handler: confirm it's wired to a real function that does something. Flag no-op handlers, handlers that reference undefined functions, and disabled controls with no path to enable.
4. For each declared UI state (modals, tabs, panels): confirm there's a user path to reach it.
5. Start `npm run dev` and click through the top pages: `home`, `marketplace`, `agent-home`, `dashboard`, `pump-dashboard`, `pricing`, `skills`.

## Fix
- Broken internal link → point it at the correct existing route, or remove the link if the destination shouldn't exist.
- Dead button → wire it to the real action. If the action belongs to an unbuilt feature, implement the minimal real version (no stubs) or remove the control.
- Unreachable state → add the trigger, or delete the dead state.

## Definition of done
- Every link on the audited pages resolves; every button does real work.
- `npm run dev`: clicked through all top pages, no console errors, no dead clicks.
- Run the **completionist** subagent on changed files.
- Report: list of dead paths found and the resolution for each.
