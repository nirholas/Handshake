// Agora — human citizen service (Task 08, see docs/agora.md § Citizens).
//
// A human citizen is a signed-in user living in Agora. To transact on AgenC
// (post/escrow, hire, claim, complete) the server signs on their behalf from a
// CUSTODIAL Solana wallet provisioned on join — the same mechanism agents use
// (api/_lib/agent-wallet.js). The secret is AES-256-GCM encrypted at rest in
// agora_citizens.meta and never leaves the server.
//
// Everything here projects into the SAME agora_activity ledger + feed an agent
// would: there is no separate "fake human" path. On-chain is the source of
// truth; agora_* is the world-layer projection (docs/agora.md invariant 3).
//
// On-chain calls go through @three-ws/solana-agent, imported LAZILY so this
// module (and the act endpoint) load even where that SDK isn't built — the same
// discipline as the passport reconcile in api/agora/[action].js.

import { createHash } from 'node:crypto';
import { sql } from './db.js';
import { confirmOrThrow, sendAndConfirm } from './solana/confirm.js';
import { generateSolanaAgentWallet, getSolanaAddressBalances } from './agent-wallet.js';
import { decryptSecret } from './secret-box.js';
import { TOKEN_MINT, TOKEN_DECIMALS } from './token/config.js';
import { publishFeedEvent } from './feed.js';

// AgenC devnet minAgentStake (matches examples/agenc-task-roundtrip/run.mjs).
const MIN_STAKE_LAMPORTS = 1_000_000;
// Default reward used when a hire/claim needs a tx-fee floor on devnet.
const LAMPORTS_PER_SOL = 1_000_000_000;

// Human citizens are generalists: they assert capability by actually delivering
// a real proof, so we register them with the full profession bitmap (all 8 bits)
// rather than a curated subset. AgenC's claim/complete still gates them — a
// claim only sticks if their capabilities cover the task's requiredCapabilities,
// and completion requires a real proofHash. (Mirrors the open-registry rule in
// docs/agora.md — never a hardcoded allowlist.)
const HUMAN_CAPABILITIES = 0xffn;

// Profession ↔ capability-bit map — mirrors docs/agora.md and the PROFESSIONS
// array in api/agora/[action].js (the canonical source is the doc). Used to turn
// a human's chosen target profession into a task's requiredCapabilities bitmap.
export const PROFESSION_BITS = {
	fetcher: 0,
	sculptor: 1,
	scribe: 2,
	cartographer: 3,
	crier: 4,
	appraiser: 5,
	verifier: 6,
	namekeeper: 7,
};

export function professionToCapabilityBits(profession) {
	const bit = PROFESSION_BITS[String(profession || '').toLowerCase()];
	if (bit == null) return 0n;
	return 1n << BigInt(bit);
}

function pickRpc(cluster) {
	const override = (process.env.AGENC_RPC_URL || '').trim();
	if (override) return override;
	if (cluster === 'devnet') return (process.env.AGENC_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL_DEVNET || '').trim() || undefined;
	return (process.env.SOLANA_RPC_URL || '').trim() || undefined;
}

// Deterministically scatter a citizen across the Commons plaza from a stable id
// so their home/spawn is consistent run to run (no Math.random in a projection).
function homeForId(id) {
	const h = createHash('sha256').update(String(id)).digest();
	const angle = (h[0] / 255) * Math.PI * 2;
	const radius = 6 + (h[1] / 255) * 14; // 6..20 units from the board
	return {
		x: Math.round(Math.cos(angle) * radius * 100) / 100,
		z: Math.round(Math.sin(angle) * radius * 100) / 100,
	};
}

function shortName(user) {
	return (user.display_name || user.username || 'three.ws citizen').toString().slice(0, 60);
}

// ── Citizen provisioning ──────────────────────────────────────────────────────

/**
 * Idempotently get-or-create the human citizen for a signed-in user. Provisions
 * a custodial Solana wallet on first join, places them in the Commons, and fires
 * a member-join feed event for a genuinely new arrival. Does NOT touch the chain
 * — AgenC registration is lazy (ensureRegistered), so joining is instant and
 * works offline of any RPC.
 *
 * @returns {Promise<{ citizen: object, created: boolean }>}
 */
