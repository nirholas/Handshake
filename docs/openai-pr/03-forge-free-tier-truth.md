# Task 03 — Make the `forge_free` tier story true everywhere (P1, blocks submit)

Read [`00-START-HERE.md`](00-START-HERE.md) first.

## The problem (verified, with evidence)

The submission answer sheet and the code disagree about what quality tier
`forge_free` returns by default.

**The code** ([`api/_mcp-studio/tools.js`](../../api/_mcp-studio/tools.js),
`handleForgeFree`) defaults to `standard` and degrades `high` to `standard` on
402/timeout. Verbatim comment:

```
// Fast free lane by default. The deployed high-tier free engine (Hunyuan3D
// via HF Spaces) blocks the submit for 50-280s with no poll handle, which no
// ChatGPT tool call survives ... True high-by-default lands when the async
// self-host Hunyuan3D worker deploys (GCP_HUNYUAN3D_URL).
const tier = VALID_TIER.has(args.tier) ? args.tier : 'standard';
```

**The submission doc**
([`prompts/store-submissions/_generated/openai-submission.md`](../../prompts/store-submissions/_generated/openai-submission.md))
is internally inconsistent:
- Line ~31 correctly says the tools "default to the standard tier."
- Line ~146 (the tool table) says `forge_free` "Defaults to the highest quality tier
  (dense geometry + PBR textures)."

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

## Definition of done

- [ ] Every doc, the submission sheet, and the tool's own `description` agree with the
      code on the default tier.
- [ ] If Path B: worker deployed and proven with real evidence; default is genuinely
      high.
- [ ] If Path A: no surface claims "highest quality by default" anymore.
- [ ] `npm test` green.
- [ ] `data/changelog.json` entry only if user-visible behavior changed (Path B yes;
      Path A is a docs/accuracy fix, `docs` tag).
- [ ] Report states the path taken and includes the real `forge_free` evidence.
