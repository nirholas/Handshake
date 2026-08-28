// Conventional Commits 1.0.0 parsing, plus the three things the spec leaves
// out and every real repository has anyway: revert commits, GitHub's merge
// subjects, and trailers that carry meaning (Co-authored-by, Changelog:).
//
// Everything here is pure and synchronous. A commit message in, a structured
// record out. No network, no git, no filesystem.

/** Conventional-commit header: type(scope)!: description */
const HEADER_RE = /^([a-zA-Z][a-zA-Z0-9_-]*)(?:\(([^)]*)\))?(!?):\s+(.+)$/;
/** GitHub's generated merge subject, and the git default. */
const MERGE_RE = /^Merge (pull request #\d+|branch |remote-tracking branch |commit )/i;
/** git revert's default subject. */
const REVERT_RE = /^Revert\s+"(.*)"\s*$/;
/** A trailer line: `Key: value`, per git-interpret-trailers. */
const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.+)$/;
/** Issue references anywhere in the message. */
const ISSUE_RE = /(?:^|[^\w/])#(\d{1,7})\b/g;

/** Types the spec blesses plus the ones the wider ecosystem settled on. */
export const KNOWN_TYPES = new Set([
	'feat',
	'fix',
	'perf',
	'refactor',
	'docs',
	'test',
	'tests',
	'build',
	'ci',
	'chore',
	'style',
	'revert',
	'security',
	'deps',
	'release',
]);

/** Friendly labels for the conventional types. Anything else passes through. */
export const TYPE_LABELS = {
	feat: 'Feature',
	fix: 'Fix',
	perf: 'Performance',
	refactor: 'Refactor',
	docs: 'Docs',
	test: 'Tests',
	tests: 'Tests',
	build: 'Build',
	ci: 'CI',
	chore: 'Chore',
	style: 'Style',
	revert: 'Revert',
	security: 'Security',
	deps: 'Dependencies',
	release: 'Release',
};

const trim = (s) => String(s == null ? '' : s).trim();

/**
 * Split a commit message into its subject and body, tolerating CRLF and the
 * missing blank line that hand-written messages often have.
 */
export function splitMessage(message) {
	const text = String(message == null ? '' : message).replace(/\r\n?/g, '\n');
	const nl = text.indexOf('\n');
	if (nl === -1) return { subject: trim(text), body: '' };
	return { subject: trim(text.slice(0, nl)), body: text.slice(nl + 1).replace(/^\n+/, '').trimEnd() };
}

/**
 * Read git trailers from the end of a body. Only the final contiguous block of
 * `Key: value` lines counts, which is what git itself does, so a colon inside
 * prose never becomes a trailer.
 */
export function parseTrailers(body) {
	const lines = String(body || '').split('\n');
	const trailers = {};
	const coAuthors = [];
	let i = lines.length - 1;
	while (i >= 0 && trim(lines[i]) === '') i--;
	const block = [];
	for (; i >= 0; i--) {
		const line = lines[i];
		if (trim(line) === '') break;
		const m = TRAILER_RE.exec(trim(line));
		if (!m) return finishTrailers(block, trailers, coAuthors);
		block.unshift(m);
	}
	return finishTrailers(block, trailers, coAuthors);
}

function finishTrailers(block, trailers, coAuthors) {
	for (const [, rawKey, rawValue] of block) {
		const key = rawKey.toLowerCase();
		const value = trim(rawValue);
		if (key === 'co-authored-by') coAuthors.push(value);
		else trailers[key] = value;
	}
	return { trailers, coAuthors };
}

/**
 * Parse one commit message.
 *
 * @param {string} message full commit message (subject + body)
 * @returns {{
 *   subject: string, type: string|null, scope: string|null, breaking: boolean,
 *   description: string, body: string, trailers: Record<string,string>,
 *   coAuthors: string[], issues: string[], merge: boolean, revert: boolean,
 *   revertedSubject: string|null, conventional: boolean
 * }}
 */
