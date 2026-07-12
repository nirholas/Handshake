// Cross-chain Subject Reputation — a pre-transaction trust primitive for ANY
// counterparty, not just three.ws agents.
//
// The question this answers is the one every autonomous agent has right before it
// pays, trades, or delegates: "should I trust the thing on the other side?" That
// counterparty ("subject") might be minted anywhere — a Solana wallet, an EVM
// wallet, a pump.fun coin, an ERC-8004 on-chain agent, or a three.ws agent. This
// module auto-detects which, reads the REAL on-chain evidence available for that
// identifier, and collapses it into one deterministic 0–100 trust score with the
// evidence and caveats attached, so the buyer can decide.
//
// Two layers, cleanly split so the score is unit-testable without any network:
//   • detectSubject() + scoreSignals()  — pure, deterministic, no I/O.
//   • loadSubjectReputation()           — the live reads (Solana RPC, EVM RPC,
//     the ERC-8004 reputation registry, DexScreener, and the three.ws on-chain
//     index) that gather the signals, each read soft so a dead source degrades to
//     a caveat instead of failing the whole call.
//
// Score rule (documented in docs/trust-primitives.md and mirrored here): six
// weighted trust dimensions, each normalized to 0..1, averaged over ONLY the
// dimensions readable for this subject, scaled to 0–100. No readable dimension →
// score:null, tier:'unknown' — never a fabricated number.

import { isUuid, isValidSolanaAddress, isValidEvmAddress } from '../validate.js';
import { CHAIN_BY_ID } from '../erc8004-chains.js';

const DEFAULT_EVM_CHAIN = 8453; // Base — where ERC-8004 sees the most agent activity.

export const SUBJECT_TYPES = [
	'threews_agent',
	'solana_wallet',
	'solana_mint',
	'evm_wallet',
	'erc8004_agent',
	'unknown',
];

// ── Detection (pure) ─────────────────────────────────────────────────────────

/**
 * Classify an arbitrary identifier into a subject type without any I/O. Solana
 * base58 strings can be either a wallet or a mint — the format alone can't tell,
 * so they resolve to the coarse family 'solana' here and loadSubjectReputation()
 * refines them to 'solana_wallet' / 'solana_mint' using the on-chain index.
 *
 * @param {string} raw                     the identifier to classify
 * @param {object} [opts]
 * @param {number|string} [opts.chain]     chain id for bare EVM/ERC-8004 subjects
 * @returns {{ subjectType:string, subject:string, chainId?:number, agentId?:string, reason?:string }}
 */
export function detectSubject(raw, opts = {}) {
	const id = String(raw ?? '').trim();
	if (!id) return { subjectType: 'unknown', subject: '', reason: 'empty identifier' };

	// three.ws agent_id (UUID) — the platform's own agents.
	if (isUuid(id)) return { subjectType: 'threews_agent', subject: id.toLowerCase() };

	// ERC-8004 agent id in CAIP-flavoured form: erc8004:<chainId>:<agentId> or
	// eip155:<chainId>:<numericAgentId>. The last segment is numeric (a token id),
	// which is what distinguishes it from a CAIP-10 account (…:0x-address).
	const prefixed = id.match(/^(?:erc8004|eip155):(\d+):(\d+)$/i);
	if (prefixed) {
		const chainId = Number(prefixed[1]);
		return { subjectType: 'erc8004_agent', subject: `erc8004:${chainId}:${prefixed[2]}`, chainId, agentId: prefixed[2] };
	}

	// EVM wallet / contract address.
	if (isValidEvmAddress(id)) {
		const chainId = normChain(opts.chain) ?? DEFAULT_EVM_CHAIN;
		return { subjectType: 'evm_wallet', subject: id.toLowerCase(), chainId };
	}

	// A bare integer is an ERC-8004 agent id whose chain wasn't spelled out — take
	// it from ?chain= (default Base). Capped at 18 digits so a 32+ char all-numeric
	// string still falls through to the Solana branch below.
	if (/^\d{1,18}$/.test(id)) {
		const chainId = normChain(opts.chain) ?? DEFAULT_EVM_CHAIN;
		return { subjectType: 'erc8004_agent', subject: `erc8004:${chainId}:${id}`, chainId, agentId: id };
	}

	// Solana base58 — wallet or mint, refined by the loader.
	if (isValidSolanaAddress(id)) return { subjectType: 'solana', subject: id };

	return { subjectType: 'unknown', subject: id, reason: 'unrecognized identifier format' };
}

