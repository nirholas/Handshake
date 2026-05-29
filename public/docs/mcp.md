# MCP Integration

Model Context Protocol (MCP) lets Claude and other MCP-compatible AI systems interact with your three.ws account directly. When connected, Claude can list your avatars, render them as interactive 3D viewers, validate and inspect glTF files, and generate optimization suggestions — all through natural language.

This document covers the MCP server's tools, authentication, client configuration, and how to test locally.

---

## What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is an open standard that connects AI assistants to external tool servers via JSON-RPC 2.0. Once your MCP client points at the three.ws server, the LLM sees a curated set of tools it can call autonomously during a conversation.

For three.ws specifically, this means Claude can:

- Browse and search your avatar library without you copy-pasting URLs
- Render any avatar inline as an interactive `<model-viewer>` HTML artifact
- Run the Khronos glTF-Validator against any public GLB or glTF URL
- Inspect mesh/texture/animation counts and geometry stats
- Get actionable optimization suggestions (compression, LOD, texture transcoding)

---

## Server details

| Property          | Value                                        |
|-------------------|----------------------------------------------|
| **URL**           | `https://three.ws/api/mcp`         |
| **Transport**     | Streamable HTTP (`POST /api/mcp`)            |
| **Protocol**      | MCP `2025-06-18`, JSON-RPC 2.0               |
| **Auth**          | OAuth 2.1 (end-user) or API key (server-to-server) |

For local development:

```bash
npm run dev
# MCP endpoint: http://localhost:5173/api/mcp
# Auth is still enforced — use an API key or OAuth token.
```

The MCP server configuration is at `.mcp.json` in the project root, which Claude Code auto-discovers.

---

## Authentication

### OAuth 2.1 (recommended for Claude Desktop / Claude Code)

Claude handles the OAuth handshake automatically via dynamic client registration (RFC 7591). When you first connect, it will:

1. Register a client at `POST /oauth/register`.
2. Open `GET /oauth/authorize?...` in your browser for login and consent.
3. Exchange the authorization code at `POST /oauth/token` with PKCE (S256).
4. Cache the resulting JWT and refresh it automatically.

The access token carries scopes (`avatars:read`, `avatars:delete`, etc.) that gate which tools Claude can call. Metadata discovery endpoints follow RFC 8414 and RFC 9728:

```
GET /.well-known/oauth-authorization-server
GET /.well-known/oauth-protected-resource
```

On a `401`, the `WWW-Authenticate` header points clients at the protected-resource metadata URL so they can begin the flow.

### API key (server-to-server)

For scripts, CI, and server agents, generate a key at **Dashboard → API Keys** and pass it as a bearer token:

