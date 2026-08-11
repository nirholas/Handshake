#!/usr/bin/env node
// Audit every platform service wallet in ONE pass: derive each wallet's pubkey
// from its secret env var, read its on-chain SOL/USDC, check it against its
// SOL floor, and cross-check the x402 advertised fee-payer/payTo against what
// the secrets actually resolve to. Surfaces the class of misconfig that silently
// 502s paid endpoints (advertised fee-payer pubkey != the secret we co-sign with)
// and the "below SOL floor → engine paused" halts.
//
// USAGE (needs the deploy secrets in the environment):
//   npm run audit:service-wallets              # whatever .env holds locally
//
// A local .env carries only a subset of the signer secrets, so most rows read
// UNCONFIGURED here. That is a gap in the local env, not a gap in production.
// Production's authoritative set lives on the Cloud Run service, so to audit
// what the live service actually signs with, export that env first:
//   gcloud run services describe three-ws-api --region us-central1 \
//     --project aerial-vehicle-466722-p5 --format=yaml
// Do NOT use `vercel env pull`: it returns EMPTY for every secret-type var, so
// it reports a fully-configured fleet as fully unconfigured. Production has run
// on Cloud Run since 2026-07-07; Vercel is not the source of truth for any of
// these keys.
//
// Read-only: derives pubkeys and queries RPC. Never logs secret material, only
// derived public keys, balances, and pass/fail verdicts.

import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SOLANA_SIGNERS } from '../api/_lib/solana-signers.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ORIGIN = process.env.AUDIT_ORIGIN || 'https://three.ws';

// The lane chain this audit reads balances over. An operator's SOLANA_RPC_URL
// goes first when set, then the keyless free lanes (mirroring
// FREE_KEYLESS_MAINNET in api/_lib/solana/connection.js) so a single throttled
// provider cannot decide what this audit believes about the money.
//
// Why the chain exists at all: on 2026-08-07 every wallet here reported
// SOL=0.0000 because the configured lane was 429ing, and the audit reported
// four "below floor" money emergencies against wallets that were actually
// funded. A balance the audit could not read must never render as a balance of
// zero, see readBalance() below.
// rpc.magicblock.app is deliberately absent: it 403s every method from our
// egress, and it is still what SOLANA_RPC_URL points at in some environments,
// which is exactly how this audit came to read every wallet as empty.
//
// Hosts with a hard egress block, pruned from the chain no matter which var
// names them. Mirrors the pruning of FREE_KEYLESS_MAINNET described in
// docs/ops/solana-rpc-lanes.md: a 403 block is not a cooldown, it never
// recovers, so probing it only spends a round trip to relearn the block. This
// list is why the comment above is true of the code and not just of intent:
// SOLANA_RPC_URL still resolves to magicblock in this workspace's .env and on
// the Cloud Run service, so without the filter every read below opened with a
// guaranteed 403 before failing over.
const BLOCKED_LANE_HOSTS = new Set(['rpc.magicblock.app']);
const laneHost = (u) => { try { return new URL(u).host; } catch { return null; } };
const RPC_LANES = [
	process.env.SOLANA_RPC_URL,
	'https://solana-rpc.publicnode.com',
	'https://api.mainnet-beta.solana.com',
	'https://solana.leorpc.com/?api_key=FREE',
].filter((u) => u && !BLOCKED_LANE_HOSTS.has(laneHost(u)));

// THE registry, imported rather than mirrored. api/_lib/solana-signers.js has no
// imports of its own, so this stays a standalone script with no app module graph
// behind it, which is what an inline copy used to buy.
//
// The copy had to go because it could not see the per-signer floor overrides
// (SIGNER_MIN_SOL_<NAME> / SIGNER_REFILL_TO_SOL_<NAME>) that solana-signers.js
// applies at module load. Those exist so ops can retune a floor without a deploy,
// and every other consumer (treasury-topup targets, balance alerts, the floors
// dashboard) already agreed on the retuned number while this audit alone still
// judged against the code default. Concretely: with
// SIGNER_MIN_SOL_COIN_LAUNCHER_MASTER=0.15 set on the Cloud Run service and in
// .env, the audit still reported coin-launcher-master "below floor 1" and sized
// the deficit at ~6.7x what the economy actually wants funded. An audit that
// disagrees with the engine it audits reports fiction.
const SIGNERS = SOLANA_SIGNERS;

