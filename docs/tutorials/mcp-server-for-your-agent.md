# Expose Your Agent as an MCP Server

By the end of this tutorial your three.ws agent is reachable as an MCP (Model Context Protocol) tool from any MCP-aware client — Claude Desktop, Cursor, Zed, Goose, your own JSON-RPC client, anything that speaks the spec. Your agent's chat surface becomes a `tools/call` method. A 3D character on a webpage and a programmatic tool other models can use are now the same thing.

This is shorter than the other Advanced tutorials because the protocol is small and the implementation reuses your existing chat endpoint. Most of the work is in getting the spec details right.

**What you'll build:**

- A `POST /mcp` JSON-RPC 2.0 endpoint that speaks MCP's Streamable HTTP transport
- A `tools/list` response advertising your agent's chat as a callable tool
- A `tools/call` handler that runs the agent and returns the response
- A discoverable manifest at `/.well-known/mcp.json`
- An OAuth-protected-resource flow for clients that auth before they call (the platform's `api/mcp/.well-known/oauth-protected-resource` route is a real example)
- Connections working in Claude Desktop and Cursor

**Prerequisites:**

- A deployed agent with a working chat endpoint. If you're using the platform, your agent already has one: `POST https://three.ws/api/chat` with a JSON body of `{ agentId, message, history }`, answered as an SSE stream (Step 4 shows the exact shapes). If you've forked the platform ([self-host-agent-backend](/tutorials/self-host-agent-backend)), use your own equivalent.
- Node.js 24.x and a deployed function host (Vercel/Cloudflare/your own server)
- Familiarity with JSON-RPC 2.0 (`jsonrpc: "2.0"`, `method`, `params`, `id`)
- A test MCP client. Claude Desktop is the most forgiving; Cursor is stricter; `npx @modelcontextprotocol/inspector` is the dev-loop tool
- 30 minutes of reading time for the spec at `https://modelcontextprotocol.io/specification` if you want to deviate from the patterns here

---

## Step 1 — What MCP is, in three minutes

MCP is an open spec from Anthropic for connecting LLM-driven clients to external tools, resources, and prompts. It is, deliberately, very small:

- **Transport:** JSON-RPC 2.0 messages over stdio (for local processes), Streamable HTTP (for remote servers), or older SSE for legacy clients
- **Server capabilities:** `tools` (callable functions), `resources` (readable URIs), `prompts` (named templates), and `logging`
- **Discovery:** A client calls `initialize`, the server replies with its capabilities, then the client calls `tools/list`, `resources/list`, etc.

For our purposes, the only capability that matters is **tools**. We're going to advertise one tool — `chat_with_agent` — that lets any MCP client send a message to your agent and get a response back.

Streamable HTTP transport in one diagram:

```
Client                                   Server
  | POST /mcp                              |
  | { "method": "initialize", ... }        |
  |--------------------------------------->|
  |    200 OK { capabilities }             |
  |<---------------------------------------|
  | POST /mcp { "method": "tools/list" }   |
  |--------------------------------------->|
  |    200 OK { tools: [...] }             |
  |<---------------------------------------|
  | POST /mcp { "method": "tools/call",    |
  |             "params": {                |
  |               "name": "chat_with_agent",|
  |               "arguments": {...}       |
  |             }}                         |
  |--------------------------------------->|
  |    200 OK { content: [...] }           |
  |<---------------------------------------|
```

Optional: clients can open a persistent **GET** to the same `/mcp` URL to receive server-initiated notifications via SSE. We'll cover that briefly but it's not required for a basic agent-as-tool integration.

Spec version we'll target: **2025-06-18**. This is the version implemented by the platform's `api/mcp.js` and the version that recent clients (Claude Desktop 2.x, Cursor 0.40+) prefer.

---

## Step 2 — Scaffold the endpoint

Working example assumes Vercel function host but the code is plain Node — adapt to whatever runs your serverless functions.

Create `api/mcp.js`:

```js
// api/mcp.js — Streamable HTTP transport, MCP 2025-06-18, JSON-RPC 2.0
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'my-agent-mcp', version: '1.0.0' };

function setCors(res, methods = 'GET,HEAD,POST,DELETE,OPTIONS') {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', methods);
  res.setHeader(
    'access-control-allow-headers',
    'authorization,content-type,mcp-protocol-version,x-payment',
  );
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET' || req.method === 'HEAD') return handleSse(req, res);
  if (req.method === 'DELETE') return handleTerminate(req, res);
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST,GET,HEAD,DELETE,OPTIONS');
    return res.status(405).json({ error: 'method not supported' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return res.status(400).json(jsonRpcError(null, -32700, `parse error: ${err.message}`));
  }

  const batch = Array.isArray(body) ? body : [body];
  if (batch.length > 32) {
    return res.status(400).json(jsonRpcError(null, -32600, 'batch too large (max 32)'));
  }

  const responses = [];
  for (const msg of batch) {
    const r = await dispatch(msg);
    if (r !== null) responses.push(r);
  }

  res.status(200);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('mcp-protocol-version', PROTOCOL_VERSION);
  res.end(JSON.stringify(Array.isArray(body) ? responses : (responses[0] ?? null)));
}

function handleSse(req, res) {
  // Minimal SSE endpoint: open the stream, emit an initial event, then idle.
  // Per spec, the server can push notifications here; we don't generate any
  // server-initiated messages in this tutorial, but the endpoint must exist
  // for clients that try to open it.
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.write(`event: open\ndata: {}\n\n`);
  // Keepalive every 25s to defeat intermediaries that close idle streams.
  const ka = setInterval(() => res.write(`: keepalive\n\n`), 25_000);
  req.on('close', () => { clearInterval(ka); res.end(); });
}

function handleTerminate(req, res) {
  // Clients call DELETE /mcp to terminate a session. We don't maintain
  // session state in this minimal example — acknowledge and return.
  res.status(204).end();
}
```

This handles transport. Now the dispatch:

```js
async function dispatch(msg) {
  const id = msg?.id;
  const isNotification = id === undefined;
  try {
    if (!msg || msg.jsonrpc !== '2.0') throw rpcError(-32600, 'invalid Request');
    const method = msg.method;
    if (method === 'initialize') return jsonRpcResult(id, await onInitialize(msg.params));
    if (method === 'ping') return jsonRpcResult(id, {});
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') return jsonRpcResult(id, { tools: TOOL_CATALOG });
    if (method === 'tools/call') return jsonRpcResult(id, await onToolCall(msg.params));
    if (method === 'resources/list') return jsonRpcResult(id, { resources: [] });
    if (method === 'resources/templates/list') return jsonRpcResult(id, { resourceTemplates: [] });
    if (method === 'prompts/list') return jsonRpcResult(id, { prompts: [] });
    if (method === 'logging/setLevel') return jsonRpcResult(id, {});
    throw rpcError(-32601, `method not found: ${method}`);
  } catch (err) {
    if (isNotification) return null;
    return jsonRpcError(id, err.code || -32603, err.message || 'internal error', err.data);
  }
}

function rpcError(code, message, data) {
  const e = new Error(message);
  e.code = code;
  e.data = data;
  return e;
}

async function onInitialize(_params) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      logging: {},
    },
    instructions:
      'Talk to a three.ws agent. The chat_with_agent tool sends a message ' +
      'to a specific agent and returns the agent\'s response.',
  };
}
```

---

## Step 3 — Define the tool catalog

The agent's chat surface becomes one MCP tool. Add to `api/mcp.js`:

```js
const TOOL_CATALOG = [
  {
    name: 'chat_with_agent',
    description:
      "Send a message to a specific three.ws agent and return the agent's " +
      'response. The agent has its own personality, optional voice output (returned ' +
      'as text), and access to whatever skills its operator has installed.',
    inputSchema: {
      type: 'object',
      required: ['agent_id', 'message'],
      properties: {
        agent_id: {
          type: 'string',
          description: 'The agent ID. Format: a string identifier shown on the agent page.',
        },
        message: {
          type: 'string',
          description: 'The message to send to the agent.',
          minLength: 1,
          maxLength: 8000,
        },
        session_id: {
          type: 'string',
          description:
            'Optional. A stable per-conversation ID. Pass the same value across ' +
            'turns to keep conversation history. Omit for a stateless one-shot.',
        },
      },
    },
  },
];
```

The `description` is what the *calling* LLM reads to decide when to invoke the tool. Write it the way you'd write a Claude tool-use schema — clear about capability, clear about intent signals.

`inputSchema` is JSON Schema. Stick to draft 2020-12 features; older Cursor builds choke on JSON Schema 7 keywords.

---

## Step 4 — Implement `tools/call`

The dispatch already routes `tools/call` to `onToolCall`. Implement it:

The platform's `/api/chat` (`api/chat.js`) contract, which this handler targets:

- **Request:** `POST` with a JSON body of `{ agentId, message, history }`. `agentId` is the agent's UUID, `message` is the single new user turn (a string, max 4000 chars), and `history` is an array of up to 20 prior `{ role: 'user' | 'assistant', content }` turns. There is no `messages` array, no `session_id`, and no `stream: false` switch.
- **Response:** always an SSE stream (`Content-Type: text/event-stream`). Each event is a `data: {...}` JSON line: `{ type: 'chunk', text }` for incremental reply text, then a final `{ type: 'done', reply, actions, ... }` carrying the complete reply, or `{ type: 'error', message }` if the stream fails mid-way.

`/api/chat` is stateless per request — conversation context travels in `history`. To honor the tool's optional `session_id`, keep a per-session history on the MCP server. In-memory works for a tutorial (it survives only as long as the function instance stays warm); use Redis or a database row for real multi-instance continuity.

```js
const SESSIONS = new Map(); // session_id → [{ role, content }, ...]

async function onToolCall(params) {
  const { name, arguments: args = {} } = params || {};
  if (name !== 'chat_with_agent') throw rpcError(-32602, `unknown tool: ${name}`);

  const agentId = String(args.agent_id || '').trim();
  if (!agentId) throw rpcError(-32602, 'agent_id is required');
  const message = String(args.message || '').trim();
  if (!message) throw rpcError(-32602, 'message is required');
  const sessionId = args.session_id ? String(args.session_id) : null;
  const history = sessionId ? SESSIONS.get(sessionId) || [] : [];

  // Call your agent's chat endpoint. For the platform, this is POST /api/chat.
  // For your own fork or stack, swap the URL.
  const upstream = await fetch('https://three.ws/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId,
      message,
      history: history.slice(-20),
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    throw rpcError(-32603, `agent endpoint ${upstream.status}: ${text.slice(0, 200)}`);
  }

  // MCP's tools/call returns a single result, so buffer the whole SSE stream
  // and take the `reply` field from the final `done` event. The accumulated
  // `chunk` text is the fallback if the stream is cut off before `done`.
  const raw = await upstream.text();
  let reply = '';
  let chunks = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let evt;
    try {
      evt = JSON.parse(line.slice('data: '.length));
    } catch {
      continue;
    }
    if (evt.type === 'chunk') chunks += evt.text || '';
    else if (evt.type === 'done') reply = (evt.reply || '').trim();
    else if (evt.type === 'error') {
      throw rpcError(-32603, `agent stream error: ${evt.message || 'stream interrupted'}`);
    }
  }
  if (!reply) reply = chunks.trim();
  if (!reply) throw rpcError(-32603, 'agent returned empty response');

  if (sessionId) {
    SESSIONS.set(
      sessionId,
      [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }].slice(-20),
    );
  }

  // MCP tool results are an array of content blocks. For a plain text reply:
  return {
    content: [{ type: 'text', text: reply }],
    isError: false,
  };
}
```

The `content` array is the canonical MCP tool response shape. Each block has a `type` ("text", "image", "resource"). For an agent chat, one text block is right.

Buffering the upstream SSE on the server, as above, is the right default: MCP's `tools/call` returns a single result; the client doesn't expect a stream from `tools/call` in the same way it expects a stream from a top-level LLM call. If you want streaming, that's the SSE channel on the GET endpoint — more complex and rarely worth the trouble for an agent tool.

---

## Step 5 — Deploy and probe

If this is on Vercel, `vercel --prod` ships it. Smoke-test with curl:

```bash
curl -X POST https://<your-domain>/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Expected response:

```json
{
  "jsonrpc":"2.0","id":1,
  "result":{
    "protocolVersion":"2025-06-18",
    "serverInfo":{"name":"my-agent-mcp","version":"1.0.0"},
    "capabilities":{...}
  }
}
```

Then `tools/list`:

```bash
curl -X POST https://<your-domain>/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Then `tools/call`:

```bash
curl -X POST https://<your-domain>/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"chat_with_agent","arguments":{"agent_id":"<your-agent-id>","message":"hello"}}}'
```

You should see the agent's reply nested under `result.content[0].text`.

If any of those fail, the dev-loop tool worth installing is the official MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

It opens a UI where you paste your endpoint URL and walk through every method interactively. Way faster than curl for figuring out which spec detail you got wrong.

---

## Step 6 — Discovery manifest

MCP clients can be pointed at a server URL directly, or they can discover the server via a well-known manifest. Add `api/well-known/mcp.json` (or whatever maps to `/.well-known/mcp.json` in your routing):

```js
// api/wk-mcp.js, routed at /.well-known/mcp.json via vercel.json
export default function handler(req, res) {
  res.setHeader('cache-control', 'public, max-age=300');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.status(200).end(
    JSON.stringify({
      protocolVersion: '2025-06-18',
      server: {
        name: 'my-agent-mcp',
        version: '1.0.0',
        url: `https://${req.headers.host}/api/mcp`,
        transport: 'streamable-http',
      },
      auth: {
        type: 'public', // or 'oauth-protected-resource' — see Step 8
      },
    }),
  );
}
```

In `vercel.json`, add a route:

```json
{
  "src": "/\\.well-known/mcp\\.json",
  "dest": "/api/wk-mcp"
}
```

Now `https://<your-domain>/.well-known/mcp.json` returns the discovery doc. Some clients prefer this entry point; others want the bare endpoint URL. Provide both.

