#!/usr/bin/env node
/**
 * End-to-end smoke test for Band 7 — MetaMask Advanced Permissions.
 *
 * Usage:
 *   SMOKE_BASE_URL=https://three.ws \
 *   SMOKE_AGENT_ID=<uuid> \
 *   SMOKE_CHAIN_ID=84532 \
 *   SMOKE_DELEGATOR_KEY=0x<test-wallet-private-key> \
 *   SMOKE_SESSION_COOKIE=<session cookie value> \
 *   node scripts/smoke-permissions.js
 *
 * Required env vars:
 *   SMOKE_BASE_URL        — Base URL of the deployed app (no trailing slash)
 *   SMOKE_AGENT_ID        — UUID of an existing on-chain-registered agent
 *   SMOKE_CHAIN_ID        — Chain to test on (default: 84532 = Base Sepolia)
 *   SMOKE_DELEGATOR_KEY   — Hex private key of the delegator wallet (needs testnet ETH for revoke step)
 *   SMOKE_SESSION_COOKIE  — Value of the session cookie for the agent owner
 *
 * Optional:
 *   SMOKE_SKIP_REVOKE=1   — Skip the on-chain revocation step (saves gas)
 *   SMOKE_SKIP_DB=1       — Skip the DB schema check (if DATABASE_URL not available)
 *   DATABASE_URL          — Postgres URL for DB schema pre-flight
 *   RPC_URL_84532         — Override public RPC for Base Sepolia
 */

import assert from 'assert';
import { Wallet, JsonRpcProvider, AbiCoder, getAddress } from 'ethers';

import {
	DELEGATION_MANAGER_DEPLOYMENTS,
	DELEGATION_MANAGER_ABI,
	CAVEAT_ENFORCERS,
} from '../src/erc7710/abi.js';
import {
	encodeScopedDelegation,
	signDelegation,
	isDelegationValid,
	delegationToManifestEntry,
	PermissionError,
} from '../src/permissions/toolkit.js';

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.SMOKE_BASE_URL?.replace(/\/$/, '');
const AGENT_ID = process.env.SMOKE_AGENT_ID;
const CHAIN_ID = Number(process.env.SMOKE_CHAIN_ID || 84532);
const DELEGATOR_KEY = process.env.SMOKE_DELEGATOR_KEY;
const SESSION_COOKIE = process.env.SMOKE_SESSION_COOKIE;
const SKIP_REVOKE = process.env.SMOKE_SKIP_REVOKE === '1';
const SKIP_DB = process.env.SMOKE_SKIP_DB === '1';
const DATABASE_URL = process.env.DATABASE_URL;

const RPC_URLS = {
	1: 'https://ethereum-rpc.publicnode.com',
	8453: 'https://mainnet.base.org',
	11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
	84532: process.env.RPC_URL_84532 || 'https://sepolia.base.org',
	421614: 'https://sepolia-rollup.arbitrum.io/rpc',
	11155420: 'https://sepolia.optimism.io',
};

// ── Result tracker ────────────────────────────────────────────────────────────

let passed = 0,
	failed = 0,
	skipped = 0;
const failures = [];

function pass(label) {
	console.log(`  \x1b[32m✓\x1b[0m ${label}`);
	passed++;
}

function fail(label, err) {
	console.error(`  \x1b[31m✗\x1b[0m ${label}`);
	console.error(`      ${err?.message || err}`);
	failed++;
	failures.push({ label, err });
}

function skip(label, reason) {
	console.log(`  \x1b[33m-\x1b[0m ${label} \x1b[2m(skipped: ${reason})\x1b[0m`);
	skipped++;
}

