# Run order: which work order to paste next

Everything open lives in [finish/](finish/) as one flat folder of 197 work orders (150 route
audits + 47 everything else). That folder tells you what is open; it does not tell you what
matters. This file ranks it.

**Measured 2026-09-06**, not copied from any pack's status text:

| Probe | Result |
|---|---|
| `curl -s https://three.ws/api/version` | `8770c06c2` on revision `three-ws-api-00415-cbr` (built 2026-09-05 15:29 UTC) |
| `git rev-parse --short main` | `c5d0cbc63` |
| commits live on `main`, not in production | **17** (was 219 on 2026-09-03) |
| `curl -s https://three.ws/api/healthz` | `subsystems.status: down` (9 ok, 4 degraded, 1 down) |
| down | `x402_settle`, now **0.0%** (0 of 39 paid attempts over 3 hours), Solana accept withdrawn on 82 `no_solana_accept`, sponsor under the SOL floor |
| degraded | `okx_chat_bot` (chat IS delivered now; the AI provider returns 403 `Lightning dunning decision is deny for project: projects/93741856042`), `agent_index` (84 of 1,605 agents erroring, 39m median lag), `sniper` (4 of 11 wallets starved, needs 0.2397 SOL, funding master holds 0.0250), `helius` / `rpc_lanes` (all four paid Solana lanes over quota at once) |
| changed since the last map | The 2026-09-05 deploy cleared the old P0 row 1. The chat-bot host is no longer down, so backlog 08's premise moved: it is a credential failure, not a hosting one. A **GCP billing dunning hold** is the new cross-cutting blocker, and `gcloud` in this workspace answers `Reauthentication failed` (OWNER-ACTIONS row 15 is live, not standing) |

Re-run those five commands before trusting this file. Ranking rule used throughout: a live
production defect outranks an unshipped fix, an unshipped fix outranks a new feature, and
anything that unblocks many other orders outranks anything that unblocks one.

The tier is the priority. Inside a tier, the order of the rows is the order to run them.

---

## P0. Every remaining row is an owner action, not an agent session (collect, do not run)

The 2026-09-05 deploy cleared the ranking's old top row: production is 17 commits behind, not
219, and those 17 are the vscode-3d, IRL and docs commits from 2026-09-05 and 2026-09-06. What is
left at P0 no longer multiplies the other tiers, because nothing here is unblocked by writing
code. Batch these into one owner message and start an agent session from P1.

| Row | Why now (measured) | Who clears it |
|---|---|---|
| GCP billing dunning hold | Production's own healthz quotes the provider: `Lightning dunning decision is deny for project: projects/93741856042`. That denial is project-wide, so it silently defeats "use Vertex, it is pre-approved" for any order that needs an LLM or an image lane, and it is why `okx_chat_bot` can deliver a message and still author no reply. Nothing in this repo can route around a billing hold. | Owner (billing). Verify with one live Vertex call before treating any Vertex-dependent order as runnable. |
| `gcloud` re-auth in this workspace | `gcloud projects describe` answers `Reauthentication failed. cannot prompt during non-interactive execution`. This is OWNER-ACTIONS row 15 in its live state, and it gates the deploy submit, the Cloud Scheduler comparison in fix-queue 03, and the fleet reads in quality-bar 03. | Owner (`gcloud auth login`). Retry a real call first; this row has cleared itself before. |
| Fund the settle sponsor (OWNER-ACTIONS row 2) | `x402_settle` got worse, not better: 10.0% settle on 2026-09-03, **0.0%** now, and the Solana accept is withdrawn from every 402 challenge. [finish/backlog-01-x402-settle-runway.md](finish/backlog-01-x402-settle-runway.md)'s code half is already done; the wallet needs about 1 SOL from outside. The ring cannot self-fund it. | Owner (~1 SOL). The `sniper` refill (0.2397 SOL) is the same class and the same message. |
| Ship the 17 (OWNER-ACTIONS row 1) | Small now, and worth batching with the re-auth above rather than running as its own campaign session. | Owner approval plus a working `gcloud`. |

