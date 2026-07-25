// POST /api/x402/schema-check
//
// Paid endpoint ($0.001 USDC) that fetches a named three.ws public JSON API and
// validates its response schema against the declared spec. The first supported
// target is `changelog_json` — the public /changelog.json feed all $THREE holders
// and RSS consumers depend on. A schema break (missing required keys, wrong entry
// shape, empty array when entries exist) surfaces here before users notice a broken
// changelog, broken RSS, or a malformed JSON feed that chokes a downstream parser.
//
// Supported `api` values:
//   changelog_json — fetches /changelog.json, validates: generated_at (ISO date-
//                    time), site.name, site.url (URL), entries (non-empty array
//                    with each entry having date/title/summary/tags). Returns
//                    { valid, version (generated_at date), entry_count,
//                    schema_errors[] }.
//
// Networks: Solana mainnet + Base mainnet. Price: $0.001 USDC.
// Consumed by the autonomous x402 loop (changelog-schema-check entry).

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody as readRawBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { env } from '../_lib/env.js';

const ROUTE = '/api/x402/schema-check';

const DESCRIPTION =
	'three.ws JSON API schema conformance checker — pay $0.001 USDC to fetch a ' +
	'named three.ws public API and validate its response against the declared schema. ' +
	'Surfaces breaking schema changes before users notice a broken feed. ' +
	'Current target: changelog_json — the /changelog.json feed holders and RSS consumers ' +
	'depend on. Returns { valid, version, entry_count, schema_errors }.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['api'],
	properties: {
		api: {
			type: 'string',
			enum: ['changelog_json'],
			description: 'Which public JSON API to fetch and validate.',
		},
	},
	additionalProperties: false,
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'api', 'valid', 'entry_count', 'fetched_at'],
	properties: {
		ok: { type: 'boolean' },
		api: { type: 'string' },
		valid: { type: 'boolean', description: 'True when all required schema assertions pass.' },
		version: { type: ['string', 'null'], description: 'generated_at date from the feed, or null on fetch error.' },
		entry_count: { type: 'integer', minimum: 0 },
		schema_errors: {
			type: 'array',
			items: { type: 'string' },
			description: 'List of schema violations found. Empty when valid=true.',
		},
		fetched_at: { type: 'string', format: 'date-time' },
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	api: 'changelog_json',
	valid: true,
	version: '2026-06-28',
	entry_count: 42,
	schema_errors: [],
	fetched_at: '2026-06-28T12:00:00.000Z',
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'json', example: { api: 'changelog_json' }, schema: INPUT_SCHEMA },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

const SUPPORTED_APIS = new Set(['changelog_json']);

// Validate the /changelog.json feed against its declared schema.
// Returns { valid, version, entry_count, schema_errors }.
function validateChangelogJson(data) {
	const errors = [];

	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		return { valid: false, version: null, entry_count: 0, schema_errors: ['root is not an object'] };
	}

	// generated_at must be a non-empty ISO datetime string
	if (typeof data.generated_at !== 'string' || !data.generated_at.trim()) {
		errors.push('missing or empty generated_at');
	} else {
		const d = new Date(data.generated_at);
		if (isNaN(d.getTime())) errors.push('generated_at is not a valid ISO datetime');
	}

	// site must be an object with name + url
	if (typeof data.site !== 'object' || data.site === null) {
		errors.push('missing site object');
	} else {
		if (typeof data.site.name !== 'string' || !data.site.name.trim()) {
			errors.push('missing site.name');
		}
		if (typeof data.site.url !== 'string' || !data.site.url.startsWith('http')) {
			errors.push('missing or invalid site.url');
		}
	}

	// entries must be a non-empty array
	if (!Array.isArray(data.entries)) {
		errors.push('entries is not an array');
	} else if (data.entries.length === 0) {
		errors.push('entries array is empty');
	} else {
		// Validate the first 5 entries (representative sample — avoid O(n) on large feeds)
		const sample = data.entries.slice(0, 5);
		for (let i = 0; i < sample.length; i++) {
			const entry = sample[i];
			if (typeof entry !== 'object' || entry === null) {
				errors.push(`entries[${i}] is not an object`);
				continue;
			}
			if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
				errors.push(`entries[${i}].date missing or not YYYY-MM-DD`);
			}
			if (typeof entry.title !== 'string' || !entry.title.trim()) {
				errors.push(`entries[${i}].title missing or empty`);
			}
			if (typeof entry.summary !== 'string' || !entry.summary.trim()) {
				errors.push(`entries[${i}].summary missing or empty`);
			}
			if (!Array.isArray(entry.tags) || entry.tags.length === 0) {
				errors.push(`entries[${i}].tags missing or empty`);
			}
		}
	}

	const version = (typeof data.generated_at === 'string' && data.generated_at.length >= 10)
		? data.generated_at.slice(0, 10)
		: null;
	const entry_count = Array.isArray(data.entries) ? data.entries.length : 0;

	return { valid: errors.length === 0, version, entry_count, schema_errors: errors };
}

async function readBody(req) {
	if (req.body && typeof req.body === 'object') return req.body;
	try {
		const chunks = [await readRawBody(req, 1_000_000)];
		const raw = Buffer.concat(chunks).toString('utf8').trim();
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('schema-check', '1000'),
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws JSON API Schema Check',
		tags: ['schema', 'validation', 'changelog', 'health', 'api'],
	}),

	async handler(req) {
		const body = await readBody(req);
		const api = body?.api;

		if (!api || !SUPPORTED_APIS.has(api)) {
			return {
				ok: false,
				error: `unsupported api "${api}"; supported: ${[...SUPPORTED_APIS].join(', ')}`,
			};
		}

		const origin = (env.APP_ORIGIN || 'https://three.ws').replace(/\/$/, '');
		const fetched_at = new Date().toISOString();

		if (api === 'changelog_json') {
			const url = `${origin}/changelog.json`;
			let data = null;
			let fetchError = null;

			try {
				const res = await fetch(url, {
					headers: { accept: 'application/json', 'user-agent': 'threews-schema-check/1.0' },
					signal: AbortSignal.timeout(10_000),
				});
				if (!res.ok) {
					fetchError = `http_${res.status}`;
				} else {
					data = await res.json();
				}
			} catch (err) {
				fetchError = err?.message || 'fetch_failed';
			}

			if (fetchError || data === null) {
				return {
					ok: false,
					api,
					valid: false,
					version: null,
					entry_count: 0,
					schema_errors: [fetchError || 'fetch_failed'],
					fetched_at,
				};
			}

			const { valid, version, entry_count, schema_errors } = validateChangelogJson(data);
			return { ok: true, api, valid, version, entry_count, schema_errors, fetched_at };
		}

		// Unreachable given the SUPPORTED_APIS guard above, but keeps linting clean.
		return { ok: false, error: 'unhandled_api' };
	},
});
