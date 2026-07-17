// @vitest-environment jsdom
//
// The homepage mini-forge's Options controls (src/home-forge-controls.js) give
// the chamber the full /forge brains — quality tiers, a live engine picker,
// aspect, BYOK, and the $THREE High gate — rendered from the SAME
// /api/forge?catalog + ?health endpoints the full page reads. These tests pin
// the behavior that keeps the two surfaces from drifting and preserves the
// mini-forge's "Auto = health-routed, never dead-ends" default:
//
//   1. Auto is the default engine → getConfig() sends NO backend (health routing).
//   2. The tier + engine + aspect buttons are built from the catalog payload.
//   3. Picking a lane sends that backend; picking Auto clears it again.
//   4. A lane the ?health probe reports "down" is disabled and unpickable.
//   5. Aspect ratio flows through to the config; geometry lanes hide the aspect row.
//   6. An older deploy with no catalog yields an inert controller on free defaults.
//
// three-access / forge-pay are mocked: this suite is about the controls' own
// wiring, not the $THREE access network or the payment modal.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/three-access.js', () => ({
	getAccess: vi.fn(async () => ({ access: { eligible: false, feature: 'forge.high' }, tier: { level: 0 } })),
	getTierPass: vi.fn(async () => null),
	attachTierPass: vi.fn((h) => h),
	primeTierPass: vi.fn(),
}));
vi.mock('../src/three-lock.js', () => ({
	renderLock: vi.fn(),
	lockStateFromAccess: vi.fn((a) => a),
}));
vi.mock('../src/forge-pay.js', () => ({
	payForHighGeneration: vi.fn(async () => ({ ok: false })),
}));

import { initForgeControls } from '../src/home-forge-controls.js';

// A minimal catalog shaped like buildCatalog() in api/_lib/forge-tiers.js.
const CATALOG = {
	paths: ['image', 'geometry', 'sketch'],
	default_tier: 'standard',
	default_backend: { image: 'nvidia', geometry: 'hunyuan3d', sketch: 'triposg' },
	tiers: [
		{ id: 'draft', label: 'Draft', blurb: 'Fast preview', price_usdc: '0.00' },
		{ id: 'standard', label: 'Standard', blurb: 'Balanced', price_usdc: '0.00' },
		{ id: 'high', label: 'High', blurb: '200k poly + PBR', price_usdc: '0.50' },
	],
	backends: [
		{ id: 'nvidia', label: 'NVIDIA', paths: ['image'], byok: null, free: true, user_images: false, configured: true, blurb: 'Free TRELLIS on NVIDIA NIM' },
		{ id: 'hunyuan3d', label: 'Hunyuan3D', paths: ['image', 'geometry'], byok: null, free: true, user_images: true, configured: true, blurb: 'Self-hosted image→3D' },
		{ id: 'meshy', label: 'Meshy', paths: ['image', 'geometry'], byok: 'meshy', free: false, user_images: true, configured: false, blurb: 'Meshy on your key' },
		{ id: 'triposg', label: 'TripoSG', paths: ['sketch'], byok: null, free: true, user_images: false, configured: true, blurb: 'Sketch→3D' },
	],
};

const HEALTH = { backends: { nvidia: { status: 'ok' }, hunyuan3d: { status: 'down', message: 'worker cold' }, meshy: { status: 'ok' } } };

function mountPanel() {
	document.body.innerHTML = `
		<section id="home-forge">
			<button data-hf-opts aria-expanded="false"></button>
			<div data-hf-panel hidden>
				<div class="hf-panel-row"><div data-hf-tier></div></div>
				<div class="hf-panel-row"><div data-hf-engine></div></div>
				<div class="hf-panel-row" data-hf-aspect-row><div data-hf-aspect></div></div>
				<div data-hf-byok hidden>
					<span data-hf-byok-label></span>
					<input data-hf-byok-key />
					<p data-hf-byok-hint></p>
				</div>
				<div data-hf-lock hidden></div>
				<p data-hf-perk hidden></p>
			</div>
		</section>`;
	return document.getElementById('home-forge');
}

