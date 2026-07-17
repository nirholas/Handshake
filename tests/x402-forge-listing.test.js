// Forge (/api/x402/forge) — discovery listing quality + schema completeness.
//
// Forge is the platform's crown-jewel paid endpoint (real text→3D / image→3D),
// so its x402scan / CDP Bazaar listing has to sell the use-case AND be complete
// enough that an autonomous agent can call it blind. The description, tags,
// serviceName, and input/output schemas all live in ONE place —
// api/_lib/forge-listing.js — imported by both the live 402 challenge
// (api/x402/forge.js) and the discovery mirror (api/wk.js), so the two can't
// drift. These tests lock that shared contract down:
//   1. the description leads with the use-case and quotes the tiers/prices,
//      the keyless pledge, the free poll, and the free draft on-ramp,
//   2. the tags anchor the 3D / AI / Utility categories within the Bazaar's
//      5-tag, ≤32-ASCII limits,
//   3. serviceName is ≤32 printable ASCII (or the CDP validator soft-drops it),
//   4. the input schema names every call field (prompt, reference-image mode,
//      tier, aspect ratio) and the output schema documents the poll token + GLB,
//   5. the published input/output examples satisfy their own schemas.
//
// The bazaar.info ⇄ bazaar.schema self-validation (CDP-acceptance) is covered
// end-to-end by scripts/verify-x402-discovery.mjs against the discovery doc, so
// it is not re-checked here — which lets us mock the heavy x402-spec leaf (it
// transitively pulls the CDP SDK + Solana client this test doesn't need).

import { describe, it, expect, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

vi.mock('../api/_lib/x402-spec.js', () => ({ buildBazaarSchema: () => ({}) }));

const {
	FORGE_SERVICE_NAME,
	FORGE_TAGS,
	FORGE_ROUTE_DESCRIPTION,
	FORGE_INPUT_SCHEMA,
	FORGE_OUTPUT_SCHEMA,
	FORGE_INPUT_EXAMPLE,
	FORGE_OUTPUT_EXAMPLE,
	FORGE_BAZAAR,
} = await import('../api/_lib/forge-listing.js');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const isPrintableAscii = (s, max) =>
	typeof s === 'string' && s.length > 0 && s.length <= max && /^[\x20-\x7e]+$/.test(s);

describe('forge listing — description sells the use-case + funnel', () => {
	it('leads with the concrete agent use-cases', () => {
		expect(FORGE_ROUTE_DESCRIPTION).toMatch(/game asset/i);
		expect(FORGE_ROUTE_DESCRIPTION).toMatch(/NFT/i);
		expect(FORGE_ROUTE_DESCRIPTION).toMatch(/scene/i);
		expect(FORGE_ROUTE_DESCRIPTION).toMatch(/product vis/i);
	});

	it('quotes all three quality tiers and their prices', () => {
		expect(FORGE_ROUTE_DESCRIPTION).toMatch(/draft \$0\.05/);
		expect(FORGE_ROUTE_DESCRIPTION).toMatch(/standard \$0\.15/);
		expect(FORGE_ROUTE_DESCRIPTION).toMatch(/high \$0\.50/);
	});

	it('makes the keyless / no-account pledge and names Solana settlement', () => {
		expect(FORGE_ROUTE_DESCRIPTION).toMatch(/no API key/i);
		expect(FORGE_ROUTE_DESCRIPTION).toMatch(/no account/i);
		expect(FORGE_ROUTE_DESCRIPTION).toMatch(/Solana/);
	});

	it('wires the free poll and the free draft on-ramp', () => {
		expect(FORGE_ROUTE_DESCRIPTION).toContain('/api/forge?job=');
		expect(FORGE_ROUTE_DESCRIPTION).toContain('/api/3d/generate');
	});
});

describe('forge listing — service metadata within Bazaar limits', () => {
	it('serviceName is ≤32 printable ASCII (CDP soft-drop rule)', () => {
		expect(isPrintableAscii(FORGE_SERVICE_NAME, 32)).toBe(true);
	});

	it('has ≤5 printable-ASCII tags anchoring the 3D / AI / Utility categories', () => {
		expect(Array.isArray(FORGE_TAGS)).toBe(true);
		expect(FORGE_TAGS.length).toBeLessThanOrEqual(5);
		for (const t of FORGE_TAGS) expect(isPrintableAscii(t, 32)).toBe(true);
		expect(FORGE_TAGS).toEqual(expect.arrayContaining(['3d', 'ai', 'utility']));
	});
});

describe('forge listing — schema completeness (call it blind)', () => {
	it('input schema names every generation field', () => {
		const p = FORGE_INPUT_SCHEMA.properties;
		expect(p.prompt).toBeTruthy(); // text→3D
		expect(p.image_urls).toBeTruthy(); // image→3D (reference views)
		expect(p.image_urls.maxItems).toBe(6);
		expect(p.tier.enum).toEqual(['draft', 'standard', 'high']);
		expect(p.aspect_ratio.enum).toContain('1:1');
	});

	it('does NOT advertise the internal health-check canary in the public listing', () => {
		expect(FORGE_INPUT_SCHEMA.properties.mode).toBeUndefined();
		expect(FORGE_INPUT_SCHEMA.properties.type).toBeUndefined();
	});

	it('output schema documents the poll token and the GLB output', () => {
		expect(FORGE_OUTPUT_SCHEMA.required).toContain('status');
		const p = FORGE_OUTPUT_SCHEMA.properties;
		expect(p.job_id).toBeTruthy();
		expect(p.poll_url).toBeTruthy();
		expect(p.glb_url).toBeTruthy();
		expect(p.mode.enum).toEqual(['text_to_3d', 'image_to_3d']);
	});

	it('the published input example satisfies FORGE_INPUT_SCHEMA', () => {
		const validate = ajv.compile(FORGE_INPUT_SCHEMA);
		const ok = validate(FORGE_INPUT_EXAMPLE);
		expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
		expect(ok).toBe(true);
	});

	it('the published output example satisfies FORGE_OUTPUT_SCHEMA', () => {
		const validate = ajv.compile(FORGE_OUTPUT_SCHEMA);
		const ok = validate(FORGE_OUTPUT_EXAMPLE);
		expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
		expect(ok).toBe(true);
	});
});

describe('forge listing — the shared bazaar block is what both surfaces advertise', () => {
	it('info carries the input body + output example examples verbatim', () => {
		expect(FORGE_BAZAAR.discoverable).toBe(true);
		expect(FORGE_BAZAAR.info.input.method).toBe('POST');
		expect(FORGE_BAZAAR.info.input.body).toEqual(FORGE_INPUT_EXAMPLE);
		expect(FORGE_BAZAAR.info.output.example).toEqual(FORGE_OUTPUT_EXAMPLE);
		// The response example includes the resolved backend so result cards render it.
		expect(FORGE_BAZAAR.info.output.example.backend).toBe('nvidia');
	});
});
