// /api/agents/:id/solana/intent — the Conversational Wallet's parser.
//
// POST /api/agents/:id/solana/intent  { utterance, history?, network?, context? }
//
// Turns a natural-language instruction ("tip 0.1 SOL to vault.sol", "snipe that
// mint with half a SOL", "withdraw 2 SOL to my Phantom") into a STRICT, validated
// intent object via Claude tool use — never free-text-to-transaction. This handler
// ONLY parses and grounds the intent; it never signs, quotes, or moves funds. The
// client takes the returned intent, previews it through the real task-05 trade /
// withdraw engine, shows an explicit read-back, and on the owner's confirm calls
// those owner-only, CSRF-protected, spend-policy-gated, audited endpoints.
//
// Owner-only by construction: a visitor (or logged-out caller) gets a 403 here, and
// even if they fabricated an intent the execution endpoints reject them server-side.
// The LLM has no privileged route around the spend guard — it produces structured
// text, nothing more.
//
// $THREE is the only coin three.ws promotes. The parser resolves "$THREE"/"three"
// to its canonical mint; any other mint is runtime data the owner supplied
// (a snipe target), never hardcoded or recommended.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { loadUserProviderKeys } from '../_lib/provider-keys.js';
import { resolveSolanaRecipient } from '../../src/solana/sns.js';
import { THREE_MINT } from '../_lib/networth-model.js';
import { getSpendLimits, getTradeLimits } from '../_lib/agent-trade-guards.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-opus-4-8';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// GPT-OSS 120B exposes OpenAI-style tool calling on OpenRouter — the free-tier
// fallback when the Anthropic key is absent so voice trading still parses.
const OPENROUTER_MODEL = 'openai/gpt-oss-120b';
const CALL_TIMEOUT_MS = 15_000;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const ACTIONS = ['buy', 'swap', 'snipe', 'sell', 'tip', 'withdraw', 'none', 'clarify'];
const UNITS = ['SOL', 'USDC', 'USD', 'token', 'percent', 'max'];

// The single tool Claude must call. We force the call (tool_choice) and validate
// the result server-side, so a missing/odd field degrades to a clarify, never a
// bad transaction.
const INTENT_TOOL = {
	name: 'record_wallet_intent',
	description:
		'Record the single wallet action the owner asked their agent to take, as a strict structured intent. ' +
		'Map the latest message to exactly one action. NEVER guess an amount or a destination — if either is ' +
		'missing or ambiguous, set action to "clarify" and put a short, in-character question in ' +
		'clarifying_question. The only coin the platform promotes is $THREE; treat "$THREE"/"three" as that ' +
		'coin. A mint the user names for a snipe/buy is their own runtime input.',
	input_schema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: ACTIONS,
				description:
					'buy/swap: spend SOL to buy a token. snipe: buy a freshly-launched mint. sell: sell a held ' +
					'token for SOL. tip: send SOL/USDC to someone as a tip. withdraw: move SOL/token to an ' +
					'address the owner controls. none: not a wallet command. clarify: need more info.',
			},
			amount: {
				type: 'number',
				description: 'The numeric amount the user named (e.g. 0.1, 2, 50). Omit if they named none.',
			},
			amount_unit: {
				type: 'string',
				enum: UNITS,
				description:
					'SOL/USDC/USD = a currency amount; percent = a share (e.g. "half" → 50); max = all of it; ' +
					'token = a raw token count for a sell.',
			},
			asset: {
				type: 'string',
				description:
					'The asset being spent or sold: "SOL", "USDC", "$THREE", a token symbol, or a base58 mint.',
			},
			destination_or_mint: {
				type: 'string',
				description:
					'For withdraw/tip: the recipient address or .sol name. For buy/swap/snipe: the mint or ' +
					'symbol to acquire ("$THREE" or a base58 mint).',
			},
			slippage_pct: { type: 'number', description: 'Slippage tolerance percent if the user stated one.' },
			confidence: { type: 'number', description: 'Your confidence 0..1 that this parse is correct.' },
			clarifying_question: {
				type: 'string',
				description: 'When action is "clarify", the single in-character question to ask the owner.',
			},
			readback: {
				type: 'string',
				description:
					'One plain-language sentence stating exactly what will happen, e.g. ' +
					'"Withdraw 2 SOL to 7xKX…Ab12." Phrase it for the owner to confirm aloud.',
			},
		},
		required: ['action', 'confidence', 'readback'],
	},
};

