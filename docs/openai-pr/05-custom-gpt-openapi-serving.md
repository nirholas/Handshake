# Task 05 — Serve the custom-GPT OpenAPI and align legal URLs (P1)

Read [`00-START-HERE.md`](00-START-HERE.md) first. Coordinate with Task 02 (the
served schema must be payment-free) and Task 04 (a contract test binds to it).

## The problem (verified, with evidence)

The custom-GPT Actions schema
([`prompts/store-submissions/_generated/openai-actions.yaml`](../../prompts/store-submissions/_generated/openai-actions.yaml),
OpenAPI 3.1.0, `title: three.ws 3D Studio`) exists but is **not served anywhere
machine-discoverable**. It lives only under `prompts/store-submissions/_generated/`.

Meanwhile the served `public/.well-known/openapi.yaml` describes the general REST
platform and does NOT include `/api/3d/studio`, `/api/ar`, or `forge_free`. So the
machine-readable schema an OpenAI reviewer or the GPT Actions runtime can fetch does
not describe the 3D Studio GPT at all.

Additionally, the legal URLs inside `openai-actions.yaml` use `.html` suffixes
(`https://three.ws/legal/privacy.html`, `.../legal/tos.html`) while the submission doc
verifies the live URLs without `.html`. Both forms currently resolve (verified:
`vercel.json` rewrites `/legal/privacy/?` to `/legal/privacy.html`, and the `.html`
file is served directly), but the inconsistency is sloppy for a submission and should
be normalized to one canonical form.

## Your job

1. **Serve the 3D Studio OpenAPI at a stable, discoverable path.** Put the served
   copy where the GPT Action and a reviewer can fetch it over https, e.g.
   `public/.well-known/3d-studio-openapi.yaml` (or a `/api/3d/openapi.yaml` route).
   Pick the path that fits how this repo already serves the other `.well-known`
   schemas and wire it in `vercel.json` if a route is needed. Do NOT overwrite the
   platform's existing `public/.well-known/openapi.yaml`.

2. **Make the served 3D Studio schema self-contained and payment-free.** It must
   describe only `/api/3d/studio` (POST submit, GET poll) and `/api/ar`, with
   `auth: none`, no x402, no prices, no chain references. This is the artifact Task 02
   points at as the app's clean discovery surface.

3. **Single source of truth.** The served schema and
   `prompts/store-submissions/_generated/openai-actions.yaml` must not drift. Either
   generate the `_generated` copy from the served one (preferred, matches the
   `_generated/` build-script convention already in that dir) or make one a copy of
   the other with a script/check. Do not hand-maintain two copies.

4. **Normalize the legal URLs.** Pick the canonical form the rest of the submission
   uses (the no-`.html` form, e.g. `https://three.ws/legal/privacy`,
   `https://three.ws/legal/tos`) and use it consistently in the served schema, the
   `_generated` copy, and `openai-submission.md`. Confirm every legal URL you cite
   returns 200 (both `privacy` and `tos` at minimum).

5. **Lint it.** `npx @redocly/cli lint <served-schema>` must pass clean (the TRACKER
   claims the `_generated` copy already lints clean; keep it that way for the served
   one).

## Constraints

- Every rule in `00-START-HERE.md`. The served schema must pass Task 02's
  no-crypto-tokens test, so keep it strictly the two free endpoints.
- Not a crypto surface if you keep it clean; just do not paste x402 content into it.
- If you add a `vercel.json` route, remember `vercel.json` is a LIVE config consumed
  by the server (`CLAUDE.md`); edit it carefully and keep the route table valid.

## Verification

- The served schema is fetchable (`curl` the local dev server or read the built
  `dist/` copy) and validates with `@redocly/cli lint`.
- Every legal URL in the schema returns 200 (test both privacy and tos).
- Task 04's contract test validates a real `api/3d/studio.js` response against it.
- `npm run build:pages` / the normal build still succeeds; `npm test` green.

## Definition of done

- [ ] The 3D Studio OpenAPI is served at a stable https path, describing only the two
      free endpoints, `auth: none`, no payment/crypto content.
- [ ] The served copy and the `_generated` copy are kept in sync by a script or check,
      not by hand.
- [ ] All legal URLs normalized to one canonical form and verified 200.
- [ ] Schema lints clean.
- [ ] `npm test` green; build succeeds.
- [ ] `data/changelog.json` entry (`docs` or `infra` tag) since a new public schema
      path is developer-visible; add the route to `data/pages.json` only if it is a
      human page (a raw schema usually is not).
