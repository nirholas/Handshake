# ERC-8004 Contract Deployments

All three registries are deployed via CREATE2, giving the same address on every
supported EVM chain within each environment class (mainnet vs. testnet).

## Provenance

Deployment transaction hashes from the original CREATE2 broadcast were not
captured per chain at deploy time. Rather than leave the record as bare `TODO`s,
each live contract is **verified by on-chain bytecode**: `scripts/verify-onchain-parity.mjs`
performs an `eth_getCode` sweep against the public RPCs in `api/_lib/erc8004-chains.js`
and asserts non-empty runtime code at every declared address. The
`bytecode ✓ (YYYY-MM-DD)` notes below are the dates of those reads. Re-run any
time with:

```
VERIFY_ONCHAIN_CHAINS=all npm run verify:onchain   # full sweep
npm run verify:onchain                              # build-gate subset (Base + Base Sepolia)
```

The IdentityRegistry + ReputationRegistry share one address per network class
(CREATE2-deterministic). A single explorer link below resolves to the contract
on any listed chain; the per-chain bytecode-verified status is the authoritative
liveness signal.

## Mainnet

Chains with confirmed bytecode (verified 2026-06-19): Ethereum (1), Optimism (10),
BSC (56), Gnosis (100), Polygon (137), Mantle (5000), Base (8453),
Arbitrum One (42161), Celo (42220), Avalanche (43114), Linea (59144), Scroll (534352).

> **Not yet deployed on Fantom (250), zkSync Era (324), Moonbeam (1284).** An
> `eth_getCode` sweep on 2026-06-19 returned `0x` (no code) at the registry
> addresses on these three chains across multiple independent RPCs. zkSync Era
> derives CREATE2 addresses differently from the EVM, so the canonical address is
> not reachable there without a chain-specific deploy. Registration / reputation
> writes on these chains will revert until the registries are deployed (deploy
> backlog). The address columns are kept for parity; liveness is per the bytecode
> notes only.

