// GET/POST /api/cron/coin-intel-observe — the serverless Coin Intelligence firehose.
//
// The /coin-intel feed reads observed launches from pump_coin_intel. Those rows
// are written by observing pump.fun's live launch firehose for each new coin's
// first seconds of trading. The always-on agent-sniper worker does this when it
// is deployed; this cron makes the engine self-sustaining on Vercel alone, so
// the feed populates without depending on a long-running host.
//
// Per run: open a PumpPortal WebSocket, subscribe to new tokens, accumulate each
// new mint's create event + trades for a bounded budget, then finalize every
// observed coin through the SAME shared path the worker uses
// (workers/agent-sniper/intel/finalize.js) — compute signals, classify, resolve
// the funding graph, cross-reference smart money, and upsert to Postgres.
//
// Bounded + idempotent: the budget is capped under the function's maxDuration,
// finalize runs with a small concurrency pool, and persistIntel upserts by mint
// so overlapping runs converge instead of duplicating.

import WebSocket from 'ws';
import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { finalizeObservation } from '../../workers/agent-sniper/intel/finalize.js';
import { pumpPortalWsUrl, handlePumpPortalAck } from '../_lib/pumpportal.js';
import { subscribePumpOnchainTrades } from '../_lib/pump-onchain-trades.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const NETWORK = 'mainnet';
const META_TIMEOUT_MS = 2_500;

// Budget must stay under the function maxDuration (120s in vercel.json) with
// headroom for the finalize drain. Observe for OBSERVE_MS, then drain.
const OBSERVE_MS = Number(process.env.COIN_INTEL_OBSERVE_MS) || 85_000;
const MAX_OBSERVATIONS = Number(process.env.COIN_INTEL_MAX_OBS) || 300;
const FINALIZE_CONCURRENCY = Number(process.env.COIN_INTEL_FINALIZE_CONCURRENCY) || 8;
const USE_LLM = process.env.COIN_INTEL_LLM === '1' || process.env.COIN_INTEL_LLM === 'true';

const solToLamports = (sol) => Math.round((Number(sol) || 0) * LAMPORTS_PER_SOL);

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { error(res, 503, 'not_configured', 'CRON_SECRET unset'); return false; }
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		error(res, 401, 'unauthorized', 'invalid cron secret');
		return false;
	}
	return true;
}

// Off-hot-path metadata fetch (description/socials) — best-effort, never blocks.
async function fetchMeta(uri) {
	if (!uri) return null;
	try {
		const ctrl = new AbortController();
		const tid = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
		const r = await fetch(uri, { signal: ctrl.signal });
		clearTimeout(tid);
		if (!r.ok) return null;
		const d = await r.json();
		return {
			description: d.description || null,
			twitter: d.twitter || null,
			telegram: d.telegram || null,
			website: d.website || null,
			image_uri: d.image || d.image_uri || null,
		};
	} catch { return null; }
}

