/**
 * Pump.fun composition skills — agent-level loops over read (MCP) + trade (signed).
 * Composes pumpfun-buy / pumpfun-sell / pumpfun-status in-process.
 *
 * Args supported by every loop:
 *   - sessionId:"..."  → seen/mirrored/spent/exited persisted in agent memory,
 *                        survives crashes within the spend cap.
 *   - signal           → AbortSignal; loops, sleeps, and inner iterations all
 *                        bail out promptly when aborted.
 *   - onProgress(evt)  → called on every state change (vet/skip/buy/sell/sleep).
 *                        Used by the UI for live counters.
 *   - dryRun:true      → identical control flow; trade-skill calls are replaced
 *                        with `{ signature: null, dryRun: true }`. Spend cap
 *                        and seen/mirrored sets still tick so a dry-run
 *                        terminates the same way a live run would.
 */

import { WalletMonitor } from './pump/wallet-monitor.js';

const MCP_ENDPOINT = 'https://pump-fun-sdk.modelcontextprotocol.name/mcp';
const _sessions = new Map();
let _rpcId = 0;

const DEFAULTS = {
	sessionSpendCapSol: 1.0,
	perTradeSol: 0.05,
	minHoldersForBuy: 30,
	maxTopHolderPct: 25,
	rejectIfCreatorRugCount: 1,
	exitOnConcentrationPct: 40,
	exitOnDevSellPct: 25,
	pollMs: 5000,
};

function cfg(ctx, key) {
	return ctx?.skillConfig?.[key] ?? DEFAULTS[key];
}

async function mcp(toolName, args) {
	const res = await fetch(MCP_ENDPOINT, {
		method: 'POST',
		signal: AbortSignal.timeout(30_000),
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: ++_rpcId,
			method: 'tools/call',
			params: { name: toolName, arguments: args ?? {} },
		}),
	});
	if (!res.ok) throw new Error(`pump-fun MCP HTTP ${res.status}`);
	const body = await res.json();
	if (body.error) throw new Error(body.error.message ?? 'pump-fun MCP error');
	const text = body.result?.content?.find?.((c) => c.type === 'text')?.text;
	if (text) {
		try { return JSON.parse(text); } catch { return text; }
	}
	return body.result;
}

async function loadState(memory, sessionId, init) {
	if (!sessionId) return { ...init };
	if (_sessions.has(sessionId)) return _sessions.get(sessionId);
	try {
		const entries = memory?.query?.({ tags: [`compose:${sessionId}`], limit: 1 }) || [];
		const prior = entries[0]?.content;
		if (prior && typeof prior === 'object') {
			const restored = {
				...init,
				...prior,
				seen: new Set(prior.seen || []),
				mirrored: new Set(prior.mirrored || []),
				exited: new Set(prior.exited || []),
			};
			_sessions.set(sessionId, restored);
			return restored;
		}
	} catch {}
	const fresh = { ...init };
	_sessions.set(sessionId, fresh);
	return fresh;
}

function saveState(memory, sessionId, state) {
	if (!sessionId) return;
	_sessions.set(sessionId, state);
	const serializable = {
		...state,
		seen: state.seen ? [...state.seen] : undefined,
		mirrored: state.mirrored ? [...state.mirrored] : undefined,
		exited: state.exited ? [...state.exited] : undefined,
	};
	try {
		memory?.add?.({
			type: 'project',
			content: serializable,
			tags: [`compose:${sessionId}`],
			important: true,
		});
	} catch {}
}

function abortableSleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		const onAbort = () => { clearTimeout(t); resolve(); };
		signal?.addEventListener?.('abort', onAbort, { once: true });
	});
}

async function doBuy(skills, ctx, dryRun, mint, solAmount) {
	if (dryRun) return { signature: null, dryRun: true };
	const r = await skills.perform('pumpfun-buy', { mint, solAmount }, ctx);
	if (!r?.success) throw new Error(r?.output || 'pumpfun-buy failed');
	return r.data;
}

async function doSell(skills, ctx, dryRun, mint) {
	const status = await skills.perform('pumpfun-status', { mint }, ctx);
	const tokenAmount = status?.data?.userBalance ?? '0';
	if (tokenAmount === '0') return { signature: null, skipped: 'no-balance', tokenAmount };
	if (dryRun) return { signature: null, dryRun: true, tokenAmount };
	const r = await skills.perform('pumpfun-sell', { mint, tokenAmount }, ctx);
	if (!r?.success) throw new Error(r?.output || 'pumpfun-sell failed');
	return { ...r.data, tokenAmount };
}

