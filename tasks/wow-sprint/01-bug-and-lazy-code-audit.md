# Task: Codebase bug & lazy-code audit (diagnosis only)

You are a senior engineer doing a cold-eyed audit of the three.ws codebase. Your
job is **diagnosis, not repair** — produce a prioritized, actionable report. Do
not change application code.

## Scope
Focus on the live frontend and API surface:
- `src/**/*.js` (the app modules — `viewer.js`, `home-v4-hero.js`, `agent-home.js`, `pump/**`, `wallet*.js`, etc.)
- `api/**/*.js` (Vercel functions)
- `pages/**/*.html` (entry points wired in `vite.config.js`)

Skip `node_modules`, `dist`, `dist-lib`, `vendor`, and third-party SDK folders.

## What to hunt for
1. **Real bugs** — logic errors, race conditions, unhandled promise rejections, off-by-one, wrong variable, missing `await`, broken conditionals, incorrect API contracts between frontend and `api/`.
2. **Lazy code** — mocks, fake/sample data arrays shipped to prod, hardcoded values that should be dynamic, `setTimeout` fake-loading, stub functions, `throw new Error('not implemented')`, empty `catch {}`, commented-out code, `TODO`/`FIXME`/`// implement later`.
3. **Broken boundaries** — network calls with no error handling at the boundary, user input not validated, missing loading/empty/error states.
4. **Dead code** — run `npx knip` (config at `knip.config.js`) and fold its findings in.

## Method
- Grep for smells: `grep -rn "TODO\|FIXME\|not implemented\|sampleData\|mockData\|fake\|placeholder\|setTimeout(" src api pages --include=*.js --include=*.html`.
- Read the highest-traffic modules in full: `src/home-v4-hero.js`, `src/agent-home.js`, `src/wallet.js`, `src/pump/dashboard.js`, `api/three-token/[action].js`, `api/pump/dashboard.js`.
- Cross-check the existing `ISSUES.md` — note which listed issues are still unfixed.

## Output
Write `tasks/wow-sprint/REPORT-01-audit.md` with a table:

| # | Severity (P0–P3) | File:line | Category | What's wrong | Suggested fix | Effort |

Sort by severity, then by user impact. P0 = users hit it now. End with a
"Top 10 fix-first" shortlist and a one-paragraph health summary.

## Definition of done
- Report file written, every finding has a real `file:line`.
- No application code changed.
- knip output incorporated.
- You'd be comfortable handing this report to the team as the sprint backlog.