export async function ensureHumanCitizen({ user, cluster = 'devnet' }) {
	const [existing] = await sql`
		select * from agora_citizens where user_id = ${user.id} and kind = 'human' limit 1
	`;
	if (existing) {
		// Keep the live presence fresh + repair a missing wallet (never hand a
		// downstream signer an empty secret).
		if (!existing.meta?.encrypted_solana_secret) {
			const wallet = await generateSolanaAgentWallet();
			const meta = { ...(existing.meta || {}), solana_address: wallet.address, encrypted_solana_secret: wallet.encrypted_secret, solana_wallet_source: 'generated' };
			const [repaired] = await sql`
				update agora_citizens set meta = ${JSON.stringify(meta)}::jsonb, last_active_at = now()
				where id = ${existing.id} returning *`;
			return { citizen: repaired, created: false };
		}
		const [touched] = await sql`
			update agora_citizens set last_active_at = now() where id = ${existing.id} returning *`;
		return { citizen: touched, created: false };
	}

	const wallet = await generateSolanaAgentWallet();
	const home = homeForId(user.id);
	const meta = {
		solana_address: wallet.address,
		encrypted_solana_secret: wallet.encrypted_secret,
		solana_wallet_source: 'generated',
		handle: user.username || null,
	};
	const [citizen] = await sql`
		insert into agora_citizens
			(kind, user_id, display_name, avatar_url, agenc_cluster, status,
			 capability_bits, home_x, home_z, pos_x, pos_z, meta)
		values
			('human', ${user.id}, ${shortName(user)}, ${user.avatar_url || null}, ${cluster}, 'idle',
			 ${HUMAN_CAPABILITIES}, ${home.x}, ${home.z}, ${home.x}, ${home.z}, ${JSON.stringify(meta)}::jsonb)
		returning *
	`;

	// A real arrival on the ticker (throttled inside the feed lib).
	publishFeedEvent({
		type: 'member-join',
		actor: shortName(user).slice(0, 32),
		handle: user.username || undefined,
	}).catch(() => {});

	return { citizen, created: true };
}

// ── On-chain plumbing ─────────────────────────────────────────────────────────

/** Decrypt the citizen's custodial secret into a Solana Keypair (server-only). */
export async function recoverCitizenKeypair(citizen) {
	const enc = citizen.meta?.encrypted_solana_secret;
	if (!enc) throw Object.assign(new Error('citizen has no custodial wallet'), { status: 409, code: 'no_wallet' });
	const { Keypair } = await import('@solana/web3.js');
	const secretB64 = await decryptSecret(enc);
	return Keypair.fromSecretKey(Buffer.from(secretB64, 'base64'));
}

async function buildClient(cluster, signer) {
	const { createAgenCClient } = await import('@three-ws/solana-agent');
	return createAgenCClient({ cluster, rpcUrl: pickRpc(cluster), signer });
}

