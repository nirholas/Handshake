---
description: Scaffold a new three.ws AI agent in the current project — creates an entry file wired to the three.ws SDK, MCP tools, and x402 payments. Pass a name: /scaffold-agent MyAgent
---

You are scaffolding a new three.ws agent into the user's project. The argument `$ARGUMENTS` is the agent name (default: `MyAgent` if blank).

## Step 1 — Detect project type

Check the current working directory for:
- `package.json` → Node.js / browser project
- `vite.config.*` → Vite frontend
- `next.config.*` → Next.js
- No package.json → standalone HTML

Read `package.json` if present to understand the existing stack.

## Step 2 — Install dependencies

For Node.js projects, run:

```bash
npm install @nirholas/agent-kit @x402/mcp @modelcontextprotocol/sdk/client
```

If the project uses a lockfile other than `package-lock.json` (yarn.lock → yarn, pnpm-lock.yaml → pnpm), use the right package manager.

## Step 3 — Create the agent entry file

Create `agent.js` (or `agent.ts` if TypeScript is detected) in the project root with this structure, substituting `$ARGUMENTS` for the agent name:

```js
import { AgentKit } from '@nirholas/agent-kit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Connect to the three.ws paid MCP tools
const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '@3d-agent/mcp-server'],
  env: {
    MCP_EVM_PAYMENT_ADDRESS: process.env.EVM_WALLET_ADDRESS ?? '',
    MCP_SVM_PAYMENT_ADDRESS: process.env.SOLANA_WALLET_ADDRESS ?? '',
  },
});

const mcp = new Client({ name: '<AgentName>', version: '1.0.0' });
await mcp.connect(transport);

// Mount the three.ws chat + avatar panel
const agent = new AgentKit({
  name: '<AgentName>',
  description: 'A three.ws AI agent',
  endpoint: process.env.AGENT_ENDPOINT ?? 'http://localhost:3000',
  onMessage: async (text, context) => {
    // Your LLM call goes here — replace with Anthropic, OpenAI, or Vercel AI SDK
    return `Echo: ${text}`;
  },
});

// Use paid MCP tools
export async function getPose(prompt) {
  const result = await mcp.callTool('get_pose_seed', { prompt });
  return JSON.parse(result.content[0].text);
}

export async function getTokenSnapshot(mint) {
  const result = await mcp.callTool('pump_snapshot', { mint });
  return JSON.parse(result.content[0].text);
}

export { agent, mcp };
```

Replace `<AgentName>` with the actual value from `$ARGUMENTS`.

## Step 4 — Create `.env.example`

If `.env.example` does not already exist, create it:

```env
# three.ws agent configuration
AGENT_ENDPOINT=http://localhost:3000

# Wallet addresses for x402 USDC payments to the MCP server
EVM_WALLET_ADDRESS=0x...
SOLANA_WALLET_ADDRESS=...

# Optional: Helius for richer pump.fun data
HELIUS_API_KEY=

# Optional: Coinbase CDP for Bazaar discovery
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=
```

If `.env.example` already exists, append only the missing keys.

## Step 5 — Add npm script

In `package.json`, add under `"scripts"`:
```json
"agent": "node agent.js"
```

## Step 6 — Report

Tell the user:
1. What files were created or modified
2. To copy `.env.example` → `.env` and fill in wallet addresses
3. To run `npm run agent` to start
4. That the agent will be available at `http://localhost:3000` by default

If any step fails (missing package.json, write permission error, etc.), report the exact error and ask how to proceed.
