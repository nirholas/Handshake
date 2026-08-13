// Pins which handler file serves each /api/kol/* path.
//
// The KOL surface is split across two files: api/kol/[action].js dispatches
// wallets / import-gmgn / leaderboard / tracker, while api/kol/trades.js serves
// the trade feed on its own. That split is not cosmetic. Vercel filesystem
// precedence (mirrored by server/index.mjs via resolveApi) puts an exact file
// ahead of a sibling [action].js, so once api/kol/trades.js exists, a `trades`
// branch inside the dispatcher can never run. One shipped that way and quietly
// drifted from the served copy (different limit clamping, different validation
// message) until this guard was written.
//
// The guard asserts both halves: every dispatcher action resolves to
// [action].js and has a branch, and /api/kol/trades resolves to trades.js and is
// absent from the dispatcher.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiHandler } from '../../server/route-resolve.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const API_ROOT = join(REPO, 'api');

const DISPATCHER = join(API_ROOT, 'kol', '[action].js');
const TRADES = join(API_ROOT, 'kol', 'trades.js');

const dispatcherSource = readFileSync(DISPATCHER, 'utf8');

// The literal keys of the DISPATCH map, e.g. "leaderboard" / "'import-gmgn'".
function dispatchActions() {
	const map = dispatcherSource.match(/const DISPATCH = \{([\s\S]*?)\n\};/);
	if (!map) throw new Error('DISPATCH map not found in api/kol/[action].js');
	return [...map[1].matchAll(/^\t'?([a-z-]+)'?:/gm)].map((m) => m[1]);
}

describe('/api/kol route resolution', () => {
	const actions = dispatchActions();

	it('dispatches the four consolidated actions', () => {
		expect([...actions].sort()).toEqual(['import-gmgn', 'leaderboard', 'tracker', 'wallets']);
	});

	for (const action of actions) {
		it(`/api/kol/${action} resolves to the dispatcher`, () => {
			const route = resolveApiHandler(API_ROOT, `/api/kol/${action}`);
			expect(route?.file).toBe(DISPATCHER);
			expect(route?.params).toEqual({ action });
		});
	}

	it('/api/kol/trades resolves to its own file, not the dispatcher', () => {
		const route = resolveApiHandler(API_ROOT, '/api/kol/trades');
		expect(route?.file).toBe(TRADES);
	});

	it('the dispatcher carries no trades branch (it would be unreachable)', () => {
		expect(actions).not.toContain('trades');
		expect(dispatcherSource).not.toMatch(/fetchKolTrades/);
	});

	it('an unknown action still lands on the dispatcher, which answers 404', () => {
		const route = resolveApiHandler(API_ROOT, '/api/kol/not-an-action');
		expect(route?.file).toBe(DISPATCHER);
		expect(dispatcherSource).toMatch(/unknown kol action/);
	});
});
