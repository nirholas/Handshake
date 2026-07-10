// Guards the rate-limiter bucket contract across every api/ handler.
//
// Two failure modes this locks down, both of which only surface in production:
//
//  1. A handler calls `limits.someTypo(ip)` — `limits` is a plain object, so the
//     call throws "is not a function" at request time and the endpoint 500s for
//     every caller. Nothing at build or import time catches it.
//  2. A page-load-critical read gets parked back on the shared `public:ip`
//     bucket. That bucket is shared by ~150 endpoints, so a page that fans out
//     to several of them starves its own budget and 429s the user (this is what
//     took down the /play lobby, the agent profile, and the oracle activity
//     feed). The isolated clusters below must keep their dedicated buckets.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { limits } from '../../api/_lib/rate-limit.js';

const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (p.endsWith('.js')) out.push(p);
	}
	return out;
}

/** Every `limits.<name>(` reference under api/, mapped to the files using it. */
function collectBucketRefs() {
	const refs = new Map();
	for (const file of walk(API_DIR)) {
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(/limits\.([a-zA-Z0-9_]+)\s*\(/g)) {
			if (!refs.has(m[1])) refs.set(m[1], new Set());
			refs.get(m[1]).add(relative(REPO, file));
		}
	}
	return refs;
}

describe('rate-limit bucket contract', () => {
	it('every limits.* referenced in api/ is a defined bucket', () => {
		const refs = collectBucketRefs();
		const undefinedBuckets = [...refs.keys()].filter((name) => typeof limits[name] !== 'function');
		expect(
			undefinedBuckets.map((n) => `limits.${n} used by ${[...refs.get(n)].join(', ')}`),
		).toEqual([]);
	});

	it('exposes the dedicated buckets that isolate page-load-critical reads', () => {
		for (const bucket of ['marketFeedIp', 'agentProfileIp', 'marketDataIp', 'galaxyIp', 'publicIp']) {
			expect(typeof limits[bucket], `limits.${bucket}`).toBe('function');
		}
	});

	// These clusters each fan out several requests on a single page load, so they
	// must never share the generic public:ip pool again.
	const ISOLATED = {
		agentProfileIp: [
			'api/agents/_id/achievements.js',
			'api/agents/_id/reputation.js',
			'api/agents/[id]/tiers.js',
			'api/agents/patronage.js',
			'api/agents/reputation-batch.js',
			'api/agents/networth.js',
		],
		marketDataIp: [
			'api/coin/markets.js',
			'api/coin/global.js',
			'api/coin/liquidations.js',
			'api/coin/gas.js',
			'api/defi/protocols.js',
			'api/crypto/trending.js',
		],
		galaxyIp: ['api/galaxy.js', 'api/galaxy/flows.js'],
		marketFeedIp: ['api/pump/trending.js', 'api/pump/search.js'],
	};

	for (const [bucket, files] of Object.entries(ISOLATED)) {
		for (const rel of files) {
			it(`${rel} uses limits.${bucket}, not the shared publicIp pool`, () => {
				const src = readFileSync(join(REPO, rel), 'utf8');
				expect(src).toContain(`limits.${bucket}(`);
				expect(src).not.toContain('limits.publicIp(');
			});
		}
	}

	it('publicIp keeps enough headroom for pages that fan out to several reads', () => {
		// Raised from 60 after the shared bucket starved real page loads. It is a
		// per-instance in-memory guard (no Redis cost), so headroom is free.
		const src = readFileSync(join(REPO, 'api/_lib/rate-limit.js'), 'utf8');
		const m = src.match(/getLimiter\('public:ip',\s*\{\s*limit:\s*(\d+)/);
		expect(m, 'public:ip limiter definition').toBeTruthy();
		expect(Number(m[1])).toBeGreaterThanOrEqual(240);
	});

	it('api/_lib/rate-limit.js contains no raw NUL byte', () => {
		// A literal NUL makes grep/ripgrep treat the file as binary and silently
		// skip every match in it. The bucket key separator must use the \0 escape.
		const buf = readFileSync(join(REPO, 'api/_lib/rate-limit.js'));
		expect(buf.includes(0)).toBe(false);
	});
});
