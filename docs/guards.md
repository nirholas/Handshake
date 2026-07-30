# Repository guards

This repository has no CI. GitHub Actions is unavailable on this account, so nothing runs your code when you open a pull request, and nothing blocks a bad merge. What protects the codebase instead is a set of small, fast, local guards wired into paths you cannot skip: the prebuild, the gate, the deploy build, and the git pre-push hook.

This page explains what each guard protects, when it runs, and how to add one. Everything here is generated from [`data/guards.json`](https://github.com/nirholas/three.ws/blob/main/data/guards.json), which [`scripts/audit-guards.mjs`](https://github.com/nirholas/three.ws/blob/main/scripts/audit-guards.mjs) verifies on every gate run, so the stage column below cannot quietly go stale.

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
| Hard rules, diff scoped | `npm run check:rules` | The CLAUDE.md hard rules on the lines you changed. |
| The guard registry | `npm run audit:guards` | Every guard is registered and every stage claim is true. |
| Design-token ratchet | `npm run audit:tokens` | Hardcoded colour hexes cannot creep back past a committed baseline. |

### Routing and pages

| Guard | Command | Protects |
|---|---|---|
| Route documentation | `npm run audit:pages` | Every human-facing route is documented in `data/pages.json`. |
| Declared pages resolve | `npm run check:pages` | Every page declared in `data/pages.json` is actually reachable. |
| Routing and 404 model | `npm run audit:routes` | Catalog pages reachable, unknown paths reach the designed 404, no shadowed routes. |
| API handlers export a body | `npm run audit:handlers` | No API handler ships empty or without an export. |
| The `[hidden]` guard | `npm run audit:hidden-guard` | Every page resolves the CSS that makes `hidden` actually hide. |
| Site link integrity | `npm run audit:links` | Every navigable target resolves to a real route or file. |

### Docs and contracts

| Guard | Command | Protects |
|---|---|---|
| Documentation integrity | `npm run audit:docs` | No dead relative link, no command naming a missing script, no package without a README. |
| x402 endpoint catalog | `npm run audit:x402-catalog` | Every paid endpoint is documented, so a buyer can find it. |
| MCP manifests | `npm run audit:mcp` | Every MCP manifest satisfies the official registry's rules, offline. |
| MCP golden contracts | `npm run audit:mcp-golden` | Tool names, descriptions, and schemas against a committed snapshot. |
| MCP safety annotations | `npm run audit:mcp-safety` | Declared `readOnlyHint` and `destructiveHint` match what handlers do. |
| Cron schedule drift | `npm run check:cron-syntax`, `npm run check:cron-drift` | Valid expressions, and agreement with the running Cloud Scheduler jobs. |

### Build and deploy

| Guard | Command | Protects |
|---|---|---|
| Browser bundle purity | `npm run check:browser-graph` | No Node-only module leaks into the browser bundle. |
| Build output shape | `npm run check:dist` | `dist/` contains every artifact the deploy expects. |
| Deploy artifact preflight | `npm run audit:deploy` | The artifact failure classes that have taken production down. |
| Cloud Build upload | `npm run check:gcloudignore` | What `gcloud builds submit` would actually upload. |

### Runtime, assets, and money

| Guard | Command | Protects |
|---|---|---|
| Console sweep | `npm run audit:console` | A clean browser console on every route, desktop and mobile. |
| Image loading attributes | `npm run check:images` | Every JS-rendered image sets `loading` and `decoding`. |
| Wardrobe catalog integrity | `npm run audit:garments` | Every garment validates and its GLB hash matches its manifest. |
| Rig coverage | `npm run audit:rig-coverage` | How well the canonicalizer maps skeletons actually stored in production. |
| Service wallet configuration | `npm run audit:service-wallets` | Balances, floors, and whether the advertised x402 fee payer matches the real secret. |
| Fleet wallet flows | `npm run audit:wallet-flows` | Where the platform's SOL is, where it went, and whether any is leaking. |
| Relayer balances | `npm run check:relayer-balances` | Every configured Solana signer is above its documented minimum. |
| Delegation contract addresses | `npm run check:erc7710` | Every delegation-manager address is a deployed contract. |

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

## Adding a guard

The full walkthrough, with a complete worked example you can run, is in the tutorial: [Write a repository guard](/docs/tutorials/write-a-guard).

The short version:

1. Write `scripts/check-<thing>.mjs`. Exit non-zero with an actionable message.
2. Add an npm script for it in `package.json`.
3. Add it to `data/guards.json` with the stage it runs in and the incident that motivated it.
4. Wire it into that stage's chain.
5. Write `tests/check-<thing>.test.js` covering the pass case and the fail case.
6. Run `npm run audit:guards`. It will tell you if step 3 and step 4 disagree.

---

## Related

- [Write a repository guard](/docs/tutorials/write-a-guard): the step-by-step tutorial.
- [/guards](/guards): the same registry as a browsable page.
- [Start here](/docs/start-here): what three.ws is, if you landed here first.
