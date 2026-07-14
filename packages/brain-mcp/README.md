<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/brain-mcp</h1>

<p align="center"><strong>Any model, one interface — discover LLM providers and run chat completions through the three.ws multi-provider router, from any AI agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/brain-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/brain-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/brain-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/brain-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI assistant the three.ws **multi-provider LLM router** over stdio. Discover which models are available — Claude, the GPT-5.6 family, o3, Qwen, DeepSeek, NVIDIA Nemotron, IBM Granite, and more — and run a chat completion through whichever one fits, without wiring each vendor SDK yourself.

The router fronts every provider behind one endpoint and transparently falls back across mirrors and free tiers if the chosen model is briefly down. The free open-weight tiers (GPT-OSS 120B, NVIDIA NIM models) work with **no key**; the paid first-party flagships unlock with a three.ws API key.

## Install

```bash
npm install @three-ws/brain-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/brain-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add brain -- npx -y @three-ws/brain-mcp
```

To unlock the paid flagships, pass your three.ws API key:

```bash
claude mcp add brain -e THREE_WS_API_KEY=sk_live_… -- npx -y @three-ws/brain-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"brain": {
			"command": "npx",
			"args": ["-y", "@three-ws/brain-mcp"],
			"env": { "THREE_WS_API_KEY": "sk_live_…" }
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/brain-mcp
```

## Tools

| Tool             | Type      | What it does                                                                                                       |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `list_providers` | read-only | List every LLM the router can reach — key, network, tier, max output, live availability, and whether it needs auth. |
| `chat`           | read-only | Run a chat completion through the chosen provider; returns the full reply, the route taken, token usage, and timing. |

Both tools read live data — the provider set and completions vary between calls, so neither is idempotent. `chat` does not mutate any platform state, so it is annotated read-only.

### Input parameters

**`list_providers`** — no parameters.

**`chat`** — `messages` (required: 1–100 turns of `{ role: "user" | "assistant", content }`, content ≤ 16,000 chars), `provider` (provider key from `list_providers`, default `gpt-oss-120b`), `system` (optional system prompt, ≤ 8,000 chars), `maxTokens` (optional, 64–16384, default 4096, clamped to the model's ceiling).

## Example

Both responses below are shape illustrations — the live provider set and generations will differ.

```jsonc
// list_providers (example response)
> {}
{
  "ok": true,
  "count": 18,
  "available": 11,
  "default_provider": "gpt-oss-120b",
  "providers": [
    { "key": "gpt-oss-120b", "label": "GPT-OSS 120B", "network": "OpenAI · OpenRouter", "tier": "balanced", "maxOutput": 8192, "available": true, "requiresAuth": false },
    { "key": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6", "network": "Anthropic", "tier": "balanced", "maxOutput": 16384, "available": true, "requiresAuth": true },
    { "key": "deepseek-r1", "label": "DeepSeek R1", "network": "DeepSeek", "tier": "reasoning", "maxOutput": 8192, "available": true, "requiresAuth": true }
    /* … */
  ]
}
```

```jsonc
// chat (example response)
> {
    "provider": "claude-sonnet-4-6",
    "system": "You are terse.",
    "messages": [{ "role": "user", "content": "Name three Solana RPC methods." }]
  }
{
  "ok": true,
  "provider": "claude-sonnet-4-6",
  "model": "Claude Sonnet 4.6",
  "network": "Anthropic",
  "tier": "balanced",
  "routed_via": null,
  "content": "getBalance, getAccountInfo, getSignaturesForAddress.",
  "usage": { "input_tokens": 24, "output_tokens": 14, "total_tokens": 38 },
  "timing_ms": { "first_token": 412, "total": 980 }
}
```

`routed_via` is `null` when the requested provider answered directly; otherwise it names the mirror or free-tier route the router fell back to (so you always get an answer even if the first choice is briefly down).

> Model availability is dynamic. Always call `list_providers` first rather than hardcoding a key — the current Claude ids are `claude-fable-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, and `claude-haiku-4-5`, but the live list is the source of truth.

## Authentication

| Model class                                                                  | Needs a key?                |
| ---------------------------------------------------------------------------- | --------------------------- |
| Free open-weight tiers (GPT-OSS 120B, NVIDIA NIM: Nemotron / Kimi / Llama 4) | No                          |
| Paid first-party flagships (Claude, GPT-5.6, o3, Qwen Plus, DeepSeek, …)     | Yes — set `THREE_WS_API_KEY` |

Create an API key at [three.ws/account](https://three.ws/account). Without it, paid models return a sign-in error and `list_providers` flags them with `requiresAuth: true`.

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable              | Required | Default            | Purpose                                                          |
| --------------------- | -------- | ------------------ | ---------------------------------------------------------------- |
| `THREE_WS_BASE`       | no       | `https://three.ws` | API base URL (override to self-host or target a preview).        |
| `THREE_WS_API_KEY`    | no       | —                  | Bearer credential that unlocks the paid first-party flagships.   |
| `THREE_WS_TIMEOUT_MS` | no       | `120000`           | Per-request timeout (completions stream server-side).            |

## Errors

A failed tool call returns an MCP error result (`isError: true`) whose text is a single JSON object — `{ "ok": false, "error": "<code>", "message": "…" }`, plus `status` and `detail` on upstream rejections:

| `error` | Meaning | Recovery |
| ------- | ------- | -------- |
| `upstream_error` | The router rejected the request — `status` carries the real HTTP code: `400` (bad arguments or an unknown provider key), `401` (paid model without a valid `THREE_WS_API_KEY`), `429` (rate-limited), `502` (the model's stream failed before producing output). | Act on `status`; for `401` set a key, for an unknown key re-run `list_providers`. |
| `timeout` | No complete response within `THREE_WS_TIMEOUT_MS`. Long flagship generations can be slow — the default 120 s matches the router's own ceiling. | Retry, lower `maxTokens`, or pick a `fast`-tier provider. |
| `network_error` | The request never reached the router (DNS, offline, TLS). | Check connectivity / `THREE_WS_BASE`. |
| `bad_config` | `THREE_WS_TIMEOUT_MS` is not a positive number (thrown at startup). | Fix the env var. |

If the requested provider fails mid-flight the router transparently falls back to a mirror or free tier and the reply's `routed_via` names the route taken — you only see an error when every route is exhausted.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0 — see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