function normChain(c) {
	if (c == null || c === '') return null;
	const n = Number(c);
	return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Scoring (pure, deterministic) ────────────────────────────────────────────

// Six trust dimensions. Each has a weight (its share of the 100-point scale when
// present) and a saturation cap (the value at which its normalized sub-score
// reaches 1.0). A subject is scored only over the dimensions that could actually
// be read for it — see scoreSignals().
export const DIMENSIONS = [
	{ key: 'activity', weight: 25, cap: 200, label: 'on-chain activity (tx / payments)' },
	{ key: 'age', weight: 15, cap: 365, label: 'account age (days)' },
	{ key: 'counterparties', weight: 15, cap: 25, label: 'distinct counterparties' },
	{ key: 'holdings', weight: 10, cap: 1000, label: 'holdings (USD)' },
	{ key: 'reliability', weight: 15, label: 'settlement reliability' },
	{ key: 'attestations', weight: 20, cap: 10, label: 'signed attestations / feedback' },
];
const DIM = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d]));

// A banned/denylisted subject is capped here regardless of any positive signal —
// a known-bad counterparty is never "medium trust" because it has volume.
const BANNED_SCORE_CAP = 10;

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const numOrNull = (n) => (isNum(n) ? n : null);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Collapse a signal bundle into a deterministic 0–100 trust score. Pure: the same
 * signals always yield the same score, so it is safe to unit-test and to compare
 * across time. Dimensions whose signal is absent (null/undefined) are dropped from
 * BOTH the numerator and denominator, so a subject with only two readable
 * dimensions is scored fairly against its own evidence rather than penalised for
 * chains we couldn't read.
 *
 * @param {object} sig
 * @param {number|null} [sig.activity]          tx / confirmed-payment count
 * @param {number|null} [sig.ageDays]           account/first-activity age in days
 * @param {number|null} [sig.counterparties]    distinct payers / tippers / peers
 * @param {number|null} [sig.holdingsUsd]       USD value held on-chain
 * @param {number|null} [sig.failureRate]       0..1 settlement failure rate
 * @param {number|null} [sig.attestationCount]  signed attestations / feedback count
 * @param {number|null} [sig.attestationAvg]    ERC-8004 average feedback [-100,100]
 * @param {boolean} [sig.banned]                hard denylist hit
 * @returns {{ score:number|null, tier:string, dimensions:object, weight_considered:number }}
 */
export function scoreSignals(sig = {}) {
	const dimensions = {};
	let sumW = 0;
	let sumWN = 0;

	const add = (key, available, norm, extra = {}) => {
		const d = DIM[key];
		const n = available ? clamp01(norm) : 0;
		if (available) {
			sumW += d.weight;
			sumWN += d.weight * n;
		}
		dimensions[key] = {
			available,
			weight: d.weight,
			norm: available ? round2(n) : null,
			points: available ? Math.round(d.weight * n) : 0,
			...extra,
		};
	};

	add('activity', isNum(sig.activity), (sig.activity || 0) / DIM.activity.cap, { value: numOrNull(sig.activity) });
	add('age', isNum(sig.ageDays), (sig.ageDays || 0) / DIM.age.cap, { days: numOrNull(sig.ageDays) });
	add('counterparties', isNum(sig.counterparties), (sig.counterparties || 0) / DIM.counterparties.cap, {
		value: numOrNull(sig.counterparties),
	});
	add('holdings', isNum(sig.holdingsUsd), (sig.holdingsUsd || 0) / DIM.holdings.cap, { usd: numOrNull(sig.holdingsUsd) });
	add('reliability', isNum(sig.failureRate), 1 - (sig.failureRate || 0), { failure_rate: numOrNull(sig.failureRate) });

	// Attestations: count saturates at 10; ERC-8004 feedback average (when present)
	// scales the contribution down for net-negative feedback, never up.
	const attAvail = isNum(sig.attestationCount);
	const qual = isNum(sig.attestationAvg)
		? sig.attestationAvg >= 0
			? 1
			: Math.max(0, (100 + sig.attestationAvg) / 100)
		: 1;
	add('attestations', attAvail, (Math.min(sig.attestationCount || 0, DIM.attestations.cap) / DIM.attestations.cap) * qual, {
		count: numOrNull(sig.attestationCount),
		avg_feedback: numOrNull(sig.attestationAvg),
	});

	let score = sumW > 0 ? Math.round((100 * sumWN) / sumW) : null;
	if (score != null && sig.banned) score = Math.min(score, BANNED_SCORE_CAP);

	return { score, tier: tierForScore(score), dimensions, weight_considered: sumW };
}

