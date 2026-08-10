// Memory-grounded Autopilot — explainable autonomy (Living Agents · Task 08).
//
// The agent acts on the user's behalf, grounded in its memory, and always shows
// the receipt. This module is the engine:
//
//   1. generateProposals() — the "mind" turns high-salience memories + pending
//      reflections ("dreams") into concrete, REAL action proposals, each citing
//      the memory/reflection ids that motivated it (provenance is mandatory).
//   2. The owner grants scoped capabilities (meta.autopilot) and reviews the
//      queue: dry-run, approve, dismiss, adjust.
//   3. executeProposal() — within scope, takes the real action: creates a real
//      pump_alert_rules row, authors a real briefing notification, or transfers
//      real $THREE through the custodial wallet path. Every execution writes a
//      signed agent_actions row carrying its provenance and is linked back.
//   4. computeTrust() derives a real trust level from the action history.
//   5. undoProposal() reverses reversible actions and writes a feedback memory so
//      the agent learns the owner's boundaries (closing the loop with reflection).
//
// No mocks. Alert rules are real, briefings are real notifications, SOL
// transfers are real on-chain System-program transfers gated by real
// confirmation + scope. Autopilot spends SOL — never $THREE: the agent only ever
// accumulates and burns $THREE, never sells or sends it. The only coin named for
// alerts is $THREE.

import { sql } from './db.js';
import { llmComplete, llmConfigured, LlmUnavailableError } from './llm.js';
import { THREE_CA } from './three-gate.js';
import { recordCustodyEvent } from './agent-trade-guards.js';

// pump.fun mints (including $THREE) are 6-decimal SPL tokens.
export const THREE_DECIMALS = 6;

// Native SOL has 9 decimals (lamports). Autopilot's spend cap and wallet_transfer
// are denominated in SOL — the currency the agent actually spends on gas and fees
// (and, via the trading capability, buying coins). $THREE is never spent here.
const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_DAILY_SOL = 1000; // sane ceiling on the daily autonomous SOL spend cap

export const AUTOPILOT_ACTION_KINDS = ['create_alert', 'briefing', 'wallet_transfer'];

// The actions /api/autopilot/proposals accepts on a POST. Kept beside the engine
// so the handler's allowlist and its error message can never drift apart.
export const AUTOPILOT_PROPOSAL_ACTIONS = Object.freeze([
	'generate', 'dryrun', 'execute', 'dismiss', 'undo', 'adjust',
]);

// ── Request-input guards for the autopilot read surfaces ─────────────────────
// Every autopilot endpoint takes the same two user-supplied paging inputs. Both
// reach Postgres directly, which rejects a negative LIMIT and an out-of-range
// bigint cursor with an error that would surface to the caller as a 500. Clamp
// and validate them here, at the boundary, so bad input reads as bad input.

const MAX_BIGINT = 9223372036854775807n;

export function pageLimit(raw, { fallback = 50, max = 200 } = {}) {
	const n = Math.trunc(Number(raw));
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(n, max);
}

// agent_actions.id is a bigserial, so the cursor is an opaque decimal string.
export function parseCursor(raw) {
	if (raw == null || raw === '') return { ok: true, cursor: null };
	if (typeof raw !== 'string' || !/^\d{1,19}$/.test(raw)) return { ok: false, reason: 'cursor must be numeric' };
	if (BigInt(raw) > MAX_BIGINT) return { ok: false, reason: 'cursor out of range' };
	return { ok: true, cursor: raw };
}

// Action types written to the signed agent_actions log, one per executable kind.
const ACTION_TYPE = {
	create_alert: 'autopilot.alert.created',
	briefing: 'autopilot.briefing.authored',
	wallet_transfer: 'autopilot.wallet.transfer',
};

// ── Scope / permission model (stored on agent_identities.meta.autopilot) ──────

export const AUTOPILOT_DEFAULTS = Object.freeze({
	enabled: false,
	// Which capabilities the owner has granted. Nothing is granted by default —
	// the agent can propose but not act until the owner opts in per capability.
	scopes: Object.freeze({ create_alert: false, briefing: false, wallet_transfer: false }),
	// Reversible actions may auto-execute within scope when the owner allows it;
	// wallet_transfer is irreversible and can never auto-execute here.
	auto_execute: Object.freeze({ create_alert: false, briefing: false }),
	// Daily ceiling on autonomous SOL outflow (in SOL). 0 ⇒ no spending. The agent
	// spends SOL, never $THREE — $THREE is buy-and-hold/burn only.
	daily_spend_sol: 0,
	// Irreversible actions require an explicit confirmation unless the owner
	// durably pre-authorized that exact scope. Default: always ask.
	require_confirm: true,
});

export function normalizeAutopilotConfig(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const scopesIn = r.scopes && typeof r.scopes === 'object' ? r.scopes : {};
	const autoIn = r.auto_execute && typeof r.auto_execute === 'object' ? r.auto_execute : {};
	// Read the SOL cap. A legacy daily_spend_three (denominated in $THREE) is
	// intentionally NOT migrated — the units differ — so autopilot fails closed
	// until the owner sets a SOL cap. SOL is fractional; we don't round to whole.
	const spend = Number(r.daily_spend_sol);
	return {
		enabled: r.enabled === true,
		scopes: {
			create_alert: scopesIn.create_alert === true,
			briefing: scopesIn.briefing === true,
			wallet_transfer: scopesIn.wallet_transfer === true,
		},
		auto_execute: {
			create_alert: autoIn.create_alert === true,
			briefing: autoIn.briefing === true,
		},
		daily_spend_sol: Number.isFinite(spend) && spend > 0 ? Math.min(spend, MAX_DAILY_SOL) : 0,
		require_confirm: r.require_confirm !== false,
		updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
	};
}

