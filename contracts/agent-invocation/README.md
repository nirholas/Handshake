# agent_invocation: verifiable agent-to-agent skill invocations (Solana / Anchor)

When one three.ws agent calls a skill on another agent, this program records
that call on-chain as a **verifiable event**. Anyone can replay the transaction
log and prove who invoked what, on whom, with which parameters, and when,
without trusting our database or either agent's own claims.

```
agent A (signer) --> invoke_skill("summarize", params) --> SkillInvoked event
                          |
                          +-- invoker_agent PDA  ["agent", A]  (proves A is A)
                          +-- target_agent  PDA  ["agent", B]  (proves B exists)
```

The program is intentionally non-trust-bearing: it moves no funds and grants no
capability. Its single job is identity-checked event emission, which makes it
the audit rail under three.ws agent-to-agent (A2A) coordination. This is the
"On-chain agent invocation" surface in [STRUCTURE.md](../../STRUCTURE.md); the
published client is [`@three-ws/agent-protocol-sdk`](../../agent-protocol-sdk/README.md).

Program id (same on every cluster, baked into `declare_id!`):
**[`AgEntJDMi1A7UadCoYcx6Fm3gusNk8SHLCi7vSUa4Zfo`](https://explorer.solana.com/address/AgEntJDMi1A7UadCoYcx6Fm3gusNk8SHLCi7vSUa4Zfo)**

## Agent identity: PDAs, not registrations

An agent's on-chain identity is a program-derived address, computed from the
wallet that controls it:

| Account | Seeds | Notes |
|---|---|---|
| `invoker_agent` | `["agent", invoker_authority]` | Re-derived and verified by Anchor `seeds`/`bump` constraints. The authority must sign, so a caller can only ever act as their own agent. |
| `target_agent` | `["agent", target_authority]` | Same derivation for the target. The target authority does not sign; only its pubkey is needed to re-derive the PDA. |

Because both agent accounts are constrained PDAs rather than raw `AccountInfo`,
an attacker cannot substitute an arbitrary account and have downstream
consumers trust it. There is no registration instruction and no rent: the PDA
derivation itself is the identity scheme. The SDK mirrors it in
[`deriveAgentPda`](../../agent-protocol-sdk/src/index.ts).

## Instructions

| Instruction | Signer | Effect |
|---|---|---|
| `invoke_skill(skill_name, parameters)` | `invoker_authority` | Validates lengths, verifies both agent PDAs, and emits a `SkillInvoked` event. No state is written. |

Limits enforced on-chain (and re-checked client-side by the SDK):
`skill_name` is 1 to 64 bytes, `parameters` is at most 512 bytes (typically a
JSON blob). Violations fail with `EmptySkillName`, `SkillNameTooLong`, or
`ParametersTooLong` from the program's `InvocationError` enum.

## The `SkillInvoked` event

Emitted via Anchor `emit!`, decodable with `anchor.EventParser` and the IDL:

| Field | Type | Meaning |
|---|---|---|
| `invoker_agent` | `Pubkey` | PDA of the calling agent |
| `target_agent` | `Pubkey` | PDA of the agent whose skill was invoked |
| `invoker_authority` | `Pubkey` | Wallet that signed the invocation |
| `skill_name` | `String` | Skill identifier (max 64 bytes) |
| `parameters` | `String` | Opaque parameter blob (max 512 bytes) |
| `timestamp` | `i64` | Cluster unix time at emission |

The hand-maintained IDL lives at
[`../idl/agent_invocation.json`](../idl/agent_invocation.json), kept in sync
with [`src/lib.rs`](src/lib.rs) and shipped inside the SDK as its `IDL` export.

## Usage

Most callers should not build instructions by hand; use the SDK:

```bash
npm install @three-ws/agent-protocol-sdk @solana/web3.js @coral-xyz/anchor
```

This example is the core of the devnet smoke test
([`scripts/agent-invocation-smoke.mjs`](../../scripts/agent-invocation-smoke.mjs)),
which runs it end-to-end against the live program and asserts every event field:

```js
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { invokeSkill, deriveAgentPda } from '@three-ws/agent-protocol-sdk';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

const invokerAuthority = Keypair.generate(); // must hold SOL; it signs and pays the fee
const targetAuthority = Keypair.generate().publicKey; // wallet owning the target agent

// The PDAs that will appear in the emitted event.
const [invokerAgent] = deriveAgentPda(invokerAuthority.publicKey);
const [targetAgent] = deriveAgentPda(targetAuthority);

const signature = await invokeSkill({
  connection,
  invokerAuthority,
  targetAuthority,
  skillName: 'summarize',
  parameters: JSON.stringify({ url: 'https://three.ws', lang: 'en' }),
});

console.log(`SkillInvoked: ${invokerAgent} -> ${targetAgent}`);
console.log(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
```

`invokeSkill` validates the length limits locally, derives both PDAs, builds
the `invoke_skill` instruction, and returns the confirmed signature. Pass
`programId` only when targeting a deployment other than the default id above.

## Build, test, deploy

The crate is a self-contained Cargo workspace (see [Cargo.toml](Cargo.toml)),
so builds here never walk up into an unrelated parent workspace:

```bash
anchor build                              # compile + verify against the IDL
anchor deploy --provider.cluster devnet   # program keypair = declare_id
anchor run smoke                          # devnet smoke test (defined in Anchor.toml)
```

The smoke test funds a fresh synthetic invoker (devnet airdrop, or a
`SMOKE_FUNDER_KEYPAIR` payer on other clusters), submits a real
`invoke_skill`, then parses the transaction logs and asserts each
`SkillInvoked` field matches what was sent. It exits non-zero on any mismatch.
Cluster config, program ids per cluster, and the deploy wallet path are in
[Anchor.toml](Anchor.toml); the deploy authority keypair is kept out of the
repo (Secret Manager: `AGENT_INVOCATION_DEPLOY_AUTHORITY`).

## Related surfaces

- [`agent-protocol-sdk/`](../../agent-protocol-sdk/README.md): the npm client
  (`invokeSkill`, `deriveAgentPda`, `IDL`, `AGENT_INVOCATION_PROGRAM_ID`,
  `MAX_SKILL_NAME_LEN`, `MAX_PARAMETERS_LEN`).
- [`../skill-license/`](../skill-license/README.md): sibling Anchor program
  minting on-chain skill-ownership NFTs; it follows this program's IDL
  convention.
- [`../README.md`](../README.md): the EVM contracts that share this
  `contracts/` directory.
