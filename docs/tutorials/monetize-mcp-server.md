# Monetize an MCP Server: Charge per Tool Call with x402

By the end of this tutorial you will have an MCP server that **charges other people's AI agents** for its tools. A caller invokes a tool, the server answers with a machine-readable price, the caller pays in USDC on Solana, and only then does the work run. No API keys, no signup page, no billing relationship to maintain.

The finished code is in [`examples/paid-mcp-server`](https://github.com/nirholas/three.ws/tree/main/examples/paid-mcp-server), and every snippet below is taken from it. The wider argument for pricing tools this way is in the post [How to monetize an MCP server](/blog/monetize-mcp-server-x402-paid-tools).

**What you'll build:**

- An MCP server over stdio with two tools: one free, one paid
- A real paid capability (fetch a glTF/GLB model and return a structural report with optimization findings)
- The x402 payment loop inside `tools/call`, using the same wiring three.ws runs in production
- Discovery metadata so agents shopping for paid services can find your tool
- A test suite that proves the tool never returns its product without payment

**Prerequisites:**

- Node.js 20+
- A Solana address to receive USDC. You do not need SOL in it: settlement is facilitator-broadcast and the transaction fee is paid by a sponsor.
- An MCP client to test with (Claude Code, Claude Desktop, Cursor, or the MCP Inspector)

**Time:** about 40 minutes.

---

## 1. Decide what is worth charging for

A paid tool that wraps a free public API is a toll booth on an open road, and agents route around it as soon as one of them reads the docs. Put your idea through three tests:

1. **Can the caller do it locally?** If the model can answer from context, it will, and it should. Charge for what needs your data, your credentials, your hardware, or your index.
2. **Does each call cost you something?** Marginal cost is what makes per-call pricing defensible rather than extractive.
3. **Is the output structured?** Your buyer is a language model. JSON it can reason over beats prose it has to parse.

This tutorial charges for **model inspection**: fetch a glTF or GLB by URL, parse the container, and report scene structure, geometry totals, declared extensions, and a prioritized list of optimization findings. It passes all three tests. The caller cannot fetch and parse a 400 KB binary in-context, the work costs bandwidth and CPU, and the result is a JSON report.

## 2. Scaffold

```bash
mkdir paid-mcp-server && cd paid-mcp-server
npm init -y && npm pkg set type=module
npm install @modelcontextprotocol/sdk @x402/core @x402/mcp @x402/svm @x402/extensions zod
```

Five packages, all real: the MCP SDK for the protocol, and the `@x402/*` family for payment. Nothing here is a three.ws-specific dependency, so the pattern transfers to any MCP server you already run.

## 3. Understand the payment convention before you write it

On plain HTTP, x402 uses the `402` status and an `X-PAYMENT` header. MCP has no status codes, so the transport spec puts the same handshake inside the message:

| Step | Where it lives |
| --- | --- |
| Unpaid call | An ordinary `tools/call` with no payment metadata |
| Challenge | The tool result carries a `PaymentRequired` envelope quoting `accepts[]` |
| Payment | The client retries the same call with the signed payload in `_meta["x402/payment"]` |
| Receipt | The settlement record returns in `_meta["x402/payment-response"]` |

x402-capable clients run that loop with no user interaction. Clients that cannot pay simply see the challenge, which is why the free orientation tool in step 6 matters.

## 4. Wire the payment layer

Create `src/payments.js`. One resource server per process verifies and settles; each paid tool gets a wrapper around its handler.

```js
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { createPaymentWrapper, createToolResourceUrl } from '@x402/mcp';
import { registerExactSvmScheme } from '@x402/svm/exact/server';

const NETWORK_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEFAULT_FACILITATOR = 'https://facilitator.payai.network';

let resourceServerPromise = null;

export function getResourceServer() {
	if (resourceServerPromise) return resourceServerPromise;
	resourceServerPromise = (async () => {
		const facilitator = new HTTPFacilitatorClient({
			url: process.env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR,
		});
		const server = new x402ResourceServer([facilitator]);
		registerExactSvmScheme(server, {});
		await server.initialize();
		return server;
	})();
	return resourceServerPromise;
}
```

Then the wrapper each paid tool uses:

```js
export function paid(config, handler) {
	const { toolName, description, priceUsd, inputSchema, example } = config;
	let wrapperPromise = null;

	async function getWrapper() {
		if (wrapperPromise) return wrapperPromise;
		wrapperPromise = (async () => {
			const resourceServer = await getResourceServer();
			const resourceUrl = createToolResourceUrl(toolName);
			const accepts = await resourceServer.buildPaymentRequirementsFromOptions(
				[
					{
						scheme: 'exact',
						network: NETWORK_SOLANA_MAINNET,
						payTo: process.env.X402_PAY_TO_SOLANA,
						price: priceUsd,
						maxTimeoutSeconds: 60,
						extra: { name: 'USDC', decimals: 6 },
					},
				],
				{ resourceUrl },
			);
			const discovery = declareDiscoveryExtension({ toolName, description, transport: 'stdio', inputSchema, example });
			const wrap = createPaymentWrapper(resourceServer, {
				accepts,
				resource: { url: resourceUrl, description, mimeType: 'application/json' },
				extensions: discovery,
			});
			return wrap(async (args) => {
				const result = await handler(args);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			});
		})();
		return wrapperPromise;
	}

	return async (args, context) => (await getWrapper())(args, context);
}
```

Two decisions in there are worth stealing:

- **The wiring is lazy.** Registration touches no secrets, so `tools/list` works with no environment set and your tests do not need a wallet.
- **Discovery metadata rides along.** `declareDiscoveryExtension` is what puts your tool in front of agents shopping for paid capabilities. A tool whose description says "paid endpoint" is a tool nobody picks.

## 5. Write the work

The paid tool has to be genuinely worth its price. The full implementation lives in [`src/gltf.js`](https://github.com/nirholas/three.ws/blob/main/examples/paid-mcp-server/src/gltf.js); the important parts are the guard and the report.

**Guard the fetch before any byte moves.** A paid endpoint that fetches user-supplied URLs is an internal-network probe unless it refuses private space:

```js
export async function assertPublicHttpsUrl(rawUrl) {
	const url = new URL(rawUrl);
	if (url.protocol !== 'https:') throw new ModelError('insecure_url', 'Only https:// model URLs are accepted.');
	const records = await lookup(url.hostname, { all: true, verbatim: true });
	for (const record of records) {
		if (isPrivateAddress(record.address, record.family)) {
			throw new ModelError('blocked_host', `${url.hostname} resolves to a private address.`);
		}
	}
	return url;
}
```

Loopback, RFC 1918, link-local (including the cloud metadata address `169.254.169.254`), and carrier-grade NAT are all rejected. Redirects are refused outright, the response is capped at 32 MB checked twice, and the fetch has a 20 second timeout.

**Report counts, do not estimate them.** Vertices and triangles come from accessor counts, so an indexed mesh reports its real triangle total:

```js
for (const primitive of mesh.primitives || []) {
	const position = primitive.attributes?.POSITION;
	if (position !== undefined) vertices += accessors[position].count || 0;
	if (primitive.indices !== undefined) triangles += Math.floor(accessors[primitive.indices].count / 3);
}
```

**Turn counts into findings.** Numbers alone are a data dump. Each finding names the problem, the evidence, and the fix, which is the part a caller is actually buying:

```json
{
	"severity": "low",
	"issue": "No geometry compression",
	"detail": "The model declares neither KHR_draco_mesh_compression nor EXT_meshopt_compression.",
	"fix": "Run gltf-transform with meshopt compression. Typical saving is 40 to 70 percent of the geometry payload."
}
```

## 6. Register one free tool and one paid tool

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer(
	{ name: 'paid-mcp-server', version: '0.1.0' },
	{ capabilities: { tools: { listChanged: false } }, instructions: SERVER_INSTRUCTIONS },
);

server.registerTool('getting_started', {
	title: 'Getting started (free)',
	description: 'FREE. Prices, the payment flow, and how to call the paid tool.',
	inputSchema: {},
	annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, gettingStartedHandler);

server.registerTool('inspect_model', {
	title: 'Inspect a 3D model ($0.002)',
	description: PAID_TOOL_DESCRIPTION,
	inputSchema: { url: z.string().url().describe('Public https:// URL of a .glb or .gltf file.') },
	annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, paid({ toolName: 'inspect_model', priceUsd: '$0.002', description: PAID_TOOL_DESCRIPTION, inputSchema }, doTheWork));

await server.connect(new StdioServerTransport());
```

**Ship the free tool.** It costs nothing to run and it is consistently the first tool a new caller invokes. It answers three questions a client cannot otherwise resolve without spending money: what does this server do, what does each tool cost, and how do I pay.

**Put the price in the description.** The tool description is what a model reads when deciding whether to call. `$0.002` in plain text there prevents a surprised caller.

**Annotate honestly.** `readOnlyHint` and `destructiveHint` are what annotation-aware clients use to decide whether to prompt before running a tool.

## 7. Get the ordering right

This is the part that separates a working paid server from an embarrassing one:

1. **Verify** the payment. Nothing has moved yet.
2. **Run the work.** Only now.
3. **Settle**, and return the receipt with the result.

The wrapper enforces the ordering, but you have to hold up your end inside the handler. In this example **every failure path throws**:

```js
async ({ url }) => {
	// Every failure throws, which skips settlement. A bad URL, an unreachable host,
	// or a corrupt file costs the caller nothing and can be retried with the same
	// signed payment.
	const buffer = await fetchModel(url);
	return inspectModel(buffer, { sourceUrl: url });
}
```

Swallowing an error into a `{ ok: false }` response would settle the payment and charge for nothing. Charge only when you produced the thing you sold.

## 8. Run it

```bash
X402_PAY_TO_SOLANA=<your-solana-address> node src/index.js
```

Then point a client at it:

```bash
claude mcp add model-inspect \
  --env X402_PAY_TO_SOLANA=<your-solana-address> \
  -- node /absolute/path/to/src/index.js
```

Ask the assistant to call `getting_started` and it answers for free. Ask it to inspect a model and, if it has no wallet, it gets the challenge instead of the report. This is the real envelope the example returns:

```json
{
	"x402Version": 2,
	"error": "Payment required to access this tool",
	"resource": { "url": "mcp://tool/inspect_model", "mimeType": "application/json" },
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

`amount` is in atomic units of 6-decimal USDC, so `"2000"` is $0.002.

## 9. Test the guarantee, not just the happy path

The property that matters is that the product never escapes without payment. Assert exactly that, with a real MCP client over an in-memory transport:

```js
const result = await client.callTool({
	name: 'inspect_model',
	arguments: { url: 'https://three.ws/avatars/cesium-man.glb' },
});
const serialized = JSON.stringify(result);
assert.ok(!serialized.includes('"triangles"'), 'an unpaid call must not leak the paid report');
assert.match(serialized, /payment|402|accepts/i, 'an unpaid call should quote what it wants');
```

The example ships 15 tests covering the parser, the geometry math, the findings engine, the SSRF guard, the tool list, the free tool payload, and the guarantee above:

```bash
npm test
```

## 10. Buy from it

The last mile is proving an assistant can find, price, and pay for your tool with no human in the loop. Give a client a self-custodial wallet:

```bash
claude mcp add x402 --env SOLANA_SECRET_KEY=<base58> -- npx -y @three-ws/x402-mcp
```

That connector can search the bazaar, read your challenge without paying (`inspect_endpoint`), and settle (`pay_and_call`) under a `MAX_PAY_USD` ceiling with a confirmation step. Watch it read your price before it commits: that is exactly how a real buyer will behave.

## Where to go next

- [Meter any API with the x402-server SDK](/tutorials/x402-server-sdk): the same idea for plain HTTP handlers.
- [Build a paid x402 endpoint your agent calls](/tutorials/paid-x402-endpoint): the long-form HTTP walkthrough with production deployment.
- [Pay for an x402 service](/tutorials/pay-for-x402-service): the buyer side, end to end.
- [Build an MCP server for your agent](/tutorials/mcp-server-for-your-agent): the unpaid MCP basics, if you are new to the protocol.
- [The x402 bazaar MCP server](/docs/mcp-x402-bazaar): how discovery works and what it indexes.
- [How to monetize an MCP server](/blog/monetize-mcp-server-x402-paid-tools): the design argument and the pricing calibration table.
