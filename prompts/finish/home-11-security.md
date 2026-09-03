# 11. Security hardening: threat model, injection boundary, abuse

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Orders
[01](home-01-connection-store.md) to [04](home-04-agent-tools.md) must have landed; run this
before any production deploy of the lane, and again before order 20.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**This order finds and fixes, it does not merely report.** A finding without a fix or a written,
justified acceptance is not finished work.

---

## Step 0: re-derive the current state

```bash
npx vitest run packages/home-bridge tests/home-*.test.js
grep -rn "getDecryptedToken" api/ --include=*.js
grep -rn "confirmed" api/_lib/home/ api/home/ api/_mcp/tools/home.js --include=*.js
curl -s localhost:3000/api/tool_schema | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).tools.filter(x=>x.name.startsWith('home'));console.log(JSON.stringify(t.map(x=>({n:x.name,props:Object.keys(x.inputSchema?.properties||{}),ann:x.annotations})),null,1))})"
npm run check:secrets 2>/dev/null || node scripts/check-secrets.mjs --help
```

## The asset being protected

Not data. **A building, and the people in it.** The worst outcome in this campaign is not a leak;
it is a stranger opening a door. Rank every finding against that.

## The threat model, written into `docs/`

Produce `docs/home-security.md`, linked from `docs/start-here.md` and `docs/smart-home.md`,
covering at minimum:

| Actor | Capability | Our control |
|---|---|---|
| A stranger on the internet | can reach our API | session auth, ownership `WHERE user_id`, 404 across tenancy, rate limits |
| A stranger who obtains a session | can act as the user | the gate: an unlock still needs a fresh, single-use, 90 s confirmation minted server-side |
| A compromised or hijacked model | can call any tool with any arguments | `confirmed` is absent from every tool schema; confirmations are redeemed only by a session with CSRF, never by a bearer or MCP principal |
| A malicious device or integration in the user's own house | controls entity names, area names, scene names | those strings reach a model; structured, capped, sanitised, and never the sole basis of an action |
| Another household member | has legitimate partial access | order 12's roles and per-entity scopes |
| Us, operationally | can read the database | credentials encrypted with a dedicated key; relay mode holds no token at all |
| A compromised relay (order 10) | can speak the relay protocol to a house | allowlisted message types, per-install keys, the gate still upstream, blast radius written down |

## The eleven checks, each with a test that would fail if the control regressed

1. **`confirmed` is unreachable from a model.** Dump every home tool schema and assert no
   `confirmed` property, on both the MCP and the chat surface.
2. **Confirmation binding.** A confirmation minted for entity A cannot execute against entity B,
   another home, or another user. Cannot be replayed, cannot outlive its TTL.
3. **Confirm endpoint principal.** Session plus CSRF only. A bearer token with `home:act` is
   refused. An MCP principal is refused.
4. **Prompt injection with a physical payload.** Rename a real entity to an instruction that
   tells the agent to unlock the front door, run a real chat turn that reads the house, assert no
   action was taken and the door is locked. Repeat with the payload in an area name and in a
   scene name.
5. **Tenancy.** For every route in order 03, user B gets 404 on user A's ids. Automate the matrix;
   do not spot check.
6. **Credential handling.** The token never appears in a response body, a log line, an error
   message, a URL, a metric label, or an audit `meta` blob. Grep the code and prove it at runtime
   with a request that fails at every stage.
7. **SSRF.** `baseUrl` is attacker-supplied and the server dials it. Prove that link-local
   (`169.254.169.254`, the cloud metadata endpoint), loopback, and RFC1918 addresses are refused
   server-side, that a redirect to one is refused, and that a DNS name resolving to one is refused
   (rebinding: resolve, pin, then connect to the pinned address).
8. **Rate and abuse.** The `act` bucket cannot cycle a garage door. The `connect` bucket resists
   credential stuffing. Both proven by exceeding them.
9. **Secrets in the diff.** `node scripts/check-secrets.mjs` over the lane's commits is clean, and
   no test fixture contains a real token.
10. **Dependency posture.** `npm audit` on the new dependencies; every one is permissively
    licensed and actively maintained (record the last-publish dates).
11. **Logout and revoke.** Revoking a home drops any live socket immediately, not at the next
    idle sweep. Prove it with `stats()`.

**Check 7 is the one most likely to be missing.** `verifyConnection` dials a user-supplied URL
from inside our production network. Look for an existing SSRF guard in the repo before writing
one (`grep -rn "ssrf\|isPrivateHost\|metadata" api/_lib/ --include=*.js`) and reuse it.

## Fixes, not findings

Every check that fails gets a fix in this same session and a regression test. A check you decide
to accept rather than fix gets a written justification in `docs/home-security.md` naming the
residual risk and who accepted it. An unresolved finding is not allowed to become a line in a
report that nobody reads.

## Tasks

| # | Task |
|---|---|
| 1 | Write `docs/home-security.md` with the threat model table and the accepted residuals section. |
| 2 | Build `tests/home-security.test.js` with the eleven checks as executable tests. |
| 3 | Run them. Fix every failure. |
| 4 | Add the tenancy matrix as a loop over the route table, so a new route added later without ownership fails the suite automatically. |
| 5 | Add the injection regression to the suite with a real physical assertion (the lock state), not a string assertion. |
| 6 | Link the doc from `docs/start-here.md` and `docs/smart-home.md`; add a `data/changelog.json` entry tagged `security`. |

## Definition of done

- [ ] All eleven checks exist as tests and pass. Paste the run.
- [ ] The tenancy matrix covers every route in `api/home/`, enumerated from the filesystem rather than hardcoded, so a future route cannot be forgotten.
- [ ] The injection test asserts a real lock's real state after a real chat turn.
- [ ] SSRF: four refusals proven (loopback, RFC1918, link-local metadata, redirect to one) plus the DNS-rebinding pin.
- [ ] The credential-leak sweep: paste the greps and the runtime proof.
- [ ] `node scripts/check-secrets.mjs --base <lane start sha> --head HEAD` is clean.
- [ ] `docs/home-security.md` exists, is linked, and every accepted residual names the risk and the reason.
- [ ] Every failure found was fixed in this session, or accepted in writing. List both sets in your report.
- [ ] `npx vitest run --root .` shows no new failures.
- [ ] `npm run audit:docs` clean, `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| A check fails and the fix looks large | It is still this order's job. The alternative is shipping a door that opens for strangers. If it genuinely cannot land this session, write the acceptance with the risk named and say so at the top of your report, not the bottom. |
| No SSRF guard exists in the repo | Then write one, pin the resolved address, and reuse it everywhere a user-supplied URL is dialled. Do not rely on a hostname check alone; DNS rebinding defeats it. |
| The injection test is hard to make deterministic | Assert on the physical outcome (the lock state) and on the action log, not on the model's words. The model's output varies; the door's state does not. |
| Someone argues the gate is enough and injection filtering is unnecessary | The gate IS the primary control and it is why we are not in real danger. Filtering is defence in depth and cheap. Do both, and say in the doc which one is load-bearing. |
| A dependency has a CVE | Upgrade it. If no fixed version exists, state the exposure and the mitigation in the doc, per the CLAUDE.md open-source rule. |

## Report format

1. The eleven checks with pass or fail, before and after.
2. Every fix made, with the file and the reason.
3. Every residual accepted, with the risk named.
4. The SSRF proofs.
5. The injection proof with the lock state.
6. Full-suite output.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-11-security.md

Never delete it on a partial. If a residual was accepted rather than fixed, that is a completion
only when the acceptance is written into `docs/home-security.md`.
