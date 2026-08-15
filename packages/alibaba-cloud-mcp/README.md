<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/alibaba-cloud-mcp</h1>

<p align="center"><strong>MCP server for Alibaba Cloud DashScope — Qwen chat, embeddings, and model discovery on your own account.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/alibaba-cloud-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/alibaba-cloud-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/alibaba-cloud-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/alibaba-cloud-mcp?color=339933&logo=node.js">
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#models">Models</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes Alibaba Cloud's Qwen models — and anything else in your DashScope account — to MCP clients such as Claude Desktop, Claude Code, and Cursor. It talks **directly** to the DashScope OpenAI-compatible REST API with **your own Alibaba Cloud API key**: no intermediary backend, no telemetry, no mock data.

> Community-built and not affiliated with Alibaba Cloud. Registry name: `io.github.nirholas/alibaba-cloud`.

## Install

```bash
npm install @three-ws/alibaba-cloud-mcp
```

Run it directly with `npx` (no install needed):

```bash
DASHSCOPE_API_KEY=sk-... npx @three-ws/alibaba-cloud-mcp
```

## Quick start

With Claude Code, one command:

```bash
claude mcp add alibaba-cloud -e DASHSCOPE_API_KEY=sk-... -- npx -y @three-ws/alibaba-cloud-mcp
```

Or add the server to your MCP client config:

```json
{
  "mcpServers": {
    "alibaba-cloud": {
      "command": "npx",
      "args": ["-y", "@three-ws/alibaba-cloud-mcp"],
      "env": {
        "DASHSCOPE_API_KEY": "sk-..."
      }
    }
  }
}
```

## Requirements

1. An [Alibaba Cloud account](https://www.alibabacloud.com/)
2. A [DashScope API key](https://bailian.console.alibabacloud.com/) — navigate to **API Keys** and create one
3. Node.js ≥ 20

## Tools

| Tool | Description |
|---|---|
| `qwen_chat` | Chat completion with any Qwen model (qwen-max, qwen-plus, qwen-turbo, qwen-long) |
| `qwen_embed` | Text embeddings via text-embedding-v3 (1024-dim default, up to 2048) |
| `qwen_list_models` | List all models available on this DashScope account |

## Models

| Model ID | Use |
|---|---|
| `qwen-max` | Highest quality — complex reasoning, long documents |
| `qwen-plus` | Balanced performance (default) |
| `qwen-turbo` | Fastest and cheapest — simple tasks |
| `qwen-long` | Long context (up to 1M tokens) |
| `text-embedding-v3` | Embeddings, semantic search, RAG (default) |

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DASHSCOPE_API_KEY` | **yes** | — | Your DashScope API key |
| `DASHSCOPE_MODEL_ID` | no | `qwen-plus` | Default chat model |
| `DASHSCOPE_EMBED_MODEL_ID` | no | `text-embedding-v3` | Default embedding model |
| `DASHSCOPE_BASE_URL` | no | International endpoint | Custom DashScope endpoint |
| `DASHSCOPE_REGION` | no | — | Set to `cn` for the China endpoint |
| `DASHSCOPE_TIMEOUT_MS` | no | `60000` | Request timeout in ms |

## Inspect

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/alibaba-cloud-mcp
```

## Programmatic use

The package entry point (`@three-ws/alibaba-cloud-mcp`) exports **`buildServer()`**: a
fully-registered `McpServer` with no transport attached, so you can mount the three tools
inside a host of your own instead of spawning the binary. It reads `DASHSCOPE_API_KEY` when
called, and registration is otherwise side-effect free. The DashScope client itself is
importable from `@three-ws/alibaba-cloud-mcp/src/dashscope.js` (`loadConfig`,
`DashScopeClient`, `DashScopeError`) when you want the REST wrapper without MCP.

```js
// example.mjs — run with: DASHSCOPE_API_KEY=sk-... node example.mjs
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '@three-ws/alibaba-cloud-mcp';

const server = buildServer();

// What this server exposes, before connecting anything.
for (const [name, tool] of Object.entries(server._registeredTools)) {
  console.log(`${name}: ${tool.title}`);
}

// Serve it over stdio (what the bin does), or attach any other MCP transport.
await server.connect(new StdioServerTransport());
```

```
qwen_chat: Qwen Chat
qwen_embed: Qwen Text Embeddings
qwen_list_models: List DashScope Models
```

---

Built by [three.ws](https://three.ws) · [three.ws/blog/three-ws-alibaba-cloud-partnership](https://three.ws/blog/three-ws-alibaba-cloud-partnership)
