# Task 03 — Make the `forge_free` tier story true everywhere (P1, blocks submit)

Read [`00-START-HERE.md`](00-START-HERE.md) first.

## The problem (verified, with evidence)

The submission answer sheet and the code disagree about what quality tier
`forge_free` returns by default.

**The code** ([`api/_mcp-studio/tools.js`](../../api/_mcp-studio/tools.js),
`handleForgeFree`) defaults to `standard` and degrades an explicit `high` to
`standard` on a 402 or submit timeout. When this task was written the comment above
that line said the high tier was blocked on an async worker; today it reads
(verbatim):

```
// Standard by default, and every doc describing this tool says exactly that.
// The high tier is a real, working option, not a stub: it runs on our own
// async Hunyuan3D worker (GCP_HUNYUAN3D_URL) behind a genuine poll handle,
// and a live production probe on 2026-08-06 returned a 2.69 MB high-tier GLB
// from backend `hunyuan3d` end to end. It stays opt-in rather than default
...
const tier = VALID_TIER.has(args.tier) ? args.tier : 'standard';
```

The two reasons it stays opt-in are in that comment: the worker is scale-to-zero,
so a cold container adds a spin-up on top of the generation, and the high-tier
access gate is cleared only by the platform seed token (`CRON_SECRET`), so a
deployment without it would quietly serve standard under a "high by default" promise.
A job that outlives `STUDIO_FORGE_TIMEOUT_MS` comes back as a pollable handle, never
an error.

**The submission doc**
([`prompts/store-submissions/_generated/openai-submission.md`](../../prompts/store-submissions/_generated/openai-submission.md))
was internally inconsistent:
- Line ~31 correctly said the tools "default to the standard tier."
- Line ~146 (the tool table) said `forge_free` "Defaults to the highest quality tier
  (dense geometry + PBR textures)."

The tool table row now reads "Defaults to the standard tier (fast, reliable,
textured); the caller may request `draft` (fastest) or `high` (best, slower; falls
back to standard under load)", the tool's own `description` and its `tier` enum
say the same, and the live evidence for both tiers is in
`prompts/store-submissions/_generated/forge-free-tier-evidence.json` (a `d97e8e94d`
attempt to make high the default was rolled back in `b39d6e2f7`).

A reviewer who reads "highest quality tier" and then gets a standard-tier model has
caught us in a misstatement. Pick the honest resolution and make ALL surfaces agree.

## Your job

Choose based on whether the async high-tier worker can actually ship in this cycle.

### Path A (default, low-risk) — Tell the truth: standard by default

The behavior is fine and defensible (fast, reliable, free). Just make every doc and
metadata surface say "standard by default, higher tiers available on request."

1. Fix `openai-submission.md` line ~146 (and any other spot) so the `forge_free`
   description matches the code: standard default, `tier` param lets the caller ask
   for draft or high, high may take longer or degrade under load.
2. Grep every doc for the "highest quality"/"high tier by default" claim and fix each:
   [`docs/mcp-studio.md`](../../docs/mcp-studio.md),
   [`docs/mcp-3d-studio.md`](../../docs/mcp-3d-studio.md), the tool descriptions the
   MCP server itself returns in `tools/list` (check `tools.js` tool metadata strings),
   and `apps-sdk/README.md`.
3. Make sure the tool's own `description` string returned to ChatGPT is accurate, so
   the model never promises "highest quality" to the user.

### Path B — Make high-by-default real

Only if the async self-host Hunyuan3D worker (`GCP_HUNYUAN3D_URL`) can be deployed
and proven within this cycle. This is the "never downgrade quality" ideal, and GCP
GPU spend is pre-approved (`CLAUDE.md` standing resource approvals).

1. Deploy the async Hunyuan3D worker with a real poll handle (submit returns a job id
   immediately, poll returns progress, never blocks 50-280s). Its own
   `workers/<name>/cloudbuild.yaml`, service accounts pinned per `CLAUDE.md`.
2. Wire `handleForgeFree` to use it for the high tier with a real submit/poll flow
   that a ChatGPT tool call survives, and flip the default to `high`.
3. Prove it: a real `forge_free` call with no tier returns a high-tier GLB, end to
   end, no timeout, no degrade. Capture the evidence JSON.
4. THEN the "highest quality by default" doc language becomes true and can stay.

Deploying a worker is not a reason to stop (`CLAUDE.md` self-unblock). But if the
worker cannot be proven this cycle, do Path A. Do not leave a half-deployed worker
and a doc claiming it works.

## Constraints

- Every rule in `00-START-HERE.md`.
- No mock/fake generation. The evidence must be a real GLB from the real lane.
- This is not a crypto surface; commit gate does not apply.

## Verification

- `grep -rni "highest quality\|high.*by default\|high tier" prompts/store-submissions docs apps-sdk/README.md api/_mcp-studio`
  returns only statements that match the shipped behavior.
- A real `forge_free` call against `/api/mcp-studio` returns a tier consistent with
  every doc. Save the response JSON as evidence.
- `npm test` green (run `tests/mcp-forge-free.test.js` and `tests/mcp-studio.test.js`).
  Note which server each covers: `tests/mcp-studio.test.js` is the ChatGPT-facing
  `/api/mcp-studio` tool (standard default). `tests/mcp-forge-free.test.js` is the
  public `mcp-server` package's `forge_free` (`mcp-server/src/tools/forge-free.js`),
  which defaults to `draft` and no longer pins a backend: the forge router's own
  free-lane default (self-host TRELLIS, then Hunyuan3D, then HuggingFace, then NVIDIA
  NIM as the last resort) picks the engine, never the paid Replicate lane.

## Definition of done

- [x] Every doc, the submission sheet, and the tool's own `description` agree with the
      code on the default tier (Path A: standard by default, high opt-in; the async
      Hunyuan3D worker from Path B is deployed and proven, but the default stays
      standard for the reasons in the code comment).
- [ ] If Path B: worker deployed and proven with real evidence; default is genuinely
      high.
- [x] If Path A: no surface claims "highest quality by default" anymore.
- [ ] `npm test` green.
- [ ] `data/changelog.json` entry only if user-visible behavior changed (Path B yes;
      Path A is a docs/accuracy fix, `docs` tag).
- [ ] Report states the path taken and includes the real `forge_free` evidence.