const OPENAI_TOOL = {
	type: 'function',
	function: { name: INTENT_TOOL.name, description: INTENT_TOOL.description, parameters: INTENT_TOOL.input_schema },
};

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// ── pure helpers (exported for tests) ───────────────────────────────────────────

// Map a free-text asset reference to a canonical Solana asset. $THREE is the only
// coin we resolve by name; everything else is SOL, USDC, a raw mint, or unknown.
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

// Validate + clamp the raw tool output into the canonical intent the client
// executes. Anything malformed collapses to a clarify so money never moves on a
// guess. Pure + synchronous; destination/mint resolution happens in the handler.
export function normalizeWalletIntent(raw, { threeMint = THREE_MINT } = {}) {
	const r = raw && typeof raw === 'object' ? raw : {};
	let action = String(r.action || '').toLowerCase();
	if (!ACTIONS.includes(action)) action = 'none';
	if (action === 'swap') action = 'buy';

	const confidence = clamp01(Number(r.confidence));
	const readback = typeof r.readback === 'string' ? r.readback.slice(0, 400) : '';
	const clarifying =
		typeof r.clarifying_question === 'string' && r.clarifying_question.trim()
			? r.clarifying_question.trim().slice(0, 400)
			: null;

	if (action === 'none') {
		return { action: 'none', confidence, readback, clarifying_question: clarifying };
	}
	if (action === 'clarify') {
		return {
			action: 'clarify',
			confidence,
			readback,
			clarifying_question: clarifying || 'Could you say that again with the amount and destination?',
		};
	}

	const amountRaw = Number(r.amount);
	const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : null;
	let unit = typeof r.amount_unit === 'string' ? r.amount_unit : null;
	if (unit && !UNITS.includes(unit)) unit = null;

	let slippage = Number(r.slippage_pct);
	slippage = Number.isFinite(slippage) ? Math.max(0, Math.min(50, slippage)) : null;

	const out = { action, confidence, readback, clarifying_question: clarifying, slippage_pct: slippage };

	if (action === 'buy' || action === 'snipe') {
		// Acquire a mint by spending SOL. The thing being acquired is in
		// destination_or_mint (the mint/symbol); the spend is amount+unit.
		const target = resolveAssetToken(r.destination_or_mint || r.asset, { threeMint });
		out.target = target;
		out.amount = amount;
		out.amount_unit = unit;
		return out;
	}
	if (action === 'sell') {
		const target = resolveAssetToken(r.asset || r.destination_or_mint, { threeMint });
		out.target = target;
		out.amount = amount;
		out.amount_unit = unit;
		return out;
	}
	// tip / withdraw — move an asset to a destination.
	out.asset = resolveAssetToken(r.asset, { threeMint });
	out.amount = amount;
	out.amount_unit = unit;
	out.destination = typeof r.destination_or_mint === 'string' ? r.destination_or_mint.trim() : '';
	return out;
}

