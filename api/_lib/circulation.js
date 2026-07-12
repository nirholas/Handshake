// @ts-check
// Autonomous agent activity engine.
//
// The platform operates a pool of real agents — each a published marketplace
// listing with its own custodial Solana (and optionally EVM) wallet. On every
// tick this engine makes those agents do real, on-chain things with one another:
// send SOL tips, pay each other for services (recorded as x402 spends), trade
// coins through the platform's own pump.fun trade engine, launch coins through
// the platform launcher, register on-chain identities, and leave marketplace
// reviews. Every event flows through the SAME real code paths a human-owned agent
// uses, so it all lands in the live money feed as genuine wallet activity — no
// synthetic rows, no fake numbers.
//
// Funds originate from a single treasury wallet the operator funds. The engine
// tops agent wallets up from the treasury just-in-time and keeps per-tick amounts
// small. Everything is gated behind CIRCULATION_ENABLED + a treasury secret; with
// neither set the engine is fully inert.

import { sql } from './db.js';
import { env } from './env.js';
import { confirmOrThrow } from './solana/confirm.js';
import { randomUUID } from 'node:crypto';
import { scrubSecrets } from './scrub-secrets.js';
import {
	ensureAgentWallet,
	recoverSolanaAgentKeypair,
	getOrCreateAgentEvmWallet,
	recoverAgentKey,
} from './agent-wallet.js';
import { recordCustodyEvent } from './agent-trade-guards.js';
import { solanaConnection } from './agent-pumpfun.js';
import { createSession } from './auth.js';
import { solUsdPrice } from './avatar-wallet.js';
import { CHAIN_BY_ID } from './erc8004-chains.js';
import { publicUrl as r2PublicUrl } from './r2.js';
import { pinToIPFS } from './ipfs-pin.js';
import { confirmSkillPurchase, resolvePayoutAddress } from './purchase-confirm.js';
import { resolveMarketplaceFee } from './marketplace-platform-fee.js';
import { submitProtected } from './execution-engine.js';
import { insertNotification } from './notify.js';
import { invalidateSkillPriceCache } from './skill-price-cache.js';
import {
	PERSONAS,
	COIN_THEMES,
	PAYMENT_SERVICES,
	REVIEW_LINES,
	OWNER_FIRST_NAMES,
	SKILL_LISTINGS,
	ASSET_BLURBS,
	GENERIC_SKILLS,
	pick,
	pickTwo,
} from './circulation-personas.js';

const SOL = 1_000_000_000;

// Conservative, real economics. Every number here is small on purpose — the goal
// is a steady, believable heartbeat, not volume for its own sake.
const FEE_BUFFER = Math.floor(0.0009 * SOL); // tx fees + ATA rent headroom
const AGENT_FLOOR = Math.floor(0.02 * SOL); // top a working wallet up to this
const LAUNCH_FLOOR = Math.floor(0.034 * SOL); // pump create + tiny dev buy + fees
const TIP_MIN = Math.floor(0.001 * SOL);
const TIP_MAX = Math.floor(0.006 * SOL);
const PAY_MIN = Math.floor(0.0012 * SOL);
const PAY_MAX = Math.floor(0.01 * SOL);

const THREE_MINT = () => env.THREE_TOKEN_MINT || 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Marketplace economics. Listings are priced in whole $THREE; buyers acquire $THREE
// through the same real trade engine before paying, so the only funding rail is the
// SOL treasury. Prices are deliberately small — a believable marketplace heartbeat,
// not volume for its own sake.
const THREE_DECIMALS = 6;
const SKILL_PRICE_MIN_THREE = 80; // whole $THREE
const SKILL_PRICE_MAX_THREE = 1200;
const ASSET_PRICE_MIN_THREE = 600;
const ASSET_PRICE_MAX_THREE = 4000;
const THREE_TOPUP_SOL = 0.012; // SOL spent to buy $THREE when a buyer is short
const SKILLS_PER_SELLER = 3; // how many skills a seller lists before it's "stocked"

function threeAtomic(whole) {
	return BigInt(Math.round(whole)) * 10n ** BigInt(THREE_DECIMALS);
}

function clampInt(v, dflt, lo, hi) {
	const n = Number.parseInt(String(v ?? ''), 10);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(hi, Math.max(lo, n));
}

export function config() {
	const enabledRaw = String(process.env.CIRCULATION_ENABLED ?? '').toLowerCase();
	return {
		enabled: enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'yes',
		network: process.env.CIRCULATION_NETWORK === 'devnet' ? 'devnet' : 'mainnet',
		treasurySecret: (process.env.CIRCULATION_TREASURY_SECRET || '').trim(),
		evmTreasurySecret: (process.env.CIRCULATION_EVM_TREASURY_SECRET || '').trim(),
		evmChainId: clampInt(process.env.CIRCULATION_EVM_CHAIN_ID, 8453, 1, 1_000_000_000),
		poolTarget: clampInt(process.env.CIRCULATION_POOL_TARGET, 14, 2, 2000),
		growthPerTick: clampInt(process.env.CIRCULATION_GROWTH_PER_TICK, 3, 1, 40),
		actionsPerTick: clampInt(process.env.CIRCULATION_ACTIONS_PER_TICK, 2, 1, 12),
		origin: env.APP_ORIGIN || 'https://three.ws',
	};
}

// A skip is an expected, recoverable non-event (treasury low, pool too small) —
// never an error. It is logged and the tick moves on.
class Skip extends Error {}

function randBetween(lo, hi) {
	return lo + Math.floor(Math.random() * Math.max(1, hi - lo));
}

// ── one-time schema guard ─────────────────────────────────────────────────────
// Self-contained so the engine works whether or not the migration has been
// applied yet. CREATE TABLE IF NOT EXISTS is idempotent and cheap.
let _ensured = false;
async function ensureSchema() {
	if (_ensured) return;
	await sql`
		create table if not exists circulation_actions (
			id                   bigserial primary key,
			kind                 text not null,
			network              text,
			actor_agent_id       uuid,
			counterparty_agent_id uuid,
			signature            text,
			amount_lamports      bigint,
			status               text not null default 'ok',
			detail               jsonb not null default '{}'::jsonb,
			created_at           timestamptz not null default now()
		)
	`;
	await sql`create index if not exists circulation_actions_created on circulation_actions(created_at desc)`;
	await sql`create index if not exists circulation_actions_kind on circulation_actions(kind, created_at desc)`;
	_ensured = true;
}

async function logAction(row) {
	try {
		await sql`
			insert into circulation_actions
				(kind, network, actor_agent_id, counterparty_agent_id, signature, amount_lamports, status, detail)
			values (
				${row.kind}, ${row.network ?? null}, ${row.actorAgentId ?? null}, ${row.counterpartyAgentId ?? null},
				${row.signature ?? null}, ${row.amountLamports != null ? String(row.amountLamports) : null},
				${row.status ?? 'ok'}, ${JSON.stringify(scrubSecrets(row.detail ?? {}))}::jsonb
			)
		`;
	} catch (e) {
		console.warn('[circulation] logAction failed', e?.message);
	}
}

// `interval` is a plain Postgres interval string (e.g. '1 day', '45 minutes')
// bound as a parameter — no embedded quotes.
async function recentCount(kind, interval) {
	const [r] = await sql`
		select count(*)::int as count from circulation_actions
		where kind = ${kind} and status = 'ok' and created_at > now() - ${interval}::interval
	`;
	return r?.count ?? 0;
}

// ── treasury + low-level Solana transfer ──────────────────────────────────────

