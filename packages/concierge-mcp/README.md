<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/concierge-mcp</h1>

<p align="center"><strong>Ask any website's AI concierge a grounded question, and generate the embed to add one to a site, from any AI assistant.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/concierge-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/concierge-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/concierge-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/concierge-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws/concierge"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that puts the [three.ws Concierge](https://three.ws/concierge), the embeddable AI chat widget with a talking 3D avatar, in reach of any AI assistant over stdio.

Three tools:

| Tool | What it does | Network |
| --- | --- | --- |
| **`concierge_ask`** | Ask a website's AI concierge a question. Give it a `url` and it fetches that page and answers grounded in the real content (title, headings, nav, main text), the way to *ask any website a question*. Or pass `knowledge`/`content` to answer from text you already have. | Free three.ws lane + fetches the URL |
| **`concierge_embed`** | Generate ready-to-paste embed code that adds a Concierge to a website: the one-tag `<script>`, the `<three-concierge>` web component, an npm snippet, or an imperative `mount()` call, configured with accent, avatar, greeting, curated knowledge, and suggested prompts. | Offline |
| **`concierge_avatars`** | List the rigged 3D avatars a Concierge can wear. | Offline |

No API key, no signer, no payment. `concierge_ask` runs on the public, free `POST /api/concierge` answer lane; the other two are pure local generators.

## Install

```bash
npm install @three-ws/concierge-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/concierge-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add concierge -- npx -y @three-ws/concierge-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"concierge": {
			"command": "npx",
			"args": ["-y", "@three-ws/concierge-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx -y @three-ws/concierge-mcp
```

## What you can do with it

**Ask any website a question, grounded in its real content:**

> Use concierge_ask to answer "what does the Pro plan include?" from https://example.com/pricing

The server fetches the page, harvests its readable text, sends it to the concierge answer engine, and returns an answer that is told not to invent anything the page doesn't say.

**Ask from text you already have (no URL):**

> concierge_ask: question = "what's the refund window?", knowledge = "Returns accepted within 30 days."

**Generate a copy-paste embed for a site:**

> Use concierge_embed for siteName "Acme", accent "#f97316", avatar "nova", suggestions ["What is Acme?", "Pricing?"], flavor "script"

Returns the exact `<script>` tag to drop into the site's HTML.

**Pick an avatar first:**

> concierge_avatars → then use the id you like as concierge_embed's `avatar`

## Tools in detail

### `concierge_ask`
Read-only, open-world.

| Parameter | Type | Notes |
| --- | --- | --- |
| `question` | string (required) | The question, in natural language. |
| `url` | string (url) | A page to ground the answer in. Fetched + harvested. |
| `siteName` | string | Display name; inferred from the page when omitted. |
| `knowledge` | string | Curated authoritative facts. Leads over harvested text. |
| `content` | string | Raw text to ground in when you pass no `url`. |
| `persona` | string | Tone instruction for the reply. |
| `lang` | string | BCP-47 hint, e.g. `en`, `es`. |

At least one of `url`, `knowledge`, or `content` is required. Returns `{ ok, question, answer, grounded_in, provider, model, endpoint }`.

### `concierge_embed`
Read-only, idempotent, offline.

Key parameters: `siteName`, `flavor` (`script` \| `web-component` \| `npm` \| `imperative` \| `all`, default `all`), `accent`, `avatar`, `customAvatar`, `position`, `theme`, `greeting`, `persona`, `knowledge`, `suggestions[]`, `endpoint`, `muted`, `open`, `noPicker`, `noTeaser`, `lang`. Returns `{ ok, flavor, snippets, applied_config, docs }`. The `script`, `web-component`, and `imperative` snippets are all plain-HTML paste-ready (they load the CDN global build); the `npm` snippet is for bundler users.

### `concierge_avatars`
Read-only, idempotent, offline. No parameters. Returns `{ ok, default, count, avatars, note }`, each avatar carrying `id`, `name`, `tagline`, `style`, and `framing`.

## Configuration

All optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `THREE_WS_BASE` | `https://three.ws` | API origin for the answer call + the origin the embed snippets point at. |
| `THREE_WS_TIMEOUT_MS` | `45000` | Timeout for the concierge answer (it may fail over across LLM providers). |
| `CONCIERGE_PAGE_TIMEOUT_MS` | `12000` | Timeout for fetching a page in `concierge_ask`. |

## Errors

A failed tool call returns an MCP error result (`isError: true`) whose text is a single JSON object: `{ "ok": false, "error": "<code>", "message": "…" }`, plus `status` on upstream rejections:

| `error` | Meaning | Recovery |
| --- | --- | --- |
| `bad_request` | Bad arguments: no `url`/`knowledge`/`content` on `concierge_ask`, a non-http(s) `url`, or an unknown `avatar` id. | Fix the call. |
| `unsupported_media` | The fetched `url` is not an HTML/text page. | Point at a readable page, or pass `content`. |
| `upstream_error` | The answer endpoint rejected the request; `status` carries the HTTP code (`429` = the free lane's IP rate limit). | Act on `status`; back off on `429`. |
| `stream_error` | The answer stream failed before completing. | Retry. |
| `timeout` | No answer within `THREE_WS_TIMEOUT_MS`, or the page fetch outran `CONCIERGE_PAGE_TIMEOUT_MS`. | Retry or raise the timeout. |
| `network_error` | The request never reached the API (DNS, offline, TLS). | Check connectivity / `THREE_WS_BASE`. |
| `bad_config` | `THREE_WS_TIMEOUT_MS` is not a positive number. Thrown while the server starts (module load), so the process exits before serving. | Fix the env var. |

## How it relates to the widget

This server is the agent-facing side of [`@three-ws/concierge`](https://www.npmjs.com/package/@three-ws/concierge), the browser widget. Same answer engine, same avatar catalog, same grounding model, exposed as MCP tools so an assistant can *use* a site's concierge or *install* one, not just a human visitor.

- Widget + docs: [three.ws/concierge](https://three.ws/concierge)
- Reference docs: [three.ws/docs/concierge](https://three.ws/docs/concierge)
- Build tutorial: [three.ws/docs/tutorials/build-a-site-concierge](https://three.ws/docs/tutorials/build-a-site-concierge)

## Develop

```bash
npm test    # node --test, offline (registration, harvest, embed, SSE parsing)
npm start   # run the server over stdio
```

A live end-to-end check against a running three.ws (`test/_manual-e2e.mjs`) drives all three tools through a real stdio client; see the file header to run it.

## License

Apache-2.0. See [LICENSE](./LICENSE). Free to run against the public three.ws API.
