// Guards the two publicly discoverable manifests under public/.well-known/ that
// an AI client (or an app-store reviewer) can fetch without asking us first.
//
// The failure this prevents: ai-plugin.json described the whole platform as
// "pay-per-call via x402", so anything that read it came away believing the 3D
// generation lane cost money. That lane is free and keyless, and it is the lane
// the ChatGPT app and the custom GPT use. Two assertions keep the story honest:
//
//   1. The free 3D lane's own schema (3d-studio-openapi.yaml, the artifact the
//      app points at) carries no crypto or payment surface at all. Same regex
//      shape as tests/mcp-studio.test.js, which pins the MCP connector.
//   2. The platform manifest states the free lane first and the optional paid
//      catalog second, and stays byte-identical to what
//      scripts/build-discovery-cards.mjs will regenerate on the next prebuild
//      (a hand-edit there does not survive a deploy).

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
	pluginDescriptions,
	PLUGIN_LOGO_URL,
	PLUGIN_LEGAL_URL,
	FREE_3D_SCHEMA_URL,
} from '../scripts/lib/discovery-copy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(readFileSync(resolve(ROOT, 'public/.well-known/ai-plugin.json'), 'utf8'));
const studioSchema = readFileSync(resolve(ROOT, 'public/.well-known/3d-studio-openapi.yaml'), 'utf8');

// Anything that would signal a crypto / payment surface, matching the bar
// tests/mcp-studio.test.js holds the MCP connector to.
const FORBIDDEN =
	/x402|payment|paymentrequired|wallet|usdc|solana|\$three|pump\.?fun|token|coin|credit|price|\bpaid\b|crypto|onchain|web3|mint/gi;

describe("served 3D Studio schema (the app's discovery artifact)", () => {
	it('carries zero crypto / payment surface', () => {
		// The only tolerated hit is the schema reassuring readers there is
		// nothing to pay ("no payment"); an actual payment surface never reads
		// that way.
		const leaks = [];
		for (const m of studioSchema.matchAll(FORBIDDEN)) {
			const before = studioSchema.slice(Math.max(0, m.index - 4), m.index).toLowerCase();
			if (m[0].toLowerCase() === 'payment' && before.endsWith('no ')) continue;
			leaks.push(`${m[0]} @ ${JSON.stringify(studioSchema.slice(Math.max(0, m.index - 40), m.index + 40))}`);
		}
		expect(leaks, `served 3D Studio schema leaked a crypto/payment surface:\n${leaks.join('\n')}`).toEqual([]);
	});

	it('is the schema the platform manifest points free-lane callers at', () => {
		expect(existsSync(resolve(ROOT, 'public/.well-known/3d-studio-openapi.yaml'))).toBe(true);
		expect(plugin.description_for_model).toContain(FREE_3D_SCHEMA_URL);
	});
});

describe('platform ai-plugin.json', () => {
	it('leads with the free lane and marks the paid catalog as separate and optional', () => {
		const text = plugin.description_for_model;
		const free = text.indexOf('FREE and keyless');
		const paid = text.indexOf('PAID and entirely optional');
		expect(free).toBeGreaterThan(-1);
		expect(paid).toBeGreaterThan(free);
		// The generation endpoints a 3D request should reach are named on the
		// free side of that split, never on the paid side.
		for (const endpoint of ['https://three.ws/api/3d/studio', 'https://three.ws/api/mcp-studio', '/api/ar']) {
			const at = text.indexOf(endpoint);
			expect(at, `${endpoint} is missing from the manifest`).toBeGreaterThan(-1);
			expect(at, `${endpoint} is described on the paid side`).toBeLessThan(paid);
		}
		expect(text.indexOf('/api/x402/')).toBeGreaterThan(paid);
		expect(text).toMatch(/no account, no API key and nothing to pay/i);
	});

	it('never advertises the free 3D lane as paid', () => {
		expect(plugin.description_for_human).toMatch(/^Free, keyless 3D/);
		expect(plugin.auth).toEqual({ type: 'none' });
		// "3D ... pay-per-call" in one breath is the exact phrasing that made the
		// old manifest read as "generation costs crypto".
		expect(plugin.description_for_human).not.toMatch(/3D[^.]*pay-per-call/i);
	});

	it('uses a real branded logo, not the favicon', () => {
		expect(plugin.logo_url).toBe(PLUGIN_LOGO_URL);
		expect(plugin.logo_url).not.toMatch(/favicon/i);
		const asset = resolve(ROOT, 'public', new URL(plugin.logo_url).pathname.replace(/^\//, ''));
		expect(existsSync(asset), `${plugin.logo_url} has no file in public/`).toBe(true);
		const png = readFileSync(asset);
		// PNG signature + IHDR width/height: the listing asset is 512x512 owned IP.
		expect(png.subarray(1, 4).toString()).toBe('PNG');
		expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(512);
		expect(png.readUInt32BE(20)).toBe(png.readUInt32BE(16));
	});

	it('points at the canonical legal URL', () => {
		expect(plugin.legal_info_url).toBe(PLUGIN_LEGAL_URL);
		expect(plugin.legal_info_url).not.toMatch(/\.html$/);
	});

	it('matches what build-discovery-cards.mjs would regenerate (no hand-edit drift)', () => {
		// The live paid-service count is the only value the generator injects, so
		// read it back from the manifest and re-derive every other word.
		const count = Number(plugin.description_for_model.match(/catalog of (\d+) pay-per-call/)?.[1]);
		expect(Number.isInteger(count), 'manifest does not state a paid-service count').toBe(true);
		// The generator refuses to write a catalog smaller than 40 entries.
		expect(count).toBeGreaterThanOrEqual(40);
		const expected = pluginDescriptions(count);
		expect(plugin.description_for_human).toBe(expected.description_for_human);
		expect(plugin.description_for_model).toBe(expected.description_for_model);
	});
});