/**
 * Map a score to a coarse trust tier. Documented thresholds so callers can gate
 * on the tier without re-deriving the bands.
 *   null → unknown · <30 → low · 30–59 → medium · 60–84 → high · ≥85 → elite
 */
export function tierForScore(score) {
	if (score == null) return 'unknown';
	if (score < 30) return 'low';
	if (score < 60) return 'medium';
	if (score < 85) return 'high';
	return 'elite';
}

// ── Live subject loaders ─────────────────────────────────────────────────────

// Every dimension a given subject type can never supply is turned into a caveat
// so the buyer knows the score reflects partial evidence, not a full audit.
const DIM_LABEL = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d.label]));
function missingCaveats(sig, keys) {
	return keys
		.filter((k) => {
			if (k === 'reliability') return !isNum(sig.failureRate);
			if (k === 'attestations') return !isNum(sig.attestationCount);
			const map = { activity: 'activity', age: 'ageDays', counterparties: 'counterparties', holdings: 'holdingsUsd' };
			return !isNum(sig[map[k]]);
		})
		.map((k) => `${DIM_LABEL[k]} not readable for this subject`);
}

function finalize({ subject, subjectType, chainId, sig, evidence = [], caveats = [], raw = {}, ts }) {
	const { score, tier, dimensions, weight_considered } = scoreSignals(sig);
	const signals = { dimensions, weight_considered, ...(chainId ? { chain: chainId } : {}), ...raw };
	if (sig.banned) caveats = ['subject is on the three.ws denylist — score capped', ...caveats];
	return { subject, subjectType, score, tier, signals, evidence, caveats, ts };
}

function unknownResult(subject, reason, ts, subjectType = 'unknown') {
	return {
		subject,
		subjectType,
		score: null,
		tier: 'unknown',
		signals: { dimensions: {}, weight_considered: 0 },
		evidence: [],
		caveats: [reason || 'subject could not be identified or scanned'],
		ts,
	};
}

// soft(): resolve a read to a fallback on any error, recording the failure as a
// caveat so a degraded source is visible in the result rather than silent.
async function soft(promise, fallback, caveats, note) {
	try {
		return await promise;
	} catch (err) {
		if (caveats && note) caveats.push(`${note}: ${err?.message || 'read failed'}`);
		return fallback;
	}
}

/**
 * Reputation for ANY subject. Auto-detects the type, reads the real evidence, and
 * returns a uniform { subject, subjectType, score, tier, signals, evidence,
 * caveats, ts } object. Never throws for an unknown/unscannable subject and never
 * fabricates a score — those return score:null, tier:'unknown'.
 *
 * @param {string} identifier
 * @param {object} [opts]  { chain } for bare EVM / ERC-8004 subjects
 */
