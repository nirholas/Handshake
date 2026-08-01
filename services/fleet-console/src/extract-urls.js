/**
 * Pull the URLs a repository claims out of its own README and manifest.
 *
 * The distinction that matters here is between a *deployment claim* and an
 * ordinary outbound link. A README that links to a specification is not
 * promising that link is its own running service; a README with a "Live demo"
 * button is. Grading both the same way produces a fleet report where every
 * repository looks broken because MDN moved a page.
 */

/** Hosts that are never a deployment and never worth link-checking. */
const IGNORED_HOSTS = new Set([
	'github.com',
	'www.github.com',
	'gist.github.com',
	'raw.githubusercontent.com',
	'user-images.githubusercontent.com',
	'avatars.githubusercontent.com',
	'objects.githubusercontent.com',
	'camo.githubusercontent.com',
	'shields.io',
	'img.shields.io',
	'badge.fury.io',
	'badgen.net',
	'codecov.io',
	'app.codecov.io',
	'npmjs.com',
	'www.npmjs.com',
	'registry.npmjs.org',
	'pypi.org',
	'crates.io',
	'opensource.org',
	'choosealicense.com',
	'spdx.org',
	'localhost',
	'127.0.0.1',
	'0.0.0.0',
	'example.com',
	'www.example.com',
	'twitter.com',
	'x.com',
	'discord.gg',
	'discord.com',
	't.me',
	'linkedin.com',
	'www.linkedin.com'
]);

/** Hosts that only ever appear because something was deployed there. */
const DEPLOYMENT_HOST_SUFFIXES = [
	'.run.app',
	'.a.run.app',
	'.pages.dev',
	'.workers.dev',
	'.vercel.app',
	'.netlify.app',
	'.github.io',
	'.fly.dev',
	'.onrender.com',
	'.herokuapp.com',
	'.railway.app',
	'.streamlit.app',
	'.hf.space',
	'.surge.sh',
	'.appspot.com',
	'.web.app',
	'.firebaseapp.com'
];

/**
 * Link text that promises the link is a running thing.
 *
 * Deliberately strict. An earlier version accepted a bare "live", which
 * classified a link labelled "Debian live-build" as one of our own deployments
 * and then reported that third party's downtime as our defect.
 */
const LIVE_LABEL = /(live\s+(demo|site|app|version|instance|url)|\bdemo\b|try\s*it|playground|deployed\s+at|hosted\s+at|open\s+the\s+app|docs?\s+site|\bwebsite\b|\bhomepage\b|\bdashboard\b|\bpreview\b)/i;

