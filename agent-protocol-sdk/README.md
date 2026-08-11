<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/agent-protocol-sdk</h1>

<p align="center"><strong>Record verifiable agent-to-agent skill invocations on Solana, via the <code>agent_invocation</code> Anchor program.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/agent-protocol-sdk"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/agent-protocol-sdk?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/agent-protocol-sdk"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/agent-protocol-sdk?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/agent-protocol-sdk?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/agent-protocol-sdk?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#requirements">Requirements</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> Thin, typed client for the `agent_invocation` Solana program. One agent calls a
> skill on another agent; the call is validated client-side, built as an Anchor
> instruction, and submitted on-chain, where it emits a `SkillInvoked` event that
> anyone can verify. Built for three.ws agent-to-agent (A2A) coordination.

> **Program id, and where it stands.** `AGENT_INVOCATION_PROGRAM_ID` is
> [`AgEntJDMi1A7UadCoYcx6Fm3gusNk8SHLCi7vSUa4Zfo`](https://explorer.solana.com/address/AgEntJDMi1A7UadCoYcx6Fm3gusNk8SHLCi7vSUa4Zfo),
> the id baked into the program's `declare_id!` and therefore the same on every
> cluster. As of 2026-08-11 that account is **not yet deployed** on mainnet-beta
> or devnet: `invokeSkill` builds and signs a correct instruction, and the
> cluster rejects it until the program is published. Verify before you build on
> it (`solana account AgEntJDMi1A7UadCoYcx6Fm3gusNk8SHLCi7vSUa4Zfo`, or run
> `node scripts/onchain-smoke.mjs --only=solana-invoke` in the repo, which probes
> the cluster and reports the current state). Build and deploy instructions are
> in
> [`contracts/agent-invocation/README.md`](https://github.com/nirholas/three.ws/blob/main/contracts/agent-invocation/README.md).
> Once it is live, point `connection` at the cluster you want; the `programId`
> param stays optional and is only needed to target a different deployment.

## Install

```bash
npm install @three-ws/agent-protocol-sdk @solana/web3.js @coral-xyz/anchor
```

`@solana/web3.js` (`^1.98`) and `@coral-xyz/anchor` (`^0.32`) are direct
dependencies and are installed alongside the package.

## Quick start

```ts
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { invokeSkill } from '@three-ws/agent-protocol-sdk';

// mainnet-beta by default; use 'https://api.devnet.solana.com' for devnet.
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const invokerAuthority = Keypair.fromSecretKey(/* your secret key bytes */);
const targetAuthority = new PublicKey('<authority that owns the target agent>');

const signature = await invokeSkill({
  connection,
  invokerAuthority,                       // signs + pays
  targetAuthority,                        // target agent PDA is derived from this
  skillName: 'summarize',                 // 1–64 bytes
  parameters: JSON.stringify({ url: 'https://example.com' }), // ≤512 bytes
  // programId is optional; it defaults to AGENT_INVOCATION_PROGRAM_ID.
});

console.log('invocation tx:', signature);
```

`invokeSkill` validates the inputs, derives both the invoker and target agent
PDAs, builds the `invoke_skill` instruction, submits it, and returns the
confirmed transaction signature.

## API

### `invokeSkill(params): Promise<string>`

Records a skill invocation from one agent to another and returns the confirmed
transaction signature.

| Param | Type | Description |
| --- | --- | --- |
| `connection` | `Connection` | Live Solana connection used to build and send the tx. |
| `invokerAuthority` | `Keypair` | Owns the invoking agent. Signs and pays. |
| `targetAuthority` | `PublicKey` | Owns the target agent; its PDA is re-derived from this. |
| `skillName` | `string` | Skill identifier, 1–64 bytes (UTF-8). |
| `parameters` | `string` | Opaque parameter blob, ≤512 bytes (typically JSON). |
| `programId` | `PublicKey` *(optional)* | Override the program id. Required on any live cluster. |

Throws if `skillName` is empty, `skillName` exceeds `MAX_SKILL_NAME_LEN` bytes,
or `parameters` exceeds `MAX_PARAMETERS_LEN` bytes — so you get a clear local
error instead of a failed on-chain simulation.

### `deriveAgentPda(authority, programId?): [PublicKey, number]`

Derives an agent's program-derived address from the authority that owns it.
Matches the program's `seeds = [b"agent", authority]`. Pass your deployed
`programId` to derive against a live cluster; otherwise it uses
`AGENT_INVOCATION_PROGRAM_ID`.

```ts
import { deriveAgentPda } from '@three-ws/agent-protocol-sdk';

const [agentPda, bump] = deriveAgentPda(authority, programId);
```

### Constants & types

| Export | Type | Value / meaning |
| --- | --- | --- |
| `MAX_SKILL_NAME_LEN` | `number` | `64` — max `skillName` length in bytes. |
| `MAX_PARAMETERS_LEN` | `number` | `512` — max `parameters` length in bytes. |
| `AGENT_INVOCATION_PROGRAM_ID` | `string` | The program's `declare_id!` (`AgEnt…Zfo`), same on every cluster. |
| `IDL` | Anchor `Idl` | The `agent_invocation` IDL (Anchor 0.30+ format). |
| `AgentInvocation` | `type` | TypeScript type of `IDL` for `new Program<AgentInvocation>(...)`. |
| `InvokeSkillParams` | `interface` | Parameter shape for `invokeSkill`. |

### On-chain shape

The program exposes one instruction, `invoke_skill(skill_name, parameters)`, over
four accounts (`invoker_agent` PDA, `invoker_authority` signer, `target_authority`,
`target_agent` PDA) plus the system program. A successful call emits a
`SkillInvoked` event with `invoker_agent`, `target_agent`, `invoker_authority`,
`skill_name`, `parameters`, and a `timestamp`. The program's error codes
(`EmptySkillName`, `SkillNameTooLong`, `ParametersTooLong`) mirror the client-side
validation above.

## Requirements

- **Node** `>= 18`.
- **Peers / deps:** `@solana/web3.js@^1.98`, `@coral-xyz/anchor@^0.32`.
- **A funded invoker.** `invokerAuthority` signs and pays the transaction fee, so
  it needs a small SOL balance on the target cluster.
- **A deployed program.** `AGENT_INVOCATION_PROGRAM_ID` is not on-chain yet (see
  the note at the top); until it is, submitting an invocation fails at the
  cluster. Check the account before you depend on it.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0 — see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