export async function loadSubjectReputation(identifier, opts = {}) {
	const det = detectSubject(identifier, opts);
	const ts = new Date().toISOString();
	try {
		switch (det.subjectType) {
			case 'threews_agent':
				return await scoreThreewsAgent(det, ts);
			case 'erc8004_agent':
				return await scoreErc8004Agent(det, ts);
			case 'evm_wallet':
				return await scoreEvmWallet(det, ts);
			case 'solana':
				return await scoreSolanaSubject(det, ts);
			default:
				return unknownResult(det.subject, det.reason, ts);
		}
	} catch (err) {
		// Absolute backstop — a subject type is known but every read blew up. Degrade
		// to unknown with the reason rather than 500. Solana stays 'solana_wallet'
		// (the safe assumption) so the type field is still informative.
		const fallbackType = det.subjectType === 'solana' ? 'solana_wallet' : det.subjectType;
		return unknownResult(det.subject, `scan failed: ${err?.message || 'error'}`, ts, fallbackType);
	}
}

/** Score a batch of arbitrary subjects concurrently. Resilient per-item. */
export async function scoreSubjectBatch(identifiers = [], { concurrency = 6, chain } = {}) {
	const ids = identifiers.map((s) => String(s ?? '').trim()).filter(Boolean);
	const out = [];
	for (let i = 0; i < ids.length; i += concurrency) {
		const chunk = ids.slice(i, i + concurrency);
		const settled = await Promise.all(
			chunk.map((id) =>
				loadSubjectReputation(id, { chain }).catch((err) =>
					unknownResult(id, `scan failed: ${err?.message || 'error'}`, new Date().toISOString()),
				),
			),
		);
		out.push(...settled);
	}
	return out;
}

// ── three.ws agent ───────────────────────────────────────────────────────────

// Map a three.ws on-chain reputation snapshot (from the pump-agent index) into the
// shared signal vocabulary. Shared by the agent path and the Solana-wallet /
// solana-mint paths when they resolve to a three.ws agent.
function sigFromAgentRep(rep) {
	const p = rep.payments || {};
	const a = rep.attestations || {};
	const settled = (p.confirmed_count || 0) + (p.failed_count || 0);
	return {
		activity: p.confirmed_count || 0,
		counterparties: p.distinct_payers || 0,
		failureRate: settled > 0 ? Number(p.failure_rate) || 0 : null,
		attestationCount: (a.feedback_count || 0) + (a.validation_count || 0),
	};
}

async function scoreThreewsAgent(det, ts) {
	const { loadAgentReputation } = await import('./solana-bouncer.js');
	const { sql } = await import('../db.js');
	let rep;
	try {
		rep = await loadAgentReputation(det.subject);
	} catch (err) {
		if (err?.status === 404) return unknownResult(det.subject, 'no three.ws agent with this id', ts, 'threews_agent');
		throw err;
	}
	const caveats = [];
	// Age from the identity row (one light indexed read).
	const [row] = await soft(
		sql`select created_at from agent_identities where id = ${det.subject} limit 1`,
		[null],
		caveats,
		'agent age read',
	);
	const ageDays = row?.created_at ? (Date.now() - new Date(row.created_at).getTime()) / 86_400_000 : null;

	const sig = { ...sigFromAgentRep(rep), ageDays };
	caveats.push(...missingCaveats(sig, ['holdings']));

	const evidence = [{ kind: 'threews_agent', ref: `/agent/${det.subject}` }];
	if (rep.wallet_address) evidence.push({ kind: 'solana_account', ref: `https://solscan.io/account/${rep.wallet_address}` });
	const firstMint = rep.mints?.[0]?.mint;
	if (firstMint) evidence.push({ kind: 'launched_coin', ref: `https://solscan.io/token/${firstMint}` });

	return finalize({
		subject: det.subject,
		subjectType: 'threews_agent',
		sig,
		evidence,
		caveats,
		raw: {
			name: rep.name || null,
			wallet_address: rep.wallet_address || null,
			deployed_mints: rep.deployed_mints || 0,
			payments: rep.payments,
			distributions: rep.distributions,
			buybacks: rep.buybacks,
			attestations: rep.attestations,
		},
		ts,
	});
}