---

## Step 7 — Connect from Claude Desktop

Claude Desktop reads servers from `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS (and the equivalent path on Windows). For an HTTP server:

```json
{
  "mcpServers": {
    "my-three-ws-agent": {
      "url": "https://<your-domain>/api/mcp"
    }
  }
}
```

Restart Claude Desktop. Open a new conversation. Type "what tools do you have?" — Claude should list `chat_with_agent`. Ask it to "use chat_with_agent to ask agent ID `<your-agent-id>` what it does." You should see Claude make a tool call, get your agent's reply, and incorporate it into its response.

If Claude Desktop doesn't see the tool:

- Open the app's developer panel (CMD+Shift+I on macOS) and look at the MCP connection logs
- Confirm the server URL is reachable from the network the app is on (corporate VPNs sometimes block outbound to weird hostnames)
- Verify your `initialize` response includes `capabilities.tools` — if you serialized that wrong, Claude assumes no tools

---

## Step 8 — Connect from Cursor

Cursor's MCP config lives in its workspace settings. Open `Settings → MCP → Add new MCP Server` and paste:

```
Name: my-three-ws-agent
URL:  https://<your-domain>/api/mcp
```

Cursor uses the same Streamable HTTP transport. The tool appears in Cursor's `@` menu — invoking it sends a message to your agent and inlines the reply.

Cursor is stricter than Claude Desktop about schema validation. If `tools/list` returns a tool with a non-conforming `inputSchema`, Cursor refuses to register it and silently logs an error. The fix: stick to standard JSON Schema 2020-12 features only.

---

## Step 9 — OAuth-protected resource (when you need auth)

Public MCP servers are fine for a public agent. For private agents, paid agents, or agents that read sensitive data, you'll want auth. The MCP spec defines an OAuth 2.1 protected-resource flow: the server publishes a well-known doc at `/.well-known/oauth-protected-resource` pointing at the OAuth authorization server; clients fetch tokens; the server's `/mcp` endpoint requires the token.

The platform's production endpoint at `https://three.ws/api/mcp/.well-known/oauth-protected-resource` is a real example. Read it:

