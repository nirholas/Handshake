// /api/agents/:id/copilot — the Conversational Trading Copilot.
//
// A tool-calling LLM that talks to the agent's owner (text or voice), answers
// with REAL live market + portfolio data, and PROPOSES trades the owner must
// confirm. The model never signs and never executes: read-only tools run
// server-side and feed grounded numbers back to the model; any state-changing
// intent (buy / sell / risk-limits) is returned to the client as a structured
// proposal. The client re-quotes it live and, only on the owner's confirmation,
// calls the existing guarded endpoints (POST /api/agents/:id/solana/trade,
// PUT /api/agents/:id/trade/limits) — which enforce the spend guards
// (api/_lib/agent-trade-guards.js), the rug/honeypot firewall
// (api/_lib/trade-firewall.js), and the custody audit (agent_custody_events).
// Conversation can never bypass a guard, the kill switch, or a spend cap.
//
//   POST /api/agents/:id/copilot   { messages:[{role,content}], network }  → SSE
//
// SSE events: `status` (phase), `tool` (a read-only tool ran), `proposal`
// (a confirm-before-execute trade/limits card), `chunk` (streamed narration
// tokens), `done` (final reply + proposals + citations), `error`.
//
// $THREE (FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump) is the only coin three.ws
// promotes. The copilot trades whatever mint the owner names at runtime — generic
// coin-agnostic plumbing — and never names or recommends any other token.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, method, error, readJson, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { PublicKey } from '@solana/web3.js';
import { solanaPublicConnection } from '../_lib/agent-pumpfun.js';
import { quoteTrade } from './solana-trade.js';
import { assessTradeSafety } from '../_lib/trade-firewall.js';
import { getSmartMoneyForMint } from '../_lib/smart-money.js';
import { getTradeLimits } from '../_lib/agent-trade-guards.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const netOf = (v) => (NETWORKS.has(v) ? v : 'mainnet');
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_ROUNDS = 4; // tool-loop rounds before we force a final answer
const MAX_MESSAGES = 24; // trailing turns we keep as context

// ── auth / ownership ──────────────────────────────────────────────────────────
async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// ── provider chain (free-first, OpenAI-compatible tool-calling + streaming) ────
// Mirrors the platform policy in api/_lib/llm.js: free platform keys lead, the
// paid OpenAI key is appended last as a backstop. Every provider here speaks the
// OpenAI chat-completions wire format (tools + streamed tool_calls), so one
// reader handles them all. Anthropic is intentionally omitted from the tool loop
// — the free OpenAI-compatible lanes are the primary path and OpenAI is the paid
// tail; nothing here depends on a paid key existing.
function providerChain() {
	const chain = [];
	if (env.GROQ_API_KEY) {
		chain.push({ name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: env.GROQ_API_KEY, model: 'llama-3.3-70b-versatile' });
	}
	const orKeys = [...new Set([env.OPENROUTER_API_KEY, ...(env.OPENROUTER_FALLBACK_KEYS || [])].filter(Boolean))];
	orKeys.forEach((key, i) => {
		chain.push({
			name: i === 0 ? 'openrouter' : `openrouter#${i + 1}`,
			url: 'https://openrouter.ai/api/v1/chat/completions',
			key,
			model: i === 0 ? 'meta-llama/llama-3.3-70b-instruct' : 'meta-llama/llama-3.3-70b-instruct:free',
			extraHeaders: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws copilot' },
		});
	});
	if (env.NVIDIA_API_KEY) {
		chain.push({ name: 'nvidia', url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: env.NVIDIA_API_KEY, model: 'meta/llama-3.3-70b-instruct' });
	}
	if (env.OPENAI_API_KEY) {
		chain.push({ name: 'openai', url: 'https://api.openai.com/v1/chat/completions', key: env.OPENAI_API_KEY, model: 'gpt-5.4-nano' });
	}
	return chain;
}

