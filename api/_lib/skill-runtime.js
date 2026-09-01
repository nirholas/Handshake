// Skill runtime — server-side dispatcher for in-process skill invocation.
//
// Skills under examples/skills/<name>/handlers.js export tool functions.
// This module gives them the `ctx` they expect:
//   ctx.skills.invoke('skill.tool', args)  → call sibling skill
//   ctx.skillConfig                        → manifest.config merged with overrides
//   ctx.memory.note(tag, value)            → no-op stub (DB persistence is opt-in)
//   ctx.fetch                              → globalThis.fetch (overridable in tests)
//   ctx.wallet                             → injected by callers that need signing
//
// Cold-start friendly: skill modules are imported lazily on first use.

const SKILL_MAP = {
	'pump-fun': '../../examples/skills/pump-fun/handlers.js',
	'pump-fun-trade': '../../examples/skills/pump-fun-trade/handlers.js',
	'pump-fun-compose': '../../examples/skills/pump-fun-compose/handlers.js',
	'pump-fun-strategy': '../../examples/skills/pump-fun-strategy/handlers.js',
	'solana-wallet': '../../examples/skills/solana-wallet/handlers.js',
};

const MANIFEST_MAP = {
	'pump-fun': '../../examples/skills/pump-fun/manifest.json',
	'pump-fun-trade': '../../examples/skills/pump-fun-trade/manifest.json',
	'pump-fun-compose': '../../examples/skills/pump-fun-compose/manifest.json',
	'pump-fun-strategy': '../../examples/skills/pump-fun-strategy/manifest.json',
	'solana-wallet': '../../examples/skills/solana-wallet/manifest.json',
};

const _modCache = new Map();
const _cfgCache = new Map();

async function loadSkill(name) {
	if (_modCache.has(name)) return _modCache.get(name);
	const path = SKILL_MAP[name];
	if (!path) throw new Error(`unknown skill: ${name}`);
	const mod = await import(path);
	_modCache.set(name, mod);
	return mod;
}

async function loadManifest(name) {
	if (_cfgCache.has(name)) return _cfgCache.get(name);
	const path = MANIFEST_MAP[name];
	if (!path) return {};
	try {
		const mod = await import(path, { with: { type: 'json' } });
		_cfgCache.set(name, mod.default ?? mod);
		return mod.default ?? mod;
	} catch {
		_cfgCache.set(name, {});
		return {};
	}
}

// ── Server-side fetch for isomorphic skills ────────────────────────────────
// Skill handlers are shared with the browser, where a relative `/api/...` URL
// resolves against the page origin. On the server there is no origin, and
// Node's fetch throws `Failed to parse URL from /api/pump-fun-mcp`: that one
// line was every scan tick of every strategy run in production (2026-09-01),
// so no backtest or simulated session ever sourced a mint. Two rungs:
//   1. POST /api/pump-fun-mcp tools/call dispatches IN-PROCESS to the same tool
//      handlers the HTTP route runs, wrapped in the JSON-RPC envelope the skill
//      unwraps. No loopback hop, and the strategy loop (four tools per mint,
//      every few seconds) stops spending the server's own per-IP MCP limit.
//   2. Any other relative path resolves against APP_ORIGIN.
// Absolute URLs and Request objects pass straight through untouched.
async function serverFetch(input, init) {
	const url = typeof input === 'string' ? input : input?.url;
	if (typeof url !== 'string' || !url.startsWith('/')) return globalThis.fetch(input, init);
	const path = url.split('?')[0];
	const isPost = String(init?.method || 'GET').toUpperCase() === 'POST';
	let rpc = null;
	if (path === '/api/pump-fun-mcp' && isPost) {
		try { rpc = JSON.parse(typeof init?.body === 'string' ? init.body : '{}'); } catch { rpc = null; }
	}
	if (rpc?.method === 'tools/call') {
		const id = rpc.id ?? null;
		let envelope;
		try {
			const { callPumpFunTool } = await import('../pump-fun-mcp.js');
			const data = await callPumpFunTool(rpc.params?.name, rpc.params?.arguments ?? {});
			envelope = {
				jsonrpc: '2.0',
				id,
				result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data },
			};
		} catch (err) {
			envelope = {
				jsonrpc: '2.0',
				id,
				error: { code: err?.rpcCode ?? -32603, message: err?.message ?? 'tool error' },
			};
		}
		return new Response(JSON.stringify(envelope), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}
	const { env } = await import('./env.js');
	return globalThis.fetch(new URL(url, env.APP_ORIGIN).href, init);
}