function initWith({ catalog = CATALOG, health = HEALTH } = {}) {
	global.fetch = vi.fn(async (url) => {
		const u = String(url);
		if (u.includes('catalog')) return { ok: true, json: async () => catalog };
		if (u.includes('health')) return { ok: true, json: async () => health };
		return { ok: true, json: async () => ({}) };
	});
	const root = mountPanel();
	return initForgeControls({ root, clientHeaders: { 'x-forge-client': 'test' }, onRerun: vi.fn() });
}

describe('home-forge controls', () => {
	beforeEach(() => {
		vi.useRealTimers();
	});
	afterEach(() => {
		document.body.innerHTML = '';
		vi.restoreAllMocks();
	});

	it('defaults to Auto — getConfig sends no backend (server health-routes)', async () => {
		const c = initWith();
		await c.whenReady;
		const cfg = c.getConfig();
		expect(cfg.backend).toBeNull();
		expect(cfg.tier).toBe('standard');
		expect(cfg.aspect_ratio).toBe('1:1');
		expect(cfg.path).toBe('image');
	});

	it('builds tier + engine buttons from the catalog', async () => {
		const c = initWith();
		await c.whenReady;
		const tiers = [...document.querySelectorAll('[data-hf-tier] button')].map((b) => b.dataset.tier);
		expect(tiers).toEqual(['draft', 'standard', 'high']);
		// High carries the $THREE lock pill.
		expect(document.querySelector('[data-hf-tier] button[data-tier="high"] .hfc-lock')).toBeTruthy();
		const engines = [...document.querySelectorAll('[data-hf-engine] button')].map((b) => b.dataset.engine);
		// Auto first, then the text/photo lanes; the sketch-only lane (triposg) is dropped.
		expect(engines[0]).toBe('__auto');
		expect(engines).toContain('nvidia');
		expect(engines).toContain('hunyuan3d');
		expect(engines).not.toContain('triposg');
	});

	it('picking a lane sends that backend; re-picking Auto clears it', async () => {
		const c = initWith();
		await c.whenReady;
		document.querySelector('[data-hf-engine] button[data-engine="nvidia"]').click();
		expect(c.getConfig().backend).toBe('nvidia');
		document.querySelector('[data-hf-engine] button[data-engine="__auto"]').click();
		expect(c.getConfig().backend).toBeNull();
	});

	it('disables a lane the health probe reports down', async () => {
		const c = initWith();
		await c.whenReady;
		// loadHealth() runs after the catalog resolves; give its promise a tick.
		await new Promise((r) => setTimeout(r, 0));
		const down = document.querySelector('[data-hf-engine] button[data-engine="hunyuan3d"]');
		expect(down.disabled).toBe(true);
		expect(down.getAttribute('aria-disabled')).toBe('true');
	});

	it('aspect ratio flows into the config and hides for geometry lanes', async () => {
		const c = initWith();
		await c.whenReady;
		document.querySelector('[data-hf-aspect] button[data-aspect="16:9"]').click();
		expect(c.getConfig().aspect_ratio).toBe('16:9');
		// hunyuan3d exposes geometry → aspect row hides, path becomes geometry.
		await new Promise((r) => setTimeout(r, 0)); // let health settle first
		// hunyuan3d is down in HEALTH; pick meshy (geometry, configured via byok) instead.
		document.querySelector('[data-hf-engine] button[data-engine="meshy"]').click();
		expect(c.getConfig().path).toBe('geometry');
		expect(document.querySelector('[data-hf-aspect-row]').hidden).toBe(true);
	});

	it('surfaces the BYOK key row for a keyed lane and sends the key header', async () => {
		const c = initWith();
		await c.whenReady;
		document.querySelector('[data-hf-engine] button[data-engine="meshy"]').click();
		expect(document.querySelector('[data-hf-byok]').hidden).toBe(false);
		const input = document.querySelector('[data-hf-byok-key]');
		input.value = 'msy_live_key';
		input.dispatchEvent(new Event('input'));
		const headers = await c.buildHeaders({ 'content-type': 'application/json' });
		expect(headers['x-forge-provider-key']).toBe('msy_live_key');
	});

	it('yields an inert free-defaults controller when the catalog is missing', async () => {
		const c = initWith({ catalog: null });
		const ready = await c.whenReady;
		expect(ready).toBe(false);
		const cfg = c.getConfig();
		expect(cfg).toEqual({ tier: 'standard', path: 'image', backend: null, aspect_ratio: '1:1', byokKey: '' });
	});
});
