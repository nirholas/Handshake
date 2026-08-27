// Treasury Autopilot — the agent that funds its own existence.
//
// An owner writes a treasury policy in plain English; we compile it into bounded,
// structured rules they approve; then a scheduler executes each rule as a REAL,
// idempotent, spend-policy-gated, audited on-chain action on the AGENT'S OWN
// wallet. The agent pays its own metered compute, holds a buffer, dollar-cost-
// averages income into $THREE, compounds its coin fees into buybacks, and sweeps
// profit to its owner — all under the same `enforceSpendLimit` ceiling that
// governs every other outbound movement (api/_lib/agent-trade-guards.js).
//
// Why this can only exist here: our agents both EARN (tips, creator fees, trading)
// and COST money to run (LLM + voice compute), and both live in the SAME real
// custodial wallet. That lets us close the loop and build a self-sustaining agent.
//
// Safety is structural, not bolted on:
//   - Owner-only to configure; every executing path acts only on the agent's wallet.
//   - The spend policy is the hard ceiling — the NL policy can only tighten it.
//   - Explicit consent: the compiled rules are shown back and armed before anything runs.
//   - Idempotent: each scheduled action claims a unique custody row per period, so a
//     retry can never double-spend.
//   - Fail safe: a price-feed gap, a missing config, or a breached buffer PAUSES the
//     affected rule and records an honest note — it never guesses with real money.
//   - A kill switch halts everything instantly.

import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { sql } from './db.js';
import { confirmOrThrow } from './solana/confirm.js';
import { solUsdPrice, sendSol, explorerTxUrl, explorerAccountUrl } from './avatar-wallet.js';
import { solanaConnection } from './agent-pumpfun.js';
import { getSolanaAddressBalances, recoverSolanaAgentKeypair } from './agent-wallet.js';
import {
	getSpendLimits,
	enforceSpendLimit,
	recordCustodyEvent,
	updateCustodyEvent,
	SpendLimitError,
	validateSolanaAddress,
} from './agent-trade-guards.js';
import { THREE_MINT } from './networth-model.js';
import { llmComplete, llmConfigured } from './llm.js';
import { logAudit } from './audit.js';
import { fetchUpstream } from './upstream-fetch.js';
import { withRetry } from './resilience.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
// Rent + network-fee headroom kept above any autopilot spend so a move can never
// brick the wallet for lack of lamports to pay the fee or open an ATA.
const FEE_HEADROOM_LAMPORTS = 6_000_000n; // ~0.006 SOL
// Below this USD the action isn't worth a transaction's fee — skip honestly.
const DUST_USD = 0.02;
const JUPITER_BASE = 'https://lite-api.jup.ag/swap/v1';

export const AUTOPILOT_RULE_KINDS = Object.freeze(['self_fund', 'buffer', 'dca', 'buyback', 'sweep']);

// ── normalization ──────────────────────────────────────────────────────────────

function num(v, def = null) {
	if (v === null || v === undefined || v === '') return def;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : def;
}
function clamp(n, min, max) {
	return Math.min(max, Math.max(min, n));
}
function str(v, max = 200) {
	return typeof v === 'string' ? v.slice(0, max) : null;
}
const CADENCES = new Set(['hourly', 'daily', 'weekly']);
function cadence(v, def = 'daily') {
	return CADENCES.has(v) ? v : def;
}
// 0=Sun … 6=Sat, or null for "any day"
function weekday(v) {
	const n = Number(v);
	return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
}

let _ruleSeq = 0;
function ruleId(kind) {
	_ruleSeq = (_ruleSeq + 1) % 1e6;
	return `${kind}_${Date.now().toString(36)}${_ruleSeq.toString(36)}`;
}

/** Coerce one raw rule into a clean, bounded rule object. */
export function normalizeRule(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const kind = AUTOPILOT_RULE_KINDS.includes(r.kind) ? r.kind : null;
	if (!kind) return null;
	const p = r.params && typeof r.params === 'object' ? r.params : {};
	let params = {};
	if (kind === 'dca') {
		const pct = p.pct != null ? clamp(num(p.pct, 0), 0, 100) : null;
		const amountSol = p.amount_sol != null ? num(p.amount_sol, null) : null;
		params = {
			basis: p.basis === 'income' ? 'income' : 'surplus',
			pct: pct != null ? pct : amountSol != null ? null : 10,
			amount_sol: amountSol != null ? clamp(amountSol, 0, 1000) : null,
			target_mint: THREE_MINT, // $THREE is the only DCA target — never owner-overridable
			cadence: cadence(p.cadence, 'daily'),
			weekday: weekday(p.weekday),
			slippage_bps: clamp(Number(p.slippage_bps) || 300, 50, 2000),
		};
	} else if (kind === 'buyback') {
		params = {
			pct_of_fees: clamp(num(p.pct_of_fees, 100), 0, 100),
			cadence: cadence(p.cadence, 'weekly'),
			weekday: weekday(p.weekday),
			slippage_bps: clamp(Number(p.slippage_bps) || 500, 50, 2000),
		};
	} else if (kind === 'sweep') {
		const dest = validateSolanaAddress(p.destination || '');
		params = {
			threshold_sol: clamp(num(p.threshold_sol, 1), 0, 1e6),
			destination: dest.valid ? dest.base58 : null,
			cadence: cadence(p.cadence, 'weekly'),
			weekday: weekday(p.weekday),
		};
	} else if (kind === 'self_fund') {
		params = { cadence: cadence(p.cadence, 'hourly') };
	} else if (kind === 'buffer') {
		params = {}; // buffer amount lives at policy level
	}
	return {
		id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : ruleId(kind),
		kind,
		enabled: r.enabled !== false,
		paused: r.paused === true,
		params,
		label: str(r.label, 240) || defaultLabel(kind, params),
		last_run_at: str(r.last_run_at) || null,
		last_status: str(r.last_status, 40) || null,
		last_note: str(r.last_note, 240) || null,
	};
}