function decodeSecretKey(secret, bs58) {
	let bytes = null;
	try {
		const d = bs58.decode(secret);
		if (d.length === 64) bytes = d;
	} catch { /* not base58 */ }
	if (!bytes) {
		try {
			const b = Buffer.from(secret, 'base64');
			if (b.length === 64) bytes = b;
		} catch { /* not base64 */ }
	}
	if (!bytes) {
		try {
			const arr = JSON.parse(secret);
			if (Array.isArray(arr) && arr.length === 64) bytes = Uint8Array.from(arr);
		} catch { /* not json */ }
	}
	return bytes ? Uint8Array.from(bytes) : null;
}

async function treasuryKeypair(cfg) {
	if (!cfg.treasurySecret) throw new Skip('CIRCULATION_TREASURY_SECRET unset');
	const { Keypair } = await import('@solana/web3.js');
	const bs58 = (await import('bs58')).default;
	const bytes = decodeSecretKey(cfg.treasurySecret, bs58);
	if (!bytes) throw new Error('CIRCULATION_TREASURY_SECRET must be a 64-byte base58, base64, or JSON-array secret key');
	return Keypair.fromSecretKey(bytes);
}

async function transferSol(conn, fromKp, toAddress, lamports) {
	const {
		PublicKey,
		SystemProgram,
		TransactionMessage,
		VersionedTransaction,
		ComputeBudgetProgram,
	} = await import('@solana/web3.js');
	const toPk = new PublicKey(toAddress);

	// Retry once on "Blockhash not found" — the blockhash can expire between
	// getLatestBlockhash and sendTransaction if there is any delay (RPC round-trips,
	// key decryption, etc.). A single retry with a fresh blockhash is sufficient
	// because the new hash is guaranteed valid for ~150 blocks (~60s).
	const MAX_ATTEMPTS = 2;
	let lastErr;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
		const message = new TransactionMessage({
			payerKey: fromKp.publicKey,
			recentBlockhash: blockhash,
			instructions: [
				ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 60_000 }),
				ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
				SystemProgram.transfer({ fromPubkey: fromKp.publicKey, toPubkey: toPk, lamports }),
			],
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		tx.sign([fromKp]);
		try {
			const signature = await conn.sendTransaction(tx, { maxRetries: 5 });
			// HTTP-polling confirm — routes through the RPC failover fetch and opens
			// no WebSocket, so a throttled provider can't trigger web3.js's WS 429
			// reconnect storm. Throws on a landed-but-reverted transfer.
			await confirmOrThrow(conn, { signature, blockhash, lastValidBlockHeight }, 'confirmed');
			return signature;
		} catch (err) {
			const msg = err?.message || '';
			if (attempt < MAX_ATTEMPTS - 1 && /Blockhash not found|BlockhashNotFound/i.test(msg)) {
				lastErr = err;
				continue;
			}
			throw err;
		}
	}
	throw lastErr;
}

async function solBalance(conn, address) {
	const { PublicKey } = await import('@solana/web3.js');
	return BigInt(await conn.getBalance(new PublicKey(address), 'confirmed'));
}

// Top `agent` up to `floor` from the treasury when it is short. Returns the funding
// signature if a transfer happened, else null. Throws Skip when the treasury itself
// cannot cover the top-up — the tick records the skip and waits for a refill.
async function ensureFunded(conn, treasuryKp, agent, floor) {
	const have = await solBalance(conn, agent.address);
	if (have >= BigInt(floor)) return null;
	const need = BigInt(floor) - have + BigInt(FEE_BUFFER);
	const treasuryHave = await solBalance(conn, treasuryKp.publicKey.toBase58());
	if (treasuryHave < need + BigInt(FEE_BUFFER)) {
		throw new Skip(`treasury balance ${(Number(treasuryHave) / SOL).toFixed(4)} SOL too low to fund ${(Number(need) / SOL).toFixed(4)} SOL`);
	}
	const sig = await transferSol(conn, treasuryKp, agent.address, Number(need));
	await logAction({
		kind: 'fund',
		network: config().network,
		actorAgentId: agent.id,
		signature: sig,
		amountLamports: Number(need),
		detail: { to: agent.address, floor },
	});
	return sig;
}

// ── pool management ───────────────────────────────────────────────────────────

async function loadPool() {
	const rows = await sql`
		select id, user_id, name, avatar_id, meta
		from agent_identities
		where (meta->>'circulation') = 'true' and deleted_at is null
		order by created_at asc
	`;
	return rows
		.map((r) => ({
			id: r.id,
			userId: r.user_id,
			name: r.name,
			avatarId: r.avatar_id,
			meta: r.meta || {},
			address: r.meta?.solana_address || null,
		}))
		.filter((a) => a.address);
}

function slugify(s) {
	return String(s)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
}

// Claim a unique username from a base word (mirrors the forge-seed username claim).
async function claimUsername(base) {
	const existing = await sql`
		select username from users where username = ${base} or username like ${base + '%'} limit 100
	`;
	const taken = new Set(existing.map((r) => r.username));
	if (!taken.has(base)) return base;
	for (let n = 2; n <= 99; n++) {
		if (!taken.has(`${base}${n}`)) return `${base}${n}`;
	}
	return `${base}_${randomUUID().slice(0, 4)}`;
}

// Clone a random public avatar into `userId`'s ownership so the new agent has a
// real 3D body + thumbnail (reusing the platform's own generated gallery) and so
// the coin launcher can use it as the token image. Returns the new avatar id or
// null when no public avatar exists yet.
//
// Exported: api/cron/agent-avatar-backfill.js reuses this to heal pre-existing
// agents whose avatar_id is NULL, so every agent card can show a real preview.
export async function cloneAvatarFor(userId, name) {
	// Prefer a humanoid with a ready-made thumbnail — the clone inherits the
	// thumbnail_key, so the agent card gets an instant preview instead of
	// waiting a cron tick for a render. Props/accessories and thumbnail-less
	// rows are only a fallback for a thin pool.
	let [src] = await sql`
		select id, storage_key, thumbnail_key, size_bytes, content_type, source, tags, model_category
		from avatars
		where visibility = 'public' and deleted_at is null and storage_key is not null
		  and model_category = 'avatar' and thumbnail_key is not null
		order by random()
		limit 1
	`;
	if (!src) {
		[src] = await sql`
			select id, storage_key, thumbnail_key, size_bytes, content_type, source, tags, model_category
			from avatars
			where visibility = 'public' and deleted_at is null and storage_key is not null
			order by random()
			limit 1
		`;
	}
	if (!src) return null;
	const slug = `${slugify(name)}-${randomUUID().slice(0, 6)}`;
	const [row] = await sql`
		insert into avatars
			(owner_id, slug, name, description, storage_key, size_bytes, content_type,
			 source, source_meta, thumbnail_key, visibility, tags, model_category, created_at, updated_at)
		values (
			${userId}, ${slug}, ${name}, ${'Operated by a three.ws agent'},
			${src.storage_key}, ${src.size_bytes ?? 0}, ${src.content_type || 'model/gltf-binary'},
			${src.source || 'import'}, ${JSON.stringify({ circulation: true, cloned_from: src.id })}::jsonb,
			${src.thumbnail_key ?? null}, 'public', ${src.tags ?? []}, ${src.model_category ?? null}, now(), now()
		)
		returning id
	`;
	return row?.id ?? null;
}

