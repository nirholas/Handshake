# Give your AI assistant a 3D tool

Model Context Protocol is how Claude Code, Claude Desktop, Cursor, and a growing
list of other clients pick up tools. This recipe is an MCP server that hands any
of them two abilities: generate a 3D model from text, and look at a 3D model.

**[Download `mcp_3d_server.mjs`](/cookbook/recipes/mcp_3d_server.mjs)**, then:

```bash
npm install @modelcontextprotocol/sdk zod
claude mcp add three-ws-3d -- node /absolute/path/to/mcp_3d_server.mjs
```

Or wire it into any MCP client's config by hand:

```json
{
  "mcpServers": {
    "three-ws-3d": {
      "command": "node",
      "args": ["/absolute/path/to/mcp_3d_server.mjs"]
    }
  }
}
```

Then ask your assistant for a model and it will build one. No API key anywhere
in that config, because the underlying lane is keyless.

## The two tools

| Tool | Input | Returns |
|---|---|---|
| `generate_3d_model` | `prompt` | The GLB URL, a viewer link, and an AR link |
| `render_3d_model` | `glbUrl`, `size` | A PNG **inline as an image**, so the model can see it |

`render_3d_model` is the interesting half. Returning the image as MCP image
content rather than a URL means a vision-capable client actually looks at the
geometry it just produced:

```js
const bytes = Buffer.from(await res.arrayBuffer());
return {
  content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
};
```

That closes the generate-then-inspect loop inside the conversation. The
[self-correcting 3D notebook](/cookbook/self-correcting-3d) builds the same loop
explicitly with the Responses API; here you get it for free because the client
already has vision.

## Verifying it before you wire it up

An MCP server that fails to boot looks identical to one that is merely not
configured yet, which is a miserable thing to debug from inside a client. Smoke
test it over stdio first:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp_3d_server.mjs
```

A healthy server answers the initialize handshake and then lists both tools. If
that works, any conforming client will work.

## Annotations are not decoration

Both tools declare what they do to the world:

```js
annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
```

Clients use these to decide what needs a confirmation prompt. `readOnlyHint`
says this call changes nothing the user owns; `openWorldHint` says it reaches
the public internet. Getting them wrong in either direction is a real bug:
too permissive and a destructive tool runs unprompted, too strict and every
harmless call nags. Declare them honestly.

## Description text is the tool's real interface

The model never reads your code. It reads the description, and that is the only
thing standing between a good call and a wasted 90 seconds:

```js
description:
  'Turn a text prompt into a real, textured 3D model (GLB) and return its URL. ' +
  'Free draft tier: single-subject prompts work best ("a wooden treasure chest"), ' +
  'no rigging. Takes roughly 60 to 120 seconds.',
```

Three things are packed in there deliberately: what the tool produces, what kind
of prompt actually works on this tier, and how long it takes. The last one stops
a client from firing a duplicate call because it assumed the first had hung.

## Polling, again

The server carries the same poll discipline as the
[command-line recipe](/cookbook/text-to-3d-cli): honor `retryAfter`, clamp it to
a sane window, and bound the total wait.

```js
function pollDelay(payload) {
  const seconds = Number(payload?.retryAfter);
  if (!Number.isFinite(seconds)) return MIN_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, seconds * 1000));
}
```

Ten minutes is the ceiling. A tool call that hangs forever is worse than one that
fails with a clear message, because the client has no way to tell the difference
between slow and stuck.

## Already using three.ws?

If you want the full platform surface (avatars, rigging, animation, agents)
rather than just text-to-3D, the hosted MCP server at `https://three.ws/api/mcp`
exposes it, and [the MCP docs](/docs/mcp) cover the tool list. This recipe is the
opposite trade: a small file you own and can modify, wrapping only the free
endpoints.

## Where to go next

- **The MCP surface three.ws already hosts** → [MCP docs](/docs/mcp)
- **The same loop, driven explicitly** → [A self-correcting 3D collectible set](/cookbook/self-correcting-3d)
- **The full endpoint reference** → [3D API docs](/docs/3d-api)
