/**
 * Wallet Intents API — owner-only control surface for the programmable,
 * conversational money layer. Routed from api/agents/[id].js as
 * /api/agents/:id/intents.
 *
 *   GET    /api/agents/:id/intents              → the owner's intents + live summary
 *   POST   /api/agents/:id/intents/compile      → plain-language rule → validated structured intent (preview; never arms)
 *   POST   /api/agents/:id/intents              → arm a validated intent (real)
 *   POST   /api/agents/:id/intents/run          → owner "test this rule now" (dry-run or real) { intent_id, dry_run }
 *   POST   /api/agents/:id/intents/copilot       → conversational "how am I doing?" over real holdings + custody P&L
 *   PUT    /api/agents/:id/intents/:intentId     → enable / disable / edit / publish
 *   DELETE /api/agents/:id/intents/:intentId     → remove
 *
 * Every write is owner-only (server-side) and CSRF-protected. Executing paths act
 * ONLY on the agent's own wallet, are clamped to the agent's spend policy at
 * execution time, and write an audited custody event stamped with the intent_id.
 * A visitor (or logged-out caller) can never read, create, arm, or fire an intent.
 */

import { cors, json, method, error, readJson, rateLimited, serverError } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import { loadUserProviderKeys } from '../_lib/provider-keys.js';
import { getSpendLimits, getTradeLimits } from '../_lib/agent-trade-guards.js';
import { getSolanaAddressBalances } from '../_lib/agent-wallet.js';
import { getBalances } from '../_lib/balances.js';
import { solUsdPrice } from '../_lib/avatar-wallet.js';
import {
	listIntents,
	getIntent,
	createIntent,
	updateIntent,
	deleteIntent,
	runIntentNow,
	compileIntentFromText,
	normalizeIntent,
	describeIntent,
} from '../_lib/wallet-intents.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

