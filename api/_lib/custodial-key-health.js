// @ts-check
// api/_lib/custodial-key-health.js
//
// One measurement of "how much custody have we lost to a key rotation?", shared
// by every surface that asks the question.
//
// A custodial wallet whose `encrypted_solana_secret` no longer decrypts is not a
// degraded wallet, it is a destroyed one: the SOL stays visible on chain and can
// never be signed for again. The 2026-07 Vercel to Cloud Run migration rotated
// WALLET_ENCRYPTION_KEY with no read path back to the retired value, and the
// wallets written under it were sealed permanently (docs/ops/wallet-key-migration.md).
// The balance keeps rendering in the product, the treasury self-heal keeps
// planning to reclaim it, and nothing in either path knows the key is gone.
//
// This module is the single source of that number so the CLI audit
// (scripts/audit-custodial-key-health.mjs) and the ops board
// (/api/ops/payment-outcomes → `stranded_custody`) cannot drift apart. It is
// READ-ONLY: it decrypts in memory to test the key, never writes, never signs,
// never broadcasts.
//
// Two invariants the callers depend on:
//   • Ownership is classified with the SAME predicate the reclaim leg enforces
//     in SQL (isPlatformOwnedAgent below, re-exported by economy-sweepback.js).
//     The audit script used to carry its own copy with a different owner email,
//     which filed 12 platform wallets as CUSTOMER ones and would have inflated
//     the customer support obligation in exactly the report written to size it.
//   • A wallet whose balance was never READ is never counted as zero. Coalescing
//     "unread" into "0" is what let this audit certify "0 SOL stranded" on
//     2026-08-09 while two wallets held 0.12 SOL behind a dead key: every total
//     here sums confirmed reads only, and `counts.stranded_unread` is the flag
//     that says a zero is not yet trustworthy.

import { sql } from './db.js';
import { decryptSecret } from './secret-box.js';

/** The platform's own agent-owner account. Anything else is a customer. */
export const PLATFORM_AGENT_OWNER_EMAIL = 'three-ws@users.three.ws.local';
/** Per-agent mailbox domain the platform issues its own agents. */
export const PLATFORM_AGENT_EMAIL_SUFFIX = '@agents.three.ws';

/** Balances are read in getMultipleAccounts batches of this size. */
const BALANCE_CHUNK = 100;
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * True only for the platform's own agent-owner accounts. Anything else (a real
 * signup, a wallet-auth account, an unknown value) is a customer and is out.
 *
 * @param {string|null|undefined} ownerEmail
 * @returns {boolean}
 */
export function isPlatformOwnedAgent(ownerEmail) {
	if (!ownerEmail || typeof ownerEmail !== 'string') return false;
	const email = ownerEmail.trim().toLowerCase();
	return email === PLATFORM_AGENT_OWNER_EMAIL || email.endsWith(PLATFORM_AGENT_EMAIL_SUFFIX);
}

const round9 = (n) => Number(Number(n).toFixed(9));

/**
 * Every custodial wallet the platform stores a secret for, oldest first.
 *
 * @param {{platformOnly?:boolean}} [opts]
 * @returns {Promise<Array<{agent_id:string,name:string,created_at:string|Date,address:string,secret:string,owner:string}>>}
 */
export async function readCustodialWalletRows({ platformOnly = false } = {}) {
	const rows = await sql`
		SELECT a.id                               AS agent_id,
		       a.name                             AS name,
		       a.created_at                       AS created_at,
		       a.meta->>'solana_address'          AS address,
		       a.meta->>'encrypted_solana_secret' AS secret,
		       LOWER(u.email)                     AS owner
		FROM agent_identities a
		JOIN users u ON u.id = a.user_id
		WHERE a.deleted_at IS NULL
		  AND a.meta->>'solana_address' IS NOT NULL
		  AND a.meta->>'encrypted_solana_secret' IS NOT NULL
		ORDER BY a.created_at ASC
	`;
	return platformOnly ? rows.filter((r) => isPlatformOwnedAgent(r.owner)) : rows;
}

/**
 * Test every stored secret against the live key candidates. Decrypt IS the test:
 * AES-GCM authenticates, so a wrong key throws rather than returning wrong
 * plaintext, and the recovered material is never used beyond checking it exists.
 *
 * @param {Array<{secret:string}>} rows mutated in place with `decryptable` + `reason`
 * @param {(secret:string)=>Promise<string|Uint8Array|null>} [decrypt] injectable for tests
 * @returns {Promise<Array<any>>} the same rows
 */
export async function classifyCustodialSecrets(rows, decrypt = decryptSecret) {
	for (const w of rows) {
		try {
			const plain = await decrypt(w.secret);
			w.decryptable = Boolean(plain && plain.length > 0);
			w.reason = w.decryptable ? null : 'empty_plaintext';
		} catch (e) {
			w.decryptable = false;
			w.reason = e?.name === 'OperationError' ? 'wrong_key' : e?.message || 'decrypt_failed';
		}
	}
	return rows;
}

