# Examples

Two ready-to-run launch configs (see the main README's Quickstart for how to invoke them):

- `coin.deterministic.json` — the NOXA rail, zero LLM calls, no `direct` block needed. The
  simplest possible launch: one `launchToken` transaction.
- `coin.direct.json` — the direct rail: deploys a fresh `HoodToken`, seeds a Uniswap v3 pool
  with 0.01 ETH, and burns the LP position NFT. Works on both mainnet and testnet.

Try either with `hood-launch preflight --config examples/<file>.json` first — it runs the full
concept → screen → uniqueness → artwork → rail-preflight pipeline without spending anything.

For a generated (not deterministic) concept, omit `name`/`symbol`/`description` from your own
config and pass `--theme "some trending narrative"` on the command line instead — see the main
README's "Concept engine" section. That path requires `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