// ── ERC-8004 agent ───────────────────────────────────────────────────────────

async function readErc8004(chainId, agentId) {
	const { REGISTRY_DEPLOYMENTS, REPUTATION_REGISTRY_ABI, IDENTITY_REGISTRY_ABI } = await import('../../../src/erc8004/abi.js');
	const deployment = REGISTRY_DEPLOYMENTS[chainId];
	if (!deployment) throw Object.assign(new Error(`ERC-8004 not deployed on chain ${chainId}`), { code: 'no_deployment' });
	const { Contract } = await import('ethers');
	const { evmFallbackProvider } = await import('../evm/rpc.js');
	const provider = await evmFallbackProvider(chainId);

	const out = { average: null, count: 0, wallet: null };
	if (deployment.reputationRegistry) {
		const rep = new Contract(deployment.reputationRegistry, REPUTATION_REGISTRY_ABI, provider);
		const [avgX100, count] = await rep.getReputation(BigInt(agentId));
		const n = Number(count);
		out.count = n;
		out.average = n === 0 ? null : Number(avgX100) / 100;
	}
	if (deployment.identityRegistry) {
		try {
			const idreg = new Contract(deployment.identityRegistry, IDENTITY_REGISTRY_ABI, provider);
			const w = await idreg.getAgentWallet(BigInt(agentId));
			if (w && /^0x[0-9a-fA-F]{40}$/.test(w) && !/^0x0{40}$/.test(w)) out.wallet = w.toLowerCase();
		} catch {
			/* getAgentWallet is optional — some registries don't bind a wallet */
		}
	}
	return out;
}

async function scoreErc8004Agent(det, ts) {
	const caveats = [];
	const reg = await soft(readErc8004(det.chainId, det.agentId), null, caveats, 'erc8004 registry read');
	if (!reg) {
		return {
			...unknownResult(det.subject, `ERC-8004 registry unreadable on chain ${det.chainId}`, ts, 'erc8004_agent'),
			signals: { dimensions: {}, weight_considered: 0, chain: det.chainId },
		};
	}

	const sig = {
		attestationCount: reg.count,
		attestationAvg: reg.average,
	};

	// If the identity registry binds a wallet, fold that wallet's raw EVM activity
	// + holdings in — the agent's own on-chain footprint, not just its reviews.
	const evidence = [{ kind: 'erc8004_reputation', ref: `eip155:${det.chainId}:agent/${det.agentId}` }];
	let walletReads = null;
	if (reg.wallet) {
		walletReads = await soft(readEvmWallet(det.chainId, reg.wallet), null, caveats, 'erc8004 agent wallet read');
		if (walletReads) {
			sig.activity = walletReads.txCount;
			sig.holdingsUsd = walletReads.holdingsUsd;
		}
		const explorer = CHAIN_BY_ID[det.chainId]?.explorer;
		if (explorer) evidence.push({ kind: 'evm_account', ref: `${explorer}/address/${reg.wallet}` });
	} else {
		caveats.push('no wallet bound to this ERC-8004 agent — activity / holdings not scored');
	}

	caveats.push(...missingCaveats(sig, ['age', 'counterparties', 'reliability']));
	if (reg.count === 0) caveats.push('no ERC-8004 feedback on record yet');

	return finalize({
		subject: det.subject,
		subjectType: 'erc8004_agent',
		chainId: det.chainId,
		sig,
		evidence,
		caveats,
		raw: {
			agent_id: det.agentId,
			erc8004: { feedback_count: reg.count, avg_feedback: reg.average, wallet: reg.wallet },
			...(walletReads ? { native_balance: walletReads.native, tx_count: walletReads.txCount } : {}),
		},
		ts,
	});
}

// ── EVM wallet ───────────────────────────────────────────────────────────────

