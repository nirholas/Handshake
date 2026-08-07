// Holder gate: the cc_unconfigured (503) path and the "enter the open world"
// action.
//
// Production returns 503 cc_unconfigured from POST /api/community/holder-pass
// whenever CC_API_KEY is not set on the deployment (api/_lib/coin-communities.js).
// The gate used to dump that upstream message ("CoinCommunities is not
// configured") into the generic error state, whose only actions (retry, switch
// wallet) can never succeed while the key is absent. These tests pin the
// designed handling: the gate routes the code to a dedicated 'unavailable'
// state, and the 'general' action continues the same entry into the open
// General world instead of bouncing the player back to the lobby.
//
// The game modules are WebGL-heavy and DOM-bound, so like crews-wiring.test.js
// this pins the wiring at source level rather than booting a renderer.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

describe('holder gate: cc_unconfigured routes to the unavailable state', () => {
	const game = read('src/game/coincommunities.js');

	it('maps the cc_unconfigured error code to the unavailable state', () => {
		expect(game).toContain("err?.code === 'cc_unconfigured'");
		expect(game).toContain("state = 'unavailable'");
	});

	it("resolves the 'general' action by closing the gate and returning the sentinel", () => {
		expect(game).toContain("if (action === 'general')");
		expect(game).toContain("return 'general'");
	});

	it('enter() downgrades the tier to general when the gate returns the sentinel', () => {
		expect(game).toContain("if (pass === 'general')");
		expect(game).toContain("tier = 'general'");
		// The downgrade needs a reassignable binding.
		expect(game).toContain("let tier = opts.tier === 'holders' ? 'holders' : 'general'");
	});
});

describe('holder gate UI: unavailable state and open-world actions', () => {
	const ui = read('src/game/coincommunities-ui.js');

	it("renders a dedicated 'unavailable' case", () => {
		expect(ui).toContain("case 'unavailable':");
		expect(ui).toContain('Holder check is offline');
	});

	it("leads with the open world via the 'general' action, not a bare cancel", () => {
		expect(ui).toContain("btn('Enter the open world', 'general', 'cc-gate-primary')");
	});

	it("the short state's open-world button fires 'general' too", () => {
		expect(ui).toContain("btn('Enter the open world instead', 'general', 'cc-gate-ghost')");
	});
});
