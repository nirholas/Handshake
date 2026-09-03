// Live Trading Theater — the real event spine.
//
// Every confirmed action on three.ws (a coin buy, an agent going on-chain, an
// x402 payment, a new agent) is published to the capped Redis list `feed:events`
// (api/_lib/feed.js) and tailed by GET /api/feed-stream (SSE). This module owns
// that connection: a fast snapshot from GET /api/feed for first paint, then the
// live stream, normalised into one shape the theater can route to a performer.
//
// Nothing here invents activity. If the stream is quiet, the theater shows its
// quiet-market state from the real recent snapshot — never a fabricated bot.

const SOL_EXPLORER = 'https://solscan.io';

function solscanToken(mint, network) {
	const base = `${SOL_EXPLORER}/token/${encodeURIComponent(mint)}`;
	return network === 'devnet' ? `${base}?cluster=devnet` : base;
}

function fmtSol(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return null;
	return `${v >= 100 ? Math.round(v) : v.toFixed(v < 1 ? 3 : 2)} SOL`;
}
function fmtUsdc(atomic) {
	const v = Number(atomic) / 1e6;
	if (!Number.isFinite(v)) return null;
	return `$${v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2)}`;
}
function shortMint(m) {
	return typeof m === 'string' && m.length > 10 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m || '';
}

/**
 * Normalise a raw feed event into the theater's routing shape, or null for an
 * event type the stage doesn't visualise (it still reaches the ticker raw).
 *
 *   { id, ts, type, kind, actor, agentId, mint, title, sub, href }
 *   kind ∈ buy | launch | verify | pay | win | loss | misc
 */
export function normalizeEvent(e) {
	if (!e || !e.type) return null;
	const base = {
		id: e.id || `${e.ts || Date.now()}-${Math.abs((e.type || '').length)}`,
		ts: Number(e.ts) || Date.now(),
		type: e.type,
		actor: typeof e.actor === 'string' ? e.actor : '',
		agentId: null,
		mint: null,
		href: null,
		// Numeric magnitudes (when the event carries them) so the stage can size the
		// spectacle to the real fill and the receipt can show the money.
		sol: Number.isFinite(Number(e.sol)) ? Number(e.sol) : null,
		usd: null,
		symbol: typeof e.symbol === 'string' ? e.symbol : null,
	};
	switch (e.type) {
		case 'coin-buy':
			return { ...base, kind: 'buy', mint: e.mint || null, title: 'Buy filled', sub: fmtSol(e.sol) || shortMint(e.mint), href: e.mint ? solscanToken(e.mint, e.network) : null };
		case 'agent-deploy':
			return { ...base, kind: 'launch', agentId: e.agentId || null, title: 'New agent', sub: e.name || base.actor, href: e.agentId ? `/agents/${e.agentId}` : null };
		case 'agent-onchain':
			return { ...base, kind: 'verify', agentId: e.agentId || null, title: 'Verified on-chain', sub: e.name || base.actor, href: e.agentId ? `/agents/${e.agentId}` : null };
		case 'payment':
			return { ...base, kind: 'pay', title: 'Payment', usd: Number.isFinite(Number(e.usdcAtomic)) ? Number(e.usdcAtomic) / 1e6 : null, sub: fmtUsdc(e.usdcAtomic) || e.recipientLabel || base.actor, href: e.explorerUrl || null };
		case 'jackpot':
			return { ...base, kind: 'win', title: 'Jackpot', sub: e.reward ? `${e.reward}` : base.actor, href: null };
		case 'agent-guard':
			// A safety refusal — an agent declined a bad buy. Shown in the tape (not
			// as a performance) so watchers see the platform's guardrails working.
			return { ...base, kind: 'guard', agentId: e.agentId || null, title: `${base.actor || 'Agent'} ${e.label || 'skipped an unsafe buy'}`, sub: e.mint ? shortMint(e.mint) : (e.reason || 'safety'), href: e.agentId ? `/agents/${e.agentId}` : (e.mint ? solscanToken(e.mint, e.network) : null) };
		case 'agora-registered':
			return { ...base, kind: 'launch', title: 'Agora citizen joined', sub: base.actor, href: e.citizenId ? `/agora?citizen=${e.citizenId}` : '/agora' };
		case 'agora-task-claimed':
			return { ...base, kind: 'misc', title: `${base.actor} claimed a job`, sub: e.profession || 'Fetcher', href: e.explorerUrl || (e.citizenId ? `/agora?citizen=${e.citizenId}` : '/agora') };
		case 'agora-task-completed':
			return { ...base, kind: 'verify', title: `${base.actor} proved a job`, sub: e.profession || 'Fetcher', href: e.explorerUrl || (e.citizenId ? `/agora?citizen=${e.citizenId}` : '/agora') };
		case 'agora-arena-entered':
			return { ...base, kind: 'misc', title: `${base.actor} entered the Arena`, sub: e.profession || 'Fetcher', href: e.explorerUrl || (e.citizenId ? `/agora?citizen=${e.citizenId}` : '/agora') };
		case 'agora-arena-won':
			return { ...base, kind: 'win', title: `${base.actor} won the Arena`, sub: e.rewardLabel || e.profession || 'Fetcher', href: e.explorerUrl || (e.citizenId ? `/agora?citizen=${e.citizenId}` : '/agora') };
		case 'agora-arena-lost':
			return { ...base, kind: 'misc', title: `${base.actor} was outraced`, sub: e.profession || 'Fetcher', href: e.explorerUrl || (e.citizenId ? `/agora?citizen=${e.citizenId}` : '/agora') };
		case 'agora-guild-joined':
			return { ...base, kind: 'misc', title: `${base.actor} joined a guild job`, sub: e.profession || 'Fetcher', href: e.explorerUrl || (e.citizenId ? `/agora?citizen=${e.citizenId}` : '/agora') };
		case 'agora-guild-contributed':
			return { ...base, kind: 'verify', title: `${base.actor} contributed to a guild job`, sub: e.rewardLabel || e.profession || 'Fetcher', href: e.explorerUrl || (e.citizenId ? `/agora?citizen=${e.citizenId}` : '/agora') };
		case 'agora-earned':
			return { ...base, kind: 'pay', title: `${base.actor} earned`, sub: e.rewardLabel || base.actor, href: e.explorerUrl || (e.citizenId ? `/agora?citizen=${e.citizenId}` : '/agora') };
		default:
			return { ...base, kind: 'misc', title: e.type.replace(/-/g, ' '), sub: base.actor, href: null };
	}
}

