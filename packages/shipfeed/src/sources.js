// Where commits and changelog entries come from. Two real sources, no adapters
// in between: GitHub's REST API, and `git log` output from a local clone.
//
// Everything here uses the global fetch, so the module runs unchanged in Node,
// in a Cloud Run handler, and in a browser.

/** The exact `git log --format` string `commitsFromGitLog` expects. */
export const GIT_LOG_FORMAT = '%H%x00%cI%x00%aI%x00%an%x00%aN%x00%P%x00%B%x1e';

// The two separators the format string above emits. NUL cannot appear inside a
// commit message and RS (0x1e) is what git itself uses for record separation,
// so neither can be produced by commit text and confuse the split.
const FIELD_SEP = String.fromCharCode(0);
const RECORD_SEP = String.fromCharCode(30);

const GITHUB_API = 'https://api.github.com';

/**
 * Read commits from GitHub, newest first, following pages until `limit`.
 *
 * @param {{repo: string, branch?: string, limit?: number, token?: string,
 *   fetchImpl?: typeof fetch, signal?: AbortSignal, userAgent?: string}} options
 * @returns {Promise<object[]>} raw GitHub commit objects
 */
export async function fetchGitHubCommits(options) {
	const {
		repo,
		branch = 'main',
		limit = 200,
		token = '',
		fetchImpl = fetch,
		signal,
		userAgent = 'shipfeed',
	} = options;
	if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) {
		throw new Error(`shipfeed: repo must look like "owner/name", got ${JSON.stringify(repo)}`);
	}

	const headers = { accept: 'application/vnd.github+json', 'user-agent': userAgent };
	if (token) headers.authorization = `Bearer ${token}`;

	const perPage = Math.min(100, Math.max(1, limit));
	const out = [];
	for (let page = 1; out.length < limit; page++) {
		const url = `${GITHUB_API}/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`;
		const res = await fetchImpl(url, { headers, signal });
		if (!res.ok) {
			if (res.headers?.get?.('x-ratelimit-remaining') === '0') {
				const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
				const until = Number.isFinite(reset) ? new Date(reset).toISOString() : 'unknown';
				throw new Error(
					`shipfeed: GitHub rate limit exhausted (resets ${until}); pass a token to raise it above 60/hour`,
				);
			}
			throw new Error(`shipfeed: GitHub commits fetch failed (${res.status}) for ${repo}`);
		}
		const batch = await res.json();
		if (!Array.isArray(batch) || batch.length === 0) break;
		out.push(...batch);
		if (batch.length < perPage) break;
	}
	return out.slice(0, limit);
}

/**
 * Parse `git log --format=<GIT_LOG_FORMAT>` output into GitHub-shaped commits,
 * so a local clone and the API produce identical feeds.
 */
export function commitsFromGitLog(text, { repo = '' } = {}) {
	return String(text || '')
		.split(RECORD_SEP)
		.map((record) => record.replace(/^\n+/, ''))
		.filter((record) => record.trim())
		.map((record) => {
			const [sha, committedAt, authoredAt, committerName, authorName, parents, message] =
				record.split(FIELD_SEP);
			return {
				sha,
				html_url: repo ? `https://github.com/${repo}/commit/${sha}` : '',
				parents: String(parents || '')
					.split(' ')
					.filter(Boolean)
					.map((p) => ({ sha: p })),
				commit: {
					message: message || '',
					author: { name: authorName || committerName || 'unknown', date: authoredAt },
					committer: { date: committedAt },
				},
				author: null,
			};
		});
}

/**
 * Load a changelog feed. Accepts three.ws's `public/changelog.json` shape
 * (`{entries: [...]}`), a bare array, or anything already in that form.
 */
export function normalizeChangelog(input) {
	const entries = Array.isArray(input) ? input : Array.isArray(input?.entries) ? input.entries : [];
	return entries
		.filter((e) => e && e.date && e.title)
		.map((e) => ({
			date: String(e.date).slice(0, 10),
			title: String(e.title),
			summary: String(e.summary || ''),
			tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
			link: e.link ? String(e.link) : null,
		}));
}

/** Fetch and normalize a changelog JSON document over HTTP. */
export async function fetchChangelog(url, { fetchImpl = fetch, signal } = {}) {
	const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal });
	if (!res.ok) throw new Error(`shipfeed: changelog fetch failed (${res.status}) for ${url}`);
	return normalizeChangelog(await res.json());
}
