// Wallet Intents engine — the programmable, conversational money layer.
//
// An intent is an owner-owned policy that makes an agent's custodial Solana
// wallet REACT to real events. The owner describes it in plain language; an LLM
// compiles it into a STRICT, server-validated structured intent; and the cron
// engine here executes enabled intents on their trigger through the SAME
// owner-authorized, spend-policy-gated, audited signing paths every other
// outbound action uses. An intent can NEVER exceed the agent's spend policy
// (enforceSpendLimit), and every real execution writes an agent_custody_events
// row with meta.intent_id so the owner sees real receipts.
//
// Triggers : on_tip_received | on_income | on_balance_below | on_schedule
//            | on_launch_matching | on_stream_started
// Actions  : tip | transfer | buy | snipe | withdraw | split_income | freeze | notify
//
// $THREE is the only coin three.ws promotes. "$THREE"/"three" resolves to its
// canonical mint; any other mint is the owner's own runtime input (a snipe
// target), never hardcoded or recommended.
//
// This file deliberately reuses the building blocks proven by the Treasury
// Autopilot engine (sendSol, swap, the gated-spend → claim → finalize custody
// pattern) so intents move money exactly the way the rest of the wallet does.

import { PublicKey } from '@solana/web3.js';
import { sql } from './db.js';
import { confirmOrThrow } from './solana/confirm.js';
import { solUsdPrice, sendSol, explorerTxUrl } from './avatar-wallet.js';
import { solanaConnection } from './agent-pumpfun.js';
import { getSolanaAddressBalances, recoverSolanaAgentKeypair } from './agent-wallet.js';
import {
	getSpendLimits,
	getTradeLimits,
	setSpendLimits,
	enforceSpendLimit,
	SpendLimitError,
	recordCustodyEvent,
	updateCustodyEvent,
	validateSolanaAddress,
	lamportsToUsd,
	SOL_FEE_HEADROOM_LAMPORTS,
} from './agent-trade-guards.js';
import { THREE_MINT } from './networth-model.js';
import { resolveSolanaRecipient } from '../../src/solana/sns.js';
import { recentPumpLaunches, enrichCreatorStats } from './pump-launch-feed.js';
import { logAudit } from './audit.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_BASE = 'https://lite-api.jup.ag/swap/v1';
const LAMPORTS_PER_SOL = 1_000_000_000n;
const DUST_USD = 0.02;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const INTENT_TRIGGERS = Object.freeze([
	'on_tip_received',
	'on_income',
	'on_balance_below',
	'on_schedule',
	'on_launch_matching',
	'on_stream_started',
]);

export const INTENT_ACTIONS = Object.freeze([
	'tip',
	'transfer',
	'buy',
	'snipe',
	'withdraw',
	'split_income',
	'freeze',
	'notify',
]);

// Actions that move funds (need spend-policy enforcement + a signing keypair).
const SPENDING_ACTIONS = new Set(['tip', 'transfer', 'buy', 'snipe', 'withdraw', 'split_income']);

// ── small pure helpers ───────────────────────────────────────────────────────────

function num(v, def = null) {
	const n = Number(v);
	return Number.isFinite(n) ? n : def;
}
function clamp(n, min, max) {
	return Math.max(min, Math.min(max, n));
}
function posNum(v) {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
}
function str(v, max = 280) {
	return typeof v === 'string' ? v.slice(0, max) : '';
}
function solToLamports(sol) {
	return BigInt(Math.floor(Number(sol) * 1e9));
}

// Resolve a free-text asset reference to a canonical Solana asset. $THREE is the
// only coin we resolve by name; everything else is SOL, USDC, a raw mint, or
// unknown — mirrors api/agents/solana-intent.js so both speak the same language.
export function resolveAssetToken(raw, { threeMint = THREE_MINT } = {}) {
	const s = String(raw || '').trim();
	if (!s) return { kind: 'none', mint: null, symbol: null };
	const lower = s.toLowerCase().replace(/^\$/, '');
	if (lower === 'sol' || lower === 'solana') return { kind: 'sol', mint: null, symbol: 'SOL' };
	if (lower === 'usdc') return { kind: 'usdc', mint: null, symbol: 'USDC' };
	if (lower === 'three') return { kind: 'three', mint: threeMint, symbol: '$THREE' };
	if (BASE58_RE.test(s)) {
		return { kind: s === threeMint ? 'three' : 'mint', mint: s, symbol: s === threeMint ? '$THREE' : null };
	}
	return { kind: 'unknown', mint: null, symbol: s };
}

// ── normalization / validation ───────────────────────────────────────────────────
//
// Turn a raw intent (from the LLM tool call OR the manual form) into the canonical
// stored shape. Anything malformed degrades to a precise validation error — money
// must never move on a guess. Returns { ok, intent } | { ok:false, error, message }.

export function normalizeIntent(raw, { threeMint = THREE_MINT } = {}) {
	const r = raw && typeof raw === 'object' ? raw : {};

	const triggerType = String(r.trigger_type || r.trigger?.type || '').trim();
	if (!INTENT_TRIGGERS.includes(triggerType)) {
		return { ok: false, error: 'bad_trigger', message: `unsupported trigger "${triggerType || '(none)'}"` };
	}
	const actionType = String(r.action_type || r.action?.type || '').trim();
	if (!INTENT_ACTIONS.includes(actionType)) {
		return { ok: false, error: 'bad_action', message: `unsupported action "${actionType || '(none)'}"` };
	}

	const tcfg = r.trigger_config || r.trigger || {};
	const acfg = r.action_config || r.action || {};

	// ── trigger config ──
	const trigger = { type: triggerType };
	if (triggerType === 'on_tip_received') {
		trigger.min_sol = posNum(tcfg.min_sol) ?? 0;
	} else if (triggerType === 'on_balance_below') {
		const t = posNum(tcfg.threshold_sol);
		if (t == null) return { ok: false, error: 'needs_threshold', message: 'a balance threshold (SOL) is required' };
		trigger.threshold_sol = t;
	} else if (triggerType === 'on_schedule') {
		trigger.cadence = ['daily', 'weekly'].includes(tcfg.cadence) ? tcfg.cadence : 'weekly';
		const wd = Number(tcfg.weekday);
		trigger.weekday = trigger.cadence === 'weekly' ? (Number.isInteger(wd) && wd >= 0 && wd <= 6 ? wd : 5) : null;
		const hr = Number(tcfg.hour);
		trigger.hour = Number.isInteger(hr) && hr >= 0 && hr <= 23 ? hr : 13;
	} else if (triggerType === 'on_launch_matching') {
		const creator = str(tcfg.creator, 64).trim();
		trigger.creator = creator && BASE58_RE.test(creator) ? creator : null;
		trigger.max_mcap_usd = posNum(tcfg.max_mcap_usd);
		trigger.min_mcap_usd = posNum(tcfg.min_mcap_usd);
		if (!trigger.creator && trigger.max_mcap_usd == null) {
			return { ok: false, error: 'needs_filter', message: 'a launch rule needs a creator address and/or a max market cap to match on' };
		}
	}
	// on_income / on_stream_started carry no required config.

	// ── action config ──
	const action = { type: actionType };
	if (actionType === 'freeze') {
		// no params — the kill switch
	} else if (actionType === 'notify') {
		action.message = str(acfg.message, 280) || null;
		action.channel = ['email', 'log'].includes(acfg.channel) ? acfg.channel : 'email';
	} else if (actionType === 'buy' || actionType === 'snipe') {
		// For on_launch_matching/snipe the mint is supplied at fire time (the matched
		// launch); otherwise the owner names a mint/symbol to acquire.
		const tgt = resolveAssetToken(acfg.mint || acfg.destination_or_mint || acfg.target, { threeMint });
		action.mint = tgt.mint || (tgt.kind === 'three' ? threeMint : null);
		action.mint_symbol = tgt.symbol || null;
		action.amount_sol = posNum(acfg.amount_sol);
		if (action.amount_sol == null) return { ok: false, error: 'needs_amount', message: `${actionType} needs a SOL amount to spend` };
		const slip = num(acfg.slippage_pct);
		action.slippage_pct = slip != null ? clamp(slip, 0, 50) : 5;
		// For a non-launch buy the mint must be known up front.
		if (triggerType !== 'on_launch_matching' && !action.mint) {
			return { ok: false, error: 'needs_mint', message: 'name the token to buy ($THREE or a mint address)' };
		}
	} else {
		// tip | transfer | withdraw | split_income — move SOL to a destination.
		const pct = posNum(acfg.pct);
		const amount = posNum(acfg.amount_sol);
		const above = posNum(acfg.above_sol);
		action.pct = pct != null ? clamp(pct, 0.01, 100) : null;
		action.amount_sol = amount;
		action.above_sol = above; // for withdraw: "profit above N SOL"
		action.of = ['tip', 'income', 'balance'].includes(acfg.of) ? acfg.of : (pct != null ? (actionType === 'split_income' ? 'income' : 'tip') : null);
		action.destination = str(acfg.destination, 64).trim();
		action.destination_label = str(acfg.destination_label, 80) || null;
		// A tip back to whoever just tipped has no static destination — the engine
		// fills the tipper in at fire time. Recognize that here so the rule validates.
		action.to_tipper = acfg.to_tipper === true || (actionType === 'tip' && triggerType === 'on_tip_received' && !action.destination);

		if (actionType === 'split_income') {
			if (action.pct == null) return { ok: false, error: 'needs_pct', message: 'split needs a percentage of income' };
			action.of = 'income';
		}
		if (actionType === 'tip' || actionType === 'transfer') {
			if (action.pct == null && action.amount_sol == null) {
				return { ok: false, error: 'needs_amount', message: 'a tip/transfer needs a fixed SOL amount or a percentage' };
			}
		}
		if (actionType === 'withdraw') {
			if (action.amount_sol == null && action.above_sol == null && action.pct == null) {
				return { ok: false, error: 'needs_amount', message: 'a withdraw needs an amount, a "profit above N SOL" threshold, or a percentage' };
			}
		}
		if (!action.destination && !action.to_tipper) {
			return { ok: false, error: 'needs_destination', message: `${actionType} needs a destination address or .sol name` };
		}
	}

	// ── owner-set caps (clamped under the spend policy at execution time) ──
	const lim = r.limits || {};
	const limits = {
		per_action_usd: posNum(lim.per_action_usd),
		daily_usd: posNum(lim.daily_usd),
		total_usd: posNum(lim.total_usd),
	};

	const intent = {
		title: str(r.title, 80).trim() || defaultTitle(triggerType, actionType, action),
		trigger,
		action,
		limits,
		readback: str(r.readback, 280).trim() || null,
	};
	return { ok: true, intent };
}