function clamp01(n) {
	return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

// ── LLM calls ───────────────────────────────────────────────────────────────────

function buildSystemPrompt({ agentName, network, balanceSol, holdings, limits: lim, tradeLimits }) {
	const heldLines = (holdings || [])
		.slice(0, 8)
		.map((h) => `  - ${h.symbol || h.mint}: ${h.ui_amount} (mint ${h.mint})`)
		.join('\n');
	const lines = [
		`You are the wallet brain of "${agentName || 'this agent'}", a 3D AI agent on three.ws that holds its own real Solana wallet. The agent's OWNER is speaking to you and can move real funds.`,
		'Your only job: translate the owner\'s latest message into exactly one structured wallet intent by calling the record_wallet_intent tool. Output nothing else.',
		'',
		'Rules:',
		'- NEVER guess an amount or a destination. If the message is missing the amount, the destination, or the token, set action="clarify" and ask one short, in-character question.',
		'- If the message is small talk or not about moving money, set action="none".',
		'- The ONLY coin this platform promotes is $THREE. Treat "$THREE"/"three" as that coin. A mint address the owner pastes for a snipe/buy is their own input — pass it through, never invent one.',
		'- "buy/swap" spends SOL to acquire a token. "snipe" buys a freshly-launched mint. "sell" sells a held token for SOL. "tip" and "withdraw" send funds to an address.',
		'- "half a SOL" → amount 0.5, unit SOL. "half my SOL" / "half" of a holding → amount 50, unit percent. "everything"/"all" → unit max.',
		'- Trades on this engine are quoted in SOL. If the owner asks to swap a non-SOL balance (e.g. USDC) into a token without saying how much SOL to spend, clarify how much SOL to use.',
		'- Keep readback to one sentence the owner can confirm aloud, naming the real amount and destination/token.',
		'',
		`Live context — network: ${network}; spendable SOL: ${balanceSol == null ? 'unknown' : balanceSol}.`,
		heldLines ? `Tokens held:\n${heldLines}` : 'Tokens held: none detected.',
		`Owner spend policy: per-tx $${fmtLim(lim?.per_tx_usd)}, daily $${fmtLim(lim?.daily_usd)}. Trade caps: per-trade ◎${fmtLim(tradeLimits?.per_trade_sol)}, daily ◎${fmtLim(tradeLimits?.daily_budget_sol)}${tradeLimits?.kill_switch ? '; trading is PAUSED' : ''}.`,
		'These limits are enforced by the server at execution — you do not need to enforce them, but you may mention them if the owner asks for more than allowed.',
	];
	return lines.join('\n');
}

function fmtLim(v) {
	return v == null ? '∞' : v;
}

function buildMessages({ utterance, history }) {
	const msgs = [];
	for (const h of (history || []).slice(-6)) {
		if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
			msgs.push({ role: h.role, content: h.content.slice(0, 1000) });
		}
	}
	msgs.push({ role: 'user', content: String(utterance).slice(0, 1000) });
	// Anthropic requires the first message to be a user turn.
	if (msgs[0].role !== 'user') msgs.shift();
	return msgs;
}

async function fetchWithTimeout(url, opts) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
	try {
		return await fetch(url, { ...opts, signal: ctrl.signal });
	} finally {
		clearTimeout(t);
	}
}

async function callAnthropic({ apiKey, system, messages }) {
	const resp = await fetchWithTimeout(ANTHROPIC_URL, {
		method: 'POST',
		headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
		body: JSON.stringify({
			model: ANTHROPIC_MODEL,
			max_tokens: 600,
			system,
			messages,
			tools: [INTENT_TOOL],
			tool_choice: { type: 'tool', name: INTENT_TOOL.name },
		}),
	});
	if (!resp.ok) throw new Error(`anthropic ${resp.status}`);
	const j = await resp.json();
	const block = (j.content || []).find((b) => b.type === 'tool_use' && b.name === INTENT_TOOL.name);
	if (!block) throw new Error('anthropic: no tool_use');
	return block.input;
}

async function callOpenRouter({ apiKey, system, messages }) {
	const resp = await fetchWithTimeout(OPENROUTER_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'content-type': 'application/json',
			'HTTP-Referer': 'https://three.ws',
			'X-Title': 'three.ws conversational wallet',
		},
		body: JSON.stringify({
			model: OPENROUTER_MODEL,
			max_tokens: 600,
			messages: [{ role: 'system', content: system }, ...messages],
			tools: [OPENAI_TOOL],
			tool_choice: { type: 'function', function: { name: INTENT_TOOL.name } },
		}),
	});
	if (!resp.ok) throw new Error(`openrouter ${resp.status}`);
	const j = await resp.json();
	const call = j.choices?.[0]?.message?.tool_calls?.[0];
	if (!call?.function?.arguments) throw new Error('openrouter: no tool_call');
	return JSON.parse(call.function.arguments);
}

async function callGrok({ apiKey, system, messages }) {
	const resp = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			model: 'grok-4.1-fast',
			max_tokens: 600,
			messages: [{ role: 'system', content: system }, ...messages],
			tools: [OPENAI_TOOL],
			tool_choice: { type: 'function', function: { name: INTENT_TOOL.name } },
		}),
	});
	if (!resp.ok) throw new Error(`grok ${resp.status}`);
	const j = await resp.json();
	const call = j.choices?.[0]?.message?.tool_calls?.[0];
	if (!call?.function?.arguments) throw new Error('grok: no tool_call');
	return JSON.parse(call.function.arguments);
}

// ── handler ──────────────────────────────────────────────────────────────────────

