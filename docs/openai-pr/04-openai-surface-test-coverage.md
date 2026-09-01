# Task 04 — Close the test gaps on the ChatGPT-facing surface (P1)

Read [`00-START-HERE.md`](00-START-HERE.md) first.

## The problem

The core logic is well tested (`tests/mcp-studio.test.js`, `tests/ar-export.test.js`,
`tests/embodiment-*.test.js`), but three surfaces a reviewer will actually hit have
**no test on the surface itself**, only on the pure functions beneath them. For a
submission to OpenAI, the HTTP-visible behavior must be pinned so a refactor cannot
silently break what the reviewer sees.

### Gap 1 — `api/ar.js` HTTP handler is untested

`api/ar.js` is the "View in your space" / "Bring it to life" endpoint every generation
links to. Only the pure lib `api/_lib/ar-launch.js` was tested (`tests/ar-export.test.js`).
The handler's own behavior was unverified:
- User-agent branching (Android → Scene Viewer 302 intent; iOS/desktop → a 200
  interstitial carrying the model's own og:image and title for unfurls, which hands
  off to `/ar/view`, where a real USDZ is generated on the device for Apple Quick
  Look; `kind=avatar` → everyone, Android included, lands on `/ar/view` with the IRL
  handoff).
- The designed error page for a bad/missing `src`.
- `assertArAssetUrl` rejection (non-https, non-`.glb/.gltf`) surfacing as a proper
  error response, not a crash.
- `Vary: user-agent` and cache headers.

Write `tests/api/ar-endpoint.test.js` that invokes the handler with mocked requests
for each UA class and asserts status, `Location`/redirect, headers, and that the HTML
launch page contains the model URL and the AR launch elements. Follow the request/
response mocking pattern used by the other `tests/api/*.test.js` files in this repo.

Closed: [`tests/api/ar-endpoint.test.js`](../../tests/api/ar-endpoint.test.js) covers
the Android redirect and its `no-store`, the iOS/iPad/desktop interstitial with the
title and the forwarded host carried through, the `kind=avatar` handoff, the designed
400 page for every bad-input class (including `.gltf` lookalikes), `Vary: user-agent`,
the CORS preflight, and an absent User-Agent.

### Gap 2 — `pages/embodiment/embed.html` wiring is untested

The persona widget iframes this page. Its param parsing (`persona/glb/name/state/
text/emotion/...`), the `GET /api/mcp3d/persona?id=` resolve, and the fallback when a
persona cannot be resolved are unverified. Add a test (jsdom or Playwright, match what
the repo already uses for page-level tests) that:
- Loads the page with `?glb=&name=` and asserts the stage mounts and the name renders.
- Loads with `?persona=<id>` against a mocked persona endpoint and asserts it resolves
  and renders.
- Loads with an unresolvable persona and asserts the designed error/empty state, not a
  blank void or console error.

Closed on two levels: [`tests/api/embodiment-embed-page.test.js`](../../tests/api/embodiment-embed-page.test.js)
pins the page's wiring contract (the documented query params, the persona resolve and
its failure surface, the designed error when neither `glb` nor `persona` is supplied,
the opt-in `wallet=1` identity poll, and that a resolved persona's name survives every
later state change instead of reverting to "Agent"), and
[`tests/e2e/embodiment-embed.spec.js`](../../tests/e2e/embodiment-embed.spec.js)
loads the page in a real browser.

### Gap 3 — No contract test binding `api/3d/studio.js` to `openai-actions.yaml`

The custom-GPT Actions response shape (`{status:'done', glbUrl, viewerUrl, arUrl,
format, previewImageUrl?, tier?}` or `{status:'pending', job, poll, watchUrl,
previewImageUrl?, tier?, etaSeconds?}`) must match the served OpenAPI schema (Task 05
serves it). Add a contract test that loads the OpenAPI schema and validates a real
`api/3d/studio.js` response object against it (the response-shaper is pure and
exported per the file). Use an existing JSON-schema/OpenAPI validator already in
`package.json` if present; do not add a heavy new dependency for this.

Closed: [`tests/api/3d-studio-actions-contract.test.js`](../../tests/api/3d-studio-actions-contract.test.js)
compiles the served
[`public/.well-known/3d-studio-openapi.yaml`](../../public/.well-known/3d-studio-openapi.yaml)
with `ajv` (2020-12 draft, plus `ajv-formats`, both already dependencies) and validates
the exported `shapeSubmit` / `shapePoll` output for the inline-done, queued, running,
finished, failed, and transient-hiccup states, plus every typed error envelope (400
`invalid_prompt`, `invalid_tier`, `prompt_rejected`, `bad_request`, `missing_job`,
`invalid_job`; 429 `rate_limited` with `retry_after`; 502 `generation_failed`; 503
`not_configured`) against the schema's `GenerationState` and `ErrorResponse`.

## Constraints

- Every rule in `00-START-HERE.md`. No mocked *generation* results that pretend to be
  real GLBs where the test claims to exercise the real lane; where you must stub the
  forge call, stub at the network boundary and label it clearly, and keep at least one
  path that asserts the real shape.
- Match the existing test style, imports, and helpers. Read a neighboring
  `tests/api/*.test.js` before writing.
- Not a crypto surface; commit gate does not apply.

## Verification

- `npm test` green, with your three new test files running and passing.
- Deliberately break each surface locally (e.g. change a header in `api/ar.js`) and
  confirm the new test catches it, then revert. Report that you did this.

## Definition of done

- [x] `tests/api/ar-endpoint.test.js` covers all UA classes, the error page, and
      headers.
- [x] A page-level test covers `pages/embodiment/embed.html` param parsing, persona
      resolve, and the failure state.
- [x] A contract test binds `api/3d/studio.js` output to the served OpenAPI (coordinate
      with Task 05 for the schema location).
- [ ] `npm test` green.
- [ ] Each new test demonstrably fails when its target is broken (verified, then
      reverted).
- [ ] No changelog entry needed (tests are internal) unless you also fixed a bug found
      while writing them, in which case that fix gets an entry.