async function loadOwned(req, res, id) {
	const auth = await resolveAuth(req);
	if (!auth) {
		error(res, 401, 'unauthorized', 'sign in to manage this agent’s wallet intents');
		return { error: true };
	}
	const [row] = await sql`SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) { error(res, 404, 'not_found', 'agent not found'); return { error: true }; }
	if (row.user_id !== auth.userId) { error(res, 403, 'forbidden', 'only the owner can manage wallet intents'); return { error: true }; }
	return { auth, row, meta: { ...(row.meta || {}) } };
}

function netOf(req) {
	const url = new URL(req.url, 'http://x');
	return url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
}

// readJson resolves whatever valid JSON the caller sent, which includes `null`,
// a bare string, and a number. Every handler below then reads a property off it
// (`body.text`, `body.intent`, `'enabled' in body`), which throws a TypeError on
// a non-object and surfaces as a 500 for what is really malformed input. Funnel
// the body through here so a scalar degrades to an empty object and the
// handler's own validation returns its normal 400.
async function readJsonObject(req, res) {
	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid request body');
		return null;
	}
	return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

export default async function handler(req, res, id, action) {
	if (cors(req, res, { methods: 'GET,POST,PUT,DELETE,OPTIONS', credentials: true })) return;

	if (action === 'compile') return handleCompile(req, res, id);
	if (action === 'run') return handleRun(req, res, id);
	if (action === 'copilot') return handleCopilot(req, res, id);
	if (action && UUID_RE.test(action)) {
		if (req.method === 'PUT') return handleUpdate(req, res, id, action);
		if (req.method === 'DELETE') return handleDelete(req, res, id, action);
		if (req.method === 'GET') return handleGetOne(req, res, id, action);
		return error(res, 405, 'method_not_allowed', 'use PUT, DELETE, or GET on an intent');
	}
	if (action) return error(res, 404, 'not_found', 'unknown intents sub-resource');

	if (req.method === 'GET') return handleList(req, res, id);
	if (req.method === 'POST') return handleCreate(req, res, id);
	return method(req, res, ['GET', 'POST']) ? error(res, 405, 'method_not_allowed', 'use GET or POST') : undefined;
}

// GET — the owner's intents + a live summary (balance, today's & lifetime impact).
async function handleList(req, res, id) {
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	const rl = await limits.walletRead(owned.auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	const network = netOf(req);
	const intents = await listIntents(id);
	const spendLimits = getSpendLimits(owned.meta);

	let balanceSol = null;
	try { balanceSol = Number((await getSolanaAddressBalances(owned.meta.solana_address, network))?.sol ?? null); }
	catch { balanceSol = null; }

	const lifetimeUsd = intents.reduce((a, i) => a + (i.stats?.spent_usd || 0), 0);
	const fires = intents.reduce((a, i) => a + (i.stats?.fire_count || 0), 0);

	return json(res, 200, {
		data: {
			intents,
			summary: {
				count: intents.length,
				enabled: intents.filter((i) => i.enabled).length,
				lifetime_usd: lifetimeUsd,
				lifetime_fires: fires,
				balance_sol: balanceSol,
				frozen: !!spendLimits.frozen,
				spend_limits: { per_tx_usd: spendLimits.per_tx_usd, daily_usd: spendLimits.daily_usd },
			},
		},
	});
}

async function handleGetOne(req, res, id, intentId) {
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	// Same meter as the collection read: this is the one owner-scoped read that
	// was unmetered, so a loop over intent ids could out-run the list endpoint.
	const rl = await limits.walletRead(owned.auth.userId);
	if (!rl.success) return rateLimited(res, rl);
	const intent = await getIntent(id, intentId);
	if (!intent) return error(res, 404, 'not_found', 'intent not found');
	return json(res, 200, { data: { intent } });
}

// Shared: the live context the compiler/dry-run needs (balance, holdings, caps).
async function compileContext(req, owned, network) {
	let balanceSol = null;
	let holdings = [];
	try {
		const bal = await getSolanaAddressBalances(owned.meta.solana_address, network);
		balanceSol = Number(bal?.sol ?? null);
	} catch { /* unknown */ }
	// The compiler prompt lists the wallet's real tokens so a rule like "sell half
	// my $THREE" grounds against something the agent actually holds. This used to
	// be declared and never filled, so every compile claimed "Tokens held: none
	// detected." even for a funded wallet. Mainnet only: the shared cached
	// getBalances path (Helius DAS, then public RPC) indexes mainnet mints.
	if (network === 'mainnet' && owned.meta.solana_address) {
		try {
			const balances = await getBalances({ chain: 'solana', address: owned.meta.solana_address });
			holdings = (balances?.tokens || [])
				.filter((t) => t.mint && Number(t.amount) > 0)
				.map((t) => ({ mint: t.mint, symbol: t.symbol || null, ui_amount: t.amount }));
		} catch { /* holdings unavailable, the prompt falls back to "none detected" */ }
	}
	let userKeys = {};
	try {
		const [u] = await sql`SELECT provider_keys FROM users WHERE id = ${owned.auth.userId}`;
		userKeys = await loadUserProviderKeys(u?.provider_keys);
	} catch { userKeys = {}; }
	return {
		agentName: owned.row.name,
		network,
		balanceSol,
		holdings,
		limits: getSpendLimits(owned.meta),
		tradeLimits: getTradeLimits(owned.meta),
		anthropicKey: userKeys.anthropic,
		grokKey: userKeys.grok,
		openrouterKey: userKeys.openrouter,
	};
}

// POST /compile — plain-language → structured intent. Preview only; never arms.
async function handleCompile(req, res, id) {
	if (!method(req, res, ['POST'])) return;
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	const rl = await limits.chatUser(owned.auth.userId);
	if (!rl.success) return rateLimited(res, rl, 'slow down — too many compile requests');

	const body = await readJsonObject(req, res);
	if (!body) return;
	const text = typeof body.text === 'string' ? body.text : '';
	if (!text.trim()) return error(res, 400, 'validation_error', 'describe a rule to compile');

	const network = netOf(req);
	const ctx = await compileContext(req, owned, network);
	ctx.history = Array.isArray(body.history) ? body.history : [];

	let compiled;
	try { compiled = await compileIntentFromText(text, ctx); }
	catch (e) { return serverError(res, 500, 'compile_failed', e); }

	if (!compiled.ok) {
		const status = compiled.error === 'unavailable' ? 503 : compiled.error === 'clarify' ? 200 : 422;
		return json(res, status, { data: { ok: false, error: compiled.error, message: compiled.message, clarify: compiled.clarify || null, provider: compiled.provider || null } });
	}

	// Concrete dry-run preview alongside the compiled intent.
	const sim = await simulate(compiled.intent, owned, network).catch(() => null);
	return json(res, 200, { data: { ok: true, intent: compiled.intent, readback: describeIntent(compiled.intent), simulation: sim, provider: compiled.provider } });
}

// Build a concrete "on a sample event, this does X; remaining budget Y" preview.
async function simulate(intent, owned, network) {
	const a = intent.action;
	let balanceSol = null;
	try { balanceSol = Number((await getSolanaAddressBalances(owned.meta.solana_address, network))?.sol ?? null); } catch { /* */ }
	let price = null;
	try { price = await solUsdPrice(); } catch { /* */ }

	const lines = [];
	if (intent.trigger.type === 'on_tip_received' && a.pct != null) {
		const sampleSol = Math.max(intent.trigger.min_sol || 0.2, 0.2);
		const back = sampleSol * (a.pct / 100);
		lines.push(`On a ${sampleSol} SOL tip, this sends back ${back.toFixed(3)} SOL${a.to_tipper ? ' to the tipper' : ''}.`);
	} else if (a.amount_sol != null) {
		lines.push(`Each fire moves ${a.amount_sol} SOL${a.destination_label ? ` to ${a.destination_label}` : ''}${price ? ` (~$${(a.amount_sol * price).toFixed(2)})` : ''}.`);
	} else if (a.above_sol != null && balanceSol != null) {
		const over = Math.max(0, balanceSol - a.above_sol);
		lines.push(`At your current ${balanceSol.toFixed(3)} SOL, this would withdraw ${over.toFixed(3)} SOL above the ${a.above_sol} SOL floor.`);
	} else if (a.pct != null) {
		lines.push(`Each fire moves ${a.pct}% of ${a.of || 'income'}${a.destination_label ? ` to ${a.destination_label}` : ''}.`);
	} else if (a.type === 'freeze') {
		lines.push(`When balance drops below ${intent.trigger.threshold_sol} SOL, all spending freezes and you're notified.`);
	} else if (a.type === 'notify') {
		lines.push('This sends you a notification — it never moves funds.');
	}
	const lim = intent.limits || {};
	if (lim.daily_usd != null) lines.push(`Daily budget: $${lim.daily_usd}.`);
	if (lim.per_action_usd != null) lines.push(`Per-action cap: $${lim.per_action_usd}.`);
	return { balance_sol: balanceSol, lines };
}