/** Solana Explorer tx URL for a cluster (mainnet drops the cluster query). */
export function explorerTx(sig, cluster) {
	return cluster === 'mainnet'
		? `https://explorer.solana.com/tx/${sig}`
		: `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

// The devnet faucet lives on the PUBLIC devnet endpoint. Keyed providers
// (Helius and friends) either rate-limit requestAirdrop into a 429 storm or
// don't proxy it at all, so a citizen's first bounty died with a raw
// "Attempt to debit an account but found no record of a prior credit".
const PUBLIC_DEVNET_FAUCET = 'https://api.devnet.solana.com';

// Airdrop sources to try, in order: whatever RPC we're already on, then the
// public faucet endpoint (deduped when they're the same host).
async function faucetSources(connection) {
	const sources = [connection];
	const current = String(connection?.rpcEndpoint || '').toLowerCase();
	if (!current.includes('api.devnet.solana.com')) {
		const { Connection } = await import('@solana/web3.js');
		sources.push(new Connection(PUBLIC_DEVNET_FAUCET, 'confirmed'));
	}
	return sources;
}

// Top up a devnet wallet from the faucet with backoff: mirrors the roundtrip
// example. Mainnet never airdrops: an underfunded mainnet wallet is an honest,
// actionable error, not a silent failure. Returns the final balance; callers
// that are about to sign must gate on requireFunded(), because a rate-limited
// faucet is a normal devnet condition, not an exception.
export async function ensureDevnetBalance(connection, keypair, neededLamports) {
	let bal = await connection.getBalance(keypair.publicKey);
	if (bal >= neededLamports) return bal;
	const sources = await faucetSources(connection);
	const chunks = [LAMPORTS_PER_SOL, LAMPORTS_PER_SOL / 2, LAMPORTS_PER_SOL / 4];
	for (let i = 0; i < chunks.length; i++) {
		for (const src of sources) {
			try {
				const sig = await src.requestAirdrop(keypair.publicKey, Math.max(chunks[i], LAMPORTS_PER_SOL / 50));
				// HTTP-polling confirm (no WebSocket); bounded so a dropped devnet airdrop
				// falls through to the next source/chunk instead of hanging the window.
				await confirmOrThrow(src, sig, 'confirmed', { timeoutMs: 30_000 });
			} catch {
				continue; // this source is dry/throttled: try the next one
			}
			bal = await connection.getBalance(keypair.publicKey);
			if (bal >= neededLamports) return bal;
		}
		await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
	}
	return connection.getBalance(keypair.publicKey);
}

/**
 * Recover a result from a confirm timeout.
 *
 * web3.js gives up waiting after ~30s and throws "Transaction was not confirmed
 * in 30.00 seconds. It is unknown if it succeeded or failed. Check signature X".
 * On a throttled devnet that happens constantly, and treating it as a failure is
 * wrong in the worst way: the work IS on-chain (escrow paid, reputation moved)
 * but the world never projects it, so a citizen loses a completion they really
 * earned. The signature is right there in the message, so look it up and decide
 * from the ledger instead of from the timeout.
 *
 * @returns {Promise<{ txSignature: string } | null>} the confirmed signature, or
 *   null when the error is not a recoverable timeout / the tx genuinely failed.
 */
export async function recoverTimedOutSignature(connection, err) {
	const msg = String(err?.message || '');
	if (!/not confirmed in|unknown if it succeeded/i.test(msg)) return null;
	const found = /signature\s+([1-9A-HJ-NP-Za-km-z]{80,90})/.exec(msg);
	if (!found) return null;
	const signature = found[1];
	// Bounded poll: the tx was already submitted, we only need the ledger to catch up.
	for (let i = 0; i < 5; i++) {
		let status = null;
		try {
			const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
			status = res?.value?.[0] || null;
		} catch {
			// transport still down: try again, then give up and let the caller 503
		}
		if (status?.err) return null;          // it landed and FAILED: a real failure
		if (status?.confirmationStatus) return { txSignature: signature };
		await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
	}
	return null;
}

/**
 * Find the signature that completed a task, for a completion we know landed but
 * never captured (a confirm that timed out, then a retry that correctly bounced
 * off the already-consumed claim account).
 *
 * The chain records `completedAt` on the task, and the completing transaction is
 * the worker's own signature at that block time, so the two identify each other
 * without guessing. Returns null when nothing matches, which keeps the caller on
 * its honest error path rather than projecting a completion we cannot evidence.
 */
export async function findCompletionSignature(connection, signerPublicKey, completedAt) {
	const at = Number(completedAt || 0);
	if (!at) return null;
	const sigs = await connection.getSignaturesForAddress(signerPublicKey, { limit: 30 }).catch(() => []);
	const hit = sigs.find((s) => !s.err && Number(s.blockTime) === at);
	return hit ? hit.signature : null;
}

function fmtSol(lamports) {
	return (Number(lamports) / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/**
 * Assert a wallet can cover `neededLamports` BEFORE anything is signed. An
 * underfunded wallet is a designed, actionable state ("fund this address"), so
 * it must never reach the RPC and come back as a raw simulation failure the
 * caller renders as an opaque 500.
 *
 * Throws a typed error ({ status: 409, code: 'insufficient_funds', detail })
 * that api/agora/act.js surfaces verbatim.
 */
export async function requireFunded({ connection, address, neededLamports, cluster, purpose }) {
	const bal = await connection.getBalance(address);
	if (bal >= neededLamports) return bal;
	const walletAddress = address?.toBase58 ? address.toBase58() : String(address);
	const hint = cluster === 'devnet'
		? 'The devnet faucet is rate-limiting airdrops right now. Send devnet SOL to this address, or try again in a few minutes.'
		: 'Send SOL to this address to cover the network fee.';
	throw Object.assign(
		new Error(`Your Agora wallet needs about ${fmtSol(neededLamports)} SOL to ${purpose} and holds ${fmtSol(bal)}. ${hint}`),
		{
			status: 409,
			code: 'insufficient_funds',
			detail: {
				walletAddress, cluster, asset: 'SOL',
				neededSol: Number((Number(neededLamports) / LAMPORTS_PER_SOL).toFixed(6)),
				haveSol: Number((Number(bal) / LAMPORTS_PER_SOL).toFixed(6)),
			},
		},
	);
}

/**
 * Ensure the human citizen is registered as an AgenC agent on `cluster`, signing
 * with their custodial wallet. Lazy + idempotent: returns the existing on-chain
 * agent if present, otherwise funds (devnet), registers, persists the canonical
 * id/PDA, and projects a 'registered' activity row + feed event.
 *
 * @returns {Promise<{ agentId: Uint8Array, agentIdHex: string, agentPda: string, signer: object, client: object, citizen: object }>}
 */
export async function ensureRegistered({ citizen, cluster }) {
	const {
		registerAgenCAgent, getAgenCAgent, deriveAgenCAgentPda, toAgenCAgentId,
		buildThreewsMetadataUri, agenCAgentIdToHex,
	} = await import('@three-ws/solana-agent');

	const signer = await recoverCitizenKeypair(citizen);
	const client = await buildClient(cluster, signer);

	const label = `agora-human-${citizen.id}`;
	const agentId = toAgenCAgentId(label);
	const agentPda = deriveAgenCAgentPda(client, agentId);

	const registered = async () => {
		if (citizen.agenc_agent_pda !== agentPda.toBase58() || citizen.agenc_cluster !== cluster) {
			await sql`
				update agora_citizens
				set agenc_agent_id = ${agenCAgentIdToHex(agentId)}, agenc_agent_pda = ${agentPda.toBase58()},
				    agenc_cluster = ${cluster}, identity_source = 'handle', synced_at = now()
				where id = ${citizen.id}`;
		}
		return { agentId, agentIdHex: agenCAgentIdToHex(agentId), agentPda: agentPda.toBase58(), signer, client, citizen };
	};

	// RegisterAgent is NOT idempotent: a second call against a live PDA aborts the
	// whole action with "account already in use", which is how a human's very first
	// claim died moments after their first bounty registered them. So we must be
	// certain an agent is ABSENT before registering, and three sources say so in
	// descending cost order:
	//
	//  1. Our own projection. We write agenc_agent_pda only after a registration
	//     confirms, so a matching row is proof, and it costs no RPC at all, which
	//     keeps the hot path alive when devnet is throttling every read.
	if (citizen.agenc_agent_pda === agentPda.toBase58() && citizen.agenc_cluster === cluster) {
		return { agentId, agentIdHex: agenCAgentIdToHex(agentId), agentPda: agentPda.toBase58(), signer, client, citizen };
	}

	//  2. A decoded on-chain agent.
	const existingOnChain = await getAgenCAgent(client, agentPda).catch(() => null);
	if (existingOnChain) return registered();

	//  3. A raw account at the PDA owned by the AgenC program. getAgenCAgent
	//     returns null for a decode miss AND for a transport hiccup, so absence
	//     has to be confirmed by a read that actually SUCCEEDED. If even this read
	//     fails we refuse to guess: registering blind on an unread chain is what
	//     produced the account-in-use abort in the first place.
	let raw;
	try {
		raw = await client.connection.getAccountInfo(agentPda);
	} catch (err) {
		throw Object.assign(
			new Error('Solana is not responding, so we could not confirm your on-chain citizen record. Nothing was signed. Try again in a moment.'),
			{ status: 503, code: 'rpc_unavailable', detail: { retryable: true, cluster }, cause: err },
		);
	}
	if (raw && raw.owner.equals(client.programId)) return registered();

	// Fund (devnet) enough for the stake + tx fees, then register. The gate runs
	// on BOTH clusters: registration stakes lamports and pays a fee either way,
	// and a dry wallet must read as "fund this address", never as a simulation
	// failure from inside the SDK.
	const registerNeeds = MIN_STAKE_LAMPORTS + 10_000_000;
	if (cluster === 'devnet') {
		await ensureDevnetBalance(client.connection, signer, registerNeeds);
	}
	await requireFunded({
		connection: client.connection, address: signer.publicKey,
		neededLamports: registerNeeds, cluster, purpose: 'register you as a citizen on-chain',
	});

	const metadataUri = buildThreewsMetadataUri({ handle: citizen.meta?.handle || citizen.id });
	const result = await registerAgenCAgent(client, {
		agentId,
		capabilities: HUMAN_CAPABILITIES,
		endpoint: `https://three.ws/agora/citizen/${citizen.id}`,
		metadataUri,
		stakeAmount: MIN_STAKE_LAMPORTS,
	});

	const idHex = agenCAgentIdToHex(agentId);
	await sql`
		update agora_citizens
		set agenc_agent_id = ${idHex}, agenc_agent_pda = ${result.agentPda.toBase58()},
		    agenc_cluster = ${cluster}, identity_source = 'handle',
		    stake_lamports = ${MIN_STAKE_LAMPORTS}, synced_at = now(), last_active_at = now()
		where id = ${citizen.id}`;

	await projectActivity({
		citizenId: citizen.id,
		kind: 'registered',
		txSignature: result.txSignature,
		narrative: `${citizen.display_name} joined Agora as a citizen.`,
		worldX: citizen.home_x, worldZ: citizen.home_z,
	});

	publishFeedEvent({
		type: 'agora-registered',
		actor: citizen.display_name.slice(0, 32),
		citizenId: citizen.id,
		agentPda: result.agentPda.toBase58(),
		profession: citizen.profession || null,
		narrative: `${citizen.display_name} joined Agora`,
	}).catch(() => {});

	return { agentId, agentIdHex: idHex, agentPda: result.agentPda.toBase58(), signer, client, citizen };
}

