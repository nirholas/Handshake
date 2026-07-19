// Coin Intelligence — the observation watcher.
//
// Holds its own PumpPortal connection so it can DYNAMICALLY subscribe to each
// new mint's trade stream for an observation window, then unsubscribe. The
// shared feed (api/_lib/pumpfun-ws-feed.js) subscribes once on open and can't
// add keys later, so the watcher manages a lean connection of its own.
//
// Lifecycle per coin:
//   create event → start observation (record dev buy + metadata) → subscribe
//   to its trades → accumulate every buy/sell for windowMs → compute signals →
//   classify → persist → unsubscribe. The result is a complete intel record the
//   sniper and the /radar feed read instantly.

import WebSocket from 'ws';
import { finalizeObservation } from './finalize.js';
import { log } from '../log.js';
import { pumpPortalWsUrl, handlePumpPortalAck } from '../../../api/_lib/pumpportal.js';
import { subscribePumpOnchainTrades } from '../../../api/_lib/pump-onchain-trades.js';

const RECONNECT_DELAY_MS = 2_000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const META_TIMEOUT_MS = 2_500;

const _metaCache = new Map();
async function fetchMeta(uri) {
	if (!uri) return null;
	if (_metaCache.has(uri)) return _metaCache.get(uri);
	try {
		const ctrl = new AbortController();
		const tid = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
		const r = await fetch(uri, { signal: ctrl.signal });
		clearTimeout(tid);
		if (!r.ok) return null;
		const d = await r.json();
		const meta = {
			description: d.description || null,
			twitter: d.twitter || null,
			telegram: d.telegram || null,
			website: d.website || null,
			image_uri: d.image || d.image_uri || null,
		};
		if (_metaCache.size > 500) _metaCache.clear();
		_metaCache.set(uri, meta);
		return meta;
	} catch { return null; }
}

const solToLamports = (sol) => Math.round((Number(sol) || 0) * LAMPORTS_PER_SOL);

/**
 * Start the intel watcher.
 * @param {object} opts
 * @param {string} [opts.network='mainnet']
 * @param {number} [opts.windowMs=90000]   observation window per coin
 * @param {number} [opts.maxConcurrent=400] cap on simultaneously-watched coins
 * @param {AbortSignal} [opts.signal]
 * @param {(rec: object) => void} [opts.onIntel] fired with each finished record
 * @returns {() => void} stop
 */
export function startIntelWatcher({
	network = 'mainnet',
	windowMs = 90_000,
	maxConcurrent = 400,
	useLlm = false,
	signal,
	onIntel,
} = {}) {
	let active = true;
	let ws = null;
	let reconnectTimer = null;
	let droppedSinceLog = 0;
	const observations = new Map(); // mint -> { meta, trades, firstSeenAtMs, createdAtSec, devBuyLamports, timer }

	// The authoritative trade source: one program-wide on-chain subscription
	// covering every observed mint. PumpPortal's per-mint trade stream (below)
	// only augments it when a funded PUMPPORTAL_API_KEY is configured — without
	// one PumpPortal refuses trade subscriptions, and this lane carries alone.
	const stopOnchain = subscribePumpOnchainTrades({ network, onTrade: (msg) => { if (active) recordTrade(msg); } });

	function stop() {
		active = false;
		clearTimeout(reconnectTimer);
		for (const obs of observations.values()) clearTimeout(obs.timer);
		try { stopOnchain(); } catch {}
		if (ws) try { ws.close(); } catch {}
	}
	signal?.addEventListener('abort', stop);

	function send(obj) {
		if (ws && ws.readyState === WebSocket.OPEN) {
			try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
		}
		return false;
	}

	function startObservation(msg) {
		const mint = msg.mint;
		if (!mint || observations.has(mint)) return;
		if (observations.size >= maxConcurrent) {
			droppedSinceLog++;
			return; // logged periodically below — never silently
		}
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
			// The creator's initial buy is part of the launch tx — seed it as the
			// first trade so dev sizing/concentration include it.
			trades: msg.solAmount
				? [{ trader: msg.traderPublicKey || null, isBuy: true, lamports: solToLamports(msg.solAmount), baseAmount: Number(msg.tokenAmount) || 0, ts: now, signature: msg.signature }]
				: [],
			// Trades arrive from two sources (the on-chain firehose always; the
			// PumpPortal per-mint stream when an API key is funded) — dedupe by tx
			// signature so the overlap, and the seeded launch buy, count once.
			sigs: new Set(msg.signature ? [msg.signature] : []),
			timer: null,
		};
		observations.set(mint, obs);
		send({ method: 'subscribeTokenTrade', keys: [mint] });

		// Enrich metadata off the hot path.
		fetchMeta(obs.meta.uri).then((m) => {
			if (m && observations.has(mint)) Object.assign(obs.meta, m);
		}).catch(() => {});

		obs.timer = setTimeout(() => finalize(mint), windowMs);
	}

	function recordTrade(msg) {
		const obs = observations.get(msg.mint);
		if (!obs) return;
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
	}

	async function finalize(mint) {
		const obs = observations.get(mint);
		if (!obs) return;
		observations.delete(mint);
		clearTimeout(obs.timer);
		send({ method: 'unsubscribeTokenTrade', keys: [mint] });

		try {
			// Signal computation, enrichment, scoring and persistence all live in the
			// shared finalize module so the serverless cron observer produces byte-for-byte
			// identical records (api/cron/coin-intel-observe.js).
			const { record, summary } = await finalizeObservation(obs, { network, useLlm });
			if (active && onIntel) { try { onIntel(record); } catch {} }

			log.info?.('intel finalized', {
				mint,
				symbol: obs.meta.symbol,
				quality: record.quality_score,
				category: record.category,
				smart_money: summary.smartMoney,
				connectivity: summary.connectivity != null ? summary.connectivity.toFixed(3) : null,
				clusters: summary.clusters,
				buyers: summary.buyers,
			});
		} catch (err) {
			log.error?.('intel finalize failed', { mint, err: err?.message });
		}
	}

	function connect() {
		if (!active) return;
		ws = new WebSocket(pumpPortalWsUrl());

		ws.on('open', () => {
			send({ method: 'subscribeNewToken' });
			// Re-subscribe trades for anything still mid-observation after a reconnect.
			const keys = [...observations.keys()];
			if (keys.length) send({ method: 'subscribeTokenTrade', keys });
			log.info?.('intel watcher connected', { network, watching: keys.length });
		});

		ws.on('message', (raw) => {
			if (!active) return;
			let msg;
			try { msg = JSON.parse(raw.toString()); } catch { return; }
			if (handlePumpPortalAck(msg, (line) => log.warn?.(line))) return;
			if (msg.txType === 'create') startObservation(msg);
			else if (msg.txType === 'buy' || msg.txType === 'sell') recordTrade(msg);
		});

		ws.on('error', (err) => log.warn?.('intel watcher ws error', { err: err?.message }));
		ws.on('close', () => {
			if (!active) return;
			reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
		});
	}

	// Periodic visibility into dropped observations (no silent caps — Rule).
	const dropTimer = setInterval(() => {
		if (droppedSinceLog > 0) {
			log.warn?.('intel watcher at capacity — dropped observations', {
				dropped: droppedSinceLog, watching: observations.size, cap: maxConcurrent,
			});
			droppedSinceLog = 0;
		}
	}, 60_000);
	signal?.addEventListener('abort', () => clearInterval(dropTimer));

	connect();
	return () => { clearInterval(dropTimer); stop(); };
}