function defaultTitle(triggerType, actionType, action) {
	const T = {
		on_tip_received: 'On a tip',
		on_income: 'On income',
		on_balance_below: 'On low balance',
		on_schedule: 'On schedule',
		on_launch_matching: 'On matching launch',
		on_stream_started: 'On stream start',
	}[triggerType] || 'Intent';
	const A = {
		tip: 'tip back',
		transfer: 'transfer',
		buy: `buy ${action?.mint_symbol || 'token'}`,
		snipe: 'snipe',
		withdraw: 'withdraw',
		split_income: 'split income',
		freeze: 'freeze the wallet',
		notify: 'notify me',
	}[actionType] || actionType;
	return `${T} → ${A}`;
}

// One-sentence human read-back when the model didn't supply one.
export function describeIntent(intent) {
	if (intent.readback) return intent.readback;
	const t = intent.trigger || {};
	const a = intent.action || {};
	const dest = a.destination_label || (a.destination ? `${a.destination.slice(0, 4)}…${a.destination.slice(-4)}` : '');
	const amt = a.pct != null ? `${a.pct}%${a.of ? ` of ${a.of}` : ''}` : a.amount_sol != null ? `${a.amount_sol} SOL` : a.above_sol != null ? `anything above ${a.above_sol} SOL` : '';
	switch (t.type) {
		case 'on_tip_received':
			return `When someone tips ${t.min_sol ? `more than ${t.min_sol} SOL` : 'me'}, ${a.type === 'tip' ? `tip back ${amt}` : `${a.type} ${amt} to ${dest}`}.`;
		case 'on_income':
			return `On income, ${a.type === 'split_income' ? `split ${amt} to ${dest}` : `${a.type} ${amt}`}.`;
		case 'on_balance_below':
			return `When my balance drops below ${t.threshold_sol} SOL, ${a.type === 'freeze' ? 'freeze all spending and notify me' : a.type === 'notify' ? 'notify me' : `${a.type} ${amt}`}.`;
		case 'on_schedule':
			return `${t.cadence === 'weekly' ? `Every ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.weekday ?? 5]}` : 'Daily'} at ${String(t.hour).padStart(2, '0')}:00 UTC, ${a.type} ${amt}${dest ? ` to ${dest}` : ''}.`;
		case 'on_launch_matching':
			return `When a launch matches${t.creator ? ` creator ${t.creator.slice(0, 4)}…` : ''}${t.max_mcap_usd ? ` under $${Math.round(t.max_mcap_usd / 1000)}k` : ''}, ${a.type} ${a.amount_sol} SOL.`;
		case 'on_stream_started':
			return `When a money stream starts, ${a.type} ${amt}${dest ? ` to ${dest}` : ''}.`;
		default:
			return intent.title || 'Wallet intent';
	}
}

// ── DB access ────────────────────────────────────────────────────────────────────

