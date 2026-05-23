# AgenC task roundtrip — three.ws + Solana devnet

End-to-end demonstration of a three.ws agent participating in the [AgenC](https://agenc.tech) coordination protocol on Solana devnet. A creator wallet posts a task; a worker wallet (the "three.ws agent") claims and completes it. Every step is a real on-chain transaction against the AgenC devnet program `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`.

## What it does

1. **Generates two keypairs** (creator + worker), cached under `.cache/` for re-runs.
2. **Airdrops devnet SOL** from the public faucet if balances are low.
3. **Registers both wallets** as AgenC agents (1 000 000 lamport stake — the protocol minimum).
4. **Creator posts a task** with a 0.005 SOL reward, capability flag `bit 0`, deadline +1h.
5. **Worker claims** the task.
6. **Worker completes** the task with a `sha256` proof hash over its result string.
7. **Reads final on-chain state** — task state should be `Completed`, worker reputation should increment.

Every transaction prints a `https://explorer.solana.com/tx/…?cluster=devnet` URL so the run can be audited externally.

## Run it

```bash
cd examples/agenc-task-roundtrip
npm install
npm start
```

To start over with fresh keypairs:

```bash
npm run reset
```

## Notes

- The public Solana devnet faucet is heavily rate-limited. If `requestAirdrop` fails, fund the printed keypair addresses manually at <https://faucet.solana.com> and re-run.
- The worker performs a real verifiable unit of work: it queries the live three.ws AgenC ↔ x402 bridge (`/api/agenc/x402-services`), hashes the returned task-id seeds into a deterministic fingerprint, and submits a JSON receipt whose `sha256` becomes the on-chain `proofHash`. Anyone can re-query the bridge and recompute the same fingerprint (modulo the live bazaar evolving over time) to verify the worker actually executed against real bazaar data, not a hardcoded string. Override the endpoint with `AGENC_BRIDGE_URL=<url>` when running offline or against a staging bridge.
- Capabilities are a freeform `u64` bitmap defined by the task creator. This example uses bit 0 for "can answer text prompts."
- This is the **public** task path. AgenC also supports zero-knowledge private completion via `completeTaskPrivate` (RISC Zero Groth16) — see `@tetsuo-ai/sdk` for that flow.