export function getAutopilotConfig(meta) {
	return normalizeAutopilotConfig(meta?.autopilot);
}

/** Persist a scope-config patch onto meta.autopilot. Owner-scoped; caller checks ownership. */
export async function setAutopilotConfig(agentId, patch) {
	const [row] = await sql`SELECT meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!row) throw new Error('agent not found');
	const current = getAutopilotConfig(row.meta);
	const next = normalizeAutopilotConfig({
		enabled: 'enabled' in patch ? patch.enabled : current.enabled,
		scopes: { ...current.scopes, ...(patch.scopes || {}) },
		auto_execute: { ...current.auto_execute, ...(patch.auto_execute || {}) },
		daily_spend_sol: 'daily_spend_sol' in patch ? patch.daily_spend_sol : current.daily_spend_sol,
		require_confirm: 'require_confirm' in patch ? patch.require_confirm : current.require_confirm,
	});
	next.updated_at = new Date().toISOString();
	const nextMeta = { ...(row.meta || {}), autopilot: next };
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(nextMeta)}::jsonb, updated_at = now() WHERE id = ${agentId}`;
	return next;
}

// ── Proposal validation (per kind) ────────────────────────────────────────────

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALERT_CONDITIONS = ['price_above', 'price_below', 'graduation', 'whale_buy'];

// Map a high-level proposal into concrete, validated params + a pump_alert_rules
// body. Returns { ok, params, rule } or { ok:false, reason }. Never throws.
function buildAlertRule(params) {
	const condition = ALERT_CONDITIONS.includes(params?.condition) ? params.condition : null;
	if (!condition) return { ok: false, reason: 'unknown alert condition' };

	// Resolve the asset to a real mint. 'three' (or the bare CA) → $THREE; an
	// explicit mint must be a valid Solana address.
	let mint = null;
	const asset = String(params?.asset ?? params?.target_mint ?? 'three').trim();
	if (asset.toLowerCase() === 'three' || asset === THREE_CA) mint = THREE_CA;
	else if (SOLANA_ADDR_RE.test(asset)) mint = asset;
	else return { ok: false, reason: 'alert asset must be $THREE or a valid mint' };

	const rule = {
		kind: condition,
		target_mint: mint,
		target_agent: null,
		threshold: null,
		deliver_in_app: true,
		webhook_url: null,
		telegram_chat: null,
		cooldown_seconds: 300,
		enabled: true,
		label: typeof params?.label === 'string' ? params.label.slice(0, 80) : null,
	};
	if (condition === 'price_above' || condition === 'price_below') {
		const t = Number(params?.threshold_usd ?? params?.threshold);
		if (!Number.isFinite(t) || t <= 0) return { ok: false, reason: `${condition} needs a positive USD threshold` };
		rule.threshold = t;
	} else if (condition === 'whale_buy') {
		const t = Number(params?.threshold_sol ?? params?.threshold);
		if (!Number.isFinite(t) || t <= 0) return { ok: false, reason: 'whale_buy needs a positive SOL threshold' };
		rule.threshold = t;
	}
	return { ok: true, params: { ...params, asset: mint === THREE_CA ? 'three' : mint, condition }, rule };
}

function validateBriefing(params) {
	const summary = typeof params?.summary === 'string' ? params.summary.trim().slice(0, 300) : '';
	if (!summary) return { ok: false, reason: 'briefing needs a summary' };
	const cadence = ['once', 'daily', 'weekly'].includes(params?.cadence) ? params.cadence : 'once';
	const topic = typeof params?.topic === 'string' ? params.topic.trim().slice(0, 200) : summary;
	return { ok: true, params: { summary, cadence, topic } };
}

function validateWalletTransfer(params) {
	const recipient = typeof params?.recipient === 'string' ? params.recipient.trim() : '';
	if (!SOLANA_ADDR_RE.test(recipient)) return { ok: false, reason: 'recipient must be a valid Solana address' };
	// Buy-only $THREE: autopilot sends NATIVE SOL only. Any attempt to route this
	// through a token mint — $THREE above all — is refused. The agent never sells
	// or sends $THREE; it only accumulates and burns it.
	const token = String(params?.mint ?? params?.asset ?? params?.token ?? '').trim().toLowerCase();
	if (token && token !== 'sol' && token !== 'native') {
		return { ok: false, reason: 'wallet_transfer sends native SOL only — it will never sell or send $THREE or any SPL token' };
	}
	const amount = Number(params?.amount_sol);
	if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'amount_sol must be > 0' };
	const reason = typeof params?.reason === 'string' ? params.reason.trim().slice(0, 200) : '';
	return { ok: true, params: { recipient, amount_sol: amount, reason } };
}

/** Validate + normalize a proposal of a given kind. Returns { ok, kind, params, rule? } | { ok:false, reason }. */
export function validateProposal(kind, params) {
	if (!AUTOPILOT_ACTION_KINDS.includes(kind)) return { ok: false, reason: `unknown action kind '${kind}'` };
	if (kind === 'create_alert') {
		const r = buildAlertRule(params);
		return r.ok ? { ok: true, kind, params: r.params, rule: r.rule } : r;
	}
	if (kind === 'briefing') {
		const r = validateBriefing(params);
		return r.ok ? { ok: true, kind, params: r.params } : r;
	}
	const r = validateWalletTransfer(params);
	return r.ok ? { ok: true, kind, params: r.params } : r;
}

// A canonical key so the generator never enqueues a duplicate of a live proposal.
export function proposalDedupeKey(kind, params) {
	if (kind === 'create_alert') return `create_alert:${params.condition}:${params.asset}:${params.threshold_usd ?? params.threshold_sol ?? params.threshold ?? ''}`;
	if (kind === 'briefing') return `briefing:${params.cadence}:${(params.topic || params.summary || '').toLowerCase().slice(0, 60)}`;
	return `wallet_transfer:${params.recipient}:${params.amount_sol}`;
}