Backlog order 08 has left this tier. The chat-bot subsystem reports chat as delivered; its
remaining failure is the billing hold in row 1 of this table, so re-read the order before
running it as a hosting task.

## P1. The highest-value agent work available today (start here)

| Order | Why now (measured) | Gate |
|---|---|---|
| [finish/swarm-100-sweep-console.md](finish/swarm-100-sweep-console.md) | The console sweep still exits 1, and its root causes (`draco_decoder.wasm` 404 on every 3D page, `/fees` logging seven 404s) are the same defects that make ~29 of the 150 route audits fail. Fixing the shared causes once retires route orders in bulk. | None. |
| [finish/fix-queue-03-cron-drift-garment-sweep.md](finish/fix-queue-03-cron-drift-garment-sweep.md) (needs the P0 re-auth) | P1 silent failure: a cron declared in `vercel.json` has never fired in production. Nothing errors, the job just never runs. | Needs a live `gcloud` read. The auth failure here is intermittent, not standing (row 15); retry before parking it. |
| [finish/production-100-04b-fact-check-publish-run.md](finish/production-100-04b-fact-check-publish-run.md) (blocked while the dunning hold stands) | Re-measured 2026-09-03: the benchmark now answers from `database` with a published run, so the campaign's definition-of-100% line 6 passes, but the run scores **16 of 40** and the `mixed` class the fix targeted is **0 of 10**. The order stands, with a sharper target than when it was written. | Needs an LLM lane, and as of 2026-09-06 Vertex is denied project-wide by the billing hold in P0. Probe the lane before starting; if it is still denied, run one of the rows above instead. |
| [finish/swarm-100-sweep-authed-audit.md](finish/swarm-100-sweep-authed-audit.md) | 33 pages had error findings in the last authed report (2026-08-19) and the QA login now exists, so the order's own "blocked" premise is stale. Signed-in users see a different, worse site than the probes measure. | None (`npm run audit:web:login`). |

## P2. Quality bar, the visible half of the product

Run in this order; each is one session. This tier is what a visitor actually judges.

| Order | Why now (measured) |
|---|---|
| [finish/quality-bar-07-design-system-sweep.md](finish/quality-bar-07-design-system-sweep.md) | Actively regressing: raw hex went 4,787 to 5,426 since 2026-08-02 and `audit:tokens` reports 10 against a baseline of 0. Every day this waits, more surfaces are built off-token. |
| [finish/quality-bar-04-pbr-texture-material-realism.md](finish/quality-bar-04-pbr-texture-material-realism.md) | `api/_lib/glb-pbr-derive.js` is imported and never called, so every generated model ships without derived PBR. This is the single biggest quality delta available on the core product. |
| [finish/quality-bar-06-forge-ux-flow.md](finish/quality-bar-06-forge-ux-flow.md) | The forge is the front door. The result-moment click-through table and the audits are still owed. |
| [finish/quality-bar-08-mobile-performance.md](finish/quality-bar-08-mobile-performance.md) | Touch targets shipped; the after-table, default GLB compression and the WebGL budget are open. Mobile is where 3D fails first. |
| [finish/swarm-100-sweep-perf.md](finish/swarm-100-sweep-perf.md) | Eight pages measured 2026-08-15, three under 80, no re-measure since the 2026-09-01 fixes. Cheap once P0 ships. |
| [finish/quality-bar-03-gpu-fleet-scaleout.md](finish/quality-bar-03-gpu-fleet-scaleout.md) | Cold-start UX shipped; the load test and scale ceilings are open. Credits are pre-approved, so nothing here is gated. |
| [finish/quality-bar-10-avatar-likeness-irl-people.md](finish/quality-bar-10-avatar-likeness-irl-people.md) | The likeness audit's only complete run shows no improvement. Highest ceiling, longest run; do it after the cheaper wins. |
| [finish/swarm-100-sweep-i18n.md](finish/swarm-100-sweep-i18n.md) | Untouched: `i18n:lint` reports 44,104 problems across 81 locales. Large, mechanical, and safe to park behind the rest of P2. |

