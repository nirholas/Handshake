/**
 * Minimal GitHub REST client.
 *
 * Two things it does that a generic client does not:
 *   1. It caches by ETag, so a rescan of an unchanged repository costs a 304
 *      and does not consume rate-limit budget.
 *   2. It surfaces the rate-limit state to the caller, so the console can tell
 *      the user "this scan is partial because the budget ran out" instead of
 *      silently reporting a repository as broken.
 */

import { config } from './config.js';
import { sleep } from './pool.js';

const API = 'https://api.github.com';

const etagCache = new Map();

export const rateLimit = {
	limit: null,
	remaining: null,
	resetAt: null,
	exhausted: false
};

const readRateLimit = (headers) => {
	const limit = Number.parseInt(headers.get('x-ratelimit-limit') ?? '', 10);
	const remaining = Number.parseInt(headers.get('x-ratelimit-remaining') ?? '', 10);
	const reset = Number.parseInt(headers.get('x-ratelimit-reset') ?? '', 10);
	if (Number.isFinite(limit)) rateLimit.limit = limit;
	if (Number.isFinite(remaining)) {
		rateLimit.remaining = remaining;
		rateLimit.exhausted = remaining <= 0;
	}
	if (Number.isFinite(reset)) rateLimit.resetAt = new Date(reset * 1000).toISOString();
};

const headers = (extra = {}) => {
	const base = {
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28',
		'user-agent': config.userAgent,
		...extra
	};
	if (config.githubToken) base.authorization = `Bearer ${config.githubToken}`;
	return base;
};

/**
 * GET a GitHub API path. Returns `{ status, data, notModified }`.
 * Never throws for an expected HTTP status: a 404 is data, not an exception.
 */
export async function ghGet(path, { accept, attempts = 3 } = {}) {
	const url = path.startsWith('http') ? path : `${API}${path}`;
	const cached = etagCache.get(url);
	const extra = {};
	if (accept) extra.accept = accept;
	if (cached?.etag) extra['if-none-match'] = cached.etag;

	let lastError = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await fetch(url, { headers: headers(extra), redirect: 'follow' });
			readRateLimit(res.headers);

			if (res.status === 304 && cached) return { status: 200, data: cached.data, notModified: true };

			// Secondary rate limits and 5xx are worth one more try after a pause.
			if ((res.status === 403 && rateLimit.exhausted) || res.status === 429) {
				return { status: res.status, data: null, notModified: false, rateLimited: true };
			}
			if (res.status >= 500 && attempt < attempts) {
				await sleep(400 * attempt);
				continue;
			}
			if (!res.ok) return { status: res.status, data: null, notModified: false };

			const isJson = (res.headers.get('content-type') || '').includes('json');
			const data = isJson ? await res.json() : await res.text();
			const etag = res.headers.get('etag');
			if (etag) etagCache.set(url, { etag, data });
			return { status: res.status, data, notModified: false };
		} catch (error) {
			lastError = error;
			if (attempt < attempts) await sleep(400 * attempt);
		}
	}
	return { status: 0, data: null, notModified: false, error: String(lastError?.message || lastError) };
}

/** Every non-fork, non-archived repository owned by `owner`, newest API page first. */
export async function listRepos(owner) {
	const out = [];
	for (let page = 1; page <= 10; page++) {
		const { status, data } = await ghGet(`/users/${encodeURIComponent(owner)}/repos?per_page=100&page=${page}&sort=updated`);
		if (status !== 200 || !Array.isArray(data) || data.length === 0) break;
		out.push(...data);
		if (data.length < 100) break;
	}
	return out
		.filter((repo) => (config.includeForks ? true : !repo.fork))
		.filter((repo) => (config.includeArchived ? true : !repo.archived))
		.map((repo) => ({
			name: repo.name,
			fullName: repo.full_name,
			description: repo.description || '',
			homepage: (repo.homepage || '').trim(),
			stars: repo.stargazers_count || 0,
			forks: repo.forks_count || 0,
			openIssues: repo.open_issues_count || 0,
			language: repo.language || '',
			topics: Array.isArray(repo.topics) ? repo.topics : [],
			license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : '',
			private: Boolean(repo.private),
			hasPages: Boolean(repo.has_pages),
			defaultBranch: repo.default_branch || 'main',
			pushedAt: repo.pushed_at || null,
			createdAt: repo.created_at || null,
			sizeKb: repo.size || 0,
			htmlUrl: repo.html_url
		}))
		.sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));
}

/** Raw README text, or '' when the repository has none. */
export async function fetchReadme(fullName) {
	const { status, data } = await ghGet(`/repos/${fullName}/readme`, { accept: 'application/vnd.github.raw' });
	return status === 200 && typeof data === 'string' ? data : '';
}

/** Parsed root package.json, or null. */
export async function fetchPackageJson(fullName, branch) {
	const url = `https://raw.githubusercontent.com/${fullName}/${branch}/package.json`;
	try {
		const res = await fetch(url, { headers: { 'user-agent': config.userAgent } });
		if (!res.ok) return null;
		return JSON.parse(await res.text());
	} catch {
		return null;
	}
}

/** The published GitHub Pages URL, or '' when Pages is not enabled. */
export async function fetchPagesUrl(fullName) {
	const { status, data } = await ghGet(`/repos/${fullName}/pages`);
	if (status !== 200 || !data?.html_url) return '';
	return data.html_url;
}

/** Top-level entry names, used to tell a repository with docs from one without. */
export async function fetchRootEntries(fullName, branch) {
	const { status, data } = await ghGet(`/repos/${fullName}/contents/?ref=${encodeURIComponent(branch)}`);
	if (status !== 200 || !Array.isArray(data)) return [];
	return data.map((entry) => ({ name: entry.name, type: entry.type }));
}

/** The most recent release tag, or ''. */
export async function fetchLatestRelease(fullName) {
	const { status, data } = await ghGet(`/repos/${fullName}/releases/latest`);
	if (status !== 200 || !data?.tag_name) return '';
	return data.tag_name;
}
