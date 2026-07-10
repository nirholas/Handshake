# @three-ws/tool-sdk

Typed tool authoring for three.ws MCP servers. Every one of the MCP servers
in this repo (`mcp-server/`, `packages/*-mcp/`) currently declares tools by
hand: a name, a description, a hand-maintained JSON-Schema (or Zod-shape)
parameter list, and a handler — with validation and error wrapping
re-implemented per server. `@three-ws/tool-sdk` gives that authoring layer a
single, typed home:

- **`defineTool`** — declare a tool's identity, API surface (Zod schemas), and
  **permission manifest** once. JSON Schema for each API is derived from the
  Zod schema automatically.
- **`defineExecutor`** — wire a typed implementation map onto a tool. Every
  call is routed through one `invoke(apiName, params, ctx)` entry point that
  validates params, enforces the declared rate limit, and normalizes both
  success and failure into one result shape.
- **`toMcpTools`** — adapt a defined tool + executor into the exact
  registration shape this repo's MCP servers already use
  (`{ name, title, description, inputSchema, annotations, handler }`, one per
  declared API), so adoption is a single call.

Ported from the owner's SperaxOS `@sperax/plugin-sdk` (`defineTool.ts` +
`defineExecutor.ts`), rewritten from TypeScript to plain ESM + JSDoc to match
this repo's other JS packages, and re-scoped from a chat-UI plugin manifest
(`BuiltinToolManifest`, LLM system-role text, marketplace category) to a
portable MCP tool manifest with an explicit **permission model** (network
allowlist, rate limit, wallet access) — the piece SperaxOS's chat-app runtime
didn't need but a standalone MCP server does.

> **`defineRenderer.ts` was intentionally not ported.** The reference SDK's
> third piece renders a custom React component for a tool's result inside
> SperaxOS's chat UI. three.ws's MCP servers are headless (stdio/HTTP JSON-RPC,
> no in-repo chat renderer to plug into), so there is nothing here for a
> renderer to attach to. If a three.ws surface ever needs to render a tool
> result as a custom UI component, `defineRenderer` should be ported into
> *that* surface's own package, not into this transport-agnostic SDK.

## Install / import

Internal workspace package (`"private": true`, not published to npm) — import
it by name from anywhere in the monorepo:

```js
import { defineTool, defineExecutor, toMcpTools, guardedFetch, z } from '@three-ws/tool-sdk';
```

A package that consumes it locally needs a `file:` dependency pointing at this
package (npm workspaces resolves it automatically once both packages are
listed in the root `package.json` `workspaces` array; see
[Consuming from a package that also ships to npm](#consuming-from-a-package-that-also-ships-to-npm)
for the one caveat that matters before you publish).

## Quick start — full runnable example

```js
import { defineTool, defineExecutor, toMcpTools, z } from '@three-ws/tool-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// 1. Declare identity, API surface, and permissions once.
const priceTool = defineTool({
  id: 'my-org-price-feed',
  title: 'My Price Feed',
  description: 'Fetches live token prices from My API.',
  version: '1.0.0',
  permissions: {
    network: ['api.example.com'],                 // guardedFetch may only reach this host
    rateLimit: { calls: 30, perSeconds: 60 },      // enforced automatically by the executor
    wallet: false,
  },
  apis: [
    {
      name: 'getPrice',
      description: 'Get the current USD price for a token symbol.',
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
      parameters: z.object({
        symbol: z.string().min(1).describe('Token ticker, e.g. "ETH"'),
      }),
    },
  ],
});

// 2. Wire an implementation. Return plain data — the executor wraps it into
//    { success: true, content, state } and catches thrown errors for you.
const priceExecutor = defineExecutor(priceTool, {
  async getPrice({ symbol }, ctx) {
    const fetchGuarded = guardedFetch(priceTool.manifest.permissions);
    const res = await fetchGuarded(`https://api.example.com/v1/price/${symbol}`);
    const data = await res.json();
    return { symbol, price: data.price };
  },
});