// Address-only vars (public keys advertised in 402 challenges, no secret here).
const ADVERTISED = [
	{ name: 'x402 payTo (Solana)',     env: 'X402_PAY_TO_SOLANA', fallbackEnv: 'X402_PAY_TO' },
	{ name: 'x402 fee-payer (Solana)', env: 'X402_FEE_PAYER_SOLANA' },
	{ name: 'credits deposit wallet',  env: 'CREDITS_DEPOSIT_WALLET_SOLANA' },
	{ name: 'platform fee wallet',     env: 'PUMP_PLATFORM_FEE_WALLET' },
	{ name: 'charity audit address',   env: 'X402_CHARITY_AUDIT_ADDRESS_SOLANA' },
];

function decodeSecret(raw) {
	if (!raw) return null;
	let s = String(raw).trim().replace(/^["']|["']$/g, '');
	// JSON array of ints
	if (s.startsWith('[')) {
		try { const a = JSON.parse(s); if (Array.isArray(a)) return Keypair.fromSecretKey(Uint8Array.from(a)); } catch {}
	}
	// base58
	try { const b = bs58.decode(s); if (b.length === 64) return Keypair.fromSecretKey(b); } catch {}
	// base64
	try { const b = Buffer.from(s, 'base64'); if (b.length === 64) return Keypair.fromSecretKey(new Uint8Array(b)); } catch {}
	return null;
}

// One JSON-RPC call against one lane. Throws on anything that is not a usable
// result, so the caller can fail over instead of reading a throttle as data:
// an HTTP error (429/5xx), a JSON-RPC `error` member (Tatum answers
// paid-tier-only methods that way), or a body with no `result` at all.
async function rpcOn(url, method, params) {
	const r = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		signal: AbortSignal.timeout(15000),
	});
	if (!r.ok) throw new Error(`http_${r.status}`);
	const body = await r.json();
	if (body?.error) throw new Error(String(body.error.message || body.error.code || 'rpc_error'));
	if (!('result' in body)) throw new Error('no_result');
	return body.result;
}

// Walk the lane chain until one answers. Returns the result, or throws with the
// last lane's reason once every lane has refused.
async function rpc(method, params) {
	let last = 'no lanes configured';
	for (const url of RPC_LANES) {
		try { return await rpcOn(url, method, params); } catch (e) { last = `${new URL(url).host}: ${e?.message || 'failed'}`; }
	}
	throw new Error(last);
}