## P3. Roadmap features with a partial build already on disk

Finishing a partial beats starting a new campaign; the expensive half is already paid for.

| Order | State |
|---|---|
| [finish/roadmap-generation-suite.md](finish/roadmap-generation-suite.md) | Tools, smoke cron and gallery shipped; PBR map outputs, job webhooks and the API contract doc open. Pairs naturally with quality-bar-04. |
| [finish/gcp-credits-05-catalog-animation-seeding.md](finish/gcp-credits-05-catalog-animation-seeding.md) | The catalog seed runs at scale (56,898 avatars); the generated motion library still has **0 clips**. Pure credit spend and pre-approved, but the 2026-09-06 billing hold in P0 denies the generation lane, so probe before starting. |
| [finish/event-06-photo-mode-share.md](finish/event-06-photo-mode-share.md) | Cross-engine verification and the changelog entry remain. Check `event-PROGRESS.md` first; another agent was on it 2026-09-02. |
| [finish/event-02-play-polish-sweep.md](finish/event-02-play-polish-sweep.md) | Rewritten to its remainder: one harness run on a quiet box. |
| [finish/fable-audit-RESIDUALS.md](finish/fable-audit-RESIDUALS.md) | Three deliberately-left items: a negative fixture and an OIDC step, an API-only task, and six seed drifts behind the commit gate. |

## P4. Distribution and listings (owner-gated, batch the human touchpoints)

Every row here stalls on an owner action, so run them as a batch and collect the asks in one
message rather than one per session. Some of these packs reference third-party projects and
therefore carry the CLAUDE.md commit gate; they are named by campaign here, not by filename, so
this file itself stays outside that gate. Find the exact order in its campaign index:
[finish/backlog-00-INDEX.md](finish/backlog-00-INDEX.md) and the queue table in
[README.md](README.md).

| Order | Owner gate |
|---|---|
| Marketplace listing pack, the relisting orders (campaign index: [README.md](README.md)) | Email OTP as `claude@three.ws` (row 10). The listing resubmitted on chain 2026-08-27 is under review. Blocked behind P0 row 2: these orders assume marketplace chat is delivering. |
| Marketplace listing pack, the real-payment gauntlet | Funding plus a login; it is a real spend, so it is a CLAUDE.md stop-and-ask gate by definition. |
| Marketplace listing pack, the final audit and watch | Runs last in that pack, after the payment test and the relisting. |
| [finish/openai-pr-06-docs-accuracy-reconciliation.md](finish/openai-pr-06-docs-accuracy-reconciliation.md) | None: the tool count drifted to 11 across the kit and an agent can fix that today. Run it independently of 07. |
| [finish/openai-pr-07-final-verification-and-submit.md](finish/openai-pr-07-final-verification-and-submit.md) | The portal submit is the owner's; everything up to it is agent work. |
| [finish/backlog-05-r2-bucket-cors.md](finish/backlog-05-r2-bucket-cors.md) | One R2 admin token in `.env.local` (row 7). |
| Backlog order 10, the third-party indexer listing | One indexer sign-in with the platform wallet (row 8). Commit gate applies (row 11). |
| [finish/backlog-09-telegram-bots-durability.md](finish/backlog-09-telegram-bots-durability.md) | Same class of fix as P0 row 2 (get a bot off this codespace); do them together if you are already in that code. |
| Backlog order 07, the two finished testnet contract deploys | Faucet funding (row 9) and the commit gate (row 11). Lowest value here: it is an EVM testnet, and Solana leads. |
| [finish/roadmap-native-widgets.md](finish/roadmap-native-widgets.md) | Not code: all four tasks are built and live. Needs an Apple Developer account (row 17) and a Windows 11 box. |