/**
 * Build a context for invoking skills from a serverless endpoint.
 *
 * @param {object} opts
 * @param {object} [opts.configOverrides] - per-skill config overrides keyed by skill name
 * @param {object} [opts.wallet] - solana wallet contract for signing skills
 * @param {(event: object) => void} [opts.onEvent] - notified on every memory.note call
 * @param {object} [opts.fetch] - fetch impl (defaults to serverFetch: in-process for /api/pump-fun-mcp, APP_ORIGIN for other relative paths)
 * @param {string} [opts.agentId] - if set, every memory.note is persisted to agent_actions
 * @param {string} [opts.signerAddress] - persisted with each agent_actions row when agentId is set
 * @param {Record<string, { skill_id: string, author_id: string }>} [opts.skillMeta] - DB-sourced royalty metadata keyed by skill name
 */
export function makeRuntime(opts = {}) {
	const { configOverrides = {}, wallet, onEvent, fetch = serverFetch, agentId, signerAddress, skillMeta = {} } = opts;
	let _sql;
	// Map skill-internal tags to canonical action types so existing
	// aggregations (spend-policy, portfolio cost-basis) keep working.
	function canonicalType(skillName, tag) {
		const [, op] = (tag ?? '').split(':');
		if (skillName === 'pump-fun-trade') {
			if (op === 'buy') return 'pumpfun.buy';
			if (op === 'sell') return 'pumpfun.sell';
			if (op === 'create') return 'pumpfun.create';
		}
		return op || tag || 'note';
	}

	async function persistAction(skillName, tag, value) {
		if (!agentId) return;
		try {
			if (!_sql) _sql = (await import('./db.js')).sql;
			await _sql`
				INSERT INTO agent_actions (agent_id, type, payload, source_skill, signature, signer_address)
				VALUES (
					${agentId},
					${canonicalType(skillName, tag)},
					${JSON.stringify(value ?? {})}::jsonb,
					${skillName},
					${value?.sig ?? null},
					${signerAddress ?? null}
				)
			`;
		} catch (e) {
			// Persistence is best-effort; never break the strategy on a DB hiccup.
			console.error('[skill-runtime] persistAction failed', e?.message);
		}
	}

	async function invoke(qualified, args) {
		const [skillName, toolName] = qualified.split('.');
		if (!skillName || !toolName) return { ok: false, error: `bad tool: ${qualified}` };
		let mod;
		try { mod = await loadSkill(skillName); }
		catch (e) { return { ok: false, error: e.message }; }
		const fn = mod[toolName];
		if (typeof fn !== 'function') {
			return { ok: false, error: `tool not found: ${qualified}` };
		}
		const manifest = await loadManifest(skillName);
		const skillConfig = { ...(manifest.config ?? {}), ...(configOverrides[skillName] ?? {}) };
		const ctx = {
			skills: { invoke },
			skillConfig,
			wallet,
			fetch,
			memory: {
				note: (tag, value) => {
					try { onEvent?.({ skill: skillName, tool: toolName, tag, value, t: Date.now() }); } catch {}
					// Fire and forget — don't block the strategy loop on disk writes.
					persistAction(skillName, tag, value);
				},
				recall: async () => null,
			},
		};
		let result;
		try {
			result = await fn(args ?? {}, ctx);
		} catch (e) {
			return { ok: false, error: e?.message ?? String(e) };
		}

		// Fire-and-forget royalty billing for paid skills.
		if (result?.ok !== false && agentId && manifest.price_per_call_usd > 0) {
			const meta = skillMeta[skillName];
			if (meta?.skill_id && meta?.author_id) {
				queueMicrotask(() => {
					import('./royalty.js')
						.then(({ billSkillRoyalty }) =>
							billSkillRoyalty({
								skillId: meta.skill_id,
								skillName,
								agentId,
								authorId: meta.author_id,
								priceUsd: manifest.price_per_call_usd,
							}),
						)
						.catch((e) => console.error('[skill-runtime] royalty billing failed', e?.message));
				});
			}

			// Record autonomous agent payment in agent_payments ledger.
			queueMicrotask(() => {
				import('./agent-wallet.js')
					.then(({ triggerSkillPayment }) =>
						triggerSkillPayment({ agentId, skillSlug: skillName, skillId: skillMeta[skillName]?.skill_id ?? null }),
					)
					.catch(() => {});
			});
		}

		return result;
	}

	return { invoke };
}
