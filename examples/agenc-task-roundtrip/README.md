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
- The "result" produced by the worker is a placeholder greeting — in a real three.ws agent runtime, this is where the LLM call, animation render, or voice synthesis would happen.
- Capabilities are a freeform `u64` bitmap defined by the task creator. This example uses bit 0 for "can answer text prompts."
- This is the **public** task path. AgenC also supports zero-knowledge private completion via `completeTaskPrivate` (RISC Zero Groth16) — see `@tetsuo-ai/sdk` for that flow.
