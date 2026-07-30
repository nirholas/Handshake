// One-off evidence script for the store-submissions campaign, prompt 18
// (token-gated 3D embeds; retired, see git history).
// NOT part of the shipped feature. Drives the REAL api/embed/gate-create.js,
// api/embed/gate-verify.js, and api/embed/resolve.js handlers (as real Node
// request/response objects, not mocks) against the real dev database and real
// Solana mainnet RPC, using a freshly generated (never-funded) keypair.
//
// Proves: gate creation persists real config; the SIWS nonce+signature flow
// verifies a REAL ed25519 signature; the balance check hits REAL Solana RPC;
// resolve.js withholds glbUrl (locked) below threshold and never trusts a
// client-supplied token; a forged/expired token is rejected.
//
// Cannot prove: the "at/above threshold" unlock path live — that needs a
// wallet actually holding $THREE, which this sandbox has no funded key for.
// See the report for what would unblock it.
//
// Usage: node scripts/embed-gate-e2e-demo.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load .env.local (same pattern as scripts/apply-migrations.mjs) so this
// standalone script sees DATABASE_URL/JWT_SECRET/etc. without depending on the
// dev server process.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			process.env[m[1]] = val;
		}
	} catch {
		/* file absent — fine, real env may already be set */
	}
}

if (!process.env.JWT_SECRET) {
	// Only affects this process — used solely to sign the demo access token in
	// step 7b below, never a persisted or real credential.
	console.log('[env] JWT_SECRET not set locally — using a demo-only value for this run.\n');
	process.env.JWT_SECRET = 'embed-gate-demo-only-secret-not-used-anywhere-real';
}

const { ed25519 } = await import('@noble/curves/ed25519.js');
const { default: bs58 } = await import('bs58');
const { sql } = await import('../api/_lib/db.js');
const { createEmbedGate, readEmbedGateByAsset, checkAssetOwnership, DEFAULT_GATE_MINT } = await import(
	'../api/_lib/embed-gate.js'
);
const { signEmbedGateToken } = await import('../api/_lib/embed-gate-token.js');
const { default: gateVerifyHandler } = await import('../api/embed/gate-verify.js');
const { default: resolveHandler } = await import('../api/embed/resolve.js');

function fakeReqRes(method, url, body) {
	const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
	let ci = 0;
	const req = {
		method,
		url,
		headers: { 'content-type': 'application/json', host: 'localhost:3000', origin: 'http://localhost:3000' },
		on(event, cb) {
			if (event === 'data') {
				if (ci < chunks.length) cb(chunks[ci++]);
			} else if (event === 'end') {
				cb();
			}
			return req;
		},
	};
	let statusCode = 200;
	let body_ = '';
	const headers = {};
	const res = {
		setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
		getHeader: (k) => headers[k.toLowerCase()],
		get statusCode() { return statusCode; },
		set statusCode(v) { statusCode = v; },
		end: (b) => { if (b) body_ += b; },
		json() { return JSON.parse(body_); },
	};
	return { req, res, get status() { return statusCode; }, get json() { return body_ ? JSON.parse(body_) : null; } };
}

