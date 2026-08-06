# paid-mcp-server

A complete, runnable MCP server whose tools **charge per call** in USDC on Solana over [x402](https://x402.org). It ships two tools on purpose:

| Tool | Price | What it does |
| --- | --- | --- |
| `getting_started` | free | Explains the server, both prices, and the payment flow. No payment, no wallet, no account. |
| `inspect_model` | $0.002 | Fetches a public glTF/GLB by URL and returns a structural report plus prioritized optimization findings. |

The paid tool does real work: it fetches the model, parses the container, counts geometry from accessors rather than estimating, and returns findings with fixes. There is no mock path anywhere in this example.

The narrative walkthrough of this code is the tutorial [Monetize an MCP server: paid tools with x402](https://three.ws/tutorials/monetize-mcp-server), and the design argument behind it is the post [How to monetize an MCP server](https://three.ws/blog/monetize-mcp-server-x402-paid-tools).

## Run it

```bash
cd examples/paid-mcp-server
npm install
X402_PAY_TO_SOLANA=<your-solana-address> npm start
```

The server speaks MCP over stdio and prints one line to stderr when it is ready. It refuses to start without a pay-to address, because a paid server that cannot receive money is a bug, not a default.

Explore it with the official inspector:

```bash
X402_PAY_TO_SOLANA=<your-solana-address> npm run inspect
```

## Wire it into a client

**Claude Code**, one line:

```bash
claude mcp add model-inspect \
  --env X402_PAY_TO_SOLANA=<your-solana-address> \
  -- node /absolute/path/to/examples/paid-mcp-server/src/index.js
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"model-inspect": {
			"command": "node",
			"args": ["/absolute/path/to/examples/paid-mcp-server/src/index.js"],
			"env": { "X402_PAY_TO_SOLANA": "<your-solana-address>" }
		}
	}
}
```

To *pay* this server from another assistant, give that assistant a wallet with [`@three-ws/x402-mcp`](https://www.npmjs.com/package/@three-ws/x402-mcp).

## What an unpaid call returns

Calling `inspect_model` with no payment returns the challenge, not the report. This is the real response from this code:

```json
{
	"x402Version": 2,
	"error": "Payment required to access this tool",
	"resource": {
		"url": "mcp://tool/inspect_model",
		"description": "Fetch a public glTF or GLB model by URL and return its structural report ...",
		"mimeType": "application/json"
	},
	"accepts": [
		{
			"scheme": "exact",
			"network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
			"amount": "2000",
			"payTo": "<your-solana-address>",
			"maxTimeoutSeconds": 60,
			"extra": { "name": "USDC", "decimals": 6, "feePayer": "..." }
		}
	],
	"extensions": { "bazaar": { "info": { "input": { "type": "mcp", "toolName": "inspect_model" } } } }
}
```

`amount` is atomic units of 6-decimal USDC, so `"2000"` is $0.002. The `bazaar` extension is what makes the tool discoverable to agents shopping for paid capabilities.

An x402-capable client signs, retries the same call with the payload in `_meta["x402/payment"]`, and receives the report with the settlement receipt in `_meta["x402/payment-response"]`.

## What a paid call returns

Verbatim output for `https://three.ws/avatars/cesium-man.glb`:

```json
{
	"source": "https://three.ws/avatars/cesium-man.glb",
	"container": "glb",
	"sizeBytes": 438044,
	"binaryChunkBytes": 409680,
	"generator": "COLLADA2GLTF",
	"gltfVersion": "2.0",
	"scenes": 1, "nodes": 22, "meshes": 1, "materials": 1, "textures": 1,
	"animations": 1, "skins": 1, "cameras": 0, "morphTargets": 0,
	"images": { "embedded": 1, "external": 0, "dataUri": 0 },
	"primitives": { "primitives": 1, "indexed": 1, "modes": [4] },
	"geometry": { "vertices": 3273, "triangles": 4672 },
	"extensionsUsed": [],
	"findings": [
		{
			"severity": "low",
			"issue": "No geometry compression",
			"detail": "The model declares neither KHR_draco_mesh_compression nor EXT_meshopt_compression.",
			"fix": "Run gltf-transform with meshopt compression. Typical saving is 40 to 70 percent of the geometry payload."
		}
	]
}
```

## How the payment works

Three steps, and the order is the whole design:

1. **Verify.** The wrapper checks the buyer's payload against what the tool advertised, using a facilitator. Nothing has moved yet.
2. **Work.** The handler runs. Only now.
3. **Settle.** The payment lands on Solana and the receipt returns with the result.

Because settlement is last, **every failure path in this example throws**, so a bad URL, an unreachable host, a file that is too large, or a corrupt container costs the caller nothing and can be retried with the same signed payment. A caller is charged only when a report was actually produced.

## Environment

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `X402_PAY_TO_SOLANA` | yes | none | Solana address that receives USDC. `X402_PAY_TO` is accepted as an alias. |
| `X402_FACILITATOR_URL` | no | `https://facilitator.payai.network` | Facilitator used for `/verify` and `/settle`. |
| `X402_FACILITATOR_TOKEN` | no | none | Bearer token, if your facilitator requires one. |
| `X402_FEE_PAYER_SOLANA` | no | platform fee payer | Sponsor that pays the Solana transaction fee. |
| `X402_ASSET_MINT_SOLANA` | no | canonical USDC mint | Override the settlement asset. |

Put these in a local `.env` (gitignored, so the repo ships no template file) and export it, or pass the variables inline as shown above:

```sh
cat > .env <<'EOF'
X402_PAY_TO_SOLANA=your-solana-address
EOF
set -a && . ./.env && set +a && npm start
```

## Safety properties worth copying

- **The fetch is SSRF-guarded.** Only `https://`, redirects refused, DNS resolved and checked against private, loopback, link-local, and carrier-grade NAT ranges before any byte moves. A paid endpoint that fetches user-supplied URLs is an internal-network probe unless it does this.
- **Bounded input.** 32 MB ceiling checked twice (declared `content-length` and actual bytes) and a 20 second timeout.
- **Tool annotations are honest.** Both tools declare `readOnlyHint: true` and `destructiveHint: false`, which is what annotation-aware clients use to decide whether to prompt.
- **Registration touches no secrets.** Payment wiring is built lazily on first call, so `tools/list` and the test suite work with no environment at all.

## Files

| Path | What it is |
| --- | --- |
| [src/index.js](./src/index.js) | Server entry: registers both tools, connects stdio, fails fast on missing config. |
| [src/tools.js](./src/tools.js) | The free orientation tool and the paid inspection tool. |
| [src/payments.js](./src/payments.js) | The x402 wiring: facilitator client, accepts, and the `paid()` wrapper. |
| [src/gltf.js](./src/gltf.js) | Guarded fetch, GLB/glTF parsing, structural stats, and the findings engine. |
| [test/gltf.test.mjs](./test/gltf.test.mjs) | Parser, geometry math, findings, and SSRF guard, all offline and deterministic. |
| [test/server.test.mjs](./test/server.test.mjs) | A real MCP client over an in-memory transport: tool list, the free tool, and the no-report-without-payment guarantee. |

```bash
npm test   # 15 tests, no network required for the deterministic ones
```

## Taking it to production

1. **Point `X402_PAY_TO_SOLANA` at a wallet you control.** Test with a small balance first.
2. **Choose a facilitator.** PayAI is free and community run. Coinbase CDP settlements are additionally indexed by catalogs agents query.
3. **Fill in discovery metadata.** The `description`, `inputSchema`, and `example` in `src/tools.js` are what a buyer sees in a catalog before deciding to call you.
4. **Rate limit by payer.** Payment is not authorization. A funded wallet can still hammer you.
5. **Record every settlement.** The receipt carries network, payer, and transaction: that is your ledger.

## Related

- [docs/tutorials/monetize-mcp-server.md](../../docs/tutorials/monetize-mcp-server.md): the step-by-step build of this server.
- [docs/mcp-x402-bazaar.md](../../docs/mcp-x402-bazaar.md): where paid services get discovered.
- [packages/x402-server](../../packages/x402-server/): the same idea for plain HTTP endpoints.
- [packages/x402-mcp](../../packages/x402-mcp/): the buyer side, for testing this server from an assistant.
- [packages/ibm-x402-mcp](../../packages/ibm-x402-mcp/): a production connector built on this exact pattern.