## P5. The swarm: 150 route audits, parallel-safe, self-retiring

Any file runs standalone in a fresh chat and depends on no index. A file present is open. Run
these when you want breadth rather than depth, or on a second machine in parallel with P1 to P3.

The 2026-09-01 headless probe (1440/768/320 px, then a reload with `/api/*` blocked) found 56 of
151 mechanically clean and 95 with at least one measured defect. Run the routes with a real
defect first, in this order:

1. **Uncaught exception on load**: [route-launch](finish/swarm-100-route-launch.md), [route-launch-studio](finish/swarm-100-route-launch-studio.md) (`/launch/launch.js` answers 500).
2. **Broken signed-out or empty shell**: [route-dashboard](finish/swarm-100-route-dashboard.md), [route-my-agents](finish/swarm-100-route-my-agents.md), [route-guardian](finish/swarm-100-route-guardian.md), [route-temporary](finish/swarm-100-route-temporary.md).
3. **Failing API or asset**: [route-galaxy](finish/swarm-100-route-galaxy.md) (`/api/galaxy` 503), [route-launches](finish/swarm-100-route-launches.md) (ipfs.io images blocked), [route-fees](finish/swarm-100-route-fees.md) (seven 404s).
4. **320 px overflow**: [route-economy](finish/swarm-100-route-economy.md), [route-ibm-hello](finish/swarm-100-route-ibm-hello.md), [route-showcase](finish/swarm-100-route-showcase.md).
5. **Core surfaces regardless of probe result**, because they carry the traffic: [route-home](finish/swarm-100-route-home.md), [route-marketplace](finish/swarm-100-route-marketplace.md), [route-play](finish/swarm-100-route-play.md), [route-forge-studio](finish/swarm-100-route-forge-studio.md), [route-pricing](finish/swarm-100-route-pricing.md), [route-login](finish/swarm-100-route-login.md), [route-register](finish/swarm-100-route-register.md), [route-search](finish/swarm-100-route-search.md), [route-settings](finish/swarm-100-route-settings.md), [route-profile](finish/swarm-100-route-profile.md).
6. Everything else alphabetically.

The 64 "no visible error state under a blocked API" hits include the ten `/features/*` pages and
other static routes that make no API call at all: those are false positives, so measure before
you build an error state nothing can reach.

## P6. three.ws Home, a whole unbuilt product (14 orders)

[finish/home-00-CONTEXT.md](finish/home-00-CONTEXT.md) plus orders 04 to 20. The client library
and the investigation landed; **nothing is wired into the product yet**, so this is net-new build,
not finishing. It is ranked last not because it is unimportant but because it competes with
fixing what users already touch. Run it as its own campaign, in numeric order (04 gates 05 and 06,
security 11 gates the launch gate 20), when the owner wants the physical-world lane pushed rather
than the live platform tightened.

Two launchpad trading plans sit beside it under the `roadmap-` prefix: strategy documents, not
work orders, and every commit touching them hits the CLAUDE.md coin gate. They are unranked here
for the same reason.

---

## Not tasks

- [masters/](masters/): nine reusable master prompts. They take a supplied TARGET and never retire.
- `<campaign>-00-INDEX.md`, `-00-CONTEXT.md`, `-README.md`, `-PROGRESS.md`, `-RUNBOOK.md`,
  `quality-bar-_shared.md`, `roadmap-REUSE-MAP.md`, `production-100-OWNER-ACTIONS.md`: context and
  logs. Read the one your order names; never run one.
- [finish/production-100-00-INDEX.md](finish/production-100-00-INDEX.md) is the campaign map this
  file ranks. It carries the per-order evidence; this file carries the sequence.

## Keeping this file true

It is a ranking of measurements, so it rots the moment the measurements change. Re-run the five
probes at the top before using it, and rewrite the tiers when a P0 row clears. A finished order is
deleted in its own closing commit, so its row here goes with it.