function emit(progress, evt) {
	try { progress?.(evt); } catch {}
}

function passesFilters(ctx, { creator, holders }) {
	const rugCount = creator?.rugCount ?? creator?.rugFlags?.length ?? 0;
	if (rugCount >= cfg(ctx, 'rejectIfCreatorRugCount')) {
		return { ok: false, reason: `creator has ${rugCount} prior rug(s)` };
	}
	const holderCount = holders?.total ?? holders?.holders?.length ?? 0;
	if (holderCount < cfg(ctx, 'minHoldersForBuy')) {
		return { ok: false, reason: `only ${holderCount} holders` };
	}
	const top = holders?.topHolderPct ?? holders?.holders?.[0]?.pct ?? 0;
	if (top > cfg(ctx, 'maxTopHolderPct')) {
		return { ok: false, reason: `top holder owns ${top}%` };
	}
	return { ok: true };
}

async function vetMint(mint) {
	const [details, holders] = await Promise.all([
		mcp('getTokenDetails', { mint }),
		mcp('getTokenHolders', { mint, limit: 20 }),
	]);
	const creatorAddr = details?.creator ?? details?.token?.creator;
	const creator = creatorAddr ? await mcp('getCreatorProfile', { creator: creatorAddr }) : { rugCount: 0 };
	return { details, holders, creator };
}

/**
 * @param {import('./agent-skills.js').AgentSkills} skills
 */