export function parseCommitMessage(message) {
	const { subject, body } = splitMessage(message);
	const { trailers, coAuthors } = parseTrailers(body);

	const merge = MERGE_RE.test(subject);
	const revertMatch = REVERT_RE.exec(subject);
	const header = HEADER_RE.exec(subject);

	const issues = [];
	const haystack = `${subject}\n${body}`;
	ISSUE_RE.lastIndex = 0;
	let issueMatch = ISSUE_RE.exec(haystack);
	while (issueMatch) {
		if (!issues.includes(issueMatch[1])) issues.push(issueMatch[1]);
		issueMatch = ISSUE_RE.exec(haystack);
	}

	// `BREAKING CHANGE:` in the body is the spec's second way to flag a break,
	// and `BREAKING-CHANGE:` is its blessed trailer alias.
	const bodyBreaking = /^BREAKING[ -]CHANGE:/m.test(body);

	if (!header) {
		return {
			subject,
			type: revertMatch ? 'revert' : null,
			scope: null,
			breaking: bodyBreaking,
			description: subject,
			body,
			trailers,
			coAuthors,
			issues,
			merge,
			revert: Boolean(revertMatch),
			revertedSubject: revertMatch ? revertMatch[1] : null,
			conventional: false,
		};
	}

	const [, type, scope, bang, description] = header;
	return {
		subject,
		type: type.toLowerCase(),
		scope: scope ? trim(scope) : null,
		breaking: bang === '!' || bodyBreaking,
		description: trim(description),
		body,
		trailers,
		coAuthors,
		issues,
		merge,
		revert: type.toLowerCase() === 'revert' || Boolean(revertMatch),
		revertedSubject: revertMatch ? revertMatch[1] : null,
		conventional: true,
	};
}

/**
 * Normalize a GitHub REST commit object (or anything shaped like one) into the
 * record the rest of this package works with. Accepts the shapes returned by
 * `/repos/{o}/{r}/commits` and by `git log --format=...` adapters.
 */
export function parseCommit(input) {
	const sha = String(input?.sha || input?.hash || '');
	const message = input?.commit?.message ?? input?.message ?? '';
	const parsed = parseCommitMessage(message);
	const committedAt =
		input?.commit?.committer?.date || input?.commit?.author?.date || input?.date || '';
	const authoredAt = input?.commit?.author?.date || input?.date || committedAt;
	const login = input?.author?.login || null;
	const name = input?.commit?.author?.name || input?.authorName || login || 'unknown';
	const parents = Array.isArray(input?.parents) ? input.parents.length : Number(input?.parents) || 0;

	return {
		...parsed,
		sha,
		shortSha: sha.slice(0, 7),
		url: input?.html_url || input?.url || '',
		author: { login, name },
		authoredAt,
		committedAt,
		parents,
		// A second parent is the only unambiguous merge signal; the subject
		// pattern is a fallback for logs that do not carry parents.
		merge: parsed.merge || parents > 1,
		files: Array.isArray(input?.files)
			? input.files.map((f) => String(f?.filename || f)).filter(Boolean)
			: null,
	};
}

/**
 * Human label for a commit's type + scope, e.g. `feat(resilience)` reads as
 * "Feature · resilience". Non-conventional subjects keep whatever leading
 * "Scope: " convention they used, so nothing is invented.
 */
export function headline(commit, { separator = ' · ' } = {}) {
	const c = commit && commit.type !== undefined ? commit : parseCommitMessage(String(commit || ''));
	if (c.type) {
		const label = TYPE_LABELS[c.type] || c.type;
		const bang = c.breaking ? ' (breaking)' : '';
		return c.scope ? `${label}${separator}${c.scope}${bang}` : `${label}${bang}`;
	}
	const idx = c.subject.indexOf(': ');
	if (idx > 0 && idx < 60) return c.subject.slice(0, idx);
	return 'New commit';
}

/** The one-line description a reader sees under the headline. */
export function summaryLine(commit) {
	const c = commit && commit.type !== undefined ? commit : parseCommitMessage(String(commit || ''));
	if (c.type) return c.description;
	const idx = c.subject.indexOf(': ');
	if (idx > 0 && idx < 60) return c.subject.slice(idx + 2);
	return c.subject;
}