// ── Projection writers ────────────────────────────────────────────────────────

/**
 * Append an agora_activity row. Idempotent on (citizen, kind, tx_signature) via
 * the unique index from the world migration — a re-run of the same on-chain
 * action never double-projects. Returns the row (or the existing one on conflict).
 */
export async function projectActivity(a) {
	const [row] = await sql`
		insert into agora_activity
			(citizen_id, kind, task_pda, task_id, profession, counterparty_citizen_id,
			 amount_atomic, reward_mint, reward_label, tx_signature, proof_hash,
			 deliverable_url, narrative, rep_before, rep_after, world_x, world_z, meta)
		values
			(${a.citizenId}, ${a.kind}, ${a.taskPda || null}, ${a.taskId || null},
			 ${a.profession || null}, ${a.counterpartyCitizenId || null},
			 ${a.amountAtomic != null ? a.amountAtomic : null}, ${a.rewardMint || null},
			 ${a.rewardLabel || null}, ${a.txSignature || null}, ${a.proofHash || null},
			 ${a.deliverableUrl || null}, ${a.narrative}, ${a.repBefore ?? null},
			 ${a.repAfter ?? null}, ${a.worldX ?? null}, ${a.worldZ ?? null},
			 ${JSON.stringify(a.meta || {})}::jsonb)
		on conflict (citizen_id, kind, tx_signature) where tx_signature is not null
		do nothing
		returning *
	`;
	return row || null;
}

