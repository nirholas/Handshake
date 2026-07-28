# x402 Buildout Specs

This directory contains no code. It is the archive of task specifications that produced the autonomous x402 spend-loop pipelines: [self/](self/) holds 83 markdown files, one per pipeline, each written as a complete agent prompt for building one autonomous caller of a three.ws x402 endpoint. The directory name reflects the buildout of the platform's closed-loop economy, where the platform's own agents pay real USDC to the platform's own paid endpoints on a schedule, proving the rail end to end and extracting usable data on every call. `self` means self-call: every spec targets a three.ws endpoint (logged with `endpoint_type='self'`), as opposed to external services discovered via the Bazaar. It serves contributors (human or agent) extending the autonomous economy: pick a spec, and it tells you exactly what to build, where to wire it, and what done means.

## Spec format

Every file in [self/](self/) follows the same structure:

- **Objective**: which x402 endpoint to call, its price, and its category.
- **What to build**: the pipeline's behavior and schedule (for example, [self/009-cross-network-payment-probe.md](self/009-cross-network-payment-probe.md) specifies an hourly $0.001 test payment on each supported network as the cheapest end-to-end proof that the payment stack is alive).
- **Implementation requirements**: add a registry entry (`id`, `name`, cooldown, `pipeline` tag, `run()`), make real payments with the platform's `X402_AGENT_SOLANA_SECRET_BASE58` keypair (never mocked; exit gracefully if unconfigured), record every call to the `x402_autonomous_log` table, extract the response's value into a dedicated DB table, respect cooldowns, and handle errors without crashing the loop.
- **Definition of done**: a checklist including a manual test of the `run()` function.

Files are named either with a number prefix (`001` through `038`) or by slug alone; registry comments cite them by number (for example `see agents/x402-buildout/self/009`).

## Where the implementations live

The specs are the input; the shipped output lives in the API layer:

| Location | Role |
|---|---|
| [../../api/_lib/x402/autonomous-registry.js](../../api/_lib/x402/autonomous-registry.js) | The registry of every scheduled entry: id, path, cooldown, priority, pipeline tag, signal extraction, value storage |
| [../../api/_lib/x402/pipelines/](../../api/_lib/x402/pipelines/) | Multi-call pipeline implementations imported by the registry |
| [../../api/cron/x402-autonomous-loop.js](../../api/cron/x402-autonomous-loop.js) | The cron loop that picks ready entries, pays, and records to `x402_autonomous_log` |
| [../../docs/x402-ring-economy.md](../../docs/x402-ring-economy.md) | The economics of the ring: wallets, float, fees, and throughput |
| [../../ARCHITECTURE.md](../../ARCHITECTURE.md) | The autonomous spend loop section, which points back to this directory |

## How to use it

Browse the specs from the repo root:

```bash
ls agents/x402-buildout/self/
```

To build a new pipeline, read a shipped spec and its matching registry entry side by side, then follow the same pattern: land the registry entry, make the payment path real, and verify a log row and a value-store write from a direct call to your `run()` function. Coordinate on shared DB schemas with neighboring specs and avoid duplicate table creation.

## Environment variables

The specs themselves read nothing. The pipelines they describe depend on the spend-loop environment, chiefly `X402_AGENT_SOLANA_SECRET_BASE58` (the outbound payer keypair) plus the platform `DATABASE_URL` and Redis credentials used by the loop for cooldowns and logging; each spec names what its pipeline needs.