/**
 * Fetch the recent feed snapshot for first paint (quiet-market highlights and
 * the replay seed). Returns normalised events newest-first.
 */
export async function loadSnapshot(limit = 40, { timeout = 8000 } = {}) {
	// Time-bounded like every other fetch on this page: a black-holed edge must
	// resolve to the designed "no recent activity" copy, never leave the tape and
	// the quiet card blank behind a promise that never settles.
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeout);
	try {
		const r = await fetch(`/api/feed?limit=${limit}`, { headers: { accept: 'application/json' }, signal: ctrl.signal });
		if (!r.ok) return [];
		const body = await r.json();
		const events = Array.isArray(body.events) ? body.events : [];
		return events.map(normalizeEvent).filter(Boolean);
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Open the live SSE stream. Calls onEvent(normalized) for each fresh event and
 * onStatus('connecting'|'live'|'reconnecting'|'offline') on connection changes.
 * EventSource reconnects automatically; we surface that as 'reconnecting' so the
 * UI never shows stale data as live. Returns { close }.
 */
export function connectFeed({ onEvent, onStatus, connectDeadline = 15000 }) {
	if (typeof EventSource === 'undefined') {
		onStatus?.('offline');
		return { close() {} };
	}
	let es = null;
	let closed = false;
	let firstOpen = true;
	// A stream that never opens (a buffering proxy, a middlebox that eats
	// text/event-stream) fires no error and no open, so the pill would claim
	// "Connecting" for the rest of the session. Bound the wait and tell the truth.
	let deadline = null;
	const clearDeadline = () => { if (deadline) { clearTimeout(deadline); deadline = null; } };
	const goLive = () => { clearDeadline(); firstOpen = false; onStatus?.('live'); };

	const open = () => {
		if (closed) return;
		onStatus?.(firstOpen ? 'connecting' : 'reconnecting');
		clearDeadline();
		deadline = setTimeout(() => { if (!closed) onStatus?.('reconnecting'); }, connectDeadline);
		es = new EventSource('/api/feed-stream');
		es.addEventListener('hello', goLive);
		es.addEventListener('open', goLive);
		es.addEventListener('event', (ev) => {
			let raw;
			try { raw = JSON.parse(ev.data); } catch { return; }
			const n = normalizeEvent(raw);
			if (n) onEvent?.(n);
		});
		es.onerror = () => {
			// EventSource transitions to CLOSED only on fatal errors; for transient
			// drops it retries on its own. Surface 'reconnecting' either way.
			clearDeadline();
			onStatus?.('reconnecting');
			if (es && es.readyState === EventSource.CLOSED && !closed) {
				try { es.close(); } catch {}
				setTimeout(open, 2500);
			}
		};
	};
	open();

	return {
		close() {
			closed = true;
			clearDeadline();
			try { es?.close(); } catch {}
		},
	};
}
