# Task: Eradicate mocks, fake data, and stubs (enforce the hard rules)

CLAUDE.md forbids mocks, fake data, placeholders, stub functions, fake-loading,
and fallback sample arrays in shipped code. Find every violation in the live app
and replace it with a real implementation.

## Scope
`src/**/*.js`, `api/**/*.js`, `pages/**/*.html`. Skip `node_modules`, `dist*`,
`vendor`, `tests/**`, and `*.test.js` / `*.spec.js` (test fixtures are allowed to
use fakes).

## Find the violations
```
grep -rn "sampleAgents\|sampleData\|mockData\|MOCK\|fakeData\|placeholder\|DUMMY\|hardcoded\|TODO\|FIXME\|not implemented" src api pages --include=*.js --include=*.html
grep -rn "setTimeout(.*\(loading\|progress\|fake\)" src --include=*.js
grep -rn "throw new Error(['\"]not implemented" src api --include=*.js
```

## Fix each one properly
- **Sample/fallback arrays** → real `fetch` from the correct `api/` endpoint with loading + error states. The token data lives behind `api/three-token/[action].js` (stats/burns/activity, Birdeye + Pump.fun) and `api/pump/*`. The $THREE mint is `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`.
- **Fake loading (`setTimeout`)** → wire to the real async operation; show a skeleton until it resolves.
- **Stub functions / `not implemented`** → implement fully, or delete if genuinely unreachable (confirm with grep first).
- **Hardcoded values that should be dynamic** → source them from config/env/API.
- **Empty `catch {}`** → handle at the boundary (surface a real error state) or let it throw if internal.

## Constraints
- Never introduce a new mock to "fix" a mock. Real APIs only.
- If a real endpoint is missing for some data, build the endpoint in `api/` — don't fake it.
- If credentials are missing, check `.env.example` and `.env`; proceed with what exists.

## Definition of done
- The grep patterns above return zero shipped-code hits (test fixtures excluded).
- `npm run dev` (port 3000): every touched view loads real data, no console errors.
- Run the **completionist** subagent on your changed files; fix everything it flags.
- Report the list of violations found and how each was resolved.