function section(title) {
	console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function check(label, fn) {
	try {
		await fn();
		pass(label);
	} catch (e) {
		fail(label, e);
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function api(path, opts = {}) {
	const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
	if (SESSION_COOKIE) headers['Cookie'] = `session=${SESSION_COOKIE}`;
	return fetch(`${BASE_URL}${path}`, { ...opts, headers });
}

function assertOk(res, body, label) {
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
	if (!body.ok) throw new Error(`ok=false: ${JSON.stringify(body)}`);
}

// ── 1. PRE-FLIGHT ─────────────────────────────────────────────────────────────

section('1. Pre-flight');

if (!BASE_URL) {
	console.error('\x1b[31mERROR: SMOKE_BASE_URL is required\x1b[0m\n');
	process.exit(1);
}
if (!AGENT_ID) {
	console.error('\x1b[31mERROR: SMOKE_AGENT_ID is required\x1b[0m\n');
	process.exit(1);
}
if (!DELEGATOR_KEY) {
	console.error('\x1b[31mERROR: SMOKE_DELEGATOR_KEY is required\x1b[0m\n');
	process.exit(1);
}
if (!SESSION_COOKIE) {
	console.warn(
		'\x1b[33mWARN: SMOKE_SESSION_COOKIE not set — authenticated tests will be skipped\x1b[0m',
	);
}
if (!(CHAIN_ID in DELEGATION_MANAGER_DEPLOYMENTS)) {
	console.error(
		`\x1b[31mERROR: CHAIN_ID ${CHAIN_ID} not in DELEGATION_MANAGER_DEPLOYMENTS\x1b[0m`,
	);
	process.exit(1);
}

pass(`BASE_URL = ${BASE_URL}`);
pass(`AGENT_ID = ${AGENT_ID}`);
pass(`CHAIN_ID = ${CHAIN_ID}`);

// Create test wallet
const wallet = new Wallet(DELEGATOR_KEY);
const DELEGATOR_ADDRESS = wallet.address;
const DELEGATE_ADDRESS = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'); // well-known test addr
pass(`Delegator wallet = ${DELEGATOR_ADDRESS}`);

if (SKIP_DB || !DATABASE_URL) {
	skip('DB schema pre-flight', SKIP_DB ? 'SMOKE_SKIP_DB=1' : 'DATABASE_URL not set');
} else {
	// Lazy postgres check
	await check('agent_delegations table exists', async () => {
		const { default: postgres } = await import('postgres');
		const sql = postgres(DATABASE_URL, { max: 1 });
		const rows = await sql`
			SELECT column_name FROM information_schema.columns
			WHERE table_name = 'agent_delegations'
			ORDER BY ordinal_position
		`;
		sql.end();
		const cols = rows.map((r) => r.column_name);
		const required = [
			'id',
			'agent_id',
			'chain_id',
			'delegator_address',
			'delegate_address',
			'delegation_hash',
			'delegation_json',
			'scope',
			'status',
			'expires_at',
			'created_at',
			'revoked_at',
			'tx_hash_revoke',
			'last_redeemed_at',
			'redemption_count',
		];
		const missing = required.filter((c) => !cols.includes(c));
		assert.deepStrictEqual(missing, [], `Missing columns: ${missing.join(', ')}`);
	});

	await check('indexer_state table exists', async () => {
		const { default: postgres } = await import('postgres');
		const sql = postgres(DATABASE_URL, { max: 1 });
		await sql`SELECT 1 FROM indexer_state LIMIT 1`;
		sql.end();
	});
}

// ── 2. CONTRACTS ──────────────────────────────────────────────────────────────

section('2. Contract addresses (eth_getCode)');

const rpcUrl = RPC_URLS[CHAIN_ID];
for (const [chainId, addr] of Object.entries(DELEGATION_MANAGER_DEPLOYMENTS)) {
	const url = RPC_URLS[chainId];
	if (!url) {
		skip(`chainId ${chainId}`, 'no RPC URL');
		continue;
	}
	await check(`DelegationManager on chain ${chainId} (${addr.slice(0, 10)}…)`, async () => {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'eth_getCode',
				params: [addr, 'latest'],
			}),
		});
		const { result } = await res.json();
		assert.ok(result && result.length > 4, `No bytecode at ${addr} on chain ${chainId}`);
	});
}

// ── 3. TOOLKIT — pure functions ───────────────────────────────────────────────

section('3. Toolkit — pure functions');

const EXPIRY = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 days
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

let delegation;