// ── Proposal generation (the "mind") ──────────────────────────────────────────

const PROPOSAL_SYSTEM = [
	'You are the autonomous-action planner of a personal AI agent. You read the',
	'agent\'s high-salience MEMORIES and propose concrete actions the agent could',
	'take on the user\'s behalf — each justified by the memories it cites.',
	'',
	'Allowed action kinds (use ONLY these):',
	'  • "create_alert"  — watch a token and notify on an event. params:',
	'      { asset: "three" | "<mint>", condition: "price_above"|"price_below"|"graduation"|"whale_buy",',
	'        threshold_usd?: number (for price_*), threshold_sol?: number (for whale_buy) }',
	'  • "briefing"      — a memory-grounded digest. params:',
	'      { summary: string, cadence: "once"|"daily"|"weekly", topic: string }',
	'  • "wallet_transfer" — send native SOL from the agent\'s own wallet. params:',
	'      { recipient: "<solana address>", amount_sol: number, reason: string }',
	'',
	'RULES:',
	'1. PROVENANCE IS MANDATORY. Every proposal must cite "source_memory_ids" using',
	'   ONLY ids that appear in the provided memories. A proposal you cannot ground',
	'   in specific memories is invalid — do not emit it.',
	'2. Propose ONLY what the memories justify. Prefer 1-3 high-value proposals over',
	'   a long list. If nothing is warranted, return {"proposals":[]}.',
	'3. For alerts the ONLY coin you name is $THREE (asset:"three"); an explicit mint',
	'   is allowed only when a memory supplies one. NEVER sell or send $THREE.',
	'4. wallet_transfer spends real SOL (never $THREE) — propose only when a memory',
	'   explicitly asks the agent to pay/tip/fund a recipient, with amount_sol.',
	'5. "rationale" is the receipt the user reads: one sentence, plain language,',
	'   explaining WHY (referencing what the memories show).',
	'',
	'Return ONLY a JSON object, no prose, no fences:',
	'{"proposals":[{"kind":"...","title":"...","rationale":"...","confidence":0.0,"source_memory_ids":["uuid"],"params":{...}}]}',
].join('\n');