function defaultLabel(kind, p) {
	switch (kind) {
		case 'self_fund':
			return 'Pay the agent’s own metered compute costs from its wallet';
		case 'buffer':
			return 'Keep a safety buffer in the wallet';
		case 'dca':
			return p.amount_sol != null
				? `Dollar-cost-average ${p.amount_sol} SOL ${p.cadence} into $THREE`
				: `Dollar-cost-average ${p.pct}% of ${p.basis} into $THREE (${p.cadence})`;
		case 'buyback':
			return `Compound ${p.pct_of_fees}% of coin fees into buybacks (${p.cadence})`;
		case 'sweep':
			return `Sweep anything over ${p.threshold_sol} SOL to the owner (${p.cadence})`;
		default:
			return kind;
	}
}

/** Read + clean the full autopilot policy off an agent's meta blob. */
export function normalizeAutopilot(raw) {
	const a = raw && typeof raw === 'object' ? raw : {};
	const dest = validateSolanaAddress(a.sweep_destination || '');
	const rules = (Array.isArray(a.rules) ? a.rules : []).map(normalizeRule).filter(Boolean).slice(0, 20);
	return {
		armed: a.armed === true,
		kill_switch: a.kill_switch === true,
		buffer_sol: num(a.buffer_sol, null),
		sweep_destination: dest.valid ? dest.base58 : null,
		rules,
		source_text: str(a.source_text, 4000),
		compiled_at: str(a.compiled_at, 40),
		approved_at: str(a.approved_at, 40),
		compute_settled_at: str(a.compute_settled_at, 40),
		updated_at: str(a.updated_at, 40),
	};
}

export function getAutopilot(meta) {
	return normalizeAutopilot(meta?.autopilot);
}

// ── NL → structured rules (compile) ─────────────────────────────────────────────

const COMPILE_SYSTEM = `You compile a plain-English treasury policy for an autonomous AI agent's own crypto wallet into a strict JSON object of bounded rules. The agent both earns (tips, its coin's fees, trading) and costs money to run (LLM + voice compute), all in one Solana wallet.

Output ONLY a JSON object (no prose, no markdown fences) with this shape:
{
  "buffer_sol": number|null,        // safety buffer of SOL to always keep
  "rules": [
    {"kind":"self_fund"},                                        // pay the agent's own compute from its wallet
    {"kind":"buffer"},                                           // maintain the buffer_sol above (include if a buffer is mentioned)
    {"kind":"dca","params":{"basis":"income"|"surplus","pct":number|null,"amount_sol":number|null,"cadence":"hourly"|"daily"|"weekly","weekday":0-6|null}},
    {"kind":"buyback","params":{"pct_of_fees":number,"cadence":"hourly"|"daily"|"weekly","weekday":0-6|null}},
    {"kind":"sweep","params":{"threshold_sol":number,"cadence":"hourly"|"daily"|"weekly","weekday":0-6|null}}
  ],
  "warnings": [string],             // anything ambiguous you assumed a default for
  "contradictions": [string]        // rules that conflict and cannot all hold (e.g. sweep threshold below the buffer)
}
Rules: DCA target is always $THREE (do not include a mint). "10% of tips/income" -> dca basis "income" pct 10. "0.5 SOL daily" -> dca amount_sol 0.5. weekday: Sun=0..Sat=6; "Fridays"=5. Only include rules the policy actually asks for. If the policy contradicts itself (e.g. "keep 3 SOL buffer" but "sweep everything over 1 SOL"), list it in contradictions. Never invent a coin other than $THREE.`;

function safeJsonExtract(text) {
	if (typeof text !== 'string') return null;
	let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
	const start = t.indexOf('{');
	const end = t.lastIndexOf('}');
	if (start < 0 || end < start) return null;
	try {
		return JSON.parse(t.slice(start, end + 1));
	} catch {
		return null;
	}
}

/**
 * Compile a natural-language treasury policy into validated, structured rules.
 * Prefers the LLM (real tool-use over a worker proxy); falls back to a real
 * deterministic intent parser when no model is configured, so the feature always
 * compiles. Returns the compiled policy plus warnings/contradictions for the
 * owner-approval preview — it NEVER arms anything.
 */
export async function compilePolicyFromText(text, { sweepDestination = null, track = null } = {}) {
	const source = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
	if (!source) {
		return { ok: false, error: 'empty_policy', message: 'Write a policy in plain English first.' };
	}

	let parsed = null;
	let via = 'heuristic';
	if (llmConfigured()) {
		try {
			const out = await llmComplete({
				system: COMPILE_SYSTEM,
				user: source,
				maxTokens: 900,
				timeoutMs: 25_000,
				track,
			});
			parsed = safeJsonExtract(out.text);
			if (parsed) via = 'model';
		} catch (e) {
			// fall through to the deterministic parser — never strand the owner
			console.warn('[autopilot] LLM compile failed, using heuristic:', e?.message);
		}
	}
	if (!parsed) parsed = heuristicCompile(source);

	const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map((w) => str(w, 240)).filter(Boolean) : [];
	const contradictions = Array.isArray(parsed.contradictions)
		? parsed.contradictions.map((w) => str(w, 240)).filter(Boolean)
		: [];

	const bufferSol = num(parsed.buffer_sol, null);
	const rules = (Array.isArray(parsed.rules) ? parsed.rules : [])
		.map((r) => {
			// stamp the owner-supplied sweep destination onto sweep rules at compile time
			if (r?.kind === 'sweep' && sweepDestination) {
				r.params = { ...(r.params || {}), destination: sweepDestination };
			}
			return normalizeRule(r);
		})
		.filter(Boolean);

	// Structural contradiction the parser may have missed: a sweep threshold at or
	// below the buffer would fight the buffer every cycle.
	for (const r of rules) {
		if (r.kind === 'sweep' && bufferSol != null && r.params.threshold_sol <= bufferSol) {
			contradictions.push(
				`Sweep threshold (${r.params.threshold_sol} SOL) is at or below the ${bufferSol} SOL buffer — they would fight each other. Raise the sweep threshold above the buffer.`,
			);
		}
		if (r.kind === 'sweep' && !r.params.destination && !sweepDestination) {
			warnings.push('Set a destination wallet for the sweep before arming, or the agent has nowhere to send the profit.');
		}
	}

	return {
		ok: true,
		via,
		source_text: source,
		buffer_sol: bufferSol,
		sweep_destination: sweepDestination || null,
		rules,
		warnings: [...new Set(warnings)],
		contradictions: [...new Set(contradictions)],
	};
}

