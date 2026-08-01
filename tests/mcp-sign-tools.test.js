// Coverage for api/_mcp/tools/sign.js: the two MCP tools that let any agent
// ask a three.ws avatar to sign something.
//
// The interesting property is restraint: a signed sentence compiles to tens of
// thousands of numbers, and pasting that into a chat transcript is a way to
// destroy an agent's context for no benefit. So sign_text answers with the
// timeline and a URL by default, and only inlines the clip when the caller
// explicitly asks. These tests hold that line, plus the readable text rendering
// an MCP client actually shows a human.

import { describe, it, expect } from 'vitest';

const { toolDefs } = await import('../api/_mcp/tools/sign.js');

const byName = Object.fromEntries(toolDefs.map((t) => [t.name, t]));
const req = { headers: { host: 'three.ws' } };
const call = (name, args) => byName[name].handler(args, {}, req);

describe('tool definitions', () => {
	it('declares both tools as pure reads', () => {
		expect(Object.keys(byName).sort()).toEqual(['list_sign_vocabulary', 'sign_text']);
		for (const tool of toolDefs) {
			expect(tool.annotations.readOnlyHint).toBe(true);
			expect(tool.annotations.destructiveHint).toBe(false);
			expect(tool.annotations.idempotentHint).toBe(true);
			expect(tool.inputSchema.additionalProperties).toBe(false);
			expect(tool.description.length).toBeGreaterThan(80);
		}
	});

	it('requires text on sign_text and nothing on the vocabulary listing', () => {
		expect(byName.sign_text.inputSchema.required).toEqual(['text']);
		expect(byName.list_sign_vocabulary.inputSchema.required).toBeUndefined();
	});
});

describe('list_sign_vocabulary', () => {
	it('lists every sign with its description', async () => {
		const out = await call('list_sign_vocabulary', {});
		expect(out.structuredContent.count).toBeGreaterThan(20);
		expect(out.structuredContent.count).toBe(out.structuredContent.vocabulary.length);
		expect(out.content[0].text).toMatch(/everything else fingerspells/);
		// Aliases resolve onto the same signs, so the recognized set is wider.
		expect(out.structuredContent.recognized_words.length).toBeGreaterThan(
			out.structuredContent.count,
		);
	});

	it('filters on the word and on the description', async () => {
		const byWord = await call('list_sign_vocabulary', { search: 'hello' });
		expect(byWord.structuredContent.vocabulary.map((v) => v.word)).toEqual(['HELLO']);

		const byGloss = await call('list_sign_vocabulary', { search: 'forehead' });
		expect(byGloss.structuredContent.count).toBeGreaterThan(0);
		for (const entry of byGloss.structuredContent.vocabulary) {
			expect(entry.gloss.toLowerCase()).toContain('forehead');
		}
	});

	it('returns an empty list rather than failing on a miss', async () => {
		const out = await call('list_sign_vocabulary', { search: 'zzzzzz' });
		expect(out.structuredContent.count).toBe(0);
		expect(out.isError).toBeUndefined();
	});
});

describe('sign_text', () => {
	it('reports the timeline and links, and withholds the clip by default', async () => {
		const out = await call('sign_text', { text: 'happy to meet you' });
		const s = out.structuredContent;
		expect(s.ok).toBe(true);
		expect(s.signed).toEqual(['HAPPY', 'MEET', 'YOU']);
		expect(s.spelled).toEqual(['TO']);
		expect(s.clip).toBeUndefined();
		expect(s.clip_url).toContain('/api/sign?text=');
		expect(s.viewer_url).toContain('/sign-language?say=');
		expect(s.timeline).toHaveLength(4);
	});

	it('inlines the clip only when asked', async () => {
		const out = await call('sign_text', { text: 'hello', include_clip: true });
		expect(out.structuredContent.clip.tracks.length).toBeGreaterThan(10);
		expect(out.structuredContent.clip.duration).toBeCloseTo(
			out.structuredContent.duration,
			4,
		);
	});

	it('renders a line a human can read, signed and spelled marked differently', async () => {
		const { content } = await call('sign_text', { text: 'hello nich' });
		const text = content[0].text;
		expect(text).toMatch(/HELLO\s+signed/);
		expect(text).toMatch(/NICH\s+spelled\s+\S+\s+N-I-C-H/);
		expect(text).toMatch(/Watch it: https:\/\/three\.ws\/sign-language\?say=/);
	});

	it('carries the hand and speed into the clip url', async () => {
		const out = await call('sign_text', { text: 'hello', hand: 'left', speed: 0.5 });
		expect(out.structuredContent.hand).toBe('left');
		expect(out.structuredContent.clip_url).toContain('hand=left');
		expect(out.structuredContent.clip_url).toContain('speed=0.5');
	});

	it('rejects text with nothing signable in it, with a usable reason', async () => {
		await expect(call('sign_text', { text: '✓✓✓' })).rejects.toThrow(/A-Z and 0-9/);
	});

	it('rejects empty text', async () => {
		await expect(call('sign_text', { text: '   ' })).rejects.toThrow(/required/);
	});
});
