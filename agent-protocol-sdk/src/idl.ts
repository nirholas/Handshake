// IDL for the `agent_invocation` Anchor program, kept in sync by hand with
// contracts/agent-invocation/src/lib.rs. Anchor 0.30+ IDL format (carries its
// own `address` + `metadata` and per-instruction discriminators).
//
// The `address` below is the program's `declare_id!`, so it is the same id on
// every cluster. It is not deployed yet (see the README): submitting against it
// fails at the cluster until the program is published. Override it with
// `invokeSkill({ programId })` to target a different deployment.

import type { Idl } from '@coral-xyz/anchor';

export const AGENT_INVOCATION_PROGRAM_ID = 'AgEntJDMi1A7UadCoYcx6Fm3gusNk8SHLCi7vSUa4Zfo';

export const IDL = {
  address: AGENT_INVOCATION_PROGRAM_ID,
  metadata: {
    name: 'agent_invocation',
    version: '0.2.0',
    spec: '0.1.0',
    description: 'Verifiable agent-to-agent skill invocation on Solana.',
  },
  instructions: [
    {
      name: 'invoke_skill',
      discriminator: [141, 69, 221, 241, 163, 138, 14, 221],
      accounts: [
        {
          name: 'invoker_agent',
          docs: ['The invoking agent PDA, derived from the invoker authority.'],
          pda: {
            seeds: [
              { kind: 'const', value: [97, 103, 101, 110, 116] },
              { kind: 'account', path: 'invoker_authority' },
            ],
          },
        },
        { name: 'invoker_authority', signer: true },
        { name: 'target_authority' },
        {
          name: 'target_agent',
          docs: ['The target agent PDA, derived from the target authority.'],
          pda: {
            seeds: [
              { kind: 'const', value: [97, 103, 101, 110, 116] },
              { kind: 'account', path: 'target_authority' },
            ],
          },
        },
        { name: 'system_program', address: '11111111111111111111111111111111' },
      ],
      args: [
        { name: 'skill_name', type: 'string' },
        { name: 'parameters', type: 'string' },
      ],
    },
  ],
  events: [
    {
      name: 'SkillInvoked',
      discriminator: [232, 117, 249, 195, 117, 36, 59, 8],
    },
  ],
  errors: [
    { code: 6000, name: 'EmptySkillName', msg: 'skill_name must not be empty' },
    { code: 6001, name: 'SkillNameTooLong', msg: 'skill_name exceeds the maximum allowed length' },
    { code: 6002, name: 'ParametersTooLong', msg: 'parameters exceed the maximum allowed length' },
  ],
  types: [
    {
      name: 'SkillInvoked',
      type: {
        kind: 'struct',
        fields: [
          { name: 'invoker_agent', type: 'pubkey' },
          { name: 'target_agent', type: 'pubkey' },
          { name: 'invoker_authority', type: 'pubkey' },
          { name: 'skill_name', type: 'string' },
          { name: 'parameters', type: 'string' },
          { name: 'timestamp', type: 'i64' },
        ],
      },
    },
  ],
} as const satisfies Idl;

export type AgentInvocation = typeof IDL;
