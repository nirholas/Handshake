# Vanity MCP — the Solana vanity-address bounty market

Read the three.ws vanity-address **grind-bounty market** and proof-of-grind rarity gallery from any agent. Quote how hard a pattern is and what to escrow for it, appraise any address's rarity, and browse the bounty board, the claimable queue workers poll, market stats, the grinder leaderboard, payout config, and the gallery of rare addresses with verifiable grind receipts. Read-only — no key, no signer, no payment.

Registered in the [official MCP registry](https://registry.modelcontextprotocol.io/?q=io.github.nirholas) as **`io.github.nirholas/vanity-mcp`**.

- **Install:** `npx -y @three-ws/vanity-mcp`
- **npm:** [`@three-ws/vanity-mcp`](https://www.npmjs.com/package/@three-ws/vanity-mcp), published from `packages/vanity-mcp`
- **Transport:** stdio

## Add it

```bash
claude mcp add vanity -- npx -y @three-ws/vanity-mcp
```

```json
{
  "mcpServers": {
    "vanity": { "command": "npx", "args": ["-y", "@three-ws/vanity-mcp"] }
  }
}
```

## Tools

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `vanity_quote` | `prefix` *(string)*, `suffix` *(string)*, `ignoreCase` *(boolean, default false)* | Quote how hard a Solana vanity address is and what to escrow for it: expected attempts, rarity tier, and an honest suggested USDC bounty (atomic units) from the difficulty→price oracle. Pure function of the pattern. |
| `vanity_appraise` | `address` *(string, required, 32–44 chars)*, `prefixLen` *(number)*, `suffixLen` *(number)* | Appraise how rare an address is: detected pattern, rarity score, rarity bits, tier, and expected grind attempts. If it's in the gallery, the public entry is returned too. Pure math — nothing stored. |
| `vanity_board` | `status` *(`open`\|`all`\|`settled`, default `open`)*, `sort` *(`recency`\|`reward`\|`expiry`, default `recency`)*, `limit` *(1–100, default 24)*, `offset` *(default 0)* | Browse the public bounty board — vanity-address bounties requesters have escrowed for the worker fleet. Each shows pattern, USDC amount, difficulty, status, and timing. |
| `vanity_open` | `limit` *(1–100, default 30)* | List the open, unexpired bounties a grinding worker can race to claim — the queue worker fleets poll. First worker to submit a verified, sealed key wins. |
| `vanity_stats` | *(none)* | Live market totals: bounties open, USDC currently escrowed, and USDC paid out to winners. |
| `vanity_leaderboard` | `limit` *(1–100, default 10)* | Top grinders by total USDC earned — worker id and cumulative payout. |
| `vanity_config` | *(none)* | Market config: whether on-chain payouts are configured, the settlement asset (USDC) and decimals, live escrow networks (Base / Solana), the pricing band, protocol version, and sealed-envelope scheme. Check before posting. |
| `vanity_gallery` | `sort` *(`score`\|`recency`, default `score`)*, `tier` *(string)*, `minLength` *(number)*, `contains` *(string)*, `limit` *(1–100, default 24)*, `offset` *(default 0)* | Browse the proof-of-grind gallery: rare addresses published with a verifiable grind receipt. Each shows the address, pattern, rarity score/bits, tier, and an explorer link. |

## Examples

Quote a `THREE…` prefix:

```json
{ "prefix": "THREE", "ignoreCase": false }
```

Biggest open bounties first:

```json
{ "status": "open", "sort": "reward", "limit": 10 }
```

Appraise an address:

```json
{ "address": "THREEsynthetic1111111111111111111111111111" }
```

## Configuration

| Env | Purpose | Default |
|-----|---------|---------|
| `THREE_WS_BASE` | Base URL of the three.ws API serving `/api/vanity`. | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | Per-request timeout in ms. All endpoints are reads. | `20000` |

## Notes

- **Read-only.** Posting or claiming bounties is the x402-paid write path on the HTTP API; this server exposes only reads and discovery.
- Market state is live — bounties are posted, claimed, and expire — so most tools are intentionally non-idempotent. Errors are normalized with `.code` (`timeout`, `network_error`, `upstream_error`).

## Source & publishing

Manifest: [`packages/vanity-mcp/server.json`](https://github.com/nirholas/three.ws/blob/main/packages/vanity-mcp/server.json). Published with `npm run publish:mcp`. Full catalog: [MCP overview](/docs/mcp).
