# Task 02 — Reconcile the served `.well-known` manifests with the zero-payment claim (P0)

Read [`00-START-HERE.md`](00-START-HERE.md) first. **This task touches a manifest
that references crypto/x402. The commit gate in `00-START-HERE.md` rule 7 applies:
do the work, but do NOT commit anything that references a non-$THREE crypto project
without explicit owner approval. Flag it in your report instead.**

## The problem (verified, with evidence)

Our OpenAI submission answer sheet
([`prompts/store-submissions/_generated/openai-submission.md`](../../prompts/store-submissions/_generated/openai-submission.md))
asserts the app has a **zero payment surface** and no crypto capability. But a public,
reviewer-discoverable manifest at a well-known path says the opposite.

[`public/.well-known/ai-plugin.json`](../../public/.well-known/ai-plugin.json)
read, until commit `1dbbe0b6d` (2026-08-06) rewrote it (verbatim):

```
"description_for_human": "three.ws — 3D avatar/world generation and live crypto intelligence APIs, pay-per-call via x402.",
"description_for_model": "three.ws exposes a 3D model viewer plus a paid pay-per-call API catalog settled via the x402 protocol (HTTP 402, USDC on Solana and Base): ... The machine-readable catalog with prices and schemas is at https://three.ws/.well-known/x402.json ..."
```

And [`public/.well-known/openapi.yaml`](../../public/.well-known/openapi.yaml) (71KB)
describes the general REST platform (Auth/Avatars/Keys/OAuth/MCP) and does **not**
include the 3D Studio endpoints (`/api/3d/studio`, `/api/ar`, `forge_free`).

An OpenAI reviewer hitting `https://three.ws/.well-known/ai-plugin.json` saw a
crypto/payments pitch, directly contradicting the submission. This was the single
most likely thing to sink the review.

**Where it stands now.** The served manifest leads with the free lane: its
`description_for_human` is "Free, keyless 3D avatar and world generation, plus an
optional paid API catalog for agents.", and `description_for_model` names the free
surface first (`POST /api/3d/studio`, the MCP lane at `/api/mcp-studio`, the viewer,
`/api/ar`, the read-only `/api/crypto` index) and points free-lane callers at
[`public/.well-known/3d-studio-openapi.yaml`](../../public/.well-known/3d-studio-openapi.yaml),
before describing the paid `/api/x402/*` catalog as separate and optional. `logo_url`
is `https://three.ws/pwa-512x512.png` and `legal_info_url` is `/legal/tos`. The
3D Studio schema is served at that path and byte-pinned to
`prompts/store-submissions/_generated/openai-actions.yaml` by
`npm run check:studio-openapi` (`scripts/sync-studio-openapi.mjs` regenerates the copy).
`tests/wellknown-manifests.test.js` asserts the served schema carries no
crypto/payment token and that the platform manifest never advertises the free lane
as paid; `tests/api/3d-studio-openapi.test.js` pins the schema to exactly
`/api/3d/studio` and `/api/ar`, keyless, with the AR parameters `api/ar.js` reads.
`openapi.yaml` still describes the general platform only, which is correct: the free
lane has its own artifact.

## Important scoping decision (this is why the task is delicate)

This manifest is **also a real, live product surface** for the general three.ws
platform and its x402 catalog. It is not junk to be deleted. The `$THREE` /
platform rules in `CLAUDE.md` say the x402 economy and launch directories are real
features, not leaks to be stripped. So the goal is **not** to erase the crypto
platform. The goal is to make sure the OpenAI-facing app is cleanly separable from
it and that the manifest a reviewer reads for the 3D Studio app does not conflate
the two.

Do NOT unilaterally gut the platform manifest. Instead, implement the option below
that keeps both stories true, and surface the decision in your report.

## Your job

Make the OpenAI-app surface and the paid-platform surface cleanly distinct at the
manifest layer. Recommended approach (implement this unless you find it wrong):

1. **Keep the existing platform manifest honest but move it off the bare
   `ai-plugin.json` default if that is what a ChatGPT reviewer keys on.** Confirm
   whether ChatGPT Apps SDK review actually reads `/.well-known/ai-plugin.json`
   (legacy ChatGPT-plugins manifest) at all, or whether the App Directory review is
   driven purely by the MCP connector metadata and the submitted OpenAPI. Document
   what you find with a source. This determines how much the manifest even matters.

2. **The 3D Studio app must have its own, self-describing, payment-free discovery
   artifact.** The custom-GPT OpenAPI already exists at
   `prompts/store-submissions/_generated/openai-actions.yaml` but is not served
   (Task 05 owns serving it). Coordinate with Task 05: the served, discoverable
   schema for the 3D Studio app must describe only `/api/3d/studio` and `/api/ar`,
   with `auth: none`, no x402, no prices, no chain references.

3. **Fix the misleading fields on the platform manifest that a 3D-app reviewer would
   see as conflicting**, without deleting the real x402 catalog:
   - `logo_url` was `favicon.ico` (`ai-plugin.json:14`). The submission cites a
     512x512 owned-IP icon, and the manifest now points at `pwa-512x512.png`;
     `tests/wellknown-manifests.test.js` fails if it ever reverts to the favicon.
   - Make it unambiguous, in both the human and model descriptions, which
     capabilities are free and which are paid, so nothing reads as "the 3D app costs
     crypto." The 3D generation lane IS free and keyless. Say so plainly.

4. **Add a test** asserting that whatever manifest describes the 3D Studio app (the
   served Task-05 schema) contains no payment/crypto tokens. Reuse the regex approach
   already in [`tests/mcp-studio.test.js`](../../tests/mcp-studio.test.js) (it asserts
   the MCP connector is crypto-surface-free) and apply it to the served 3D-app schema.

## What NOT to do

- Do not delete `public/.well-known/x402.json`, the x402 catalog, or the paid
  platform's own manifests. Those are real features.
- Do not strip existing other-coin references as if they were secrets (that
  enforcement is retired per `CLAUDE.md`). The commit gate is about not *committing*
  new non-$THREE references, not about scrubbing the working tree.
- Do not silently change what the paid platform advertises to its own users.

## Constraints

- Every rule in `00-START-HERE.md`, especially the commit gate (rule 7) and
  no-push/no-submit (rule 8).
- If your fix requires editing a file whose diff still references x402/USDC/Solana/
  Base/another chain, prepare the edit, run the tests, and STOP before commit with a
  one-line flag to the owner. Do not commit that diff yourself.

## Verification

- `curl -s https://three.ws/.well-known/ai-plugin.json` (or read the file) and
  confirm the 3D-app story is unambiguous and payment-free where it describes the app.
- The served 3D Studio schema (Task 05) passes the no-crypto-tokens test.
- `npm test` green.
- You can articulate, in one paragraph, exactly what an OpenAI reviewer sees at each
  well-known path and why none of it contradicts the submission.

## Definition of done

- [x] The 3D Studio app has a served, payment-free, self-describing discovery artifact
      (jointly with Task 05): `/.well-known/3d-studio-openapi.yaml`.
- [x] The platform `ai-plugin.json` no longer reads as "the 3D app is a paid crypto
      service"; free vs paid is explicit; logo is a real branded asset.
- [x] A test asserts the 3D-app schema is crypto/payment-free
      (`tests/wellknown-manifests.test.js`, `tests/api/3d-studio-openapi.test.js`).
- [ ] `npm test` green.
- [ ] Any commit that would trip the commit gate is prepared but NOT committed;
      flagged to the owner in your report with the exact diff.
- [ ] Report documents whether ChatGPT App Directory review actually reads
      `/.well-known/ai-plugin.json`, with a source.