function rowToIntent(row) {
	if (!row) return null;
	return {
		id: row.id,
		agent_id: row.agent_id,
		title: row.title,
		trigger: { type: row.trigger_type, ...(row.trigger_config || {}) },
		action: { type: row.action_type, ...(row.action_config || {}) },
		limits: row.limits || {},
		network: row.network,
		enabled: row.enabled,
		public_trait: row.public_trait,
		source_text: row.source_text,
		readback: row.readback,
		stats: {
			fire_count: row.fire_count,
			spent_usd: Number(row.spent_usd || 0),
			last_fired_at: row.last_fired_at,
			last_status: row.last_status,
			last_note: row.last_note,
			last_signature: row.last_signature,
		},
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export async function listIntents(agentId) {
	const rows = await sql`
		SELECT * FROM agent_wallet_intents WHERE agent_id = ${agentId} ORDER BY created_at DESC
	`;
	return rows.map(rowToIntent);
}

export async function getIntent(agentId, intentId) {
	const [row] = await sql`SELECT * FROM agent_wallet_intents WHERE id = ${intentId} AND agent_id = ${agentId}`;
	return rowToIntent(row);
}

export async function createIntent(agentId, userId, normalized, { network = 'mainnet', sourceText = null, publicTrait = false } = {}) {
	const { trigger, action, limits, title, readback } = normalized;
	const triggerConfig = { ...trigger };
	delete triggerConfig.type;
	const actionConfig = { ...action };
	delete actionConfig.type;
	const [row] = await sql`
		INSERT INTO agent_wallet_intents
			(agent_id, user_id, title, trigger_type, trigger_config, action_type, action_config, limits, network, source_text, readback, public_trait, enabled)
		VALUES (
			${agentId}, ${userId}, ${title}, ${trigger.type}, ${JSON.stringify(triggerConfig)}::jsonb,
			${action.type}, ${JSON.stringify(actionConfig)}::jsonb, ${JSON.stringify(limits || {})}::jsonb,
			${network}, ${sourceText}, ${readback || describeIntent(normalized)}, ${!!publicTrait}, true
		)
		RETURNING *
	`;
	logAudit({ userId, action: 'wallet_intent.create', resourceId: agentId, meta: { intent_id: row.id, trigger: trigger.type, action: action.type } });
	return rowToIntent(row);
}

export async function updateIntent(agentId, userId, intentId, patch) {
	const existing = await getIntent(agentId, intentId);
	if (!existing) return null;

	const fields = [];
	const next = {};
	if ('enabled' in patch) next.enabled = patch.enabled === true;
	if ('public_trait' in patch) next.public_trait = patch.public_trait === true;
	if ('title' in patch) next.title = str(patch.title, 80).trim() || existing.title;
	// A full re-validated intent may replace trigger/action/limits.
	let normalized = null;
	if (patch.intent) {
		const r = normalizeIntent(patch.intent);
		if (!r.ok) return { error: r.error, message: r.message };
		normalized = r.intent;
	}

	const triggerConfig = normalized ? (() => { const c = { ...normalized.trigger }; delete c.type; return c; })() : null;
	const actionConfig = normalized ? (() => { const c = { ...normalized.action }; delete c.type; return c; })() : null;

	const [row] = await sql`
		UPDATE agent_wallet_intents SET
			enabled = ${'enabled' in next ? next.enabled : existing.enabled},
			public_trait = ${'public_trait' in next ? next.public_trait : existing.public_trait},
			title = ${normalized ? normalized.title : ('title' in next ? next.title : existing.title)},
			trigger_type = ${normalized ? normalized.trigger.type : existing.trigger.type},
			trigger_config = ${JSON.stringify(triggerConfig ?? (() => { const c = { ...existing.trigger }; delete c.type; return c; })())}::jsonb,
			action_type = ${normalized ? normalized.action.type : existing.action.type},
			action_config = ${JSON.stringify(actionConfig ?? (() => { const c = { ...existing.action }; delete c.type; return c; })())}::jsonb,
			limits = ${JSON.stringify(normalized ? normalized.limits : existing.limits)}::jsonb,
			readback = ${normalized ? (normalized.readback || describeIntent(normalized)) : existing.readback},
			updated_at = now()
		WHERE id = ${intentId} AND agent_id = ${agentId}
		RETURNING *
	`;
	logAudit({ userId, action: 'wallet_intent.update', resourceId: agentId, meta: { intent_id: intentId } });
	return rowToIntent(row);
}

export async function deleteIntent(agentId, userId, intentId) {
	const rows = await sql`DELETE FROM agent_wallet_intents WHERE id = ${intentId} AND agent_id = ${agentId} RETURNING id`;
	if (rows.length) logAudit({ userId, action: 'wallet_intent.delete', resourceId: agentId, meta: { intent_id: intentId } });
	return rows.length > 0;
}

// Sum the REAL USD this intent has moved within a window (from custody rows it
// wrote). Powers per-intent daily/total caps and the "remaining budget" read-out.
async function intentSpentUsd(agentId, intentId, sinceIso = null) {
	const [row] = await sql`
		SELECT COALESCE(SUM(usd), 0)::float8 AS usd
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND usd IS NOT NULL
		  AND status IN ('ok', 'pending', 'confirmed')
		  AND meta->>'intent_id' = ${intentId}
		  AND (${sinceIso}::timestamptz IS NULL OR created_at > ${sinceIso}::timestamptz)
	`;
	return Number(row?.usd || 0);
}

// ── NL → structured intent compiler (real LLM proxy, strict tool schema) ─────────

const COMPILE_TOOL = {
	name: 'record_wallet_intent',
	description:
		'Record the single standing wallet RULE the owner described, as a strict structured intent the engine can enforce. ' +
		'A rule is an event TRIGGER plus an ACTION the agent takes automatically when it fires, bounded by owner caps. ' +
		'NEVER invent an amount, destination, creator, or token. If anything required is missing or ambiguous, set ' +
		'needs_clarification true and ask one short question instead of guessing. The only coin the platform promotes is ' +
		'$THREE; treat "$THREE"/"three" as that coin. A mint/creator the owner names is their own runtime input.',
	input_schema: {
		type: 'object',
		properties: {
			title: { type: 'string', description: 'A short label, e.g. "Tip back generously".' },
			trigger_type: {
				type: 'string',
				enum: INTENT_TRIGGERS,
				description:
					'on_tip_received: someone tips the agent. on_income: any income arrives. on_balance_below: SOL balance drops under a floor. ' +
					'on_schedule: a daily/weekly time. on_launch_matching: a new pump.fun launch matches a creator and/or market cap. ' +
					'on_stream_started: a money stream to the agent begins.',
			},
			trigger_config: {
				type: 'object',
				description:
					'Fields by trigger. on_tip_received: { min_sol }. on_balance_below: { threshold_sol }. on_schedule: ' +
					'{ cadence: "daily"|"weekly", weekday: 0-6 (Sun=0..Sat=6, Fri=5), hour: 0-23 (UTC) }. on_launch_matching: ' +
					'{ creator: base58|null, max_mcap_usd, min_mcap_usd }.',
				properties: {
					min_sol: { type: 'number' },
					threshold_sol: { type: 'number' },
					cadence: { type: 'string', enum: ['daily', 'weekly'] },
					weekday: { type: 'number' },
					hour: { type: 'number' },
					creator: { type: 'string' },
					max_mcap_usd: { type: 'number' },
					min_mcap_usd: { type: 'number' },
				},
			},
			action_type: {
				type: 'string',
				enum: INTENT_ACTIONS,
				description:
					'tip/transfer: send SOL to a destination. buy/snipe: spend SOL to acquire a token. withdraw: send SOL to an ' +
					'owner-controlled address. split_income: send a % of income to a destination. freeze: halt all spending ' +
					'(kill switch). notify: just DM the owner.',
			},
			action_config: {
				type: 'object',
				description:
					'Fields by action. tip/transfer: { amount_sol } OR { pct, of: "tip"|"income"|"balance" }, destination. ' +
					'buy/snipe: { mint ("$THREE" or base58, omit for on_launch_matching), amount_sol, slippage_pct }. ' +
					'withdraw: { amount_sol } OR { above_sol } OR { pct }, destination. split_income: { pct, destination }. ' +
					'notify: { message }. "half of what they sent" → pct 50, of "tip".',
				properties: {
					amount_sol: { type: 'number' },
					above_sol: { type: 'number' },
					pct: { type: 'number' },
					of: { type: 'string', enum: ['tip', 'income', 'balance'] },
					destination: { type: 'string' },
					mint: { type: 'string' },
					slippage_pct: { type: 'number' },
					message: { type: 'string' },
				},
			},
			limits: {
				type: 'object',
				description: 'Owner caps. { per_action_usd, daily_usd, total_usd } — each in USD, omit if not stated.',
				properties: {
					per_action_usd: { type: 'number' },
					daily_usd: { type: 'number' },
					total_usd: { type: 'number' },
				},
			},
			readback: { type: 'string', description: 'One plain sentence the owner can confirm, naming real amounts/destinations.' },
			confidence: { type: 'number', description: '0..1 confidence this parse is correct.' },
			needs_clarification: { type: 'boolean' },
			clarifying_question: { type: 'string', description: 'When needs_clarification, the single short question to ask.' },
		},
		required: ['trigger_type', 'action_type', 'readback'],
	},
};

const OPENAI_COMPILE_TOOL = {
	type: 'function',
	function: { name: COMPILE_TOOL.name, description: COMPILE_TOOL.description, parameters: COMPILE_TOOL.input_schema },
};

function compileSystemPrompt({ agentName, network, balanceSol, holdings, limits, tradeLimits }) {
	const held = (holdings || []).slice(0, 6).map((h) => `  - ${h.symbol || h.mint}: ${h.ui_amount}`).join('\n');
	return [
		`You compile the owner's plain-language money rule into ONE structured standing intent for "${agentName || 'this agent'}", a 3D AI agent on three.ws that holds its own real Solana wallet.`,
		'Call record_wallet_intent exactly once. Map the request to one trigger + one action. Output nothing else.',
		'',
		'Rules:',
		'- NEVER invent an amount, destination, creator address, token, or schedule. If the rule is missing any of these, set needs_clarification=true with one short question.',
		'- "tip back half of what they sent" → trigger on_tip_received, action tip, action_config { pct: 50, of: "tip" }, destination is the tipper (leave destination empty — the engine fills the tipper in at fire time).',
		'- "when my balance is under X, freeze and DM me" → trigger on_balance_below { threshold_sol: X }, action freeze.',
		'- "split 10% of everything I earn to <addr/name>" → trigger on_income, action split_income { pct: 10, destination: <addr/.sol> }.',
		'- "every Friday withdraw profit above 2 SOL to <addr>" → trigger on_schedule { cadence: "weekly", weekday: 5, hour: 13 }, action withdraw { above_sol: 2, destination: <addr> }.',
		'- "snipe launches from <creator> under $40k, max 1 SOL each" → trigger on_launch_matching { creator, max_mcap_usd: 40000 }, action snipe { amount_sol: 1 } (omit mint — it is the matched launch).',
		'- The ONLY coin the platform promotes is $THREE. Treat "$THREE"/"three" as that coin. A mint/creator the owner pastes is their own input — pass it through, never invent one.',
		'- Keep readback to one sentence the owner can confirm.',
		'',
		`Live context — network: ${network}; spendable SOL: ${balanceSol == null ? 'unknown' : balanceSol}.`,
		held ? `Tokens held:\n${held}` : 'Tokens held: none detected.',
		`Owner spend policy (hard ceilings the engine enforces): per-tx $${limits?.per_tx_usd ?? '∞'}, daily $${limits?.daily_usd ?? '∞'}. Any cap the owner sets is clamped under these.`,
	].join('\n');
}

async function fetchWithTimeout(url, opts, ms = 15_000) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), ms);
	try {
		return await fetch(url, { ...opts, signal: ctrl.signal });
	} finally {
		clearTimeout(t);
	}
}

