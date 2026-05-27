// Source authority scoring for fact-checker.
// Returns a weight in [0, 1] representing how much to trust a given URL.

const DOMAIN_SCORES = new Map([
	// Major scientific / government
	['ncbi.nlm.nih.gov', 0.95],
	['pubmed.ncbi.nlm.nih.gov', 0.95],
	['scholar.google.com', 0.85],
	['nature.com', 0.85],
	['science.org', 0.85],

	// Top-tier news and reference
	['reuters.com', 0.85],
	['apnews.com', 0.85],
	['bbc.com', 0.85],
	['nytimes.com', 0.85],
	['theguardian.com', 0.85],
	['wsj.com', 0.85],
	['washingtonpost.com', 0.85],
	['ft.com', 0.85],
	['bloomberg.com', 0.85],
	['economist.com', 0.85],

	// Mid-tier news
	['cnn.com', 0.75],
	['nbcnews.com', 0.75],
	['abcnews.go.com', 0.75],
	['cbsnews.com', 0.75],
	['npr.org', 0.75],
	['bbc.co.uk', 0.75],
	['politico.com', 0.75],
	['theatlantic.com', 0.75],
	['newyorker.com', 0.75],

	// Tech and reference
	['wikipedia.org', 0.7],
	['britannica.com', 0.7],
	['snopes.com', 0.7],
	['factcheck.org', 0.7],
	['politifact.com', 0.7],
	['techcrunch.com', 0.7],
	['wired.com', 0.7],
	['arstechnica.com', 0.7],

	// Social / blogs
	['medium.com', 0.4],
	['substack.com', 0.4],
	['reddit.com', 0.4],
	['twitter.com', 0.4],
	['x.com', 0.4],
]);

/**
 * Score a URL's domain by authority.
 * @param {string} url
 * @returns {number} 0..1
 */
export function authorityScore(url) {
	let hostname;
	try {
		hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return 0.55;
	}

	// Exact domain match.
	if (DOMAIN_SCORES.has(hostname)) {
		return DOMAIN_SCORES.get(hostname);
	}

	// .gov TLD.
	if (hostname.endsWith('.gov')) return 0.95;

	// .edu TLD.
	if (hostname.endsWith('.edu')) return 0.9;

	// Check if the hostname ends with any known domain (e.g. sub.reuters.com).
	for (const [domain, score] of DOMAIN_SCORES) {
		if (hostname.endsWith(`.${domain}`)) {
			return score;
		}
	}

	return 0.55;
}