// Cheap, keyless EVM reads: outbound tx count (nonce) for activity and native
// balance priced to USD for holdings. Age + counterparties need an indexer we
// don't require, so they stay unread (→ caveats).
async function readEvmWallet(chainId, address) {
	const { evmFallbackProvider } = await import('../evm/rpc.js');
	const provider = await evmFallbackProvider(chainId);
	const [nonce, balanceWei] = await Promise.all([
		provider.getTransactionCount(address),
		provider.getBalance(address),
	]);
	const native = Number(balanceWei) / 1e18;
	const price = await evmNativePriceUsd(chainId);
	return { txCount: Number(nonce), native, holdingsUsd: price != null ? native * price : null };
}

// Native-asset USD price by chain, keyless via CoinGecko simple price. Best-effort
// — a miss just leaves holdings unpriced (dimension unavailable), never an error.
const CG_NATIVE_ID = {
	1: 'ethereum', 8453: 'ethereum', 42161: 'ethereum', 10: 'ethereum', 59144: 'ethereum',
	534352: 'ethereum', 324: 'ethereum', 5000: 'mantle', 56: 'binancecoin', 137: 'matic-network',
	43114: 'avalanche-2', 100: 'xdai', 250: 'fantom', 42220: 'celo', 1284: 'moonbeam',
};
async function evmNativePriceUsd(chainId) {
	const cgId = CG_NATIVE_ID[chainId];
	if (!cgId) return null;
	try {
		const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(5000),
		});
		if (!r.ok) return null;
		const data = await r.json();
		return Number(data?.[cgId]?.usd) || null;
	} catch {
		return null;
	}
}

async function scoreEvmWallet(det, ts) {
	const caveats = [];
	const reads = await soft(readEvmWallet(det.chainId, det.subject), null, caveats, 'evm wallet read');
	if (!reads) {
		return {
			...unknownResult(det.subject, `EVM chain ${det.chainId} unreadable for this wallet`, ts, 'evm_wallet'),
			signals: { dimensions: {}, weight_considered: 0, chain: det.chainId },
		};
	}
	const sig = { activity: reads.txCount, holdingsUsd: reads.holdingsUsd };
	caveats.push(...missingCaveats(sig, ['age', 'counterparties', 'reliability', 'attestations']));

	const explorer = CHAIN_BY_ID[det.chainId]?.explorer;
	const evidence = explorer ? [{ kind: 'evm_account', ref: `${explorer}/address/${det.subject}` }] : [];

	return finalize({
		subject: det.subject,
		subjectType: 'evm_wallet',
		chainId: det.chainId,
		sig,
		evidence,
		caveats,
		raw: { tx_count: reads.txCount, native_balance: reads.native, native_symbol: nativeSymbol(det.chainId) },
		ts,
	});
}

function nativeSymbol(chainId) {
	if (chainId === 56) return 'BNB';
	if (chainId === 137) return 'MATIC';
	if (chainId === 43114) return 'AVAX';
	if (chainId === 250) return 'FTM';
	if (chainId === 42220) return 'CELO';
	if (chainId === 1284) return 'GLMR';
	if (chainId === 5000) return 'MNT';
	return 'ETH';
}

// ── Solana subject (wallet or mint) ──────────────────────────────────────────

async function scoreSolanaSubject(det, ts) {
	const { sql } = await import('../db.js');

	// (1) A pump.fun mint three.ws indexed → score its owning agent's behavior.
	const mintRows = await sql`
		select agent_id, symbol, network from pump_agent_mints where mint = ${det.subject} limit 1
	`.catch(() => []);
	if (mintRows[0]?.agent_id) return scoreThreewsMint(det, mintRows[0], ts);

	// (2) A known three.ws agent wallet → score that agent (folding wallet reads).
	const agentRows = await sql`
		select id from agent_identities
		 where (wallet_address = ${det.subject} or meta->>'solana_address' = ${det.subject})
		   and deleted_at is null
		 limit 1
	`.catch(() => []);
	const knownAgentId = agentRows[0]?.id || null;

	// (3) Not ours — is it a live token? DexScreener resolves mints; if it returns a
	//     Solana pair, treat the subject as an external mint scored from its market.
	if (!knownAgentId) {
		const market = await dexscreenerToken(det.subject).catch(() => null);
		if (market) return scoreExternalMint(det, market, ts);
	}

	// (4) Fall through: score it as a raw Solana wallet (folding agent signals if known).
	return scoreSolanaWallet(det, { knownAgentId }, ts);
}