async function callAnthropicCompile({ apiKey, system, messages }) {
	const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
		body: JSON.stringify({
			model: 'claude-opus-4-8',
			max_tokens: 700,
			system,
			messages,
			tools: [COMPILE_TOOL],
			tool_choice: { type: 'tool', name: COMPILE_TOOL.name },
		}),
	});
	if (!resp.ok) throw new Error(`anthropic ${resp.status}`);
	const j = await resp.json();
	const block = (j.content || []).find((b) => b.type === 'tool_use' && b.name === COMPILE_TOOL.name);
	if (!block) throw new Error('anthropic: no tool_use');
	return block.input;
}

async function callOpenRouterCompile({ apiKey, system, messages }) {
	const resp = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'content-type': 'application/json',
			'HTTP-Referer': 'https://three.ws',
			'X-Title': 'three.ws wallet intents',
		},
		body: JSON.stringify({
			model: 'openai/gpt-oss-120b',
			max_tokens: 700,
			messages: [{ role: 'system', content: system }, ...messages],
			tools: [OPENAI_COMPILE_TOOL],
			tool_choice: { type: 'function', function: { name: COMPILE_TOOL.name } },
		}),
	});
	if (!resp.ok) throw new Error(`openrouter ${resp.status}`);
	const j = await resp.json();
	const call = j.choices?.[0]?.message?.tool_calls?.[0];
	if (!call?.function?.arguments) throw new Error('openrouter: no tool_call');
	return JSON.parse(call.function.arguments);
}

async function callGrokCompile({ apiKey, system, messages }) {
	const resp = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			model: 'grok-4.1-fast',
			max_tokens: 700,
			messages: [{ role: 'system', content: system }, ...messages],
			tools: [OPENAI_COMPILE_TOOL],
			tool_choice: { type: 'function', function: { name: COMPILE_TOOL.name } },
		}),
	});
	if (!resp.ok) throw new Error(`grok ${resp.status}`);
	const j = await resp.json();
	const call = j.choices?.[0]?.message?.tool_calls?.[0];
	if (!call?.function?.arguments) throw new Error('grok: no tool_call');
	return JSON.parse(call.function.arguments);
}

/**
 * Compile a plain-language rule into a validated structured intent. The model is
 * forced to emit the tool schema; the server then re-validates every field. A
 * missing-key deployment returns a precise "unavailable" so the client falls back
 * to the manual form rather than faking a parse.
 *
 * @returns {Promise<{ ok:true, intent, provider, clarify?:string }
 *                  | { ok:false, error, message, clarify?:string }>}
 */
export async function compileIntentFromText(text, ctx = {}) {
	const utterance = String(text || '').trim();
	if (!utterance) return { ok: false, error: 'empty', message: 'describe a rule first' };
	if (utterance.length > 1000) return { ok: false, error: 'too_long', message: 'that is too long — shorten the rule' };

	const anthropicKey = ctx.anthropicKey || process.env.ANTHROPIC_API_KEY;
	const grokKey = ctx.grokKey || process.env.GROK_API_KEY;
	const openrouterKey = ctx.openrouterKey || process.env.OPENROUTER_API_KEY;
	if (!anthropicKey && !grokKey && !openrouterKey) {
		return { ok: false, error: 'unavailable', message: 'the rule compiler is not configured on this deployment — build the rule with the form instead' };
	}

	const system = compileSystemPrompt(ctx);
	const messages = [];
	for (const h of (ctx.history || []).slice(-4)) {
		if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
			messages.push({ role: h.role, content: h.content.slice(0, 800) });
		}
	}
	messages.push({ role: 'user', content: utterance });
	if (messages[0].role !== 'user') messages.shift();

	let raw = null;
	let provider = null;
	const tried = [];
	if (anthropicKey) {
		try { raw = await callAnthropicCompile({ apiKey: anthropicKey, system, messages }); provider = 'anthropic'; }
		catch (e) { tried.push(`anthropic:${e.message}`); }
	}
	if (!raw && grokKey) {
		try { raw = await callGrokCompile({ apiKey: grokKey, system, messages }); provider = 'grok'; }
		catch (e) { tried.push(`grok:${e.message}`); }
	}
	if (!raw && openrouterKey) {
		try { raw = await callOpenRouterCompile({ apiKey: openrouterKey, system, messages }); provider = 'openrouter'; }
		catch (e) { tried.push(`openrouter:${e.message}`); }
	}
	if (!raw) {
		console.warn('[wallet-intents] compile providers failed:', tried.join(' | '));
		return { ok: false, error: 'parse_failed', message: 'could not parse that — rephrase, or build the rule with the form' };
	}

	if (raw.needs_clarification && raw.clarifying_question) {
		return { ok: false, error: 'clarify', message: 'I need one more detail', clarify: str(raw.clarifying_question, 280), provider };
	}

	const norm = normalizeIntent(raw, { threeMint: THREE_MINT });
	if (!norm.ok) {
		return { ok: false, error: norm.error, message: norm.message, clarify: raw.clarifying_question ? str(raw.clarifying_question, 280) : null, provider };
	}

	// Resolve a .sol / name destination to a real address now, so the read-back and
	// the stored intent both carry the real recipient. An unresolved name clarifies.
	const a = norm.intent.action;
	const needsDest = ['tip', 'transfer', 'withdraw', 'split_income'].includes(a.type) && a.destination;
	// A tip-back to the tipper has an empty destination by design (filled at fire time).
	const tipBackToTipper = a.type === 'tip' && norm.intent.trigger.type === 'on_tip_received' && !a.destination;
	if (needsDest && !BASE58_RE.test(a.destination)) {
		const resolved = await resolveSolanaRecipient(a.destination).catch(() => ({ address: null }));
		if (resolved.address) {
			a.destination_label = a.destination;
			a.destination = resolved.address;
		} else {
			return { ok: false, error: 'bad_destination', message: `couldn't resolve "${a.destination}"`, clarify: `What Solana address or .sol name should "${norm.intent.title}" send to?`, provider };
		}
	} else if (needsDest && !a.destination_label) {
		a.destination_label = `${a.destination.slice(0, 4)}…${a.destination.slice(-4)}`;
	}
	if (tipBackToTipper) a.to_tipper = true;

	norm.intent.readback = norm.intent.readback || describeIntent(norm.intent);
	return { ok: true, intent: norm.intent, provider };
}

// ── execution ─────────────────────────────────────────────────────────────────────
//
// Every spending action flows through gatedSpend: clamp to the agent spend policy
// AND the intent's own caps, claim an idempotent custody row stamped with
// intent_id, run the real transfer/swap, finalize the row. doSpend(lamports)
// returns { signature }.

// Why did the atomic claim above write no row? Exactly one of: this event already
// fired, or one of the three rolling ceilings is full. Re-read them (outside the
// lock, which is fine for a message) so the owner sees the real reason instead of
// a generic skip.
async function claimRejection({ agentId, intentId, idemKey, usd, network, dailyUsd, intentDailyUsd, intentTotalUsd, sinceIso }) {
	const [dupe] = await sql`
		SELECT id FROM agent_custody_events
		WHERE agent_id = ${agentId} AND idempotency_key = ${idemKey} LIMIT 1
	`;
	if (dupe) return { status: 'skipped', note: 'already fired for this event' };

	if (intentTotalUsd != null) {
		const spent = await intentSpentUsd(agentId, intentId, null);
		if (spent + usd > intentTotalUsd + 1e-9) {
			return { status: 'paused', note: `would exceed this rule's lifetime cap ($${intentTotalUsd})`, usd };
		}
	}
	if (intentDailyUsd != null) {
		const spent = await intentSpentUsd(agentId, intentId, sinceIso);
		if (spent + usd > intentDailyUsd + 1e-9) {
			return { status: 'paused', note: `would exceed this rule's daily budget ($${intentDailyUsd}; $${spent.toFixed(2)} used today)`, usd };
		}
	}
	if (dailyUsd != null) {
		const [row] = await sql`
			SELECT COALESCE(SUM(usd), 0)::float8 AS s
			FROM agent_custody_events
			WHERE agent_id = ${agentId} AND network = ${network} AND event_type = 'spend'
			  AND status IN ('ok', 'pending', 'confirmed') AND usd IS NOT NULL
			  AND created_at > now() - interval '24 hours'
		`;
		const spent = Number(row?.s || 0);
		return {
			status: 'paused',
			note: `would bring today's wallet spend to $${(spent + usd).toFixed(2)}, over the $${dailyUsd} daily limit`,
			usd,
		};
	}
	// No ceiling explains it and no duplicate exists: another writer claimed the
	// same key between the insert and this read. Treat it as already fired.
	return { status: 'skipped', note: 'already fired for this event' };
}