// Create exactly one new pool agent for the next unused persona. Idempotent per
// persona (a persona already represented is skipped). Returns a short descriptor
// or null when the persona set is exhausted.
async function createPoolAgent() {
	// Variant-based scaling: the pool grows past the 16 base personas by minting
	// additional accounts that reuse a persona's craft but get their own owner,
	// wallet, name suffix, and marketplace listing. Selection is deterministic on
	// the current count so repeated calls produce distinct accounts.
	const [{ count }] = await sql`
		select count(*)::int as count from agent_identities
		where (meta->>'circulation') = 'true' and deleted_at is null
	`;
	if (count >= 5000) return null; // hard safety ceiling

	const persona = PERSONAS[count % PERSONAS.length];
	const variant = Math.floor(count / PERSONAS.length);
	const agentName = variant === 0 ? persona.name : `${persona.name} #${variant + 1}`;

	const ownerWord = `${pick(OWNER_FIRST_NAMES)}${persona.handle}`.replace(/[^a-z0-9]/g, '');
	const username = await claimUsername(slugify(ownerWord) || persona.handle);
	const email = `${username}@agents.three.ws`;
	const displayName = username.replace(/\d+$/, '').replace(/\b\w/g, (c) => c.toUpperCase());

	const [user] = await sql`
		insert into users (email, display_name, username, plan, email_verified, created_at, updated_at)
		values (${email}, ${displayName}, ${username}, 'free', false, now(), now())
		on conflict do nothing
		returning id
	`;
	if (!user?.id) return { skipped: 'user_conflict', persona: persona.handle };

	const avatarId = await cloneAvatarFor(user.id, agentName).catch(() => null);

	const meta = { circulation: true, persona: persona.handle, variant };
	const [agent] = await sql`
		insert into agent_identities
			(user_id, name, description, system_prompt, greeting, category, tags, capabilities,
			 avatar_id, is_published, published_at, meta, created_at, updated_at)
		values (
			${user.id}, ${agentName}, ${persona.description}, ${persona.system_prompt}, ${persona.greeting},
			${persona.category}, ${persona.tags}, ${JSON.stringify({ bullets: [], skills: [], library: [] })}::jsonb,
			${avatarId}, true, now(), ${JSON.stringify(meta)}::jsonb, now(), now()
		)
		returning id
	`;
	if (!agent?.id) {
		await sql`delete from users where id = ${user.id}`.catch(() => {});
		return { skipped: 'agent_insert_failed', persona: persona.handle };
	}

	// First published version, mirroring the marketplace publish path.
	await sql`
		insert into agent_versions (agent_id, version, system_prompt, greeting, category, tags, capabilities, changelog, created_by)
		values (${agent.id}, 1, ${persona.system_prompt}, ${persona.greeting}, ${persona.category}, ${persona.tags},
		        ${JSON.stringify({ bullets: [], skills: [], library: [] })}::jsonb, 'Initial release', ${user.id})
		on conflict do nothing
	`.catch(() => {});

	// Provision the custodial Solana wallet immediately so the agent can transact.
	await ensureAgentWallet(agent.id, user.id, { reason: 'circulation_provision' }).catch((e) => {
		console.warn('[circulation] wallet provision failed', e?.message);
	});

	await logAction({ kind: 'provision', actorAgentId: agent.id, detail: { persona: persona.handle, username, avatar: !!avatarId } });
	return { created: agent.id, persona: persona.handle, username };
}

// ── helpers shared by actions ─────────────────────────────────────────────────

async function loadAgentMeta(agentId) {
	const [row] = await sql`select id, user_id, meta from agent_identities where id = ${agentId} and deleted_at is null limit 1`;
	return row || null;
}

async function senderKeypair(agent, reason) {
	const full = await loadAgentMeta(agent.id);
	const secret = full?.meta?.encrypted_solana_secret;
	if (!secret) throw new Error('agent has no custodial secret');
	return recoverSolanaAgentKeypair(secret, {
		agentId: agent.id,
		userId: agent.userId,
		reason,
		meta: { source: 'circulation' },
	});
}

// ── marketplace helpers ───────────────────────────────────────────────────────

// Register the agent's custodial Solana wallet as its default payout wallet so
// buyers' funds resolve a destination (resolvePayoutAddress reads this table).
// Idempotent — mirrors the upsert in /api/monetization/wallet.
async function ensurePayoutWallet(agent) {
	if (!agent.address) throw new Skip('seller has no custodial wallet');
	await sql`
		insert into agent_payout_wallets
			(user_id, agent_id, address, chain, is_default, preferred_network)
		values (${agent.userId}, ${agent.id}, ${agent.address}, 'solana', true, 'mainnet')
		on conflict (user_id, agent_id, chain) do update set
			address = excluded.address, is_default = true
	`;
}

// Read an owner's $THREE balance in atomic units (0 when the token account does
// not exist yet). Cheap, read-only.
async function threeBalanceAtomic(conn, ownerAddress) {
	const { PublicKey } = await import('@solana/web3.js');
	const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
	const ata = getAssociatedTokenAddressSync(new PublicKey(THREE_MINT()), new PublicKey(ownerAddress));
	try {
		const bal = await conn.getTokenAccountBalance(ata, 'confirmed');
		return BigInt(bal?.value?.amount ?? '0');
	} catch {
		return 0n; // no ATA / not found
	}
}

// Guarantee `agent` holds at least `needAtomic` $THREE. Tops the wallet up with SOL
// from the treasury, then buys $THREE through the real trade engine. Returns when
// the balance clears; throws Skip if it still falls short (the tick records the skip
// and a later tick retries once the buy settles).
async function ensureThree(ctx, agent, needAtomic) {
	const { conn, treasuryKp, network } = ctx;
	let have = await threeBalanceAtomic(conn, agent.address);
	if (have >= needAtomic) return have;

	await ensureFunded(conn, treasuryKp, agent, AGENT_FLOOR);

	const { PublicKey } = await import('@solana/web3.js');
	const { executeAgentTrade } = await import('../agents/agent-trade.js');
	const full = await loadAgentMeta(agent.id);
	if (!full) throw new Skip('agent vanished');

	const result = await executeAgentTrade({
		id: agent.id,
		userId: agent.userId,
		meta: full.meta,
		input: {
			side: 'buy',
			mint: THREE_MINT(),
			mintPk: new PublicKey(THREE_MINT()),
			amount: THREE_TOPUP_SOL,
			isMax: false,
			slippageBps: 700,
			slippagePct: 7,
			network,
			simulate: false,
			idempotencyKey: randomUUID(),
		},
		source: 'discretionary',
	});
	if (!result.ok) throw new Skip(`could not acquire $THREE: ${result.code || 'trade_error'}${result.message ? ` — ${result.message}` : ''}`);

	// Give the buy a moment to settle, then re-read.
	for (let i = 0; i < 6; i++) {
		have = await threeBalanceAtomic(conn, agent.address);
		if (have >= needAtomic) return have;
		await new Promise((r) => setTimeout(r, 2500));
	}
	throw new Skip('still short on $THREE after top-up buy — will retry next tick');
}

// Build, sign, and submit an SPL transferChecked of `atomic` $THREE from `fromKp`
// to `toAddress`, tagging it with a Solana-Pay `referenceKey` so confirm/validate
// can find it on-chain. Buyer pays the seller-ATA rent idempotently. Returns the
// confirmed signature.
// Transfer $THREE to a recipient, tagging the leg with a Solana-Pay reference so
// confirmSkillPurchase can find it. When `feeLeg` is supplied ({ wallet, atomics }),
// a SECOND transferChecked routes the platform fee to the treasury in the SAME
// transaction — the exact split confirmSkillPurchase verifies. `atomic` is the
// CREATOR leg (price − fee); pass the full price with no feeLeg for a plain transfer.
async function transferThreeWithReference(conn, fromKp, toAddress, atomic, referenceKey, network, feeLeg = null) {
	const { PublicKey } = await import('@solana/web3.js');
	const {
		getAssociatedTokenAddressSync,
		createTransferCheckedInstruction,
		createAssociatedTokenAccountIdempotentInstruction,
		getMint,
	} = await import('@solana/spl-token');

	const mintKey = new PublicKey(THREE_MINT());
	const recipKey = new PublicKey(toAddress);
	const mintInfo = await getMint(conn, mintKey);
	const fromAta = getAssociatedTokenAddressSync(mintKey, fromKp.publicKey);
	const toAta = getAssociatedTokenAddressSync(mintKey, recipKey);

	const transferIx = createTransferCheckedInstruction(
		fromAta, mintKey, toAta, fromKp.publicKey, atomic, mintInfo.decimals,
	);
	transferIx.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

	const ixs = [
		createAssociatedTokenAccountIdempotentInstruction(fromKp.publicKey, toAta, recipKey, mintKey),
		transferIx,
	];

	if (feeLeg && feeLeg.atomics > 0n && feeLeg.wallet) {
		const feeKey = new PublicKey(feeLeg.wallet);
		const feeAta = getAssociatedTokenAddressSync(mintKey, feeKey);
		ixs.push(createAssociatedTokenAccountIdempotentInstruction(fromKp.publicKey, feeAta, feeKey, mintKey));
		ixs.push(createTransferCheckedInstruction(
			fromAta, mintKey, feeAta, fromKp.publicKey, feeLeg.atomics, mintInfo.decimals,
		));
	}

	const { signature } = await submitProtected({ network, connection: conn, payer: fromKp, instructions: ixs });
	return signature;
}

