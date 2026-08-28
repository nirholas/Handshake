// @three-ws/agent-glance: the npm client that talks to /api/glance.
//
// Every URL builder validates the agent id up front, because the failure this
// prevents is a card silently rendering someone else's agent (or a 404 image)
// in a README that nobody re-reads.

import { describe, it, expect, vi } from 'vitest';
import {
	fetchGlanceCard,
	glanceCardUrl,
	glanceImageUrl,
	glanceMarkdown,
	glanceEmbedHtml,
	renderGlanceAnsi,
	GlanceError,
} from '../packages/agent-glance/src/index.js';

const ID = '0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34';

const CARD = {
	version: 1,
	id: ID,
	name: 'Atlas Scout',
	description: 'Watches the launch feed.',
	headline: 'Working.',
	url: `https://three.ws/agents/${ID}`,
	status: 'active',
	metric: { label: 'Moves today', value: 17 },
	stats: [
		{ label: 'This week', value: 96 },
		{ label: 'All time', value: 412 },
		{ label: 'Skills', value: 4 },
	],
};

describe('url builders', () => {
	it('builds the json and image urls off one agent id', () => {
		expect(glanceCardUrl(ID)).toBe(`https://three.ws/api/glance/card?agent=${ID}`);
		expect(glanceImageUrl(ID)).toBe(
			`https://three.ws/api/glance/card?agent=${ID}&format=svg&size=medium&theme=auto`,
		);
	});

	it('honours size and theme, and refuses values it does not serve', () => {
		expect(glanceImageUrl(ID, { size: 'large', theme: 'dark' })).toContain('size=large&theme=dark');
		expect(glanceImageUrl(ID, { size: 'gigantic', theme: 'neon' })).toContain(
			'size=medium&theme=auto',
		);
	});

	it('points at a self-hosted origin when told to', () => {
		expect(glanceCardUrl(ID, { origin: 'http://localhost:3000' })).toBe(
			`http://localhost:3000/api/glance/card?agent=${ID}`,
		);
	});

	it('rejects anything that is not an agent id, before any network call', () => {
		expect(() => glanceCardUrl('atlas-scout')).toThrow(GlanceError);
		expect(() => glanceImageUrl('')).toThrow(/not a three\.ws agent id/);
	});

	it('emits a README snippet that links the image back to the agent', () => {
		const md = glanceMarkdown(ID, { size: 'small' });
		expect(md).toBe(
			`[![three.ws agent](https://three.ws/api/glance/card?agent=${ID}&format=svg&size=small&theme=auto)](https://three.ws/agents/${ID})`,
		);
	});

	it('emits an embed snippet that loads the element and the tag together', () => {
		const html = glanceEmbedHtml(ID, { theme: 'dark' });
		expect(html).toContain('https://three.ws/glance/element.js');
		expect(html).toContain(`<agent-glance agent="${ID}" size="medium" theme="dark">`);
	});
});

describe('fetchGlanceCard', () => {
	it('returns the card on a 200', async () => {
		const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => CARD }));
		await expect(fetchGlanceCard(ID, { fetchImpl })).resolves.toEqual(CARD);
		expect(fetchImpl.mock.calls[0][1].signal).toBeDefined();
	});

	it('says plainly that the agent does not exist on a 404', async () => {
		const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
		await expect(fetchGlanceCard(ID, { fetchImpl })).rejects.toThrow(/no such agent/);
	});

	it('wraps a transport failure instead of leaking a raw network error', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('ECONNREFUSED');
		});
		await expect(fetchGlanceCard(ID, { fetchImpl })).rejects.toThrow(/could not reach three\.ws/);
	});
});

describe('renderGlanceAnsi', () => {
	it('draws a bordered card that fits a terminal', () => {
		const plain = renderGlanceAnsi(CARD, { color: false, width: 68 });
		const lines = plain.split('\n');
		expect(lines[0]).toMatch(/^╭─+╮$/);
		expect(lines.at(-1)).toMatch(/^╰─+╯$/);
		expect(plain).toContain('Atlas Scout');
		expect(plain).toContain('17 moves today');
		expect(plain).toContain(`https://three.ws/agents/${ID}`);
	});

	it('keeps every row the same width once the escapes are stripped', () => {
		const colored = renderGlanceAnsi(CARD, { color: true, width: 68 });
		// eslint-disable-next-line no-control-regex
		const widths = new Set(colored.split('\n').map((l) => l.replace(/\[[0-9;]*m/g, '').length));
		expect(widths.size).toBe(1);
		expect([...widths][0]).toBe(68);
	});
});
