// Pure formatting and interpretation helpers for /trading.
//
// Kept out of trading-hub.js so the interesting logic (what counts as a healthy
// fleet, how a sparkline is drawn, how a null renders) is unit-testable without
// a DOM or a network. No imports, no side effects.

/** A dot that is not a number renders as a neutral placeholder, never as 0. */
const PLACEHOLDER = '·';

/**
 * Is this a value we can honestly render as a number?
 *
 * The trap it closes: Number(null) and Number('') are both 0, so a bare
 * Number.isFinite() check accepts a missing datapoint and renders it as a real
 * zero. Nullish is rejected before coercion, never after.
 *
 * @param {unknown} n
 * @returns {boolean}
 */
export function isNumeric(n) {
	// Objects coerce too eagerly to trust: Number([]) is 0 and Number(['7']) is 7,
	// so an accidental array of one would print as a real reading.
	if (typeof n !== 'number' && typeof n !== 'string') return false;
	if (n === '') return false;
	return Number.isFinite(Number(n));
}

/**
 * Format lamport-derived SOL for display.
 * @param {number|string|null|undefined} n
 * @param {{signed?: boolean}} [opts] signed prefixes a positive value with "+"
 * @returns {string}
 */
export function formatSol(n, { signed = true } = {}) {
	if (!isNumeric(n)) return PLACEHOLDER;
	const v = Number(n);
	// Small balances need more places or every row reads "0.000 SOL".
	const places = Math.abs(v) < 0.01 && v !== 0 ? 4 : 3;
	return `${signed && v > 0 ? '+' : ''}${v.toFixed(places)} SOL`;
}

/**
 * Format a percentage for display.
 * @param {number|string|null|undefined} n
 * @param {{signed?: boolean}} [opts]
 * @returns {string}
 */