// A read that failed is `null`, never 0. Every caller must treat null as "not
// known" and refuse to judge it against a floor.
async function onchain(addr) {
	let sol = null;
	let readError = null;
	try { sol = (await rpc('getBalance', [addr]))?.value / 1e9; } catch (e) { readError = e?.message || 'balance read failed'; }
	if (!Number.isFinite(sol)) { sol = null; readError = readError || 'balance read returned no value'; }
	let usdc = null;
	try {
		const u = await rpc('getTokenAccountsByOwner', [addr, { mint: USDC }, { encoding: 'jsonParsed' }]);
		usdc = Number(u?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString || 0);
	} catch { usdc = null; }
	return { sol, usdc, readError };
}
const fmtSol = (v) => (v === null ? 'unreadable' : v.toFixed(4));
const fmtUsdc = (v) => (v === null ? 'unreadable' : String(v));
// One accessor for both tables, so the registry's own `fallbackEnv` field is the
// only fallback spelling this script knows.
const rawOf = (spec) => process.env[spec.env] || (spec.fallbackEnv ? process.env[spec.fallbackEnv] : null);
function pub(spec) {
	const raw = rawOf(spec);
	if (!raw) return { configured: false };
	const kp = decodeSecret(raw);
	if (!kp) return { configured: true, bad: true };
	return { configured: true, pubkey: kp.publicKey.toBase58() };
}
function addrOf(spec) {
	const raw = rawOf(spec);
	if (!raw) return null;
	const v = String(raw).trim().replace(/^["']|["']$/g, '');
	try { new PublicKey(v); return v; } catch { return null; }
}

const flags = [];
const blind = [];
console.log(`\nservice-wallet audit · RPC lanes ${RPC_LANES.map((u) => new URL(u).host).join(' → ')} · origin ${ORIGIN}\n${'='.repeat(72)}`);

console.log('\nSECRET-BACKED SIGNERS (derived pubkey ← secret env):');
const sponsorDerived = {};
for (const s of SIGNERS) {
	const p = pub(s);
	if (!p.configured) { console.log(`  ⚪ ${s.name.padEnd(22)} UNCONFIGURED (${s.env} not set)`); continue; }
	if (p.bad) { console.log(`  ❌ ${s.name.padEnd(22)} SECRET PRESENT BUT UNDECODABLE (${s.env}), malformed key`); flags.push(`${s.name}: secret malformed`); continue; }
	const oc = await onchain(p.pubkey);
	// An unreadable balance is a blind spot, never a funding verdict. Judging
	// null against a floor is how a throttled RPC turns into four fake money
	// emergencies on the owner's desk.
	const unread = oc.sol === null;
	const low = !unread && oc.sol < s.minSol;
	const mark = unread ? '‼️' : low ? '⚠️ ' : '✅';
	const note = unread ? ` (READ FAILED: ${oc.readError})` : low ? ` (BELOW floor ${s.minSol})` : '';
	console.log(`  ${mark} ${s.name.padEnd(22)} ${p.pubkey}  SOL=${fmtSol(oc.sol)}${note}  USDC=${fmtUsdc(oc.usdc)}`);
	if (unread) blind.push(`${s.name} (${p.pubkey}): balance unreadable, ${oc.readError}`);
	if (low) flags.push(`${s.name}: SOL ${oc.sol.toFixed(4)} below floor ${s.minSol}`);
	if (s.name === 'x402-ring-sponsor') sponsorDerived.pubkey = p.pubkey;
}

console.log('\nADVERTISED ADDRESSES (public keys, no secret):');
const advVals = {};
for (const a of ADVERTISED) {
	const addr = addrOf(a);
	if (!addr) { console.log(`  ⚪ ${a.name.padEnd(24)} not set`); continue; }
	advVals[a.name] = addr;
	const oc = await onchain(addr);
	const unread = oc.sol === null;
	console.log(`  ${unread ? '‼️' : '✅'} ${a.name.padEnd(24)} ${addr}  SOL=${fmtSol(oc.sol)}  USDC=${fmtUsdc(oc.usdc)}`);
	if (unread) blind.push(`${a.name} (${addr}): balance unreadable, ${oc.readError}`);
}

// Live cross-check: what production actually advertises right now.
console.log('\nLIVE CONSISTENCY CHECKS:');
try {
	const st = await (await fetch(`${ORIGIN}/api/x402-status`)).json();
	const sol = (st.accepts || []).find((x) => String(x.network).startsWith('solana'));
	const advFee = sol?.extra?.feePayer;
	const advPay = sol?.payTo;
	console.log(`  live advertised fee-payer: ${advFee}`);
	console.log(`  live advertised payTo:     ${advPay}`);
	if (sponsorDerived.pubkey) {
		if (advFee === sponsorDerived.pubkey) console.log(`  ✅ advertised fee-payer MATCHES the sponsor secret we co-sign with`);
		else { console.log(`  ❌ MISMATCH: advertised fee-payer ${advFee} != sponsor secret pubkey ${sponsorDerived.pubkey} → every sponsor-mode settle 502s`); flags.push('fee-payer advertised != sponsor secret → settles 502'); }
	} else {
		console.log(`  ⚠️  cannot compare, X402_FEE_PAYER_SECRET_BASE58 not resolvable in this env`);
	}
	// PayAI shared account guard
	if (advFee === '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4') {
		console.log(`  ❌ advertised fee-payer is PayAI's PUBLIC shared account, self-hosted facilitator cannot co-sign for it`);
		flags.push("fee-payer is PayAI's public account (2wKupLR9…), override X402_FEE_PAYER_SOLANA");
	}
} catch (e) { console.log(`  (could not fetch ${ORIGIN}/api/x402-status: ${e.message})`); }

console.log(`\n${'='.repeat(72)}`);
// Two exit lanes on purpose. `✗` means the audit READ the chain and the money
// is wrong: a funding or config action. `‼` means the audit could not read at
// all: a monitoring blind spot to fix before anyone touches a wallet. Callers
// (scripts/gcp-triage.mjs) route them to different severities, so never merge
// the two lists.
if (blind.length) { console.log(`UNVERIFIED: ${blind.length} wallet(s) could not be read:`); blind.forEach((b) => console.log(`  ‼ ${b}`)); }
if (flags.length) { console.log(`RESULT: ${flags.length} issue(s):`); flags.forEach((f) => console.log(`  ✗ ${f}`)); }
if (!flags.length && !blind.length) console.log('RESULT: all checked wallets configured, funded, and consistent.');
else if (!flags.length) console.log('RESULT: no funding or config issue found among the wallets that could be read.');
if (flags.length) process.exitCode = 1;
else if (blind.length) process.exitCode = 2;
