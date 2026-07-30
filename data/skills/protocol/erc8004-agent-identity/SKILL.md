---
name: erc8004-agent-identity
description: Complete guide to ERC-8004: the open standard for on-chain AI agent identity, reputation, and validation. Covers agent registration as NFTs, reputation signals, validator attestations, and multi-chain deployment across 12 chains. Essential for building trustless AI agent ecosystems.
license: MIT
metadata:
  category: protocol
  difficulty: intermediate
  author: clawhub
  tags: [protocol, erc8004-agent-identity]
---

# ERC-8004: On-Chain AI Agent Identity

ERC-8004 is an open Ethereum standard for **discovering, choosing, and interacting with AI agents** across organizational boundaries without pre-existing trust. It was created by the Sperax team and is deployed across 12 chains.

**Spec**: https://eips.ethereum.org/EIPS/eip-8004

## Why ERC-8004?

As AI agents proliferate, we need a way to:
- **Discover** agents across platforms (not locked in one vendor)
- **Verify** agent capabilities and track record
- **Trust** agents without knowing who built them
- **Pay** agents via standard protocols (x402, on-chain)

ERC-8004 solves this with three on-chain registries.

## The Three Registries

### 1. Identity Registry (ERC-721 NFT)

Every agent gets an **NFT identity**: a unique, transferrable on-chain identity.

- Based on ERC-721 with URIStorage
- TokenURI points to a JSON registration file
- Owners can update metadata, transfer, or burn
- One NFT = one agent identity

### 2. Reputation Registry

A standard interface for posting and querying **feedback signals** about agents.

| Signal | Measures | Scale |
|--------|----------|-------|
| `starred` | Quality rating | 0-100 |
| `reachable` | Endpoint reachable | binary |
| `uptime` | Availability | percentage |
| `successRate` | Task completion rate | percentage |
| `responseTime` | Response latency | milliseconds |
| `tradingYield` | Trading return | signed percentage |
| `revenues` | Cumulative revenue | USD |

**Star ratings** map to the 0-100 scale:
- 1★ = 20, 2★ = 40, 3★ = 60, 4★ = 80, 5★ = 100

### 3. Validation Registry

**Independent validator attestations** for agent capabilities:
- zkML proofs (zero-knowledge machine learning)
- TEE attestations (trusted execution environment)
- Staker validations (economic security)
- Custom validator contracts

## Agent Registration

### Registration File Format

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "My Trading Agent",
  "description": "Automated yield optimizer on Arbitrum",
  "image": "https://three.ws/avatars/thumbs/default.png",
  "services": [
    {
      "name": "MCP",
      "endpoint": "https://api.myagent.com/mcp",
      "version": "2025-06-18",
      "mcpTools": ["getQuote", "executeTrade"]
    },
    {
      "name": "A2A",
      "endpoint": "https://api.myagent.com/.well-known/agent-card.json",
      "version": "0.3.0",
      "a2aSkills": ["defi/yield_optimization"]
    },
    {
      "name": "ENS",
      "endpoint": "myagent.eth",
      "version": "v1"
    }
  ],
  "x402Support": true,
  "active": true
}
```

### Service Types

| Service | Purpose | Use When |
|---------|---------|----------|
| MCP | Model Context Protocol | Agent exposes tools for other AI to call |
| A2A | Agent-to-Agent | Agent participates in multi-agent workflows |
| ENS | Ethereum Name Service | Human-readable agent address |
| DID | Decentralized Identifier | Cross-chain identity |

### Key Operations

| Operation | Description |
|-----------|-------------|
| `registerAgent` | Mint an agent NFT with metadata |
| `lookupAgent` | Query agent details by token ID |
| `searchAgents` | Find agents by criteria |
| `updateMetadata` | Update agent's registration file |
| `transferAgent` | Transfer ownership to new address |
| `getAgentReputation` | Fetch reputation signals |
| `submitFeedback` | Post a reputation signal |
| `addValidation` | Add validator attestation |
| `getValidations` | Query validations for an agent |
| `listAgents` | List agents by owner |

## Supported Chains (12)

| Chain | Networks |
|-------|----------|
| Ethereum | Mainnet, Sepolia |
| BNB Chain | Mainnet, Testnet |
| Arbitrum | Mainnet, Sepolia |
| Base | Mainnet, Sepolia |
| Optimism | Mainnet, Sepolia |
| Polygon | Mainnet, Amoy |

All contracts use vanity addresses starting with `0x8004...`

## Best Practices

### Registration

1. **Always include a rich registration file** with name, description, image, and services
2. **Declare services explicitly**: other agents need to know how to communicate
3. **Keep metadata current**: update when endpoints change
4. **Use active flag**: set `"active": false` when taking agent offline

### Reputation

1. **Encourage feedback**: more signals = more trust
2. **Monitor your scores**: respond to quality issues
3. **Use standard signal types**: stick to the defined tags for interoperability
4. **Trusted probers** (infra watchtowers) should regularly publish uptime/reachability

### Security

1. **Validate callers**: check msg.sender for sensitive operations
2. **Rate-limit feedback**: prevent spam signals
3. **Verify validators**: ensure validator contracts are trustworthy

## Use Cases for OpenClaw Agents

### Register Your OpenClaw Agent On-Chain

Give your agent a verifiable identity that works across platforms:
1. Deploy agent registration via ERC-8004
2. Advertise MCP endpoints so other agents can discover your tools
3. Build reputation over time as users interact

### Discover & Interact With Other Agents

Use the ERC-8004 registries to:
1. Find specialized agents (e.g., "DeFi yield optimizer on Arbitrum")
2. Check reputation before trusting
3. Call via MCP or A2A protocols

### Build Agent Marketplaces

ERC-8004 provides the infra layer for on-chain agent marketplaces:
- Identity (who is this agent?)
- Reputation (is it any good?)
- Validation (has it been audited?)
- Discovery (how do I find it?)

## Related Resources

| Resource | URL |
|----------|-----|
| ERC-8004 Spec | https://eips.ethereum.org/EIPS/eip-8004 |
| Best Practices | https://github.com/sperax |
| Agent Creator UI | https://github.com/sperax |
| Demo Agent | https://github.com/sperax |
| Solidity Contracts | https://github.com/sperax |
| Subgraph | https://github.com/sperax |
| SperaxOS | https://chat.sperax.io |
