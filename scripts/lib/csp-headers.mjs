// Comparing the security headers a response carried against the ones the route
// table declares for it.
//
// The comparison is subtle enough to deserve its own home and its own tests:
// `server/csp-hashes.mjs` rewrites `script-src` per response, so a served
// policy is allowed to differ from the declared one in exactly one way, and
// only on the responses that get rewritten. Everything else about a security
// header has to arrive byte-for-byte or the site is not serving what the repo
// says it serves.
//
// Used by scripts/audit-csp.mjs. Pure functions: no network, no route table,
// no filesystem.

/** The security headers a document is expected to carry, whatever else it declares. */
export const REQUIRED_ON_HTML = [
	'content-security-policy',
	'strict-transport-security',
	'x-content-type-options',
	'referrer-policy',
];

/** "a 'b' c; d 'e'" -> Map{ a => Set{'b','c'}, d => Set{'e'} } */
export function parsePolicy(value) {
	const directives = new Map();
	for (const chunk of String(value).split(';')) {
		const parts = chunk.trim().split(/\s+/).filter(Boolean);
		if (!parts.length) continue;
		directives.set(parts[0].toLowerCase(), new Set(parts.slice(1)));
	}
	return directives;
}

const setsEqual = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

/**
 * Differences between the policy the route table declares and the one the
 * response carried, allowing only the rewrite server/csp-hashes.mjs performs:
 * within script-src / script-src-elem, `'unsafe-inline'` is replaced by any
 * number of `'sha256-…'` sources. Everything else must survive byte-for-byte.
 *
 * The rewrite is only applied to documents, so it is only required of them.
 * `sha256Rewritten` says whether this response is one the server hardens: for a
 * document it is demanded (a page that shipped the raw `'unsafe-inline'` policy
 * is exactly the regression this comparison exists to catch), and for
 * everything else (robots.txt, llms.txt, the .well-known JSON, an API response)
 * the declared policy has to arrive untouched instead.
 */
export function policyDiff(declared, served, sha256Rewritten) {
	const want = parsePolicy(declared);
	const got = parsePolicy(served);
	const problems = [];
	for (const [name, wantSources] of want) {
		const gotSources = got.get(name);
		if (!gotSources) {
			problems.push(`directive "${name}" is missing from the served policy`);
			continue;
		}
		const hashable = name === 'script-src' || name === 'script-src-elem';
		const expected = new Set(wantSources);
		const actual = new Set(gotSources);
		if (hashable && sha256Rewritten) {
			expected.delete("'unsafe-inline'");
			for (const src of [...actual]) if (src.startsWith("'sha256-")) actual.delete(src);
		}
		if (setsEqual(expected, actual)) continue;
		const missing = [...expected].filter((s) => !actual.has(s));
		const extra = [...actual].filter((s) => !expected.has(s));
		problems.push(
			`directive "${name}" differs${missing.length ? ` (missing ${missing.join(' ')})` : ''}` +
				`${extra.length ? ` (unexpected ${extra.join(' ')})` : ''}`,
		);
	}
	return problems;
}

/**
 * Every way a response's security headers fail to be what the route table says
 * this path serves. `declared` is the resolved header bag from vercel.json,
 * `served` the response's own headers; both keyed lowercase.
 */
export function headerProblems(declared, served) {
	const problems = [];

	for (const name of REQUIRED_ON_HTML) {
		if (!declared[name]) problems.push(`vercel.json declares no ${name} for this path`);
	}

	// Only documents get their script-src rewritten into hashes; a text or JSON
	// response carries the declared policy verbatim, and a response that carries
	// hashes proves the rewrite ran even if its content type is unusual.
	const isDocument = /text\/html/i.test(served['content-type'] || '');
	const carriesHashes = /'sha256-/.test(served['content-security-policy'] || '');

	for (const [name, expected] of Object.entries(declared)) {
		// Only security headers are the subject here. Cache and CORS values are
		// legitimately rewritten by the CDN and by conditional-request handling.
		if (!name.startsWith('x-') && !REQUIRED_ON_HTML.includes(name) && name !== 'permissions-policy') {
			continue;
		}
		const value = served[name];
		if (value === undefined) {
			problems.push(`${name} was declared but the response did not carry it`);
			continue;
		}
		if (name === 'content-security-policy') {
			problems.push(...policyDiff(expected, value, isDocument || carriesHashes));
			continue;
		}
		if (value.trim() !== expected.trim()) {
			problems.push(`${name} is "${value}" but vercel.json declares "${expected}"`);
		}
	}
	return problems;
}
