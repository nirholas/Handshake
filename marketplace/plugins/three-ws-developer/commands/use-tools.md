---
description: Show ready-to-run code for calling any of the four @3d-agent/mcp-server paid tools. Pass a tool name: /use-tools pump_snapshot
---

You are producing a working code example for a specific three.ws MCP tool. `$ARGUMENTS` is the tool name the user wants to use. If blank, show a menu of all four tools.

## Tool catalog

| Tool | Price | Input | Output |
|------|-------|-------|--------|
| `get_pose_seed` | $0.001 | `{ prompt: string }` | Pose map with Euler rotations (radians) + previewUrl |
| `pump_snapshot` | $0.005 | `{ mint: string }` | USD price, 24h volume, holders, metadata, bundle signals |
| `agent_reputation` | $0.01 | `{ agentId: string, chainId?: number }` | Reputation score, stake, recent events from ReputationRegistry |
| `vanity_grinder` | up to $0.50 | `{ prefix: string, suffix?: string }` | Solana keypair whose address starts with `prefix` |

## If `$ARGUMENTS` is blank

List all four tools in a table and ask: "Which tool do you want to use?"

## If `$ARGUMENTS` names a tool

Produce a complete, runnable Node.js script for that tool. The script must:

1. Spawn the MCP server via `StdioClientTransport` using `npx @3d-agent/mcp-server`
2. Set `MCP_EVM_PAYMENT_ADDRESS` and `MCP_SVM_PAYMENT_ADDRESS` from env
3. Use `wrapMCPClientWithPayment` from `@x402/mcp` for automatic 402 retry with a real EVM private key from `process.env.AGENT_EVM_PRIVATE_KEY`
4. Call the tool and `console.log` the parsed result
5. Close the transport

### Template for `get_pose_seed`

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { wrapMCPClientWithPayment } from '@x402/mcp';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '@3d-agent/mcp-server'],
  env: {
    MCP_EVM_PAYMENT_ADDRESS: process.env.MCP_EVM_PAYMENT_ADDRESS,
    MCP_SVM_PAYMENT_ADDRESS: process.env.MCP_SVM_PAYMENT_ADDRESS ?? '',
  },
});

const mcp = new Client({ name: 'demo', version: '1.0.0' });
await mcp.connect(transport);

const account = privateKeyToAccount(process.env.AGENT_EVM_PRIVATE_KEY);
const x402 = new x402Client().register('eip155:8453', new ExactEvmScheme(account));
const paid = wrapMCPClientWithPayment(mcp, x402, { autoPayment: true });

const result = await paid.callTool('get_pose_seed', { prompt: 'warrior stance' });
console.log(JSON.parse(result.content[0].text));

await transport.close();
```

Adapt the tool name, input, and any tool-specific notes (e.g., for `vanity_grinder` note that the returned secret key must be treated as a secret and stored securely; for `agent_reputation` note that `agentId` can be an EVM address and `chainId` defaults to Base).

After the code block, add a one-paragraph note on:
- What env vars are required (`AGENT_EVM_PRIVATE_KEY`, `MCP_EVM_PAYMENT_ADDRESS`, and optionally `MCP_SVM_PAYMENT_ADDRESS`)
- That the x402 payment (~$0.001–$0.50 USDC) is deducted automatically from the EVM wallet on each successful call
- Where to get a free Helius RPC if they want better Solana data for `pump_snapshot`