// Stream one chat-completion round. Emits assistant content deltas via
// onContent; accumulates streamed tool_calls. Resolves { content, toolCalls }.
// Throws on transport / non-2xx so the caller can fail over to the next provider.
async function streamRound(provider, { messages, tools, onContent }) {
	const body = {
		model: provider.model,
		max_tokens: 1024,
		temperature: 0.4,
		stream: true,
		messages,
	};
	if (Array.isArray(tools) && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
	const resp = await fetch(provider.url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.key}`, ...(provider.extraHeaders || {}) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(45_000),
	});
	if (!resp.ok || !resp.body) {
		const detail = await resp.text().catch(() => '');
		throw Object.assign(new Error(`${provider.name} ${resp.status}: ${detail.slice(0, 180)}`), { status: 502 });
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let content = '';
	const toolCalls = []; // index → { id, name, args }
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5).trim();
			if (payload === '[DONE]') { buf = ''; break; }
			let evt;
			try { evt = JSON.parse(payload); } catch { continue; }
			const delta = evt.choices?.[0]?.delta;
			if (!delta) continue;
			if (delta.content) { content += delta.content; onContent?.(delta.content); }
			if (Array.isArray(delta.tool_calls)) {
				for (const tc of delta.tool_calls) {
					const idx = tc.index ?? 0;
					if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || `call_${idx}`, name: '', args: '' };
					if (tc.id) toolCalls[idx].id = tc.id;
					if (tc.function?.name) toolCalls[idx].name = tc.function.name;
					if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
				}
			}
		}
	}
	return { content, toolCalls: toolCalls.filter(Boolean) };
}

// ── tool schema (OpenAI function-calling format) ───────────────────────────────
const TOOLS = [
	{
		type: 'function',
		function: {
			name: 'get_portfolio',
			description: "Read the agent wallet's live SOL balance, token holdings, and open sniper positions with unrealized PnL. Use to answer 'how's my position?' / 'what do I hold?'.",
			parameters: { type: 'object', properties: {}, additionalProperties: false },
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_coin_intel',
			description: 'Live intelligence for one coin mint: quality score, bundle/organic/concentration signals, risk flags, dev-sold, narrative, and graduation/rug outcome. Use before discussing or proposing a buy.',
			parameters: { type: 'object', properties: { mint: { type: 'string', description: 'base58 token mint address' } }, required: ['mint'], additionalProperties: false },
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_smart_money',
			description: 'Smart-money read for one coin: count of reputable wallets in it, a 0-100 smart-money score, and whether one funder cluster dominates (sybil). Use for "is smart money in this?".',
			parameters: { type: 'object', properties: { mint: { type: 'string' } }, required: ['mint'], additionalProperties: false },
		},
	},
	{
		type: 'function',
		function: {
			name: 'assess_safety',
			description: 'Run the rug/honeypot firewall on a prospective BUY: returns verdict (allow/warn/block), a 0-100 safety score, and plain-language reasons (mint authority, honeypot round-trip, concentration, price impact). Always run before proposing a buy.',
			parameters: { type: 'object', properties: { mint: { type: 'string' }, sol_amount: { type: 'number', description: 'SOL the owner would spend' } }, required: ['mint'], additionalProperties: false },
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_quote',
			description: 'Non-binding live quote: expected output and price impact for a buy (sol_amount) or sell (token_amount in UI units). Cite these exact numbers; never invent a quote.',
			parameters: {
				type: 'object',
				properties: {
					side: { type: 'string', enum: ['buy', 'sell'] },
					mint: { type: 'string' },
					sol_amount: { type: 'number', description: 'for buy: SOL to spend' },
					token_amount: { type: 'number', description: 'for sell: tokens to sell, in UI units' },
					slippage_bps: { type: 'integer', description: 'default 300 (3%)' },
				},
				required: ['side', 'mint'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_trade_limits',
			description: "Read the owner's discretionary trade guardrails: per-trade SOL cap, daily budget, max price impact, max slippage, and kill-switch state.",
			parameters: { type: 'object', properties: {}, additionalProperties: false },
		},
	},
	{
		type: 'function',
		function: {
			name: 'propose_buy',
			description: 'Surface a BUY proposal for the owner to confirm. Does NOT execute — it returns a confirm card grounded with a fresh quote + firewall verdict. Call this when the owner clearly wants to buy. Never claim a buy happened until the owner confirms it.',
			parameters: {
				type: 'object',
				properties: {
					mint: { type: 'string' },
					sol_amount: { type: 'number', description: 'SOL to spend (> 0)' },
					slippage_bps: { type: 'integer', description: 'default 300' },
					rationale: { type: 'string', description: 'one short sentence on why, citing real signals' },
				},
				required: ['mint', 'sol_amount'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'propose_sell',
			description: 'Surface a SELL proposal for the owner to confirm. Does NOT execute. Provide either token_pct (1-100 of the held balance) or token_amount (UI units).',
			parameters: {
				type: 'object',
				properties: {
					mint: { type: 'string' },
					token_pct: { type: 'number', description: 'percent of holding to sell, 1-100' },
					token_amount: { type: 'number', description: 'tokens to sell in UI units (alternative to token_pct)' },
					slippage_bps: { type: 'integer', description: 'default 300' },
					rationale: { type: 'string' },
				},
				required: ['mint'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'propose_set_limits',
			description: "Surface a risk-control change for the owner to confirm (does NOT apply until confirmed): per-trade SOL cap, daily SOL budget, max price-impact %, or the kill switch (kill_switch:true halts all trading). Use for 'cap my trades at 0.5 SOL', 'pause trading', 'set a daily budget'.",
			parameters: {
				type: 'object',
				properties: {
					per_trade_sol: { type: 'number' },
					daily_budget_sol: { type: 'number' },
					max_price_impact_pct: { type: 'number' },
					kill_switch: { type: 'boolean' },
					rationale: { type: 'string' },
				},
				additionalProperties: false,
			},
		},
	},
];

// ── server-side tool execution (read-only) ─────────────────────────────────────
function num(v) { return v == null || !Number.isFinite(Number(v)) ? null : Number(v); }

async function loadIntel(mint, network) {
	const [row] = await sql`
		SELECT i.mint, i.symbol, i.name, i.quality_score, i.bundle_score, i.organic_score,
		       i.snipe_ratio, i.concentration_top10, i.fresh_wallet_ratio, i.risk_flags,
		       i.category, i.narrative, i.dev_sold, i.unique_buyers, i.observation_seconds,
		       o.outcome, o.ath_multiple
		FROM pump_coin_intel i
		LEFT JOIN pump_coin_outcomes o ON o.mint = i.mint AND o.network = i.network
		WHERE i.mint = ${mint} AND i.network = ${network}
		LIMIT 1`.catch(() => []);
	if (!row) return { mint, found: false, note: 'No intelligence on this mint yet — the engine only fingerprints pump.fun launches it has observed.' };
	return {
		mint, found: true, symbol: row.symbol, name: row.name,
		quality_score: num(row.quality_score),
		bundle_score: num(row.bundle_score), organic_score: num(row.organic_score),
		snipe_ratio: num(row.snipe_ratio), concentration_top10: num(row.concentration_top10),
		fresh_wallet_ratio: num(row.fresh_wallet_ratio), risk_flags: row.risk_flags || [],
		category: row.category, narrative: row.narrative, dev_sold: row.dev_sold,
		unique_buyers: row.unique_buyers, observation_seconds: row.observation_seconds,
		outcome: row.outcome || null, ath_multiple: num(row.ath_multiple),
	};
}

async function loadPortfolio(agentId, address, network) {
	const out = { network, wallet: address, sol_balance: null, holdings: [], open_positions: [] };
	if (!address) return out;
	const conn = solanaPublicConnection(network);
	const ownerPk = new PublicKey(address);
	try {
		const lamports = await conn.getBalance(ownerPk);
		out.sol_balance = Number(lamports) / LAMPORTS_PER_SOL;
	} catch { /* RPC hiccup — report null, copilot says balance unavailable */ }
	try {
		const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
		const TOKEN22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
		const accounts = [];
		for (const prog of [TOKEN, TOKEN22]) {
			const r = await conn.getParsedTokenAccountsByOwner(ownerPk, { programId: prog }).catch(() => null);
			if (r?.value) accounts.push(...r.value);
		}
		out.holdings = accounts
			.map((a) => {
				const info = a.account.data.parsed?.info;
				const amt = info?.tokenAmount;
				return amt && Number(amt.uiAmount) > 0
					? { mint: info.mint, ui_amount: Number(amt.uiAmount), decimals: amt.decimals }
					: null;
			})
			.filter(Boolean)
			.slice(0, 30);
	} catch { /* token read failed — holdings stay empty */ }
	try {
		const rows = await sql`
			SELECT mint, symbol, status, entry_quote_lamports, last_value_lamports,
			       realized_pnl_lamports, realized_pnl_pct, exit_reason
			FROM agent_sniper_positions
			WHERE agent_id = ${agentId} AND network = ${network} AND status = 'open'
			ORDER BY opened_at DESC LIMIT 20`;
		out.open_positions = rows.map((p) => ({
			mint: p.mint, symbol: p.symbol,
			entry_sol: num(p.entry_quote_lamports) != null ? num(p.entry_quote_lamports) / LAMPORTS_PER_SOL : null,
			current_sol: num(p.last_value_lamports) != null ? num(p.last_value_lamports) / LAMPORTS_PER_SOL : null,
			unrealized_pnl_pct: num(p.realized_pnl_pct),
		}));
	} catch { /* positions table read failed — leave empty */ }
	return out;
}

async function runQuote({ side, mint, solAmount, tokenAmount, slippageBps, network }) {
	const conn = solanaPublicConnection(network);
	const mintPk = new PublicKey(mint);
	let tokenAmountRaw;
	if (side === 'sell') {
		// Convert UI tokens → raw using on-chain decimals.
		let decimals = 6;
		try {
			const info = await conn.getParsedAccountInfo(mintPk);
			const d = info?.value?.data?.parsed?.info?.decimals;
			if (Number.isInteger(d)) decimals = d;
		} catch { /* default 6 */ }
		tokenAmountRaw = BigInt(Math.floor(Number(tokenAmount || 0) * 10 ** decimals)).toString();
	}
	const q = await quoteTrade({ conn, side, mintPk, mintStr: mint, network, solAmount, tokenAmountRaw, slippageBps });
	return {
		side, mint, venue: q.venue, price_impact_pct: num(q.priceImpactPct),
		in_asset: q.inAsset, in_amount: num(q.inAmount),
		out_asset: q.outAsset, expected_out: num(q.outUi),
		min_received: num(q.minOutUi),
	};
}

// Best-effort coin label (symbol/name) for proposal cards.
async function coinLabel(mint, network) {
	const intel = await loadIntel(mint, network).catch(() => null);
	if (intel?.found && (intel.symbol || intel.name)) return { symbol: intel.symbol || null, name: intel.name || null };
	return { symbol: null, name: null };
}

// ── system prompt ──────────────────────────────────────────────────────────────
function buildSystemPrompt({ agentName, persona, network }) {
	const base = (persona || '').trim();
	return [
		base ? `You speak in character as ${agentName}. Persona:\n${base}\n` : `You are ${agentName}, a trading copilot.`,
		`You are the in-world CONVERSATIONAL TRADING COPILOT for the three.ws agent "${agentName}" and its self-custodied Solana wallet (network: ${network}).`,
		`Your job: help the owner snipe, trade, and manage risk by talking. You have real tools — use them; never invent numbers, prices, balances, safety verdicts, or smart-money counts. If a tool returns no data, say so plainly.`,
		`RULES:`,
		`• ACT, don't ask. The read-only tools (get_portfolio, get_coin_intel, get_smart_money, assess_safety, get_quote, get_trade_limits) are free and instant — CALL them immediately to answer. NEVER ask the owner for permission to read their own wallet or check a coin ("would you like me to check…?" is forbidden). If they ask "how's my portfolio?", call get_portfolio right away and answer with the real numbers. Only the propose_* actions need confirmation.`,
		`• You NEVER execute or sign anything. To buy, sell, or change risk limits you MUST call the matching propose_* tool, which surfaces a confirm card. The owner confirms; a guarded server endpoint then enforces spend caps, the firewall, and the kill switch and signs. Never say a trade is done — say you've prepared it for confirmation.`,
		`• Before proposing OR recommending a buy, ground it: call assess_safety (firewall) and get_quote, and mention the safety verdict and price impact. If the firewall verdict is "block", refuse the buy and explain why.`,
		`• Keep answers tight and conversational (2-5 sentences) — this may be read aloud. Light markdown is fine (bold, short bullet lists) but no tables or code blocks. The UI already shows the raw numbers as cards, so narrate the takeaway — don't re-list every figure.`,
		`• The only coin three.ws promotes is $THREE. You may trade any mint the owner explicitly names (that is their call), but never suggest, shill, or name a specific other token on your own initiative.`,
		`• When the owner is vague ("buy the safe one"), ask one brief clarifying question or have them paste a mint — do not guess a mint address.`,
	].join('\n');
}