```bash
curl -X POST https://three.ws/api/mcp \
  -H "Authorization: Bearer 3da_live_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Keys are tied to a single user account and inherit that user's plan quotas.

---

## Connecting Claude Code

Claude Code auto-discovers `.mcp.json` at the project root. Add your key to that file:

```json
{
  "mcpServers": {
    "3d-agent": {
      "url": "https://three.ws/api/mcp",
      "headers": {
        "Authorization": "Bearer 3da_live_xxxxx"
      }
    }
  }
}
```

Or add it globally in `~/.claude/settings.json` under `mcpServers` with the same shape.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent path on your OS:

```json
{
  "mcpServers": {
    "3dagent": {
      "command": "npx",
      "args": ["-y", "@3d-agent/mcp-server", "--url", "https://three.ws/"]
    }
  }
}
```

This uses the standalone npm package, which handles OAuth locally. The `--url` flag lets you point at a local dev server.

### Any MCP-compatible client

Send `POST /api/mcp` with valid JSON-RPC 2.0 messages and a bearer token. The server is stateless — no session setup needed beyond the `initialize` handshake.

---

## Available tools

All tools return `{ content: [{ type, text }], structuredContent: {...} }`. On error, `isError: true` is set and `content[0].text` contains the message.

---

### `list_my_avatars`

Paginated list of the authenticated user's avatars.

**Scope required:** `avatars:read`

```json
{
  "type": "object",
  "properties": {
    "limit":      { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
    "cursor":     { "type": "string", "description": "Opaque pagination cursor from previous response." },
    "visibility": { "type": "string", "enum": ["private", "unlisted", "public"] }
  },
  "additionalProperties": false
}
```

Returns each avatar's `id`, `name`, `slug`, `size`, `visibility`, and `model_url` (when publicly accessible).

---

### `get_avatar`

Fetch a single avatar by `id` (UUID) or by your `slug`.

**Scope required:** `avatars:read`

```json
{
  "type": "object",
  "properties": {
    "id":   { "type": "string", "format": "uuid" },
    "slug": { "type": "string" }
  },
  "additionalProperties": false
}
```

For private avatars, returns a short-lived signed URL (1-hour expiry). Public and unlisted avatars return a permanent CDN URL.

---

### `search_public_avatars`

Full-text search over the public avatar gallery. No authentication required for the search itself.

```json
{
  "type": "object",
  "properties": {
    "q":     { "type": "string", "description": "Free-text search over name and description." },
    "tag":   { "type": "string", "description": "Filter to one tag." },
    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 12 }
  },
  "additionalProperties": false
}
```

---

### `render_avatar`

Returns a complete `<model-viewer>` HTML document for the specified avatar. Claude renders this as an inline HTML artifact — an interactive 3D viewer that supports orbit controls, auto-rotate, and AR on mobile.

**Scope required:** `avatars:read`

```json
{
  "type": "object",
  "properties": {
    "id":            { "type": "string", "format": "uuid" },
    "slug":          { "type": "string" },
    "auto_rotate":   { "type": "boolean", "default": true },
    "background":    { "type": "string", "description": "CSS background color or gradient.", "default": "transparent" },
    "height":        { "type": "string", "default": "480px" },
    "width":         { "type": "string", "default": "100%" },
    "camera_orbit":  { "type": "string", "description": "model-viewer camera-orbit value, e.g. \"0deg 80deg 2m\"." },
    "poster":        { "type": "string", "description": "HTTPS URL of a poster image shown while loading." },
    "ar":            { "type": "boolean", "default": true, "description": "Include AR button for mobile." }
  },
  "additionalProperties": false
}
```

The response contains two content entries: a short text summary (for the transcript) and a `resource` entry with `mimeType: "text/html"` that MCP clients render inline.

**Note:** Agents whose embed policy sets `surfaces.mcp = false` cannot be rendered via this tool. The server returns error code `-32000` with message `embed_denied_surface` in that case.

---

### `delete_avatar`

Soft-delete an avatar you own. Irreversible from the API (contact support to recover).

**Scope required:** `avatars:delete`

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "format": "uuid" }
  },
  "required": ["id"],
  "additionalProperties": false
}
```

---

### `validate_model`