export async function handleIntent(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in to talk-to-trade from this wallet');

	const [row] = await sql`SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	// Owner-only: visitors can converse but can never trigger a fund action, by any
	// phrasing. The parser itself is gated so the LLM is never even consulted for a
	// non-owner.
	if (row.user_id !== auth.userId) {
		return error(res, 403, 'forbidden', 'only the owner can give this wallet voice commands');
	}

	const rl = await limits.chatUser(auth.userId || `ip:${clientIp(req)}`);
	if (!rl.success) return rateLimited(res, rl, 'too many wallet commands, slow down');

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid request body');
	}

	const utterance = typeof body.utterance === 'string' ? body.utterance.trim() : '';
	if (!utterance) return error(res, 400, 'validation_error', 'utterance is required');
	if (utterance.length > 1000) return error(res, 400, 'validation_error', 'utterance is too long');
	const network = body.network === 'devnet' ? 'devnet' : 'mainnet';

	const meta = { ...(row.meta || {}) };
	const ctx = body.context && typeof body.context === 'object' ? body.context : {};
	const system = buildSystemPrompt({
		agentName: row.name,
		network,
		balanceSol: typeof ctx.balance_sol === 'number' ? ctx.balance_sol : null,
		holdings: Array.isArray(ctx.holdings) ? ctx.holdings : [],
		limits: getSpendLimits(meta),
		tradeLimits: getTradeLimits(meta),
	});
	const messages = buildMessages({ utterance, history: body.history });

	// Provider ladder: Anthropic (claude-opus-4-8, native tool use) first; an
	// OpenRouter free-tier model with OpenAI-style tool calling as the fallback so a
	// missing Anthropic key never takes voice trading down silently. Both produce the
	// same tool schema; the server normalizes the result either way.
	let userKeys = {};
	try {
		const [urow] = await sql`SELECT provider_keys FROM users WHERE id = ${auth.userId}`;
		userKeys = await loadUserProviderKeys(urow?.provider_keys);
	} catch {
		userKeys = {};
	}
	const anthropicKey = userKeys.anthropic || process.env.ANTHROPIC_API_KEY;
	const grokKey = userKeys.grok || process.env.GROK_API_KEY;
	const openrouterKey = userKeys.openrouter || process.env.OPENROUTER_API_KEY;

	let rawIntent = null;
	let provider = null;
	const tried = [];
	if (anthropicKey) {
		try {
			rawIntent = await callAnthropic({ apiKey: anthropicKey, system, messages });
			provider = 'anthropic';
		} catch (e) {
			tried.push(`anthropic:${e.message}`);
		}
	}
	if (!rawIntent && grokKey) {
		try {
			rawIntent = await callGrok({ apiKey: grokKey, system, messages });
			provider = 'grok';
		} catch (e) {
			tried.push(`grok:${e.message}`);
		}
	}
	if (!rawIntent && openrouterKey) {
		try {
			rawIntent = await callOpenRouter({ apiKey: openrouterKey, system, messages });
			provider = 'openrouter';
		} catch (e) {
			tried.push(`openrouter:${e.message}`);
		}
	}

	if (!rawIntent) {
		if (!anthropicKey && !grokKey && !openrouterKey) {
			// Honest signal so the client can fall back to the manual HUD form rather
			// than fake a parse.
			return error(res, 503, 'intent_unavailable', 'voice trading is not configured on this deployment — use the wallet form');
		}
		console.warn('[solana/intent] all providers failed:', tried.join(' | '));
		return error(res, 502, 'parse_failed', 'could not understand that right now — try again or use the wallet form');
	}

	const intent = normalizeWalletIntent(rawIntent, { threeMint: THREE_MINT });

	// Resolve a withdraw/tip destination (.sol → address) server-side so the client
	// shows the real recipient in the read-back. An unresolved name becomes a clarify.
	if ((intent.action === 'tip' || intent.action === 'withdraw') && intent.destination) {
		const resolved = await resolveSolanaRecipient(intent.destination).catch(() => ({ address: null }));
		if (resolved.address) {
			intent.destination = resolved.address;
			intent.destination_label = resolved.resolved_from || null;
		} else if (!BASE58_RE.test(intent.destination)) {
			return json(res, 200, {
				data: {
					provider,
					intent: {
						action: 'clarify',
						confidence: intent.confidence,
						readback: '',
						clarifying_question: `I couldn't resolve "${intent.destination}" to a Solana address. What address or .sol name should I send to?`,
					},
				},
			});
		}
	}

	return json(res, 200, { data: { provider, intent } });
}

export default handleIntent;