/** Patch a citizen's cumulative world stats + live status. */
export async function bumpCitizenStats(citizenId, patch = {}) {
	const sets = [];
	if (patch.status) sets.push(sql`status = ${patch.status}`);
	if (patch.incPosted) sets.push(sql`tasks_posted = tasks_posted + ${patch.incPosted}`);
	if (patch.incCompleted) sets.push(sql`tasks_completed = tasks_completed + ${patch.incCompleted}`);
	if (patch.addEarnedAtomic) sets.push(sql`earned_three_atomic = earned_three_atomic + ${patch.addEarnedAtomic}`);
	if (patch.setReputation != null) sets.push(sql`reputation = ${patch.setReputation}`);
	sets.push(sql`last_active_at = now()`);

	let assignment = sets[0];
	for (let i = 1; i < sets.length; i++) assignment = sql`${assignment}, ${sets[i]}`;
	const [row] = await sql`update agora_citizens set ${assignment} where id = ${citizenId} returning *`;
	return row;
}

// ── Read helpers ──────────────────────────────────────────────────────────────

/**
 * Read the citizen's live custodial balances. Returns SOL always, plus $THREE on
 * mainnet (the economy's coin). Never throws — an RPC hiccup yields nulls so the
 * HUD degrades to "balance unavailable" rather than erroring.
 */
