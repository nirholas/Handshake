# 07. Deploy the two finished testnet contracts

Read [00-INDEX.md](backlog-00-INDEX.md) first.

> **Commit gate.** This work order and its deliverables reference a chain other
> than Solana. Per CLAUDE.md, any commit whose diff references a crypto project
> other than `$THREE` needs explicit owner approval before staging. Build freely;
> ask before committing.

## What is wrong

`GreenfieldVault` and `WorldMoves` are code-complete and dry-run verified, and
neither has ever been deployed publicly. Every proof in the retired campaign ran
against an anvil fork or a local instance because no funded deployer key exists:
`BNB_TESTNET_DEPLOYER_KEY` is absent from the shell env, the root `.env`, and
`contracts/.env`, and the public faucet is reCAPTCHA-gated so an agent cannot
self-serve it.

No code change is needed. The moment the addresses exist,
`/api/bnb/world-config` starts returning `deployed: true` for real visitors and
the sender, reader, and ghost paths light up as already proven.

Full history: [../bnb-chain/PROGRESS.md](../bnb-chain/PROGRESS.md). Deploy
addresses and script names: [../../contracts/DEPLOYMENTS.md](../../contracts/DEPLOYMENTS.md).

## The work

1. **Re-verify the dry runs still pass** against the current tree before asking
   for anything. A stale claim of "ready to deploy" is worse than no claim.
   ```sh
   cd contracts
   forge script script/DeployGreenfieldVault.s.sol
   forge script script/DeployWorldMoves.s.sol
   ```

2. **Owner action, one funded key.** Fund a throwaway EOA at
   `https://www.bnbchain.org/en/testnet-faucet` (reCAPTCHA, so a human must do
   it), then set `BNB_TESTNET_DEPLOYER_KEY` in `contracts/.env`.
   `GREENFIELD_VAULT_OPERATOR_KEY` falls back to the same key.

3. **Deploy, then wire the address.** Deploying to a public testnet spends funds
   from a key: render the network, the deployer address, and the estimated cost
   and get an explicit owner yes first (stop-and-ask gate 1).
   ```sh
   forge script script/DeployGreenfieldVault.s.sol --broadcast
   forge script script/DeployWorldMoves.s.sol --broadcast
   ```
   Then set `WORLD_MOVES_ADDRESS_TESTNET` on the service with
   `--update-env-vars` and confirm:
   ```sh
   curl -s https://three.ws/api/bnb/world-config | python3 -m json.tool
   ```

4. **Prove the read and write paths against the real deployment**, not the fork.
   Every path the campaign proved locally gets one live re-run, and the evidence
   goes in [PROGRESS.md](backlog-PROGRESS.md) with transaction hashes.

5. **Update `contracts/DEPLOYMENTS.md`** with the live addresses, the network, the
   deploy block, and the verification link.

## Keep Solana first

This is an additive testnet surface. It does not change where the platform lives.
Do not re-point, migrate, or de-prioritize any Solana infrastructure as part of
this work, and lead your report with the Solana position if you touch anything
shared.

## Definition of done

- [ ] Both dry runs re-verified green against the current tree.
- [ ] Both contracts deployed with transaction hashes recorded.
- [ ] `WORLD_MOVES_ADDRESS_TESTNET` set; `/api/bnb/world-config` returns
      `deployed: true` to an anonymous caller.
- [ ] Sender, reader, and ghost paths exercised against the live deployment.
- [ ] `contracts/DEPLOYMENTS.md` updated.
- [ ] Owner approval obtained before any commit containing this content.
