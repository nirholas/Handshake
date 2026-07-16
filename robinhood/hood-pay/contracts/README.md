# HoodPayRouter

Stateless, non-custodial payment attribution for plain ERC-20s on Robinhood
Chain. `pay(token, payTo, amount, reference)` pulls the tokens from the
caller straight to the merchant and emits
`PaymentReceived(reference, payer, payTo, token, amount)`. The contract
never holds a balance, has no owner, and cannot be paused or upgraded.

Why it exists: USDG has no memo field and no EIP-2612 permit (verified
on-chain), so a bare `transfer` cannot say which invoice it settles. See
`docs/security.html` for the full reference-scheme design and collision
math.

## Layout

- `src/HoodPayRouter.sol` - the router (zero dependencies, solc 0.8.30).
- `test/HoodPayRouter.t.sol` - local unit + fuzz tests. Cheatcodes are
  declared inline, so there is no forge-std submodule to install.
- `test/HoodPayRouter.fork.t.sol` - fork tests against the REAL USDG
  contract and real mainnet balances (executed only in forge's local fork
  EVM; nothing is broadcast).

## Test

```sh
npm run forge:test        # local unit + fuzz
npm run forge:test:fork   # mainnet-fork tests against real USDG
```

## Deploy (owner step - signs and broadcasts a real transaction)

The router is optional: direct-mode checkouts need no contract at all.
Deploy it to enable router mode (exact attribution + partial-payment
semantics). Fund the deployer with a little testnet/mainnet ETH first
(gas is ETH on Robinhood Chain).

Testnet (chain 46630), with Blockscout verification:

```sh
forge create contracts/src/HoodPayRouter.sol:HoodPayRouter \
  --root contracts \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --private-key "$ROBINHOOD_CHAIN_PRIVATE_KEY" \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api
```

Mainnet (chain 4663):

```sh
forge create contracts/src/HoodPayRouter.sol:HoodPayRouter \
  --root contracts \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --private-key "$ROBINHOOD_CHAIN_PRIVATE_KEY" \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api
```

Then pass the deployed address as `router` (together with a `reference`)
in widget configs, payment links, and `hood-pay link --router 0x…`.

The deployment is permissionless and address-agnostic: anyone may deploy
their own router; verifiers watch whatever router address the merchant
configures.
