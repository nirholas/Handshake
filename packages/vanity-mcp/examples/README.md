# Examples: @three-ws/vanity-mcp

Two runnable examples. Both spawn this package's own MCP server over stdio (the
same `node src/index.js` entry point the README documents), speak real MCP
JSON-RPC to it, and read the live grind-bounty market.

| File | What it does | Run |
|---|---|---|
| [`list-tools.mjs`](list-tools.mjs) | Prints all 8 tools with titles, annotation hints, and full input schemas. | `node examples/list-tools.mjs` |
| [`quote-and-appraise.mjs`](quote-and-appraise.mjs) | Market config, then a pattern's difficulty and honest bounty price, then one address's rarity, then live market totals. | `node examples/quote-and-appraise.mjs` |

Run them from the package directory:

```bash
cd packages/vanity-mcp
node examples/list-tools.mjs
node examples/quote-and-appraise.mjs
```

Nothing to install and nothing to configure: every tool on this server is
read-only and keyless. Posting a bounty and claiming one are x402-paid writes on
the HTTP API, and this server does not expose them, so these examples cannot
spend anything. The server prints a one-line banner to stderr on connect
(`[vanity-mcp@x.y.z] connected over stdio with 8 tools`), which is normal.

## list-tools.mjs

Runs the MCP `initialize` handshake, then `tools/list`, and formats every tool.
Expected output (abridged):

```
server:       vanity-mcp v0.1.2 (stdio)
capabilities: tools
tools:        8

1. vanity_quote
   title: Quote the bounty price for a vanity pattern
   hints: read-only, idempotent, open-world
   params:
     - prefix (optional; string)
     - suffix (optional; string)
     - ignoreCase (optional; boolean)

2. vanity_appraise
   hints: read-only, idempotent, open-world
   params:
     - address (required; string, minLength 32, maxLength 44)
     - prefixLen (optional; integer, min 0)
     - suffixLen (optional; integer, min 0)

3. vanity_board      4. vanity_open       5. vanity_stats
6. vanity_leaderboard  7. vanity_config   8. vanity_gallery
```

Note which two carry `idempotentHint`: `vanity_quote` and `vanity_appraise` are
pure functions of their input, so the same pattern or address always scores the
same. The six market reads are not idempotent, because the market moves.

## quote-and-appraise.mjs

Four live calls. The interesting pair is the difficulty oracle and the
appraiser: the first tells you what a pattern should cost to have ground, the
second tells you what an address you already hold was worth grinding.

```
vanity_config:
  payouts configured: true
  settlement asset:   USDC (6 decimals)
  escrow networks:    base, solana
  pricing band:       0.050000 to 5000.000000 USDC
  protocol:           three-vanity-bounty/v1

vanity_quote: prefix "THREE", case-sensitive
  tier:              Mythic (39 bits of rarity)
  expected attempts: 11,308,763,834
  expected grind:    2.1h on the reference rig
  suggested bounty:  2.094216 USDC
  generous bounty:   5.235540 USDC

vanity_appraise: FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
  detected pattern:  prefix "FeMb", suffix "none"
  tier:              Epic (score 2166)
  expected attempts: 3,304,724
  grind time:        under a second
  scoring model:     base58-exact/v2

vanity_stats:
  open bounties:  0 (0.000000 USDC escrowed)
  settled:        0 (0.000000 USDC paid out)
  total ever:     0

All four calls were read-only. No bounty was posted, claimed, or paid.
```

The quote is deterministic, so a rerun with the same prefix reproduces those
numbers exactly. `vanity_stats` is live and moves with the market.

Difficulty is exponential in pattern length, which the two runs make obvious: a
3-character prefix is ~3.4 million attempts and prices at the 0.05 USDC floor,
while a 5-character case-sensitive prefix is ~11.3 billion attempts and prices
at ~2.09 USDC. Quote before you escrow.

### Arguments

```bash
node examples/quote-and-appraise.mjs "<base58 prefix>" "<solana address>"
```

Both optional. The default prefix is `THREE`; the default address is the $THREE
mint, a real mainnet address. Any Base58 public key of 32 to 44 characters can be
appraised, and nothing about it is stored.

### Environment

Optional, forwarded to the server if set: `THREE_WS_BASE` (default
`https://three.ws`) and `THREE_WS_TIMEOUT_MS`.