// ── handler ─────────────────────────────────────────────────────────────────────
export default async function handler(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in to talk to this copilot');

	const rl = await limits.tradePerUser(auth.userId).catch(() => ({ success: true }));
	if (rl && rl.success === false) return rateLimited(res, rl);

	const [row] = await sql`SELECT id, user_id, name, persona_prompt, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'only the owner can use this copilot');

	const meta = row.meta || {};
	const address = meta.solana_address || null;
	const body = await readJson(req).catch(() => null);
	const network = netOf(body?.network);
	const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
	const history = rawMessages
		.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
		.slice(-MAX_MESSAGES)
		.map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
	if (!history.length || history[history.length - 1].role !== 'user') {
		return error(res, 422, 'no_message', 'send at least one user message');
	}

	const chain = providerChain();
	if (!chain.length) return error(res, 503, 'llm_unavailable', 'No LLM provider configured. Set GROQ_API_KEY, OPENROUTER_API_KEY, or NVIDIA_API_KEY.');

	// SSE open.
	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();
	let active = true;
	req.on('close', () => { active = false; });
	const send = (event, data) => { if (active) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
	// Keepalive: a tool-loop round can sit silent for tens of seconds waiting on a
	// slow provider (or a mid-round failover to the next one). Emit an SSE comment
	// every 15s so the client's stall watchdog can stay tight and only fire on a
	// genuinely dead connection, never on a model that's just thinking.
	const heartbeat = setInterval(() => { if (active) res.write(': ping\n\n'); }, 15_000);

	const messages = [{ role: 'system', content: buildSystemPrompt({ agentName: row.name || 'Agent', persona: row.persona_prompt, network }) }, ...history];
	const proposals = [];
	const citations = [];
	let finalText = '';

	// Read-only tools are pure within a turn — the wallet/intel/quote a round sees
	// won't change between the model's rounds. Memoize by (name, args) so when the
	// model re-issues an identical read (a common small-model tic that otherwise
	// burns a whole tool-loop round and paints a duplicate "Portfolio: …" line in
	// the UI) we serve it from cache: no second RPC, no duplicate `tool` event, and
	// the loop can tell the round made no new progress and cut to a final answer.
	const readCache = new Map();

	// One read-only tool execution → returns a compact result for the model + a UI summary.
	async function execReadTool(name, args) {
		if (name === 'get_portfolio') {
			const p = await loadPortfolio(id, address, network);
			citations.push({ kind: 'portfolio', sol: p.sol_balance, holdings: p.holdings.length, positions: p.open_positions.length });
			return {
				result: p,
				summary: address ? `Portfolio: ${p.sol_balance != null ? p.sol_balance.toFixed(4) + ' SOL' : 'balance unavailable'}, ${p.holdings.length} token(s), ${p.open_positions.length} open position(s)` : 'No wallet provisioned yet',
				card: { kind: 'portfolio', wallet: p.wallet, sol_balance: p.sol_balance, holdings: p.holdings, open_positions: p.open_positions, network },
			};
		}
		if (name === 'get_coin_intel') {
			const intel = await loadIntel(args.mint, network);
			citations.push({ kind: 'intel', mint: args.mint, quality: intel.quality_score ?? null });
			return {
				result: intel,
				summary: intel.found ? `Intel ${intel.symbol || ''}: quality ${intel.quality_score ?? '—'}/100, ${(intel.risk_flags || []).length} risk flag(s)${intel.outcome ? `, outcome ${intel.outcome}` : ''}` : 'No intel on this mint',
				card: { kind: 'intel', ...intel },
			};
		}
		if (name === 'get_smart_money') {
			const sm = await getSmartMoneyForMint(args.mint, network);
			citations.push({ kind: 'smart_money', mint: args.mint, score: sm.smart_money_score, count: sm.count });
			return {
				result: sm,
				summary: `Smart money: ${sm.count} reputable wallet(s), score ${sm.smart_money_score}/100${sm.sybil_flag ? ' (sybil-dominated)' : ''}`,
				card: { kind: 'smart_money', mint: args.mint, count: sm.count, score: sm.smart_money_score, sybil: !!sm.sybil_flag },
			};
		}
		if (name === 'assess_safety') {
			const conn = solanaPublicConnection(network);
			const quoteLamports = args.sol_amount > 0 ? BigInt(Math.floor(Number(args.sol_amount) * LAMPORTS_PER_SOL)) : null;
			const a = await assessTradeSafety({ network, mint: args.mint, side: 'buy', payer: address, quoteAmount: quoteLamports, connection: conn });
			citations.push({ kind: 'safety', mint: args.mint, verdict: a.verdict, score: a.score });
			return {
				result: { verdict: a.verdict, score: a.score, reasons: a.reasons, simulated: a.simulated },
				summary: `Firewall: ${a.verdict.toUpperCase()} (${a.score}/100)${a.reasons?.[0] ? ' — ' + a.reasons[0] : ''}`,
				card: { kind: 'safety', mint: args.mint, verdict: a.verdict, score: a.score, reasons: a.reasons || [], simulated: !!a.simulated },
			};
		}
		if (name === 'get_quote') {
			const q = await runQuote({ side: args.side, mint: args.mint, solAmount: args.sol_amount, tokenAmount: args.token_amount, slippageBps: args.slippage_bps || 300, network });
			citations.push({ kind: 'quote', mint: args.mint, side: args.side, impact: q.price_impact_pct });
			return {
				result: q,
				summary: `Quote ${args.side}: ${q.expected_out != null ? q.expected_out.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'} ${q.out_asset}, ${q.price_impact_pct != null ? q.price_impact_pct.toFixed(2) + '% impact' : 'impact n/a'}`,
				card: { kind: 'quote', mint: args.mint, side: q.side, in_asset: q.in_asset, in_amount: q.in_amount, out_asset: q.out_asset, expected_out: q.expected_out, price_impact_pct: q.price_impact_pct, min_received: q.min_received },
			};
		}
		if (name === 'get_trade_limits') {
			const lim = getTradeLimits(meta);
			return {
				result: lim,
				summary: `Limits: per-trade ${lim.per_trade_sol ?? '∞'} SOL, daily ${lim.daily_budget_sol ?? '∞'} SOL, kill switch ${lim.kill_switch ? 'ON' : 'off'}`,
				card: { kind: 'limits', ...lim },
			};
		}
		return { result: { error: 'unknown_tool' }, summary: 'unknown tool' };
	}

	// A propose_* tool → grounded proposal card, never executed here.
	async function execProposeTool(name, args) {
		if (name === 'propose_buy') {
			if (!BASE58_RE.test(args.mint || '')) return { result: { error: 'invalid_mint' }, summary: 'invalid mint' };
			const slippageBps = Math.max(0, Math.min(5000, Math.round(args.slippage_bps || 300)));
			const [quote, safety, label] = await Promise.all([
				runQuote({ side: 'buy', mint: args.mint, solAmount: args.sol_amount, slippageBps, network }).catch((e) => ({ error: e?.message || 'quote_failed' })),
				assessTradeSafety({ network, mint: args.mint, side: 'buy', payer: address, quoteAmount: BigInt(Math.floor(Number(args.sol_amount) * LAMPORTS_PER_SOL)), connection: solanaPublicConnection(network) })
					.then((a) => ({ verdict: a.verdict, score: a.score, reasons: a.reasons, simulated: a.simulated }))
					.catch(() => null),
				coinLabel(args.mint, network),
			]);
			const proposal = { id: `p${proposals.length + 1}`, kind: 'buy', mint: args.mint, coin: label, sol_amount: Number(args.sol_amount), slippage_bps: slippageBps, network, quote, safety, rationale: args.rationale || null };
			proposals.push(proposal);
			send('proposal', proposal);
			const blocked = safety?.verdict === 'block';
			return { result: { surfaced: true, blocked, safety_verdict: safety?.verdict, price_impact_pct: quote?.price_impact_pct }, summary: `Buy proposal surfaced (awaiting confirmation). Firewall ${safety?.verdict || 'n/a'}.${blocked ? ' BLOCKED — do not encourage this trade.' : ''}` };
		}
		if (name === 'propose_sell') {
			if (!BASE58_RE.test(args.mint || '')) return { result: { error: 'invalid_mint' }, summary: 'invalid mint' };
			const slippageBps = Math.max(0, Math.min(5000, Math.round(args.slippage_bps || 300)));
			// Resolve the held balance so a percent maps to a concrete UI amount.
			const port = await loadPortfolio(id, address, network).catch(() => null);
			const held = port?.holdings?.find((h) => h.mint === args.mint) || null;
			let tokenAmount = num(args.token_amount);
			let tokenPct = num(args.token_pct);
			if (tokenAmount == null && tokenPct != null && held) tokenAmount = (held.ui_amount * Math.max(1, Math.min(100, tokenPct))) / 100;
			if (tokenAmount == null && held) tokenAmount = held.ui_amount; // default: sell all
			if (!(tokenAmount > 0)) return { result: { error: 'no_holding' }, summary: 'owner does not hold this coin' };
			const [quote, label] = await Promise.all([
				runQuote({ side: 'sell', mint: args.mint, tokenAmount, slippageBps, network }).catch((e) => ({ error: e?.message || 'quote_failed' })),
				coinLabel(args.mint, network),
			]);
			const proposal = { id: `p${proposals.length + 1}`, kind: 'sell', mint: args.mint, coin: label, token_amount: tokenAmount, token_pct: tokenPct ?? null, decimals: held?.decimals ?? 6, slippage_bps: slippageBps, network, quote, rationale: args.rationale || null };
			proposals.push(proposal);
			send('proposal', proposal);
			return { result: { surfaced: true, expected_sol: quote?.expected_out }, summary: `Sell proposal surfaced (awaiting confirmation): ~${quote?.expected_out != null ? Number(quote.expected_out).toFixed(4) : '—'} SOL.` };
		}
		if (name === 'propose_set_limits') {
			const cur = getTradeLimits(meta);
			const changes = {};
			for (const k of ['per_trade_sol', 'daily_budget_sol', 'max_price_impact_pct']) {
				if (num(args[k]) != null) changes[k] = Number(args[k]);
			}
			if (typeof args.kill_switch === 'boolean') changes.kill_switch = args.kill_switch;
			if (!Object.keys(changes).length) return { result: { error: 'no_change' }, summary: 'no limit change specified' };
			const proposal = { id: `p${proposals.length + 1}`, kind: 'limits', network, current: cur, changes, rationale: args.rationale || null };
			proposals.push(proposal);
			send('proposal', proposal);
			return { result: { surfaced: true }, summary: 'Risk-limit change surfaced (awaiting confirmation).' };
		}
		return { result: { error: 'unknown_tool' }, summary: 'unknown tool' };
	}

	// ── tool loop ───────────────────────────────────────────────────────────────
	try {
		let answered = false;
		for (let round = 0; round < MAX_ROUNDS && active && !answered; round++) {
			send('status', { phase: round === 0 ? 'thinking' : 'continuing' });
			// Pick the first provider that yields a round; once content has been
			// streamed to the client we can't fail over, so stream-failover only
			// applies before any byte for THIS round was emitted.
			let roundOut = null;
			let lastErr = null;
			for (const provider of chain) {
				let emitted = false;
				try {
					roundOut = await streamRound(provider, {
						messages,
						tools: TOOLS,
						onContent: (t) => { emitted = true; finalText += t; send('chunk', { text: t }); },
					});
					break;
				} catch (e) {
					lastErr = e;
					if (emitted) { roundOut = { content: '', toolCalls: [] }; break; } // mid-stream failure; stop
				}
			}
			if (!roundOut) throw lastErr || new Error('all providers failed');

			if (!roundOut.toolCalls.length) { answered = true; break; }

			// Record the assistant's tool-call turn, then resolve each call.
			messages.push({
				role: 'assistant',
				content: roundOut.content || null,
				tool_calls: roundOut.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args || '{}' } })),
			});
			// A round is only "progress" if at least one call surfaced something new —
			// a fresh read, or a proposal. If every call this round is a repeat of a
			// read the model already ran this turn, it's spinning: feed the cached
			// results back (OpenAI requires a tool result per tool_call) but break out
			// afterward so the finalize step turns what we have into a real answer
			// instead of stalling the owner behind more identical "Analyzing…" rounds.
			let progressed = false;
			for (const tc of roundOut.toolCalls) {
				let args = {};
				try { args = tc.args ? JSON.parse(tc.args) : {}; } catch { args = {}; }
				const isPropose = tc.name.startsWith('propose_');
				let outcome;
				let cached = false;
				try {
					if (isPropose) {
						outcome = await execProposeTool(tc.name, args);
						progressed = true;
					} else {
						const key = `${tc.name}:${JSON.stringify(args)}`;
						if (readCache.has(key)) {
							outcome = readCache.get(key);
							cached = true;
						} else {
							outcome = await execReadTool(tc.name, args);
							readCache.set(key, outcome);
							progressed = true;
						}
					}
				} catch (e) {
					outcome = { result: { error: e?.message || 'tool_failed' }, summary: `Tool ${tc.name} failed: ${e?.message || 'error'}` };
					progressed = true; // a genuine failure is new information, not a spin
				}
				// Surface read activity once per distinct read — never re-paint a cached repeat.
				if (!isPropose && !cached) send('tool', { name: tc.name, summary: outcome.summary, data: outcome.card || null });
				messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(outcome.result).slice(0, 6000) });
			}
			if (!progressed) break; // model looped on data it already has — go answer.
		}

		// If the loop hit its round cap mid-tool without a natural answer, ask for a
		// final plain-language wrap-up (no tools) so the user always gets a reply.
		if (!finalText.trim() && active) {
			send('status', { phase: 'finalizing' });
			for (const provider of chain) {
				try {
					const out = await streamRound(provider, {
						messages: [...messages, { role: 'user', content: 'Briefly summarize what you found and what I should do next. Plain language, 2-4 sentences.' }],
						tools: [],
						onContent: (t) => { finalText += t; send('chunk', { text: t }); },
					});
					if (out) break;
				} catch { /* try next provider */ }
			}
		}

		send('done', { reply: finalText.trim(), proposals, citations });
	} catch (e) {
		send('error', { code: e?.code || 'copilot_error', message: e?.message || 'The copilot hit an error. Try again.' });
	} finally {
		clearInterval(heartbeat);
		if (active) res.end();
	}
}