async function gatedSpend({ ctx, intent, discriminator, category, usd, lamports, rowMeta, doSpend }) {
	const { agentId, ownerId, userId, network, dryRun, now } = ctx;

	// 1) intent-level caps (per-action / daily / total): the owner's own ceilings.
	// The per-action cap is exact here (one value against a constant); the daily and
	// lifetime budgets are re-checked atomically inside the claim in step 3, so this
	// pass exists to reject early with a precise message, not to be the gate.
	const lim = intent.limits || {};
	if (lim.per_action_usd != null && usd > lim.per_action_usd + 1e-9) {
		return { status: 'skipped', note: `over this rule's per-action cap ($${lim.per_action_usd})`, usd };
	}
	if (lim.daily_usd != null) {
		const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
		const spent = await intentSpentUsd(agentId, intent.id, since);
		if (spent + usd > lim.daily_usd + 1e-9) {
			return { status: 'paused', note: `would exceed this rule's daily budget ($${lim.daily_usd}; $${spent.toFixed(2)} used today)`, usd };
		}
	}
	if (lim.total_usd != null) {
		const spent = await intentSpentUsd(agentId, intent.id, null);
		if (spent + usd > lim.total_usd + 1e-9) {
			return { status: 'paused', note: `would exceed this rule's lifetime cap ($${lim.total_usd})`, usd };
		}
	}

	// 2) the agent spend policy: the SAME hard ceiling every outbound path obeys.
	// This runs every non-daily guard (freeze, allowlist, NL policy rules, per-tx
	// ceiling, anomaly, capability) and gives a fast, specific pause message. Its
	// daily-cap read is advisory only; the binding daily check is the atomic claim
	// below, which reserves headroom in the same statement that writes the row.
	try {
		await enforceSpendLimit({ agentId, meta: ctx.meta, category: 'intent', usdValue: usd, network });
	} catch (e) {
		if (e instanceof SpendLimitError) return { status: 'paused', note: e.message, usd };
		throw e;
	}

	if (dryRun) return { status: 'would_run', note: `would move ~$${usd.toFixed(2)}`, usd };

	// 3) Atomic claim: one execution per (intent, discriminator) AND a reservation
	// against every rolling ceiling this spend answers to, in ONE statement under a
	// per-agent advisory lock.
	//
	// The idempotency key alone only stops the SAME intent firing twice (security
	// review M5). Racing distinct intents, or two overlapping sweeps, each read the
	// same pre-spend totals under the old read-then-write shape and each passed,
	// overshooting the wallet's daily USD cap and the rule's own budgets by up to
	// one spend apiece. Counting 'pending' rows inside the lock is what makes the
	// second caller see the first one's in-flight claim.
	const idemKey = `intent:${intent.id}:${discriminator}`;
	const dailyUsd = getSpendLimits(ctx.meta)?.daily_usd ?? null;
	const intentDailyUsd = lim.daily_usd ?? null;
	const intentTotalUsd = lim.total_usd ?? null;
	const sinceIso = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
	const claim = await sql`
		WITH locked AS (
			SELECT pg_advisory_xact_lock(hashtextextended(${String(agentId)}, 0))
		),
		wallet_day AS (
			SELECT COALESCE(SUM(usd), 0)::float8 AS s
			FROM agent_custody_events
			WHERE agent_id = ${agentId} AND network = ${network} AND event_type = 'spend'
			  AND status IN ('ok', 'pending', 'confirmed') AND usd IS NOT NULL
			  AND created_at > now() - interval '24 hours'
		),
		rule_day AS (
			SELECT COALESCE(SUM(usd), 0)::float8 AS s
			FROM agent_custody_events
			WHERE agent_id = ${agentId} AND usd IS NOT NULL
			  AND status IN ('ok', 'pending', 'confirmed')
			  AND meta->>'intent_id' = ${intent.id}
			  AND created_at > ${sinceIso}::timestamptz
		),
		rule_life AS (
			SELECT COALESCE(SUM(usd), 0)::float8 AS s
			FROM agent_custody_events
			WHERE agent_id = ${agentId} AND usd IS NOT NULL
			  AND status IN ('ok', 'pending', 'confirmed')
			  AND meta->>'intent_id' = ${intent.id}
		)
		INSERT INTO agent_custody_events
			(agent_id, user_id, event_type, category, network, asset, amount_lamports, usd, status, idempotency_key, meta)
		SELECT ${agentId}, ${userId ?? ownerId ?? null}, 'spend', ${category}, ${network}, 'SOL',
		       ${lamports != null ? String(lamports) : null}, ${usd ?? null}, 'pending', ${idemKey},
		       ${JSON.stringify({ ...rowMeta, intent_id: intent.id, intent_title: intent.title, trigger: intent.trigger?.type, action: intent.action?.type })}::jsonb
		FROM wallet_day, rule_day, rule_life, locked
		WHERE NOT EXISTS (SELECT 1 FROM agent_custody_events WHERE agent_id = ${agentId} AND idempotency_key = ${idemKey})
		  AND (${dailyUsd}::float8 IS NULL OR wallet_day.s + ${usd}::float8 <= ${dailyUsd}::float8 + 1e-9)
		  AND (${intentDailyUsd}::float8 IS NULL OR rule_day.s + ${usd}::float8 <= ${intentDailyUsd}::float8 + 1e-9)
		  AND (${intentTotalUsd}::float8 IS NULL OR rule_life.s + ${usd}::float8 <= ${intentTotalUsd}::float8 + 1e-9)
		RETURNING id
	`;
	if (!claim.length) return await claimRejection({ agentId, intentId: intent.id, idemKey, usd, network, dailyUsd, intentDailyUsd, intentTotalUsd, sinceIso });
	const eventId = claim[0].id;

	try {
		const { signature } = await doSpend(lamports);
		await updateCustodyEvent(eventId, { status: 'confirmed', signature, meta: { settled_at: now.toISOString() } });
		return { status: 'ok', signature, explorer: explorerTxUrl(signature, network), usd };
	} catch (e) {
		await updateCustodyEvent(eventId, { status: 'failed', meta: { error: (e?.message || 'failed').slice(0, 200) } });
		return { status: 'error', note: (e?.message || 'transaction failed').slice(0, 240), usd };
	}
}

// Real SOL transfer from the agent's wallet → destination.
async function transferSol({ ctx, intent, discriminator, category, lamports, rowMeta }) {
	if (lamports <= 0n) return { status: 'skipped', note: 'amount rounds to zero' };
	// Keep a fee headroom so the wallet never bricks itself.
	const usable = ctx.balanceLamports - SOL_FEE_HEADROOM_LAMPORTS;
	if (lamports > usable) return { status: 'skipped', note: 'not enough SOL after the fee buffer' };
	const usd = await lamportsToUsd(lamports).catch(() => null);
	if (usd == null) return { status: 'paused', note: 'SOL/USD price feed unavailable — will retry' };
	return gatedSpend({
		ctx, intent, discriminator, category, usd, lamports, rowMeta,
		doSpend: async (lams) => ({ signature: await sendSol({ connection: ctx.conn, fromKeypair: ctx.keypair, to: rowMeta.destination, lamports: Number(lams), memo: `intent:${intent.action.type}`, network: ctx.network }) }),
	});
}