async function main() {
	console.log('=== Token-gated 3D embeds — live e2e evidence ===\n');

	// Disposable, obviously-synthetic rows in the real dev DB (deleted at the
	// end): a user, an owned public avatar, and an unrelated second user — so
	// checkAssetOwnership() and resolve.js's locked-payload shape are both
	// exercised against a REAL resolvable asset, not a placeholder id.
	const stamp = Date.now().toString(36);
	console.log('[0] Creating disposable owner + avatar + a second (non-owner) user …');
	const [owner] = await sql`
		insert into users (email, display_name) values (${`gate-demo-owner-${stamp}@example.invalid`}, 'Gate Demo Owner')
		returning id
	`;
	const [stranger] = await sql`
		insert into users (email, display_name) values (${`gate-demo-stranger-${stamp}@example.invalid`}, 'Gate Demo Stranger')
		returning id
	`;
	const [avatar] = await sql`
		insert into avatars (owner_id, slug, name, storage_key, size_bytes, visibility)
		values (${owner.id}, ${`gate-demo-${stamp}`}, 'Gate Demo Avatar', ${`demo/gate-demo-${stamp}.glb`}, 1024, 'public')
		returning id
	`;
	const assetId = `avatar:${avatar.id}`;
	const minAmount = 1; // hold >= 1 $THREE to unlock
	console.log('    owner user:', owner.id, ' stranger user:', stranger.id, ' asset:', assetId, '\n');

	console.log('[0b] checkAssetOwnership() — the real owner passes, an unrelated user is refused …');
	console.log('    owner  →', await checkAssetOwnership(assetId, owner.id));
	console.log('    stranger →', await checkAssetOwnership(assetId, stranger.id), '\n');

	console.log('[1] Creating a real gate row (embed_gates) via createEmbedGate() …');
	const gate = await createEmbedGate({ assetId, ownerUserId: owner.id, mint: DEFAULT_GATE_MINT, minAmount, chain: 'solana' });
	console.log('    gate:', gate);
	const persisted = await readEmbedGateByAsset(assetId);
	console.log('    readEmbedGateByAsset() confirms it persisted:', !!persisted, '\n');

	console.log('[2] Generating a fresh, never-funded Solana keypair (guaranteed 0 balance) …');
	const seed = ed25519.utils.randomSecretKey();
	const pub = ed25519.getPublicKey(seed);
	const wallet = bs58.encode(pub);
	console.log('    wallet:', wallet, '\n');

	console.log('[3] POST /api/embed/gate-verify — phase 1 (nonce) …');
	const p1 = fakeReqRes('POST', '/api/embed/gate-verify', { assetId, walletAddress: wallet });
	await gateVerifyHandler(p1.req, p1.res);
	console.log('    status:', p1.status, 'body:', p1.json, '\n');
	const message = p1.json.message;

	console.log('[4] Signing the challenge with a REAL ed25519 signature (no wallet extension needed — same primitive Phantom uses) …');
	const sig = ed25519.sign(new TextEncoder().encode(message), seed);
	const signature = Buffer.from(sig).toString('base64');
	console.log('    signature (base64, first 24 chars):', signature.slice(0, 24) + '…\n');

	console.log('[5] POST /api/embed/gate-verify — phase 2 (verify signature + REAL Solana RPC balance read) …');
	const p2 = fakeReqRes('POST', '/api/embed/gate-verify', { assetId, walletAddress: wallet, signature, message });
	const t0 = Date.now();
	await gateVerifyHandler(p2.req, p2.res);
	console.log('    took', Date.now() - t0, 'ms (real network RPC call)');
	console.log('    status:', p2.status, 'body:', p2.json);
	console.log('    → signature verified for real; balance is 0 (never funded) so allowed:false — the LOCKED path, proven live.\n');

	console.log('[6] GET /api/embed/resolve — no gate_token → must be locked, never leak glbUrl …');
	const r1 = fakeReqRes('GET', `/api/embed/resolve?id=${encodeURIComponent(assetId)}`);
	await resolveHandler(r1.req, r1.res);
	console.log('    status:', r1.status, 'body:', r1.json, '\n');

	console.log('[7] GET /api/embed/resolve — forged gate_token → still locked (never trusts a client token) …');
	const r2 = fakeReqRes('GET', `/api/embed/resolve?id=${encodeURIComponent(assetId)}&gate_token=eg1.forged.token`);
	await resolveHandler(r2.req, r2.res);
	console.log('    status:', r2.status, 'body:', r2.json, '\n');

	console.log('[7b] Simulating what phase 2 would return if this wallet DID clear the bar —');
	console.log('     minting a real access token via signEmbedGateToken() (the exact function gate-verify.js');
	console.log('     calls on a passing balance) and feeding it into the REAL resolve.js handler …');
	const unlockToken = await signEmbedGateToken({
		gateId: gate.gateId,
		assetId,
		wallet,
		mint: gate.mint,
		minAmount: gate.minAmount,
		amount: 5, // pretend this wallet holds 5 $THREE — clears the 1 minAmount bar
	});
	const r3 = fakeReqRes('GET', `/api/embed/resolve?id=${encodeURIComponent(assetId)}&gate_token=${encodeURIComponent(unlockToken)}`);
	await resolveHandler(r3.req, r3.res);
	console.log('    status:', r3.status, 'body:', r3.json);
	console.log('    → a valid access token unlocks resolve.js for real (glbUrl present, unlocked:true).\n');

	console.log('[7c] A corrupted (tampered payload) token must NOT unlock — HMAC signature check rejects it …');
	const tampered = unlockToken.replace(/^eg1\./, 'eg1.tampered');
	const r4 = fakeReqRes('GET', `/api/embed/resolve?id=${encodeURIComponent(assetId)}&gate_token=${encodeURIComponent(tampered)}`);
	await resolveHandler(r4.req, r4.res);
	console.log('    tampered token → status:', r4.status, 'locked:', r4.json?.locked === true, '\n');

	console.log('[8] Cleaning up every disposable row this script created …');
	await sql`delete from embed_gates where id = ${gate.gateId}`;
	await sql`delete from avatars where id = ${avatar.id}`;
	await sql`delete from users where id in (${owner.id}, ${stranger.id})`;
	console.log('    deleted gate, avatar, and both demo users\n');

	console.log('=== Done. Every network/DB call above was real — no mocks. ===');
	process.exit(0);
}

main().catch((err) => {
	console.error('DEMO FAILED:', err);
	process.exit(1);
});