/**
 * Read on-chain SOL for every wallet, 100 addresses per RPC call. An address
 * whose chunk failed gets NO map entry, which is what keeps an unread balance
 * from summing as a confirmed zero downstream.
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {Array<{address:string}>} wallets
 * @returns {Promise<{balances:Map<string,number>, readErrors:Array<{address:string,reason:string}>}>}
 */
export async function readCustodialBalances(connection, wallets) {
	const { PublicKey } = await import('@solana/web3.js');
	const balances = new Map();
	const readErrors = [];
	for (let i = 0; i < wallets.length; i += BALANCE_CHUNK) {
		const chunk = wallets.slice(i, i + BALANCE_CHUNK);
		let keys;
		try {
			keys = chunk.map((w) => new PublicKey(w.address));
		} catch (e) {
			for (const w of chunk) readErrors.push({ address: w.address, reason: `bad_address: ${e?.message}` });
			continue;
		}
		try {
			const infos = await connection.getMultipleAccountsInfo(keys);
			infos.forEach((info, idx) => balances.set(chunk[idx].address, (info?.lamports ?? 0) / LAMPORTS_PER_SOL));
		} catch (e) {
			for (const w of chunk) readErrors.push({ address: w.address, reason: `rpc_error: ${e?.message}` });
		}
	}
	return { balances, readErrors };
}

/**
 * Turn classified wallets + confirmed balances into the report every caller
 * renders. Pure: no DB, no RPC, so the counting rules are unit-testable.
 *
 * @param {object} args
 * @param {Array<{agent_id?:string,name?:string,address:string,owner:string,created_at?:any,decryptable?:boolean,reason?:string|null}>} args.wallets
 * @param {Map<string,number>} args.balances confirmed reads only
 * @param {Array<{address:string,reason:string}>} [args.readErrors]
 * @param {string} [args.rpc] label for the lane the balances came from
 * @param {number|Date} [args.now]
 * @param {number} [args.topN]
 * @param {number|null} [args.keyCandidates] how many keys a decrypt had to try
 * @returns {object}
 */
export function summarizeCustodialKeyHealth({ wallets, balances, readErrors = [], rpc = 'unknown', now = Date.now(), topN = 20, keyCandidates = null }) {
	const sum = (list) => list.reduce((t, w) => (balances.has(w.address) ? t + balances.get(w.address) : t), 0);
	const unread = (list) => list.filter((w) => !balances.has(w.address));

	const platform = wallets.filter((w) => isPlatformOwnedAgent(w.owner));
	const customer = wallets.filter((w) => !isPlatformOwnedAgent(w.owner));
	const stranded = wallets.filter((w) => !w.decryptable);
	// "Funded" requires a CONFIRMED positive balance; a stranded wallet whose
	// balance we never read is neither funded nor cleared, it is unknown.
	const strandedFunded = stranded.filter((w) => balances.has(w.address) && balances.get(w.address) > 0);
	const strandedUnread = unread(stranded);
	const describe = (w) => ({
		agent_id: w.agent_id || null,
		name: w.name || null,
		address: w.address,
		owner: w.owner,
		reason: w.reason,
		created_at: w.created_at || null,
		platform: isPlatformOwnedAgent(w.owner),
	});

	return {
		checked_at: new Date(now).toISOString(),
		rpc,
		wallets: wallets.length,
		// How many keys a decrypt had to try. 1 is the healthy steady state; a
		// higher count means retired keys are still configured for the migration.
		key_candidates: keyCandidates,
		read_errors: readErrors.length,
		decryptable: wallets.length - stranded.length,
		undecryptable: stranded.length,
		sol: {
			// Every figure below sums CONFIRMED reads only (sum() skips addresses
			// with no balances entry). Never trust them as complete while
			// counts.stranded_unread is above zero.
			total: round9(sum(wallets)),
			decryptable: round9(sum(wallets.filter((w) => w.decryptable))),
			stranded: round9(sum(stranded)),
			stranded_platform: round9(sum(stranded.filter((w) => isPlatformOwnedAgent(w.owner)))),
			stranded_customer: round9(sum(stranded.filter((w) => !isPlatformOwnedAgent(w.owner)))),
		},
		counts: {
			platform: platform.length,
			customer: customer.length,
			stranded_platform: stranded.filter((w) => isPlatformOwnedAgent(w.owner)).length,
			stranded_customer: stranded.filter((w) => !isPlatformOwnedAgent(w.owner)).length,
			stranded_funded: strandedFunded.length,
			stranded_unread: strandedUnread.length,
		},
		top_stranded: strandedFunded
			.slice()
			.sort((a, b) => (balances.get(b.address) || 0) - (balances.get(a.address) || 0))
			.slice(0, topN)
			.map((w) => ({ ...describe(w), sol: round9(balances.get(w.address) || 0) })),
		unread_stranded: strandedUnread.map(describe),
	};
}

/**
 * The whole measurement: read the fleet, test every key, read every balance.
 *
 * @param {object} [args]
 * @param {import('@solana/web3.js').Connection} [args.connection] defaults to the rotating production lane
 * @param {boolean} [args.platformOnly]
 * @param {string|null} [args.rpcUrl]
 * @param {number} [args.topN]
 * @param {number|null} [args.keyCandidates]
 * @returns {Promise<object>} the report shape summarizeCustodialKeyHealth builds
 */
