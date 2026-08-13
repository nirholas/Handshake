# Tests

How the three.ws test suite is organized, how to run each part, and which parts
need credentials. Real money rides on this code — green has to mean green.

## TL;DR

```bash
npm run test:core      # full vitest suite (1.5 to 5 min depending on host load)
npm run test:gate      # 7 critical money/auth files — fast, offline, mock-backed
npm run lint           # eslint . (0 errors is the bar; warnings are a backlog)
npm run typecheck      # tsc -p jsconfig.json (must stay clean; it gates deploys)
```

## Suites

| Command | Runner | What it covers | Needs creds? |
| --- | --- | --- | --- |
| `npm test` | vitest + playwright | Unit suite then the browser e2e specs | Some unit specs are creds-gated (skip cleanly); e2e needs Chromium |
| `npm run test:core` | vitest | Same unit suite, without the browser e2e specs | No (creds-gated specs skip) |
| `npm run test:serial` | vitest `--maxWorkers=1` | Same unit suite forced onto one worker. Diagnostic only, see Concurrency below | No (creds-gated specs skip) |
| `npm run test:gate` | node `scripts/test-gate.mjs` | 7 highest-consequence files: money-path confirm, HTTP cache boundary, custody/spend guards, vanity flow, x402 verify, holder snapshot, healthz | No — offline + mock-backed |
| `npm run test:e2e` | playwright | `tests/**/*.spec.js` — boots `npm run dev` as its web server | Chromium (`npx playwright install chromium`) |
| `npm run test:pages` | node `scripts/test-pages.mjs` | Chromium health pass over every public route (thrown errors, console errors, dead requests, broken hero images) | Chromium; spawns its own vite |
| `npm run test:all` | — | `test` then `test:pages` | as above |
| `npm run test:mcp` | node `scripts/test-mcp-all.mjs` | MCP transport surface | varies |
| `npm run smoke:onchain` | node | Live Solana/RPC parity checks | RPC access |
| `npm run smoke:agent-wallet` | node | Agent wallet path | wallet/CDP creds |
| `npm run smoke:mcp` | node | Remote MCP endpoints | live endpoints |

`vitest` discovers `tests/**/*.test.{js,mjs}`, `src/**/*.test.js`,
`api/_lib/coin/**/*.test.js`, and `tour-sdk/test/**/*.test.mjs`
(see `vitest.config.js`).

## Credentials

Credential-gated specs **skip cleanly** when their env var is absent — they do not
fail. They run wherever the secret is present (CI secrets, a local `.env`). The
common ones, by frequency in the suite:

`NVIDIA_API_KEY`, `HF_TOKEN`, `JWT_SECRET`, `REPLICATE_API_TOKEN`,
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, `OPENAI_API_KEY`,
`GROQ_API_KEY`, `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`, `OPENROUTER_API_KEY`,
`DATABASE_URL`, `BIRDEYE_API_KEY`.

A local run with none of these set is expected to show skips, not failures. If you
see a creds-gap spec *fail* rather than skip, that's a bug in the gate — fix the
guard, don't delete the test.

## Concurrency / flakes

Heavy cold ESM imports (Solana toolchain, `@coinbase/x402`, jsdom, neon) make
worker startup memory-hungry. `vitest.config.js` already caps forks
(`MAX_FORKS`) and sets a 120s test/hook timeout for this reason.

On a loaded box (e.g. a Codespace shared by several agents) the default
fork count can still starve and surface as `Timeout waiting for worker to
respond`, which is the host, not the test.

**Do not reach for `--maxWorkers=1` as the cure.** `test:core` carried it from
2026-06-05 to 2026-08-13 and it was measured to be the wrong trade:

| Mode | Wall clock |
| --- | --- |
| default forks (`MAX_FORKS`) | 88s, 182s and 308s over three runs on this host |
| `--maxWorkers=1` | ~30 min (imports alone serialize to ~470s, tests to ~440s) |

Serializing does not remove the flake class it was blamed for. Back-to-back
full runs on the same commit failed 10 files and then 2; the 8 that moved were
`branding`, `thumbnail-url-guard`, `no-nul-bytes`, `asset-host-liveness`,
`setup-git-hooks`, `skill-royalty`, `node-operator` and `play-gate`, all of
which either scan the tracked working tree, shell out to real `git`, or reach
the network. In a worktree shared with other agents those inputs change *during
the run*, and a single worker makes that window ten times longer, not shorter.
Each of them passes in isolation at full parallelism.

So: a failure that appears only in a full run and passes on its own is an
environment artifact, and the thing to check is whether another agent was
writing to the worktree, not the worker count. `npm run test:serial` still
exists for the rare case where you genuinely need to rule out cross-worker
interference, and it is a diagnostic, not the reliable run.

`vitest.config.js` sets `slowTestThreshold: 5_000`, so any single test over five
seconds is called out in the reporter. That list is the early warning that the
total is creeping back up; there is deliberately no hard wall-clock gate,
because failing a build for a busy host would be the same mistake in a new
shape.

## Where the checks actually run

**There is no CI on this repository.** This section used to describe a
`.github/workflows/ci.yml` that runs lint, typecheck, tests and guards on every
push; that file does not exist, and `CLAUDE.md` bans GitHub Actions outright.
Believing it is how a red suite reaches `main`. Every protection is local:

| Stage | What runs it | Covers |
| --- | --- | --- |
| Pre-push hook | `scripts/setup-git-hooks.mjs` installs it; `postinstall` runs that on every `npm install` | `check:rules` over exactly the commits being pushed, plus the commit-subject lint |
| `npm run gate` | you, before shipping | the offline audit set (docs, pages, handlers, guards, x402 catalog, tour atlas, …) |
| `npm run build:gcp` | the deploy runbook in `CLAUDE.md` | the build-time guards, in a load-bearing order |
| `npm run test:core` / `npm test` | you | this suite; `npm test` then runs Playwright |

`data/guards.json` is the registry of which guard belongs to which stage, and
`npm run audit:guards` fails when a claim there stops matching reality. Nothing
runs the unit suite for you, so run it before you ask for a push.

Lint blocks on errors only; the pre-existing warnings are a tracked backlog.
