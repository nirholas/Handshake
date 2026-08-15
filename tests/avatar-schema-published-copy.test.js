// The avatar manifest schema is published at its own `$id`
// (https://three.ws/schema/avatar.v1.json) so any third-party validator can
// dereference it, which means the bytes under public/ must stay identical to
// the canonical copy inside @three-ws/avatar-schema. Nothing copies them at
// build time (public/ is Vite's publicDir, verbatim), so this is the guard:
// edit the package copy and this fails until the served copy is updated too.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANONICAL = fileURLToPath(new URL('../packages/avatar-schema/schema/avatar.v1.json', import.meta.url));
const PUBLISHED = fileURLToPath(new URL('../public/schema/avatar.v1.json', import.meta.url));

describe('published avatar schema', () => {
	it('is byte-identical to the package copy', () => {
		expect(readFileSync(PUBLISHED)).toEqual(readFileSync(CANONICAL));
	});

	it('declares the $id it is served from', () => {
		const schema = JSON.parse(readFileSync(PUBLISHED, 'utf8'));
		expect(schema.$id).toBe('https://three.ws/schema/avatar.v1.json');
	});

	it('matches the SCHEMA_ID the package advertises', async () => {
		const { SCHEMA_ID, schema } = await import('../packages/avatar-schema/src/index.js');
		expect(SCHEMA_ID).toBe('https://three.ws/schema/avatar.v1.json');
		expect(schema.$id).toBe(SCHEMA_ID);
	});
});
