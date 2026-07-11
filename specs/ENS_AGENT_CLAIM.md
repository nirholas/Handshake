# ENS / DNS Agent Claim — v1

A convention for letting a domain prove it owns a three.ws (and vice versa). Bidirectional binding between human-readable names and on-chain agent identities.

## Why

ERC-8004 gives an agent a CAIP-10 reference. Humans don't memorize `eip155:8453:0x8004A169…/42`. Without a name binding, every "this is the official three.ws for example.com" claim is just an unverifiable assertion in a card.

This spec defines two records that are cheap to set, easy to verify, and require no new on-chain infrastructure.

## Forward record (name → agent)

### ENS

Set the text record `agent` on the ENS name:

```
agent = eip155:<chainId>:<registry>/<tokenId>
```

Example for `coachleo.eth`:

```
agent = eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/42
```

Multiple agents: comma-separated list, first entry is canonical.

### DNS (TXT)

For domains without ENS, publish a TXT record at `_agent.<domain>`:

```
_agent.example.com.  IN  TXT  "v=agent1; ref=eip155:8453:0x8004A169.../42"
```

Resolvers MUST treat the first valid `v=agent1` record as canonical and ignore others.

## Reverse record (agent → name)

The agent card SHOULD include a `claims` array pointing at the names that claim it:

```json
"claims": [
	{ "type": "ens",  "name": "coachleo.eth" },
	{ "type": "dns",  "name": "coachleo.com" }
]
```

A claim is **verified** only when both directions match:

- forward: the name's `agent` record contains the agent's CAIP ref.
- reverse: the agent card lists the name in `claims`.

Either direction alone is **unverified**. A consumer (resolver, badge, indexer) MUST display the trust state — verified, half-claim from name, half-claim from agent — distinctly. A half-claim is a useful discovery signal but not a trust signal.

## Resolver behavior

The HTTP resolver at [`/api/v1/agents/:caip`](../api/v1/agents/[caip].js) currently returns the on-chain agent record plus card-level verification:

```json
{
	"ref": "eip155:8453:0x…/42",
	"chainId": 8453,
	"agentId": "42",
	"registry": "0x…",
	"owner": "0x…",
	"tokenURI": "ipfs://…",
	"card": { "…": "the fetched agent card" },
	"verified": { "modelSha256": true, "cardSchema": "3d-agent-card-v1" },
	"fetchedAt": "2026-07-11T00:00:00.000Z"
}
```

Any `claims` array appears only inside `card` (verbatim from the agent card); the resolver does not yet verify it. As a future extension, the resolver SHOULD resolve the card's `claims` array and annotate each entry with a per-name `verified` flag (and a `reason` on failure), e.g. `{ "type": "ens", "name": "coachleo.eth", "verified": true }`. When implemented, verification is best-effort and time-bounded; failures are reported, not thrown.

## Adding `claims` to the v1 schema

Treat `claims` as an optional extension block (not yet in [3d-agent-card.schema.json](../public/.well-known/3d-agent-card.schema.json) v1.0). It will be promoted to v1.1 once at least one validator runs claim verification as part of the suite.

## Security notes

- A name binding is only as strong as the name's own custody. Compromise the ENS owner key → spoofed claims. Consumers SHOULD show the chain age of the binding (block of last `setText`) so a freshly-set `agent` record is treated with more skepticism.
- DNS bindings are weaker (DNS hijack vector). Treat ENS-verified above DNS-verified above unverified.
- Never auto-trust a one-sided claim. The bidirectional requirement defeats the easy attack of "I'll just put your domain in my card."

## Out of scope (v1)

- On-chain reverse resolver contract. The card-level `claims` array is sufficient until indexers want O(1) reverse lookup.
- Wildcard / subdomain claims (e.g. `*.example.com → agent`). Easy to add later.