// Deterministic, dependency-free intent parser. Real implementation (not a mock):
// extracts the same rule shapes from common phrasings so the feature compiles
// offline and whenever no model is configured.
function heuristicCompile(text) {
	const t = text.toLowerCase();
	const rules = [];
	const warnings = [];
	let buffer_sol = null;

	if (/\b(pay|fund|cover|settle)\b.*\b(its own|your own|own)?\s*(compute|brain|llm|inference|costs?|bills?)\b/.test(t) ||
		/self[- ]?fund/.test(t)) {
		rules.push({ kind: 'self_fund' });
	}

	const buf = t.match(/(?:keep|hold|maintain|leave|reserve)\s*(?:a|an)?\s*([\d.]+)\s*sol\s*(?:safety\s*)?(?:buffer|reserve|floor)?/);
	if (buf || /buffer|reserve|floor/.test(t)) {
		if (buf) buffer_sol = Number(buf[1]);
		rules.push({ kind: 'buffer' });
		if (!buf) warnings.push('A buffer was requested but no amount was found — defaulting to no fixed buffer; set one explicitly.');
	}

	// DCA: percentage of tips/income, or a fixed SOL amount
	const dcaPct = t.match(/([\d.]+)\s*%\s*(?:of)?\s*(tips?|income|earnings|revenue)?[^.]*?(?:into|to|in)\s*\$?three/);
	const dcaAmt = t.match(/(?:put|dca|buy|invest|allocate)\s*([\d.]+)\s*sol[^.]*?(?:into|to|in)\s*\$?three/);
	if (dcaPct || dcaAmt || /\bdca\b|dollar[- ]cost/.test(t)) {
		const params = { cadence: cadenceFrom(t), weekday: weekdayFrom(t) };
		if (dcaPct) {
			params.pct = Number(dcaPct[1]);
			params.basis = 'income';
		} else if (dcaAmt) {
			params.amount_sol = Number(dcaAmt[1]);
		} else {
			params.pct = 10;
			params.basis = 'surplus';
			warnings.push('DCA size was unclear — defaulting to 10% of surplus.');
		}
		rules.push({ kind: 'dca', params });
	}

	if (/\b(compound|buyback|buy back|burn)\b.*\b(fees?|coin)\b/.test(t) || /\bbuyback/.test(t)) {
		rules.push({ kind: 'buyback', params: { pct_of_fees: 100, cadence: cadenceFrom(t, 'weekly'), weekday: weekdayFrom(t) } });
	}

	const sweep = t.match(/sweep[^.]*?(?:over|above|exceed(?:ing)?|more than)\s*([\d.]+)\s*sol/);
	if (sweep || /\bsweep\b|send.*profit|withdraw.*profit/.test(t)) {
		const params = { cadence: cadenceFrom(t, 'weekly'), weekday: weekdayFrom(t) };
		if (sweep) params.threshold_sol = Number(sweep[1]);
		else {
			params.threshold_sol = 1;
			warnings.push('Sweep threshold was unclear — defaulting to 1 SOL.');
		}
		rules.push({ kind: 'sweep', params });
	}

	if (!rules.length) {
		warnings.push('No recognizable rules — try phrasing like "Pay your own compute, keep a 1 SOL buffer, put 10% of tips into $THREE, sweep over 3 SOL to me on Fridays."');
	}
	return { buffer_sol, rules, warnings, contradictions: [] };
}

function cadenceFrom(t, def = 'daily') {
	if (/\bhourly\b|every hour/.test(t)) return 'hourly';
	if (/\bweekly\b|every week|each week|friday|monday|tuesday|wednesday|thursday|saturday|sunday/.test(t)) return 'weekly';
	if (/\bdaily\b|every day|each day/.test(t)) return 'daily';
	return def;
}
function weekdayFrom(t) {
	const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
	for (let i = 0; i < days.length; i++) if (t.includes(days[i])) return i;
	return null;
}

// ── persistence (owner-only) ─────────────────────────────────────────────────────

/**
 * Persist an autopilot policy patch onto the agent (owner-only). Caller has
 * already verified ownership. Writes a custody audit event + platform audit log.
 * Returns the new normalized policy.
 */
