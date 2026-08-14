# ERC-8004 Contracts (optional / reference)

> **You probably don't need to deploy these.** The canonical ERC-8004 reference
> contracts are already live at the same addresses on every major EVM chain
> (see [`../src/erc8004/abi.js`](../src/erc8004/abi.js)). Identity:
> `0x8004A818...` (mainnet) / `0x8004A169...` (testnet). This directory is kept
> as a local reference implementation — useful if you ever need to fork, audit,
> or run a private deployment.

> **Reviewing these contracts?** Start at [`AUDIT-README.md`](./AUDIT-README.md):
> scope, deploy status, where the money is, the invariant ids, and the exact
> commands that reproduce every coverage and static-analysis number.

Three registries implementing [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) for the `3d-agent` project:

- **IdentityRegistry** — ERC-721 agents with `tokenURI`, delegated wallet (EIP-712), and key/value metadata.
- **ReputationRegistry** — one signed score per reviewer per agent, aggregated on-chain.
- **ValidationRegistry** (not deployed; the platform uses the ERC-8004 reference registry instead): requested validators attest to off-chain proofs (e.g. glTF-Validator reports).

The browser code in `../src/erc8004/` already targets these ABIs — only the deployed addresses are missing.

## Build & test

```bash
forge build
forge test -vv
```

25 tests across the three contracts. All passing.

## Deploy to Base Sepolia

1. Install Foundry if you haven't:

    ```bash
    curl -L https://foundry.paradigm.xyz | bash && foundryup
    ```

2. Fund a deployer wallet with Base Sepolia ETH: https://www.alchemy.com/faucets/base-sepolia

3. Configure environment:

    ```bash
    cp .env.example .env
    # Fill in DEPLOYER_PK and BASESCAN_API_KEY
    ```

4. Deploy + verify:

    ```bash
    source .env
    forge script script/Deploy.s.sol:Deploy \
        --rpc-url $BASE_SEPOLIA_RPC_URL \
        --private-key $DEPLOYER_PK \
        --broadcast \
        --verify
    ```

5. Copy the three addresses from the console output into [`../src/erc8004/abi.js`](../src/erc8004/abi.js) under the `84532` entry of `REGISTRY_DEPLOYMENTS`.

## Deploy to Base mainnet

Same as above but with `$BASE_RPC_URL`, and update the `8453` entry in `abi.js`.

## After deploy: register the three.ws itself

```js
// Browser console on three.ws with wallet connected to Base Sepolia:
import { registerAgent } from './src/erc8004/index.js';
const r = await registerAgent({
    glbFile: /* your GLB File */,
    name: 'three.ws',
    description: 'AI-powered 3D model viewer & validation agent',
    apiToken: 'YOUR_WEB3STORAGE_TOKEN',
    onStatus: console.log,
});
console.log(r); // { agentId, registrationCID, txHash }
```

Then update [`../public/.well-known/agent-registration.json`](../public/.well-known/agent-registration.json):

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
the `recordValidation()` helper in `../src/erc8004/validation-recorder.js` wraps
(including the request leg when the same wallet owns the agent).

## Layout

```
contracts/
├── src/
│   ├── IdentityRegistry.sol
│   ├── ReputationRegistry.sol
│   └── ValidationRegistry.sol
├── test/
│   ├── IdentityRegistry.t.sol
│   ├── ReputationRegistry.t.sol
│   └── ValidationRegistry.t.sol
├── script/
│   └── Deploy.s.sol
├── foundry.toml
├── .env.example
└── README.md
```
