// Multi-source web search with fallback chain.
// Priority: Brave → Tavily → Exa → DuckDuckGo instant answer.
// At least 3 results are always returned (or a descriptive error thrown).

const TIMEOUT_MS = 10_000;

function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`Search timed out after ${ms}ms`)), ms),
		),
	]);
}

// ── Brave Search ──────────────────────────────────────────────────────────────

async function searchBrave(query) {
	const key = process.env.BRAVE_API_KEY;
	if (!key) return null;

	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
	const res = await withTimeout(
		fetch(url, {
			headers: {
				'accept': 'application/json',
				'accept-encoding': 'gzip',
				'X-Subscription-Token': key,
			},
		}),
		TIMEOUT_MS,
	);
	if (!res.ok) {
		throw new Error(`Brave search HTTP ${res.status}`);
	}
	const data = await res.json();
	const results = data?.web?.results || [];
	return results.map((r) => ({
		url: r.url,
		title: r.title || '',
		snippet: r.description || r.extra_snippets?.[0] || '',
	}));
}

// ── Tavily ────────────────────────────────────────────────────────────────────

async function searchTavily(query) {
	const key = process.env.TAVILY_API_KEY;
	if (!key) return null;

	const res = await withTimeout(
		fetch('https://api.tavily.com/search', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				api_key: key,
				query,
				max_results: 10,
				search_depth: 'basic',
			}),
		}),
		TIMEOUT_MS,
	);
	if (!res.ok) {
		throw new Error(`Tavily search HTTP ${res.status}`);
	}
	const data = await res.json();
	const results = data?.results || [];
	return results.map((r) => ({
		url: r.url,
		title: r.title || '',
		snippet: r.content || '',
	}));
}

// ── Exa ───────────────────────────────────────────────────────────────────────

async function searchExa(query) {
	const key = process.env.EXA_API_KEY;
	if (!key) return null;

	const res = await withTimeout(
		fetch('https://api.exa.ai/search', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': key,
			},
			body: JSON.stringify({ query, numResults: 10, useAutoprompt: true }),
		}),
		TIMEOUT_MS,
	);
	if (!res.ok) {
		throw new Error(`Exa search HTTP ${res.status}`);
	}
	const data = await res.json();
	const results = data?.results || [];
	return results.map((r) => ({
		url: r.url,
		title: r.title || '',
		snippet: r.text ? r.text.slice(0, 400) : '',
	}));
}

// ── DuckDuckGo instant answer (fallback) ──────────────────────────────────────

async function searchDuckDuckGo(query) {
	const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&t=threews`;
	const res = await withTimeout(fetch(url, { headers: { accept: 'application/json' } }), TIMEOUT_MS);
	if (!res.ok) {
		throw new Error(`DuckDuckGo HTTP ${res.status}`);
	}
	const data = await res.json();

	const results = [];

	if (data.AbstractURL && data.Abstract) {
		results.push({
			url: data.AbstractURL,
			title: data.Heading || query,
			snippet: data.Abstract,
		});
	}

	for (const r of data.RelatedTopics || []) {
		if (r.FirstURL && r.Text) {
			results.push({ url: r.FirstURL, title: r.Text.slice(0, 80), snippet: r.Text });
		}
		// Nested subtopics.
		if (Array.isArray(r.Topics)) {
			for (const t of r.Topics) {
				if (t.FirstURL && t.Text) {
					results.push({ url: t.FirstURL, title: t.Text.slice(0, 80), snippet: t.Text });
				}
			}
		}
	}

	for (const r of data.Results || []) {
		if (r.FirstURL && r.Text) {
			results.push({ url: r.FirstURL, title: r.Text.slice(0, 80), snippet: r.Text });
		}
	}

	return results.slice(0, 10);
}

// ── Deduplicate by URL ────────────────────────────────────────────────────────

function deduplicate(results) {
	const seen = new Set();
	return results.filter((r) => {
		if (!r.url || seen.has(r.url)) return false;
		seen.add(r.url);
		return true;
	});
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run multi-source search. Uses up to 2 sources in parallel if multiple keys
 * are configured, falling back through the chain until at least 3 results are
 * collected.
 *
 * @param {string} query
 * @returns {Promise<Array<{url: string, title: string, snippet: string}>>}
 */
export async function searchWeb(query) {
	const hasBrave = Boolean(process.env.BRAVE_API_KEY);
	const hasTavily = Boolean(process.env.TAVILY_API_KEY);
	const hasExa = Boolean(process.env.EXA_API_KEY);

	const searchFns = [];
	if (hasBrave) searchFns.push(searchBrave);
	if (hasTavily) searchFns.push(searchTavily);
	if (hasExa) searchFns.push(searchExa);

	// Run up to 2 sources in parallel for speed.
	const primary = searchFns.slice(0, 2);
	let combined = [];
	let errors = [];

	if (primary.length > 0) {
		const settled = await Promise.allSettled(primary.map((fn) => fn(query)));
		for (const outcome of settled) {
			if (outcome.status === 'fulfilled' && Array.isArray(outcome.value)) {
				combined.push(...outcome.value);
			} else if (outcome.status === 'rejected') {
				errors.push(outcome.reason?.message || String(outcome.reason));
			}
		}
	}

	// If not enough results, try remaining sources sequentially.
	for (const fn of searchFns.slice(2)) {
		if (deduplicate(combined).length >= 3) break;
		try {
			const more = await fn(query);
			if (Array.isArray(more)) combined.push(...more);
		} catch (err) {
			errors.push(err.message);
		}
	}

	// Final fallback: DuckDuckGo.
	if (deduplicate(combined).length < 3) {
		try {
			const ddg = await searchDuckDuckGo(query);
			combined.push(...ddg);
		} catch (err) {
			errors.push(err.message);
		}
	}

	const deduped = deduplicate(combined);

	if (deduped.length === 0) {
		const detail = errors.length ? errors.join('; ') : 'no search providers configured';
		const err = new Error(`Search returned no results: ${detail}`);
		err.status = 502;
		err.code = 'search_failed';
		throw err;
	}

	if (deduped.length < 3) {
		// Return what we have — the verdict logic will mark it 'insufficient'.
	}

	return deduped;
}

/**
 * Run the same query across all three search queries in parallel (max 2 sources each).
 * Returns a flat deduplicated result list.
 *
 * @param {string[]} queries  Up to 3 queries.
 * @returns {Promise<Array<{url: string, title: string, snippet: string}>>}
 */
export async function searchAll(queries) {
	const settled = await Promise.allSettled(queries.map((q) => searchWeb(q)));
	const combined = [];
	for (const outcome of settled) {
		if (outcome.status === 'fulfilled') {
			combined.push(...outcome.value);
		}
	}
	return deduplicate(combined);
}