// POST / — arm a validated intent. Re-validates server-side; ownership + CSRF gated.
async function handleCreate(req, res, id) {
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;

	const body = await readJsonObject(req, res);
	if (!body) return;
	if (!body.intent || typeof body.intent !== 'object') return error(res, 400, 'validation_error', 'an intent object is required');

	const norm = normalizeIntent(body.intent);
	if (!norm.ok) return error(res, 422, norm.error || 'invalid_intent', norm.message || 'the intent could not be validated');
	// Preserve a resolved destination + tip-back flag the compiler already grounded.
	if (body.intent.action) {
		const src = body.intent.action;
		if (src.destination && !norm.intent.action.destination) norm.intent.action.destination = src.destination;
		if (src.destination_label) norm.intent.action.destination_label = src.destination_label;
		if (src.to_tipper) norm.intent.action.to_tipper = true;
		if (src.mint && !norm.intent.action.mint) norm.intent.action.mint = src.mint;
	}

	const network = netOf(req);
	try {
		const intent = await createIntent(id, owned.auth.userId, norm.intent, {
			network,
			sourceText: typeof body.source_text === 'string' ? body.source_text.slice(0, 1000) : null,
			publicTrait: body.public_trait === true,
		});
		return json(res, 201, { data: { intent } });
	} catch (e) {
		return serverError(res, 500, 'create_failed', e);
	}
}

// PUT /:intentId — enable/disable/edit/publish.
async function handleUpdate(req, res, id, intentId) {
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;

	const body = await readJsonObject(req, res);
	if (!body) return;

	const patch = {};
	if ('enabled' in body) patch.enabled = body.enabled === true;
	if ('public_trait' in body) patch.public_trait = body.public_trait === true;
	if ('title' in body) patch.title = body.title;
	if ('intent' in body) patch.intent = body.intent;

	try {
		const result = await updateIntent(id, owned.auth.userId, intentId, patch);
		if (!result) return error(res, 404, 'not_found', 'intent not found');
		if (result.error) return error(res, 422, result.error, result.message);
		return json(res, 200, { data: { intent: result } });
	} catch (e) {
		return serverError(res, 500, 'update_failed', e);
	}
}

async function handleDelete(req, res, id, intentId) {
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	try {
		const ok = await deleteIntent(id, owned.auth.userId, intentId);
		if (!ok) return error(res, 404, 'not_found', 'intent not found');
		return json(res, 200, { data: { deleted: true } });
	} catch (e) {
		return serverError(res, 500, 'delete_failed', e);
	}
}

// POST /run — owner "test this rule now" (honors freeze, spend policy, caps).
async function handleRun(req, res, id) {
	if (!method(req, res, ['POST'])) return;
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	const rl = await limits.walletRead(owned.auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	let body = {};
	try {
		const raw = await readJson(req);
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) body = raw;
	} catch { body = {}; }
	const intentId = String(body.intent_id || '');
	if (!UUID_RE.test(intentId)) return error(res, 400, 'validation_error', 'intent_id is required');
	const dryRun = body.dry_run !== false; // default to a safe simulation

	try {
		const result = await runIntentNow({ agentId: id, userId: owned.auth.userId, intentId, network: netOf(req), dryRun });
		return json(res, 200, { data: result });
	} catch (e) {
		return serverError(res, 500, 'run_failed', e);
	}
}

