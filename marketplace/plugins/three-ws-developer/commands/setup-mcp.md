---
description: Configure the @3d-agent/mcp-server in Claude Desktop, Claude Code, or Cursor — outputs the exact JSON snippet and optionally writes it to your config file.
---

You are helping the user add the `@3d-agent/mcp-server` to their MCP client config. Follow these steps precisely:

## Step 1 — Detect OS and find the config file

Check the user's platform:

- **macOS Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows Claude Desktop:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Claude Code (project):** `.mcp.json` in the current working directory
- **Claude Code (global):** `~/.claude/claude_desktop_config.json`
- **Cursor:** `~/.cursor/mcp.json`

Use `uname -s` or `$OS` to detect the platform. Check which of these files already exists with the shell.

## Step 2 — Collect wallet addresses

Ask the user (in a single message) for:

1. **EVM wallet address** (Base USDC payouts) — `0x...` format
2. **Solana wallet address** (Solana USDC payouts) — base58 format
3. **Helius API key** (optional, improves pump_snapshot data — get free at helius.dev)
4. **CDP API key ID + secret** (optional, enables Coinbase Bazaar discovery — get at portal.cdp.coinbase.com)

If the user skips any optional field, omit that env var from the config.

## Step 3 — Generate the config snippet

Produce the exact JSON block to add to their config file under `"mcpServers"`:

```json
{
  "mcpServers": {
    "3d-agent": {
      "command": "npx",
      "args": ["-y", "@3d-agent/mcp-server"],
      "env": {
        "MCP_EVM_PAYMENT_ADDRESS": "<their EVM address>",
        "MCP_SVM_PAYMENT_ADDRESS": "<their Solana address>"
      }
    }
  }
}
```

Add optional env vars only if the user supplied them:
- `"HELIUS_API_KEY": "<key>"` — better pump.fun token data
- `"CDP_API_KEY_ID": "<id>"` and `"CDP_API_KEY_SECRET": "<secret>"` — Coinbase Bazaar discovery
- `"SOLANA_RPC_URL": "https://mainnet.helius-rpc.com/?api-key=<key>"` — if Helius key provided

If the config file already exists, read it first and **merge** the `"3d-agent"` entry into the existing `"mcpServers"` object rather than replacing the whole file.

## Step 4 — Write or show

Ask the user: "Should I write this to `<config path>` now, or do you want to paste it yourself?"

- If they say write: use the Write or Edit tool to update the file.
- If they say paste: display the final JSON block in a code fence with clear copy instructions.

## Step 5 — Verify

After writing, confirm the file is valid JSON with:
```bash
node -e "JSON.parse(require('fs').readFileSync('<path>', 'utf8')); console.log('valid')"
```

Then tell the user to restart Claude Desktop / Claude Code / Cursor for the tools to appear.

## Tools available

Once configured, these four paid tools will be available (settled in USDC via x402):

| Tool | Price | What it does |
|------|-------|--------------|
| `get_pose_seed` | $0.001 | Deterministic pose map for a three.ws avatar |
| `pump_snapshot` | $0.005 | Live pump.fun token snapshot — price, volume, holders |
| `agent_reputation` | $0.01 | ERC-8004 reputation lookup on any EVM chain |
| `vanity_grinder` | up to $0.50 | Mine a Solana keypair with a custom address prefix |
