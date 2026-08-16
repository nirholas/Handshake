// Thin GitHub REST/GraphQL client for the memory-seeding endpoints.
//
// Every call is read-only and scoped to the connected user's own OAuth token.
// Upstream failures are tagged with `status` so wrap() reports them as 502
// upstream errors rather than as our own 500.

const API = 'https://api.github.com';
const UA = 'three.ws/1.0';
const TIMEOUT_MS = 15_000;

function headers(token, accept = 'application/vnd.github+json') {
	return {
		authorization: `token ${token}`,
		accept,
		'user-agent': UA,
		'x-github-api-version': '2022-11-28',
	};
}

function upstream(message, status = 502) {
	return Object.assign(new Error(message), { status });
}

async function ghJson(path, token) {
	const res = await fetch(`${API}${path}`, {
		headers: headers(token),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (res.status === 401) throw upstream('GitHub rejected the stored token', 401);
	if (!res.ok) throw upstream(`GitHub ${path} failed: ${res.status}`);
	return res.json();
}

export function fetchProfile(token) {
	return ghJson('/user', token);
}

/**
 * Check a token the user pasted and report back what it can do. Returns the
 * profile it belongs to plus the raw `x-oauth-scopes` header, which is the only
 * place GitHub states a classic PAT's grants (fine-grained tokens omit it, so
 * the header comes back null). A token GitHub rejects returns `valid: false`
 * rather than throwing, because a mistyped paste is a user error to explain, not
 * an upstream outage to report.
 */
export async function verifyToken(token) {
	const res = await fetch(`${API}/user`, {
		headers: headers(token),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (res.status === 401 || res.status === 403) return { valid: false, status: res.status };
	if (!res.ok) throw upstream(`GitHub token check failed: ${res.status}`);
	const profile = await res.json();
	if (!profile?.login) return { valid: false, status: res.status };
	return { valid: true, status: res.status, profile, scopeHeader: res.headers.get('x-oauth-scopes') };
}

/** Public repos the user owns, most recently pushed first. */
export function fetchRepos(token, perPage = 40) {
	return ghJson(
		`/user/repos?sort=pushed&direction=desc&per_page=${perPage}&visibility=public&affiliation=owner`,
		token,
	);
}

const PINNED_QUERY = `query($login:String!){
	user(login:$login){
		pinnedItems(first:6, types:[REPOSITORY]){
			nodes{
				... on Repository{
					nameWithOwner name description stargazerCount pushedAt isFork url
					primaryLanguage{ name }
					repositoryTopics(first:8){ nodes{ topic{ name } } }
				}
			}
		}
	}
}`;

/**
 * Repos the developer pinned to their own profile. A pin is the strongest
 * signal of what they consider their work, so these lead the consent catalog.
 * GraphQL is the only API that exposes pins; a failure here degrades to an
 * empty pin list rather than failing the whole catalog.
 */
export async function fetchPinnedRepos(token, login) {
	const res = await fetch(`${API}/graphql`, {
		method: 'POST',
		headers: { ...headers(token), 'content-type': 'application/json' },
		body: JSON.stringify({ query: PINNED_QUERY, variables: { login } }),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) return [];
	const body = await res.json().catch(() => null);
	const nodes = body?.data?.user?.pinnedItems?.nodes;
	if (!Array.isArray(nodes)) return [];
	return nodes.filter(Boolean).map((n) => ({
		full_name: n.nameWithOwner,
		name: n.name,
		description: n.description,
		language: n.primaryLanguage?.name ?? null,
		stargazerCount: n.stargazerCount,
		topics: (n.repositoryTopics?.nodes ?? []).map((t) => t?.topic?.name).filter(Boolean),
		pushedAt: n.pushedAt,
		isFork: n.isFork,
		url: n.url,
	}));
}

/**
 * A repo's README as raw markdown, or null when it has none. A missing README
 * is an ordinary state, not an error: the seed run continues with the repos
 * that do have one.
 */
export async function fetchReadme(token, repoKey) {
	const res = await fetch(`${API}/repos/${repoKey}/readme`, {
		headers: headers(token, 'application/vnd.github.raw'),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (res.status === 404) return null;
	if (!res.ok) throw upstream(`GitHub README fetch failed for ${repoKey}: ${res.status}`);
	return res.text();
}

/** Best-effort revocation of our OAuth grant on GitHub's side. */
export async function revokeGrant(token, clientId, clientSecret) {
	const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
	const res = await fetch(`${API}/applications/${clientId}/grant`, {
		method: 'DELETE',
		headers: {
			authorization: `Basic ${creds}`,
			accept: 'application/vnd.github+json',
			'content-type': 'application/json',
			'user-agent': UA,
		},
		body: JSON.stringify({ access_token: token }),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	return res.status === 204;
}
