/**
 * Pump.fun watch skills
 * ---------------------
 * Read-only skills that let a Solana agent observe live pump.fun activity.
 * Pairs with /api/agents/pumpfun-feed (SSE) and the upstream pumpfun-claims-bot
 * MCP server.
 *
 * Skills registered:
 *   - pumpfun-recent-claims  → list the latest N claims with intel
 *   - pumpfun-token-intel    → enriched analysis of a specific mint
 *   - pumpfun-watch-start    → subscribe to live feed; agent reacts per event
 *   - pumpfun-watch-stop     → unsubscribe
 *
 * Reactions (handled inside watch-start) emit existing protocol events:
 *   - first-time claim → emote celebration + speak the AI take
 *   - fake claim       → emote concern + warn
 *   - graduation       → gesture wave + speak
 *
 * No keys held. No transactions signed. Pure read + react.
 */

import { ACTION_TYPES } from './agent-protocol.js';
import { watchClaims } from './pump/pumpkit-claims.js';
import { applyReaction, createReactionDispatcher } from './widgets/pumpfun-reactions.js';

const FEED_PATH = '/api/agents/pumpfun-feed';
const TIER_BADGE = { mega: '🔥🔥', influencer: '🔥', notable: '⭐' };

const _state = {
	es: null,
	startedAt: 0,
	count: 0,
};

/** Active whale-trade watchers keyed by mint. Value is the AbortController. */
const _whaleWatchers = new Map();

// Bounded so a stalled feed cannot hang the agent's turn: the watch skills
// await this inline, and without a deadline the chat sits mid-reply forever.
async function fetchJson(url, { timeout = 8000 } = {}) {
	const r = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(timeout) });
	if (!r.ok) throw new Error(`request failed: ${r.status}`);
	return r.json();
}

function summarizeClaim(ev) {
	const tier = ev.tier ? `${TIER_BADGE[ev.tier] || ''} ${ev.tier}` : '';
	const who = ev.github_user ? `@${ev.github_user}` : ev.claimer || 'unknown';
	const sol = ev.amount_sol != null ? `${Number(ev.amount_sol).toFixed(3)} SOL` : '—';
	return `${who} claimed ${sol} ${tier}`.trim();
}

/**
 * Register pump.fun watch skills onto an AgentSkills instance.
 * @param {import('./agent-skills.js').AgentSkills} skills
 */
