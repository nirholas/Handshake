# TODO — autonomous queue

The scheduled agent should work top-down. Each item is either **agent-doable**
(can be completed in one fresh-context run with what's in the repo + env) or
**human-blocked** (skip and leave a note in STATUS.md).

After each run, the agent should:
1. Pick the top **unchecked + agent-doable** item.
2. Implement it completely per CLAUDE.md (no mocks, no TODOs, no stubs, real
   wiring, real APIs).
3. Commit as `nirholas <nirholas@users.noreply.github.com>`, push to both
   remotes (skip the remote it lacks creds for; surface that in STATUS.md).
4. Check the box here, then append one line to `STATUS.md`:
   `YYYY-MM-DD HH:MM UTC | <commit short sha> | <one-line summary>`.

If every agent-doable item is done, the agent should STOP — do not invent new
work or refactor for the sake of it.

---

## Agent-doable

- [x] **Audit Resend integration end-to-end.** Read `api/_lib/email.js` and
  every caller (auth, siwe, siws, payments evm+solana, cron, newsletter).
  Verify each call site handles the no-API-key case correctly (returns instead
  of throwing), uses the right template, and the templates render valid HTML.
  Write any missing fixture-based unit tests under `tests/email.test.js`. Run
  `npm test` and confirm green before committing.

- [x] **Add `/api/healthz` Resend probe.** Extend the existing healthz endpoint
  to include a `resend: "configured" | "missing" | "key_invalid"` field by
  doing a cheap `GET https://api.resend.com/domains` (or whatever the
  send-only key permits — likely a 401 with `restricted_api_key` is still a
  positive "key valid" signal). Cache the result for 5 min so we don't spam
  Resend. Add a test.

- [x] **Document Persona Hub.** `docs/persona-hub.md` exists but is partial.
  Fill it in: how to generate keys with `scripts/generate-persona-key.mjs`,
  how `/api/auth/persona/issue` and `/verify` work, what `/.well-known/jwks.json`
  publishes, ES256 vs HS256 fallback, example tenant verification code in
  Node + a browser snippet. No new code — pure docs.

- [x] **Stale-TODO sweep.** CLAUDE.md forbids `TODO`, `// implement later`,
  stub functions, and `throw new Error("not implemented")` in shipped code.
  Grep the repo for these patterns (exclude `node_modules`, `dist`, vendor
  directories, and this TODO.md). For each hit: implement it properly, or if
  it's truly out of scope, file it under "Human-blocked" below with the file
  path and a one-line reason. Do NOT delete code to silence the lint — finish
  it or escalate it.

- [x] **Lip-sync test gaps.** `tests/agent-avatar-lipsync.test.js` is new.
  Read it, look at `src/lip-sync-analyser.js` and `src/agent-avatar.js`, and
  identify any obvious behavior not covered (e.g. very short audio, silence,
  multiple back-to-back utterances, browser without `AnalyserNode`). Add
  those tests if missing. Skip cleanly if coverage is already comprehensive.

- [x] **Verify the demo route reorg.** The previous commit moved `/coin` →
  `/demo/coin` and added `/demo/avatar-os/*` and `/demos/*`. Start the dev
  server (`npm run dev`), curl each new route + the legacy redirect from
  `/coin`, confirm 200s and no console errors in the rendered HTML. Document
  the route map in `docs/demo-routes.md`. If a route 404s, fix the
  `vercel.json` rewrite or `vite.config.js` entry that's missing.

## Human-blocked (leave these alone, surface in STATUS.md)

- [ ] **Mirror push to `nirholas/3D-Agent`.** The previous PAT was revoked.
  Codespaces `GITHUB_TOKEN` is scoped to `nirholas/three.ws` only and 403s on
  3D-Agent. A new fine-grained PAT with **Contents: Read and Write** on
  `nirholas/3D-Agent` is required. Until then, every commit lives only on
  `three.ws` and the mirror falls behind. Agent: log this in STATUS.md once
  per run if and only if there are unpushed commits to 3D-Agent.

- [ ] **Verify three.ws as a Resend sending domain.** Requires logging into
  Resend dashboard, adding `three.ws` under Domains, copying the SPF + DKIM
  records, and pasting them into the DNS provider for `three.ws`. Until this
  is done, transactional sends are limited to `nichxbt@gmail.com` and must
  use `onboarding@resend.dev` as the From address.

- [ ] **Set `RESEND_AUDIENCE_ID`.** Requires creating an audience in Resend
  dashboard, copying the UUID, and adding it to Vercel env (production,
  preview, development). Until then, `/api/newsletter-subscribe` no-ops in
  production.

- [ ] **Confirm the test email arrived at `nichxbt@gmail.com`.** Resend
  accepted message id `c21b8917-784e-445c-92f5-958e5ca0c933` but only a human
  can confirm inbox delivery (and that it didn't go to spam — a known issue
  when sending from `onboarding@resend.dev` to a Gmail address with no SPF
  alignment on three.ws).
