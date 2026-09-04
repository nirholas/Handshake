/**
 * Poll primitives for long-running generations on flaky mobile networks.
 *
 * A 3D generation runs for minutes. On a phone that means the tab gets
 * backgrounded, the radio drops, and the edge answers the occasional 502, none
 * of which mean the job died, because every byte of job state lives on the
 * server. A naive `while (…) { await sleep(); await fetch(); }` loop loses the
 * finished model to any one of them:
 *
 *   • a bare `fetch` rejects with a TypeError the moment the socket drops, and
 *     the rejection escapes the loop as a hard failure;
 *   • a transient 5xx / 429 reads the same as a dead job;
 *   • background tabs get their timers clamped to a minute or more, so wall
 *     time keeps running while almost no polls happen, and a run budget
 *     measured in wall time expires on a job the server is still finishing;
 *   • coming back to the foreground then sits on a stale screen until the
 *     clamped timer finally fires.
 *
 * These three helpers fix all four. `src/forge.js` and `src/home-forge.js` both
 * build their poll loops on them.
 *
 * @example
 * const hidden = createHiddenClock();
 * const runNow = () => performance.now() - hidden.hiddenMs();
 * let deadline = runNow() + 12 * 60 * 1000;
 * let backoff = 2500;
 * try {
 *   while (runNow() < deadline) {
 *     await sleepUntilVisibleOrElapsed(backoff);
 *     let data;
 *     try {
 *       data = await fetchJobStatus(`/api/forge?job=${id}`);
 *     } catch (err) {
 *       if (err.kind !== 'transport') throw err;
 *       backoff = nextBackoff(backoff, 20_000);
 *       continue;
 *     }
 *     if (data.status === 'done') return data;
 *   }
 * } finally {
 *   hidden.stop();
 * }
 */

/**
 * Sleep that also wakes the moment the tab returns to the foreground, or the
 * moment the device regains connectivity.
 *
 * Two separate stalls, one primitive. Waking on `visibilitychange` means a
 * finished generation is on screen as soon as the user looks at the tab again,
 * rather than after the browser's clamped background timer fires. Waking on
 * `online` matters on exactly the network this whole module exists for: a phone
 * that loses its radio in a lift or a tunnel has already been pushed to a 20 s
 * backoff by the time it comes back, so without this the user watches a
 * "connection dropped" notice for most of a minute after their signal returned.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleepUntilVisibleOrElapsed(ms) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('online', finish);
			resolve();
		};
		const onVisibility = () => {
			if (document.visibilityState === 'visible') finish();
		};
		const timer = setTimeout(finish, ms);
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('online', finish);
	});
}

/**
 * Tracks how long the tab has spent hidden. Subtract it from `performance.now()`
 * to get foreground-only elapsed time, so backgrounding a generation can never
 * expire its run budget.
 *
 * Call `stop()` when the poll finishes; the clock holds a document listener.
 *
 * @returns {{ hiddenMs: () => number, stop: () => void }}
 */
export function createHiddenClock() {
	let hiddenTotal = 0;
	let hiddenSince = document.visibilityState === 'hidden' ? performance.now() : 0;
	const onVisibility = () => {
		if (document.visibilityState === 'hidden') {
			if (!hiddenSince) hiddenSince = performance.now();
		} else if (hiddenSince) {
			hiddenTotal += performance.now() - hiddenSince;
			hiddenSince = 0;
		}
	};
	document.addEventListener('visibilitychange', onVisibility);
	return {
		hiddenMs: () => hiddenTotal + (hiddenSince ? performance.now() - hiddenSince : 0),
		stop: () => document.removeEventListener('visibilitychange', onVisibility),
	};
}

/**
 * One status request against a job endpoint. Transport-shaped failures (dropped
 * socket, edge 5xx, rate-limit bounce) reject with `err.kind === 'transport'` so
 * the caller can retry them on backoff instead of treating them as a dead job.
 * Every other response resolves to its parsed JSON body (an unparseable body
 * resolves to `{}`, which reads as "no status yet" to every caller).
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchJobStatus(url, init = {}) {
	let res;
	try {
		res = await fetch(url, { cache: 'no-store', ...init });
	} catch (err) {
		const e = new Error(err?.message || 'Network request failed.');
		e.kind = 'transport';
		throw e;
	}
	if (res.status >= 500 || res.status === 429) {
		const e = new Error(`Status check returned HTTP ${res.status}.`);
		e.kind = 'transport';
		throw e;
	}
	return res.json().catch(() => ({}));
}

/**
 * Next interval for an exponential backoff, jittered so a fleet of tabs coming
 * back from the same outage does not retry in lockstep.
 *
 * @param {number} current  the interval just used, in ms
 * @param {number} ceiling  hard cap, in ms
 * @returns {number}
 */
export function nextBackoff(current, ceiling) {
	const doubled = Math.min(current * 2, ceiling);
	return Math.round(doubled * (0.85 + Math.random() * 0.3));
}