export function registerPumpFunWatchSkills(skills) {
	skills.register({
		name: 'pumpfun-recent-claims',
		description: 'List the most recent pump.fun GitHub social-fee claims with intel.',
		instruction: 'Returns up to N enriched claim records. Read-only.',
		animationHint: 'curiosity',
		voicePattern: 'Pulling the last {{limit}} claims…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
		},
		handler: async (args) => {
			const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));
			try {
				const data = await fetchJson(`/api/agents/pumpfun?op=claims&limit=${limit}`);
				const items = data?.items || [];
				return {
					success: true,
					output: items.length
						? `Last ${items.length} claims:\n` + items.map(summarizeClaim).join('\n')
						: 'No claims found in feed.',
					sentiment: 0.2,
					data: { items },
				};
			} catch (err) {
				return { success: false, output: `Could not fetch claims: ${err.message}`, sentiment: -0.3 };
			}
		},
	});

	skills.register({
		name: 'pumpfun-token-intel',
		description: 'Get pump.fun token intel: graduation status, creator, holders, trust signals.',
		instruction: 'Read-only enrichment for a specific mint address.',
		animationHint: 'think',
		voicePattern: 'Analyzing {{mint}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: { mint: { type: 'string', description: 'SPL mint pubkey (base58)' } },
			required: ['mint'],
		},
		handler: async (args) => {
			if (!args?.mint) return { success: false, output: 'mint required', sentiment: -0.2 };
			try {
				const data = await fetchJson(
					`/api/agents/pumpfun?op=token&mint=${encodeURIComponent(args.mint)}`,
				);
				const t = data || {};
				const lines = [
					t.name ? `${t.name}${t.symbol ? ` ($${t.symbol})` : ''}` : args.mint,
					t.graduated ? 'Graduated to PumpAMM' : `Curve progress: ${t.curve_progress ?? '—'}%`,
					t.creator ? `Creator: ${t.creator}` : null,
					t.warnings?.length ? `⚠️ ${t.warnings.join(', ')}` : null,
				].filter(Boolean);
				return {
					success: true,
					output: lines.join('\n'),
					sentiment: t.warnings?.length ? -0.2 : 0.3,
					data: t,
				};
			} catch (err) {
				return { success: false, output: `Could not fetch intel: ${err.message}`, sentiment: -0.3 };
			}
		},
	});

	skills.register({
		name: 'pumpfun-watch-start',
		description: 'Subscribe to live pump.fun events; agent narrates and reacts as they arrive.',
		instruction: 'Opens an SSE stream. Emits speak/gesture/emote per event.',
		animationHint: 'curiosity',
		voicePattern: 'Watching pump.fun live.',
		mcpExposed: false, // browser-only — needs EventSource
		inputSchema: {
			type: 'object',
			properties: {
				kind: { type: 'string', enum: ['all', 'claims', 'graduations'], default: 'all' },
				minTier: { type: 'string', enum: ['notable', 'influencer', 'mega'] },
			},
		},
		handler: async (args, ctx) => {
			if (typeof window === 'undefined' || !window.EventSource) {
				return { success: false, output: 'Live watch requires a browser.', sentiment: -0.3 };
			}
			if (_state.es) {
				return { success: true, output: 'Already watching.', sentiment: 0.1 };
			}
			const params = new URLSearchParams();
			params.set('kind', args?.kind || 'all');
			if (args?.minTier) params.set('minTier', args.minTier);
			const url = `${FEED_PATH}?${params.toString()}`;

			_state.es = new EventSource(url, { withCredentials: true });
			_state.startedAt = Date.now();
			_state.count = 0;

			const protocol = ctx.protocol;
			const dispatcher = createReactionDispatcher();
			const react = (kind, ev) =>
				dispatcher.dispatch(kind, ev, (reaction) => applyReaction(protocol, reaction));

			_state.es.addEventListener('claim', (msg) => {
				_state.count++;
				const ev = safeJson(msg.data);
				if (!ev) return;
				react('claim', ev);
			});

			_state.es.addEventListener('graduation', (msg) => {
				const ev = safeJson(msg.data);
				if (!ev) return;
				react('graduation', ev);
			});

			_state.es.addEventListener('mint', (msg) => {
				const ev = safeJson(msg.data);
				if (!ev) return;
				react('mint', ev);
			});

			_state.es.addEventListener('error', () => {
				// EventSource auto-reconnects; surface only if it permanently closes.
				if (_state.es && _state.es.readyState === EventSource.CLOSED) {
					protocol?.emit({ type: ACTION_TYPES.EMOTE, payload: { trigger: 'concern', weight: 0.4 } });
					_state.es = null;
				}
			});

			return {
				success: true,
				output: `Watching pump.fun (${args?.kind || 'all'}).`,
				sentiment: 0.4,
			};
		},
	});

	skills.register({
		name: 'pumpfun-watch-stop',
		description: 'Stop the live pump.fun watch.',
		instruction: 'Closes the SSE stream.',
		animationHint: 'patience',
		voicePattern: 'Stopping the watch.',
		mcpExposed: false,
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			if (!_state.es) {
				return { success: true, output: 'Not currently watching.', sentiment: 0 };
			}
			_state.es.close();
			const seen = _state.count;
			_state.es = null;
			_state.count = 0;
			return {
				success: true,
				output: `Stopped. Saw ${seen} events.`,
				sentiment: 0.1,
				data: { events: seen },
			};
		},
	});

	// ── pumpfun.watchWhales ───────────────────────────────────────────────────
	skills.register({
		name: 'pumpfun.watchWhales',
		description:
			'Watch for whale buys/sells on a pump.fun token. Streams alert messages as trades arrive.',
		instruction:
			'Subscribes to live pump.fun bonding-curve trades and speaks each trade that meets minUsd.',
		animationHint: 'curiosity',
		voicePattern: 'Watching {{mint}} for whale trades…',
		mcpExposed: false, // browser-only WebSocket; MCP variant is pumpfun_watch_whales in pump-fun-mcp.js
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string', description: 'SPL mint pubkey (base58)' },
				minUsd: { type: 'number', description: 'Minimum trade value in USD (default 5000)' },
				durationMs: {
					type: 'number',
					description: 'Watch window in ms (default 300000, max 1800000)',
				},
			},
			required: ['mint'],
		},
		handler: async (args, ctx) => {
			if (typeof window === 'undefined') {
				return { success: false, output: 'Whale watch requires a browser.', sentiment: -0.3 };
			}
			const mint = args?.mint;
			if (!mint) return { success: false, output: 'mint required', sentiment: -0.2 };

			if (_whaleWatchers.has(mint)) {
				return {
					success: true,
					output: `Already watching ${mint.slice(0, 8)}… for whales.`,
					sentiment: 0.1,
				};
			}

			const minUsd = Math.max(1, Number(args?.minUsd) || 5000);
			const durationMs = Math.min(
				1_800_000,
				Math.max(5_000, Number(args?.durationMs) || 300_000),
			);

			const ac = new AbortController();
			_whaleWatchers.set(mint, ac);

			const protocol = ctx.protocol;
			const speak = (text, sentiment = 0) =>
				protocol?.emit({ type: ACTION_TYPES.SPEAK, payload: { text, sentiment } });

			const stop = () => {
				ac.abort();
				_whaleWatchers.delete(mint);
			};
			const timer = setTimeout(stop, durationMs);
			ac.signal.addEventListener('abort', () => clearTimeout(timer));

			try {
				const { watchWhaleTrades } = await import('./pump/pumpkit-whale.js');
				watchWhaleTrades({
					mint,
					minUsd,
					signal: ac.signal,
					onTrade(trade) {
						const side = trade.sideBuy ? 'bought' : 'sold';
						speak(
							`🐋 Whale ${side} $${Math.round(trade.usd).toLocaleString()} (${trade.sol.toFixed(2)} SOL) — ${trade.wallet.slice(0, 8)}…`,
							trade.sideBuy ? 0.7 : -0.2,
						);
					},
				}).catch(stop);
			} catch (err) {
				stop();
				return {
					success: false,
					output: `Failed to start whale watch: ${err.message}`,
					sentiment: -0.4,
				};
			}

			speak(
				`Watching ${mint.slice(0, 8)}… for trades ≥ $${minUsd.toLocaleString()}.`,
				0.3,
			);

			return {
				success: true,
				output: `Started whale watch on ${mint.slice(0, 8)}… — min $${minUsd.toLocaleString()}, ${Math.round(durationMs / 60_000)} min.`,
				sentiment: 0.4,
				data: { mint, minUsd, durationMs },
			};
		},
	});

	skills.register({
		name: 'pumpfun-watch-claims',
		description:
			'Watch for pump.fun fee-claim events from a specific creator wallet and react as they arrive.',
		instruction:
			'Polls Solana RPC for fee-claim transactions. Emits speak/emote per claim. Resolves after durationMs.',
		animationHint: 'curiosity',
		voicePattern: 'Watching {{creator}} for claims…',
		mcpExposed: false, // long-running poll — not suitable for MCP request/response
		inputSchema: {
			type: 'object',
			properties: {
				creator: { type: 'string', description: 'Creator wallet address (base58)' },
				durationMs: {
					type: 'number',
					description: 'Watch window in ms (default 300000, max 1800000)',
				},
				network: { type: 'string', enum: ['mainnet', 'devnet'] },
			},
			required: ['creator'],
		},
		handler: async (args, ctx) => {
			if (!args?.creator) {
				return { success: false, output: 'creator wallet required', sentiment: -0.2 };
			}
			const duration = Math.min(1_800_000, Math.max(5_000, Number(args.durationMs) || 300_000));
			const ctrl = new AbortController();
			const timeout = setTimeout(() => ctrl.abort(), duration);

			const protocol = ctx?.protocol;
			const speak = (text, sentiment = 0) =>
				protocol?.emit({ type: ACTION_TYPES.SPEAK, payload: { text, sentiment } });
			const emote = (trigger, weight) =>
				protocol?.emit({ type: ACTION_TYPES.EMOTE, payload: { trigger, weight } });

			const claims = [];
			try {
				await watchClaims({
					creator: args.creator,
					signal: ctrl.signal,
					network: args.network || 'mainnet',
					onClaim: (claim) => {
						claims.push(claim);
						const sol = (claim.lamports / 1e9).toFixed(4);
						const tag = claim.mint ? ` (${claim.mint.slice(0, 8)}…)` : '';
						emote('curiosity', 0.6);
						speak(`Claim detected: ${sol} SOL${tag}`, 0.4);
					},
				});
			} finally {
				clearTimeout(timeout);
			}

			return {
				success: true,
				output: claims.length
					? `Saw ${claims.length} claim${claims.length === 1 ? '' : 's'} in ${duration / 1000}s.`
					: `No claims from ${args.creator.slice(0, 8)}… in ${duration / 1000}s.`,
				sentiment: claims.length ? 0.4 : 0,
				data: { claims },
			};
		},
	});
}

function safeJson(s) {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}
