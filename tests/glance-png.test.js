// Glance PNG: the bitmap encoding native widget hosts consume.
//
// rasterizeGlanceCard runs the real SVG renderer through the real sharp
// pipeline; only the thumbnail fetch is network, and the cards here carry
// none, so the suite is hermetic.

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { buildGlanceCard, noticeCard } from '../api/_lib/glance-card.js';
import { renderGlanceSvg } from '../api/_lib/glance-svg.js';
import { rasterizeGlanceCard, pngOptions, GLANCE_PNG_SCALES } from '../api/_lib/glance-png.js';
import { stateCard, linkUrl, GLANCE_STATES } from '../api/glance/mine.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');

function card(patch = {}) {
	return buildGlanceCard({
		agent: {
			id: '11111111-2222-3333-4444-555555555555',
			name: 'Atlas Scout',
			description: 'Watches the launch feed.',
			skills: ['watch'],
			created_at: new Date('2026-08-01T00:00:00.000Z'),
			avatar_thumbnail_key: null,
			avatar_visibility: null,
			...patch,
		},
		activity: { total: 412, day: 17, week: 96 },
		last: { type: 'skill.invoke', created_at: new Date('2026-08-28T11:00:00.000Z') },
		now: NOW,
	});
}

async function pixel(png, x, y) {
	const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
	const i = (y * info.width + x) * info.channels;
	return [data[i], data[i + 1], data[i + 2]];
}

describe('pngOptions', () => {
	it('defaults to medium, dark, 2x and rejects what it does not know', () => {
		expect(pngOptions(new URLSearchParams(''))).toEqual({ size: 'medium', theme: 'dark', scale: 2 });
		expect(pngOptions(new URLSearchParams('size=huge&theme=auto&scale=7'))).toEqual({ size: 'medium', theme: 'dark', scale: 2 });
		expect(pngOptions(new URLSearchParams('size=small&theme=light&scale=3'))).toEqual({ size: 'small', theme: 'light', scale: 3 });
		expect(GLANCE_PNG_SCALES).toEqual([1, 2, 3]);
	});
});

describe('rasterizeGlanceCard', () => {
	it('renders every size at the requested density', async () => {
		const expected = { small: [240, 240], medium: [480, 200], large: [480, 300] };
		for (const [size, [w, h]] of Object.entries(expected)) {
			const out = await rasterizeGlanceCard(card(), { size, scale: 2 });
			const meta = await sharp(out.png).metadata();
			expect(meta.format).toBe('png');
			expect([meta.width, meta.height]).toEqual([w * 2, h * 2]);
			expect([out.width, out.height]).toEqual([w * 2, h * 2]);
		}
	});

	it('paints the fixed themes with literal colors, which is what librsvg can read', async () => {
		const dark = await rasterizeGlanceCard(card(), { theme: 'dark', scale: 1 });
		const light = await rasterizeGlanceCard(card(), { theme: 'light', scale: 1 });
		// Inside the rounded corner, away from the accent strip and any glyph.
		expect(await pixel(dark.png, 470, 190)).toEqual([11, 11, 22]);
		expect(await pixel(light.png, 470, 190)).toEqual([255, 255, 255]);
	});

	it('keeps the fixed-theme SVG free of custom properties', () => {
		expect(renderGlanceSvg(card(), { theme: 'dark' })).not.toContain('var(--');
		expect(renderGlanceSvg(card(), { theme: 'light' })).not.toContain('var(--');
		expect(renderGlanceSvg(card(), { theme: 'auto' })).toContain('prefers-color-scheme');
	});

	it('draws the monogram when the thumbnail cannot be fetched', async () => {
		const out = await rasterizeGlanceCard(card({ avatar_thumbnail_key: 'thumb/x.png', avatar_visibility: 'public' }), {
			size: 'small',
			scale: 1,
		});
		// The portrait square sits at 20..76; its fill is the accent gradient,
		// never the panel or a transparent hole.
		const [r, g, b] = await pixel(out.png, 30, 30);
		expect(r + g + b).toBeGreaterThan(0);
		expect([r, g, b]).not.toEqual([11, 11, 22]);
	});
});

describe('notice cards', () => {
	it('shape a message exactly like an agent card so every renderer draws them', () => {
		const notice = noticeCard({ name: 'Widget unlinked', headline: 'Tap to link again.', url: 'https://three.ws/glance' });
		const agent = card();
		expect(Object.keys(notice).sort()).toEqual(Object.keys(agent).sort());
		expect(notice.id).toBe('notice');
		expect(notice.image).toBeNull();
		expect(notice.stats).toHaveLength(3);
	});

	it('answer every non-agent widget state with a tap target that fixes it', async () => {
		const signedOut = stateCard(GLANCE_STATES.signedOut);
		const unlinked = stateCard(GLANCE_STATES.unlinked);
		const noAgent = stateCard(GLANCE_STATES.noAgent);
		expect(signedOut.url).toContain('/login');
		expect(unlinked.url).toContain('/glance?link=android');
		expect(noAgent.url).toBe('https://three.ws/create');
		for (const notice of [signedOut, unlinked, noAgent]) {
			const out = await rasterizeGlanceCard(notice, { size: 'small', scale: 1 });
			expect((await sharp(out.png).metadata()).width).toBe(240);
		}
	});

	it('send an unlinked widget to the hand-off its own platform can finish', () => {
		// The shipped 1.1 Android APK sends no platform at all, so the default
		// has to stay exactly where it was pointing before Apple existed here.
		expect(linkUrl('')).toBe('https://three.ws/glance?link=android');
		expect(linkUrl(undefined)).toBe('https://three.ws/glance?link=android');
		expect(linkUrl('android')).toBe('https://three.ws/glance?link=android');
		expect(linkUrl('ios')).toBe('https://three.ws/glance?link=apple');
		expect(linkUrl('macos')).toBe('https://three.ws/glance?link=apple');
		// An unknown value is a caller we do not know, not a reason to 400 a
		// widget that is already in trouble.
		expect(linkUrl('windows')).toBe('https://three.ws/glance?link=android');
		expect(stateCard(GLANCE_STATES.unlinked, 'macos').url).toBe('https://three.ws/glance?link=apple');
	});
});