export function formatPct(n, { signed = true } = {}) {
	if (!isNumeric(n)) return PLACEHOLDER;
	const v = Number(n);
	return `${signed && v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/**
 * Human "time since" for an ISO timestamp.
 * @param {string|null|undefined} iso
 * @param {number} [now] epoch ms, injectable so tests do not depend on the clock
 * @returns {string}
 */
export function formatAgo(iso, now = Date.now()) {
	if (!iso) return 'never';
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return 'never';
	const ms = now - t;
	if (ms < 0) return 'just now';
	if (ms < 60_000) return 'just now';
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
	return `${Math.round(ms / 86_400_000)}d ago`;
}

/**
 * Duration since boot, in the coarsest unit that still reads honestly.
 * @param {string|null|undefined} iso
 * @param {number} [now]
 * @returns {string}
 */
export function formatUptime(iso, now = Date.now()) {
	if (!iso) return PLACEHOLDER;
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return PLACEHOLDER;
	const ms = now - t;
	if (ms < 0) return PLACEHOLDER;
	if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Interpret the `solvency` block of a /api/sniper/status payload.
 *
 * Liveness is not solvency. Between 2026-07-29 and 2026-08-08 the fleet booked
 * over a thousand failed entries and closed nothing while every liveness check
 * stayed green: the process was up, the feed was connected, and the wallets
 * were too poor to place a single buy. The worker publishes the per-wallet
 * verdict for exactly that reason (api/_lib/sniper-solvency.js), so this page
 * renders it as a first-class vital rather than a footnote.
 *
 * @param {object|null|undefined} solvency the `solvency` object from /api/sniper/status
 * @returns {{tone: string, label: string, sub: string, detail: string}}
 */
export function describeSolvency(solvency) {
	const s = solvency && typeof solvency === 'object' ? solvency : null;
	const agents = Number(s?.agents);
	if (!s || !Number.isFinite(agents) || agents === 0) {
		return {
			tone: 'muted',
			label: PLACEHOLDER,
			sub: 'No wallet balances measured yet',
			detail: 'The worker has not reported armed wallet balances yet, so nothing is claimed here.',
		};
	}

	const tradeable = Number(s.tradeable ?? 0);
	const starved = Number(s.starved ?? 0);
	const shrunk = Number(s.shrunk ?? 0);
	const deficit = Number(s.deficitSol);
	const fix =
		s.masterCanCover === true
			? ' The funding wallet can refill them automatically.'
			: s.masterCanCover === false
				? ' The funding wallet cannot cover that, so a person has to move SOL in.'
				: '';
	const need = Number.isFinite(deficit) && deficit > 0 ? ` Refilling them needs ${deficit.toFixed(3)} SOL.${fix}` : '';

	if (s.state === 'starved') {
		return {
			tone: 'down',
			label: `0 of ${agents} can trade`,
			sub: 'No wallet can afford an entry',
			detail: `Every armed wallet is below the minimum entry size, so the fleet takes no trades no matter what the feed shows.${need}`,
		};
	}
	if (s.state === 'degraded') {
		return {
			tone: 'warn',
			label: `${tradeable} of ${agents} can trade`,
			sub: `${starved} starved, ${shrunk} sized down`,
			detail: `Some armed wallets cannot place their configured size. A starved wallet is skipped entirely; a shrunk one still trades, just smaller.${need}`,
		};
	}
	return {
		tone: 'live',
		label: `${agents} of ${agents} can trade`,
		sub: 'Every armed wallet is funded',
		detail: 'Every armed wallet holds enough SOL to place its configured position size.',
	};
}

/**
 * Interpret a /api/sniper/status payload into display state.
 *
 * Two distinctions matter, and both are failures that look identical to
 * "healthy" on a naive check:
 *
 *   · a worker can beat steadily while its launch feed has gone quiet, in which
 *     case it sees nothing, so feed health is reported separately; and
 *   · a worker can be up, connected and armed while no wallet can afford an
 *     entry, so solvency outranks the feed checks.
 *
 * The endpoint already resolves that precedence into `state`
 * ('down' | 'starved' | 'degraded' | 'live', see deriveSniperState in
 * api/_lib/sniper-solvency.js), so this trusts that verdict rather than
 * re-deriving a second opinion that could disagree with the source. Older
 * payloads without `state` fall back to the mode-and-feed reading.
 *
 * @param {object|null|undefined} status
 * @returns {{tone: string, label: string, detail: string, feedTone: string,
 *            feedLabel: string, feedDetail: string, uptimeLabel: string,
 *            solvency: {tone: string, label: string, sub: string, detail: string}}}
 */
export function describeFleet(status, now = Date.now()) {
	const s = status || {};
	const mode = s.mode === 'live' ? 'live' : s.mode === 'simulate' ? 'simulate' : null;
	const killed = s.globalKill === true;
	const feedLive = s.feedLive === true;
	const feedSilent = s.feedSilent === true;
	const solvency = describeSolvency(s.solvency);

	let feedTone = 'muted';
	let feedLabel = 'Unknown';
	let feedDetail = 'The worker did not report feed state.';
	if (feedLive && !feedSilent) {
		feedTone = 'live';
		feedLabel = 'Connected';
		const age = Number(s.lastEventAgeMs);
		feedDetail = Number.isFinite(age)
			? `Last launch seen ${Math.max(0, Math.round(age / 1000))}s ago`
			: 'Receiving launches';
	} else if (feedSilent) {
		feedTone = 'warn';
		feedLabel = 'Silent';
		feedDetail = 'Connected but no launches are arriving.';
	} else if (s.feedLive === false) {
		feedTone = 'down';
		feedLabel = 'Disconnected';
		feedDetail = 'The worker is not receiving launches.';
	}

	const armed = `${s.strategies ?? 0} strategies armed, ${s.openPositions ?? 0} open.`;
	let tone = 'unknown';
	let label = 'Fleet status unknown';
	let detail = 'The status endpoint returned no recognizable state.';

	if (killed) {
		// The owner's own switch outranks every measurement: nothing else the
		// worker reports changes the fact that no entry will be taken.
		tone = 'down';
		label = 'Fleet halted';
		detail = 'The global kill switch is on. No new entries will be taken.';
	} else if (s.state === 'down') {
		tone = 'down';
		label = 'Worker offline';
		detail = 'The worker has stopped reporting. No entries and no exits are being taken.';
	} else if (s.state === 'starved') {
		tone = 'down';
		label = 'Out of SOL';
		detail = `The fleet is running but no wallet can afford an entry. ${solvency.detail}`;
	} else if (s.state === 'degraded') {
		// 'degraded' has two very different causes and the page is useless if it
		// blames the wrong one, so name the one that actually fired.
		const solvencyCause = s.solvency?.state === 'degraded';
		tone = 'warn';
		label = solvencyCause && feedTone === 'live' ? 'Live, wallets underfunded' : 'Live, feed degraded';
		detail = `${armed} ${solvencyCause ? solvency.detail : feedDetail}`;
	} else if (s.state === 'live') {
		tone = 'live';
		label = mode === 'simulate' ? 'Simulating' : 'Trading live';
		detail =
			mode === 'simulate'
				? `Real quotes, no broadcast. ${s.strategies ?? 0} strategies armed.`
				: `${armed} ${feedDetail}`;
	} else if (mode === 'live') {
		tone = feedTone === 'live' ? 'live' : 'warn';
		label = feedTone === 'live' ? 'Trading live' : 'Live, feed degraded';
		detail = `${armed} ${feedDetail}`;
	} else if (mode === 'simulate') {
		tone = 'muted';
		label = 'Simulating';
		detail = `Real quotes, no broadcast. ${s.strategies ?? 0} strategies armed.`;
	}

	return {
		tone,
		label,
		detail,
		feedTone,
		feedLabel,
		feedDetail,
		uptimeLabel: formatUptime(s.bootAt, now),
		solvency,
	};
}

/**
 * Build an SVG path for a cumulative profit-and-loss sparkline.
 *
 * Returns an empty string when there is nothing honest to draw (fewer than two
 * points), so the caller can omit the element entirely rather than render a
 * flat line that implies a result the data does not contain.
 *
 * @param {Array<number>} series
 * @param {number} w
 * @param {number} h
 * @returns {string} an SVG path "d" attribute, or "" when undrawable
 */
export function sparkPath(series, w = 120, h = 32) {
	if (!Array.isArray(series)) return '';
	// Drop nullish and empty entries BEFORE coercing. Number(null) and Number('')
	// are both 0, so mapping first would turn a missing datapoint into a real
	// zero and bend the line toward a value the series never contained.
	const pts = series
		.filter((v) => v !== null && v !== undefined && v !== '')
		.map(Number)
		.filter((n) => Number.isFinite(n));
	if (pts.length < 2) return '';
	const min = Math.min(...pts);
	const max = Math.max(...pts);
	const pad = 2;
	const usableH = Math.max(1, h - pad * 2);
	// A flat series has no range to normalize against; draw it down the middle
	// instead of dividing by zero.
	const range = max - min;
	const x = (i) => (i / (pts.length - 1)) * w;
	const y = (v) => (range === 0 ? h / 2 : pad + usableH - ((v - min) / range) * usableH);
	return pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
}
