---
name: erc8004-agent-creation-guide
description: Step-by-step guide to creating and deploying ERC-8004 Trustless Agents. Covers the full lifecycle from generating an agent identity NFT, setting up metadata, registering on-chain across 12 chains, building reputation, and connecting to the agent marketplace.
license: MIT
metadata:
  category: protocol
  difficulty: intermediate
  author: nich
  tags: [protocol, erc8004-agent-creation-guide]
---

# ERC-8004 Agent Creation Guide

A step-by-step guide to creating and deploying ERC-8004 Trustless Agents — from generating an identity NFT to building on-chain reputation across 12 chains.

## ERC-8004 Overview

ERC-8004 ("Trustless Agents") is an Ethereum standard for AI agent identity:

| Component | Description |
|-----------|-------------|
| **Agent NFT** | Each agent is an on-chain NFT (ERC-721) |
| **Identity** | Name, description, capabilities stored on-chain |
| **Reputation** | On-chain feedback and scoring system |
| **Registry** | Global registry of all agents |
| **Validation** | Trustless verification of agent capabilities |

## The 7-Step Process

### Step 1: Generate Agent Identity

```typescript
import { AgentFactory } from '@erc8004/sdk';

const factory = new AgentFactory(provider);

const agentIdentity = {
  name: "Sperax DeFi Advisor",
  description: "Expert AI agent for Sperax protocol — USDs yield, SPA staking, and Demeter farming",
  category: "defi",
  capabilities: [
    "portfolio-analysis",
    "yield-optimization",
    "risk-assessment",
    "trade-execution"
  ],
  // Resolve at mint time from platform config or the caller's selection —
  // never hardcode a model id. This string is uploaded to IPFS and minted
  // into immutable NFT metadata, so a stale id becomes permanent and public.
  model: resolveDefaultModel(),  // e.g. "<current-default-model>"
  version: "1.0.0"
};
```

### Step 2: Create Agent Metadata

```json
{
  "name": "Sperax DeFi Advisor",
  "description": "Expert for USDs, SPA, and Sperax Farms",
  "image": "ipfs://Qm.../agent-avatar.png",
  "external_url": "https://app.sperax.io/agents/defi-advisor",
  "attributes": [
    { "trait_type": "Category", "value": "DeFi" },
    { "trait_type": "Chain", "value": "Arbitrum" },
    { "trait_type": "Model", "value": "<current-default-model>" },
    { "trait_type": "Tools", "value": 12 },
    { "trait_type": "Reputation", "display_type": "number", "value": 0 }
  ],
  "properties": {
    "capabilities": ["portfolio-analysis", "yield-optimization"],
    "protocols": ["sperax", "aave", "uniswap"],
    "chains": ["arbitrum", "ethereum"]
  }
}
```

### Step 3: Upload Metadata to IPFS

```bash
# Using Pinata
curl -X POST https://api.pinata.cloud/pinning/pinJSONToIPFS \
  -H "Authorization: Bearer $PINATA_JWT" \
  -d @agent-metadata.json
```

### Step 4: Mint Agent NFT

```typescript
const tx = await factory.createAgent({
  metadataURI: "ipfs://QmAgentMetadataHash",
  owner: "0xYourAddress",
  chain: "arbitrum"
});

console.log(`Agent NFT minted: Token ID ${tx.tokenId}`);
console.log(`Transaction: ${tx.hash}`);
```

### Step 5: Register in Global Registry

```typescript
const registry = new AgentRegistry(provider);

await registry.register({
  tokenId: tx.tokenId,
  endpoint: "https://api.chat.sperax.io/agents/defi-advisor",
  mcpEndpoint: "https://mcp.chat.sperax.io/defi-advisor",
  publicKey: "0x...",  // Agent's signing key
  chains: [42161, 1]   // Arbitrum, Ethereum
});
```

### Step 6: Deploy Across Chains

ERC-8004 supports 12 chains:

| Chain | Chain ID | Status |
|-------|----------|--------|
| Ethereum | 1 | ✅ |
| Arbitrum | 42161 | ✅ |
| Base | 8453 | ✅ |
| Polygon | 137 | ✅ |
| Optimism | 10 | ✅ |
| BSC | 56 | ✅ |
| Avalanche | 43114 | ✅ |
| Fantom | 250 | ✅ |
| Gnosis | 100 | ✅ |
| zkSync | 324 | ✅ |
| Scroll | 534352 | ✅ |
| Linea | 59144 | ✅ |

```typescript
// Deploy to multiple chains
await factory.deployMultichain({
  tokenId: tx.tokenId,
  chains: [1, 42161, 8453, 56]
});
```

### Step 7: Build Reputation

```typescript
// Users submit feedback after agent interactions
await registry.submitFeedback({
  agentTokenId: 42,
  score: 5,           // 1-5 rating
  category: "accuracy",
  comment: "Excellent yield optimization advice"
});

// Check agent reputation
const rep = await registry.getReputation(42);
// { score: 4.8, totalReviews: 150, categories: {...} }
```

## Agent Lifecycle

```
Create Identity → Upload Metadata → Mint NFT → Register
    │                                                │
    │    ┌──────────────────────────────────────────┘
    │    │
    ▼    ▼
Deploy → Serve Users → Collect Feedback → Build Reputation
    │                                         │
    └──── Update Metadata ◄───────────────────┘
```

## SperaxOS Integration

ERC-8004 agents created through SperaxOS automatically:
- Get SperaxOS marketplace listing
- Receive the Sperax agent badge
- Can access all builtin tools
- Are indexed for discovery

## Links

- ERC-8004 Spec: https://erc8004.org
- EIP: https://eips.ethereum.org/EIPS/eip-8004
- Demo: https://github.com/nirholas/erc-8004-demo-agent
- Contracts: https://github.com/nirholas/erc-8004-contracts
- SperaxOS: https://app.sperax.io