export function registerPumpFunComposeSkills(skills) {
	skills.register({
		name: 'pumpfun-research-and-buy',
		description: 'Research a pump.fun token, then buy if it passes rug/holder filters.',
		instruction: 'search → vet (curve, holders, creator rug flags) → buy via pumpfun-buy.',
		animationHint: 'inspect',
		voicePattern: 'Researching {{query}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				amountSol: { type: 'number' },
				dryRun: { type: 'boolean', description: 'Vet/quote but skip the actual buy.' },
			},
			required: ['query'],
		},
		handler: async (args, ctx) => {
			const dryRun = !!args.dryRun;
			const onProgress = args.onProgress;
			emit(onProgress, { type: 'search', query: args.query });
			const search = await mcp('searchTokens', { query: args.query, limit: 1 });
			const mint = search?.results?.[0]?.mint ?? search?.[0]?.mint ?? args.query;
			emit(onProgress, { type: 'vet', mint });
			const v = await vetMint(mint);
			const verdict = passesFilters(ctx, v);
			if (!verdict.ok) {
				emit(onProgress, { type: 'skip', mint, reason: verdict.reason });
				return {
					success: true,
					output: `Skipping ${mint.slice(0, 8)}…: ${verdict.reason}`,
					sentiment: -0.1,
					data: { mint, decision: 'skip', reason: verdict.reason, dryRun },
				};
			}
			const amountSol = args.amountSol ?? cfg(ctx, 'perTradeSol');
			emit(onProgress, { type: dryRun ? 'dry-buy' : 'buy', mint, amountSol });
			const buy = await doBuy(skills, ctx, dryRun, mint, amountSol);
			return {
				success: true,
				output: dryRun
					? `Dry-run buy ${amountSol} SOL of ${mint.slice(0, 8)}….`
					: `Bought ${amountSol} SOL of ${mint.slice(0, 8)}….`,
				sentiment: 0.6,
				data: { mint, decision: 'buy', amountSol, sig: buy.signature, dryRun },
			};
		},
	});

	skills.register({
		name: 'pumpfun-auto-snipe',
		description: 'Poll new tokens, vet, and auto-buy each pass with perTradeSol until sessionSpendCapSol. Persists seen/spent under sessionId.',
		instruction: 'autoSnipe loop. Use simulate:true to validate filters without spending.',
		animationHint: 'gesture',
		voicePattern: 'Sniping for {{durationSec}}s…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				durationSec: { type: 'integer', minimum: 10, maximum: 3600 },
				perTradeSol: { type: 'number' },
				sessionId: { type: 'string' },
				dryRun: { type: 'boolean' },
			},
			required: ['durationSec'],
		},
		handler: async (args, ctx) => {
			const dryRun = !!args.dryRun;
			const onProgress = args.onProgress;
			const signal = args.signal;
			const sessionId = args.sessionId;
			const deadline = Date.now() + args.durationSec * 1000;
			const perTrade = args.perTradeSol ?? cfg(ctx, 'perTradeSol');
			const cap = cfg(ctx, 'sessionSpendCapSol');
			const state = await loadState(ctx?.memory, sessionId, { seen: new Set(), spent: 0, log: [] });
			emit(onProgress, { type: 'start', mode: 'auto-snipe', spent: state.spent, cap });

			while (!signal?.aborted && Date.now() < deadline && state.spent + perTrade <= cap) {
				const fresh = await mcp('getNewTokens', { limit: 20 }).catch(() => null);
				const items = fresh?.tokens ?? fresh ?? [];
				for (const t of items) {
					if (signal?.aborted) break;
					const mint = t.mint ?? t.address;
					if (!mint || state.seen.has(mint)) continue;
					state.seen.add(mint);
					emit(onProgress, { type: 'vet', mint });
					const v = await vetMint(mint).catch((e) => ({ verdict: { ok: false, reason: e.message } }));
					const verdict = v.verdict || passesFilters(ctx, v);
					if (!verdict.ok) {
						state.log.push({ mint, action: 'skip', reason: verdict.reason });
						emit(onProgress, { type: 'skip', mint, reason: verdict.reason, spent: state.spent });
						continue;
					}
					try {
						const buy = await doBuy(skills, ctx, dryRun, mint, perTrade);
						state.spent += perTrade;
						state.log.push({ mint, action: dryRun ? 'dry-buy' : 'buy', sig: buy.signature, spent: state.spent });
						saveState(ctx?.memory, sessionId, state);
						emit(onProgress, { type: dryRun ? 'dry-buy' : 'buy', mint, sig: buy.signature, spent: state.spent });
						if (state.spent + perTrade > cap) break;
					} catch (e) {
						state.log.push({ mint, action: 'error', reason: e.message });
						emit(onProgress, { type: 'error', mint, reason: e.message });
					}
				}
				saveState(ctx?.memory, sessionId, state);
				if (signal?.aborted || Date.now() >= deadline || state.spent + perTrade > cap) break;
				emit(onProgress, { type: 'poll-sleep', ms: cfg(ctx, 'pollMs') });
				await abortableSleep(cfg(ctx, 'pollMs'), signal);
			}
			const reason = signal?.aborted ? 'aborted' : Date.now() >= deadline ? 'duration' : 'cap';
			return {
				success: true,
				output: `${dryRun ? 'Dry-run' : 'Snipe'} done (${reason}). Spent ${state.spent} SOL across ${state.log.length} events.`,
				sentiment: 0.4,
				data: { spent: state.spent, trades: state.log, dryRun, sessionId, reason },
			};
		},
	});

	skills.register({
		name: 'pumpfun-copy-trade',
		description: 'Mirror a wallet\'s recent pump.fun buys with size scaling. Persists mirrored sigs under sessionId.',
		instruction: 'copyTrade loop.',
		animationHint: 'gesture',
		voicePattern: 'Copy-trading {{wallet}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				wallet: { type: 'string' },
				sizeMultiplier: { type: 'number', minimum: 0.001, maximum: 10 },
				durationSec: { type: 'integer', minimum: 10, maximum: 7200 },
				sessionId: { type: 'string' },
				dryRun: { type: 'boolean' },
			},
			required: ['wallet', 'durationSec'],
		},
		handler: async (args, ctx) => {
			const dryRun = !!args.dryRun;
			const onProgress = args.onProgress;
			const signal = args.signal;
			const sessionId = args.sessionId;
			const deadline = Date.now() + args.durationSec * 1000;
			const mult = args.sizeMultiplier ?? 1;
			const cap = cfg(ctx, 'sessionSpendCapSol');
			const state = await loadState(ctx?.memory, sessionId, { mirrored: new Set(), spent: 0, log: [] });
			emit(onProgress, { type: 'start', mode: 'copy-trade', wallet: args.wallet, spent: state.spent, cap });

			while (!signal?.aborted && Date.now() < deadline && state.spent < cap) {
				const profile = await mcp('getCreatorProfile', { creator: args.wallet }).catch(() => null);
				const recentMints = (profile?.tokens ?? []).map((t) => t.mint).filter(Boolean);
				for (const mint of recentMints) {
					if (signal?.aborted) break;
					const trades = await mcp('getTokenTrades', { mint, limit: 20 }).catch(() => null);
					const buys = (trades?.trades ?? trades ?? []).filter(
						(t) => t.side === 'buy' && t.wallet === args.wallet && !state.mirrored.has(t.sig),
					);
					for (const b of buys) {
						if (signal?.aborted) break;
						state.mirrored.add(b.sig);
						const amountSol = Math.min((b.solAmount ?? 0) * mult, cap - state.spent);
						if (amountSol <= 0) break;
						try {
							const r = await doBuy(skills, ctx, dryRun, mint, amountSol);
							state.spent += amountSol;
							state.log.push({ mint, mirroredFrom: b.sig, sig: r.signature, amountSol, dryRun });
							saveState(ctx?.memory, sessionId, state);
							emit(onProgress, { type: dryRun ? 'dry-buy' : 'buy', mint, sig: r.signature, amountSol, spent: state.spent });
						} catch (e) {
							state.log.push({ mint, error: e.message });
							emit(onProgress, { type: 'error', mint, reason: e.message });
						}
					}
				}
				saveState(ctx?.memory, sessionId, state);
				if (signal?.aborted || Date.now() >= deadline || state.spent >= cap) break;
				emit(onProgress, { type: 'poll-sleep', ms: cfg(ctx, 'pollMs') });
				await abortableSleep(cfg(ctx, 'pollMs'), signal);
			}
			const reason = signal?.aborted ? 'aborted' : Date.now() >= deadline ? 'duration' : 'cap';
			return {
				success: true,
				output: `${dryRun ? 'Dry-run' : 'Copy-trade'} done (${reason}). Mirrored ${state.log.length} buys, spent ${state.spent} SOL.`,
				sentiment: 0.4,
				data: { spent: state.spent, mirrors: state.log, dryRun, sessionId, reason },
			};
		},
	});

	skills.register({
		name: 'pumpfun-rug-exit-watch',
		description: 'Watch held mints; auto-sell on top-holder concentration or dev-wallet sell triggers. Persists exited mints under sessionId.',
		instruction: 'rugExitWatch loop.',
		animationHint: 'concern',
		voicePattern: 'Watching {{mints.length}} positions…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				mints: { type: 'array', items: { type: 'string' } },
				durationSec: { type: 'integer', minimum: 10, maximum: 86400 },
				sessionId: { type: 'string' },
				dryRun: { type: 'boolean' },
			},
			required: ['mints', 'durationSec'],
		},
		handler: async (args, ctx) => {
			const dryRun = !!args.dryRun;
			const onProgress = args.onProgress;
			const signal = args.signal;
			const sessionId = args.sessionId;
			const deadline = Date.now() + args.durationSec * 1000;
			const concentrationLimit = cfg(ctx, 'exitOnConcentrationPct');
			const devSellLimit = cfg(ctx, 'exitOnDevSellPct');
			const state = await loadState(ctx?.memory, sessionId, { exited: new Set(), log: [] });
			emit(onProgress, { type: 'start', mode: 'rug-exit-watch', mints: args.mints });

			while (!signal?.aborted && Date.now() < deadline && state.exited.size < args.mints.length) {
				for (const mint of args.mints) {
					if (signal?.aborted) break;
					if (state.exited.has(mint)) continue;
					const [holders, trades, details] = await Promise.all([
						mcp('getTokenHolders', { mint, limit: 10 }).catch(() => null),
						mcp('getTokenTrades', { mint, limit: 50 }).catch(() => null),
						mcp('getTokenDetails', { mint }).catch(() => null),
					]);
					const top = holders?.topHolderPct ?? holders?.holders?.[0]?.pct ?? 0;
					const dev = details?.creator ?? details?.token?.creator;
					const devSells = (trades?.trades ?? trades ?? []).filter((t) => t.side === 'sell' && t.wallet === dev);
					const devSellPct = devSells.reduce((s, t) => s + (t.pctOfSupply ?? 0), 0);

					let trigger = null;
					if (top >= concentrationLimit) trigger = `top holder ${top}%`;
					else if (devSellPct >= devSellLimit) trigger = `dev sold ${devSellPct}%`;
					if (!trigger) {
						emit(onProgress, { type: 'tick', mint, top, devSellPct });
						continue;
					}

					try {
						const sell = await doSell(skills, ctx, dryRun, mint);
						if (sell.skipped === 'no-balance') {
							state.log.push({ mint, trigger, action: 'skipped-no-balance' });
							emit(onProgress, { type: 'skip', mint, reason: 'no-balance' });
						} else {
							state.exited.add(mint);
							state.log.push({ mint, trigger, sig: sell.signature, tokenAmount: sell.tokenAmount, dryRun });
							emit(onProgress, { type: dryRun ? 'dry-sell' : 'sell', mint, sig: sell.signature, trigger });
						}
						saveState(ctx?.memory, sessionId, state);
					} catch (e) {
						state.log.push({ mint, trigger, error: e.message });
						emit(onProgress, { type: 'error', mint, reason: e.message });
					}
				}
				saveState(ctx?.memory, sessionId, state);
				if (signal?.aborted || Date.now() >= deadline || state.exited.size >= args.mints.length) break;
				emit(onProgress, { type: 'poll-sleep', ms: cfg(ctx, 'pollMs') });
				await abortableSleep(cfg(ctx, 'pollMs'), signal);
			}
			const reason = signal?.aborted ? 'aborted' : Date.now() >= deadline ? 'duration' : 'all-exited';
			return {
				success: true,
				output: `Exit watch done (${reason}). Exited ${state.exited.size}/${args.mints.length} positions.`,
				sentiment: state.exited.size > 0 ? -0.2 : 0.2,
				data: { exited: [...state.exited], events: state.log, dryRun, sessionId, reason },
			};
		},
	});

	skills.register({
		name: 'pumpfun-copy-trade-live',
		description:
			"Mirror a wallet's pump.fun trades in real-time via WebSocket (~100ms latency). Mirrors both buys AND sells. Use instead of pumpfun-copy-trade when speed matters.",
		instruction:
			'WebSocket logsSubscribe on the target wallet. Fires doBuy on buy events, doSell on sell events (if we hold the mint). Stops at durationSec, spendCap, or abort.',
		animationHint: 'gesture',
		voicePattern: 'Live copy-trading {{wallet}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				wallet: { type: 'string', description: 'Base58 Solana address to mirror.' },
				sizeMultiplier: { type: 'number', minimum: 0.001, maximum: 10, description: 'Scale factor applied to the target\'s trade size.' },
				durationSec: { type: 'integer', minimum: 10, maximum: 7200 },
				network: { type: 'string', enum: ['mainnet', 'devnet'] },
				sessionId: { type: 'string' },
				dryRun: { type: 'boolean' },
			},
			required: ['wallet', 'durationSec'],
		},
		handler: async (args, ctx) => {
			const dryRun = !!args.dryRun;
			const onProgress = args.onProgress;
			const signal = args.signal;
			const sessionId = args.sessionId;
			const mult = args.sizeMultiplier ?? 1;
			const cap = cfg(ctx, 'sessionSpendCapSol');
			const state = await loadState(ctx?.memory, sessionId, { mirrored: new Set(), spent: 0, log: [] });

			const monitor = new WalletMonitor(args.wallet, { network: args.network ?? 'mainnet' });

			emit(onProgress, { type: 'start', mode: 'copy-trade-live', wallet: args.wallet, spent: state.spent, cap });

			await new Promise((resolve) => {
				if (signal?.aborted) { resolve(); return; }

				const timer = setTimeout(resolve, args.durationSec * 1000);
				signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });

				monitor.addEventListener('trade', async (evt) => {
					if (signal?.aborted || state.spent >= cap) { clearTimeout(timer); resolve(); return; }

					const { side, mint, solAmount, signature } = evt;

					// Skip if we already acted on this tx
					if (state.mirrored.has(signature)) return;
					state.mirrored.add(signature);

					try {
						if (side === 'buy') {
							const amount = Math.min(solAmount * mult, cap - state.spent);
							if (amount <= 0) return;
							emit(onProgress, { type: dryRun ? 'dry-buy' : 'buy', mint, solAmount: amount, spent: state.spent });
							const r = await doBuy(skills, ctx, dryRun, mint, amount);
							state.spent += amount;
							state.log.push({ side: 'buy', mint, mirroredSig: signature, sig: r.signature, solAmount: amount, dryRun });
						} else {
							// Sell — only if we hold the mint
							emit(onProgress, { type: dryRun ? 'dry-sell' : 'sell', mint });
							const r = await doSell(skills, ctx, dryRun, mint);
							if (r.skipped !== 'no-balance') {
								state.log.push({ side: 'sell', mint, mirroredSig: signature, sig: r.signature, dryRun });
							}
						}
						saveState(ctx?.memory, sessionId, state);
					} catch (e) {
						state.log.push({ side, mint, error: e.message });
						emit(onProgress, { type: 'error', mint, reason: e.message });
					}
				});

				monitor.start();
			});

			monitor.stop();

			const reason = signal?.aborted ? 'aborted' : state.spent >= cap ? 'cap' : 'duration';
			return {
				success: true,
				output: `${dryRun ? 'Dry-run' : 'Live copy-trade'} done (${reason}). Mirrored ${state.log.length} trades, spent ${state.spent.toFixed(4)} SOL.`,
				sentiment: 0.4,
				data: { spent: state.spent, mirrors: state.log, dryRun, sessionId, reason },
			};
		},
	});
}