```bash
curl https://three.ws/api/mcp/.well-known/oauth-protected-resource
```

The shape:

```json
{
  "resource": "https://three.ws/api/mcp",
  "authorization_servers": ["https://three.ws"],
  "scopes_supported": ["mcp", "mcp:tools", "mcp:resources"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://three.ws/docs/mcp"
}
```

To wire this on your own server, add `api/wk-oauth-protected-resource.js`:

```js
export default function handler(req, res) {
  res.setHeader('cache-control', 'public, max-age=300');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const host = `https://${req.headers.host}`;
  res.status(200).end(
    JSON.stringify({
      resource: `${host}/api/mcp`,
      authorization_servers: [host],
      scopes_supported: ['mcp', 'mcp:tools', 'mcp:resources'],
      bearer_methods_supported: ['header'],
    }),
  );
}
```

And the corresponding `vercel.json` routes:

```json
{ "src": "/\\.well-known/oauth-protected-resource", "dest": "/api/wk-oauth-protected-resource" },
{ "src": "/api/mcp/\\.well-known/oauth-protected-resource", "dest": "/api/wk-oauth-protected-resource" }
```

Now make `api/mcp.js` require a Bearer token:

```js
function authenticate(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return { ok: false, reason: 'no bearer token' };
  }
  const token = auth.slice('Bearer '.length).trim();
  // Validate the token against your auth provider.
  // For a quick start, accept tokens issued by your own /api/auth/token endpoint.
  const claims = verifyToken(token); // your impl: JWT verify, opaque-token lookup, etc.
  if (!claims) return { ok: false, reason: 'invalid token' };
  return { ok: true, claims };
}

