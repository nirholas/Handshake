// Tests for custom bone-mounted attachments on the avatar appearance record.
//
// `appearance.accessories` names entries in the curated preset catalog. Scene
// Composer attaches forged GLBs that are in no catalog, so they persist through
// `appearance.attachments`, each carrying its own bone + URL. Two things have to
// hold for that to be safe and to actually work:
//
//   1. The API accepts the shape the studio writes, and rejects a URL on a host
//      we do not serve assets from. A stored attachment is fetched by every
//      browser that renders the avatar, including viewers who do not own it.
//   2. The runtime turns a stored entry back into the preset shape the
//      load-and-attach path already understands, with ids that cannot collide
//      with a catalog preset.
//
// Before this contract existed the studio PATCHed a top-level `accessories`
// array, which zod stripped as an unknown key: the request answered 200 and
// stored nothing. The last case here is the regression guard for that.

import { describe, it, expect } from 'vitest';

import { avatarAppearance } from '../api/_lib/validate.js';
import { isTrustedAttachmentUrl, validateAppearance } from '../api/_lib/accessories.js';

const CDN = 'https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev';

describe('appearance.attachments schema', () => {
	it('accepts a bone-mounted forged prop on a three.ws asset host', () => {
		const res = avatarAppearance.safeParse({
			attachments: [{ bone: 'mixamorig:Head', url: `${CDN}/forge/anon/crown.glb`, name: 'Horned crown' }],
		});
		expect(res.success).toBe(true);
		expect(res.data.attachments).toHaveLength(1);
		expect(res.data.attachments[0].bone).toBe('mixamorig:Head');
	});

	it('keeps attachments alongside the rest of the appearance document', () => {
		const res = avatarAppearance.safeParse({
			colors: { skin: '#c99a70' },
			hidden: ['hair'],
			attachments: [{ bone: 'mixamorig:RightHand', url: `${CDN}/forge/anon/staff.glb` }],
		});
		expect(res.success).toBe(true);
		expect(res.data.colors.skin).toBe('#c99a70');
		expect(res.data.attachments[0].bone).toBe('mixamorig:RightHand');
	});

	it('rejects a URL on a host we do not serve assets from', () => {
		const res = avatarAppearance.safeParse({
			attachments: [{ bone: 'mixamorig:Head', url: 'https://evil.example.com/payload.glb' }],
		});
		expect(res.success).toBe(false);
		expect(JSON.stringify(res.error.issues)).toMatch(/asset host/);
	});

	it('rejects more attachments than the studio may save', () => {
		const many = Array.from({ length: 9 }, (_, i) => ({
			bone: 'mixamorig:Head',
			url: `${CDN}/forge/anon/prop-${i}.glb`,
		}));
		expect(avatarAppearance.safeParse({ attachments: many }).success).toBe(false);
	});

	it('rejects an entry with no bone to hang on', () => {
		const res = avatarAppearance.safeParse({
			attachments: [{ url: `${CDN}/forge/anon/crown.glb` }],
		});
		expect(res.success).toBe(false);
	});
});

describe('isTrustedAttachmentUrl', () => {
	it('allows our own asset hosts and same-origin paths', () => {
		expect(isTrustedAttachmentUrl(`${CDN}/forge/anon/crown.glb`)).toBe(true);
		expect(isTrustedAttachmentUrl('https://three.ws/accessories/hat-beanie.glb')).toBe(true);
		expect(isTrustedAttachmentUrl('/accessories/hat-beanie.glb')).toBe(true);
	});

	it('refuses http, protocol-relative and lookalike hosts', () => {
		expect(isTrustedAttachmentUrl('http://three.ws/x.glb')).toBe(false);
		expect(isTrustedAttachmentUrl('//evil.example.com/x.glb')).toBe(false);
		expect(isTrustedAttachmentUrl('https://three.ws.evil.com/x.glb')).toBe(false);
		expect(isTrustedAttachmentUrl('https://notr2.dev.evil.com/x.glb')).toBe(false);
		expect(isTrustedAttachmentUrl(null)).toBe(false);
	});
});

describe('validateAppearance', () => {
	it('names the offending URL so the studio can show it', () => {
		const err = validateAppearance({
			attachments: [{ bone: 'Head', url: 'https://evil.example.com/x.glb' }],
		});
		expect(err).toMatch(/evil\.example\.com/);
	});

	it('passes a well-formed outfit', () => {
		expect(
			validateAppearance({ attachments: [{ bone: 'Head', url: `${CDN}/forge/anon/crown.glb` }] }),
		).toBeNull();
	});
});

describe('the shape Scene Composer used to send', () => {
	it('is no longer silently dropped: a bare accessories array of objects fails', () => {
		// The old payload put objects in `accessories`, which the catalog field
		// types as preset-id strings. It has to fail loudly rather than parse to
		// an empty document that stores nothing.
		const res = avatarAppearance.safeParse({
			accessories: [{ bone: 'mixamorig:Head', glbUrl: `${CDN}/forge/anon/crown.glb`, name: 'Crown' }],
		});
		expect(res.success).toBe(false);
	});
});