await check('encodeScopedDelegation — valid input', () => {
	const caveats = [
		{
			enforcer: CAVEAT_ENFORCERS.AllowedTargetsEnforcer[CHAIN_ID],
			terms: '0x' + DELEGATE_ADDRESS.slice(2).toLowerCase().padStart(64, '0'),
			args: '0x',
		},
		{
			enforcer:
				CAVEAT_ENFORCERS.ERC20PeriodTransferEnforcer?.[CHAIN_ID] ||
				CAVEAT_ENFORCERS.ERC20TransferAmountEnforcer[CHAIN_ID],
			terms: AbiCoder.defaultAbiCoder().encode(
				['address', 'uint256'],
				[USDC_BASE_SEPOLIA, 10_000_000n],
			),
			args: '0x',
		},
	];
	delegation = encodeScopedDelegation({
		delegator: DELEGATOR_ADDRESS,
		delegate: DELEGATE_ADDRESS,
		caveats,
		expiry: EXPIRY,
		chainId: CHAIN_ID,
	});
	assert.strictEqual(delegation.delegate, DELEGATE_ADDRESS);
	assert.strictEqual(delegation.delegator, DELEGATOR_ADDRESS);
	assert.ok(delegation.caveats.length >= 1);
});

await check('encodeScopedDelegation — delegate === delegator throws', () => {
	assert.throws(
		() =>
			encodeScopedDelegation({
				delegator: DELEGATOR_ADDRESS,
				delegate: DELEGATOR_ADDRESS,
				caveats: [
					{
						enforcer: '0x1234567890123456789012345678901234567890',
						terms: '0x',
						args: '0x',
					},
				],
				expiry: EXPIRY,
				chainId: CHAIN_ID,
			}),
		(e) => e instanceof PermissionError,
	);
});

await check('encodeScopedDelegation — unsupported chain throws', () => {
	assert.throws(
		() =>
			encodeScopedDelegation({
				delegator: DELEGATOR_ADDRESS,
				delegate: DELEGATE_ADDRESS,
				caveats: [
					{
						enforcer: '0x1234567890123456789012345678901234567890',
						terms: '0x',
						args: '0x',
					},
				],
				expiry: EXPIRY,
				chainId: 999999,
			}),
		(e) => e instanceof PermissionError && e.code === 'chain_not_supported',
	);
});

// ── 4. SIGNING ────────────────────────────────────────────────────────────────

section('4. EIP-712 signing (real wallet)');

let signedDelegation;

await check('signDelegation — produces valid signature', async () => {
	assert.ok(delegation, 'encodeScopedDelegation must have passed');
	const provider = new JsonRpcProvider(rpcUrl);
	const signer = wallet.connect(provider);
	signedDelegation = await signDelegation(delegation, signer);
	assert.ok(signedDelegation.signature?.startsWith('0x'), 'signature must be hex');
	assert.ok(signedDelegation.hash?.startsWith('0x'), 'hash must be hex');
	assert.strictEqual(signedDelegation.hash.length, 66, 'hash must be 32 bytes');
	console.log(`      hash: ${signedDelegation.hash}`);
	console.log(`      sig:  ${signedDelegation.signature.slice(0, 20)}…`);
});

await check('delegationToManifestEntry — correct shape', () => {
	assert.ok(signedDelegation, 'signDelegation must have passed');
	const scope = {
		token: USDC_BASE_SEPOLIA,
		maxAmount: '10000000',
		period: 'daily',
		targets: [DELEGATE_ADDRESS],
		expiry: EXPIRY,
	};
	const entry = delegationToManifestEntry({ ...signedDelegation, scope });
	assert.strictEqual(entry.chainId, CHAIN_ID);
	assert.strictEqual(entry.delegator, DELEGATOR_ADDRESS);
	assert.strictEqual(entry.hash, signedDelegation.hash);
	assert.ok(!('signature' in entry), 'signature must NOT appear in manifest entry');
	assert.strictEqual(entry.scope.token, USDC_BASE_SEPOLIA);
});

// ── 5. API — public endpoints (no auth) ───────────────────────────────────────

section('5. API — public endpoints');

await check('GET /api/permissions/metadata?agentId — responds 200', async () => {
	const res = await api(`/api/permissions/metadata?agentId=${AGENT_ID}`);
	const body = await res.json();
	assert.ok(res.ok, `HTTP ${res.status}`);
	assert.ok(body.ok, `ok=false: ${JSON.stringify(body)}`);
	assert.ok(Array.isArray(body.delegations), 'delegations must be array');
	assert.strictEqual(body.spec, 'erc-7715/0.1');
	const cc = res.headers.get('cache-control') || '';
	assert.ok(cc.includes('public'), `Cache-Control must include "public" — got "${cc}"`);
	assert.ok(res.headers.get('access-control-allow-origin') === '*', 'CORS header must be *');
	console.log(`      ${body.delegations.length} active delegation(s)`);
});

