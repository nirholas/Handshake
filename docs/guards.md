# Repository guards

This repository has no CI. GitHub Actions is unavailable on this account, so nothing runs your code when you open a pull request, and nothing blocks a bad merge. What protects the codebase instead is a set of small, fast, local guards wired into paths you cannot skip: the prebuild, the gate, the deploy build, and the git pre-push hook.

This page explains what each guard protects, when it runs, and how to add one. Everything here tracks [`data/guards.json`](https://github.com/nirholas/three.ws/blob/main/data/guards.json), and [`scripts/audit-guards.mjs`](https://github.com/nirholas/three.ws/blob/main/scripts/audit-guards.mjs) checks the two against each other on every gate run: every stage claim has to be true against the real npm chains, and every registered guard has to appear in a table below. So neither the stage column nor the guard list can quietly go stale.

Browse the same data as an interactive page at [/guards](/guards).

---

## The one rule

**A guard that is not wired into an unavoidable path protects nothing.**

Every failure this system exists to prevent had a checker that could have caught it. In several cases the checker already existed and simply was not run: eight working audit scripts sat in `scripts/` with no npm script at all, discoverable only by reading the directory. One of them stated in its own header that it was "wired as `npm run audit:console`" when no such script existed.

So the rule for adding a guard is not "write a checker." It is: **write the checker, then give it a home in a stage that runs whether or not anyone remembers it.**

---

## The stages

Guards are grouped by when they run, cheapest first.

### Prebuild

Runs on every `npm run build`, automatically.

These regenerate the page index and then immediately re-audit it, so a page cannot be advertised in `data/pages.json` and unreachable in the same build. Nothing to invoke by hand.

### Gate

```bash
npm run gate
```

The composite correctness sweep, and the one command to run before you call a feature done. It chains the CLAUDE.md truth check, the critical-path tests, and every offline audit.

Order is deliberate: the merge-conflict scan runs first because it costs seconds while the test stage costs minutes, and a conflict marker is a syntax error that neither eslint nor vitest will catch.

Do not pipe the gate through `head` or `tail`. Doing so closes the pipe early and npm exits with a broken-pipe error that looks exactly like a real failure. Redirect to a file instead:

```bash
npm run gate > /tmp/gate.log 2>&1; echo "exit=$?"
```

### Deploy build

```bash
npm run build:gcp
```

Guards that can only judge a finished artifact: whether a Node-only module leaked into the browser bundle, whether `dist/` holds every file the image needs, and whether every declared page resolves against the real route table.

The order inside this chain is load-bearing. The frontend build empties `dist/`, so everything that writes into it must come after. `build:gcp` already encodes the correct order, and `npm run check:claude` verifies that the runbook in `CLAUDE.md` still describes it accurately.

### Pre-push

Runs automatically on `git push`. Installed into `.git/hooks` by [`scripts/setup-git-hooks.mjs`](https://github.com/nirholas/three.ws/blob/main/scripts/setup-git-hooks.mjs), which `postinstall` runs on every `npm install`, so a fresh clone is covered without a setup step.

The hook checks the CLAUDE.md hard rules against **exactly the commits being pushed**, using the remote and local shas git hands it on stdin:

```
node scripts/check-rules.mjs --base <remote sha> --head <local sha>
```

That scoping is the whole design. Several agents share this working tree, so a check against the worktree would block your push over somebody else's half-finished file. Diffing two commits sees only your work. It also means a violation introduced and fixed within the same push range does not block, because the two-endpoint diff shows the net result.

For the same reason the hook deliberately runs **only** this check, never `npm run gate`: the gate audits worktree state, and a requested push must not fail because of another agent's in-flight work.

Emergency bypass:

```bash
SKIP_PUSH_CHECKS=1 git push
```

### On demand

Guards that need a browser, live credentials, or a network round trip. They cannot sit on an automatic path without making it flaky, so each one has an npm script and you run it when you touch the area it covers.

---

## The guards

Run `npm run audit:guards` to print the current count and per-stage breakdown. The full table below is the same data as [`data/guards.json`](https://github.com/nirholas/three.ws/blob/main/data/guards.json).

### Correctness of the repo itself

| Guard | Command | Protects |
|---|---|---|
| Merge-conflict markers | `npm run check:conflicts` | No unresolved conflict marker can be built or deployed. |
| CLAUDE.md truth check | `npm run check:claude` | Every script, path, count, and runbook step named in CLAUDE.md matches the repo. |
| Vendored worker modules | `npm run check:vendored` | Every copy of a shared worker module (`worker_security.py`, `oin.py`, `oin_upload.py`, `gltf_meshopt.py` and its test) is byte-identical across all workers. |
| No unbounded outbound call | `npm run check:fetch-timeouts` | Every fetch to a third-party host carries a deadline, so one stalled upstream cannot hold a request until the platform kills it. |
| Hard rules, diff scoped | `npm run check:rules` | The CLAUDE.md hard rules on the lines you changed. |
| The guard registry | `npm run audit:guards` | Every guard is registered and every stage claim is true. |
| Design-token ratchet | `npm run audit:tokens` | Hardcoded colour hexes cannot creep back past a committed baseline. |
| Credential material | `npm run check:secrets` | No dotenv file, private key, keystore, or downloaded cloud credential becomes a tracked file, and no added line carries a provider-issued key. |
| iOS app icon | `npm run check:ios-icons` | The committed iOS icon and launch images are exactly what the current brand mark produces, and the icon carries no alpha channel. |
| macOS app icon | `npm run check:macos-icon` | The ten committed Mac icon sizes and their Contents.json are exactly what the current brand mark produces. |
| Apple glance widget | `npm run check:apple-widget` | Both Xcode projects that build the Agent glance widget are consistent, every shared Swift source belongs to the targets that need it, and the Swift client still agrees with `api/glance/mine.js` on the endpoint, the headers, the states, the sizes and the token shape. |

### Routing and pages

| Guard | Command | Protects |
|---|---|---|
| Route documentation | `npm run audit:pages` | Every human-facing route is documented in `data/pages.json`. |
| Declared pages resolve | `npm run check:pages` | Every page declared in `data/pages.json` is actually reachable. |
| Routing and 404 model | `npm run audit:routes` | Catalog pages reachable, unknown paths reach the designed 404, no shadowed routes. |
| Route shadowing | `npm run audit:route-shadowing` | Every handler under `api/` that looks routed can actually be reached through the production router's walk of `vercel.json`. |
| API handlers export a body | `npm run audit:handlers` | No API handler ships empty or without an export. |
| The `[hidden]` guard | `npm run audit:hidden-guard` | Every page resolves the CSS that makes `hidden` actually hide. |
| Site link integrity | `npm run audit:links` | Every navigable target resolves to a real route or file. |

### Docs and contracts

| Guard | Command | Protects |
|---|---|---|
| Documentation integrity | `npm run audit:docs` | No dead relative link, no command naming a missing script, no package without a README. |
| Upstream resilience ratchet | `npm run audit:upstreams` | No new call to a third-party service without a deadline, and no existing one quietly getting weaker. |
| Tutorial reachability | `npm run check:tutorials` | Every tutorial appears in the library manifest, has its markdown on disk, and is registered in `data/pages.json`. |
| Runnable doc samples | `npm run check:runnable-docs` | Every sample a reader can press Run on still returns what the doc says it returns. |
| Doc figures | `npm run check:doc-media` | Every figure a doc points at was really captured, still matches its recipe, and carries alt text. |
| Tour atlas truth | `npm run audit:tour-atlas` | `public/tour/atlas.json` matches a fresh render: every stop resolves, every promised screenshot exists, and the page's own copy (`data/pages.json`, `pages/tour-atlas.html`) advertises the number of stops the atlas actually has. |
| x402 endpoint catalog | `npm run audit:x402-catalog` | Every paid endpoint is documented, so a buyer can find it. |
| MCP manifests | `npm run audit:mcp` | Every MCP manifest satisfies the official registry's rules, offline. |
| MCP golden contracts | `npm run audit:mcp-golden` | Tool names, descriptions, and schemas against a committed snapshot. |
| MCP safety annotations | `npm run audit:mcp-safety` | Declared `readOnlyHint` and `destructiveHint` match what handlers do. |
| MCP tool catalog freshness | `npm run audit:mcp-catalog` | `public/mcp-catalog.json` matches what the MCP servers actually expose. |
| MCP directory listing source | `npm run audit:mcp-listing` | The one file every third-party MCP directory listing is written from still matches the manifests, and no new server lands without listing copy. |
| 3D Studio OpenAPI sync | `npm run check:studio-openapi` | The Actions file in the OpenAI submission kit is byte-identical to the OpenAPI schema the site serves. |
| Live event window | `npm run check:event` | `public/event.json` describes an event that will actually happen, on every surface that reads it. |
| Cron schedule drift | `npm run check:cron-syntax`, `npm run check:cron-drift` | Valid expressions, and agreement with the running Cloud Scheduler jobs. |

### Build and deploy

| Guard | Command | Protects |
|---|---|---|
| Browser bundle purity | `npm run check:browser-graph` | No Node-only module leaks into the browser bundle. |
| Bootstrap ordering | `npm run check:tdz-bootstrap` | No page calls its own entry point above the state that entry point writes, which renders fine in Chrome and throws in every Safari. |
| Build output shape | `npm run check:dist` | `dist/` contains every artifact the deploy expects. |
| Deploy artifact preflight | `npm run audit:deploy` | The artifact failure classes that have taken production down. |
| Cloud Build upload | `npm run check:gcloudignore` | What `gcloud builds submit` would actually upload. |

### Runtime, assets, and money

| Guard | Command | Protects |
|---|---|---|
| CSP-safe inline markup | `npm run audit:inline-handlers` | No served HTML carries an inline event handler attribute or a `javascript:` URL. |
| Live CSP sweep | `npm run audit:csp` | No page violates the Content-Security-Policy the server sends with it, and every response carries the security headers `vercel.json` declares. `--headers-only --base https://three.ws` checks the header half against a live origin with no browser. |
| Console sweep | `npm run audit:console` | A clean browser console on every route, desktop and mobile. |
| `/play` failure modes | `npm run audit:play-failures` | `/play` stays usable when its dependencies fail, and hostile deep-link params never execute. |
| Overlapping fixed overlays | `npm run audit:overlays` | No persistent floating widget can cover another one's controls. |
| Image loading attributes | `npm run check:images` | Every JS-rendered image sets `loading` and `decoding`. |
| Wardrobe catalog integrity | `npm run audit:garments` | Every garment validates and its GLB hash matches its manifest. |
| Rig coverage | `npm run audit:rig-coverage` | How well the canonicalizer maps skeletons actually stored in production. |
| Service wallet configuration | `npm run audit:service-wallets` | Balances, floors, and whether the advertised x402 fee payer matches the real secret. |
| Fleet wallet flows | `npm run audit:wallet-flows` | Where the platform's SOL is, where it went, and whether any is leaking. |
| Relayer balances | `npm run check:relayer-balances` | Every configured Solana signer is above its documented minimum. |
| LLM spend metering | `npm run audit:llm-metering` | Every LLM lane that spends money reports a real cost, never exactly $0 and never an unknown. |
| Cron liveness | `npm run audit:cron-liveness` | Each cron in `vercel.json` resolves to a handler that exists, imports, answers a live request, and refuses an unauthenticated one. |
| Custodial key health | `npm run audit:custodial-keys` | Every stored custodial Solana secret still decrypts under the current `WALLET_ENCRYPTION_KEY`. |
| Home credential health | `npm run audit:home-credentials` | Every stored Home Assistant token still decrypts under the current `WALLET_ENCRYPTION_KEY`, so no connected house is sealed. |
| Hands-free voice loop | `npm run check:home-voice` | Nothing about listening loads before opt-in, an ambient "yeah" never confirms a guarded action, and the agent does not wake itself. |
| Delegation contract addresses | `npm run check:erc7710` | Every delegation-manager address is a deployed contract. |
| Connector reviewer path | `npm run audit:mcp-reviewer` | Every paid tool on the published stdio server answers an unpaid call with a clean, priced x402 challenge, and the reviewer entitlement lifts the paywall only for the right secret. |

---

## Design principles

These are the rules the existing guards follow. A new guard that breaks one of them tends to get switched off, which leaves you worse off than having no guard at all.

**1. Be diff scoped when the rule is new.** Thousands of tracked files predate the typography rules. A repo-wide sweep would produce a diff that buries every real change for a month, so `check-rules` reads added lines only. Your change is held to the bar; the legacy around it waits until someone touches it deliberately.

**2. Never report a false positive.** A checker that cries wolf gets deleted by the first person it blocks. Several guards are deliberately conservative and say so in their headers: `check-merge-conflicts` only matches markers at column zero, because git only ever writes them there, and an unanchored search flags any file that merely *describes* a conflict.

**3. Ratchet instead of demanding perfection.** For long-tail debt, count violations against a committed baseline and fail only when the count rises. `audit-token-drift` works this way, and it makes the debt strictly decreasing without ever requiring a big-bang cleanup.

**4. Say what to do, not just what is wrong.** Every failure message names the file, the rule, and the fix. Compare "invalid stage" with the message `audit-guards` actually prints: *"claims it runs in `gate` but it is not in the gate chain. Wire it there, or correct the stage in data/guards.json."*

**5. Record the incident in the header.** Every guard here opens with a dated note explaining the failure that created it. That is what stops a future maintainer from deleting a check that looks pointless, and it is why the `why` field is required in the registry.

**6. Test the guard.** A checker with no test rots into a no-op silently, and you find out when something it was supposed to catch ships anyway. See [`tests/audit-guards.test.js`](https://github.com/nirholas/three.ws/blob/main/tests/audit-guards.test.js) and [`tests/check-merge-conflicts.test.js`](https://github.com/nirholas/three.ws/blob/main/tests/check-merge-conflicts.test.js) for the pattern: build a miniature repo in a temp directory, run the real script against it, and assert on both the pass and the fail.

---

## Proving a guard still works

`npm run audit:guards` proves a guard is *wired*. It cannot prove the guard still *catches* anything. A checker that has rotted into a no-op (a directory it no longer scans, a regex that stopped matching, an exclusion list that grew until it excluded everything) exits 0 forever, and exit 0 is indistinguishable from a clean tree. That is the worst failure mode a safety net has: loudest when it works, silent when it dies.

So every registry entry carries a `proof`: the violation the guard must reject.

```bash
npm run prove:guards                 # prove all of them, write public/guard-proofs.json
npm run prove:guards -- --only check-claude-md
npm run prove:guards -- --stage gate
npm run prove:guards -- --help
```

Each proof runs twice inside a throwaway git worktree overlaid with your working tree, and both halves are required:

1. **Control.** The sandbox is arranged so the guard must pass. A clean exit pins a known baseline; without it, "the guard exited non-zero" could just mean the sandbox is broken.
2. **Violation.** One surgical mutation is applied. The guard must now exit non-zero **and** print the expected fragment, because a guard that fails for the wrong reason is not a working guard.

A mutation proof is a fixture, not code:

```json
"proof": {
  "summary": "CLAUDE.md telling an agent to run an npm script that does not exist.",
  "violation": {
    "append": { "CLAUDE.md": "\n\nVerify with `npm run guard-proof-nonexistent`.\n" }
  },
  "expect": "guard-proof-nonexistent"
}
```

`violation` takes any of `write`, `append`, `delete`, `link`, and `json` (each `json` op needs a `file`, a `pointer`, and exactly one of `insert` / `set` / `removeWhere`), and an optional `setup` block arranges the control side first. A guard that genuinely cannot be proven offline (it needs `gcloud`, a browser, live credentials, or the network) declares the honest gap instead of a fake green:

```json
"proof": { "kind": "live", "reason": "Needs Playwright plus a server serving dist/, because the thing under test is the browser's own policy evaluation." }
```

`audit-guards` rejects a guard with no proof block at all, so this cannot be skipped. Results land in [`public/guard-proofs.json`](https://github.com/nirholas/three.ws/blob/main/public/guard-proofs.json) with a verdict per guard and the commit they were measured at.

The runner is deliberately safe to run while other agents are working in this same tree: each run gets its own sandbox worktree keyed to its process id, and reclaims sandboxes left behind by runs that were killed before their teardown.

---

## Adding a guard

The full walkthrough, with a complete worked example you can run, is in the tutorial: [Write a repository guard](/docs/tutorials/write-a-guard).

The short version:

1. Write `scripts/check-<thing>.mjs`. Exit non-zero with an actionable message.
2. Add an npm script for it in `package.json`.
3. Add it to `data/guards.json` with the stage it runs in, the incident that motivated it, and a `proof` block (see [Proving a guard still works](#proving-a-guard-still-works)).
4. Wire it into that stage's chain.
5. Add a row for it to the tables above, so the page that lists every guard still does.
6. Write `tests/check-<thing>.test.js` covering the pass case and the fail case.
7. Run `npm run audit:guards`. It will tell you if steps 3, 4, and 5 disagree.
8. Run `npm run prove:guards -- --only <id>`. It will tell you whether the guard actually catches what you claimed.

---

## Related

- [Write a repository guard](/docs/tutorials/write-a-guard): the step-by-step tutorial.
- [/guards](/guards): the same registry as a browsable page.
- [Start here](/docs/start-here): what three.ws is, if you landed here first.