| Contract             | Address                                      | Provenance              |
| -------------------- | -------------------------------------------- | ----------------------- |
| IdentityRegistry     | [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://basescan.org/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) | bytecode ✓ (2026-06-19) on 12 chains; tx unrecoverable |
| ReputationRegistry   | [`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`](https://basescan.org/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63) | bytecode ✓ (2026-06-19) on 12 chains; tx unrecoverable |
| ValidationRegistry   | not deployed on mainnet                      | pending mainnet deploy (`src/erc8004/abi.js` MAINNET.validationRegistry = '') |

## Testnet

Chains (all bytecode-verified 2026-06-19): BSC Testnet (97), Ethereum Sepolia (11155111),
Base Sepolia (84532), Arbitrum Sepolia (421614), Optimism Sepolia (11155420),
Polygon Amoy (80002), Avalanche Fuji (43113).

| Contract             | Address                                      | Provenance              |
| -------------------- | -------------------------------------------- | ----------------------- |
| IdentityRegistry     | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://sepolia.basescan.org/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) | bytecode ✓ (2026-06-19) on 7 testnets; tx unrecoverable |
| ReputationRegistry   | [`0x8004B663056A597Dffe9eCcC1965A193B7388713`](https://sepolia.basescan.org/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) | bytecode ✓ (2026-06-19) on 7 testnets; tx unrecoverable |
| ValidationRegistry   | [`0x8004Cb1BF31DAf7788923b405b754f57acEB4272`](https://sepolia.basescan.org/address/0x8004Cb1BF31DAf7788923b405b754f57acEB4272) | reference `ValidationRegistryUpgradeable` (ERC-1967 proxy), interface ✓ 2026-08-06 via `npm run verify:erc8004-validation`; NOT this repo's ValidationRegistry.sol |

## Platform validator (ValidationRegistry attestor)

The platform validator is the EVM key that signs glTF/schema validation
attestations (`validationResponse`) when an agent is registered. The deployed
registry has no allowlist, so there is nothing to add it to: it can answer any
request addressed to it. It needs gas on every chain it attests on, and it must be
stored as the `VALIDATOR_PRIVATE_KEY` env var on the `three-ws-api` Cloud Run
service (never committed). Provision/rotate with
[`scripts/erc8004/provision-validator-key.mjs`](../scripts/erc8004/provision-validator-key.mjs).
Flow and operating notes: [`docs/erc8004/validation-attestation.md`](../docs/erc8004/validation-attestation.md).

| Address | State | Notes |
| ------- | ----- | ----- |
| `0x93Bc7EfB0059B784465619FC73C2db8D01b1CD04` | not configured, unfunded | Provisioned 2026-06-15. As of 2026-08-06 the key is absent from `.env`, `.env.local`, Secret Manager and the Cloud Run service, and the address holds 0 gas on Base Sepolia, so `/api/erc8004/validate` returns `validator_key_not_configured`. Configure + fund it (testnet first: Base Sepolia 84532) to activate platform attestations. |

## CREATE2 Factory (ThreeWSFactory)

Custom vanity-prefixed CREATE2 deployer used to obtain matching addresses across chains.

| Chain            | Address                                      | Deployer EOA             | Deployed   | Tx |
| ---------------- | -------------------------------------------- | ------------------------ | ---------- | -- |
| BSC (56)         | `0x00000000D49195AE81759cd247cFeDD9D0B479df` | `0x4022de2D...C0564f402` | 2026-05-11 | — |
| Base (8453)      | `0x00000000D49195AE81759cd247cFeDD9D0B479df` | `0x4022de2D...C0564f402` | 2026-05-14 | [`0x20bbd8a8…`](https://basescan.org/tx/0x20bbd8a8f948a1d01eae17e2df919963ab92b6bcb86c326377d28d224bdb6923) |
| Arbitrum (42161) | `0x00000000D49195AE81759cd247cFeDD9D0B479df` | `0x4022de2D...C0564f402` | 2026-05-14 | [`0xa91d7cb7…`](https://arbiscan.io/tx/0xa91d7cb722fdcb1bc739b2161db7acdf911692837ec574bc9434e0eaf5be0747) |

Bytecode SHA-256 `424e78aad2b19a37…` (1278 bytes) is identical on all three chains.

**Vanity salt** (deployed via Arachnid proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C`, prefix `0000000`):
```
0xfc1ecd1953bb17cf798c1eaeed287873008f3a3038f438e9e74c3b33ce370ef5
```
- Factory init code hash: `0x30f9d9020bf9622bbe7f8a1625d447efe350dfafd0a91e6dbd62d56547db835f`
- Grind: 96,448,706 attempts in 101.1 s, generated 2026-05-10T11:40:46Z (lucked into 8 zeros while targeting 7)

- Source: `ThreeWSFactory.sol`, solc v0.8.35, optimizer 200 runs, MIT, verified on BscScan.
- ABI:
  - `deploy(bytes32 salt, bytes initCode) → address` — wraps `CREATE2(0, initCode, salt)`, reverts `"create2 failed"` on zero address.
  - `predict(bytes32 salt, bytes32 initCodeHash) → address` (view).
  - Event: `Deployed(address indexed addr, bytes32 indexed salt)`.
- Vanity 8-byte zero prefix (`0x00000000…`) saves calldata gas on every `deploy`/`predict` call.
- To replicate on a new chain, use the same EOA + nonce + init code so CREATE2 yields the same address.

## ThreeWSPayments (x402 pay-per-call receiver)

Deployed via `ThreeWSFactory.deploy(salt, initCode)`. Constructor takes the chain's
canonical USDC token, so each chain's init code differs → the cross-chain CREATE2
address parity that the factory itself enjoys does **not** apply here. The vanity
8-zero prefix only landed on BSC; Base and Arbitrum produced ordinary addresses
from the same salt.

**Owner:** `0x4022de2d36c334e73c7a108805cea11c0564f402` (deployer EOA)

**Vanity salt** (BSC-targeted, prefix `00000000`, case-insensitive):
```
0x5ef7540f7c609d04ab6d3997bc8c38f0f31ce09acccff2c11bcb3909ad542cde
```
- Factory / deployer:    `0x00000000d49195ae81759cd247cfedd9d0b479df`
- BSC init code hash:    `0xb55479df540c0e4efae39a0181051754cc236a9934f03805a743f4290178569e`
- Grind: 2,859,887,864 attempts in 22.3 s, generated 2026-05-10T13:58:54Z

| Chain            | USDC                                         | ThreeWSPayments                              | Tx |
| ---------------- | -------------------------------------------- | -------------------------------------------- | -- |
| BSC (56)         | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | [`0x00000000381f09742a30a5a49975514AeC1B72Cc`](https://bscscan.com/address/0x00000000381f09742a30a5a49975514AeC1B72Cc) | [`0xc4f4e87f…`](https://bscscan.com/tx/0xc4f4e87f67c70044a8682ea50d59fbc04e9777f453538a6916075f5409e5b7ef) |
| Arbitrum (42161) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | [`0xed3696489490dbfAFD82996ADB11165A56c33c49`](https://arbiscan.io/address/0xed3696489490dbfAFD82996ADB11165A56c33c49) | [`0xca39a600…`](https://arbiscan.io/tx/0xca39a6003e8a6144662aceae43ee2b2c5107e426e16ccf58a406d66d38f34e5f) |
| Base (8453)      | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | [`0x31B13cDe47431EfcC8616C8495204e6E6C2Ded34`](https://basescan.org/address/0x31B13cDe47431EfcC8616C8495204e6E6C2Ded34) | [`0xb6fcf60b…`](https://basescan.org/tx/0xb6fcf60b4ca16d25e135f91046107e78518fca9aa4f180d5110a5116bcdfe4d0) |

### Base deploy status — LIVE, bytecode confirmed (re-verified 2026-06-15)

The earlier "tx mined but address has no code → treat as **not deployed**" note was
**wrong** — a stale/unsynced RPC reading at deploy time. The deploy succeeded. Proof,
re-checked on-chain against live Base RPC:

- Deploy tx [`0xb6fcf60b…`](https://basescan.org/tx/0xb6fcf60b4ca16d25e135f91046107e78518fca9aa4f180d5110a5116bcdfe4d0)
  emitted `Deployed(addr=0x31B13cDe…, salt=0x5ef7540f…)` from `ThreeWSFactory` — so the
  predicted address **is** the deployed address (no CREATE2 collision, no salt mismatch).
- `eth_getCode(0x31B13cDe…)` returns **1243 bytes** (non-empty). `owner()` →
  `0x4022de2D36C334E73C7a108805Cea11C0564f402` (the deployer EOA, as on BSC/Arbitrum),
  and Base USDC `0x833589fCD6…` is embedded as the `USDC` immutable (BSC USDC is not).
- Independently re-derived: compiling the in-repo source (`contracts/ThreeWSPayments.sol`,
  solc `0.8.35`, optimizer 200) reproduces the **exact** recorded BSC init-code hash
  `0xb55479df…` and live BSC address — confirming source + settings are byte-for-byte
  correct — and CREATE2(`factory`, salt, Base-USDC init code) → `0x31B13cDe…`. The Base
  init-code hash is `0x253291817df177b537145a05d0221065be924cffa606b387221b5c6bf8f1c475`.
  (1243 bytes runtime, vs BSC's 1278, differs only because each chain's USDC enters the
  constructor as an immutable.)

**Basescan verification: PENDING (not yet verified).** Source + exact settings are
captured in-repo; run `scripts/verify-threews-payments-base.mjs` with a
`BASESCAN_API_KEY` set to publish (constructor args:
`(0x4022de2D…, 0x833589fCD6…)`). The script prints the Standard JSON Input bundle for
manual UI verification when no key is present.

### Base payment routing — EOA `payTo` is intentional (no redeploy / no redirect)

`X402_PAY_TO_BASE` stays the EOA `0x4022de2D36C334E73C7a108805Cea11C0564f402`, **not**
the contract. Base x402 settles via the `exact` scheme (EIP-3009
`transferWithAuthorization` / Permit2) through the CDP facilitator, which performs a
plain ERC-20 USDC transfer to `payTo` — it never calls `pay(bytes32)` on the recipient.
An EOA receiver is correct there: funds land directly and stay liquid. Pointing `payTo`
at the contract would route USDC in via a raw transfer with **no `Payment` event**,
recoverable only through the contract's `withdraw()` — strictly worse.

`ThreeWSPayments` is load-bearing only on **BSC** (`X402_PAY_TO_BSC` = the contract),
where Binance-Peg USDC implements no EIP-3009 and no facilitator advertises `eip155:56`,
so the contract-mediated `pay(bytes32)` "direct" scheme is the only option (see
`api/_lib/x402-bsc-direct.js`). The Base instance exists for cross-chain parity and as an
on-chain record; the Base x402 flow has no code path that calls it, and Base payments
have been settling correctly to the EOA all along.

Deploy command (run from 3D-Agent repo where `scripts/deploy-multichain.mjs` lives):
```
PK=<deployer-private-key> \
PAYMENTS_SALT=0x5ef7540f7c609d04ab6d3997bc8c38f0f31ce09acccff2c11bcb3909ad542cde \
BASE_RPC_URL=... ARB_RPC_URL=... BSC_RPC_URL=... \
node scripts/deploy-multichain.mjs
```

## AgentPayments (EVM agent-token payment engine)

EVM port of the Solana `pump_agent_payments` program. One deployment per chain
serves every agent token on that chain. Deploy + wiring guide:
[`AGENT_PAYMENTS.md`](AGENT_PAYMENTS.md). Source: [`src/AgentPayments.sol`](src/AgentPayments.sol).
Owner = protocol/global buyback authority (set to the platform multisig).

Unlike `ThreeWSPayments`, the constructor takes only `owner` (no chain-specific
immutable), so a CREATE2 deploy via `ThreeWSFactory` with a shared salt yields the
**same** address on every chain. Plain `new` deploys produce per-chain addresses
(nonce-dependent) — fill in whichever you used.

| Chain | Chain ID | AgentPayments | Owner | Routers allow-listed | Tx |
| --- | --- | --- | --- | --- | --- |
| Ethereum | 1 | TODO: fill after deployment | TODO | TODO | TODO |
| Base | 8453 | TODO: fill after deployment | TODO | TODO | TODO |
| Arbitrum One | 42161 | TODO: fill after deployment | TODO | TODO | TODO |
| Polygon | 137 | TODO: fill after deployment | TODO | TODO | TODO |
| BNB Smart Chain | 56 | TODO: fill after deployment | TODO | TODO | TODO |
| Avalanche | 43114 | TODO: fill after deployment | TODO | TODO | TODO |

After filling a row, set the matching `agentPayments` address in
[`agent-payments-sdk/src/evm/addresses.ts`](../agent-payments-sdk/src/evm/addresses.ts)
and run `npm run build` in `agent-payments-sdk/`.

## WorldMoves (event-only move-commit contract)

BNB Chain campaign, Track C: an event-only on-chain move stream for three.ws
real-time worlds, designed to be called every ~0.45s (BSC's live block time).
Source: [`src/WorldMoves.sol`](src/WorldMoves.sol). No admin, no owner, no
upgradeability — `move()` never writes storage; `checkpoint()` is the only
opt-in storage-writing call. Full design rationale in the contract NatSpec.

**Status: built, compiled, and fully unit-tested locally (19/19 `forge test`
passing). Public BSC testnet broadcast is BLOCKED on a funded deployer key**
(same root cause as campaign items 10/13/18 — no `DEPLOYER_PK` or
`BNB_TESTNET_DEPLOYER_KEY` in this environment; checked `.env`, `contracts/.env`,
`cast wallet list`, and shell env, no secret values read, only key presence;
the public tBNB faucet is reCAPTCHA-gated with no programmatic path). A
`forge script ... -vvvv` dry-run against the LIVE BSC testnet RPC
(`https://data-seed-prebsc-1-s1.bnbchain.org:8545`) simulated successfully
end-to-end 2026-07-08: constructor executes, `COORD_MIN`/`COORD_MAX` read back
correctly, 566,068 gas estimated for the deploy tx at 0.1 gwei ≈ 0.0000566068
BNB — the RPC, script, and bytecode are all deploy-ready.

**Re-verified 2026-08-02.** The dry run above still simulates green against the
same live testnet RPC (chainId 97, block 122,607,654 at read time) at exactly
566,068 gas, and `forge test` is still 19/19. The funding blocker is unchanged
and was re-checked from scratch, not carried over: shell env, `.env`,
`.env.local`, the `three-ws-api` Cloud Run service env, and Secret Manager all
hold no funded chain-97 key, and three programmatic faucet endpoints
(bnbchain's API, Stakely, Triangle) refuse or are retired. A throwaway deployer
was written to the gitignored `contracts/.env` at
`0xC4e63FdF188D94059C877b957866726A888e1240`; that key no longer exists on this
machine (see the 2026-09-02 note below for the address that replaced it, and do
not fund the retired one).
[`scripts/bnb-testnet-deploy-prove.mjs`](../scripts/bnb-testnet-deploy-prove.mjs)
is the single command for the rest: a signature-free preflight by default, and
with `--broadcast` it deploys both contracts and then proves the live sender,
reader, and ghost paths against what it just deployed.

**Re-verified 2026-09-02, and the deployer address changed.** Everything above
was re-measured against the current tree rather than carried forward:

- Both dry runs simulate green against the live BSC testnet RPC at exactly the
  same gas as before: `DeployWorldMoves` 566,068 gas and `DeployGreenfieldVault`
  1,711,362 gas, both at 0.1 gwei (0.0000566068 and 0.0001711362 BNB).
- `forge test` is 19/19 on WorldMoves and 41/41 on GreenfieldVault (the vault
  suite has grown by 7 cases since the 2026-08-02 note's 34).
- All four BSC testnet RPC lanes in `api/_lib/bnb/chains.js` answer chainId
  `0x61` today, so the lane list is no longer one rung thin.
- **The deployer is now `0x1C4918894dfA5eE11cfF9629B458b5169Cfa3871`.** The
  2026-08-02 throwaway key was not preserved across sessions, and its address
  holds 0 tBNB, so nothing was stranded by replacing it. The new key is
  testnet-only, lives in the gitignored `contracts/.env` at mode 600, and has
  never held and must never hold mainnet value.
- The faucet still has no agent path: `testnet.bnbchain.org/faucet-smart` serves
  its reCAPTCHA page rather than a claim API, and the Stakely endpoint is gone.
  Funding remains one human action.
- The full `--broadcast` path was re-validated end to end against a local
  `anvil --chain-id 97` before asking for funds, so a funded run will not be the
  first time this code executes: both contracts deployed, then 1 `join`,
  3 `move`, and 1 `leave` mined through the real `api/_lib/bnb/world-moves.js`
  sender, decoded live by `src/bnb/world-presence-reader.js` (1 Joined, 3 Moved,
  1 Left, zero reader errors), with `createGhostTracker` holding 1 ghost
  interpolating `{x:1110, z:-445}` toward its `{x:1500, z:-250}` target and
  dropping to 0 on `Left`. Local addresses are deliberately not recorded here;
  they are anvil-local and mean nothing on the public chain.

**Re-verified 2026-09-04. Still one faucet claim away, nothing else.** Every
line was re-measured against the current tree, not carried forward:

- Both dry runs simulate green against the live chain-97 RPC at exactly the
  same gas as the two previous re-reads: `DeployWorldMoves` 566,068 gas and
  `DeployGreenfieldVault` 1,711,362 gas at 0.1 gwei (0.0000566068 and
  0.0001711362 BNB, 0.000227743 BNB for the pair).
- `forge test` is 19/19 on WorldMoves and 41/41 on GreenfieldVault.
- The deployer `0x1C4918894dfA5eE11cfF9629B458b5169Cfa3871` still holds
  0 tBNB, read independently on three RPC lanes
  (`data-seed-prebsc-1-s1`, `bsc-testnet.drpc.org`,
  `bsc-testnet-rpc.publicnode.com`), all answering chainId 97.
- The `--broadcast` path was re-proven end to end against a local
  `anvil --chain-id 97`, running the real
  `scripts/bnb-testnet-deploy-prove.mjs --broadcast` rather than a
  hand-assembled sequence: both contracts deployed, then 1 `join`, 3 `move`,
  and 1 `leave` mined through the real `api/_lib/bnb/world-moves.js` sender,
  decoded live by `src/bnb/world-presence-reader.js` (1 Joined, 3 Moved,
  1 Left), with `createGhostTracker` holding 1 ghost before the leave and 0
  after. Local addresses are again deliberately not recorded: they are
  anvil-local.
- The faucet is still the only human step. Four claim paths were checked and
  every one is captcha- or account-gated: the official
  `testnet.bnbchain.org/faucet-smart` (its `/api/v1/faucet` path serves the
  HTML page, not a claim API), ghostchain.io and faucet.zalalena.com (both
  Cloudflare Turnstile / hCaptcha), and tokentool.bitbond.com (wallet connect
  plus a completed third-party profile).
- The wiring after funding is unblocked and was re-checked: `gcloud` is
  authenticated in the workspace again, `WORLD_MOVES_ADDRESS_TESTNET` is
  confirmed absent from the `three-ws-api` service env, and
  `/api/bnb/world-config?network=testnet` answers live today with
  `address: null, deployed: false`. Setting the var is a config-only
  `--update-env-vars` call, which needs no further approval.

**Real broadcast proof — anvil fork of LIVE BSC testnet state** (per
00-CONTEXT's decision-default table: "if every faucet fails, finish ALL code +
tests against a local `anvil --chain-id 97` fork" — the same workaround
prompts 02/03 used successfully). `anvil --chain-id 97 --fork-url
https://bsc-testnet.drpc.org` forked real BSC testnet at block `117848403`;
a fresh throwaway account (`0x5c04D686210421706E842A07e98B51396702e7AE`,
private key discarded after this run) was funded via `anvil_setBalance`, then
the REAL, unmodified `script/DeployWorldMoves.s.sol` was run with
`--broadcast` against the fork — same script, same bytecode that would run
against the public RPC, only the RPC endpoint differs:

```
$ forge script script/DeployWorldMoves.s.sol:DeployWorldMoves \
    --rpc-url http://127.0.0.1:8555 --private-key $THROWAWAY_PK --broadcast -vvvv
[353991] → new WorldMoves@0x71Ddcb9865632Ca3c4325dE0E4a92Cc0065c8aaE
ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.
```

- **Deploy tx:** `0x508db193ef6594c350751063657db3f9f831cb45ce590ea55f2c3759730b0710`,
  block `117848404`, status `success`.
- **Deployed address (fork-local):** `0x71Ddcb9865632Ca3c4325dE0E4a92Cc0065c8aaE`.
- **10 real `move()` transactions fired back-to-back** via `cast send`
  through the real deployed contract (not a reimplementation), each mined
  into its own block, receipts fetched independently and one full log decoded
  to confirm the exact `Moved` event shape:

  | # | tx hash | block | timestamp | gasUsed | status |
  |---|---|---|---|---|---|
  | 1 | `0xae6a706c…4a0` | 117848405 | 1783475882 | 26293 | success |
  | 2 | `0xd557c5d9…d9` | 117848406 | 1783475883 | 26293 | success |
  | 3 | `0x111b513d…a7` | 117848407 | 1783475884 | 26293 | success |
  | 4 | `0x9985f6e2…f8` | 117848408 | 1783475884 | 26293 | success |
  | 5 | `0x808f4586…f2` | 117848409 | 1783475885 | 26293 | success |
  | 6 | `0x39203f83…5d` | 117848410 | 1783475885 | 26293 | success |
  | 7 | `0x3a58b91b…d7` | 117848411 | 1783475885 | 26293 | success |
  | 8 | `0x878e042f…e8` | 117848412 | 1783475886 | 26305 | success |
  | 9 | `0xe7e9c934…be` | 117848413 | 1783475887 | 26305 | success |
  | 10 | `0x0b66bc4b…42` | 117848414 | 1783475888 | 26305 | success |

  One block minted per transaction (matches `move()`'s design goal of
  supporting one call per block); `gasUsed` is the full transaction-level
  cost (21,000 base intrinsic gas + calldata + 3-topic log), consistent with
  the `forge test` unit measurement below of ~4,800 gas of *internal
  execution* alone. Decoded log for tx `0xae6a706c…4a0` confirms the exact
  `Moved(worldId=1, player=0x5c04d686…702e7ae, x=10, y=-5, z=3, facing=36,
  blockNumber=117848405, timestamp=1783475882)` shape — every field matches
  the call args and block metadata exactly, byte-for-byte decoded from the
  real receipt, not asserted from memory.

  **Honesty note on block spacing:** these 10 blocks were mined by anvil's
  local auto-miner (one block per submitted tx, timestamps following the
  sandbox's real wall-clock as `cast send` calls executed sequentially) — this
  proves the `move()` call flow, gas cost, and event shape against real
  forked BSC-testnet EVM state, but it is NOT a measurement of BSC's live
  0.45s block-production cadence (a local fork doesn't run BSC's validator
  set). The 0.45s claim itself is separately, already, live-proven by
  `probeBlockTime()` against the public RPC (prompt 01/19 entries above,
  reconfirmed `avgBlockTimeMs: 450` on 2026-07-08) — this WorldMoves proof and
  that block-time proof are complementary, not duplicative.

Deploy (once funded, real public broadcast):
```
forge script script/DeployWorldMoves.s.sol:DeployWorldMoves \
  --rpc-url https://data-seed-prebsc-1-s1.bnbchain.org:8545 \
  --private-key $DEPLOYER_PK \
  --broadcast
```

Once a real public-testnet deploy tx exists, replace the fork-local address/tx
above with the BscScan-visible ones (same script, same bytecode — only the
`--rpc-url`/`--private-key` change).

### Prompt 18 — two-wallet world E2E proof (anvil, `--block-time 0.45`)

Prompt 18 (bnb-chain campaign, work order 18, world e2e demo; retired, see git history) needed two real participants
moving in the same world at once with block spacing that actually reproduces
BSC's live ~0.45s cadence — a step up from 14/15/16's wall-clock-paced local
blocks. This run started a FRESH (non-forked) `anvil --chain-id 97 --block-time
0.45 --port 8555` — anvil's interval-mining flag accepts fractional seconds, so
this genuinely interval-mines a block every 0.45s regardless of pending txs,
the same rate 00-CONTEXT's `probeBlockTime()` measured live on the public RPC
(`avgBlockTimeMs: 450`), not merely "close to it."

- **Deploy:** the real, unmodified `DeployWorldMoves.s.sol` script,
  `--broadcast`, deployer = anvil's well-known account #0 (public test key,
  zero real funds). Deploy tx
  `0xab86fb5937e655dd1e64d8e45118ca5624d20f9b4bd213704067f5dc7ae8b65a`, block
  `18`, status success, contract `0x5FbDB2315678afecb367f032d93F642f64180aa3`.
- **Two independent real Chromium browser contexts** (Playwright, headless),
  each pre-seeded with a distinct funded anvil test-mnemonic account
  (`0x7099…dc79C8` / `0x3C44…4293BC`) as its `three.ws:bnb-presence-key`
  localStorage session key, navigated to the real `/agora?play=1` route with
  the existing `?bnbDevAddress=&bnbDevRpc=` pre-public-deploy override
  (`src/agora/onchain-presence.js`'s `turnOn()`), then driven with real WASD
  keyboard input for 60s each, concurrently.
- **7 real `move()` txs landed on-chain, all `status: success`, `mode:
  self-pay`** (MegaFuel testnet declined sponsorship — no policy provisioned
  for these throwaway addresses, the expected/documented outcome, see prompt
  15/16 entries):

  | wallet | tx hash | block | gasUsed | block timestamp (unix) |
  |---|---|---|---|---|
  | A | `0xd1b5188c…9d7` | 1849 | 26281 | 1783496844 |
  | A | `0xb63fdb5b…997` | 1880 | 26305 | 1783496858 |
  | A | `0x5f772762…f61` | 1927 | 26305 | 1783496879 |
  | A | `0x11dd19f4…b32` | 1986 | 26305 | 1783496905 |
  | B | `0x945ce448…715` | 1863 | 26281 | 1783496850 |
  | B | `0x317554f6…b20` | 1916 | 26305 | 1783496874 |
  | B | `0x3d378b15…c78` | 1963 | 26305 | 1783496895 |

  Real block-cadence check across the run: block 1849 (ts 1783496844) →
  block 1986 (ts 1783496905) is 137 blocks over 61 real seconds = **0.445s
  average inter-block time**, matching the live BSC testnet ~0.45s Fermi
  cadence to within 1%. Finer-grained per-block sampling (`cast block 1849
  1850 1851 1852 1853 1854 1855`) shows two blocks per integer second
  (`1849,1850→...844`, `1851,1852→...845`, `1853,1854,1855→...846`) —
  consistent with true sub-second (~0.45–0.5s) interval mining, not
  per-tx-triggered mining.
- **Cross-wallet visibility confirmed live, independently, both directions:**
  session A's console logged `ghost joined player=0x3C44…4293BC` (wallet B)
  and session B's console logged `ghost joined player=0x7099…dc79C8` (wallet
  A) — each browser picked up the other's real on-chain `Moved`/`Joined`
  events via `watchWorldPresence()`, with zero coordination between the two
  Playwright contexts beyond the shared chain.

**Honesty note:** identical in spirit to prompt 14/15's caveat — this is a
local anvil instance, not the live BSC testnet validator set, so it does not
substitute for `probeBlockTime()`'s live measurement. What's new here is that
the local cadence was explicitly *configured* to match the live-measured rate
(`--block-time 0.45`) rather than following the sandbox's incidental
wall-clock pacing, so the block-spacing numbers above are a deliberate
reproduction of the real rate, not a coincidence of how fast `cast send` was
invoked. Full run log, receipts, and the two-wallet Playwright script (deleted
after the run per repo hygiene — reproducible from this write-up) recorded in
`prompts/bnb-chain/PROGRESS.md`'s prompt 18 entry.

## GreenfieldVault (pay → PermissionHub grant, on-chain-gated 3D asset vault)

BNB Chain campaign, Track B: a BSC marketplace contract that, on payment,
calls the REAL Greenfield `PermissionHub.createPolicy` cross-chain, granting
the buyer read permission on an encrypted object. Source:
[`src/GreenfieldVault.sol`](src/GreenfieldVault.sol); real interface stubs
(sourced from `bnb-chain/greenfield-contracts`, verified against `master` on
2026-07-08 — no invented ABI) in [`src/greenfield/`](src/greenfield). Uses the
real, already-deployed `PermissionHub`/`CrossChain`/`ObjectHub` hubs — no
Greenfield contract of our own to deploy.

Constructor-supplied hub addresses (deploy script
[`script/DeployGreenfieldVault.s.sol`](script/DeployGreenfieldVault.s.sol)
defaults per `block.chainid`, env-overridable):

| Network | PermissionHub | CrossChain | ObjectHub (IGnfdAccessControl) |
| --- | --- | --- | --- |
| BSC mainnet (56) | `0xe1776006dBE9B60d9eA38C0dDb80b41f2657acE8` | `0x77e719b714be09F70D484AB81F70D02B0E182f7d` | `0x634eB9c438b8378bbdd8D0e10970Ec88db0b4d0f` |
| BSC testnet (97) | `0x25E1eeDb5CaBf288210B132321FBB2d90b4174ad` | `0xa5B2c9194131A4E0BFaCbF9E5D6722c873159cb7` | `0x1b059D8481dEe299713F18601fB539D066553e39` |

(Mainnet CrossChain/ObjectHub bytecode-verified 2026-07-07 per
`prompts/bnb-chain/00-CONTEXT.md`; PermissionHub mainnet + all testnet
addresses read live from `bnb-chain/greenfield-contracts`'s README "Contract
Entrypoint" tables on 2026-07-08 — never invented.)

**Status: built, compiled, and fully unit-tested locally (34/34 `forge test`
passing, including two dedicated re-entrancy proofs against a mocked
PermissionHub/CrossChain/IGnfdAccessControl). NOT deployed to BSC testnet.** A
`forge script ... -vvvv` dry-run against the live BSC testnet RPC
(`https://data-seed-prebsc-1-s1.bnbchain.org:8545`, also reachable via the new
`bsc_testnet` `foundry.toml` alias) simulated successfully end-to-end
(constructor executes against the real testnet PermissionHub/CrossChain/
ObjectHub addresses above, ~1.16M gas estimated for the deploy tx at 0.1 gwei
≈ 0.000170 BNB) — the RPC, script, and bytecode are all deploy-ready. The only
missing piece is a funded deployer key: neither `DEPLOYER_PK` nor
`BNB_TESTNET_DEPLOYER_KEY` is present in this environment (checked `.env`,
`contracts/.env`, `cast wallet list`, and shell env; no secret values were
read, only key presence). Same funding blocker as campaign items 13 and 18 —
owner-only to unblock (fund a deployer EOA via the tBNB faucet, then run the
broadcast command below).

**Re-verified 2026-08-02.** The dry run still simulates green against the live
testnet RPC at 1,695,618 total gas (1,226,903 of it the constructor) at 0.1
gwei = 0.0001695618 BNB, and `forge test` is still 34/34. The ~1.16M/~0.000170
BNB figures above were the constructor-only measurement; the number that
matters for funding is the total. The funding blocker is unchanged; see the
re-verification notes in the WorldMoves section for the full re-check and for
the throwaway deployer address now waiting on the faucet. Re-measured again
2026-09-02 and 2026-09-04: same 1,711,362 total gas both times, and `forge
test` is 41/41. See the WorldMoves section's 2026-09-04 block for the full
re-read, including the four faucet paths that are all human-gated.

Deploy (once funded), preferred, because it also proves the live paths in the
same run:
```
node scripts/bnb-testnet-deploy-prove.mjs            # preflight, signs nothing
node scripts/bnb-testnet-deploy-prove.mjs --broadcast # deploy both + live proof
```

The underlying forge command it runs, if you want it by hand:
```
forge script script/DeployGreenfieldVault.s.sol:DeployGreenfieldVault \
  --rpc-url https://data-seed-prebsc-1-s1.bnbchain.org:8545 \
  --private-key $BNB_TESTNET_DEPLOYER_KEY \
  --broadcast
```

After a real deploy: replace this status block with the address, deploy tx
hash, and a BscScan link; have a seller `grantRole(ROLE_CREATE, vault, expiry)`
on the real testnet ObjectHub for a real uploaded object (prompt 09); execute
one real `buy()`; and paste the BSC tx hash plus the resulting
`PermissionHub.settleCreatePolicy`/`PolicyGranted` proof (BscScan +
GreenfieldScan once the cross-chain ack settles) per
the bnb-chain campaign work order 10 (vault contract; retired, see git history) definition of done.

**Prompt 11 (vault unlock API) local-anvil proof, 2026-07-08 — mocked-hubs
deploy script added:** [`script/DeployGreenfieldVaultMocked.s.sol`](script/DeployGreenfieldVaultMocked.s.sol)
deploys `MockCrossChain`/`MockPermissionHub`/`MockGnfdAccessControl` (the
same mocks `test/GreenfieldVault.t.sol`'s 34-test suite already validates)
plus a real `GreenfieldVault` wired to them, on a local anvil chain — LOCAL
TEST-ONLY, never point it at a real network. Used to prove `api/vault/*`
(list/status/unlock) against a genuinely deployed contract + real
transactions before a funded deployer key exists; full run log in
`prompts/bnb-chain/PROGRESS.md`'s prompt 11 entry. One real bug was caught
and fixed by this run: `getVaultLogs()` resolved its default `toBlock` via
viem's `getBlockNumber()`, which memoizes for several seconds by default —
two calls made back-to-back (e.g. right after a `buy()`/settlement tx, the
exact shape of a real poll) could read a stale `toBlock` and silently miss
the newest events. Fixed with `cacheTime: 0` on that one call.

**Prompt 13 (vault-e2e-proof) capstone chain run, 2026-07-08 — same mocked-hubs script, full
list→buy→settle→unlock→decrypt chain proven together:** re-deployed the identical
`DeployGreenfieldVaultMocked.s.sol` (same deterministic addresses:
`GreenfieldVault 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9`,
`MockPermissionHub 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`) against a fresh anvil chain, then ran
a real GLB (from the free forge lane) through `encryptGlb` → `list()` → `buy()` →
`settleCreatePolicy()` → the REAL exported `api/vault/{list,status,unlock,download}.js` handlers →
client-side `unwrapKey`/`decryptGlb` → a byte-identical sha256 match against the original GLB. Full
proof (every tx hash, every HTTP response, the real "Query failed with (6): No such bucket" finding
from testing `download.js` against live Greenfield testnet infra with a throwaway operator key) is in
`prompts/bnb-chain/PROGRESS.md`'s prompt 13 entry. One real bug caught and fixed by this run:
`settleCreatePolicy(saleId, status)`'s second argument is `STATUS_SUCCESS = 0` (not `1`) per
`GreenfieldVault.sol`'s own constant — passing `1` silently drives the contract's `Failed` branch and
clears `saleIdOf`, with `waitForTransactionReceipt` still resolving normally (a successful receipt
is not the same as the contract's OWN state machine landing where the caller assumed).

## Notes

- Addresses are authoritative in [`src/erc8004/abi.js`](../src/erc8004/abi.js) (`REGISTRY_DEPLOYMENTS`).
- Changing any address requires redeployment and updating `REGISTRY_DEPLOYMENTS` in `abi.js` and `api/_lib/erc8004-chains.js`.
- Deploy scripts: [`script/Deploy.s.sol`](script/Deploy.s.sol) (testnet), [`script/DeployValidationMainnet.s.sol`](script/DeployValidationMainnet.s.sol) (mainnet ValidationRegistry).
- 15-chain deploy command list: [`script/deploy-validation-registry.sh`](script/deploy-validation-registry.sh).
- After deployment: run `computeAddress(DEPLOYER_ADDRESS)` in the script (dry-run) to confirm the address, then update `validationRegistry` in `src/erc8004/abi.js` and `sdk/src/erc8004/abi.js`.