export async function gatherCustodialKeyHealth({ connection, platformOnly = false, rpcUrl = null, topN = 20, keyCandidates = null } = {}) {
	const wallets = await readCustodialWalletRows({ platformOnly });
	await classifyCustodialSecrets(wallets);
	// The rotating multi-lane connection production reads balances through, not a
	// single bare endpoint: a script pinned to one RPC URL dies the moment that
	// lane rate-limits the caller (observed 2026-08-09, and the failure was
	// invisible because unread balances silently summed as zero).
	let conn = connection;
	if (!conn) {
		const { solanaConnection } = await import('./solana/connection.js');
		conn = solanaConnection({ url: rpcUrl || process.env.SOLANA_RPC_URL || null });
	}
	const { balances, readErrors } = await readCustodialBalances(conn, wallets);
	return summarizeCustodialKeyHealth({
		wallets,
		balances,
		readErrors,
		rpc: rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
		topN,
		keyCandidates,
	});
}

/**
 * How long a stranded-custody snapshot stays good. Custody loss is a rotation
 * event, not a live metric: it changes when someone rotates a key or a sealed
 * wallet receives a deposit, never between two dashboard refreshes. Six hours
 * keeps an ops board honest while making the read effectively free (one fleet
 * scan per instance per quarter-day instead of one per request).
 */
export const STRANDED_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

/** @type {{at:number, panel:object}|null} */
let cached = null;
/** @type {Promise<object>|null} */
let inFlight = null;

/**
 * The ops-board panel: stranded wallet count, SOL, and the platform/customer
 * split, cached for STRANDED_SNAPSHOT_TTL_MS and de-duplicated across concurrent
 * requests so a polled dashboard never turns into fleet-wide RPC load.
 *
 * @param {object} [args]
 * @param {number} [args.ttlMs]
 * @param {boolean} [args.force] recompute even if the cache is warm
 * @param {() => Promise<object>} [args.gather] injectable for tests
 * @param {number} [args.now]
 * @returns {Promise<object>}
 */
export async function strandedCustodyPanel({ ttlMs = STRANDED_SNAPSHOT_TTL_MS, force = false, gather = gatherCustodialKeyHealth, now = Date.now() } = {}) {
	if (!force && cached && now - cached.at < ttlMs) {
		return { ...cached.panel, cache_age_seconds: Math.round((now - cached.at) / 1000) };
	}
	if (!inFlight) {
		inFlight = (async () => {
			const report = await gather();
			const panel = buildStrandedPanel(report);
			cached = { at: Date.now(), panel };
			return panel;
		})().finally(() => {
			inFlight = null;
		});
	}
	const panel = await inFlight;
	return { ...panel, cache_age_seconds: 0 };
}

/** Drop the memoized snapshot. Tests and a forced ops refresh use this. */
export function resetStrandedCustodyCache() {
	cached = null;
	inFlight = null;
}

/**
 * Reduce a full key-health report to the board panel. Pure.
 *
 * @param {object} report as returned by summarizeCustodialKeyHealth
 * @returns {object}
 */
export function buildStrandedPanel(report) {
	const counts = report?.counts || {};
	const sol = report?.sol || {};
	const unread = counts.stranded_unread || 0;
	const funded = counts.stranded_funded || 0;
	// A total is only a total when every sealed wallet actually got a balance
	// read. While any is unread the SOL figures are a FLOOR, and the panel says
	// so rather than letting a partial read render as a clean number.
	const status = unread > 0 ? 'unknown' : funded > 0 ? 'stranded' : 'clear';
	return {
		status,
		checked_at: report?.checked_at || null,
		wallets: report?.wallets ?? null,
		undecryptable: report?.undecryptable ?? 0,
		stranded_funded: funded,
		stranded_unread: unread,
		sol_stranded: sol.stranded ?? 0,
		sol_stranded_platform: sol.stranded_platform ?? 0,
		sol_stranded_customer: sol.stranded_customer ?? 0,
		customer_wallets_stranded: (report?.top_stranded || []).filter((w) => !w.platform).length,
		detail:
			status === 'clear'
				? 'No funded custodial wallet sits behind an undecryptable key.'
				: status === 'unknown'
					? `${unread} sealed wallet(s) never got a balance read, so the stranded total is a floor, not a measurement.`
					: `${funded} custodial wallet(s) hold ${sol.stranded ?? 0} SOL behind a retired encryption key (platform ${sol.stranded_platform ?? 0}, customer ${sol.stranded_customer ?? 0}).`,
		// Customer money that cannot be withdrawn is a support obligation, not an
		// ops number: the board names the decision doc rather than leaving the
		// reader to rediscover that recovery is impossible.
		brief: (sol.stranded_customer || 0) > 0 ? 'docs/ops/stranded-wallets.md' : null,
		top_stranded: (report?.top_stranded || []).slice(0, 10).map((w) => ({
			address: w.address,
			sol: w.sol,
			platform: w.platform,
			reason: w.reason,
		})),
	};
}