// Skills currently listed (active, $THREE-priced), joined to the seller's owner so
// the purchase action can exclude self-dealing. ONLY circulation sellers — agents
// we own — are ever included. Manufactured demand never reaches a real user's
// wallet, so no SOL or $THREE ever leaves the closed loop. Each row is tagged
// seller_kind so callers can reason about it.
async function listedSkills() {
	return sql`
		select asp.agent_id, asp.skill, asp.amount, asp.currency_mint, asp.trial_uses,
		       ai.user_id as seller_user_id, ai.name as seller_name, 'circulation' as seller_kind
		from agent_skill_prices asp
		join agent_identities ai on ai.id = asp.agent_id
		where asp.is_active = true
		  and asp.currency_mint = ${THREE_MINT()}
		  and (ai.meta->>'circulation') = 'true'
		  and ai.deleted_at is null
	`;
}

// ── actions ───────────────────────────────────────────────────────────────────

// Agent A sends a real SOL tip to agent B. Recorded on B exactly like a verified
// peer tip, so it lands in the feed as an inbound tip with A as the counterparty.
async function actionTip(ctx) {
	const { conn, treasuryKp, pool, network, solUsd } = ctx;
	const [sender, receiver] = pickTwo(pool);
	if (!sender || !receiver || sender.id === receiver.id) throw new Skip('need two distinct agents');

	const amount = randBetween(TIP_MIN, TIP_MAX);
	await ensureFunded(conn, treasuryKp, sender, Math.max(AGENT_FLOOR, amount + FEE_BUFFER));

	const kp = await senderKeypair(sender, 'circulation_tip');
	const signature = await transferSol(conn, kp, receiver.address, amount);

	const usd = solUsd ? (amount / SOL) * solUsd : null;
	await recordCustodyEvent({
		agentId: receiver.id,
		userId: null,
		eventType: 'tip',
		category: 'tip',
		network,
		asset: 'SOL',
		amountLamports: amount,
		usd,
		destination: receiver.address,
		signature,
		status: 'confirmed',
		idempotencyKey: `tip:${signature}`,
		meta: { source: 'p2p_tip', from: sender.address, block_time: new Date().toISOString(), decimals: 9 },
	});

	await logAction({ kind: 'tip', network, actorAgentId: receiver.id, counterpartyAgentId: sender.id, signature, amountLamports: amount, detail: { from: sender.name, to: receiver.name } });
	return { kind: 'tip', from: sender.name, to: receiver.name, sol: amount / SOL, signature };
}

// Agent A pays agent B for a service. Real SOL transfer, recorded on the PAYER as
// an x402-category spend so it surfaces in the feed as an agent-to-agent payment.
async function actionPayment(ctx) {
	const { conn, treasuryKp, pool, network, solUsd } = ctx;
	const [payer, payee] = pickTwo(pool);
	if (!payer || !payee || payer.id === payee.id) throw new Skip('need two distinct agents');

	const amount = randBetween(PAY_MIN, PAY_MAX);
	await ensureFunded(conn, treasuryKp, payer, Math.max(AGENT_FLOOR, amount + FEE_BUFFER));

	const kp = await senderKeypair(payer, 'circulation_payment');
	const signature = await transferSol(conn, kp, payee.address, amount);

	const service = pick(PAYMENT_SERVICES);
	const usd = solUsd ? (amount / SOL) * solUsd : null;
	await recordCustodyEvent({
		agentId: payer.id,
		userId: payer.userId,
		eventType: 'spend',
		category: 'x402',
		network,
		asset: 'SOL',
		amountLamports: amount,
		usd,
		destination: payee.address,
		signature,
		status: 'confirmed',
		reason: 'a2a_payment',
		idempotencyKey: `pay:${signature}`,
		meta: { source: 'a2a_payment', service, to_agent: payee.name, to: payee.address, block_time: new Date().toISOString() },
	});

	await logAction({ kind: 'payment', network, actorAgentId: payer.id, counterpartyAgentId: payee.id, signature, amountLamports: amount, detail: { service, from: payer.name, to: payee.name } });
	return { kind: 'payment', from: payer.name, to: payee.name, service, sol: amount / SOL, signature };
}

async function pickTradableMint(network) {
	if (network === 'mainnet' && Math.random() < 0.6) return THREE_MINT();
	const rows = await sql`
		select pam.mint from pump_agent_mints pam
		join agent_identities ai on ai.id = pam.agent_id
		where pam.network = ${network} and (ai.meta->>'circulation') = 'true'
		order by pam.created_at desc
		limit 20
	`;
	if (rows.length) return pick(rows).mint;
	return network === 'mainnet' ? THREE_MINT() : null;
}

// Agent buys a small amount of a coin through the real, fully-guarded trade engine.
async function actionTrade(ctx) {
	const { conn, treasuryKp, pool, network } = ctx;
	const agent = pick(pool);
	await ensureFunded(conn, treasuryKp, agent, AGENT_FLOOR);

	const mint = await pickTradableMint(network);
	if (!mint) throw new Skip('no tradable mint available');

	const { PublicKey } = await import('@solana/web3.js');
	const { executeAgentTrade } = await import('../agents/agent-trade.js');
	const full = await loadAgentMeta(agent.id);
	if (!full) throw new Skip('agent vanished');

	const amount = Number((0.002 + Math.random() * 0.008).toFixed(5)); // 0.002–0.010 SOL
	const result = await executeAgentTrade({
		id: agent.id,
		userId: agent.userId,
		meta: full.meta,
		input: {
			side: 'buy',
			mint,
			mintPk: new PublicKey(mint),
			amount,
			isMax: false,
			slippageBps: 500,
			slippagePct: 5,
			network,
			simulate: false,
			idempotencyKey: randomUUID(),
		},
		source: 'discretionary',
	});

	if (!result.ok) throw new Skip(`trade rejected: ${result.code || 'error'}${result.message ? ` — ${result.message}` : ''}`);
	await logAction({ kind: 'trade', network, actorAgentId: agent.id, signature: result.data?.signature, amountLamports: Math.round(amount * SOL), detail: { mint, agent: agent.name } });
	return { kind: 'trade', agent: agent.name, mint, sol: amount, signature: result.data?.signature };
}

