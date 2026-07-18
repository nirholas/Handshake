// Guards the served 3D Studio OpenAPI schema that describes the custom-GPT
// Actions surface (https://three.ws/.well-known/3d-studio-openapi.yaml).
//
// Two things matter for the OpenAI submission:
//  1. The served copy must never drift from the custom-GPT Action file the
//     builder pastes in (`prompts/store-submissions/_generated/openai-actions.yaml`).
//  2. The app's discovery surface must stay keyless and free of any crypto /
//     payment surface, so a reviewer who fetches it sees the same "free, no
//     account, no payment" story the submission claims.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVED = resolve(ROOT, 'public/.well-known/3d-studio-openapi.yaml');
const SOURCE = resolve(ROOT, 'prompts/store-submissions/_generated/openai-actions.yaml');

const servedRaw = readFileSync(SERVED, 'utf8');
const sourceRaw = readFileSync(SOURCE, 'utf8');
const doc = parse(servedRaw);

describe('3d-studio-openapi served schema', () => {
	it('is byte-identical to the custom-GPT Action source (drift guard)', () => {
		expect(servedRaw).toBe(sourceRaw);
	});

	it('is a valid OpenAPI 3.1 document for three.ws', () => {
		expect(doc.openapi).toBe('3.1.0');
		expect(doc.info?.title).toBe('three.ws 3D Studio');
		expect(doc.servers?.[0]?.url).toBe('https://three.ws');
	});

	it('declares no authentication (keyless)', () => {
		// An explicit empty root security requirement = "no auth required".
		expect(doc.security).toEqual([]);
		expect(doc.components?.securitySchemes ?? {}).toEqual({});
	});

	it('exposes only the free generation action (POST generate + GET poll)', () => {
		expect(Object.keys(doc.paths)).toEqual(['/api/3d/studio']);
		expect(doc.paths['/api/3d/studio'].post?.operationId).toBe('generate3DModel');
		expect(doc.paths['/api/3d/studio'].get?.operationId).toBe('checkModelJob');
		// No action may be flagged consequential (nothing charges or mutates state).
		expect(doc.paths['/api/3d/studio'].post['x-openai-isConsequential']).toBe(false);
		expect(doc.paths['/api/3d/studio'].get['x-openai-isConsequential']).toBe(false);
	});

	it('uses the canonical no-.html legal URLs', () => {
		expect(servedRaw).not.toMatch(/legal\/\w+\.html/);
		expect(servedRaw).toContain('https://three.ws/legal/privacy');
		expect(servedRaw).toContain('https://three.ws/legal/tos');
	});

	it('carries ZERO crypto / payment / settlement surface', () => {
		// Deliberately excludes the bare word "payment": the schema says
		// "No account, no API key, no payment" as reassurance, which is fine.
		// This matches real crypto/settlement/collection indicators only.
		const FORBIDDEN =
			/x402|usdc|\bsolana\b|onchain|web3|\bwallet\b|crypto|\$three|pump\.?fun|checkout|invoice|\bprice\b|billing|paymentrequired|permit2/i;
		const match = servedRaw.match(FORBIDDEN);
		expect(match, `served schema leaked a crypto/payment token: ${match?.[0]}`).toBeNull();
	});
});

describe('3d-studio Actions responses conform to the served schema', () => {
	// Bind api/3d/studio.js's real wire output to the GenerationState schema so a
	// response-shape change and a schema change cannot silently diverge.
	const allowedKeys = new Set(Object.keys(doc.components.schemas.GenerationState.properties));
	const validStatus = new Set(doc.components.schemas.GenerationState.properties.status.enum);

	async function shapers() {
		return import('../../api/3d/studio.js');
	}

	it('GenerationState allows exactly the keys api/3d/studio.js can emit', async () => {
		const { shapeSubmit, shapePoll } = await shapers();
		const outputs = [
			shapeSubmit({ status: 'done', glb_url: 'https://cdn.example/a.glb' }, 'https://three.ws', 'a fox'),
			shapeSubmit({ status: 'pending', job_id: 'f1.abc.sig' }, 'https://three.ws', 'a fox'),
			shapePoll({ status: 'done', glb_url: 'https://cdn.example/a.glb' }, 'https://three.ws', 'f1.abc.sig', 'a fox'),
			shapePoll({ status: 'failed', error: 'upstream hiccup' }, 'https://three.ws', 'f1.abc.sig', 'a fox'),
		].filter(Boolean);
		expect(outputs.length).toBeGreaterThan(0);
		for (const out of outputs) {
			expect(validStatus.has(out.status), `status "${out.status}" not in schema enum`).toBe(true);
			for (const key of Object.keys(out)) {
				expect(allowedKeys.has(key), `response key "${key}" is not declared in GenerationState`).toBe(true);
			}
		}
	});
});