// Real SOL → token swap (Jupiter, mainnet) for buy/snipe.
async function buyToken({ ctx, intent, discriminator, mint, lamports, slippagePct }) {
	if (ctx.network !== 'mainnet') return { status: 'skipped', note: 'buys/snipes are mainnet-only — this wallet is on devnet' };
	if (lamports <= 0n) return { status: 'skipped', note: 'amount rounds to zero' };
	if ((ctx.balanceLamports - SOL_FEE_HEADROOM_LAMPORTS) < lamports) return { status: 'skipped', note: 'not enough SOL after the fee buffer' };
	const usd = await lamportsToUsd(lamports).catch(() => null);
	if (usd == null) return { status: 'paused', note: 'SOL/USD price feed unavailable — will retry' };
	const slippageBps = Math.round(clamp(slippagePct ?? 5, 0, 50) * 100);
	return gatedSpend({
		ctx, intent, discriminator, category: intent.action.type === 'snipe' ? 'snipe' : 'trade', usd, lamports,
		rowMeta: { action: intent.action.type, mint },
		doSpend: async (lams) => {
			const res = await swapSolToToken({ keypair: ctx.keypair, lamports: lams, outputMint: mint, slippageBps, network: ctx.network, conn: ctx.conn });
			return { signature: res.signature };
		},
	});
}

async function swapSolToToken({ keypair, lamports, outputMint, slippageBps, conn }) {
	const { VersionedTransaction } = await import('@solana/web3.js');
	const qUrl = `${JUPITER_BASE}/quote?inputMint=${WSOL_MINT}&outputMint=${outputMint}&amount=${lamports.toString()}&slippageBps=${slippageBps}&swapMode=ExactIn`;
	const qRes = await fetchWithTimeout(qUrl, {}, 15_000);
	if (!qRes.ok) throw Object.assign(new Error(`no swap route (${qRes.status})`), { code: 'no_route' });
	const quote = await qRes.json();
	if (!quote?.outAmount) throw Object.assign(new Error('no swap route for this pair'), { code: 'no_route' });
	const sRes = await fetchWithTimeout(`${JUPITER_BASE}/swap`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ quoteResponse: quote, userPublicKey: keypair.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }),
	}, 20_000);
	if (!sRes.ok) throw Object.assign(new Error(`swap build failed (${sRes.status})`), { code: 'swap_failed' });
	const { swapTransaction } = await sRes.json();
	if (!swapTransaction) throw Object.assign(new Error('swap build returned no transaction'), { code: 'swap_failed' });
	const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
	tx.sign([keypair]);
	const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
	const bh = await conn.getLatestBlockhash();
	// HTTP-polling confirm (no WebSocket) — throws on a landed-but-reverted swap so
	// a revert is never reported back as a successful intent execution.
	await confirmOrThrow(conn, { signature: sig, ...bh }, 'confirmed');
	return { signature: sig, outAmount: quote.outAmount };
}

// Notify the owner (real audit event + best-effort email). No funds move.
async function notifyOwner({ ctx, intent, discriminator, subject, body }) {
	const idemKey = `intent:${intent.id}:${discriminator}`;
	const claim = await sql`
		INSERT INTO agent_custody_events (agent_id, user_id, event_type, category, network, reason, status, idempotency_key, meta)
		SELECT ${ctx.agentId}, ${ctx.ownerId ?? null}, 'intent_notify', 'notify', ${ctx.network}, ${subject.slice(0, 200)}, 'ok', ${idemKey},
		       ${JSON.stringify({ intent_id: intent.id, intent_title: intent.title, message: body })}::jsonb
		WHERE NOT EXISTS (SELECT 1 FROM agent_custody_events WHERE agent_id = ${ctx.agentId} AND idempotency_key = ${idemKey})
		RETURNING id
	`;
	if (!claim.length) return { status: 'skipped', note: 'already notified for this event' };
	// Best-effort email to the owner — never block on the channel being configured.
	try {
		const { sendEmail } = await import('./email.js');
		const [u] = await sql`SELECT email FROM users WHERE id = ${ctx.ownerId}`;
		if (u?.email) await sendEmail({ to: u.email, subject, html: `<p>${body}</p><p style="color:#888">— your agent's wallet copilot</p>` }).catch(() => {});
	} catch { /* email optional */ }
	return { status: 'notified', note: body.slice(0, 200) };
}

// ── the action dispatcher ──────────────────────────────────────────────────────────

async function executeAction(intent, ctx, event = {}) {
	const a = intent.action;
	const now = ctx.now;

	// Resolve the moving amount in lamports for the SOL-moving actions.
	const resolveLamports = async () => {
		if (a.pct != null) {
			if (a.of === 'tip' || a.of === 'income') {
				// % of the triggering event value, taken in SOL.
				const eventSol = event.amount_sol != null ? event.amount_sol : (event.usd != null ? event.usd / ctx.price : 0);
				return solToLamports(eventSol * (a.pct / 100));
			}
			if (a.of === 'balance') return BigInt(Math.floor(Number(ctx.balanceLamports) * (a.pct / 100)));
		}
		if (a.above_sol != null) {
			// "withdraw profit above N SOL" → everything over the floor (minus headroom).
			const over = ctx.balanceLamports - solToLamports(a.above_sol);
			return over > 0n ? over : 0n;
		}
		if (a.amount_sol != null) return solToLamports(a.amount_sol);
		return 0n;
	};

	switch (a.type) {
		case 'freeze': {
			// Kill switch: freeze every outbound spend + notify. Idempotent per breach/day.
			const disc = ctx.discriminator || `bal:${now.toISOString().slice(0, 10)}`;
			if (!ctx.dryRun) {
				const limits = getSpendLimits(ctx.meta);
				if (!limits.frozen) await setSpendLimits(intent.agent_id || ctx.agentId, ctx.ownerId, { frozen: true }).catch(() => {});
			}
			const note = `Spending frozen${event.balance_sol != null ? ` — balance ${event.balance_sol.toFixed(4)} SOL is below your ${intent.trigger.threshold_sol} SOL floor` : ''}.`;
			if (ctx.dryRun) return { status: 'would_run', note };
			const n = await notifyOwner({ ctx, intent, discriminator: disc, subject: `${ctx.agentName || 'Your agent'}: wallet frozen`, body: note });
			return { status: 'ok', note, frozen: true, notify: n.status };
		}
		case 'notify': {
			const disc = ctx.discriminator || `notify:${now.toISOString().slice(0, 13)}`;
			const body = a.message || describeIntent(intent);
			if (ctx.dryRun) return { status: 'would_run', note: body };
			return notifyOwner({ ctx, intent, discriminator: disc, subject: `${ctx.agentName || 'Your agent'}: ${intent.title}`, body });
		}
		case 'buy':
		case 'snipe': {
			const mint = ctx.overrideMint || a.mint;
			if (!mint || !BASE58_RE.test(mint)) return { status: 'skipped', note: 'no valid mint to buy' };
			const lamports = solToLamports(a.amount_sol);
			return buyToken({ ctx, intent, discriminator: ctx.discriminator || `buy:${mint}`, mint, lamports, slippagePct: a.slippage_pct });
		}
		case 'tip':
		case 'transfer':
		case 'withdraw':
		case 'split_income': {
			let destination = a.destination;
			if (a.to_tipper && event.from) destination = event.from; // tip-back to the tipper
			if (!destination || !BASE58_RE.test(destination)) return { status: 'skipped', note: 'no valid destination' };
			const lamports = await resolveLamports();
			if (lamports <= 0n) return { status: 'skipped', note: 'nothing to send for this event' };
			const category = a.type === 'withdraw' ? 'withdraw' : a.type === 'split_income' ? 'split' : 'transfer';
			return transferSol({
				ctx, intent, discriminator: ctx.discriminator || `${a.type}:${event.signature || now.toISOString().slice(0, 13)}`,
				category, lamports, rowMeta: { action: a.type, destination, destination_label: a.destination_label },
			});
		}
		default:
			return { status: 'skipped', note: 'unknown action' };
	}
}

// ── execution context (loads the agent, gates safety, recovers the key once) ─────