// Internal authenticated POST as a given owner (mints a short-lived session and
// passes it as the host session cookie). Used for the launcher endpoints, which
// authenticate via the session cookie.
async function postAs(origin, ownerUserId, path, body, timeoutMs = 55_000) {
	const token = await createSession({ userId: ownerUserId, userAgent: 'circulation', ip: null });
	let res;
	try {
		res = await fetch(`${origin}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				cookie: `__Host-sid=${token}`,
				'user-agent': 'threews-circulation/1.0',
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { status: 0, body: null, timedOut: true };
		throw err;
	}
	let parsed = null;
	try { parsed = await res.json(); } catch { /* non-JSON */ }
	return { status: res.status, body: parsed };
}

// Agent launches a coin through the platform's own pump.fun launcher (build
// metadata → server-signed launch-agent). Records into pump_agent_mints, so it
// surfaces in the feed and the launch directory as a real on-chain launch.
async function actionLaunch(ctx) {
	const { conn, treasuryKp, pool, network, origin } = ctx;
	// Prefer an agent that has not launched recently.
	const recent = await sql`
		select actor_agent_id from circulation_actions
		where kind = 'launch' and created_at > now() - interval '2 days'
	`;
	const launchedSet = new Set(recent.map((r) => r.actor_agent_id));
	const candidates = pool.filter((a) => a.avatarId && !launchedSet.has(a.id));
	const agent = candidates.length ? pick(candidates) : pool.find((a) => a.avatarId);
	if (!agent) throw new Skip('no launch-ready agent (needs an avatar image)');

	await ensureFunded(conn, treasuryKp, agent, LAUNCH_FLOOR);

	const theme = pick(COIN_THEMES);
	const meta = await postAs(origin, agent.userId, '/api/pump/build-metadata', {
		name: theme.name,
		symbol: theme.symbol,
		description: theme.description,
		agent_id: agent.id,
		avatar_id: agent.avatarId,
	});
	if (meta.timedOut) throw new Skip('metadata build timed out');
	if (meta.status !== 200 || !meta.body?.metadata_url) {
		throw new Skip(`metadata build ${meta.status}: ${meta.body?.error || 'no url'}`);
	}

	const launch = await postAs(origin, agent.userId, '/api/pump/launch-agent', {
		agent_id: agent.id,
		name: theme.name,
		symbol: theme.symbol,
		uri: meta.body.metadata_url,
		network,
		quote_currency: 'sol',
		sol_buy_in: 0.001,
		buyback_bps: 0,
		coin_type: 'agent',
	});
	if (launch.timedOut) throw new Skip('launch timed out');
	if (launch.status !== 200 || !(launch.body?.mint || launch.body?.data?.mint)) {
		throw new Skip(`launch ${launch.status}: ${launch.body?.error || launch.body?.message || 'no mint'}`);
	}
	const mint = launch.body?.mint || launch.body?.data?.mint;

	await logAction({ kind: 'launch', network, actorAgentId: agent.id, signature: mint, detail: { name: theme.name, symbol: theme.symbol, mint, agent: agent.name } });
	return { kind: 'launch', agent: agent.name, name: theme.name, symbol: theme.symbol, mint };
}

// Owner of one agent leaves a real marketplace review on another agent's listing.
async function actionReview(ctx) {
	const { pool } = ctx;
	const [reviewer, target] = pickTwo(pool);
	if (!reviewer || !target || reviewer.id === target.id || reviewer.userId === target.userId) {
		throw new Skip('need two agents with distinct owners');
	}
	const rating = Math.random() < 0.75 ? 5 : 4;
	const body = pick(REVIEW_LINES);
	await sql`
		insert into agent_reviews (agent_id, user_id, rating, body)
		values (${target.id}, ${reviewer.userId}, ${rating}, ${body})
		on conflict (agent_id, user_id)
		do update set rating = excluded.rating, body = excluded.body, updated_at = now()
	`;
	await logAction({ kind: 'review', actorAgentId: reviewer.id, counterpartyAgentId: target.id, detail: { rating, target: target.name } });
	return { kind: 'review', by: reviewer.name, on: target.name, rating };
}

// A seller agent lists one more skill on its marketplace profile: a real
// agent_skill_prices row priced in $THREE (some trial-eligible), plus the skill
// surfaced on the agent's published capabilities so it's a visible listing — not
// just a price row. Registers the seller's payout wallet so buyers can pay it.
async function actionListSkill() {
	const [seller] = await sql`
		select ai.id, ai.user_id, ai.name, ai.category, ai.capabilities, ai.meta
		from agent_identities ai
		where (ai.meta->>'circulation') = 'true' and ai.deleted_at is null
		  and ai.meta->>'solana_address' is not null
		  and (
			select count(*) from agent_skill_prices asp
			where asp.agent_id = ai.id and asp.is_active = true and asp.currency_mint = ${THREE_MINT()}
		  ) < ${SKILLS_PER_SELLER}
		order by random()
		limit 1
	`;
	if (!seller) throw new Skip('every seller is fully stocked');

	const sellerAgent = { id: seller.id, userId: seller.user_id, name: seller.name, address: seller.meta?.solana_address };
	await ensurePayoutWallet(sellerAgent);

	const catalog = SKILL_LISTINGS[seller.category] || GENERIC_SKILLS;
	const listed = new Set((await sql`select skill from agent_skill_prices where agent_id = ${seller.id}`).map((r) => r.skill));
	const choices = catalog.filter((s) => !listed.has(s));
	if (!choices.length) throw new Skip('seller has listed its whole catalog');
	const skill = pick(choices);

	const priceWhole = randBetween(SKILL_PRICE_MIN_THREE, SKILL_PRICE_MAX_THREE);
	const amount = threeAtomic(priceWhole).toString();
	const trialUses = Math.random() < 0.4 ? 1 : 0;

	await sql`
		insert into agent_skill_prices
			(agent_id, skill, amount, currency_mint, chain, is_active, trial_uses,
			 mint_decimals, pricing_type, gate_type)
		values
			(${seller.id}, ${skill}, ${amount}, ${THREE_MINT()}, 'solana', true, ${trialUses},
			 ${THREE_DECIMALS}, 'fixed', 'price')
		on conflict (agent_id, skill) do update set
			amount = excluded.amount, currency_mint = excluded.currency_mint, chain = excluded.chain,
			is_active = true, trial_uses = excluded.trial_uses, mint_decimals = excluded.mint_decimals,
			updated_at = now()
	`;

	const skills = Array.isArray(seller.capabilities?.skills) ? seller.capabilities.skills : [];
	if (!skills.includes(skill)) {
		const next = { ...(seller.capabilities || {}), skills: [...skills, skill] };
		await sql`update agent_identities set capabilities = ${JSON.stringify(next)}::jsonb, updated_at = now() where id = ${seller.id}`;
	}
	await invalidateSkillPriceCache(seller.id).catch(() => {});

	await logAction({ kind: 'list_skill', actorAgentId: seller.id, detail: { skill, price_three: priceWhole, trial: !!trialUses, seller: seller.name } });
	return { kind: 'list_skill', seller: seller.name, skill, price_three: priceWhole, trial: !!trialUses };
}

// A buyer agent purchases a listed skill from another agent. The buyer signs a real
// $THREE SPL transfer (acquiring $THREE first if short, via the same trade engine),
// then confirmSkillPurchase validates on-chain, records the seller's revenue, and
// grants persistent access — the identical path a human-owned agent uses.
async function actionBuySkill(ctx) {
	const { conn, pool, network } = ctx;
	const listings = await listedSkills();
	if (!listings.length) throw new Skip('no skills listed yet');
	const listing = pick(listings);

	const candidates = pool.filter((a) => a.userId !== listing.seller_user_id && a.id !== listing.agent_id);
	if (!candidates.length) throw new Skip('no eligible buyer');
	const buyer = pick(candidates);

	const [owned] = await sql`
		select 1 from skill_purchases
		where user_id = ${buyer.userId} and agent_id = ${listing.agent_id} and skill = ${listing.skill}
		  and status in ('confirmed','trial') limit 1
	`;
	if (owned) throw new Skip('buyer already owns this skill');

	const amountAtomic = BigInt(listing.amount);
	await ensureThree(ctx, buyer, amountAtomic);

	const recipient = await resolvePayoutAddress(listing.agent_id, 'solana').catch(() => null);
	if (!recipient) throw new Skip('seller payout wallet missing');

	// Platform fee — the same take-rate the real /marketplace purchase path charges,
	// so the demo loop validates true unit economics. When the fee is OFF (default)
	// resolveMarketplaceFee returns 0 and this degrades to a plain full-price transfer
	// (today's behaviour, no risk). When ON, the buyer's single tx splits creator-net
	// to the seller and the fee to the treasury — exactly what confirmSkillPurchase
	// verifies — and the fee is persisted so the Pulse take-rate reads real on-chain fees.
	let feeAtomics = 0n;
	let feeWallet = null;
	try {
		const fee = await resolveMarketplaceFee({ grossAtomics: amountAtomic });
		if (fee?.feeAtomics > 0n && fee.recipient && fee.feeAtomics < amountAtomic) {
			feeAtomics = fee.feeAtomics;
			feeWallet = fee.recipient.toBase58();
		}
	} catch { /* fee is best-effort; a resolution miss never blocks the sale */ }
	const creatorAtomic = amountAtomic - feeAtomics;

	const { Keypair } = await import('@solana/web3.js');
	const referenceKp = Keypair.generate();
	const reference = referenceKp.publicKey.toBase58();

	const [pur] = await sql`
		insert into skill_purchases
			(user_id, agent_id, skill, status, reference, amount, currency_mint, chain, expires_at, kind,
			 platform_fee_amount, platform_fee_wallet)
		values
			(${buyer.userId}, ${listing.agent_id}, ${listing.skill}, 'pending', ${reference},
			 ${listing.amount}, ${THREE_MINT()}, 'solana', now() + interval '15 minutes', 'purchase',
			 ${feeAtomics.toString()}, ${feeWallet})
		returning id, user_id, agent_id, skill, status, amount, currency_mint, chain, reference, expires_at,
		          platform_fee_amount, platform_fee_wallet
	`;
	pur.mint_decimals = THREE_DECIMALS;

	const buyerKp = await senderKeypair(buyer, 'circulation_skill_purchase');
	let txSig;
	try {
		txSig = await transferThreeWithReference(
			conn, buyerKp, recipient, creatorAtomic, referenceKp.publicKey, network,
			feeAtomics > 0n ? { wallet: feeWallet, atomics: feeAtomics } : null,
		);
	} catch (e) {
		await sql`update skill_purchases set status = 'failed' where id = ${pur.id} and status = 'pending'`.catch(() => {});
		throw new Skip(`skill payment failed: ${e?.message?.slice(0, 160)}`);
	}

	const result = await confirmSkillPurchase({ ...pur, tx_signature: txSig, referrer_user_id: null });
	if (result.status !== 'confirmed') {
		throw new Skip(`skill purchase ${result.status}: ${(result.message || '').slice(0, 120)}`.trim());
	}

	const priceThree = Number(amountAtomic / 10n ** BigInt(THREE_DECIMALS));
	await recordCustodyEvent({
		agentId: buyer.id,
		userId: buyer.userId,
		eventType: 'spend',
		category: 'marketplace',
		network,
		asset: 'THREE',
		amountRaw: amountAtomic,
		destination: recipient,
		signature: txSig,
		status: 'confirmed',
		reason: 'skill_purchase',
		idempotencyKey: `skillbuy:${txSig}`,
		meta: { source: 'marketplace_skill', skill: listing.skill, seller: listing.seller_name, amount_three: priceThree, decimals: THREE_DECIMALS, to: recipient, block_time: new Date().toISOString() },
	}).catch((e) => console.warn('[circulation] custody event failed', e?.message));

	await logAction({ kind: 'buy_skill', network, actorAgentId: buyer.id, counterpartyAgentId: listing.agent_id, signature: txSig, detail: { skill: listing.skill, buyer: buyer.name, seller: listing.seller_name, amount_three: priceThree } });
	return { kind: 'buy_skill', buyer: buyer.name, seller: listing.seller_name, skill: listing.skill, three: priceThree, signature: txSig };
}

// A buyer agent starts a free trial on a trial-eligible listed skill. No payment —
// a real skill_purchases trial row, exactly like /api/marketplace/start-trial.
async function actionTrial(ctx) {
	const { pool } = ctx;
	const trialable = (await listedSkills()).filter((l) => (l.trial_uses || 0) > 0);
	if (!trialable.length) throw new Skip('no trial-eligible skills listed');
	const listing = pick(trialable);

	const candidates = pool.filter((a) => a.userId !== listing.seller_user_id && a.id !== listing.agent_id);
	if (!candidates.length) throw new Skip('no eligible trial taker');
	const taker = pick(candidates);

	const [blocked] = await sql`
		select 1 from skill_purchases
		where user_id = ${taker.userId} and agent_id = ${listing.agent_id} and skill = ${listing.skill}
		  and (status in ('confirmed','trial') or kind = 'trial') limit 1
	`;
	if (blocked) throw new Skip('taker already engaged this skill');

	const reference = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
	await sql`
		insert into skill_purchases
			(user_id, agent_id, skill, status, kind, reference, amount, currency_mint, chain, trial_remaining)
		values
			(${taker.userId}, ${listing.agent_id}, ${listing.skill}, 'trial', 'trial', ${reference},
			 ${listing.amount}, ${THREE_MINT()}, 'solana', ${listing.trial_uses})
	`;
	await logAction({ kind: 'trial', actorAgentId: taker.id, counterpartyAgentId: listing.agent_id, detail: { skill: listing.skill, taker: taker.name, seller: listing.seller_name } });
	return { kind: 'trial', taker: taker.name, seller: listing.seller_name, skill: listing.skill };
}

// A seller agent lists its 3D avatar as a purchasable asset (real asset_prices row,
// priced in $THREE). Registers the payout wallet so the asset can be bought.
async function actionListAsset() {
	const [row] = await sql`
		select ai.id as agent_id, ai.user_id, ai.name, ai.avatar_id, ai.meta
		from agent_identities ai
		where (ai.meta->>'circulation') = 'true' and ai.deleted_at is null
		  and ai.avatar_id is not null
		  and ai.meta->>'solana_address' is not null
		  and not exists (
			select 1 from asset_prices ap
			where ap.item_type = 'avatar' and ap.item_id = ai.avatar_id and ap.is_active = true
		  )
		order by random()
		limit 1
	`;
	if (!row) throw new Skip('no unlisted avatars to sell');

	const seller = { id: row.agent_id, userId: row.user_id, name: row.name, address: row.meta?.solana_address };
	await ensurePayoutWallet(seller);

	const priceWhole = randBetween(ASSET_PRICE_MIN_THREE, ASSET_PRICE_MAX_THREE);
	const amount = threeAtomic(priceWhole).toString();
	await sql`
		insert into asset_prices (item_type, item_id, owner_user_id, amount, currency_mint, chain, mint_decimals, is_active)
		values ('avatar', ${row.avatar_id}, ${row.user_id}, ${amount}, ${THREE_MINT()}, 'solana', ${THREE_DECIMALS}, true)
		on conflict (item_type, item_id) do update set
			amount = excluded.amount, currency_mint = excluded.currency_mint, chain = excluded.chain,
			mint_decimals = excluded.mint_decimals, owner_user_id = excluded.owner_user_id,
			is_active = true, updated_at = now()
	`;
	await logAction({ kind: 'list_asset', actorAgentId: row.agent_id, detail: { item: 'avatar', avatar_id: row.avatar_id, price_three: priceWhole, blurb: pick(ASSET_BLURBS), seller: row.name } });
	return { kind: 'list_asset', seller: row.name, avatar_id: row.avatar_id, price_three: priceWhole };
}

// A buyer agent purchases a listed avatar. Real $THREE SPL transfer tagged with the
// Solana-Pay reference, validated on-chain, then asset_purchases is confirmed and
// both sides notified — the same settlement the buy-asset endpoint performs.
async function actionBuyAsset(ctx) {
	const { conn, pool, network } = ctx;
	const listings = await sql`
		select ap.item_type, ap.item_id, ap.owner_user_id, ap.amount
		from asset_prices ap
		where ap.is_active = true and ap.currency_mint = ${THREE_MINT()} and ap.item_type = 'avatar'
		  and exists (
			select 1 from agent_identities ai
			where ai.user_id = ap.owner_user_id and (ai.meta->>'circulation') = 'true' and ai.deleted_at is null
		  )
	`;
	if (!listings.length) throw new Skip('no avatars listed for sale');
	const listing = pick(listings);

	const candidates = pool.filter((a) => a.userId !== listing.owner_user_id);
	if (!candidates.length) throw new Skip('no eligible buyer');
	const buyer = pick(candidates);

	const [owned] = await sql`
		select 1 from asset_purchases
		where buyer_user_id = ${buyer.userId} and item_type = 'avatar' and item_id = ${listing.item_id}
		  and status = 'confirmed' limit 1
	`;
	if (owned) throw new Skip('buyer already owns this avatar');

	const [payoutRow] = await sql`
		select address from agent_payout_wallets
		where user_id = ${listing.owner_user_id} and chain = 'solana' and is_default = true
		order by created_at asc limit 1
	`;
	const payout = payoutRow?.address;
	if (!payout) throw new Skip('seller payout wallet missing');

	const amountAtomic = BigInt(listing.amount);
	await ensureThree(ctx, buyer, amountAtomic);

	const { Keypair, PublicKey } = await import('@solana/web3.js');
	const { findReference, validateTransfer } = await import('@solana/pay');
	const BigNumber = (await import('bignumber.js')).default;

	const referenceKp = Keypair.generate();
	const reference = referenceKp.publicKey.toBase58();

	const [pur] = await sql`
		insert into asset_purchases
			(buyer_user_id, item_type, item_id, seller_user_id, status, reference,
			 amount, currency_mint, chain, payout_address, expires_at)
		values
			(${buyer.userId}, 'avatar', ${listing.item_id}, ${listing.owner_user_id}, 'pending', ${reference},
			 ${listing.amount}, ${THREE_MINT()}, 'solana', ${payout}, now() + interval '15 minutes')
		returning id
	`;

	const buyerKp = await senderKeypair(buyer, 'circulation_asset_purchase');
	let txSig;
	try {
		txSig = await transferThreeWithReference(conn, buyerKp, payout, amountAtomic, referenceKp.publicKey, network);
	} catch (e) {
		await sql`update asset_purchases set status = 'expired' where id = ${pur.id} and status = 'pending'`.catch(() => {});
		throw new Skip(`asset payment failed: ${e?.message?.slice(0, 160)}`);
	}

	const expected = new BigNumber(String(amountAtomic)).dividedBy(new BigNumber(10).pow(THREE_DECIMALS));
	try {
		await findReference(conn, referenceKp.publicKey, { finality: 'confirmed' });
		await validateTransfer(
			conn, txSig,
			{ recipient: new PublicKey(payout), amount: expected, splToken: new PublicKey(THREE_MINT()), reference: referenceKp.publicKey },
			{ commitment: 'confirmed' },
		);
	} catch (e) {
		throw new Skip(`asset transfer not validated: ${e?.message?.slice(0, 160)}`);
	}

	await sql`
		update asset_purchases set status = 'confirmed', tx_signature = ${txSig}, confirmed_at = now(), updated_at = now()
		where id = ${pur.id} and status = 'pending'
	`;
	const priceThree = Number(amountAtomic / 10n ** BigInt(THREE_DECIMALS));
	await insertNotification(listing.owner_user_id, 'asset_purchased', {
		item_type: 'avatar', item_id: listing.item_id, amount: String(listing.amount), currency_mint: THREE_MINT(), tx_signature: txSig, purchase_id: pur.id,
	}).catch(() => {});
	await insertNotification(buyer.userId, 'asset_purchase_confirmed', {
		item_type: 'avatar', item_id: listing.item_id, amount: String(listing.amount), currency_mint: THREE_MINT(), tx_signature: txSig, purchase_id: pur.id,
	}).catch(() => {});

	await recordCustodyEvent({
		agentId: buyer.id,
		userId: buyer.userId,
		eventType: 'spend',
		category: 'marketplace',
		network,
		asset: 'THREE',
		amountRaw: amountAtomic,
		destination: payout,
		signature: txSig,
		status: 'confirmed',
		reason: 'asset_purchase',
		idempotencyKey: `assetbuy:${txSig}`,
		meta: { source: 'marketplace_asset', item_type: 'avatar', amount_three: priceThree, decimals: THREE_DECIMALS, to: payout, block_time: new Date().toISOString() },
	}).catch((e) => console.warn('[circulation] custody event failed', e?.message));

	await logAction({ kind: 'buy_asset', network, actorAgentId: buyer.id, signature: txSig, detail: { item: 'avatar', avatar_id: listing.item_id, buyer: buyer.name, amount_three: priceThree } });
	return { kind: 'buy_asset', buyer: buyer.name, avatar_id: listing.item_id, three: priceThree, signature: txSig };
}

// Register an agent's on-chain (ERC-8004) identity. Funds the agent's EVM wallet
// for gas from the EVM treasury, pins an agent card, signs register(string), and
// confirms it through the platform's verify endpoint. Gated behind an EVM
// treasury secret — skipped cleanly when unset.
async function actionDeploy(ctx) {
	const { pool, origin, cfg } = ctx;
	if (!cfg.evmTreasurySecret) throw new Skip('EVM treasury not configured');

	const { Wallet, Contract, parseEther, formatEther } = await import('ethers');
	const { evmFallbackProvider } = await import('./evm/rpc.js');
	const chainId = cfg.evmChainId;
	const chain = CHAIN_BY_ID[chainId];
	if (!chain) throw new Skip(`unsupported EVM chain ${chainId}`);
	const registryAddr = chain.registry;

	// Pick an agent not yet registered on-chain.
	const candidates = pool.filter((a) => !a.meta?.onchain);
	const agent = candidates.length ? pick(candidates) : null;
	if (!agent) throw new Skip('all agents already deployed on-chain');

	const provider = await evmFallbackProvider(chainId);
	const treasury = new Wallet(cfg.evmTreasurySecret, provider);

	const { address: evmAddress } = await getOrCreateAgentEvmWallet(agent.id, { chainId });

	// Fund gas if the agent wallet is light.
	const bal = await provider.getBalance(evmAddress);
	const gasFloor = parseEther('0.00025');
	if (bal < gasFloor) {
		const tbal = await provider.getBalance(treasury.address);
		const topUp = gasFloor - bal;
		if (tbal < topUp + parseEther('0.0001')) throw new Skip(`EVM treasury low (${formatEther(tbal)} ETH)`);
		const fundTx = await treasury.sendTransaction({ to: evmAddress, value: topUp });
		await fundTx.wait();
	}

	// Build + pin the agent card the registry URI will resolve to.
	const card = await buildAgentCard(agent, origin);
	const pinned = await pinToIPFS(Buffer.from(JSON.stringify(card, null, 2)), 'agent.json').catch(() => null);
	const uri = pinned?.uri;
	if (!uri) throw new Skip('could not pin agent card');

	// Recover the agent's EVM key and register on-chain.
	const full = await loadAgentMeta(agent.id);
	const encKey = full?.meta?.encrypted_wallet_key;
	if (!encKey) throw new Skip('agent has no EVM key');
	const pkHex = await recoverAgentKey(encKey, { agentId: agent.id, userId: agent.userId, reason: 'circulation_deploy' });
	const signer = new Wallet(pkHex, provider);
	const registry = new Contract(
		registryAddr,
		['function register(string) returns (uint256)', 'event Registered(uint256 indexed agentId, string metadataURI, address indexed owner)'],
		signer,
	);
	const tx = await registry['register(string)'](uri);
	const receipt = await tx.wait();

	// Parse the Registered event for the assigned agent id.
	let onChainId = null;
	for (const lg of receipt.logs || []) {
		try {
			const parsed = registry.interface.parseLog(lg);
			if (parsed?.name === 'Registered') { onChainId = parsed.args[0].toString(); break; }
		} catch { /* not our event */ }
	}
	if (!onChainId) throw new Error('Registered event not found in receipt');

	// Confirm + bind through the platform endpoint (writes the on-chain index + badge).
	const confirm = await postAs(origin, agent.userId, '/api/erc8004/register-confirm', {
		chainId,
		txHash: receipt.hash,
		agentId: onChainId,
		metadataUri: uri,
		ownerAddress: evmAddress,
		agentDbId: agent.id,
	}, 30_000);
	if (confirm.status !== 200) throw new Error(`register-confirm ${confirm.status}: ${confirm.body?.error || 'failed'}`);

	await logAction({ kind: 'deploy', actorAgentId: agent.id, signature: receipt.hash, detail: { chainId, onChainId, agent: agent.name } });
	return { kind: 'deploy', agent: agent.name, chainId, onChainId, txHash: receipt.hash };
}

async function buildAgentCard(agent, origin) {
	let image = null;
	let glb = null;
	if (agent.avatarId) {
		const [av] = await sql`select storage_key, thumbnail_key from avatars where id = ${agent.avatarId} and deleted_at is null limit 1`;
		if (av?.thumbnail_key) image = r2PublicUrl(av.thumbnail_key);
		if (av?.storage_key) glb = r2PublicUrl(av.storage_key);
	}
	return {
		name: agent.name,
		description: agent.meta?.description || `${agent.name}, an autonomous agent on three.ws`,
		image: image || `${origin}/og.png`,
		url: `${origin}/agent/${agent.id}`,
		active: true,
		x402Support: true,
		services: glb ? [{ name: 'avatar', endpoint: glb, type: 'model/gltf-binary' }] : [],
	};
}

// ── tick orchestration ────────────────────────────────────────────────────────

// Choose the action mix for this tick. Launch/deploy are heavyweight and run
// solo. Everything else can batch up to actionsPerTick.
async function planActions(cfg, poolSize) {
	const plan = [];
	const launchesToday = await recentCount('launch', '1 day');
	const deploysToday = await recentCount('deploy', '1 day');
	const launchesHour = await recentCount('launch', '45 minutes');

	// Heavyweight, low-frequency, solo actions get first refusal.
	const r = Math.random();
	if (poolSize >= 2 && launchesHour === 0 && launchesToday < 8 && r < 0.14) {
		return ['launch'];
	}
	if (cfg.evmTreasurySecret && poolSize >= 1 && deploysToday < 6 && r >= 0.14 && r < 0.2) {
		return ['deploy'];
	}

	// Bootstrap / replenish marketplace inventory first so there's always
	// something to buy. A seller lists skills until each agent averages a few
	// listings; avatars get listed at about half that rate.
	const [{ c: listedSkillCount }] = await sql`
		select count(*)::int as c from agent_skill_prices asp
		join agent_identities ai on ai.id = asp.agent_id
		where asp.is_active = true and asp.currency_mint = ${THREE_MINT()}
		  and (ai.meta->>'circulation') = 'true' and ai.deleted_at is null
	`;
	const [{ c: listedAssetCount }] = await sql`
		select count(*)::int as c from asset_prices ap
		where ap.is_active = true and ap.currency_mint = ${THREE_MINT()} and ap.item_type = 'avatar'
		  and exists (select 1 from agent_identities ai where ai.user_id = ap.owner_user_id and (ai.meta->>'circulation') = 'true')
	`;
	// Keep marketplace inventory ahead of demand — buy_skill is now the dominant
	// action, so each agent should average ~3 active listings so a buyer can always
	// find a fresh skill it doesn't already own.
	if (listedSkillCount < poolSize * 3) plan.push('list_skill');
	if (listedAssetCount < Math.floor(poolSize / 2)) plan.push('list_asset');

	// Fill the remaining budget with light actions. Weighted HARD toward real
	// marketplace purchases (value delivered + take-rate earned) — the honest signal
	// we want to grow — and away from the bare p2p `payment` transfer, which moves
	// SOL but delivers nothing and only padded the x402 counter.
	const weighted = [
		['buy_skill', 34],
		['tip', 18],
		['trade', 12],
		['trial', 12],
		['buy_asset', 8],
		['review', 8],
		['payment', 6],
	];
	const total = weighted.reduce((s, [, w]) => s + w, 0);
	while (plan.length < cfg.actionsPerTick) {
		let roll = Math.random() * total;
		for (const [kind, w] of weighted) {
			roll -= w;
			if (roll <= 0) { plan.push(kind); break; }
		}
	}
	return plan;
}

const ACTIONS = {
	tip: actionTip,
	payment: actionPayment,
	trade: actionTrade,
	launch: actionLaunch,
	review: actionReview,
	deploy: actionDeploy,
	list_skill: actionListSkill,
	buy_skill: actionBuySkill,
	trial: actionTrial,
	list_asset: actionListAsset,
	buy_asset: actionBuyAsset,
};

/**
 * Run one activity tick. Safe to call on a schedule; fully inert unless enabled
 * and funded. Never throws — every failure is contained and reported.
 */
export async function runCirculationTick() {
	const cfg = config();
	if (!cfg.enabled) return { ok: true, skipped: 'disabled' };

	await ensureSchema();

	// Grow the pool toward target, up to growthPerTick new agents per tick so a
	// large target (hundreds–thousands) fills in a reasonable number of ticks.
	let pool = await loadPool();
	const grew = [];
	let createdAny = false;
	for (let i = 0; i < cfg.growthPerTick && pool.length + i < cfg.poolTarget; i++) {
		try {
			const r = await createPoolAgent();
			if (!r) break; // safety ceiling hit
			grew.push(r);
			if (r.created) createdAny = true;
		} catch (e) {
			console.warn('[circulation] pool growth failed', e?.message);
			break;
		}
	}
	if (createdAny) pool = await loadPool();

	if (pool.length < 2) {
		return { ok: true, pool: pool.length, grew, note: 'pool warming up' };
	}

	let treasuryKp;
	try {
		treasuryKp = await treasuryKeypair(cfg);
	} catch (e) {
		if (e instanceof Skip) return { ok: true, pool: pool.length, grew, skipped: e.message };
		throw e;
	}

	const conn = solanaConnection(cfg.network);
	let solUsd = null;
	try { solUsd = await solUsdPrice(); } catch { /* usd is decoration */ }

	const ctx = { conn, treasuryKp, pool, network: cfg.network, origin: cfg.origin, solUsd, cfg };
	const plan = await planActions(cfg, pool.length);

	const results = [];
	for (const kind of plan) {
		const fn = ACTIONS[kind];
		if (!fn) continue;
		try {
			results.push({ ok: true, ...(await fn(ctx)) });
		} catch (e) {
			if (e instanceof Skip) {
				results.push({ ok: false, kind, skipped: e.message });
				await logAction({ kind, network: cfg.network, status: 'skipped', detail: { reason: e.message } });
			} else {
				console.error('[circulation] action failed', kind, e?.message);
				results.push({ ok: false, kind, error: e?.message });
				await logAction({ kind, network: cfg.network, status: 'error', detail: { error: e?.message?.slice(0, 300) } });
			}
		}
	}

	return { ok: true, pool: pool.length, grew, network: cfg.network, actions: results };
}