async function scoreThreewsMint(det, mintRow, ts) {
	const { loadAgentReputation } = await import('./solana-bouncer.js');
	const caveats = [];
	const rep = await soft(loadAgentReputation(mintRow.agent_id), null, caveats, 'agent reputation read');
	if (!rep) return unknownResult(det.subject, 'mint owner reputation unreadable', ts, 'solana_mint');

	const market = await dexscreenerToken(det.subject).catch(() => null);
	const sig = { ...sigFromAgentRep(rep) };
	if (market) {
		sig.ageDays = market.ageDays;
		sig.holdingsUsd = market.liquidityUsd; // pool liquidity = skin-in-the-game proxy for a coin
	}
	caveats.push(...missingCaveats(sig, ['age', 'holdings']));

	const evidence = [
		{ kind: 'solana_token', ref: `https://solscan.io/token/${det.subject}` },
		{ kind: 'threews_agent', ref: `/agent/${mintRow.agent_id}` },
	];
	if (market) evidence.push({ kind: 'dexscreener', ref: `https://dexscreener.com/solana/${det.subject}` });

	return finalize({
		subject: det.subject,
		subjectType: 'solana_mint',
		sig,
		evidence,
		caveats,
		raw: {
			mint: det.subject,
			symbol: mintRow.symbol || rep.mints?.find((m) => m.mint === det.subject)?.symbol || null,
			owner_agent_id: mintRow.agent_id,
			owner_name: rep.name || null,
			payments: rep.payments,
			attestations: rep.attestations,
			...(market ? { market: { liquidity_usd: market.liquidityUsd, volume_24h_usd: market.volumeUsd, txns_24h: market.txns24h } } : {}),
		},
		ts,
	});
}

async function scoreExternalMint(det, market, ts) {
	const caveats = [
		'external mint — scored from live market signals (liquidity, activity, age), not agent behavior',
	];
	const sig = {
		activity: market.txns24h,
		ageDays: market.ageDays,
		holdingsUsd: market.liquidityUsd,
	};
	caveats.push(...missingCaveats(sig, ['counterparties', 'reliability', 'attestations']));

	return finalize({
		subject: det.subject,
		subjectType: 'solana_mint',
		sig,
		evidence: [
			{ kind: 'solana_token', ref: `https://solscan.io/token/${det.subject}` },
			{ kind: 'dexscreener', ref: `https://dexscreener.com/solana/${det.subject}` },
		],
		caveats,
		raw: {
			mint: det.subject,
			symbol: market.symbol || null,
			market: {
				price_usd: market.priceUsd,
				liquidity_usd: market.liquidityUsd,
				volume_24h_usd: market.volumeUsd,
				txns_24h: market.txns24h,
				pair_created_at: market.pairCreatedAt,
			},
		},
		ts,
	});
}