async function buildExecContext({ agentId, userId, network, dryRun, needsKey }) {
	const [row] = await sql`SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!row) return { error: 'not_found' };
	const meta = row.meta || {};
	const address = meta.solana_address;
	const encryptedSecret = meta.encrypted_solana_secret;
	if (!address) return { error: 'no_wallet' };

	const limits = getSpendLimits(meta);
	if (limits.frozen && needsKey) return { error: 'wallet_frozen' };

	let price;
	try { price = await solUsdPrice(); } catch { return { error: 'price_unavailable' }; }

	const conn = solanaConnection(network);
	let balanceSol = 0;
	try { balanceSol = Number((await getSolanaAddressBalances(address, network))?.sol || 0); }
	catch (e) { return { error: 'balance_read_failed', detail: e?.message }; }

	let keypair = null;
	if (needsKey && !dryRun) {
		if (!encryptedSecret) return { error: 'no_secret' };
		try { keypair = await recoverSolanaAgentKeypair(encryptedSecret, { agentId, userId: userId ?? row.user_id, reason: 'wallet_intent' }); }
		catch (e) { return { error: 'key_recover_failed', detail: e?.message }; }
	}

	return {
		ctx: {
			agentId, agentName: row.name, ownerId: row.user_id, userId, network, dryRun,
			now: new Date(), conn, price, meta, address,
			balanceSol, balanceLamports: solToLamports(balanceSol), keypair,
		},
	};
}

async function stampFire(intent, res, now = new Date()) {
	const moved = res.status === 'ok' && res.usd ? Number(res.usd) : 0;
	await sql`
		UPDATE agent_wallet_intents SET
			fire_count = fire_count + ${res.status === 'ok' || res.status === 'notified' ? 1 : 0},
			spent_usd = spent_usd + ${moved},
			last_fired_at = ${now.toISOString()},
			last_status = ${res.status},
			last_note = ${(res.note || (res.signature ? 'executed' : null) || res.status)?.slice?.(0, 280) ?? null},
			last_signature = ${res.signature || null},
			updated_at = now()
		WHERE id = ${intent.id}
	`;
}

// ── public entrypoints ─────────────────────────────────────────────────────────────

/**
 * Owner-initiated "test this rule now" — runs the real (or dry) execution path for
 * a single intent. Honors freeze, spend policy, and the intent's caps exactly like
 * the scheduler. dryRun reports what WOULD happen without moving funds.
 */
export async function runIntentNow({ agentId, userId, intentId, network = 'mainnet', dryRun = true }) {
	const intent = await getIntent(agentId, intentId);
	if (!intent) return { ran: false, reason: 'not_found' };
	if (!intent.enabled && !dryRun) return { ran: false, reason: 'disabled' };

	const needsKey = SPENDING_ACTIONS.has(intent.action.type);
	const built = await buildExecContext({ agentId, userId, network, dryRun, needsKey });
	if (built.error) return { ran: false, reason: built.error, note: built.detail || null };
	const ctx = built.ctx;

	// Synthesize a representative event for triggers that need one, so the dry-run is
	// concrete (e.g. tip-back shows what it would send on a sample tip).
	const event = synthEvent(intent, ctx);
	ctx.discriminator = dryRun ? `dryrun:${Date.now ? 'now' : 'x'}` : `manual:${ctx.now.toISOString()}`;
	if (intent.trigger.type === 'on_launch_matching' && intent.action.type === 'snipe') {
		// A manual test of a snipe rule can't pick a real launch — report readiness.
		return { ran: true, dryRun, results: [{ ...intentSummary(intent), status: 'would_run', note: `armed — will snipe up to ${intent.action.amount_sol} SOL on the next matching launch` }] };
	}

	let res;
	try { res = await executeAction(intent, ctx, event); }
	catch (e) { res = { status: 'error', note: (e?.message || 'failed').slice(0, 240) }; }
	if (!dryRun) await stampFire(intent, res, ctx.now).catch(() => {});
	return { ran: true, dryRun, results: [{ ...intentSummary(intent), ...res }] };
}

function intentSummary(intent) {
	return { id: intent.id, title: intent.title, trigger: intent.trigger.type, action: intent.action.type };
}

function synthEvent(intent, ctx) {
	const t = intent.trigger;
	if (t.type === 'on_tip_received' || t.type === 'on_income') {
		const sampleSol = Math.max(t.min_sol || 0.1, 0.1);
		return { amount_sol: sampleSol, usd: sampleSol * ctx.price, from: null, signature: null, sample: true };
	}
	if (t.type === 'on_balance_below') return { balance_sol: ctx.balanceSol };
	return {};
}

/**
 * Fired from the tip-recording path: evaluate this agent's on_tip_received /
 * on_income intents against a freshly-recorded REAL tip and execute any that
 * match. Idempotent per (intent, tip signature) via the custody claim.
 *
 * @param {object} tip { signature, amount_sol, usd, from, network }
 */
export async function onTipRecorded(agentId, tip) {
	try {
		const rows = await sql`
			SELECT * FROM agent_wallet_intents
			WHERE agent_id = ${agentId} AND enabled = true AND trigger_type IN ('on_tip_received', 'on_income')
		`;
		if (!rows.length) return { fired: 0 };
		const network = tip.network === 'devnet' ? 'devnet' : 'mainnet';
		const intents = rows.map(rowToIntent).filter((i) => {
			if (i.network !== network) return false;
			if (i.trigger.type === 'on_tip_received') return (tip.amount_sol ?? 0) >= (i.trigger.min_sol || 0);
			return true; // on_income — any inflow
		});
		if (!intents.length) return { fired: 0 };

		const needsKey = intents.some((i) => SPENDING_ACTIONS.has(i.action.type));
		const built = await buildExecContext({ agentId, userId: null, network, dryRun: false, needsKey });
		if (built.error) {
			console.warn('[wallet-intents] tip eval skipped:', built.error);
			return { fired: 0, reason: built.error };
		}
		const ctx = built.ctx;
		const event = { amount_sol: tip.amount_sol ?? null, usd: tip.usd ?? null, from: tip.from || null, signature: tip.signature || null };

		let fired = 0;
		for (const intent of intents) {
			ctx.discriminator = `${intent.action.type}:tip:${tip.signature || ctx.now.toISOString()}`;
			let res;
			try { res = await executeAction(intent, ctx, event); }
			catch (e) { res = { status: 'error', note: (e?.message || 'failed').slice(0, 240) }; }
			await stampFire(intent, res, ctx.now).catch(() => {});
			if (res.status === 'ok' || res.status === 'notified') fired++;
		}
		return { fired };
	} catch (e) {
		console.warn('[wallet-intents] onTipRecorded failed', e?.message);
		return { fired: 0, error: e?.message };
	}
}

/**
 * Fired from the money-stream settlement path. A stream's FIRST settlement is its
 * "started" moment; every settlement is also income. Evaluate this agent's
 * on_stream_started (first settlement only) and on_income (every settlement) intents
 * against the real, on-chain-verified settlement and execute any that match. Each
 * fire is idempotent via the custody claim — on_stream_started per stream_id (one
 * fire per session), on_income per settlement signature.
 *
 * @param {object} stream { stream_id, signature, amount_sol, usd, from, network, first }
 */
export async function onStreamSettled(agentId, stream) {
	try {
		const first = stream.first === true;
		// On a non-first settlement there's nothing for the stream-start trigger to do,
		// so don't even load it — only income rules apply to a mid-stream settlement.
		const triggerTypes = first ? ['on_stream_started', 'on_income'] : ['on_income'];
		const rows = await sql`
			SELECT * FROM agent_wallet_intents
			WHERE agent_id = ${agentId} AND enabled = true AND trigger_type = ANY(${triggerTypes})
		`;
		if (!rows.length) return { fired: 0 };
		const network = stream.network === 'devnet' ? 'devnet' : 'mainnet';
		const intents = rows.map(rowToIntent).filter((i) => i.network === network);
		if (!intents.length) return { fired: 0 };

		const needsKey = intents.some((i) => SPENDING_ACTIONS.has(i.action.type));
		const built = await buildExecContext({ agentId, userId: null, network, dryRun: false, needsKey });
		if (built.error) {
			console.warn('[wallet-intents] stream eval skipped:', built.error);
			return { fired: 0, reason: built.error };
		}
		const ctx = built.ctx;
		const event = { amount_sol: stream.amount_sol ?? null, usd: stream.usd ?? null, from: stream.from || null, signature: stream.signature || null };

		let fired = 0;
		for (const intent of intents) {
			// on_stream_started: one fire per stream session. on_income: one per settlement.
			ctx.discriminator = intent.trigger.type === 'on_stream_started'
				? `${intent.action.type}:stream:${stream.stream_id}`
				: `${intent.action.type}:streamincome:${stream.signature || ctx.now.toISOString()}`;
			let res;
			try { res = await executeAction(intent, ctx, event); }
			catch (e) { res = { status: 'error', note: (e?.message || 'failed').slice(0, 240) }; }
			await stampFire(intent, res, ctx.now).catch(() => {});
			if (res.status === 'ok' || res.status === 'notified') fired++;
		}
		return { fired };
	} catch (e) {
		console.warn('[wallet-intents] onStreamSettled failed', e?.message);
		return { fired: 0, error: e?.message };
	}
}

const UTC_WEEKDAY = (d) => d.getUTCDay();

function scheduleDue(intent, now) {
	const t = intent.trigger;
	if (t.cadence === 'weekly' && t.weekday != null && UTC_WEEKDAY(now) !== t.weekday) return false;
	return now.getUTCHours() === (t.hour ?? 13);
}

/**
 * The cron sweep: evaluate every enabled scheduled / balance / launch intent
 * across all agents and execute the due ones. (Tip/income/stream intents fire
 * inline from their event hooks — onTipRecorded / onStreamSettled.) Each kind is
 * bounded and idempotent. Returns a per-trigger summary (no secrets).
 */
export async function runIntentSweep({ network = 'mainnet', now = new Date(), launchLimit = 60 } = {}) {
	const summary = { scanned: 0, fired: 0, by_trigger: {}, errors: 0 };

	// 1) scheduled intents whose hour/weekday is now.
	const scheduled = (await sql`
		SELECT * FROM agent_wallet_intents WHERE enabled = true AND trigger_type = 'on_schedule' AND network = ${network}
	`).map(rowToIntent).filter((i) => scheduleDue(i, now));
	for (const intent of scheduled) {
		summary.scanned++;
		const r = await fireScheduledLike(intent, network, now, `sched:${isoBucket(intent.trigger, now)}`);
		tallySweep(summary, intent.trigger.type, r);
	}

	// 2) balance-floor intents — poll each agent's SOL balance.
	const balance = (await sql`
		SELECT * FROM agent_wallet_intents WHERE enabled = true AND trigger_type = 'on_balance_below' AND network = ${network}
	`).map(rowToIntent);
	for (const intent of balance) {
		summary.scanned++;
		const r = await fireBalanceIntent(intent, network, now);
		tallySweep(summary, intent.trigger.type, r);
	}

	// 3) launch-matching intents — one shared pull of recent launches, matched per rule.
	const launch = (await sql`
		SELECT * FROM agent_wallet_intents WHERE enabled = true AND trigger_type = 'on_launch_matching' AND network = ${network}
	`).map(rowToIntent);
	if (launch.length && network === 'mainnet') {
		let launches = [];
		try { launches = await recentPumpLaunches({ network, limit: launchLimit }); } catch { launches = []; }
		let solPrice = 0;
		try { solPrice = await solUsdPrice(); } catch { solPrice = 0; }
		for (const intent of launch) {
			summary.scanned++;
			const r = await fireLaunchIntent(intent, network, now, launches, solPrice);
			tallySweep(summary, intent.trigger.type, r);
		}
	}

	return summary;
}

function isoBucket(trigger, now) {
	if (trigger.cadence === 'weekly') {
		// year-week bucket
		const oneJan = Date.UTC(now.getUTCFullYear(), 0, 1);
		const week = Math.ceil(((now.getTime() - oneJan) / 86400000 + 1) / 7);
		return `${now.getUTCFullYear()}-W${week}`;
	}
	return now.toISOString().slice(0, 10);
}

function tallySweep(summary, triggerType, r) {
	summary.by_trigger[triggerType] = (summary.by_trigger[triggerType] || 0) + 1;
	if (r?.status === 'ok' || r?.status === 'notified') summary.fired++;
	if (r?.status === 'error') summary.errors++;
}

async function fireScheduledLike(intent, network, now, discriminator) {
	const needsKey = SPENDING_ACTIONS.has(intent.action.type);
	const built = await buildExecContext({ agentId: intent.agent_id, userId: null, network, dryRun: false, needsKey });
	if (built.error) { const res = { status: 'paused', note: built.error }; await stampFire(intent, res, now).catch(() => {}); return res; }
	const ctx = built.ctx; ctx.discriminator = discriminator; ctx.now = now;
	let res;
	try { res = await executeAction(intent, ctx, { balance_sol: ctx.balanceSol }); }
	catch (e) { res = { status: 'error', note: (e?.message || 'failed').slice(0, 240) }; }
	await stampFire(intent, res, now).catch(() => {});
	return res;
}

async function fireBalanceIntent(intent, network, now) {
	const built = await buildExecContext({ agentId: intent.agent_id, userId: null, network, dryRun: false, needsKey: SPENDING_ACTIONS.has(intent.action.type) });
	if (built.error) { const res = { status: 'paused', note: built.error }; await stampFire(intent, res, now).catch(() => {}); return res; }
	const ctx = built.ctx; ctx.now = now;
	if (ctx.balanceSol >= intent.trigger.threshold_sol) {
		return { status: 'skipped', note: `balance ${ctx.balanceSol.toFixed(4)} SOL is above the ${intent.trigger.threshold_sol} SOL floor` };
	}
	// Idempotent per UTC day so a sustained low balance notifies/freezes at most daily.
	ctx.discriminator = `bal:${now.toISOString().slice(0, 10)}`;
	let res;
	try { res = await executeAction(intent, ctx, { balance_sol: ctx.balanceSol }); }
	catch (e) { res = { status: 'error', note: (e?.message || 'failed').slice(0, 240) }; }
	await stampFire(intent, res, now).catch(() => {});
	return res;
}

async function fireLaunchIntent(intent, network, now, launches, solPrice) {
	const t = intent.trigger;
	// Match by creator and/or market cap. Creator-gated rules enrich on demand.
	let match = null;
	for (const raw of launches) {
		if (!raw?.mint) continue;
		if (t.creator && raw.creator !== t.creator) continue;
		const mc = raw.market_cap_usd;
		if (t.max_mcap_usd != null && !(mc != null && mc <= t.max_mcap_usd)) continue;
		if (t.min_mcap_usd != null && !(mc != null && mc >= t.min_mcap_usd)) continue;
		match = raw;
		break;
	}
	if (!match) return { status: 'skipped', note: 'no launch matched this cycle' };
	if (t.creator) { try { await enrichCreatorStats(match, solPrice); } catch { /* best effort */ } }

	const built = await buildExecContext({ agentId: intent.agent_id, userId: null, network, dryRun: false, needsKey: true });
	if (built.error) { const res = { status: 'paused', note: built.error }; await stampFire(intent, res, now).catch(() => {}); return res; }
	const ctx = built.ctx; ctx.now = now;
	ctx.overrideMint = match.mint;
	ctx.discriminator = `snipe:${match.mint}`; // one buy per matched mint, ever
	let res;
	try { res = await executeAction(intent, ctx, {}); }
	catch (e) { res = { status: 'error', note: (e?.message || 'failed').slice(0, 240) }; }
	if (res.signature || res.status === 'ok') res.note = `sniped ${match.symbol || match.mint.slice(0, 6)} @ ~$${Math.round(match.market_cap_usd || 0).toLocaleString()} mc`;
	await stampFire(intent, res, now).catch(() => {});
	return res;
}

// Public, read-only persona traits (owner opt-in). Visitors may see the BEHAVIOR,
// never the rule, caps, or controls. Used by public agent surfaces.
export async function publicIntentTraits(agentId) {
	const rows = await sql`
		SELECT trigger_type, action_type, title FROM agent_wallet_intents
		WHERE agent_id = ${agentId} AND enabled = true AND public_trait = true
		ORDER BY created_at DESC LIMIT 6
	`;
	return rows.map((r) => ({
		label: traitLabel(r.trigger_type, r.action_type) || r.title,
		trigger: r.trigger_type,
		action: r.action_type,
	}));
}

function traitLabel(trigger, action) {
	if (trigger === 'on_tip_received' && action === 'tip') return 'Tips back generously';
	if (action === 'split_income') return 'Shares its income';
	if (trigger === 'on_launch_matching' && action === 'snipe') return 'Snipes fresh launches';
	if (action === 'freeze') return 'Self-protects on low balance';
	return null;
}
