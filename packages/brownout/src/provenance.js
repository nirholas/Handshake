// Read the Brownout headers off any response.
//
// The wire format is two headers, both single-line ASCII, both stable:
//
//   x-brownout:       v=1;tier=stale;sources=3;ok=1;failed=2;ms=512;degraded=1
//   x-brownout-trace: birdeye;o=429;t=412, tokens-xyz;o=timeout;t=8000, dex;o=ok;t=88
//
// The summary is always present on a response that touched an upstream. The
// trace appears only when something degraded, so a healthy response stays cheap.

/** @typedef {'live'|'cache'|'stale'|'fallback'} Tier */
/** @typedef {{ name: string, outcome: string, ms: number }} TraceEntry */
/**
 * @typedef {object} Provenance
 * @property {Tier|null} tier      worst freshness that contributed to the answer
 * @property {boolean} degraded    something failed over, or the answer is not fresh
 * @property {number} ok           sources that contributed
 * @property {number} failed       sources that did not answer
 * @property {number} sources      total sources touched
 * @property {number|null} ms      wall time spent inside the handler
 * @property {TraceEntry[]} trace  per-source breakdown, empty unless degraded
 */

/** Freshness lattice, best first. A response is only as fresh as its least fresh source. */
export const TIERS = /** @type {const} */ (['live', 'cache', 'stale', 'fallback']);

/**
 * Parse the Brownout headers from a `Response`, a `Headers`, or a plain object.
 *
 * Returns null when the response carries no summary, which is a real state
 * rather than an error: it means the request was answered without touching any
 * instrumented upstream.
 *
 * @param {Response|Headers|Record<string,string>} source
 * @returns {Provenance|null}
 */
export function parseProvenance(source) {
	const headers = source && typeof source === 'object' && 'headers' in source ? source.headers : source;
	const get = (name) => {
		if (!headers) return '';
		if (typeof headers.get === 'function') return headers.get(name) || '';
		const lower = name.toLowerCase();
		for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return String(v);
		return '';
	};

	const summary = get('x-brownout');
	if (!summary) return null;

	const fields = Object.create(null);
	for (const pair of summary.split(';')) {
		const idx = pair.indexOf('=');
		if (idx < 0) continue;
		fields[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
	}

	const raw = get('x-brownout-trace');
	const trace = raw
		? raw
				.split(',')
				.map((entry) => {
					const parts = entry.split(';').map((p) => p.trim());
					const ms = Number((parts.find((p) => p.startsWith('t=')) || 't=0').slice(2));
					return {
						name: parts[0] || '',
						outcome: (parts.find((p) => p.startsWith('o=')) || 'o=').slice(2),
						ms: Number.isFinite(ms) ? ms : 0,
					};
				})
				.filter((e) => e.name)
		: [];

	const num = (key) => {
		const n = Number(fields[key]);
		return Number.isFinite(n) ? n : 0;
	};

	return {
		tier: TIERS.includes(fields.tier) ? fields.tier : null,
		degraded: fields.degraded === '1',
		ok: num('ok'),
		failed: num('failed'),
		sources: num('sources'),
		ms: fields.ms ? num('ms') : null,
		trace,
	};
}

/**
 * True when the answer is not fresh: it came from a stale tier or from a
 * different provider than the one asked for.
 *
 * Distinct from `degraded`, which is also true when a source merely failed over
 * and a live one answered. Use this to decide whether to CAPTION a number
 * ("as of 20 minutes ago"); use `degraded` to decide whether to log or alert.
 *
 * @param {Provenance|null} prov
 * @returns {boolean}
 */
export function isStale(prov) {
	return prov?.tier === 'stale' || prov?.tier === 'fallback';
}

/**
 * The sources that did not answer, in the order they were tried.
 * @param {Provenance|null} prov
 * @returns {TraceEntry[]}
 */
export function failedSources(prov) {
	return (prov?.trace || []).filter((e) => e.outcome !== 'ok');
}

/**
 * A one-line human summary, for a log line or a status pill.
 * @param {Provenance|null} prov
 * @returns {string}
 */
export function describeProvenance(prov) {
	if (!prov) return 'no upstream was touched';
	const bits = [`tier=${prov.tier || 'unknown'}`];
	if (prov.failed) bits.push(`${prov.failed} source${prov.failed === 1 ? '' : 's'} failed`);
	if (prov.ms != null) bits.push(`${prov.ms}ms`);
	const names = failedSources(prov).map((e) => `${e.name}(${e.outcome})`);
	if (names.length) bits.push(`refused: ${names.join(', ')}`);
	return bits.join(', ');
}