const normalise = (raw) => {
	let value = String(raw || '').trim();
	if (!value) return '';
	// Markdown regularly leaves trailing punctuation, emphasis markers and code
	// fences glued to a bare URL. Strip them before parsing, or the URL
	// constructor percent-encodes the garbage into the path and the probe 404s
	// on a URL that never existed.
	value = value.replace(/[).,;:'"\]}>`*_~]+$/, '');
	if (value.startsWith('www.')) value = `https://${value}`;
	if (!/^https?:\/\//i.test(value)) return '';
	// A glob or a template placeholder is documentation, not an address.
	if (/[*{}<>\s]|\$\{/.test(value)) return '';
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
		url.hash = '';
		return url.toString();
	} catch {
		return '';
	}
};

const hostOf = (url) => {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return '';
	}
};

export const isIgnoredHost = (url) => {
	const host = hostOf(url);
	if (!host) return true;
	if (IGNORED_HOSTS.has(host)) return true;
	if (host.endsWith('.local') || host.endsWith('.internal')) return true;
	return false;
};

const looksLikeDeploymentHost = (url) => {
	const host = hostOf(url);
	return DEPLOYMENT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
};

/** Strip fenced code blocks so a curl example is not read as a deployment claim. */
const stripCodeFences = (markdown) => markdown.replace(/```[\s\S]*?```/g, '\n').replace(/^ {4,}\S.*$/gm, '');

/**
 * @returns {{ url: string, label: string, source: string }[]} unique links in document order.
 */
export function extractReadmeLinks(markdown) {
	const text = stripCodeFences(String(markdown || ''));
	const seen = new Set();
	const out = [];

	const push = (rawUrl, label, source) => {
		const url = normalise(rawUrl);
		if (!url || seen.has(url)) return;
		seen.add(url);
		out.push({ url, label: String(label || '').replace(/[*`_]/g, '').trim(), source });
	};

	// Inline markdown links, skipping images (a leading '!').
	for (const match of text.matchAll(/(!)?\[([^\]]*)\]\((\s*<?)([^)\s>]+)>?[^)]*\)/g)) {
		if (match[1]) continue;
		push(match[4], match[2], 'markdown');
	}
	// Reference definitions.
	for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) push(match[1], '', 'reference');
	// HTML anchors, which READMEs use for centred hero buttons.
	for (const match of text.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
		push(match[1], match[2].replace(/<[^>]+>/g, ' '), 'html');
	}
	// Bare URLs.
	for (const match of text.matchAll(/(?<![("<\]])\bhttps?:\/\/[^\s<>"')\]]+/g)) push(match[0], '', 'bare');

	return out.filter((link) => !isIgnoredHost(link.url));
}

const originOf = (url) => {
	try {
		return new URL(url).origin;
	} catch {
		return '';
	}
};

/**
 * Decide which URLs this repository is promising are live.
 *
 * Claims are grouped by origin, because "is the deployment up?" is a question
 * about a site, not about every page a README happens to link on it. A README
 * that lists ninety paths on one host is making one deployment claim, not
 * ninety, and probing all ninety both wastes the scan and lets a single stale
 * subpage drag the score down as if the site were half dead. The origin root is
 * always probed, plus a small sample of the deeper paths, which is what catches
 * a host that serves its landing page and 404s everything else.
 *
 * @param {object} input
 * @param {string} input.repoName
 * @param {string} input.homepage repo.homepage from the GitHub record
 * @param {string} input.pagesUrl published GitHub Pages URL, when enabled
 * @param {string} input.manifestHomepage package.json "homepage"
 * @param {{url:string,label:string,source:string}[]} input.links extracted README links
 * @param {number} [input.perOrigin] paths probed per origin, including the root
 * @param {number} [input.maxCandidates] hard cap across all origins
 * @returns {{ url: string, why: string }[]}
 */
export function deploymentCandidates({ repoName, homepage, pagesUrl, manifestHomepage, links, perOrigin = 3, maxCandidates = 8 }) {
	const claims = new Map();
	const add = (raw, why) => {
		const url = normalise(raw);
		if (!url || isIgnoredHost(url)) return;
		if (!claims.has(url)) claims.set(url, why);
	};

	add(homepage, 'repository homepage field');
	add(pagesUrl, 'GitHub Pages');
	add(manifestHomepage, 'package.json homepage');

	const slug = String(repoName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
	const ownHosts = new Set([homepage, manifestHomepage, pagesUrl].map(hostOf).filter(Boolean));

	for (const link of links) {
		const host = hostOf(link.url);
		if (looksLikeDeploymentHost(link.url)) {
			add(link.url, 'known hosting provider');
			continue;
		}
		const nameMatch = slug.length >= 4 && host.replace(/[^a-z0-9]+/g, '').includes(slug);
		if (nameMatch) {
			add(link.url, 'host matches the repository name');
			continue;
		}
		// A "live demo" label only counts on a host this repository already owns.
		// Otherwise a link labelled "live" on somebody else's site becomes our outage.
		if (LIVE_LABEL.test(link.label) && (ownHosts.has(host) || ownHosts.size === 0)) {
			add(link.url, `linked as "${link.label.slice(0, 40)}"`);
		}
	}

	// Group by origin. The shortest claimed path on an origin is that site's base
	// and is always probed; a sample of the deeper paths comes along to catch a
	// host that serves its landing page and 404s everything beneath it. The base
	// is never synthesized: on a project Pages site the origin root belongs to a
	// different repository, and probing it would report somebody else's page as
	// this one's deployment.
	const byOrigin = new Map();
	for (const [url, why] of claims) {
		const origin = originOf(url);
		if (!origin) continue;
		if (!byOrigin.has(origin)) byOrigin.set(origin, []);
		byOrigin.get(origin).push({ url, why });
	}

	const out = [];
	for (const group of byOrigin.values()) {
		const ordered = [...group].sort((a, b) => a.url.length - b.url.length || a.url.localeCompare(b.url));
		out.push(...ordered.slice(0, perOrigin));
		if (out.length >= maxCandidates) break;
	}
	return out.slice(0, maxCandidates);
}

export const __testables = { normalise, hostOf, originOf, looksLikeDeploymentHost, stripCodeFences, LIVE_LABEL };