// 3. Adapt into MCP tool registrations — one call, one tool per declared API.
const server = new McpServer({ name: 'price-feed-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
for (const def of toMcpTools(priceTool, priceExecutor)) {
  server.registerTool(
    def.name,
    { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
    def.handler, // throws on failure, returns content on success — matches every hand-written tool in this repo
  );
}

await server.connect(new StdioServerTransport());
```

Run it, then call `getPrice` from any MCP client (or `npx -y
@modelcontextprotocol/inspector node your-server.js`):

```jsonc
> { "symbol": "ETH" }
{ "symbol": "ETH", "price": 3421.09 }
```

## API

### `defineTool(config)`

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique identifier, e.g. `"my-org-price-feed"`. |
| `title` | yes | Display name. Also the per-API default `title`. |
| `description` | yes | Short description of the tool as a whole. Also the per-API default `description`. |
| `version` | yes | Semantic version, e.g. `"1.0.0"`. |
| `permissions` | no | `{ network?: string[], rateLimit?: { calls, perSeconds }, wallet?: boolean }` — see [Permission model](#permission-model). |
| `apis` | yes | Non-empty array of `{ name, description, parameters, title?, annotations? }`. `parameters` must be a `z.object({...})` schema. |

Returns `{ manifest, _apis, _config }`. `manifest` is the JSON-Schema-bearing,
serializable form (`{ id, title, description, version, permissions, apis: [{ name, title, description, parameters }] }`)
— safe to log, diff, or ship to a registry. `_apis` keeps the original Zod
schema per API for `defineExecutor` and `toMcpTools` to consume.

Throws a `TypeError` synchronously on a missing required field, a duplicate
API name, or an API whose `parameters` isn't a Zod schema — tool definitions
fail fast at module-load time, not at first invocation.

### `defineExecutor(tool, implementation)`

`implementation` is a `{ [apiName]: (params, ctx?) => Promise<*> | * }` map.
Each handler may return:

- **Plain data** — wrapped automatically into `{ success: true, content: data, state: data }`.
- **A full result envelope** (`{ success, content, state }` or `{ success, error }`) — passed through unchanged, for handlers that need `content` (rendered text) and `state` (structured data) to differ.

Returns `{ id, getApiNames(), hasApi(name), invoke(apiName, params, ctx?) }`.
`invoke` never throws — every outcome is a `ToolResult`:

```ts
type ToolResult =
  | { success: true, content: any, state: any }
  | { success: false, error: { message: string, code?: string, issues?: unknown, body?: unknown }, content?: string };
```

Before calling your handler, `invoke` runs, in order:

1. **API existence** — unknown `apiName` → `{ success: false, error: { code: 'API_NOT_FOUND' } }`.
2. **Implementation presence** → `{ success: false, error: { code: 'METHOD_NOT_IMPLEMENTED' } }`.
3. **Rate limit** (if `permissions.rateLimit` is declared) → `{ success: false, error: { code: 'RATE_LIMITED' } }`.
4. **Zod validation** of `params` against the API's schema → `{ success: false, error: { code: 'INVALID_PARAMS', issues } }`.
5. **Your handler**, wrapped in try/catch. A thrown error becomes `{ success: false, error: { message, code: error.code }, content: '<id>.<api> failed: <message>' }`.

### `toMcpTools(tool, executor)`

Returns one entry per declared API:

```ts
{
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, ZodTypeAny>,  // raw Zod shape — what McpServer.registerTool expects, NOT JSON Schema
  annotations: object,                      // per-API annotations, or a safe { readOnlyHint: false, idempotentHint: false, openWorldHint: true } default
  handler: (args, extra?) => Promise<any>,  // returns result.content on success, THROWS on failure
}
```

This is the exact shape `packages/naming-mcp/src/tools/*.js` hand-writes and
`packages/naming-mcp/src/index.js` feeds straight into `server.registerTool(name,
{ title, description, inputSchema, annotations }, handler)`. The handler
throws instead of returning a `{ success: false }` envelope because every
existing MCP server in this repo wraps tool handlers in its own
`try { ... } catch (err) { return { content: [...], isError: true } }` — see
`packages/naming-mcp/src/index.js`'s `buildServer()`.

## Permission model

`permissions` is declared once, on the tool, and applies to every API on it:

| Field | Enforcement |
|---|---|
| `network: string[]` | **Enforced.** `guardedFetch(permissions)` returns a `fetch`-compatible function that throws `{ code: 'NETWORK_NOT_ALLOWED' }` for any hostname not in the list. **Deny-by-default**: an empty/omitted `network` list means `guardedFetch` refuses every host. Exact hostname match only — no wildcards. |
| `rateLimit: { calls, perSeconds }` | **Enforced.** `defineExecutor` runs an in-memory token-bucket limiter per API name automatically; no extra wiring needed. Also exported standalone as `createRateLimiter(rateLimit)` for use outside an executor. |
| `wallet: boolean` | **Declarative only.** The SDK cannot grant or scope wallet access — that stays with whatever host constructs the executor's `ctx` (e.g. a signer-bearing runtime deciding whether to populate `ctx.wallet` based on this flag). |

`guardedFetch` is opt-in inside your implementation — it does not silently
replace the global `fetch`. Use it for calls you want the permission manifest
to actually govern; use a bespoke client (like `packages/naming-mcp`'s
`apiRequest`, which layers its own abort-timeout handling) where you need
behavior `guardedFetch` doesn't provide.

## Consuming from a package that also ships to npm

`@three-ws/tool-sdk` is `"private": true` and is never published. Most
`packages/*-mcp` servers (including `naming-mcp`) **are** published
standalone to npm (`npx @three-ws/naming-mcp`, etc.). A published package that
takes a hard `dependencies` entry on this SDK will fail to install for
external consumers, because npm cannot resolve an unpublished private
package from the registry.

For **in-monorepo development and testing** this is not a problem: a `file:`
dependency (`"@three-ws/tool-sdk": "file:../tool-sdk"`) resolves correctly for
every local `npm install`/`npm test` run, which is what
`packages/naming-mcp/src/tools/sns-resolve.js` uses as this package's
proof-of-port. Before that server's *next npm publish*, either (a) publish
`@three-ws/tool-sdk` itself, (b) bundle the two files it actually uses at
build time, or (c) inline the thin adapter call for that one file. This is a
known, disclosed follow-up — not a blocker for using the SDK inside the
monorepo today.

## Test

```bash
npx vitest run packages/tool-sdk
```

26 tests cover: Zod→JSON-Schema conversion, permission normalization,
param-validation failure shape, executor success/error wrapping (including
pass-through of a full result envelope), the in-memory rate-limit bucket
(fake timers), `guardedFetch` allow/deny (including deny-by-default), and the
`toMcpTools` adapter's output shape against a fixture of
`packages/naming-mcp`'s current hand-written registration format.
