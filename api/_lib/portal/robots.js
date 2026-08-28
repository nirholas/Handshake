// @ts-check
// A minimal, correct robots.txt matcher for the Portal crawler.
//
// Portal fetches a page the visitor asked for, on their behalf, once, and
// caches the result. That is polite by construction, but "polite by
// construction" is not the same as "asked permission", and a crawler that
// ignores robots.txt is the kind of detail that turns a good product into a
// complaint. There is no robots parser in this repo's dependency tree, and the
// format is small enough that a correct implementation is shorter than the
// argument for adding one.
//
// Implements the parts of the Robots Exclusion Protocol (RFC 9309) that decide
// an allow/deny for one path:
//
// - Groups are selected by the MOST SPECIFIC matching User-agent token, with
//   `*` as the fallback group. Consecutive `User-agent` lines share one group.
// - Within the winning group, the LONGEST matching rule wins, and Allow beats
//   Disallow on an exact tie (RFC 9309 section 2.2.2).
// - `*` matches any run of characters, `$` anchors the end of the path.
// - An empty `Disallow:` value allows everything; a group with no rules allows
//   everything. A missing or unreachable robots.txt allows everything, which is
//   what every major crawler does and what the RFC's "unavailable" status says.
// - Comments (`#`) are stripped, values are trimmed, keys are case-insensitive.

/** @typedef {{ agents: string[], rules: { allow: boolean, path: string }[] }} RobotsGroup */

/**
 * Parse a robots.txt body into its groups. Never throws: a malformed file is a
 * file that grants everything, not a crash in the caller's request path.
 * @param {string} body
 * @returns {RobotsGroup[]}
 */
export function parseRobots(body) {
	/** @type {RobotsGroup[]} */
	const groups = [];
	/** @type {RobotsGroup | null} */
	let current = null;
	// True while we are reading a run of User-agent lines, which all belong to
	// the same group. The first rule line closes the run, so the NEXT
	// User-agent line starts a new group rather than joining this one.
	let collectingAgents = false;

	for (const rawLine of String(body || '').split(/\r?\n/)) {
		const line = rawLine.split('#')[0].trim();
		if (!line) continue;
		const idx = line.indexOf(':');
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();

		if (key === 'user-agent') {
			if (!current || !collectingAgents) {
				current = { agents: [], rules: [] };
				groups.push(current);
				collectingAgents = true;
			}
			if (value) current.agents.push(value.toLowerCase());
			continue;
		}
		if (key !== 'allow' && key !== 'disallow') continue;
		if (!current) continue;
		collectingAgents = false;
		// `Disallow:` with an empty value is the documented "allow everything"
		// form, so it is recorded as nothing rather than as a rule matching "".
		if (key === 'disallow' && value === '') continue;
		current.rules.push({ allow: key === 'allow', path: value });
	}
	return groups;
}

/**
 * The group that governs `userAgent`: the longest matching agent token, or the
 * `*` group, or null when neither exists.
 * @param {RobotsGroup[]} groups
 * @param {string} userAgent
 */
function groupFor(groups, userAgent) {
	const ua = String(userAgent || '').toLowerCase();
	/** @type {RobotsGroup | null} */
	let best = null;
	let bestLen = -1;
	/** @type {RobotsGroup | null} */
	let wildcard = null;
	for (const group of groups) {
		for (const agent of group.agents) {
			if (agent === '*') {
				if (!wildcard) wildcard = group;
				continue;
			}
			if (ua.includes(agent) && agent.length > bestLen) {
				best = group;
				bestLen = agent.length;
			}
		}
	}
	return best || wildcard;
}

/**
 * Does a robots path pattern match this path? `*` is any run of characters and
 * a trailing `$` anchors the end. Everything else is a literal prefix match.
 * @param {string} pattern
 * @param {string} path
 * @returns {number} length of the matched pattern, or -1 when it does not match
 */
export function matchRule(pattern, path) {
	if (pattern === '') return -1;
	const anchored = pattern.endsWith('$');
	const body = anchored ? pattern.slice(0, -1) : pattern;
	const parts = body.split('*');
	let cursor = 0;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === '') continue;
		const at = i === 0 ? (path.startsWith(part) ? 0 : -1) : path.indexOf(part, cursor);
		if (at < 0) return -1;
		cursor = at + part.length;
	}
	if (anchored && cursor !== path.length) {
		// A trailing wildcard before the anchor may still consume the remainder.
		if (!body.endsWith('*')) return -1;
	}
	return pattern.length;
}

/**
 * Is `path` fetchable by `userAgent` under this robots.txt body?
 * @param {string|null|undefined} body robots.txt contents, or null when unreachable
 * @param {string} path URL path (with query, as sent on the wire)
 * @param {string} userAgent our product token
 * @returns {boolean}
 */
export function isAllowed(body, path, userAgent) {
	if (!body) return true;
	const group = groupFor(parseRobots(body), userAgent);
	if (!group || !group.rules.length) return true;
	const target = path || '/';
	let verdict = true;
	let bestLen = -1;
	for (const rule of group.rules) {
		const len = matchRule(rule.path, target);
		if (len < 0) continue;
		// Longest match wins; Allow wins an exact-length tie (RFC 9309 2.2.2).
		if (len > bestLen || (len === bestLen && rule.allow)) {
			bestLen = len;
			verdict = rule.allow;
		}
	}
	return verdict;
}
