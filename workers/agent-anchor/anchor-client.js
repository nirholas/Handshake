// anchor-client.js — live integrations for the Newsroom Anchor worker.
//
// Pulls the three real intel feeds, asks the brain to script the bulletin, and
// stores the spoken script so the browser can fetch + speak it. Every call is a
// real three.ws API call (no mocks): aixbt narrative intel, the pump.fun-backed
// sentiment pulse, a live token snapshot, the multi-LLM brain router, and the
// Redis-backed anchor-script store.

import { mergeBrief, buildAnchorMessages } from './brief.js';

const API_BASE = (process.env.ANCHOR_API_BASE || process.env.API_BASE || 'https://three.ws').replace(/\/$/, '');
const AGENT_JWT = process.env.AGENT_JWT;
const AGENT_ID = process.env.AGENT_ID;
// $THREE is the only coin — its sentiment + flow are the anchor's house ticker.
// Overridable for non-prod runs; defaults to the canonical $THREE mint.
const TOKEN_MINT = process.env.ANCHOR_TOKEN_MINT || 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
// Free, anon-allowed brain provider so the worker never burns a billed key.
const BRAIN_PROVIDER = process.env.ANCHOR_BRAIN_PROVIDER || 'gpt-oss-120b';

async function getJson(path, opts = {}) {
	const url = /^https?:\/\//.test(path) ? path : `${API_BASE}${path}`;
	const res = await fetch(url, {
		...opts,
		signal: AbortSignal.timeout(opts.timeoutMs || 12_000),
	});
	if (!res.ok) throw new Error(`${path} → ${res.status}`);
	return res.json();
}

/** aixbt narrative intel — the spine of every bulletin. */
async function fetchIntel() {
	try {
		return await getJson(`/api/aixbt/intel?limit=12`);
	} catch {
		return null;
	}
}

/** Sentiment pulse for the house ticker (pump.fun comments, no key needed). */
async function fetchSentiment() {
	try {
		return await getJson(`/api/social/sentiment-pulse`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: TOKEN_MINT, limit: 100 }),
			timeoutMs: 15_000,
		});
	} catch {
		return null;
	}
}

/**
 * Live market snapshot for the house ticker, shaped to what mergeBrief expects.
 * Reads Dexscreener directly — the same public, key-free source the pump_snapshot
 * MCP tool uses for price/volume — and picks the highest-volume pair.
 */
async function fetchPump() {
	try {
		const data = await getJson(
			`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(TOKEN_MINT)}`,
		);
		const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
		if (!pairs.length) return null;
		const pair = pairs.reduce(
			(best, p) => (Number(p?.volume?.h24 || 0) > (best?.vol || 0) ? { p, vol: Number(p.volume.h24) } : best),
			null,
		)?.p;
		if (!pair) return null;
		return {
			priceUsd: pair.priceUsd != null ? Number(pair.priceUsd) : null,
			price: { priceChange24hPct: pair.priceChange?.h24 ?? null },
			volume24h: { volume24hUsd: Number(pair.volume?.h24 || 0), dex: pair.dexId || null },
			meta: { name: pair.baseToken?.name || null, symbol: pair.baseToken?.symbol || null },
		};
	} catch {
		return null;
	}
}

/** Fetch all three feeds concurrently and merge into an anchor briefing. */
export async function gatherBrief() {
	const [intel, sentiment, pump] = await Promise.all([
		fetchIntel(),
		fetchSentiment(),
		fetchPump(),
	]);
	return mergeBrief({ intel, sentiment, pump });
}

/**
 * Script the bulletin via POST /api/brain/chat (SSE). Accumulates the streamed
 * text fragments into the full anchor read. Throws on an upstream error event.
 */
export async function scriptBulletin(brief) {
	const { system, messages } = buildAnchorMessages(brief);
	const res = await fetch(`${API_BASE}/api/brain/chat`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(AGENT_JWT ? { authorization: `Bearer ${AGENT_JWT}` } : {}),
		},
		body: JSON.stringify({ provider: BRAIN_PROVIDER, system, messages, maxTokens: 400 }),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok || !res.body) throw new Error(`brain/chat → ${res.status}`);

	let buf = '';
	let out = '';
	let errMsg = null;
	const decoder = new TextDecoder();
	for await (const chunk of res.body) {
		buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
		const events = buf.split('\n\n');
		buf = events.pop() || '';
		for (const ev of events) {
			let event = 'message';
			const dataLines = [];
			for (const line of ev.split('\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
			}
			const data = dataLines.join('\n');
			if (!data) continue;
			if (event === 'error') {
				try { errMsg = JSON.parse(data).message; } catch { errMsg = data; }
				continue;
			}
			if (event === 'done' || data === '[DONE]') continue;
			if (event === 'meta' || event === 'first' || event === 'fallback') continue;
			// Data-only chunk: a JSON-encoded text fragment.
			try {
				const frag = JSON.parse(data);
				if (typeof frag === 'string') out += frag;
			} catch { /* skip non-JSON keepalive lines */ }
		}
	}
	if (!out.trim() && errMsg) throw new Error(errMsg);
	if (!out.trim()) throw new Error('empty anchor script');
	return out.trim();
}

/**
 * Store the spoken script so the browser can fetch it via GET /api/agent/
 * anchor-script. Posts to the same endpoint (authenticated) which writes Redis.
 */
export async function publishScript({ headline, body, brief }) {
	if (!AGENT_JWT || !AGENT_ID) return;
	try {
		await fetch(`${API_BASE}/api/agent/anchor-script`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_JWT}` },
			body: JSON.stringify({
				agentId: AGENT_ID,
				headline,
				body,
				offline: brief?.offline || [],
			}),
			signal: AbortSignal.timeout(8_000),
		});
	} catch { /* non-fatal — the headline frame still renders */ }
}