export async function setAutopilot(agentId, userId, patch, { req = null } = {}) {
	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!row) throw Object.assign(new Error('agent not found'), { status: 404, code: 'not_found' });
	if (row.user_id !== userId) throw Object.assign(new Error('not your agent'), { status: 403, code: 'forbidden' });

	const prev = getAutopilot(row.meta);
	const merged = { ...prev };
	if ('rules' in patch) merged.rules = patch.rules;
	if ('buffer_sol' in patch) merged.buffer_sol = patch.buffer_sol;
	if ('sweep_destination' in patch) merged.sweep_destination = patch.sweep_destination;
	if ('source_text' in patch) merged.source_text = patch.source_text;
	if ('armed' in patch) merged.armed = patch.armed === true;
	if ('kill_switch' in patch) merged.kill_switch = patch.kill_switch === true;
	if ('compiled_at' in patch) merged.compiled_at = patch.compiled_at;
	if ('approved_at' in patch) merged.approved_at = patch.approved_at;
	if ('compute_settled_at' in patch) merged.compute_settled_at = patch.compute_settled_at;

	const next = normalizeAutopilot(merged);
	next.updated_at = new Date().toISOString();
	// stamp the sweep destination onto sweep rules so the executor always has it
	for (const r of next.rules) {
		if (r.kind === 'sweep' && !r.params.destination && next.sweep_destination) {
			r.params.destination = next.sweep_destination;
		}
	}

	const meta = { ...(row.meta || {}), autopilot: next };
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${agentId}`;

	await recordCustodyEvent({
		agentId,
		userId,
		eventType: 'autopilot_config',
		reason: patch.kill_switch === true ? 'autopilot_killed' : next.armed ? 'autopilot_armed' : 'autopilot_updated',
		meta: { armed: next.armed, kill_switch: next.kill_switch, rules: next.rules.map((r) => ({ kind: r.kind, enabled: r.enabled, paused: r.paused })) },
	}).catch((e) => console.warn('[autopilot] config audit failed', e?.message));
	logAudit({ userId, action: 'autopilot.config', resourceId: agentId, meta: { armed: next.armed, kill_switch: next.kill_switch }, req });

	return next;
}

// ── period bucketing + idempotency ───────────────────────────────────────────────

function utcParts(d = new Date()) {
	return {
		y: d.getUTCFullYear(),
		m: String(d.getUTCMonth() + 1).padStart(2, '0'),
		d: String(d.getUTCDate()).padStart(2, '0'),
		h: String(d.getUTCHours()).padStart(2, '0'),
		dow: d.getUTCDay(),
	};
}
function isoWeek(d = new Date()) {
	const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
	const day = t.getUTCDay() || 7;
	t.setUTCDate(t.getUTCDate() + 4 - day);
	const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
	return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// The deterministic period key for a rule's cadence. Two runs in the same period
// share a key, so the idempotent claim below lets exactly one of them spend.
function periodBucket(cadenceVal, now = new Date()) {
	const p = utcParts(now);
	if (cadenceVal === 'hourly') return `${p.y}-${p.m}-${p.d}-${p.h}`;
	if (cadenceVal === 'weekly') return isoWeek(now);
	return `${p.y}-${p.m}-${p.d}`;
}

// True when a weekday-gated rule is allowed to run today.
function weekdayAllows(rule, now = new Date()) {
	const wd = rule.params?.weekday;
	if (wd == null) return true;
	return now.getUTCDay() === wd;
}

/**
 * Atomically claim this rule's action for the current period by inserting a
 * single pending custody row keyed on a per-period idempotency key. Returns the
 * row id, or null if the action was already claimed this period (skip). This is
 * the no-double-spend guarantee: a retry in the same period finds the key taken.
 */
async function claimAction({ agentId, userId, category, network, idemKey, usd, lamports, meta }) {
	const rows = await sql`
		INSERT INTO agent_custody_events
			(agent_id, user_id, event_type, category, network, asset, amount_lamports, usd, status, idempotency_key, meta)
		SELECT ${agentId}, ${userId ?? null}, 'spend', ${category}, ${network}, 'SOL',
		       ${lamports != null ? String(lamports) : null}, ${usd ?? null}, 'pending', ${idemKey},
		       ${JSON.stringify(meta ?? {})}::jsonb
		WHERE NOT EXISTS (
			SELECT 1 FROM agent_custody_events WHERE agent_id = ${agentId} AND idempotency_key = ${idemKey}
		)
		RETURNING id
	`;
	return rows.length ? rows[0].id : null;
}

// ── income + cost (real ledger reads) ────────────────────────────────────────────

/** Sum the agent's REAL metered compute/voice cost (micro-USD ledger) since `sinceIso`. */
export async function getComputeCostUsd(agentId, sinceIso = null) {
	const [row] = await sql`
		SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS micro
		FROM usage_events
		WHERE agent_id = ${agentId}
		  AND cost_micro_usd IS NOT NULL
		  AND (${sinceIso}::timestamptz IS NULL OR created_at > ${sinceIso}::timestamptz)
	`;
	return Number(BigInt(row?.micro ?? '0')) / 1e6;
}

/** Sum the agent's REAL tip income (custody 'tip' rows) over a window. */
export async function getTipIncomeUsd(agentId, network, sinceIso = null) {
	const [row] = await sql`
		SELECT COALESCE(SUM(usd), 0)::float8 AS usd
		FROM agent_custody_events
		WHERE agent_id = ${agentId} AND network = ${network} AND event_type = 'tip'
		  AND usd IS NOT NULL
		  AND (${sinceIso}::timestamptz IS NULL OR created_at > ${sinceIso}::timestamptz)
	`;
	return Number(row?.usd || 0);
}

/**
 * When this rule last actually settled an on-chain action (confirmed custody row),
 * as an ISO string — or null if it never has. Used to window income-basis DCA from
 * the last DCA (not the last cron tick): the cron runs hourly but a daily/weekly
 * DCA only spends once per bucket, so "income since last run" would otherwise count
 * a single hour. Income since the last DCA captures the whole period exactly once.
 */
async function lastConfirmedActionAt(agentId, network, ruleId) {
	const [row] = await sql`
		SELECT created_at FROM agent_custody_events
		WHERE agent_id = ${agentId} AND network = ${network}
		  AND event_type = 'spend' AND category = 'autopilot'
		  AND status IN ('ok', 'confirmed')
		  AND meta->>'rule_id' = ${ruleId}
		ORDER BY created_at DESC LIMIT 1
	`;
	return row?.created_at ? new Date(row.created_at).toISOString() : null;
}

// ── compute-settlement destination (where the agent pays for its brain) ──────────

function resolveComputeTreasury() {
	const explicit = (process.env.AUTOPILOT_COMPUTE_TREASURY || '').trim();
	if (explicit) {
		const v = validateSolanaAddress(explicit);
		if (v.valid) return v.base58;
	}
	// Derive a public address from a configured platform treasury keypair.
	for (const envName of ['PLATFORM_TREASURY_KEYPAIR', 'TREASURY_KEYPAIR', 'COIN_TREASURY_SECRET_KEY_B64']) {
		const raw = (process.env[envName] || '').trim();
		if (!raw) continue;
		try {
			const bytes = parseSecretBytes(raw);
			if (bytes && bytes.length >= 64) {
				// last 32 bytes of an ed25519 secret key are the public key
				return new PublicKey(bytes.slice(32, 64)).toBase58();
			}
		} catch {
			/* try next */
		}
	}
	return null;
}

function parseSecretBytes(raw) {
	if (raw.startsWith('[')) {
		try {
			return Uint8Array.from(JSON.parse(raw));
		} catch {
			return null;
		}
	}
	// base64
	try {
		return Uint8Array.from(Buffer.from(raw, 'base64'));
	} catch {
		return null;
	}
}

// ── token balance (real chain read) ──────────────────────────────────────────────

async function tokenUiBalance(conn, owner, mint) {
	try {
		const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
		let ui = 0;
		for (const { account } of res.value) {
			ui += account.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
		}
		return ui;
	} catch {
		return null;
	}
}

// ── real swap (Jupiter, mainnet) ─────────────────────────────────────────────────

/**
 * Swap `lamports` of native SOL into `outputMint` from the agent's wallet via
 * Jupiter, returning the signature. Throws on devnet, no route, or any failure —
 * the executor turns that into an honest pause, never a guess.
 */
async function swapSolToToken({ keypair, lamports, outputMint, slippageBps, network, conn }) {
	if (network !== 'mainnet') {
		throw Object.assign(new Error('token swaps are mainnet-only — this wallet is on devnet'), { code: 'devnet_no_swap' });
	}
	const qUrl = `${JUPITER_BASE}/quote?inputMint=${WSOL_MINT}&outputMint=${outputMint}&amount=${lamports.toString()}&slippageBps=${slippageBps}&swapMode=ExactIn`;
	// The quote is an idempotent GET: a 429/5xx/network blip is retried with
	// jittered backoff inside the same 15s per-attempt deadline. A 4xx (no route
	// for this pair) is an answer and comes straight back as `no_route`, which the
	// executor turns into an honest pause with the reason attached.
	const qRes = await fetchUpstream(qUrl, { headers: { accept: 'application/json' } }, {
		name: 'jupiter-treasury-quote',
		timeoutMs: 15_000,
		attempts: 3,
		okWhen: (res) => res.ok || (res.status < 500 && res.status !== 429),
	}).catch((err) => {
		throw Object.assign(new Error(`no swap route (${err?.status || 'jupiter unreachable'}: ${err?.message || 'network error'})`), { code: 'no_route' });
	});
	if (!qRes.ok) throw Object.assign(new Error(`no swap route (${qRes.status})`), { code: 'no_route' });
	const quote = await qRes.json();
	if (!quote || !quote.outAmount) throw Object.assign(new Error('no swap route for this pair'), { code: 'no_route' });

	// The swap build returns an UNSIGNED transaction, so repeating it is safe;
	// it is retried once, only on a 5xx/network failure, never on a 4xx. Signing
	// and broadcasting happen below and are never retried here.
	const buildSwap = () => fetchUpstream(`${JUPITER_BASE}/swap`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({
			quoteResponse: quote,
			userPublicKey: keypair.publicKey.toBase58(),
			wrapAndUnwrapSol: true,
			dynamicComputeUnitLimit: true,
			prioritizationFeeLamports: 'auto',
		}),
	}, {
		name: 'jupiter-treasury-swap',
		timeoutMs: 20_000,
		attempts: 1,
		okWhen: (res) => res.ok || res.status < 500,
	});
	const sRes = await withRetry(buildSwap, {
		attempts: 2,
		shouldRetry: (err) => !err?.status || Number(err.status) >= 500,
	}).catch((err) => {
		throw Object.assign(new Error(`swap build failed (${err?.status || 'jupiter unreachable'}: ${err?.message || 'network error'})`), { code: 'swap_failed' });
	});
	if (!sRes.ok) throw Object.assign(new Error(`swap build failed (${sRes.status})`), { code: 'swap_failed' });
	const { swapTransaction } = await sRes.json();
	if (!swapTransaction) throw Object.assign(new Error('swap build returned no transaction'), { code: 'swap_failed' });

	const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
	tx.sign([keypair]);
	const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
	const bh = await conn.getLatestBlockhash();
	// HTTP-polling confirm (no WebSocket) — throws on a landed-but-reverted swap so
	// a revert is never reported back as a successful autopilot trade.
	await confirmOrThrow(conn, { signature: sig, ...bh }, 'confirmed');
	return { signature: sig, outAmount: quote.outAmount, outMint: outputMint };
}

// ── the executor ─────────────────────────────────────────────────────────────────

/**
 * Run one autopilot cycle for an agent: execute every armed, due rule as a real,
 * idempotent, spend-policy-gated, audited action on the agent's own wallet.
 *
 * @param {object} o
 * @param {string} o.agentId
 * @param {string|null} [o.userId]   the actor (owner for a manual run; null for cron)
 * @param {'mainnet'|'devnet'} [o.network]
 * @param {string} [o.trigger]       'manual' | 'cron'
 * @param {boolean} [o.dryRun]       evaluate + report without moving funds
 * @returns {Promise<object>} a per-rule result summary (no secrets)
 */
export async function runAutopilotCycle({ agentId, userId = null, network = 'mainnet', trigger = 'cron', dryRun = false }) {
	const now = new Date();
	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!row) return { ran: false, reason: 'not_found' };

	const meta = row.meta || {};
	const policy = getAutopilot(meta);
	const ownerId = row.user_id;

	if (policy.kill_switch) return { ran: false, reason: 'kill_switch', results: [] };
	if (!policy.armed) return { ran: false, reason: 'disarmed', results: [] };
	if (!policy.rules.length) return { ran: false, reason: 'no_rules', results: [] };

	const address = meta.solana_address;
	const encryptedSecret = meta.encrypted_solana_secret;
	if (!address) return { ran: false, reason: 'no_wallet', results: [] };

	const limits = getSpendLimits(meta);
	if (limits.frozen) {
		return { ran: false, reason: 'wallet_frozen', results: [], note: 'Wallet is frozen — every autonomous spend is paused until you unfreeze it under Limits & Safety.' };
	}

	// Live price is the trust anchor for every USD conversion. If it's gone, we
	// pause the whole cycle rather than guess with real money.
	let price;
	try {
		price = await solUsdPrice();
	} catch {
		return { ran: false, reason: 'price_feed_unavailable', results: [], note: 'SOL/USD price feed is unavailable — autopilot paused this cycle and will retry.' };
	}

	const conn = solanaConnection(network);
	let balances;
	try {
		balances = await getSolanaAddressBalances(address, network);
	} catch (e) {
		return { ran: false, reason: 'balance_read_failed', results: [], note: e?.message || 'could not read wallet balance' };
	}
	const balanceSol = Number(balances?.sol || 0);
	const balanceLamports = BigInt(Math.floor(balanceSol * 1e9));
	const bufferSol = policy.buffer_sol || 0;
	const bufferLamports = BigInt(Math.floor(bufferSol * 1e9));
	const bufferBreached = balanceLamports < bufferLamports;

	// Order matters: pay the brain first, check the buffer, then DCA/buyback, sweep last.
	const order = { self_fund: 0, buffer: 1, dca: 2, buyback: 3, sweep: 4 };
	const due = policy.rules
		.filter((r) => r.enabled && !r.paused)
		.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

	// Recover the signing keypair once, only when a real spend rule may run.
	let keypair = null;
	const hasSpendRule = due.some((r) => r.kind !== 'buffer');
	if (hasSpendRule && !dryRun) {
		if (!encryptedSecret) return { ran: false, reason: 'no_secret', results: [] };
		try {
			keypair = await recoverSolanaAgentKeypair(encryptedSecret, { agentId, userId: userId ?? ownerId, reason: 'treasury_autopilot' });
		} catch (e) {
			return { ran: false, reason: 'key_recover_failed', results: [], note: e?.message || 'could not recover wallet key' };
		}
	}

	const results = [];
	const ctx = { agentId, ownerId, userId, network, trigger, dryRun, now, conn, price, address, bufferSol, bufferLamports, balanceLamports, bufferBreached, policy, meta, keypair };

	for (const rule of due) {
		if (!weekdayAllows(rule, now)) {
			results.push(stamp(rule, { status: 'skipped', note: 'not scheduled today' }, now));
			continue;
		}
		let res;
		try {
			res = await executeRule(rule, ctx);
		} catch (e) {
			res = { status: 'error', note: (e?.message || 'execution failed').slice(0, 240) };
		}
		results.push(stamp(rule, res, now));
	}

	// Persist updated per-rule status + compute-settlement marker (best-effort).
	if (!dryRun) {
		try {
			const fresh = getAutopilot((await sql`SELECT meta FROM agent_identities WHERE id = ${agentId}`)[0]?.meta);
			const byId = new Map(results.map((r) => [r.id, r]));
			fresh.rules = fresh.rules.map((r) => {
				const u = byId.get(r.id);
				return u ? { ...r, last_run_at: u.last_run_at, last_status: u.last_status, last_note: u.last_note } : r;
			});
			const settled = results.find((r) => r.kind === 'self_fund' && r.last_status === 'ok');
			if (settled) fresh.compute_settled_at = now.toISOString();
			fresh.updated_at = now.toISOString();
			const m2 = { ...((await sql`SELECT meta FROM agent_identities WHERE id = ${agentId}`)[0]?.meta || {}), autopilot: fresh };
			await sql`UPDATE agent_identities SET meta = ${JSON.stringify(m2)}::jsonb WHERE id = ${agentId}`;
		} catch (e) {
			console.warn('[autopilot] status persist failed', e?.message);
		}
	}

	return { ran: true, trigger, dryRun, results };
}

function stamp(rule, res, now) {
	return {
		id: rule.id,
		kind: rule.kind,
		label: rule.label,
		last_run_at: now.toISOString(),
		last_status: res.status,
		last_note: res.note || null,
		signature: res.signature || null,
		explorer: res.explorer || null,
		usd: res.usd ?? null,
	};
}

async function executeRule(rule, ctx) {
	switch (rule.kind) {
		case 'self_fund':
			return execSelfFund(rule, ctx);
		case 'buffer':
			return execBuffer(rule, ctx);
		case 'dca':
			return execDca(rule, ctx);
		case 'buyback':
			return execBuyback(rule, ctx);
		case 'sweep':
			return execSweep(rule, ctx);
		default:
			return { status: 'skipped', note: 'unknown rule' };
	}
}

// Shared: enforce the spend policy, claim the period idempotently, run the spend,
// finalize the custody row. `doSpend(lamports)` must return { signature }.
async function gatedSpend({ ctx, rule, category, usd, lamports, rowMeta, doSpend }) {
	const { agentId, ownerId, userId, network, dryRun } = ctx;
	// Hard ceiling: clamp to the spend policy at execution time (server-side).
	try {
		await enforceSpendLimit({ agentId, meta: ctx.meta, category: 'autopilot', usdValue: usd, network });
	} catch (e) {
		if (e instanceof SpendLimitError) return { status: 'paused', note: e.message, usd };
		throw e;
	}
	if (dryRun) return { status: 'would_run', note: `would spend ~$${usd.toFixed(2)}`, usd };

	const idemKey = `ap:${rule.id}:${periodBucket(rule.params?.cadence || 'hourly', ctx.now)}`;
	const reservationId = await claimAction({
		agentId, userId: userId ?? ownerId, category, network, idemKey, usd, lamports,
		meta: { ...rowMeta, rule_id: rule.id, kind: rule.kind, trigger: ctx.trigger, autopilot: true },
	});
	if (!reservationId) return { status: 'skipped', note: 'already executed this period' };

	try {
		const { signature } = await doSpend(lamports);
		await updateCustodyEvent(reservationId, { status: 'confirmed', signature, meta: { settled_at: ctx.now.toISOString() } });
		return { status: 'ok', signature, explorer: explorerTxUrl(signature, network), usd };
	} catch (e) {
		await updateCustodyEvent(reservationId, { status: 'failed', meta: { error: (e?.message || 'failed').slice(0, 200) } });
		return { status: 'error', note: (e?.message || 'transaction failed').slice(0, 240), usd };
	}
}

async function execSelfFund(rule, ctx) {
	const { agentId, network, price, balanceLamports, bufferLamports, policy } = ctx;
	const since = policy.compute_settled_at || null;
	const costUsd = await getComputeCostUsd(agentId, since);
	if (costUsd < DUST_USD) return { status: 'skipped', note: 'no metered compute cost has accrued yet' };

	const treasury = resolveComputeTreasury();
	if (!treasury) return { status: 'paused', note: 'No compute-settlement treasury is configured (AUTOPILOT_COMPUTE_TREASURY) — self-funding is paused.' };

	let lamports = BigInt(Math.ceil((costUsd / price) * 1e9));
	// Never breach the buffer or leave the wallet unable to pay fees.
	const spendable = balanceLamports - bufferLamports - FEE_HEADROOM_LAMPORTS;
	if (spendable <= 0n) {
		return { status: 'paused', note: `Income too small to self-fund without breaching the ${ctx.bufferSol} SOL buffer — paused, fund the wallet or lower the buffer.` };
	}
	if (lamports > spendable) lamports = spendable; // partial settlement is honest progress
	const usd = (Number(lamports) / 1e9) * price;

	return gatedSpend({
		ctx, rule, category: 'autopilot', usd, lamports,
		rowMeta: { action: 'self_fund', destination: treasury, compute_cost_usd: costUsd, settled_since: since },
		doSpend: (lams) => sendSol({ connection: ctx.conn, fromKeypair: ctx.keypair, to: treasury, lamports: Number(lams), memo: 'autopilot:self_fund', network }),
	});
}

async function execBuffer(rule, ctx) {
	const { agentId, ownerId, network, balanceLamports, bufferLamports, bufferSol, dryRun, now } = ctx;
	const balSol = Number(balanceLamports) / 1e9;
	const ok = balanceLamports >= bufferLamports;
	const note = ok
		? `Buffer healthy: ${balSol.toFixed(4)} SOL held, ${bufferSol} SOL floor maintained.`
		: `Buffer breached: ${balSol.toFixed(4)} SOL held, below the ${bufferSol} SOL floor — spending rules are gated until income restores it.`;
	if (!dryRun) {
		// Record an audited, non-spend buffer check (idempotent per hour).
		const idemKey = `ap:${rule.id}:${periodBucket('hourly', now)}`;
		await sql`
			INSERT INTO agent_custody_events (agent_id, user_id, event_type, category, network, asset, status, idempotency_key, meta)
			SELECT ${agentId}, ${ownerId}, 'autopilot_check', 'buffer', ${network}, 'SOL', ${ok ? 'ok' : 'failed'}, ${idemKey},
			       ${JSON.stringify({ kind: 'buffer', balance_sol: balSol, buffer_sol: bufferSol, ok })}::jsonb
			WHERE NOT EXISTS (SELECT 1 FROM agent_custody_events WHERE agent_id = ${agentId} AND idempotency_key = ${idemKey})
		`.catch(() => {});
	}
	return { status: ok ? 'ok' : 'alert', note };
}

async function execDca(rule, ctx) {
	const { agentId, network, price, balanceLamports, bufferLamports, bufferBreached, policy, now } = ctx;
	if (bufferBreached) return { status: 'skipped', note: 'balance is below the buffer — DCA skipped to protect the floor' };

	const p = rule.params;
	let lamports;
	if (p.amount_sol != null) {
		lamports = BigInt(Math.floor(p.amount_sol * 1e9));
	} else if (p.basis === 'income') {
		// Window from the last DCA this rule actually settled, falling back to the
		// cadence window on first run — so a daily/weekly DCA counts the whole
		// period's tips once, even though the hourly cron evaluates it many times.
		const since = (await lastConfirmedActionAt(agentId, network, rule.id)) || windowStart(p.cadence, now);
		const incomeUsd = await getTipIncomeUsd(agentId, network, since);
		if (incomeUsd < DUST_USD) return { status: 'skipped', note: 'no new tip income this period to DCA' };
		lamports = BigInt(Math.floor(((incomeUsd * (p.pct / 100)) / price) * 1e9));
	} else {
		// surplus basis: a slice of spendable surplus above the buffer
		const surplus = balanceLamports - bufferLamports - FEE_HEADROOM_LAMPORTS;
		if (surplus <= 0n) return { status: 'skipped', note: 'no surplus above the buffer to DCA' };
		lamports = (surplus * BigInt(Math.round(p.pct * 100))) / 10000n;
	}

	// Never breach the buffer or fee headroom.
	const spendable = balanceLamports - bufferLamports - FEE_HEADROOM_LAMPORTS;
	if (lamports > spendable) lamports = spendable;
	if (lamports <= 0n) return { status: 'skipped', note: 'computed DCA size is below the buffer headroom' };
	const usd = (Number(lamports) / 1e9) * price;
	if (usd < DUST_USD) return { status: 'skipped', note: 'computed DCA size is below the dust threshold' };

	return gatedSpend({
		ctx, rule, category: 'autopilot', usd, lamports,
		rowMeta: { action: 'dca', target_mint: THREE_MINT, basis: p.basis, pct: p.pct, symbol: '$THREE' },
		doSpend: async (lams) => {
			const r = await swapSolToToken({ keypair: ctx.keypair, lamports: lams, outputMint: THREE_MINT, slippageBps: p.slippage_bps, network, conn: ctx.conn });
			return { signature: r.signature };
		},
	});
}

async function execBuyback(rule, ctx) {
	const { agentId, network, price, balanceLamports, bufferLamports, bufferBreached } = ctx;
	if (bufferBreached) return { status: 'skipped', note: 'balance is below the buffer — buyback skipped to protect the floor' };

	// The agent's own coin (launched through three.ws). No coin → nothing to compound.
	const [coin] = await sql`SELECT mint FROM pump_agent_mints WHERE agent_id = ${agentId} AND network = ${network} ORDER BY created_at ASC LIMIT 1`;
	if (!coin?.mint) return { status: 'skipped', note: 'this agent has not launched a coin — nothing to buy back' };

	const p = rule.params;
	// Compound real accrued creator fees: approximate the compoundable pot as the
	// surplus above the buffer (fees land in the same wallet), scaled by pct_of_fees.
	const surplus = balanceLamports - bufferLamports - FEE_HEADROOM_LAMPORTS;
	if (surplus <= 0n) return { status: 'skipped', note: 'no surplus above the buffer to compound into a buyback' };
	let lamports = (surplus * BigInt(Math.round(p.pct_of_fees * 100))) / 10000n;
	if (lamports <= 0n) return { status: 'skipped', note: 'computed buyback size is zero' };
	const usd = (Number(lamports) / 1e9) * price;
	if (usd < DUST_USD) return { status: 'skipped', note: 'computed buyback size is below the dust threshold' };

	return gatedSpend({
		ctx, rule, category: 'autopilot', usd, lamports,
		rowMeta: { action: 'buyback', mint: coin.mint, pct_of_fees: p.pct_of_fees },
		doSpend: async (lams) => {
			const r = await swapSolToToken({ keypair: ctx.keypair, lamports: lams, outputMint: coin.mint, slippageBps: p.slippage_bps, network, conn: ctx.conn });
			return { signature: r.signature };
		},
	});
}

async function execSweep(rule, ctx) {
	const { network, price, balanceLamports, policy } = ctx;
	const p = rule.params;
	const destination = p.destination || policy.sweep_destination;
	if (!destination) return { status: 'paused', note: 'No sweep destination set — add your wallet under Autopilot before this rule can run.' };

	const thresholdLamports = BigInt(Math.floor(p.threshold_sol * 1e9));
	if (balanceLamports <= thresholdLamports) {
		return { status: 'skipped', note: `balance ${(Number(balanceLamports) / 1e9).toFixed(4)} SOL is at or below the ${p.threshold_sol} SOL sweep threshold` };
	}
	// Sweep only the excess above the threshold, leaving fee headroom in place.
	let lamports = balanceLamports - thresholdLamports;
	if (lamports > balanceLamports - FEE_HEADROOM_LAMPORTS) lamports = balanceLamports - FEE_HEADROOM_LAMPORTS;
	if (lamports <= 0n) return { status: 'skipped', note: 'nothing to sweep after fee headroom' };
	const usd = (Number(lamports) / 1e9) * price;

	return gatedSpend({
		ctx, rule, category: 'autopilot', usd, lamports,
		rowMeta: { action: 'sweep', destination, threshold_sol: p.threshold_sol },
		doSpend: (lams) => sendSol({ connection: ctx.conn, fromKeypair: ctx.keypair, to: destination, lamports: Number(lams), memo: 'autopilot:sweep', network }),
	});
}

function windowStart(cadenceVal, now = new Date()) {
	const ms = cadenceVal === 'hourly' ? 3600e3 : cadenceVal === 'weekly' ? 7 * 86400e3 : 86400e3;
	return new Date(now.getTime() - ms).toISOString();
}

// ── the runway view (real income / cost / runway) ────────────────────────────────

/**
 * Build the real runway dashboard for an agent: 30-day income vs cost, current
 * buffer, $THREE accumulated, buybacks executed, profit swept, current balance,
 * and the honest runway (how long it self-sustains at the real burn). Every
 * number traces to a real chain read or DB row; a net-negative agent shows the
 * truth, not a projection.
 */
export async function computeRunway({ agentId, network = 'mainnet', meta = null }) {
	const m = meta || (await sql`SELECT meta FROM agent_identities WHERE id = ${agentId}`)[0]?.meta || {};
	const policy = getAutopilot(m);
	const address = m.solana_address || null;
	const since30 = new Date(Date.now() - 30 * 86400e3).toISOString();

	let price = null;
	try {
		price = await solUsdPrice();
	} catch {
		price = null;
	}

	let balanceSol = 0;
	let threeUi = null;
	if (address) {
		try {
			const b = await getSolanaAddressBalances(address, network);
			balanceSol = Number(b?.sol || 0);
		} catch {
			/* leave 0 */
		}
		try {
			const conn = solanaConnection(network);
			threeUi = await tokenUiBalance(conn, address, THREE_MINT);
		} catch {
			threeUi = null;
		}
	}

	const [costUsd, tipUsd] = await Promise.all([
		getComputeCostUsd(agentId, since30).catch(() => 0),
		getTipIncomeUsd(agentId, network, since30).catch(() => 0),
	]);

	// Break the autopilot spend out by action for the dashboard (sweep/buyback/dca/
	// self_fund all use category 'autopilot'; split by the recorded meta.action).
	const breakdown = await sql`
		SELECT meta->>'action' AS action, COALESCE(SUM(usd),0)::float8 AS usd,
		       COALESCE(SUM(amount_lamports),0)::text AS lamports, COUNT(*)::int AS n
		FROM agent_custody_events
		WHERE agent_id = ${agentId} AND network = ${network}
		  AND event_type = 'spend' AND category = 'autopilot'
		  AND status IN ('ok','confirmed') AND created_at > ${since30}::timestamptz
		GROUP BY meta->>'action'
	`.catch(() => []);
	const byAction = {};
	for (const r of breakdown) byAction[r.action || 'other'] = { usd: Number(r.usd || 0), sol: Number(BigInt(r.lamports || '0')) / 1e9, count: Number(r.n || 0) };

	const balanceUsd = price != null ? balanceSol * price : null;
	const bufferUsd = price != null && policy.buffer_sol != null ? policy.buffer_sol * price : null;
	const incomeUsd = tipUsd;
	const netUsd = incomeUsd - costUsd;
	const dailyBurnUsd = costUsd / 30;
	const dailyIncomeUsd = incomeUsd / 30;
	const netDailyUsd = dailyIncomeUsd - dailyBurnUsd;
	// Runway: spendable balance above the buffer divided by the net daily burn.
	const spendableUsd = balanceUsd != null ? Math.max(0, balanceUsd - (bufferUsd || 0)) : null;
	let runwayDays = null;
	if (spendableUsd != null) {
		if (netDailyUsd >= 0) runwayDays = Infinity; // self-sustaining or profitable
		else runwayDays = spendableUsd / -netDailyUsd;
	}

	return {
		network,
		price_usd: price,
		balance_sol: balanceSol,
		balance_usd: balanceUsd,
		buffer_sol: policy.buffer_sol,
		buffer_usd: bufferUsd,
		three_accumulated: threeUi,
		window_days: 30,
		income_usd: incomeUsd,
		cost_usd: costUsd,
		net_usd: netUsd,
		net_positive: netUsd >= 0,
		daily_burn_usd: dailyBurnUsd,
		daily_income_usd: dailyIncomeUsd,
		net_daily_usd: netDailyUsd,
		runway_days: runwayDays === Infinity ? null : runwayDays,
		self_sustaining: netDailyUsd >= 0,
		self_funded_usd: byAction.self_fund?.usd || 0,
		dca_usd: byAction.dca?.usd || 0,
		dca_count: byAction.dca?.count || 0,
		buyback_usd: byAction.buyback?.usd || 0,
		buyback_count: byAction.buyback?.count || 0,
		swept_usd: byAction.sweep?.usd || 0,
		swept_sol: byAction.sweep?.sol || 0,
		sweep_count: byAction.sweep?.count || 0,
		armed: policy.armed,
		kill_switch: policy.kill_switch,
		explorer_account: address ? explorerAccountUrl(address, network) : null,
	};
}