// POST /copilot — conversational "how am I doing?" over REAL holdings + custody P&L.
// Funds never move here; the copilot only reads + explains. Owner-only.
async function handleCopilot(req, res, id) {
	if (!method(req, res, ['POST'])) return;
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	const rl = await limits.chatUser(owned.auth.userId);
	if (!rl.success) return rateLimited(res, rl, 'slow down');

	const body = await readJsonObject(req, res);
	if (!body) return;
	const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
	if (!message) return error(res, 400, 'validation_error', 'ask a question');

	const network = netOf(req);

	// Real numbers first — the copilot never guesses a balance or a P&L.
	let balanceSol = null;
	try { balanceSol = Number((await getSolanaAddressBalances(owned.meta.solana_address, network))?.sol ?? null); } catch { /* */ }
	const [agg] = await sql`
		SELECT
			COALESCE(SUM(usd) FILTER (WHERE event_type = 'tip'), 0)::float8 AS tip_usd,
			COALESCE(SUM(usd) FILTER (WHERE event_type = 'spend'), 0)::float8 AS spend_usd,
			COUNT(*) FILTER (WHERE meta->>'intent_id' IS NOT NULL) AS intent_events
		FROM agent_custody_events
		WHERE agent_id = ${id} AND network = ${network} AND created_at > now() - interval '30 days'
	`;
	const intents = await listIntents(id);
	const facts = {
		balance_sol: balanceSol,
		tips_30d_usd: Number(agg?.tip_usd || 0),
		spend_30d_usd: Number(agg?.spend_usd || 0),
		net_30d_usd: Number(agg?.tip_usd || 0) - Number(agg?.spend_usd || 0),
		active_intents: intents.filter((i) => i.enabled).length,
		intent_fires: intents.reduce((a, i) => a + (i.stats?.fire_count || 0), 0),
		intent_moved_usd: intents.reduce((a, i) => a + (i.stats?.spent_usd || 0), 0),
	};

	const factual = `Balance: ${facts.balance_sol == null ? 'unknown' : facts.balance_sol.toFixed(3) + ' SOL'}. ` +
		`Last 30 days — tips in: $${facts.tips_30d_usd.toFixed(2)}, spend out: $${facts.spend_30d_usd.toFixed(2)}, net: ${facts.net_30d_usd >= 0 ? '+' : ''}$${facts.net_30d_usd.toFixed(2)}. ` +
		`${facts.active_intents} active rule${facts.active_intents === 1 ? '' : 's'} have fired ${facts.intent_fires} time${facts.intent_fires === 1 ? '' : 's'}, moving $${facts.intent_moved_usd.toFixed(2)}.`;

	// Phrase it in-character if an LLM is available; otherwise return the real facts.
	let reply = factual;
	let provider = 'facts';
	try {
		let userKeys = {};
		try { const [u] = await sql`SELECT provider_keys FROM users WHERE id = ${owned.auth.userId}`; userKeys = await loadUserProviderKeys(u?.provider_keys); } catch { /* */ }
		const key = userKeys.anthropic || process.env.ANTHROPIC_API_KEY;
		const orKey = userKeys.openrouter || process.env.OPENROUTER_API_KEY;
		const persona = (owned.row.meta?.persona_prompt || owned.meta.system_prompt || '').toString().slice(0, 600);
		const sys = `You are the wallet copilot for "${owned.row.name}", a 3D AI agent on three.ws. Answer the owner's question about their money in 1–3 short sentences, in character${persona ? ` (persona: ${persona})` : ''}. Use ONLY these real facts — never invent numbers: ${factual}`;
		if (key) {
			const r = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
				body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 300, system: sys, messages: [{ role: 'user', content: message }] }),
				signal: AbortSignal.timeout(15_000),
			});
			if (r.ok) { const j = await r.json(); const t = (j.content || []).find((b) => b.type === 'text')?.text; if (t) { reply = t.trim(); provider = 'anthropic'; } }
		} else if (orKey) {
			const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
				method: 'POST', headers: { Authorization: `Bearer ${orKey}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws wallet copilot' },
				body: JSON.stringify({ model: 'openai/gpt-oss-120b', max_tokens: 300, messages: [{ role: 'system', content: sys }, { role: 'user', content: message }] }),
				signal: AbortSignal.timeout(15_000),
			});
			if (r.ok) { const j = await r.json(); const t = j.choices?.[0]?.message?.content; if (t) { reply = t.trim(); provider = 'openrouter'; } }
		}
	} catch { /* fall back to facts */ }

	return json(res, 200, { data: { reply, facts, provider } });
}
