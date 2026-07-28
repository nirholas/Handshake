// Guardrail: the published x402 discovery catalog must stay "fully green" —
// every resource must pass the exact checks the open indexers (CDP Bazaar /
// agentic.market, x402scan, 402index) run, the same ones
// scripts/verify-x402-discovery.mjs enforces against the live catalog. A single
// malformed resource (a newline in payTo, a bazaar.info that fails its own
// schema, a missing output.example) silently delists us from discovery — that's
// how we once lost all 43 resources to one stray newline.
//
// This renders the catalog locally (no deploy/network) and asserts ZERO errors
// AND ZERO warnings, so any regression in api/wk.js is a red build before it can
// ship and quietly drop us from the indexes.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const execFileAsync = promisify(execFile);

const NETWORK_BASE = 'eip155:8453';
const SOLANA_PREFIX = 'solana:';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function isAbsoluteHttps(u) {
	try {
		return new URL(u).protocol === 'https:';
	} catch {
		return false;
	}
}
function isPrintableAscii(s, max) {
	return typeof s === 'string' && s.length > 0 && s.length <= max && /^[\x20-\x7e]+$/.test(s);
}
function label(r) {
	return r.toolName ? `${r.path || r.url} :: ${r.toolName}` : r.path || r.url;
}

// Mirrors checkResource() in scripts/verify-x402-discovery.mjs exactly.
function checkResource(r) {
	const errors = [];
	const warnings = [];

	if (!r.url) errors.push('missing resource.url');
	if (!r.description || String(r.description).trim().length < 12)
		warnings.push('description missing or very short (<12 chars)');
	const accepts = Array.isArray(r.accepts) ? r.accepts : [];
	if (!accepts.length) errors.push('no accepts[] — not payable, will not be cataloged');
	accepts.forEach((a, i) => {
		for (const f of ['scheme', 'network', 'amount', 'asset', 'payTo']) {
			if (a[f] == null || a[f] === '') errors.push(`accepts[${i}] missing ${f}`);
		}
		if (typeof a.payTo === 'string' && /\s/.test(a.payTo))
			errors.push(`accepts[${i}].payTo contains whitespace ("${a.payTo}")`);
	});

	const nets = accepts.map((a) => a.network || '');
	const hasBase = nets.includes(NETWORK_BASE);
	const hasSolana = nets.some((n) => n.startsWith(SOLANA_PREFIX));
	if (!hasBase && !hasSolana) warnings.push('advertises neither Base nor Solana');

	if (r.serviceName != null && !isPrintableAscii(r.serviceName, 32))
		warnings.push('serviceName not printable-ASCII ≤32 chars');
	if (r.tags != null) {
		if (!Array.isArray(r.tags) || r.tags.length > 5) warnings.push('tags must be an array of ≤5');
		else if (!r.tags.every((t) => isPrintableAscii(t, 32)))
			warnings.push('a tag is not printable-ASCII ≤32 chars');
	}
	if (r.iconUrl != null && !isAbsoluteHttps(r.iconUrl))
		warnings.push('iconUrl is not an absolute https URL');

	const bazaar = r.extensions?.bazaar || r.bazaar;
	if (!bazaar) {
		errors.push('no bazaar extension');
	} else {
		if (bazaar.discoverable !== true) warnings.push('bazaar.discoverable is not true');
		if (!bazaar.info) errors.push('bazaar.info missing');
		if (!bazaar.schema) {
			warnings.push('bazaar.schema missing');
		} else if (bazaar.info) {
			let validate;
			try {
				validate = ajv.compile(bazaar.schema);
			} catch (e) {
				errors.push(`bazaar.schema does not compile: ${e.message}`);
			}
			if (validate && !validate(bazaar.info)) {
				const detail = (validate.errors || [])
					.map((e) => `${e.instancePath || '/'} ${e.message}`)
					.join('; ');
				errors.push(`bazaar.info FAILS its own schema → CDP rejects: ${detail}`);
			}
		}
		if (!bazaar.info?.output?.example) warnings.push('no output.example');
	}

	return { label: label(r), errors, warnings };
}

// Rendered in a CHILD node process, loading api/wk.js natively — exactly how
// production (server/index.mjs) loads it. Importing it in-process here would
// pull its multi-thousand-module graph through vitest's transform pipeline:
// ~55s in isolation and past the 120s hook budget under full-suite contention,
// so the file flaked on load, never on content. The native import is ~6s.
const RENDER_ENV = {
	APP_ORIGIN: 'https://three.ws',
	X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
	X402_PAY_TO_SOLANA: 'So11111111111111111111111111111111111111112',
	X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	X402_ASSET_MINT_SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	X402_ASSET_ADDRESS_ARBITRUM: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
	X402_MAX_AMOUNT_REQUIRED: '1000',
	X402_FEE_PAYER_SOLANA: 'So11111111111111111111111111111111111111112',
};

const WK_URL = new URL('../../api/wk.js', import.meta.url).href;
const RENDER_SCRIPT = `
	const mod = await import(${JSON.stringify(WK_URL)});
	const res = {
		statusCode: 0,
		headers: {},
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(body) { this.body = body; },
	};
	const req = {
		method: 'GET',
		url: '/.well-known/x402-discovery?name=x402-discovery',
		query: { name: 'x402-discovery' },
		headers: {},
	};
	await mod.default(req, res);
	process.stdout.write(res.body);
`;

let renderPromise;
function renderDiscovery() {
	// One render serves every test — the catalog is a pure function of the env
	// above, so re-rendering only re-pays the child's cold import.
	renderPromise ??= (async () => {
		const { stdout } = await execFileAsync(
			process.execPath,
			['--input-type=module', '-e', RENDER_SCRIPT],
			{ env: { ...process.env, ...RENDER_ENV }, maxBuffer: 64 * 1024 * 1024 },
		);
		return JSON.parse(stdout);
	})();
	return renderPromise;
}

describe('x402 discovery catalog is fully green', () => {
	let report;
	beforeAll(async () => {
		const doc = await renderDiscovery();
		report = (doc.resources || []).map(checkResource);
	});

	it('catalogs a non-trivial number of resources', () => {
		expect(report.length).toBeGreaterThan(20);
	});

	it('has no errors that would get a resource dropped by the indexers', () => {
		const failing = report.filter((r) => r.errors.length);
		expect(
			failing,
			`Resources the indexers will DROP:\n${failing
				.map((r) => `  ✗ ${r.label}: ${r.errors.join('; ')}`)
				.join('\n')}`,
		).toEqual([]);
	});

	it('has no listing-quality warnings (every resource ranks and renders fully)', () => {
		const warned = report.filter((r) => r.warnings.length);
		expect(
			warned,
			`Resources with listing-quality warnings:\n${warned
				.map((r) => `  ▲ ${r.label}: ${r.warnings.join('; ')}`)
				.join('\n')}`,
		).toEqual([]);
	});

	it('every resource carries a real output.example for result cards', async () => {
		const doc = await renderDiscovery();
		for (const r of doc.resources || []) {
			const ex = (r.extensions?.bazaar || r.bazaar)?.info?.output?.example;
			expect(ex, `${label(r)} is missing bazaar.info.output.example`).toBeTruthy();
		}
	});
});