Run the [Khronos glTF-Validator](https://github.com/KhronosGroup/glTF-Validator) against any public HTTPS GLB or glTF URL. Returns error, warning, info, and hint counts with detailed per-issue messages. SSRF-hardened: only public `https://` URLs are fetched.

**Rate limit:** 10 calls/minute per user.

```json
{
  "type": "object",
  "properties": {
    "url":        { "type": "string", "format": "uri", "description": "Public https URL of a .glb or .gltf file." },
    "max_issues": { "type": "integer", "minimum": 1, "maximum": 500, "default": 100 }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

Example response text:
```
glTF-Validator report for avatar.glb (1842.3 KB)
Errors: 0, Warnings: 2, Infos: 4, Hints: 1

  [WRN] ACCESSOR_ELEMENT_OUT_OF_RANGE: … @ /accessors/3
  [WRN] MESH_PRIMITIVE_UNUSED_TEXCOORD: … @ /meshes/0/primitives/0
```

---

### `inspect_model`

Parse a remote GLB/glTF and return structural statistics: scene/node/mesh counts, vertex and triangle totals, material and texture summaries, animation count, extensions used. Pure inspection — no pass/fail verdict, no spec compliance check.

**Rate limit:** 30 calls/minute per user.

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "format": "uri", "description": "Public https URL of a .glb or .gltf file." }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

Example response text:
```
Model: avatar.glb (1.80 MB, glb)
Generator: Blender 4.1 · glTF 2.0
Scenes: 1, Nodes: 47, Meshes: 12, Materials: 8, Textures: 10
Animations: 3, Skins: 1
Vertices: 18,432, Triangles: 24,108
Indexed primitives: 12, Non-indexed: 0
Extensions used: KHR_materials_unlit
Textures:
  • Albedo — image/jpeg 1024×1024, 184.2 KB
  • Normal — image/png 512×512, 92.7 KB
```

`structuredContent` carries the full structured object for programmatic processing.

---

### `optimize_model`

Inspect the model and return actionable suggestions for reducing file size and draw-call overhead: triangle budget, Draco/Meshopt compression, oversized textures, KTX2 transcoding, non-indexed primitives, redundant materials, and more. Each suggestion includes a severity (`info`, `warn`, `critical`) and a size-reduction estimate.

**Rate limit:** 10 calls/minute per user.

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "format": "uri", "description": "Public https URL of a .glb or .gltf file." }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

Example response text:
```
[CRIT] large_textures: 3 textures exceed 512×512 — consider resizing. — estimated 60% size reduction
[WARN] no_draco: No geometry compression detected — apply Draco or Meshopt. — estimated 40% size reduction
[INFO] ktx2_transcoding: Convert PNG/JPEG textures to KTX2 for GPU-native compression.
```

---

## Rate limits

| Scope            | Limit                    |
|------------------|--------------------------|
| Per IP (all)     | 600 requests / minute    |
| Per user (all)   | 1 200 requests / minute  |
| `validate_model` | 10 calls / minute / user |
| `inspect_model`  | 30 calls / minute / user |
| `optimize_model` | 10 calls / minute / user |

Rate-limit errors return JSON-RPC error code `-32000` with message `rate_limited` and a `retry_after` field (seconds).

---

## Example Claude workflow

Here is a realistic conversation showing how Claude uses the MCP tools end-to-end.

**User:**
> I just uploaded a character called "storm-mage". Can you check if it's valid, show me its stats, and then render it?

**Claude internally calls:**

1. `get_avatar({ slug: "storm-mage" })` — resolves the UUID and model URL.

2. `validate_model({ url: "https://cdn.three.ws/u/…/storm-mage.glb" })` — runs the Khronos validator.

   Response:
   ```
   glTF-Validator report for storm-mage.glb (3241.0 KB)
   Errors: 0, Warnings: 1, Infos: 2, Hints: 0
     [WRN] NODE_EMPTY: node "Armature" has no mesh and no children
   ```

3. `inspect_model({ url: "https://cdn.three.ws/u/…/storm-mage.glb" })` — structural overview.

   Response:
   ```
   Model: storm-mage.glb (3.17 MB, glb)
   Generator: Blender 4.2 · glTF 2.0
   Scenes: 1, Nodes: 63, Meshes: 18, Materials: 11, Textures: 14
   Animations: 7, Skins: 1
   Vertices: 31,204, Triangles: 41,892
   ```

4. `render_avatar({ slug: "storm-mage", auto_rotate: true, height: "520px" })` — renders the HTML artifact.

**Claude replies:**

> Your storm-mage avatar looks good! The validator found zero errors and one minor warning: an empty "Armature" node that has no mesh or children — harmless but you can clean it up in Blender.
>
> Stats: 18 meshes, 11 materials, 7 animations, ~42K triangles — well within real-time budget. Here it is:
>
> *[inline 3D viewer appears as an interactive HTML artifact]*

---

## Error handling

MCP errors follow the JSON-RPC error object shape:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "unknown tool: load_model",
    "data": null
  }
}
```

| Code     | Meaning                                                        |
|----------|----------------------------------------------------------------|
| `-32600` | Invalid JSON-RPC request (e.g. wrong `jsonrpc` version)        |
| `-32601` | Method not found                                               |
| `-32602` | Invalid params or unknown tool name                            |
| `-32603` | Internal server error                                          |
| `-32002` | Insufficient OAuth scope for the requested tool                |
| `-32000` | Server error: `rate_limited` (includes `retry_after`), `embed_denied_surface` |

Tool execution errors (avatar not found, fetch failure, validation library crash) do **not** use the JSON-RPC error channel. They return a normal result with `isError: true` and the message in `content[0].text`. This follows the MCP spec convention and allows tool-error recovery without aborting a batch.

**Authentication errors** return HTTP `401` with a `WWW-Authenticate` header. The header includes the protected-resource metadata URL so compliant clients (Claude Desktop, Claude Code) can start the OAuth flow automatically.

---

## Local development and testing

Clone the repo and start the dev server:

```bash
git clone https://github.com/nirholas/three.ws
npm install
npm run dev
# MCP endpoint: http://localhost:5173/api/mcp
```

Authentication is still enforced in dev mode. Use your API key in the `Authorization` header, or point a local OAuth client at the dev server.

Test the server with `mcp-inspector`:

```bash
npx @modelcontextprotocol/inspector http://localhost:5173/api/mcp
```

`mcp-inspector` gives you a browser UI to call tools manually, inspect responses, and validate JSON schemas before wiring up a full Claude workflow.

To point Claude Code at your local server, update `.mcp.json`:

```json
{
  "mcpServers": {
    "3d-agent": {
      "url": "http://localhost:5173/api/mcp",
      "headers": {
        "Authorization": "Bearer 3da_live_xxxxx"
      }
    }
  }
}
```

Restart Claude Code after editing `.mcp.json` so the new server config is picked up.