// Run the firehose for OBSERVE_MS, returning the map of observations collected.
// Creates come from PumpPortal (free tier); trades come from the on-chain
// program subscription (api/_lib/pump-onchain-trades.js), with PumpPortal's
// per-mint trade stream as an augmenting source when a funded key is set.
// Overlap between the two is deduped by tx signature per observation.
function collectObservations(budgetMs) {
	return new Promise((resolve) => {
		const observations = new Map(); // mint -> obs
		const metaPending = [];
		let settled = false;
		let ws;

		const recordTrade = (msg) => {
			const obs = observations.get(msg.mint);
			if (!obs || settled) return;
			if (msg.signature) {
				if (obs.sigs.has(msg.signature)) return;
				obs.sigs.add(msg.signature);
			}
			obs.trades.push({
				trader: msg.traderPublicKey || null,
				isBuy: msg.txType === 'buy',
				lamports: msg.solAmount != null ? solToLamports(msg.solAmount) : 0,
				baseAmount: Number(msg.tokenAmount) || 0,
				ts: Date.now(),
				signature: msg.signature,
			});
		};
		const stopOnchain = subscribePumpOnchainTrades({ network: NETWORK, onTrade: recordTrade });

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			try { stopOnchain(); } catch {}
			try { ws?.close(); } catch {}
			// Let any in-flight metadata enrich attach before we hand off.
			Promise.allSettled(metaPending).then(() => resolve(observations));
		};
		const deadline = setTimeout(finish, budgetMs);

		const send = (obj) => {
			if (ws && ws.readyState === WebSocket.OPEN) {
				try { ws.send(JSON.stringify(obj)); } catch {}
			}
		};

		try { ws = new WebSocket(pumpPortalWsUrl()); }
		catch { finish(); return; }

		ws.on('open', () => send({ method: 'subscribeNewToken' }));

		ws.on('message', (raw) => {
			let msg;
			try { msg = JSON.parse(raw.toString()); } catch { return; }
			if (handlePumpPortalAck(msg, (line) => console.warn('[coin-intel-observe]', line))) return;

			if (msg.txType === 'create') {
				const mint = msg.mint;
				if (!mint || observations.has(mint)) return;
				if (observations.size >= MAX_OBSERVATIONS) return;
				const now = Date.now();
				const obs = {
					mint,
					createdAtSec: Math.floor(now / 1000),
					firstSeenAtMs: now,
					creator: msg.traderPublicKey || null,
					devBuyLamports: msg.solAmount != null ? solToLamports(msg.solAmount) : null,
					mcSolFirstSeen: typeof msg.marketCapSol === 'number' ? msg.marketCapSol : null,
					meta: {
						name: msg.name || null,
						symbol: msg.symbol || null,
						bonding_curve: msg.bondingCurveKey || null,
						image_uri: msg.uri || null,
						uri: msg.uri || null,
						description: null, twitter: null, telegram: null, website: null,
					},
					// Seed the creator's launch buy as the first trade so dev sizing /
					// concentration include it.
					trades: msg.solAmount
						? [{ trader: msg.traderPublicKey || null, isBuy: true, lamports: solToLamports(msg.solAmount), baseAmount: Number(msg.tokenAmount) || 0, ts: now, signature: msg.signature }]
						: [],
					sigs: new Set(msg.signature ? [msg.signature] : []),
				};
				observations.set(mint, obs);
				send({ method: 'subscribeTokenTrade', keys: [mint] });
				metaPending.push(fetchMeta(obs.meta.uri).then((m) => { if (m) Object.assign(obs.meta, m); }).catch(() => {}));
			} else if (msg.txType === 'buy' || msg.txType === 'sell') {
				recordTrade(msg);
			}
		});

		ws.on('error', () => { /* close handler resolves; reconnect not worth it in a bounded run */ });
		ws.on('close', () => { if (!settled && observations.size === 0) finish(); });
	});
}

// Finalize observations with a bounded concurrency pool.
async function drain(observations, endedAtMs) {
	const items = [...observations.values()];
	let i = 0, persisted = 0, failed = 0;
	async function worker() {
		while (i < items.length) {
			const obs = items[i++];
			try {
				await finalizeObservation(obs, { network: NETWORK, useLlm: USE_LLM, endedAtMs });
				persisted++;
			} catch { failed++; }
		}
	}
	await Promise.all(Array.from({ length: Math.min(FINALIZE_CONCURRENCY, items.length || 1) }, worker));
	return { persisted, failed };
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const started = Date.now();
	const observations = await collectObservations(OBSERVE_MS);
	const endedAtMs = Date.now();
	const { persisted, failed } = await drain(observations, endedAtMs);

	return json(res, 200, {
		ok: true,
		observed: observations.size,
		persisted,
		failed,
		observe_ms: endedAtMs - started,
		total_ms: Date.now() - started,
		llm: USE_LLM,
	});
}, { requireWriteCapacity: true });