async function scoreSolanaWallet(det, { knownAgentId }, ts) {
	const caveats = [];
	const { solanaConnection } = await import('../solana/connection.js');
	const { PublicKey } = await import('@solana/web3.js');
	const { findBan, normalizeWallet } = await import('../club/cover-pass.js');

	let pk;
	try {
		pk = new PublicKey(det.subject);
	} catch {
		return unknownResult(det.subject, 'not a valid Solana address', ts, 'solana_wallet');
	}
	const conn = solanaConnection({ network: 'mainnet' });

	// Bounded signature scan: count (capped at 1000/page) → activity. Age is only
	// derivable when the scan reached the START of history (page NOT saturated) —
	// for a hyperactive wallet that fills the 1000-tx page, the oldest signature in
	// the page is merely the oldest *recent* tx, not the account's age, so we must
	// NOT treat it as age (doing so wrongly tanks an ancient, busy wallet's score).
	const sigs = await soft(conn.getSignaturesForAddress(pk, { limit: 1000 }), null, caveats, 'solana signatures read');
	let activity = null;
	let ageDays = null;
	if (Array.isArray(sigs)) {
		activity = sigs.length;
		if (sigs.length >= 1000) {
			caveats.push(
				'activity is a lower bound and account age is not derivable — signature history exceeds the 1000-tx scan window',
			);
		} else {
			const oldest = sigs[sigs.length - 1]?.blockTime;
			if (oldest) ageDays = Math.max(0, (Date.now() - oldest * 1000) / 86_400_000);
		}
	}

	// Native SOL balance priced to USD → holdings.
	const lamports = await soft(conn.getBalance(pk), null, caveats, 'solana balance read');
	let holdingsUsd = null;
	let solAmount = null;
	if (isNum(lamports)) {
		solAmount = lamports / 1e9;
		const price = await soft(solPriceUsd(), null, caveats, 'SOL price read');
		if (isNum(price)) holdingsUsd = solAmount * price;
	}

	// Denylist → hard risk override.
	const ban = await soft(findBan(normalizeWallet(det.subject)), null, caveats, 'denylist read');

	const sig = { activity, ageDays, holdingsUsd, banned: Boolean(ban) };

	// Fold the agent's settled-payment behavior in when this wallet is a known
	// three.ws agent wallet — richer, third-party-attested signals.
	let agentRaw = null;
	if (knownAgentId) {
		const { loadAgentReputation } = await import('./solana-bouncer.js');
		const rep = await soft(loadAgentReputation(knownAgentId), null, caveats, 'agent reputation read');
		if (rep) {
			const arep = sigFromAgentRep(rep);
			sig.counterparties = arep.counterparties;
			sig.failureRate = arep.failureRate;
			sig.attestationCount = arep.attestationCount;
			if (!isNum(sig.activity)) sig.activity = arep.activity;
			agentRaw = { agent_id: knownAgentId, name: rep.name || null, payments: rep.payments, attestations: rep.attestations };
		}
	}
	caveats.push(...missingCaveats(sig, knownAgentId ? [] : ['counterparties', 'reliability', 'attestations']));

	const evidence = [{ kind: 'solana_account', ref: `https://solscan.io/account/${det.subject}` }];
	if (knownAgentId) evidence.push({ kind: 'threews_agent', ref: `/agent/${knownAgentId}` });

	return finalize({
		subject: det.subject,
		subjectType: 'solana_wallet',
		sig,
		evidence,
		caveats,
		raw: {
			sol_balance: solAmount,
			signature_count: activity,
			denylisted: Boolean(ban),
			...(agentRaw ? { agent: agentRaw } : {}),
		},
		ts,
	});
}

// ── shared upstream reads ────────────────────────────────────────────────────

async function solPriceUsd() {
	const { solPriceUsd: solSpotUsd } = await import('../sol-price.js');
	const p = await solSpotUsd();
	return p > 0 ? p : null;
}

// DexScreener token lookup → normalized market signals, or null if it's not a
// tradeable Solana token (i.e. probably a wallet, not a mint). Keyless, public.
async function dexscreenerToken(mint) {
	const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(6000),
	});
	if (!r.ok) return null;
	const data = await r.json();
	const pairs = (data.pairs || []).filter((p) => p.chainId === 'solana' && p.baseToken?.address === mint);
	if (!pairs.length) return null;
	pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
	const p = pairs[0];
	const txns = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
	const created = p.pairCreatedAt ? Number(p.pairCreatedAt) : null;
	return {
		symbol: p.baseToken?.symbol || null,
		priceUsd: parseFloat(p.priceUsd) || null,
		liquidityUsd: p.liquidity?.usd ?? null,
		volumeUsd: p.volume?.h24 ?? null,
		txns24h: txns,
		pairCreatedAt: created ? new Date(created).toISOString() : null,
		ageDays: created ? Math.max(0, (Date.now() - created) / 86_400_000) : null,
	};
}