function truncate(s, n) {
	const str = String(s ?? '');
	return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function buildProposalPrompt({ agent, memories }) {
	const lines = [];
	lines.push(`AGENT: ${agent?.name || 'Agent'}${agent?.description ? ` — ${agent.description}` : ''}`);
	lines.push(`$THREE mint: ${THREE_CA}`);
	lines.push('');
	lines.push('HIGH-SALIENCE MEMORIES:');
	for (const m of memories) {
		const tags = Array.isArray(m.tags) && m.tags.length ? ` [${m.tags.join(', ')}]` : '';
		lines.push(`- id=${m.id} (${m.type}, salience ${Number(m.salience).toFixed(2)})${tags}: ${truncate(m.content, 400)}`);
	}
	lines.push('');
	lines.push('Propose the actions these memories justify, as the specified JSON.');
	return lines.join('\n');
}

function parseProposalPayload(text) {
	if (!text) return null;
	let body = String(text).trim();
	const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) body = fence[1].trim();
	if (body[0] !== '{') {
		const start = body.indexOf('{');
		const end = body.lastIndexOf('}');
		if (start === -1 || end === -1 || end <= start) return null;
		body = body.slice(start, end + 1);
	}
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

// Deterministic fallback when no LLM provider is configured (the platform must
// degrade, never fake). Mines memories for two well-grounded patterns:
//   • interest in a $THREE price/market-cap level → a price alert
//   • a stated routine ("every morning", "daily digest") → a daily briefing
// Each proposal cites the exact memory it came from. Pure + synchronous.
export function heuristicProposals(memories) {
	const out = [];
	for (const m of memories) {
		const text = String(m.content || '').toLowerCase();
		const mentionsThree = /\bthree\b|\$three/.test(text);
		const priceMatch = text.match(/\$?\s?([\d,]+(?:\.\d+)?)\s?(k|m)?\b/);
		if (mentionsThree && /(market\s?cap|price|hits?|reaches?|above|target|alert)/.test(text) && priceMatch) {
			let n = parseFloat(priceMatch[1].replace(/,/g, ''));
			if (priceMatch[2] === 'k') n *= 1_000;
			if (priceMatch[2] === 'm') n *= 1_000_000;
			if (Number.isFinite(n) && n > 0) {
				out.push({
					kind: 'create_alert',
					title: `Alert when $THREE market cap crosses $${n.toLocaleString()}`,
					rationale: `You noted interest in $THREE around $${n.toLocaleString()} — I'll watch it and ping you when it crosses.`,
					confidence: 0.55,
					source_memory_ids: [m.id],
					params: { asset: 'three', condition: 'price_above', threshold_usd: n },
				});
			}
		}
		if (/(every morning|each morning|daily|each day|every day|digest|briefing|catch me up)/.test(text)) {
			out.push({
				kind: 'briefing',
				title: 'Daily $THREE briefing',
				rationale: `You mentioned wanting a regular catch-up — I'll author a short daily briefing grounded in what I know.`,
				confidence: 0.5,
				source_memory_ids: [m.id],
				params: { summary: 'Daily $THREE briefing', cadence: 'daily', topic: truncate(m.content, 120) },
			});
		}
	}
	return out;
}

// Map a reflection's proposed_action (Task 04) into one of our action kinds.
function reflectionToProposal(dream) {
	const pa = dream.proposed_action;
	if (!pa || typeof pa !== 'object') return null;
	const rawKind = String(pa.kind || '').toLowerCase();
	let kind = null;
	let params = {};
	if (rawKind.includes('alert') || pa.condition) {
		kind = 'create_alert';
		params = {
			asset: pa.asset || 'three',
			condition: ALERT_CONDITIONS.includes(pa.condition) ? pa.condition : 'price_above',
			threshold_usd: pa.threshold_usd ?? pa.threshold,
			threshold_sol: pa.threshold_sol,
		};
	} else if (rawKind.includes('brief') || rawKind.includes('digest') || pa.summary || pa.trigger) {
		kind = 'briefing';
		params = {
			summary: pa.summary || dream.statement,
			cadence: /week/i.test(pa.trigger || '') ? 'weekly' : /day|morning/i.test(pa.trigger || pa.cadence || '') ? 'daily' : 'once',
			topic: dream.statement,
		};
	} else {
		return null; // unknown automation shape — don't guess into a spend
	}
	const v = validateProposal(kind, params);
	if (!v.ok) return null;
	return {
		kind,
		title: dream.statement.slice(0, 120),
		rationale: dream.rationale || `Your agent reflected: "${truncate(dream.statement, 160)}"`,
		confidence: dream.confidence ?? 0.6,
		source_memory_ids: dream.source_memory_ids || [],
		source_reflection_id: dream.id,
		params: v.params,
	};
}

const MAX_PROPOSALS_PER_RUN = 6;
const MIN_SALIENCE = 0.6;

/**
 * Generate real action proposals for an agent from its mind (pending dreams +
 * high-salience memories). Inserts them into agent_autopilot_proposals. Returns
 * { created: [...], source } — never throws on LLM failure (falls back to
 * deterministic heuristics so the feature degrades, never fakes).
 */
export async function generateProposals({ agentId, userId, agent }) {
	// Existing live proposals — used to dedupe so we never enqueue the same thing.
	const existing = await sql`
		SELECT kind, params, source_reflection_id FROM agent_autopilot_proposals
		WHERE agent_id = ${agentId} AND status IN ('pending', 'executed')
	`;
	const seenKeys = new Set();
	const seenReflections = new Set();
	for (const e of existing) {
		if (e.source_reflection_id) seenReflections.add(e.source_reflection_id);
		const v = validateProposal(e.kind, e.params);
		if (v.ok) seenKeys.add(proposalDedupeKey(e.kind, v.params));
	}

	const candidates = [];
	let source = 'memory';

	// Source A: pending dreams that proposed an automation (provenance: reflection).
	const dreams = await sql`
		SELECT id, statement, rationale, confidence, source_memory_ids, proposed_action
		FROM agent_reflections
		WHERE agent_id = ${agentId} AND status = 'pending' AND proposed_action IS NOT NULL
		ORDER BY created_at DESC
		LIMIT 20
	`;
	for (const d of dreams) {
		if (seenReflections.has(d.id)) continue;
		const p = reflectionToProposal(d);
		if (p) {
			candidates.push(p);
			source = 'reflection';
		}
	}

	// Source B: high-salience memories → LLM synthesis (or heuristic fallback).
	const memories = await sql`
		SELECT id, type, content, tags, salience
		FROM agent_memories
		WHERE agent_id = ${agentId}
		  AND (expires_at IS NULL OR expires_at > now())
		  AND salience >= ${MIN_SALIENCE}
		ORDER BY salience DESC, created_at DESC
		LIMIT 40
	`;
	const validMemIds = new Set(memories.map((m) => m.id));

	if (memories.length) {
		let raw = [];
		if (llmConfigured()) {
			try {
				const completion = await llmComplete({
					system: PROPOSAL_SYSTEM,
					user: buildProposalPrompt({ agent, memories }),
					maxTokens: 1200,
					timeoutMs: 30_000,
					track: { userId, agentId, tool: 'autopilot.propose' },
				});
				const payload = parseProposalPayload(completion.text);
				if (payload && Array.isArray(payload.proposals)) raw = payload.proposals;
			} catch (err) {
				if (!(err instanceof LlmUnavailableError)) {
					console.warn('[autopilot] proposal LLM failed, using heuristics:', err?.message);
				}
				raw = heuristicProposals(memories);
				source = 'heuristic';
			}
		} else {
			raw = heuristicProposals(memories);
			source = 'heuristic';
		}
		for (const r of raw) candidates.push(r);
	}

	// Validate + provenance-check + dedupe, then persist.
	const created = [];
	for (const c of candidates) {
		if (created.length >= MAX_PROPOSALS_PER_RUN) break;
		const kind = String(c.kind || '');
		const v = validateProposal(kind, c.params || c);
		if (!v.ok) continue;

		// Provenance: keep only cited ids that are real memories of this agent.
		// Reflection-sourced proposals already carry verified provenance.
		const cited = Array.isArray(c.source_memory_ids) ? c.source_memory_ids : [];
		const sourceIds = c.source_reflection_id
			? [...new Set(cited.filter((id) => typeof id === 'string'))]
			: [...new Set(cited.filter((id) => typeof id === 'string' && validMemIds.has(id)))];
		if (!c.source_reflection_id && sourceIds.length === 0) continue; // ungrounded — drop

		const key = proposalDedupeKey(kind, v.params);
		if (seenKeys.has(key)) continue;
		seenKeys.add(key);

		const title = (typeof c.title === 'string' && c.title.trim() ? c.title : defaultTitle(kind, v)).slice(0, 160);
		const rationale = (typeof c.rationale === 'string' && c.rationale.trim()
			? c.rationale
			: 'Grounded in your agent\'s memory.').slice(0, 600);
		const confidence = clamp01(c.confidence, 0.6);
		// wallet_transfer is irreversible → always requires confirmation here.
		const requiresConfirmation = kind === 'wallet_transfer';

		try {
			const [row] = await sql`
				INSERT INTO agent_autopilot_proposals
					(agent_id, user_id, kind, title, rationale, params, source_memory_ids,
					 source_reflection_id, confidence, requires_confirmation)
				VALUES (
					${agentId}, ${userId}, ${kind}, ${title}, ${rationale},
					${JSON.stringify(v.params)}::jsonb, ${sourceIds}::uuid[],
					${c.source_reflection_id || null}, ${confidence}, ${requiresConfirmation}
				)
				RETURNING *
			`;
			created.push(decorateProposal(row));
		} catch (err) {
			// Unique-index race (same reflection enqueued concurrently) — skip, not fatal.
			if (!/duplicate key|unique/i.test(err?.message || '')) throw err;
		}
	}

	return { created, source, scanned: { memories: memories.length, dreams: dreams.length } };
}

function defaultTitle(kind, v) {
	if (kind === 'create_alert') {
		const m = v.params.asset === 'three' ? '$THREE' : `${v.rule.target_mint.slice(0, 6)}…`;
		return `Alert: ${m} ${v.rule.kind.replace('_', ' ')}`;
	}
	if (kind === 'briefing') return v.params.summary;
	return `Send ${v.params.amount_sol} SOL`;
}

function clamp01(n, dflt) {
	const v = Number(n);
	if (!Number.isFinite(v)) return dflt;
	return Math.max(0, Math.min(1, v));
}

// ── Signed receipts ───────────────────────────────────────────────────────────

// Build the canonical message that gets ERC-191 signed for a receipt.
export function actionMessage({ agentId, type, ts, payload }) {
	return [
		'three.ws/autopilot',
		`agent:${agentId}`,
		`type:${type}`,
		`ts:${ts}`,
		`payload:${stableStringify(payload)}`,
	].join('\n');
}

function stableStringify(obj) {
	if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
	if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// Sign an action with the agent's EVM custodial key (ERC-191 personal_sign).
// Best-effort: returns { signature, signer_address } or nulls when no key
// exists — a missing key never blocks the action, the receipt is just unsigned.
async function signAction(agentId, userId, meta, type, ts, payload) {
	const encrypted = meta?.encrypted_wallet_key;
	if (!encrypted) return { signature: null, signer_address: null };
	try {
		const { recoverAgentKey } = await import('./agent-wallet.js');
		const { Wallet } = await import('ethers');
		const pk = await recoverAgentKey(encrypted, { agentId, userId, reason: 'autopilot.sign' });
		const wallet = new Wallet(pk);
		const signature = await wallet.signMessage(actionMessage({ agentId, type, ts, payload }));
		return { signature, signer_address: wallet.address };
	} catch (err) {
		console.warn('[autopilot] action signing skipped:', err?.message);
		return { signature: null, signer_address: null };
	}
}

// Append a signed action to the real agent_actions log. Returns the row id.
async function recordAction({ agentId, userId, meta, type, payload }) {
	const ts = new Date().toISOString();
	const signed = { ...payload, ts };
	const { signature, signer_address } = await signAction(agentId, userId, meta, type, ts, signed);
	const [row] = await sql`
		INSERT INTO agent_actions (agent_id, type, payload, source_skill, signature, signer_address)
		VALUES (${agentId}, ${type}, ${JSON.stringify(signed)}::jsonb, 'autopilot', ${signature}, ${signer_address})
		RETURNING id
	`;
	return { id: row.id, signature, signer_address, ts };
}

// ── Execution ─────────────────────────────────────────────────────────────────

export class AutopilotError extends Error {
	constructor(message, { status = 400, code = 'autopilot_error' } = {}) {
		super(message);
		this.name = 'AutopilotError';
		this.status = status;
		this.code = code;
	}
}

/** Sum of SOL sent by autopilot in the trailing 24h (real history from agent_actions). */
export async function dailySolSpent(agentId) {
	const [row] = await sql`
		SELECT COALESCE(SUM((payload->>'amount_sol')::numeric), 0) AS spent
		FROM agent_actions
		WHERE agent_id = ${agentId}
		  AND type = ${ACTION_TYPE.wallet_transfer}
		  AND created_at > now() - interval '24 hours'
	`;
	return Number(row?.spent ?? 0);
}

/** Live native SOL balance (in SOL) for an address. Best-effort RPC read. */
async function agentSolBalance(address) {
	const { Connection, PublicKey } = await import('@solana/web3.js');
	const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
	const conn = new Connection(url, 'confirmed');
	const lamports = await conn.getBalance(new PublicKey(address), 'confirmed');
	return lamports / LAMPORTS_PER_SOL;
}

/**
 * A non-mutating preview of exactly what executing a proposal would do — the
 * "dry run" that lets a cautious owner see before granting. Returns
 * { kind, willDo, checks: [{label, ok, detail}], blocked }.
 */
export async function dryRunProposal({ proposal, agent, config }) {
	const checks = [];
	const kind = proposal.kind;
	const scoped = config.scopes[kind] === true;
	checks.push({ label: `Scope "${kind}" granted`, ok: scoped, detail: scoped ? 'granted' : 'not granted — enable it above' });

	let willDo = '';
	if (kind === 'create_alert') {
		const v = validateProposal(kind, proposal.params);
		willDo = v.ok
			? `Create a real alert rule: ${v.rule.kind.replace('_', ' ')} on ${v.params.asset === 'three' ? '$THREE' : v.rule.target_mint}` +
			  (v.rule.threshold != null ? ` at ${v.rule.threshold}` : '') + '. Reversible — you can undo it.'
			: `Invalid: ${v.reason}`;
		checks.push({ label: 'Alert parameters valid', ok: v.ok, detail: v.ok ? 'ok' : v.reason });
	} else if (kind === 'briefing') {
		willDo = `Author a memory-grounded briefing ("${proposal.params.topic || proposal.params.summary}") and deliver it to your inbox. Reversible.`;
		checks.push({ label: 'LLM available for synthesis', ok: llmConfigured(), detail: llmConfigured() ? 'ready' : 'will use a grounded summary fallback' });
	} else {
		const amt = Number(proposal.params.amount_sol) || 0;
		willDo = `Send ${amt} SOL to ${proposal.params.recipient}. IRREVERSIBLE — always requires explicit confirmation. (Autopilot never sells or sends $THREE.)`;
		const cap = config.daily_spend_sol;
		const spent = await dailySolSpent(proposal.agentId);
		const withinCap = config.scopes.wallet_transfer && cap > 0 && spent + amt <= cap;
		checks.push({ label: `Within daily SOL cap (${cap})`, ok: withinCap, detail: `${spent} spent in 24h + ${amt} ≤ ${cap}` });
		// Live native SOL balance check — real RPC read, no spend.
		let bal = null;
		try {
			const { ensureAgentWallet } = await import('./agent-wallet.js');
			const w = await ensureAgentWallet(proposal.agentId, agent.user_id, { reason: 'autopilot.dryrun' });
			bal = await agentSolBalance(w.address);
		} catch { /* balance is decoration on the preview */ }
		checks.push({ label: 'Wallet SOL balance covers transfer', ok: bal == null ? false : bal >= amt, detail: bal == null ? 'could not read balance' : `${bal} SOL available` });
	}

	const blocked = checks.some((c) => !c.ok);
	return { kind, willDo, checks, blocked };
}

/**
 * Execute a proposal for real, within scope. Writes a signed agent_actions row
 * with full provenance, links it back to the proposal, and returns
 * { proposal, action, receipt }. Throws AutopilotError (4xx) on a guard breach —
 * never a 500 for an expected denial.
 *
 * @param {object} opts.confirmed  the owner explicitly confirmed an irreversible action this call
 */
export async function executeProposal({ proposal, agent, userId, meta, confirmed = false }) {
	const config = getAutopilotConfig(meta);
	const kind = proposal.kind;

	if (!config.enabled) throw new AutopilotError('Autopilot is off — enable it to let the agent act.', { code: 'autopilot_disabled', status: 409 });
	if (!config.scopes[kind]) throw new AutopilotError(`This agent isn't scoped to ${kind.replace('_', ' ')}.`, { code: 'scope_denied', status: 403 });

	const irreversible = kind === 'wallet_transfer';
	if (irreversible && config.require_confirm && !confirmed) {
		throw new AutopilotError('This action moves real SOL and needs explicit confirmation.', { code: 'confirmation_required', status: 428 });
	}

	const provenance = {
		proposal_id: proposal.id,
		rationale: proposal.rationale,
		source_memory_ids: proposal.sourceMemoryIds || [],
		source_reflection_id: proposal.sourceReflectionId || null,
	};

	let action;
	let result = {};

	if (kind === 'create_alert') {
		const v = validateProposal(kind, proposal.params);
		if (!v.ok) throw new AutopilotError(`Invalid alert: ${v.reason}`);
		const r = v.rule;
		const [rule] = await sql`
			INSERT INTO pump_alert_rules
				(user_id, kind, target_mint, target_agent, threshold, deliver_in_app,
				 webhook_url, telegram_chat, cooldown_seconds, enabled, label)
			VALUES (
				${userId}, ${r.kind}, ${r.target_mint}, ${r.target_agent}, ${r.threshold},
				${r.deliver_in_app}, ${r.webhook_url}, ${r.telegram_chat}, ${r.cooldown_seconds},
				${r.enabled}, ${r.label}
			)
			RETURNING id
		`;
		result = { rule_id: rule.id, rule_kind: r.kind, target_mint: r.target_mint, threshold: r.threshold };
		action = await recordAction({ agentId: proposal.agentId, userId, meta, type: ACTION_TYPE.create_alert, payload: { ...provenance, ...result } });
	} else if (kind === 'briefing') {
		const body = await composeBriefing({ agentId: proposal.agentId, userId, agent, params: proposal.params });
		const [notif] = await sql`
			INSERT INTO user_notifications (user_id, type, payload)
			VALUES (${userId}, 'autopilot_briefing', ${JSON.stringify({
				agent_id: proposal.agentId,
				agent_name: agent.name || 'Your agent',
				title: proposal.title,
				body,
				cadence: proposal.params.cadence,
				proposal_id: proposal.id,
				source_memory_ids: provenance.source_memory_ids,
			})}::jsonb)
			RETURNING id
		`;
		result = { notification_id: notif.id, cadence: proposal.params.cadence, body_preview: body.slice(0, 140) };
		action = await recordAction({ agentId: proposal.agentId, userId, meta, type: ACTION_TYPE.briefing, payload: { ...provenance, ...result } });
	} else {
		// wallet_transfer — real, irreversible native SOL transfer (never $THREE).
		result = await executeWalletTransfer({ proposal, agent, userId, config });
		action = await recordAction({ agentId: proposal.agentId, userId, meta, type: ACTION_TYPE.wallet_transfer, payload: { ...provenance, ...result } });
	}

	const [row] = await sql`
		UPDATE agent_autopilot_proposals
		SET status = 'executed', decided_at = now(), executed_at = now(),
		    executed_action_id = ${action.id}, result = ${JSON.stringify(result)}::jsonb
		WHERE id = ${proposal.id} AND status = 'pending'
		RETURNING *
	`;
	if (!row) {
		// Lost the race — already decided. The action is logged; surface idempotently.
		const [cur] = await sql`SELECT * FROM agent_autopilot_proposals WHERE id = ${proposal.id}`;
		return { proposal: decorateProposal(cur), action, receipt: buildReceipt(kind, result) };
	}
	return { proposal: decorateProposal(row), action, receipt: buildReceipt(kind, result) };
}

async function executeWalletTransfer({ proposal, agent, userId, config }) {
	const amount = Number(proposal.params.amount_sol);
	const recipient = proposal.params.recipient;
	if (!SOLANA_ADDR_RE.test(recipient)) throw new AutopilotError('Invalid recipient address.');
	if (!(amount > 0)) throw new AutopilotError('Transfer amount must be positive.');

	// Daily SOL cap — real history. Autopilot spends SOL only; it never sells $THREE.
	const cap = config.daily_spend_sol;
	if (!(cap > 0)) throw new AutopilotError('No daily SOL spend budget is set.', { code: 'no_budget', status: 403 });
	const spent = await dailySolSpent(proposal.agentId);
	if (spent + amount > cap) {
		throw new AutopilotError(`Daily SOL budget exceeded (${spent} + ${amount} > ${cap}).`, { code: 'budget_exceeded', status: 403 });
	}

	const { ensureAgentWallet, recoverSolanaAgentKeypair } = await import('./agent-wallet.js');
	const { transferNativeSol } = await import('./solana-transfer.js');

	await ensureAgentWallet(proposal.agentId, agent.user_id, { reason: 'autopilot.transfer' });
	const [row] = await sql`SELECT meta FROM agent_identities WHERE id = ${proposal.agentId}`;
	const encryptedSecret = row?.meta?.encrypted_solana_secret;
	const fromAddress = row?.meta?.solana_address;
	if (!encryptedSecret || !fromAddress) throw new AutopilotError('Agent wallet not provisioned.', { code: 'no_wallet', status: 409 });

	// Live native SOL balance must cover the transfer.
	const lamports = BigInt(Math.round(amount * LAMPORTS_PER_SOL));
	const balanceSol = await agentSolBalance(fromAddress).catch(() => null);
	if (balanceSol != null && balanceSol < amount) {
		throw new AutopilotError(`Insufficient SOL: wallet holds ${balanceSol}, needs ${amount}.`, { code: 'insufficient_funds', status: 402 });
	}

	const custodyId = await recordCustodyEvent({
		agentId: proposal.agentId, userId, eventType: 'spend', category: 'autopilot',
		network: 'mainnet', asset: 'SOL', amountRaw: lamports.toString(),
		destination: recipient, reason: `autopilot ${proposal.params.reason || 'transfer'}`.slice(0, 200),
		status: 'pending', meta: { proposal_id: proposal.id, amount_sol: amount },
	});

	let signature;
	try {
		const kp = await recoverSolanaAgentKeypair(encryptedSecret, { agentId: proposal.agentId, userId, reason: 'autopilot.transfer' });
		signature = await transferNativeSol({
			fromKeypair: kp,
			toAddress: recipient,
			lamports,
			network: 'mainnet',
		});
	} catch (err) {
		const { updateCustodyEvent } = await import('./agent-trade-guards.js');
		await updateCustodyEvent(custodyId, { status: 'failed', meta: { error: (err?.message || 'transfer failed').slice(0, 300) } });
		throw new AutopilotError(`SOL transfer failed: ${(err?.message || 'unknown').slice(0, 200)}`, { code: 'transfer_failed', status: 502 });
	}

	const { updateCustodyEvent } = await import('./agent-trade-guards.js');
	await updateCustodyEvent(custodyId, { status: 'confirmed', signature });
	return { signature, amount_sol: amount, recipient, asset: 'SOL', custody_id: custodyId };
}

// Author a real, memory-grounded briefing via the LLM (degrades to a grounded
// summary when no provider is configured — never a fake "the agent said X").
async function composeBriefing({ agentId, userId, agent, params }) {
	const memories = await sql`
		SELECT content, salience FROM agent_memories
		WHERE agent_id = ${agentId} AND (expires_at IS NULL OR expires_at > now())
		ORDER BY salience DESC, created_at DESC
		LIMIT 12
	`;
	const grounded = memories.map((m) => `- ${truncate(m.content, 200)}`).join('\n');
	if (!llmConfigured() || !memories.length) {
		return `${params.summary}\n\nGrounded in what I know:\n${grounded || '(no memories yet)'}`.slice(0, 2000);
	}
	try {
		const completion = await llmComplete({
			system: [
				`You are ${agent?.name || 'a personal AI agent'} writing a short briefing for your owner.`,
				'Ground every statement in the provided memories. Be concise (under 120 words),',
				'warm, and specific. The only coin you may reference is $THREE. No markdown headers.',
			].join('\n'),
			user: `Topic: ${params.topic || params.summary}\n\nWhat you know:\n${grounded}\n\nWrite the briefing.`,
			maxTokens: 400,
			timeoutMs: 25_000,
			track: { userId, agentId, tool: 'autopilot.briefing' },
		});
		return (completion.text || params.summary).slice(0, 2000);
	} catch {
		return `${params.summary}\n\nGrounded in what I know:\n${grounded}`.slice(0, 2000);
	}
}

function buildReceipt(kind, result) {
	if (kind === 'create_alert') return `Created a ${String(result.rule_kind).replace('_', ' ')} alert.`;
	if (kind === 'briefing') return 'Authored a briefing and delivered it to your inbox.';
	return `Sent ${result.amount_sol} SOL.`;
}

// ── Trust loop (approve / dismiss / undo) ─────────────────────────────────────

/**
 * Reverse a reversible action and write a feedback memory so the agent learns
 * the boundary. wallet_transfer is irreversible and cannot be undone (on-chain).
 */
export async function undoProposal({ proposal, agentId, userId }) {
	if (proposal.status !== 'executed') throw new AutopilotError('Only an executed action can be undone.', { code: 'not_executed', status: 409 });
	if (proposal.kind === 'wallet_transfer') {
		throw new AutopilotError('A SOL transfer is on-chain and cannot be undone.', { code: 'irreversible', status: 409 });
	}

	if (proposal.kind === 'create_alert' && proposal.result?.rule_id) {
		await sql`DELETE FROM pump_alert_rules WHERE id = ${proposal.result.rule_id} AND user_id = ${userId}`;
	} else if (proposal.kind === 'briefing' && proposal.result?.notification_id) {
		await sql`DELETE FROM user_notifications WHERE id = ${proposal.result.notification_id} AND user_id = ${userId}`;
	}

	await sql`
		UPDATE agent_autopilot_proposals
		SET status = 'undone', decided_at = now()
		WHERE id = ${proposal.id} AND status = 'executed'
	`;

	// Closing the loop with Reflection (Task 04/05): the undo is real feedback the
	// agent remembers, so future reflections lean more conservative.
	const fb = `I undid an autopilot action ("${truncate(proposal.title, 120)}"). Be more conservative before taking this kind of action again.`;
	await sql`
		INSERT INTO agent_memories (agent_id, type, content, tags, context, salience, tier, pinned)
		VALUES (${agentId}, 'feedback', ${fb}, ${['autopilot', 'undo', 'boundary']},
			${JSON.stringify({ source: 'autopilot_undo', proposal_id: proposal.id, kind: proposal.kind })}::jsonb,
			0.8, 'recall', true)
	`;
	return { ok: true };
}

/** Dismiss a pending proposal; records a light feedback signal. */
export async function dismissProposal({ proposal, agentId }) {
	if (proposal.status !== 'pending') throw new AutopilotError('Only a pending proposal can be dismissed.', { code: 'not_pending', status: 409 });
	await sql`
		UPDATE agent_autopilot_proposals
		SET status = 'dismissed', decided_at = now()
		WHERE id = ${proposal.id} AND status = 'pending'
	`;
	await sql`
		INSERT INTO agent_memories (agent_id, type, content, tags, context, salience, tier, pinned)
		VALUES (${agentId}, 'feedback', ${`I dismissed an autopilot proposal: "${truncate(proposal.title, 120)}". Don't propose this again.`},
			${['autopilot', 'dismissed']},
			${JSON.stringify({ source: 'autopilot_dismiss', proposal_id: proposal.id, kind: proposal.kind })}::jsonb,
			0.6, 'recall', false)
	`;
	return { ok: true };
}

const TRUST_LEVELS = [
	{ key: 'sandbox', label: 'Sandbox', min: 0, blurb: 'Proposes; you approve everything.' },
	{ key: 'trusted', label: 'Trusted', min: 5, blurb: 'A track record of approved actions.' },
	{ key: 'autonomous', label: 'Autonomous', min: 20, blurb: 'Consistently acts within your boundaries.' },
];

/**
 * Trust level derived from REAL action history — not a vanity number.
 * Score = approved actions, penalized by undos/dismissals, normalized by volume.
 */
export async function computeTrust({ agentId }) {
	const [counts] = await sql`
		SELECT
			COUNT(*) FILTER (WHERE status = 'executed')  AS executed,
			COUNT(*) FILTER (WHERE status = 'undone')    AS undone,
			COUNT(*) FILTER (WHERE status = 'dismissed') AS dismissed,
			COUNT(*) FILTER (WHERE status = 'pending')   AS pending
		FROM agent_autopilot_proposals
		WHERE agent_id = ${agentId}
	`;
	const executed = Number(counts?.executed ?? 0);
	const undone = Number(counts?.undone ?? 0);
	const dismissed = Number(counts?.dismissed ?? 0);
	const pending = Number(counts?.pending ?? 0);

	// Net successful actions: each kept execution is +1, each undo cancels one out.
	const net = Math.max(0, executed - undone);
	const decided = executed + dismissed + undone;
	// Reliability: of everything decided, how much did the owner keep?
	const reliability = decided > 0 ? executed / decided : 0;
	const score = Math.round(net * Math.max(0.25, reliability));

	let level = TRUST_LEVELS[0];
	for (const l of TRUST_LEVELS) if (score >= l.min) level = l;

	return {
		level: level.key,
		label: level.label,
		blurb: level.blurb,
		score,
		stats: { executed, undone, dismissed, pending, reliability: Math.round(reliability * 100) },
		next: nextLevel(level, score),
	};
}

function nextLevel(current, score) {
	const idx = TRUST_LEVELS.findIndex((l) => l.key === current.key);
	const nxt = TRUST_LEVELS[idx + 1];
	if (!nxt) return null;
	return { label: nxt.label, at: nxt.min, remaining: Math.max(0, nxt.min - score) };
}

// ── Serialization ─────────────────────────────────────────────────────────────

export function decorateProposal(row) {
	return {
		id: row.id,
		agentId: row.agent_id,
		userId: row.user_id,
		kind: row.kind,
		title: row.title,
		rationale: row.rationale,
		params: row.params || {},
		sourceMemoryIds: row.source_memory_ids || [],
		sourceReflectionId: row.source_reflection_id || null,
		confidence: row.confidence != null ? Number(row.confidence) : null,
		requiresConfirmation: row.requires_confirmation,
		status: row.status,
		executedActionId: row.executed_action_id != null ? String(row.executed_action_id) : null,
		result: row.result || {},
		createdAt: toIso(row.created_at),
		decidedAt: toIso(row.decided_at),
		executedAt: toIso(row.executed_at),
	};
}

function toIso(d) {
	if (!d) return null;
	return d instanceof Date ? d.toISOString() : d;
}
