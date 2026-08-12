'use strict';

// Coverage for the network-free public surface of @three-ws/agent-protocol-sdk:
// exported on-chain limits, the program id, deterministic PDA derivation, and
// the client-side input validation in invokeSkill (which must fire before any
// transaction is built, so a stub connection is never touched).
//
// Runs against the built CJS output, mirroring the package's publish artifact.
// `pretest` builds dist via tsc.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicKey, Keypair } = require('@solana/web3.js');

const {
  deriveAgentPda,
  invokeSkill,
  IDL,
  AGENT_INVOCATION_PROGRAM_ID,
  MAX_SKILL_NAME_LEN,
  MAX_PARAMETERS_LEN,
} = require('../dist/index.js');

const AGENT_SEED = Buffer.from('agent');

test('exports the on-chain limits as the documented constants', () => {
  assert.equal(MAX_SKILL_NAME_LEN, 64);
  assert.equal(MAX_PARAMETERS_LEN, 512);
});

test('AGENT_INVOCATION_PROGRAM_ID is a valid base58 program id', () => {
  const pk = new PublicKey(AGENT_INVOCATION_PROGRAM_ID);
  assert.equal(pk.toBase58(), AGENT_INVOCATION_PROGRAM_ID);
});

test('IDL carries the invoke_skill instruction the SDK builds', () => {
  const names = (IDL.instructions || []).map((i) => i.name);
  assert.ok(names.includes('invoke_skill'), `invoke_skill missing from IDL (${names.join(',')})`);
});

test('deriveAgentPda matches the program seeds [b"agent", authority] and is deterministic', () => {
  const authority = Keypair.generate().publicKey;
  const [pda, bump] = deriveAgentPda(authority);

  const [expectedPda, expectedBump] = PublicKey.findProgramAddressSync(
    [AGENT_SEED, authority.toBuffer()],
    new PublicKey(AGENT_INVOCATION_PROGRAM_ID),
  );

  assert.equal(pda.toBase58(), expectedPda.toBase58());
  assert.equal(bump, expectedBump);

  // Deterministic: same authority → same PDA.
  const [again] = deriveAgentPda(authority);
  assert.equal(again.toBase58(), pda.toBase58());
});

test('deriveAgentPda honors a custom programId (e.g. a devnet deployment)', () => {
  const authority = Keypair.generate().publicKey;
  const altProgram = Keypair.generate().publicKey;

  const [defaultPda] = deriveAgentPda(authority);
  const [altPda] = deriveAgentPda(authority, altProgram);

  assert.notEqual(altPda.toBase58(), defaultPda.toBase58());

  const [expected] = PublicKey.findProgramAddressSync([AGENT_SEED, authority.toBuffer()], altProgram);
  assert.equal(altPda.toBase58(), expected.toBase58());
});

// invokeSkill validates inputs before constructing the provider/transaction, so
// these rejections never touch the network; the stub connection proves it.
const STUB_CONNECTION = {};

function baseParams(overrides) {
  return {
    connection: STUB_CONNECTION,
    invokerAuthority: Keypair.generate(),
    targetAuthority: Keypair.generate().publicKey,
    skillName: 'render',
    parameters: '{}',
    ...overrides,
  };
}

test('invokeSkill rejects an empty skillName', async () => {
  await assert.rejects(invokeSkill(baseParams({ skillName: '' })), /skillName must not be empty/);
});

test('invokeSkill rejects a skillName over the byte limit', async () => {
  await assert.rejects(
    invokeSkill(baseParams({ skillName: 'a'.repeat(MAX_SKILL_NAME_LEN + 1) })),
    /skillName exceeds 64 bytes/,
  );
});

test('invokeSkill enforces the limit in BYTES, not characters', async () => {
  // 20 rocket emoji = 40 UTF-16 units (String#length) but 80 UTF-8 bytes (>64).
  // A String#length check would wrongly accept this; the SDK must reject it.
  const multibyte = '\u{1F680}'.repeat(20);
  assert.ok(multibyte.length < MAX_SKILL_NAME_LEN, 'precondition: String#length under limit');
  assert.ok(Buffer.byteLength(multibyte, 'utf8') > MAX_SKILL_NAME_LEN, 'precondition: byte length over limit');
  await assert.rejects(invokeSkill(baseParams({ skillName: multibyte })), /skillName exceeds 64 bytes/);
});

test('invokeSkill rejects parameters over the byte limit', async () => {
  await assert.rejects(
    invokeSkill(baseParams({ parameters: 'x'.repeat(MAX_PARAMETERS_LEN + 1) })),
    /parameters exceed 512 bytes/,
  );
});
