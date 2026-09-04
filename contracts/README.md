# three.ws on-chain contracts

Every contract and program three.ws owns lives here: the Solidity set built with
[Foundry](https://book.getfoundry.sh/), and the three Solana programs built with
[Anchor](https://www.anchor-lang.com/). Solana is the home chain; the EVM
contracts are additional surfaces.

> **Reviewing these contracts?** Start at [`AUDIT-README.md`](./AUDIT-README.md):
> scope, deploy status, where the money is, the invariant ids, and the exact
> commands that reproduce every coverage and static-analysis number.

> **You probably do not need to deploy the ERC-8004 registries.** The canonical
> ERC-8004 reference contracts are already live at the same addresses on every
> major EVM chain, and [`../src/erc8004/abi.js`](../src/erc8004/abi.js) already
> points at them: identity `0x8004A169...` on mainnets, `0x8004A818...` on
> testnets. The registry sources here are a local reference implementation,
> useful if you need to fork, audit, or run a private deployment.

## What is in here

| Contract | Source | Role | Deploy status |
| --- | --- | --- | --- |
| `ThreeWSPayments` | [`ThreeWSPayments.sol`](./ThreeWSPayments.sol) | x402 pay-per-call USDC receiver | Live on BNB Smart Chain, Base, Arbitrum One. Custodies real USDC |
| `ThreeWSFactory` | [`ThreeWSFactory.sol`](./ThreeWSFactory.sol) | CREATE2 deployer behind the platform's vanity addresses | Live on the same three chains |
| `IdentityRegistry` | [`src/IdentityRegistry.sol`](./src/IdentityRegistry.sol) | ERC-8004 agents as ERC-721, EIP-712 delegated wallet, key/value metadata | Canonical ERC-8004 address live everywhere; not deployed from this tree |
| `ReputationRegistry` | [`src/ReputationRegistry.sol`](./src/ReputationRegistry.sol) | One signed score per reviewer per agent, aggregated on-chain | Same as above |
| `ValidationRegistry` | [`src/ValidationRegistry.sol`](./src/ValidationRegistry.sol) | Allow-listed validators attest to off-chain proofs (for example glTF-Validator reports) | Not deployed from this tree; the platform uses the ERC-8004 reference registry |
| `AgentPayments` | [`src/AgentPayments.sol`](./src/AgentPayments.sol) | Payments in, split into authority and buyback shares, buyback swaps and burns | Not deployed. See [`AGENT_PAYMENTS.md`](./AGENT_PAYMENTS.md) |
| `GreenfieldVault` | [`src/GreenfieldVault.sol`](./src/GreenfieldVault.sol) | Pay-to-unlock marketplace over a real BNB Greenfield cross-chain permission grant | Not deployed to a public chain; proven on an anvil fork |
| `WorldMoves` | [`src/WorldMoves.sol`](./src/WorldMoves.sol) | Event-only move stream for the Agora world. No value, no admin | Not deployed to a public chain |
| `skill_license` | [`skill-license/`](./skill-license) | Solana: a 1-of-1 NFT access key per purchased skill, revocable on refund | Not deployed. Program id reserved |
| `agent_invocation` | [`agent-invocation/`](./agent-invocation) | Solana: verifiable agent-to-agent invocation events | Not deployed. Program id reserved |
| `knock_escrow` | [`knock-escrow/`](./knock-escrow) | Solana: a priced message held in escrow that pays out only against a reply, and refunds in full otherwise | Not deployed. Program id reserved |

Per-address provenance and every chain id: [`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

## Build and test the Solidity set

Install Foundry once:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Then, from this directory:

```bash
forge build
forge test
```

242 tests across 8 suites, all passing:

| Suite | Tests |
| --- | --- |
| `AgentPaymentsTest` | 57 |
| `GreenfieldVaultTest` | 41 |
| `IdentityRegistryTest` | 37 |
| `ReputationRegistryTest` | 31 |
| `ThreeWSPaymentsTest` | 22 |
| `ValidationRegistryTest` | 22 |
| `WorldMovesTest` | 19 |
| `ThreeWSFactoryTest` | 13 |

`forge test --summary` reprints that table. Dependencies (`forge-std`,
`openzeppelin-contracts`) are vendored under `lib/`, so no `forge install` step
is needed.

## Build and test the Solana programs

The invariant suite in [`program-tests/`](./program-tests) runs the real compiled
SBF bytecode in LiteSVM, so the bytecode has to exist before the tests run:

```bash
cd skill-license       && cargo-build-sbf
cd ../agent-invocation && cargo-build-sbf
cd ../knock-escrow     && cargo-build-sbf
cd ../program-tests    && cargo test
```

`cargo-build-sbf` ships with the Solana (Agave) toolchain, and `cargo test` needs
a host Rust toolchain:

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

A cold SBF build takes minutes per program; the tests themselves run in seconds.
Green is 42 tests: 21 for `skill_license`, 11 for `agent_invocation`, and 10 for
`knock_escrow`. The harness, the invariant ids, and the reason the LiteSVM clock
must be set are all documented in
[`program-tests/README.md`](./program-tests/README.md).

## Deploy the registries to Base Sepolia

Only needed for a private or forked deployment. The platform itself reads the
canonical registries.

1. Fund a deployer wallet with Base Sepolia ETH:
   https://www.alchemy.com/faucets/base-sepolia

2. Configure environment:

    ```bash
    cp .env.example .env
    # Fill in DEPLOYER_PK and BASESCAN_API_KEY
    ```

3. Deploy and verify:

    ```bash
    source .env
    forge script script/Deploy.s.sol:Deploy \
        --rpc-url $BASE_SEPOLIA_RPC_URL \
        --private-key $DEPLOYER_PK \
        --broadcast \
        --verify
    ```

    To rehearse without spending anything, point `--rpc-url` at a local
    `anvil` and use one of its funded dev keys. The script prints the three
    addresses and the `ValidationRegistry` owner either way.

4. Point the browser code at your deployment. In
   [`../src/erc8004/abi.js`](../src/erc8004/abi.js), `REGISTRY_DEPLOYMENTS[84532]`
   currently references the shared `TESTNET` constant that all seven supported
   testnets point at, so editing that constant would repoint every one of them.
   Replace the single entry with a literal instead:

    ```js
    84532: {
        identityRegistry: '0xYourIdentityRegistry',
        reputationRegistry: '0xYourReputationRegistry',
        validationRegistry: '0xYourValidationRegistry',
    },
    ```

## Deploy the registries to Base mainnet

Same as above with `$BASE_RPC_URL`, replacing the `8453` entry (which references
the shared `MAINNET` constant) the same way.

## After deploy: register three.ws itself

```js
// Browser console on three.ws with a wallet connected to Base Sepolia:
import { registerAgent } from './src/erc8004/index.js';
const r = await registerAgent({
    name: 'three.ws',
    description: 'AI-powered 3D model viewer & validation agent',
    glbFile: yourGlbFile, // a File; omit and pass glbUrl if it is already pinned
    onStatus: console.log,
});
console.log(r); // { agentId, registrationUrl, txHash, chainId }
```

Pinning uses the platform's built-in R2 backend by default. Pass
`apiToken: '<your Pinata JWT>'` to pin through your own Pinata account instead.
The full option list (2D image, auto thumbnail, declared services, x402 support)
is documented on `registerAgent` in
[`../src/erc8004/agent-registry.js`](../src/erc8004/agent-registry.js).

Then update
[`../public/.well-known/agent-registration.json`](../public/.well-known/agent-registration.json):

```json
"registrations": [
    { "agentId": 1, "agentRegistry": "eip155:84532:0xYourIdentityRegistryAddress" }
]
```

## Authorize a validator (for on-chain validation records)

The registry the platform actually reads and writes is the ERC-8004 reference
`ValidationRegistryUpgradeable`, which has no allowlist. A validator earns the
right to attest per agent, from the agent's owner:

```bash
# The agent's owner opens a request naming the validator, on the Identity
# Registry's terms (owner, per-token approval, or approval for all).
cast send $VALIDATION_REGISTRY \
    "validationRequest(address,uint256,string,bytes32)" \
    $VALIDATOR_ADDR $AGENT_ID "$REPORT_URI" $REQUEST_HASH \
    --rpc-url $BASE_SEPOLIA_RPC_URL \
    --private-key $OWNER_PK
```

To let a validator (for example the platform's) open requests itself, the owner
approves it as an operator instead: `approve(validator, agentId)` or
`setApprovalForAll(validator, true)` on the Identity Registry.

The validator then answers with
`validationResponse(requestHash, response, responseURI, responseHash, tag)`, which
the `recordValidation()` helper in
[`../src/erc8004/validation-recorder.js`](../src/erc8004/validation-recorder.js)
wraps (including the request leg when the same wallet owns the agent).

## Layout

```
contracts/
├── ThreeWSPayments.sol          live x402 USDC receiver
├── ThreeWSFactory.sol           live CREATE2 vanity deployer
├── src/
│   ├── IdentityRegistry.sol
│   ├── ReputationRegistry.sol
│   ├── ValidationRegistry.sol
│   ├── IIdentityRegistry.sol
│   ├── AgentPayments.sol
│   ├── GreenfieldVault.sol
│   ├── WorldMoves.sol
│   └── greenfield/              BNB Greenfield precompile interfaces
├── test/                        8 Foundry suites, 242 tests
│   └── mocks/                   MockGreenfield, Reentrant
├── script/                      Foundry deploy scripts, one per contract
├── skill-license/               Anchor program + DEPLOYMENT.md
├── agent-invocation/            Anchor program
├── knock-escrow/                Anchor program, escrowed pay-per-reply
├── program-tests/               LiteSVM invariant suite over the real bytecode
├── idl/                         vendored Anchor IDLs (ours plus the launchpad
│                                interfaces the platform reads; see idl/pump/README.md)
├── audit/                       committed Slither + Clippy output
├── vanity/                      CREATE2 salt grind artifacts
├── lib/                         vendored forge-std + openzeppelin-contracts
├── AUDIT-README.md              start here for a review
├── DEPLOYMENTS.md               address provenance per chain
├── AGENT_PAYMENTS.md            AgentPayments design notes
├── foundry.toml
└── .env.example
```
