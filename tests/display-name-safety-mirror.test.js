// Drift guard: multiplayer/src/display-name-safety.js is a byte-for-byte mirror
// of api/_lib/display-name-safety.js.
//
// Why a copy exists at all: the multiplayer service deploys from the
// multiplayer/ directory alone (deploy-cloudrun.sh runs `gcloud run deploy
// --source .` from there), so it cannot import across the repo boundary at
// runtime. The chat/name gate in WalkRoom therefore ships its own copy. This
// test is what keeps the copy honest: edit the api/_lib module and this fails
// until the mirror is re-copied, exactly like the spatial-mcp package mirror.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('display-name-safety mirror', () => {
	it('multiplayer copy is byte-identical to api/_lib source', () => {
		const source = readFileSync(new URL('../api/_lib/display-name-safety.js', import.meta.url), 'utf8');
		const mirror = readFileSync(new URL('../multiplayer/src/display-name-safety.js', import.meta.url), 'utf8');
		expect(mirror).toBe(source);
	});
});