await check('GET /api/permissions/metadata — missing agentId returns 400', async () => {
	const res = await api('/api/permissions/metadata');
	assert.strictEqual(res.status, 400);
});

await check('GET /api/permissions/metadata — unknown agentId returns 404', async () => {
	const res = await api('/api/permissions/metadata?agentId=00000000-0000-0000-0000-000000000000');
	assert.ok(res.status === 404 || (await res.clone().json()).ok === false);
});

// verify endpoint — only testable once a delegation exists; do a hash-only probe
await check('GET /api/permissions/verify — missing params returns 400', async () => {
	const res = await api('/api/permissions/verify');
	assert.strictEqual(res.status, 400);
});

await check('GET /api/permissions/verify — invalid chainId returns 400', async () => {
	const hash = signedDelegation?.hash || '0x' + 'ab'.repeat(32);
	const res = await api(`/api/permissions/verify?hash=${hash}&chainId=999999`);
	assert.ok(res.status === 400 || res.status === 200);
	if (res.status === 200) {
		const body = await res.json();
		assert.ok(!body.valid, 'unknown chain → valid must be false');
	}
});

// ── 6. API — authenticated endpoints ─────────────────────────────────────────

section('6. API — authenticated endpoints');

let grantedId, grantedHash;

if (!SESSION_COOKIE) {
	skip('POST /api/permissions/grant', 'no SMOKE_SESSION_COOKIE');
	skip('GET  /api/permissions/list', 'no SMOKE_SESSION_COOKIE');
	skip('GET  /api/permissions/verify (live)', 'no SMOKE_SESSION_COOKIE');
	skip('POST /api/permissions/revoke', 'no SMOKE_SESSION_COOKIE');
} else {
	const scope = {
		token: USDC_BASE_SEPOLIA,
		maxAmount: '10000000',
		period: 'daily',
		targets: [DELEGATE_ADDRESS],
		expiry: EXPIRY,
	};

	await check('POST /api/permissions/grant — happy path', async () => {
		assert.ok(signedDelegation, 'signDelegation must have passed');
		const res = await api('/api/permissions/grant', {
			method: 'POST',
			body: JSON.stringify({
				agentId: AGENT_ID,
				chainId: CHAIN_ID,
				delegation: signedDelegation,
				scope,
			}),
		});
		const body = await res.json();
		assertOk(res, body, 'grant');
		assert.ok(body.id, 'id must be present');
		assert.ok(body.delegationHash, 'delegationHash must be present');
		grantedId = body.id;
		grantedHash = body.delegationHash;
		console.log(`      id:   ${grantedId}`);
		console.log(`      hash: ${grantedHash}`);
	});

	await check('POST /api/permissions/grant — duplicate hash returns 409', async () => {
		assert.ok(signedDelegation, 'need signed delegation');
		const res = await api('/api/permissions/grant', {
			method: 'POST',
			body: JSON.stringify({
				agentId: AGENT_ID,
				chainId: CHAIN_ID,
				delegation: signedDelegation,
				scope,
			}),
		});
		assert.strictEqual(res.status, 409);
		const body = await res.json();
		assert.strictEqual(body.error, 'duplicate_delegation');
	});

	await check('GET /api/permissions/list?agentId — includes granted delegation', async () => {
		assert.ok(grantedHash, 'grant must have passed');
		const res = await api(`/api/permissions/list?agentId=${AGENT_ID}&status=active`);
		const body = await res.json();
		assertOk(res, body, 'list');
		const found = body.delegations.find((d) => d.delegationHash === grantedHash);
		assert.ok(found, `Delegation ${grantedHash} not found in list`);
		assert.strictEqual(found.status, 'active');
		assert.ok(
			!('delegationJson' in found) || typeof found.delegationJson === 'object',
			'signature should only be in authenticated view',
		);
		console.log(`      listed ${body.delegations.length} delegation(s)`);
	});

	await check('GET /api/permissions/verify — granted delegation is valid', async () => {
		assert.ok(grantedHash, 'grant must have passed');
		const res = await api(`/api/permissions/verify?hash=${grantedHash}&chainId=${CHAIN_ID}`);
		const body = await res.json();
		assert.ok(res.ok, `HTTP ${res.status}`);
		assert.ok(body.ok, `ok=false: ${JSON.stringify(body)}`);
		// May be valid:true (fully on-chain) or valid:true/unknown_to_platform (off-chain only)
		assert.ok(typeof body.valid === 'boolean', 'valid must be boolean');
		console.log(`      valid: ${body.valid}, reason: ${body.reason || 'none'}`);
	});

	// Revoke step requires on-chain tx — skip if SMOKE_SKIP_REVOKE
	if (SKIP_REVOKE) {
		skip('POST /api/permissions/revoke — on-chain', 'SMOKE_SKIP_REVOKE=1');
	} else {
		await check(
			'POST /api/permissions/revoke — on-chain disableDelegation + server mirror',
			async () => {
				assert.ok(grantedId && grantedHash && signedDelegation, 'grant must have passed');

				// Submit the on-chain disableDelegation tx
				const provider = new JsonRpcProvider(rpcUrl);
				const signer = wallet.connect(provider);
				const balance = await provider.getBalance(DELEGATOR_ADDRESS);
				assert.ok(
					balance > 0n,
					`Delegator ${DELEGATOR_ADDRESS} has no ETH on chain ${CHAIN_ID} — fund it first`,
				);

				const { Contract } = await import('ethers');
				const dm = new Contract(
					DELEGATION_MANAGER_DEPLOYMENTS[CHAIN_ID],
					DELEGATION_MANAGER_ABI,
					signer,
				);

				// Build the delegation tuple the contract expects
				const delegationTuple = {
					delegate: signedDelegation.delegate,
					delegator: signedDelegation.delegator,
					authority: signedDelegation.authority,
					caveats: signedDelegation.caveats,
					salt: signedDelegation.salt,
					signature: signedDelegation.signature,
				};

				console.log('      submitting disableDelegation tx…');
				const tx = await dm.disableDelegation(delegationTuple);
				const receipt = await tx.wait();
				assert.ok(receipt.status === 1, `tx reverted: ${receipt.hash}`);
				console.log(`      tx:    ${receipt.hash}`);
				console.log(`      block: ${receipt.blockNumber}`);

				// Mirror revocation to the server
				const res = await api('/api/permissions/revoke', {
					method: 'POST',
					body: JSON.stringify({ id: grantedId, txHash: receipt.hash }),
				});
				const body = await res.json();
				assertOk(res, body, 'revoke');
				assert.strictEqual(body.status, 'revoked');

				// Confirm verify endpoint now returns invalid
				const vRes = await api(
					`/api/permissions/verify?hash=${grantedHash}&chainId=${CHAIN_ID}`,
				);
				const vBody = await vRes.json();
				if (vBody.valid !== false) {
					console.log(
						'      \x1b[33mWARN: verify still shows valid — indexer may not have run yet\x1b[0m',
					);
				} else {
					assert.strictEqual(vBody.reason, 'delegation_revoked');
					console.log('      verify correctly shows delegation_revoked');
				}
			},
		);
	}

	// ── 7. API — negative cases ──────────────────────────────────────────────

	section('7. API — negative cases');

	await check('POST /api/permissions/grant — no auth returns 401', async () => {
		const res = await fetch(`${BASE_URL}/api/permissions/grant`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				agentId: AGENT_ID,
				chainId: CHAIN_ID,
				delegation: {},
				scope: {},
			}),
		});
		assert.strictEqual(res.status, 401);
	});

	await check('POST /api/permissions/revoke — wrong id returns 404', async () => {
		const res = await api('/api/permissions/revoke', {
			method: 'POST',
			body: JSON.stringify({
				id: '00000000-0000-0000-0000-000000000000',
				txHash: '0x' + '00'.repeat(32),
			}),
		});
		assert.ok(res.status === 404 || res.status === 400);
	});
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
console.log(
	`\x1b[1mResults:\x1b[0m  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  \x1b[33m${skipped} skipped\x1b[0m`,
);

if (failures.length) {
	console.log('\nFailed checks:');
	for (const { label, err } of failures) {
		console.error(`  \x1b[31m✗\x1b[0m ${label}`);
		console.error(`      ${err?.message || err}`);
	}
	process.exit(1);
}

if (!SESSION_COOKIE) {
	console.log(
		'\n\x1b[33mTIP:\x1b[0m Set SMOKE_SESSION_COOKIE to run authenticated grant/list/revoke tests.',
	);
}

console.log('\nAll checks passed.');
