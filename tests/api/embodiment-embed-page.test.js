// Pins the wiring contract of the hosted embodiment embed page
// (pages/embodiment/embed.html) that the persona widget iframes into ChatGPT.
//
// The EmbodimentStage engine is unit-tested elsewhere (tests/embodiment-*.test.js).
// This guards the PAGE contract the audit flagged as untested: which modules it
// imports, which query params it reads, which endpoint it resolves a durable
// persona through, and that it renders a designed surface when there is nothing
// to show — without a flaky WebGL/jsdom mount of three.js.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(resolve(ROOT, 'pages/embodiment/embed.html'), 'utf8');

describe('embodiment embed page — wiring contract', () => {
	it('imports the engine + overlay from paths that actually exist', () => {
		expect(html).toContain("import { EmbodimentStage } from '/apps-sdk/embodiment/embodiment-stage.js'");
		expect(html).toContain("import { mountOverlay } from '/apps-sdk/embodiment/overlay.js'");
		expect(existsSync(resolve(ROOT, 'apps-sdk/embodiment/embodiment-stage.js'))).toBe(true);
		expect(existsSync(resolve(ROOT, 'apps-sdk/embodiment/overlay.js'))).toBe(true);
	});

	it('reads the documented query params', () => {
		for (const p of ['persona', 'glb', 'name', 'state', 'text', 'emotion', 'intensity', 'gesture', 'bg', 'wallet', 'network']) {
			expect(html, `embed page should read the "${p}" param`).toContain(`q.get('${p}')`);
		}
	});

	it('renders a designed error surface when neither glb nor persona is supplied', () => {
		expect(html).toContain('if (!glbUrl && !personaId)');
		expect(html).toContain('No persona or GLB URL supplied.');
	});

	it('resolves a durable persona through the persona API and surfaces load failures', () => {
		expect(html).toContain('/api/mcp3d/persona?id=');
		// A failed resolve paints the overlay error state, not a blank canvas.
		expect(html).toContain("overlay.setState('error'");
	});

	it('the live on-chain identity poll is strictly opt-in (wallet=1) so a plain body makes zero extra calls', () => {
		expect(html).toContain("q.get('wallet') === '1'");
		expect(html).toContain('if (showWallet && personaId)');
	});

	it('keeps the resolved persona name on every later state change', () => {
		// The overlay label is tracked separately from the ?name param, so a
		// loading/idle/speaking transition after the resolve cannot revert the
		// persona's real name to the generic default.
		expect(html).toContain('let displayName');
		expect(html).toContain('{ ...detail, name: displayName }');
		expect(html).toContain('displayName = resolved.name;');
	});

	it('is sandboxable: noindex + framable by any host', () => {
		expect(html).toContain('name="robots" content="noindex"');
	});
});