export async function citizenBalances(citizen, cluster) {
	const address = citizen.meta?.solana_address;
	if (!address) return { sol: null, three: null, address: null };
	const { sol } = await getSolanaAddressBalances(address, cluster).catch(() => ({ sol: null }));
	let three = null;
	if (cluster === 'mainnet') {
		three = await readThreeBalance(address).catch(() => null);
	}
	return { sol, three, address };
}

async function readThreeBalance(address) {
	const { PublicKey } = await import('@solana/web3.js');
	const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
	const { solanaConnection } = await import('./agent-pumpfun.js');
	const conn = solanaConnection('mainnet');
	const owner = new PublicKey(address);
	const ata = getAssociatedTokenAddressSync(new PublicKey(TOKEN_MINT), owner, false);
	try {
		const bal = await conn.getTokenAccountBalance(ata);
		return bal?.value?.uiAmount ?? 0;
	} catch {
		return 0; // no ATA yet → zero $THREE
	}
}

/** $THREE atomic-units multiplier as a BigInt. */
export const THREE_ATOMICS_PER_TOKEN = 10n ** BigInt(TOKEN_DECIMALS);

/** Human label for a reward, e.g. "25,000 $THREE" or "0.05 SOL". */
export function rewardLabel(amountAtomic, cluster) {
	const a = BigInt(amountAtomic);
	if (cluster === 'mainnet') {
		const whole = a / THREE_ATOMICS_PER_TOKEN;
		return `${whole.toLocaleString('en-US')} $THREE`;
	}
	const sol = Number(a) / LAMPORTS_PER_SOL;
	return `${sol} SOL`;
}

/** sha256(deliverable) as a 32-byte hex proof, the same shape AgenC expects. */
export function proofHashFor(deliverable) {
	return createHash('sha256').update(String(deliverable), 'utf8').digest('hex');
}

// SPL Memo program — the canonical way to write a small, signed, on-chain note.
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Leave a real on-chain attestation (a signed SPL-memo transaction) from the
 * citizen's custodial wallet. Used by `vouch`: a verifiable, cheap, permanent
 * record that this citizen attested to another's work — the on-chain proof the
 * agora_vouches edge and the 'vouched' activity row cite. Returns the tx sig.
 */
export async function sendOnchainAttestation({ cluster, signer, memo }) {
	const { Connection, Transaction, TransactionInstruction, PublicKey } =
		await import('@solana/web3.js');
	const rpc = pickRpc(cluster) || (cluster === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
	const conn = new Connection(rpc, 'confirmed');
	if (cluster === 'devnet') await ensureDevnetBalance(conn, signer, 5_000_000);
	const ix = new TransactionInstruction({
		keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }],
		programId: new PublicKey(MEMO_PROGRAM_ID),
		data: Buffer.from(String(memo).slice(0, 500), 'utf8'),
	});
	const tx = new Transaction().add(ix);
	// HTTP-polling send+confirm (no WebSocket subscription).
	return sendAndConfirm(conn, tx, [signer], { commitment: 'confirmed' });
}
