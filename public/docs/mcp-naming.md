# Naming MCP — on-chain identity for AI agents

Resolve Solana Name Service (`.sol`) names to wallets, reverse-look-up a wallet to its primary `.sol` name, and check whether a `*.threews.sol` agent handle is free to claim — the identity layer that lets agents refer to each other by name instead of a 44-character base58 string. Mainnet, read-only.

Registered in the [official MCP registry](https://registry.modelcontextprotocol.io/?q=io.github.nirholas) as **`io.github.nirholas/naming-mcp`**.

- **Install:** `npx -y @three-ws/naming-mcp`
- **npm:** [`@three-ws/naming-mcp`](https://www.npmjs.com/package/@three-ws/naming-mcp), published from `packages/naming-mcp`
- **Transport:** stdio — no account, no key, no payment

## Add it

```bash
claude mcp add naming -- npx -y @three-ws/naming-mcp
```

```json
{
  "mcpServers": {
    "naming": { "command": "npx", "args": ["-y", "@three-ws/naming-mcp"] }
  }
}
```

## Tools

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `sns_resolve` | `name` *(string, required)* | Resolve a `.sol` name to the base58 wallet that owns it. Accepts a bare label, a subdomain, or the full name — the `.sol` suffix is optional (`bonfida`, `nick.threews`, `bonfida.sol`). Returns `resolved:false` when the name is unregistered. |
| `sns_reverse` | `address` *(string, required)* | Reverse-look-up a wallet to the primary `.sol` name it has set as its favorite. Returns `resolved:false` when the wallet has no favorite domain — a routine answer, not an error. |
| `threews_availability` | `label` *(string, required, 1–63 chars of `[a-z0-9-]`)* | Check whether `<label>.threews.sol` is available to claim as a three.ws agent identity. Returns the full domain, availability, the current owner if taken, the on-chain check status, and the public showcase URL for a claimed handle. |

## Examples

Resolve a name:

```json
{ "name": "bonfida.sol" }
```

Reverse-look-up a wallet:

```json
{ "address": "HKKp49qGWXd639QsuH7JiLijfVW5UtCVY4s1n2HANwEA" }
```

Is `alice.threews.sol` free?

```json
{ "label": "alice" }
```

## Configuration

| Env | Purpose | Default |
|-----|---------|---------|
| `THREE_WS_BASE` | Base URL of the three.ws API serving `/api/sns` and `/api/threews/subdomain`. | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | Per-request timeout in ms. Lookups hit a Solana RPC pool, so the default leaves room for cold reads. | `20000` |

## Notes

- **Read-only, mainnet only.** No auth, no key, no payment. Minting a `*.threews.sol` subdomain is an authenticated write on the HTTP API; `threews_availability` is the public read.
- Responses are a consistent `{ ok, … resolved }` shape; errors are normalized with `.code` (`timeout`, `network_error`, `upstream_error`, `bad_config`).

## Source & publishing

Manifest: [`packages/naming-mcp/server.json`](https://github.com/nirholas/three.ws/blob/main/packages/naming-mcp/server.json). Published with `npm run publish:mcp`. Full catalog: [MCP overview](/docs/mcp).
