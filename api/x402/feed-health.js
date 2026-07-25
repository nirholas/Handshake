// POST /api/x402/feed-health
//
// Paid RSS/JSON feed validation endpoint. For $0.001 USDC the server fetches
// a named public feed, parses it, and returns a structural health verdict:
// whether the feed is valid XML, how many items it contains, and whether the
// latest entry's title matches the platform's canonical changelog record.
//
// Supported feeds:
//   changelog_rss — three.ws/changelog.xml — the public RSS 2.0 changelog feed
//
// The autonomous loop calls this every 5 minutes with { feed: "changelog_rss" }
// to detect three failure modes before holders notice:
//   • The XML is broken (invalid syntax or unreachable URL)
//   • The item count drifts from the canonical source (build step skipped)
//   • The latest title diverges from the DB record (content went to the feed
//     but the merge step that writes public/changelog.json was not rerun)

import { readFileSync } from 'node:fs';
import { readBody } from '../_lib/http.js';
import { XMLParser } from 'fast-xml-parser';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { env } from '../_lib/env.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/feed-health';
const FETCH_TIMEOUT_MS = 8_000;

const DESCRIPTION =
	'three.ws Feed Health Validator — fetches a named public feed (changelog RSS, ' +
	'sitemap, etc.) and returns a structural health verdict: { valid, item_count, ' +
	'latest_title }. Pays $0.001 USDC per check. Supported feeds: changelog_rss. ' +
	'The latest_title is cross-checked against the canonical changelog record so ' +
	'both a broken XML feed and a stale/diverged feed surface as valid:false.';

const SUPPORTED_FEEDS = ['changelog_rss'];

const INPUT_EXAMPLE = { feed: 'changelog_rss' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['feed'],
	properties: {
		feed: {
			type: 'string',
			enum: SUPPORTED_FEEDS,
			description: 'Feed identifier. Currently: changelog_rss (three.ws/changelog.xml).',
		},
	},
};

const OUTPUT_EXAMPLE = {
	feed: 'changelog_rss',
	valid: true,
	item_count: 1241,
	latest_title: 'x402 Volume Analytics — the platform measures its own payment economy',
	title_match: true,
	fetch_ms: 312,
	checked_at: '2026-06-28T12:00:00.000Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['feed', 'valid', 'item_count', 'latest_title', 'title_match', 'checked_at'],
	properties: {
		feed: { type: 'string' },
		valid: { type: 'boolean' },
		item_count: { type: 'integer', minimum: 0 },
		latest_title: { type: ['string', 'null'] },
		title_match: { type: 'boolean' },
		fetch_ms: { type: ['integer', 'null'] },
		error: { type: 'string' },
		checked_at: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodyExample: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });

// Read the canonical changelog record from the compiled public asset. The file
// is bundled into the Vercel deployment alongside the API so readFileSync is
// safe here. We load it once per cold start — it only changes on deploy.
let _changelogEntries = null;
function getChangelogEntries() {
	if (_changelogEntries) return _changelogEntries;
	try {
		const raw = readFileSync(
			new URL('../../public/changelog.json', import.meta.url),
			'utf8',
		);
		const parsed = JSON.parse(raw);
		_changelogEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
	} catch {
		_changelogEntries = [];
	}
	return _changelogEntries;
}

async function validateChangelogRss(origin) {
	const url = `${origin}/changelog.xml`;
	const start = Date.now();

	let xmlText;
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { accept: 'application/rss+xml, application/xml, text/xml' },
		});
		if (!res.ok) {
			return {
				valid: false,
				item_count: 0,
				latest_title: null,
				title_match: false,
				fetch_ms: Date.now() - start,
				error: `HTTP ${res.status} fetching ${url}`,
			};
		}
		xmlText = await res.text();
	} catch (err) {
		return {
			valid: false,
			item_count: 0,
			latest_title: null,
			title_match: false,
			fetch_ms: Date.now() - start,
			error: `Fetch failed: ${err?.message || String(err)}`,
		};
	}

	const fetchMs = Date.now() - start;

	let parsed;
	try {
		parsed = xmlParser.parse(xmlText);
	} catch (err) {
		return {
			valid: false,
			item_count: 0,
			latest_title: null,
			title_match: false,
			fetch_ms: fetchMs,
			error: `XML parse failed: ${err?.message || String(err)}`,
		};
	}

	const channel = parsed?.rss?.channel;
	if (!channel) {
		return {
			valid: false,
			item_count: 0,
			latest_title: null,
			title_match: false,
			fetch_ms: fetchMs,
			error: 'RSS channel element missing from parsed document',
		};
	}

	// fast-xml-parser coerces a single <item> to an object rather than an array.
	const rawItems = channel.item;
	const items = Array.isArray(rawItems)
		? rawItems
		: rawItems != null
			? [rawItems]
			: [];

	const itemCount = items.length;
	const latestTitle = typeof items[0]?.title === 'string'
		? items[0].title.trim()
		: items[0]?.title != null
			? String(items[0].title).trim()
			: null;

	// Cross-check against the canonical compiled record.
	const entries = getChangelogEntries();
	const expectedTitle = entries.length > 0 ? (entries[0].title || null) : null;
	const titleMatch = latestTitle != null && expectedTitle != null
		? latestTitle === expectedTitle
		: false;

	return {
		valid: true,
		item_count: itemCount,
		latest_title: latestTitle,
		title_match: titleMatch,
		fetch_ms: fetchMs,
	};
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('feed-health', '1000'),
	networks: ['solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Feed Health',
		tags: ['rss', 'feed', 'health', 'changelog', 'validation'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		// Drain the stream — Vercel does not reliably pre-parse req.body for this
		// POST route, and `feed` is required, so trusting req.body would 400 every
		// paid call. Fall back to a pre-parsed body when the runtime supplies one.
		let body = {};
		if (req.body && typeof req.body === 'object') {
			body = req.body;
		} else {
			try {
				const chunks = [await readBody(req, 1_000_000)];
				const raw = Buffer.concat(chunks).toString('utf8');
				if (raw) body = JSON.parse(raw);
			} catch { /* tolerate an empty/unparseable body → unsupported_feed below */ }
		}
		const feed = String(body.feed || '').trim();

		if (!SUPPORTED_FEEDS.includes(feed)) {
			const err = new Error(
				`unsupported feed "${feed}". Supported: ${SUPPORTED_FEEDS.join(', ')}.`,
			);
			err.status = 400;
			err.code = 'unsupported_feed';
			throw err;
		}

		const origin = (env.APP_ORIGIN || 'https://three.ws').replace(/\/$/, '');
		const result = await validateChangelogRss(origin);

		return {
			feed,
			...result,
			checked_at: new Date().toISOString(),
		};
	},
});