function send401(res, host) {
  // Per the OAuth 2.1 + RFC 9728 dance, the 401 response must include a
  // WWW-Authenticate header pointing the client at the protected-resource doc.
  res.setHeader(
    'www-authenticate',
    `Bearer resource_metadata="${host}/.well-known/oauth-protected-resource"`,
  );
  res.status(401).end();
}
```

In the POST handler, before dispatching:

```js
const auth = authenticate(req);
if (!auth.ok) return send401(res, `https://${req.headers.host}`);
```

The token-issuance side (your OAuth authorization server) is out of scope here. Building a full OAuth 2.1 AS from scratch is a real project; for most use cases you either reuse an existing identity provider (Auth0, Clerk, Privy) and adapt its token format to MCP, or implement the device-authorization grant alone (which is what most MCP clients prefer because they're CLI/desktop apps without redirect URIs).

The three.ws platform issues short-lived JWTs via its own `/api/auth/*` routes and verifies them in `api/_mcp/auth.js` — read those for a reference implementation.

---

## Step 10 — Streaming notifications (optional)

MCP supports server-pushed notifications via the GET endpoint. Useful for: progress updates on long tool calls, log streaming, resource-change events.

The skeleton `handleSse` we wrote in Step 2 opens the stream but emits nothing useful. To push a notification:

```js
function pushNotification(sseRes, method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  sseRes.write(`event: message\ndata: ${msg}\n\n`);
}
```

A typical use: `chat_with_agent` takes 4 seconds because the agent invokes a tool internally. Without notifications, the client sees a 4-second hang. With notifications, you push intermediate `notifications/progress` messages so the client can render "agent is thinking…"

The catch: maintaining the SSE connection across serverless function invocations is hard. Vercel functions have a max duration; Cloudflare Workers don't easily multiplex an outbound stream against incoming POST handler invocations. The clean pattern is to deploy `/mcp` to a long-running server (a small VPS, a Cloudflare Durable Object, or Fly with persistent processes), separate from the rest of your serverless surface.

For most agent-as-tool integrations, skip streaming. Buffer on the server and return a single 200 with the final content. Add streaming when the latency cost actually hurts.

---

## Step 11 — Schema validation, error codes, and the other rough edges

Things the spec is precise about that clients enforce:

- **`mcp-protocol-version` header.** Both directions. Include it in your response headers. Some clients use it to negotiate down to an older version if they don't support yours.
- **JSON-RPC errors.** Use the standard codes: `-32700` parse error, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal error. Anything in the `-32000` to `-32099` range is yours to define; use those for protocol-specific errors (rate-limited, unauthorized, payment required).
- **Notifications.** A JSON-RPC message with no `id` is a notification — the server does not respond. Don't accidentally return a result for `notifications/initialized`; return `null` from `dispatch` and skip it in the responses array.
- **Batches.** A request body that's a JSON array means the client wants a batch. Process each item, respond with an array of results (omitting notifications). Don't blow up on a batch with one element; some clients send `[msg]` instead of `msg`.
- **`tools/call` error reporting.** When a tool's underlying call fails, you have a choice: return `result: { isError: true, content: [...] }` (the tool ran and returned a structured error) or return a JSON-RPC `error: { code, message }` (the tool couldn't even be invoked). Convention: use `isError: true` for tool-runtime errors (upstream timeout, validation), and JSON-RPC `error` for protocol-level errors (unknown tool, bad args).

Common rookie mistakes that take an hour to debug:

- **Returning a string from `tools/call` instead of `{ content: [...] }`.** The client gets a parse error somewhere downstream.
- **Forgetting `inputSchema` is `inputSchema`, not `input_schema`.** MCP uses camelCase. The Anthropic tool-use shape uses snake_case. They're different.
- **Setting `Content-Type: application/json` but emitting JSON arrays as plain text.** Stringify properly.
- **CORS that omits `mcp-protocol-version` from `Access-Control-Allow-Headers`.** Browsers will block the request.

---

## Step 12 — Rate-limiting and abuse

Every `tools/call` is a real LLM call against your agent's chat endpoint, which costs you tokens. Without rate-limiting, anyone with the URL can drain your provider budget.

Two layers:

**Per-IP, on the MCP transport.** Use Upstash Redis (the platform pattern from [self-host-agent-backend](/tutorials/self-host-agent-backend)) keyed by `req.headers['cf-connecting-ip']` or `x-forwarded-for[0]`. Cap to something reasonable like 60 calls/min per IP.

**Per-token, after auth.** Once a client has authenticated (Step 9), key the rate limit on the token's claims (e.g., the user ID). This is the rate limit that follows the actual user.

The platform's production server in `api/mcp.js` runs both — see the `limits.mcpIp` and `limits.mcpUser` calls. Lift that pattern verbatim.

For a paid MCP server, replace rate limits with x402 challenges. See [paid-x402-endpoint](/tutorials/paid-x402-endpoint) — the production `api/mcp.js` settles an x402 payment per call when the user hasn't pre-paid via a subscription. You can do the same: 402 the `tools/call` until the client supplies an `X-PAYMENT` header.

---

## Step 13 — Pitfalls to ship past

Things that look right but bite you:

**Long-running tool calls.** Vercel functions on the hobby tier have a 10-second timeout, on Pro it's 60 seconds. If your agent's chat takes 12 seconds, your `tools/call` times out and the client retries — and your agent runs twice. Either pay for longer durations or move `tools/call` to a different host.

**Cold starts.** First call after a quiet period takes 800ms-1.5s of cold-start overhead. The client sees this as the tool being slow. The fix is the usual one for serverless: a warmup ping (a cron that hits `/api/mcp` every 5 minutes), or move to an always-warm host.

**Concurrent calls to the same agent.** Some agent implementations don't tolerate two simultaneous chat requests to the same session. If your chat endpoint uses a per-session lock, MCP clients that fan out tool calls (Claude sometimes does this, calling multiple tools in parallel) will hit the lock and get serialization. Provide per-call session IDs (Step 3's `session_id` parameter) so the client can opt out of session continuity for parallel work.

**Schema drift.** Your `inputSchema` lives in code; the agent's actual interface lives in code. Drift between them silently causes 4xx errors in tool calls. Add a smoke test that runs `tools/call` end-to-end on every deploy.

**Spec changes.** MCP is at `2025-06-18` as of this writing. The spec evolves. The protocol-version header on every response lets older clients downgrade gracefully if you bump versions later — but the wire format itself has had breaking changes (transport mode, capability shape). Subscribe to the spec repo and have a rebuild plan.

---

## What you learned

- The MCP wire protocol: JSON-RPC 2.0 over Streamable HTTP, the methods `initialize`, `tools/list`, `tools/call`, and the standard error codes
- How to wrap an existing agent chat endpoint as an MCP tool
- The discovery manifest at `/.well-known/mcp.json` and the OAuth-protected-resource doc at `/.well-known/oauth-protected-resource`
- How to connect from Claude Desktop and Cursor, and the dev-loop tool (the official Inspector) for debugging
- The right way to do auth (OAuth 2.1 protected resource), rate-limiting (Upstash, per-IP + per-token), and per-call payment (x402 hand-off)
- The pitfalls — schema drift, cold starts, long-running calls, concurrent sessions

## Next steps

- Build a database-backed skill so the agent has something rich to return when MCP clients call it — [skill-with-database-auth](/tutorials/skill-with-database-auth)
- Front the MCP endpoint with x402 so each call is paid per-call — [paid-x402-endpoint](/tutorials/paid-x402-endpoint)
- Coordinate two agents and expose the team as a single MCP server — [multi-agent-coordination](/tutorials/multi-agent-coordination)
- Build a custom skill that the agent itself calls (the inside view of what an MCP client triggers from the outside) — [custom-skill](/tutorials/custom-skill)
