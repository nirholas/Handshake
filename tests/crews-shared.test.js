import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	RESERVED_TAGS,
	TAG_RE,
	crestHues,
	presenceLine,
	realmLabel,
	sanitizeTag,
	tagFromPath,
	validateTag,
} from '../src/crews-shared.js';
import { normalizeTag, isReservedTag } from '../api/_lib/crews-store.js';

describe('crew tags', () => {
	it('accepts 2 to 6 letters or digits and upper-cases them', () => {
		expect(sanitizeTag(' nova ')).toBe('NOVA');
		expect(sanitizeTag('n-o-v-a')).toBe('NOVA');
		expect(sanitizeTag('3ws')).toBe('3WS');
		expect(TAG_RE.test('3WS')).toBe(true);
	});

	it('rejects a tag that is too short, too long, or reserved', () => {
		expect(validateTag('n').ok).toBe(false);
		expect(validateTag('toolongtag').ok).toBe(false);
		expect(validateTag('search').ok).toBe(false);
		expect(validateTag('search').message).toMatch(/reserved/i);
	});

	it('gives an empty input guidance rather than an error', () => {
		const v = validateTag('');
		expect(v.ok).toBe(false);
		expect(v.tone).toBe('');
		expect(v.message).toMatch(/2 to 6/);
	});

	it('agrees with the server on what a tag is', () => {
		for (const raw of ['nova', '3ws', 'a', 'toolongtag', 'n-o-v-a', '  ax ']) {
			const client = validateTag(raw);
			const server = normalizeTag(raw);
			// The client only calls a tag good when the server would also accept it.
			expect(client.ok).toBe(Boolean(server) && !isReservedTag(server));
			if (server) expect(client.tag).toBe(server);
		}
	});

	// The reserved list is duplicated so the founding form can answer without a
	// round trip. If the two ever drift, a tag the form calls good is refused on
	// submit, the exact failure the duplication exists to avoid.
	it('keeps the reserved list identical to the server list', () => {
		const src = readFileSync(new URL('../api/_lib/crews-store.js', import.meta.url), 'utf8');
		const match = src.match(/const RESERVED_TAGS = new Set\(\[([^\]]*)\]\)/);
		expect(match, 'server RESERVED_TAGS literal not found').toBeTruthy();
		const serverTags = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
		expect(serverTags.sort()).toEqual([...RESERVED_TAGS].sort());
		for (const tag of serverTags) expect(isReservedTag(tag)).toBe(true);
	});

	it('reserves every tag that would shadow a real /api/crews route file', () => {
		// server/index.mjs resolves an exact file before a [param].js, so any
		// endpoint added under api/crews/ must also be an unusable tag.
		for (const routeFile of ['search', 'index', 'directory']) {
			const asTag = normalizeTag(routeFile);
			if (!asTag) continue; // longer than 6 chars: can never be a tag
			expect(isReservedTag(asTag)).toBe(true);
		}
	});
});

describe('crew crest', () => {
	it('is deterministic and in range', () => {
		const a = crestHues('NOVA');
		expect(crestHues('NOVA')).toEqual(a);
		expect(a.hue).toBeGreaterThanOrEqual(0);
		expect(a.hue).toBeLessThan(360);
		expect(a.hue2).toBeGreaterThanOrEqual(0);
		expect(a.hue2).toBeLessThan(360);
	});

	it('separates the two hues so the gradient never collapses to one colour', () => {
		for (const tag of ['NOVA', '3WS', 'AX', 'ZZZZZZ', '000000']) {
			const { hue, hue2 } = crestHues(tag);
			expect(hue).not.toBe(hue2);
		}
	});

	it('gives different tags different colours', () => {
		const hues = new Set(['NOVA', 'AXIOM', '3WS', 'ORBIT', 'ZED'].map((t) => crestHues(t).hue));
		expect(hues.size).toBeGreaterThan(3);
	});

	it('does not throw on an empty tag', () => {
		expect(() => crestHues('')).not.toThrow();
	});
});

describe('crew presence wording', () => {
	it('says Offline when the member is not in a world', () => {
		expect(presenceLine({ online: false, realm: 'mainland' })).toBe('Offline');
		expect(presenceLine(null)).toBe('Offline');
	});

	it('names the realm and server when there is one', () => {
		expect(presenceLine({ online: true, realm: 'coin_world', server: 2 })).toBe('In Coin World · Server 2');
		expect(presenceLine({ online: true, realm: 'mainland' })).toBe('In Mainland');
	});

	it('falls back to Online when presence carries no realm', () => {
		expect(presenceLine({ online: true, realm: null })).toBe('Online');
	});

	it('formats realms the same way the in-world friends drawer does', () => {
		expect(realmLabel('coin-world', null)).toBe('Coin World');
		expect(realmLabel('', 3)).toBe('');
	});
});

describe('crew routing', () => {
	it('reads the tag out of /crews/<TAG>', () => {
		expect(tagFromPath('/crews/NOVA')).toBe('NOVA');
		expect(tagFromPath('/crews/nova/')).toBe('NOVA');
		expect(tagFromPath('/crews/3ws')).toBe('3WS');
	});

	it('treats the bare page as the personal HQ', () => {
		expect(tagFromPath('/crews')).toBe('');
		expect(tagFromPath('/crews/')).toBe('');
	});

	it('ignores anything that is not a tag-shaped segment', () => {
		expect(tagFromPath('/crews/toolongtag')).toBe('');
		expect(tagFromPath('/crews/NOVA/extra')).toBe('');
		expect(tagFromPath('/other')).toBe('');
	});
});
