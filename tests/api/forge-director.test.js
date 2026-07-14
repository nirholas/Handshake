// Tests for directPrompt() in api/_mcp-studio/forge-client.js: the Granite art
// director that rewrites a rough idea into a single-subject 3D spec before it
// drives the FLUX reference image.
//
// The director must run IN PROCESS (watsonx Granite lead, shared free-first
// llmComplete chain as fallback). The original implementation POSTed
// provider=watsonx to its own /api/chat, which the anonymous-provider gate
// rejects with 401, so the director silently never ran and raw two-word
// prompts (the "meme egg" class of bad generations) went straight to the image
// model. These tests pin the in-process contract so that regression cannot
// come back: no fetch to /api/chat, watsonx first, chain fallback, fail-soft
// null, and the same output cleanup as before.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
	configured: true,
	watsonx: vi.fn(),
	chain: vi.fn(),
}));

vi.mock('../../api/_lib/watsonx.js', () => ({
	watsonxConfig: () => ({ configured: state.configured, chatModel: 'ibm/granite-3-8b-instruct' }),
	watsonxChatComplete: (...args) => state.watsonx(...args),
}));

vi.mock('../../api/_lib/llm.js', () => ({
	llmComplete: (...args) => state.chain(...args),
}));

import { directPrompt } from '../../api/_mcp-studio/forge-client.js';
import { MESH_DIRECTOR } from '../../api/_lib/forge-director-prompts.js';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
	state.configured = true;
	state.watsonx.mockReset();
	state.chain.mockReset();
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	vi.useRealTimers();
});

describe('directPrompt — in-process Granite director', () => {
	it('runs watsonx Granite with the instruction as the system message and never touches the network', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('the director must not make HTTP calls');
		});
		state.watsonx.mockResolvedValue({ text: 'A glossy two-tone gel capsule, studio lighting, plain background' });

		const out = await directPrompt(MESH_DIRECTOR, 'a capsule pill');
		expect(out).toBe('A glossy two-tone gel capsule, studio lighting, plain background');
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(state.chain).not.toHaveBeenCalled();

		const [, opts] = state.watsonx.mock.calls[0];
		expect(opts.messages).toEqual([
			{ role: 'system', content: MESH_DIRECTOR },
			{ role: 'user', content: 'Idea: a capsule pill' },
		]);
	});

	it('cleans the model output: wrapping quotes stripped, first line only', async () => {
		state.watsonx.mockResolvedValue({ text: '"A brushed steel teapot, centered"\nSecond line the model added anyway' });
		const out = await directPrompt(MESH_DIRECTOR, 'teapot');
		expect(out).toBe('A brushed steel teapot, centered');
	});

	it('falls back to the free llmComplete chain when watsonx is not configured', async () => {
		state.configured = false;
		state.chain.mockResolvedValue({ text: 'A matte ceramic robot figurine, centered', provider: 'groq', model: 'x' });

		const out = await directPrompt(MESH_DIRECTOR, 'robot');
		expect(out).toBe('A matte ceramic robot figurine, centered');
		expect(state.watsonx).not.toHaveBeenCalled();
		expect(state.chain).toHaveBeenCalledTimes(1);
		expect(state.chain.mock.calls[0][0]).toMatchObject({ system: MESH_DIRECTOR, user: 'Idea: robot' });
	});

	it('falls back to the chain when watsonx throws', async () => {
		state.watsonx.mockRejectedValue(new Error('watsonx 429: quota'));
		state.chain.mockResolvedValue({ text: 'A worn oak chair, centered' });
		const out = await directPrompt(MESH_DIRECTOR, 'chair');
		expect(out).toBe('A worn oak chair, centered');
	});

	it('falls back to the chain when watsonx hangs past the director timeout', async () => {
		vi.useFakeTimers();
		state.watsonx.mockReturnValue(new Promise(() => {}));
		state.chain.mockResolvedValue({ text: 'A cast iron lantern, centered' });

		const pending = directPrompt(MESH_DIRECTOR, 'lantern');
		await vi.advanceTimersByTimeAsync(20_000);
		const out = await pending;
		expect(out).toBe('A cast iron lantern, centered');
	});

	it('returns null (fail-soft) when every lane fails, so callers keep the raw prompt', async () => {
		state.watsonx.mockRejectedValue(new Error('down'));
		state.chain.mockRejectedValue(new Error('all rungs dead'));
		expect(await directPrompt(MESH_DIRECTOR, 'anything')).toBeNull();
	});

	it('returns null on a degenerate rewrite instead of forwarding junk', async () => {
		state.watsonx.mockResolvedValue({ text: '""' });
		expect(await directPrompt(MESH_DIRECTOR, 'anything')).toBeNull();
	});
});
