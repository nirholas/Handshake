/**
 * Tests for the authoring-model chain behind the 3D Studio MCP's two
 * language-model tools: generate_material and direct_prompt
 * (api/_mcp3d/tools/studio.js).
 *
 * Both tools used to hard-throw "IBM watsonx.ai is not configured" whenever
 * WATSONX_API_KEY was unset, which made them permanently dead on production
 * even though the shared free-first chain (llmComplete) was one call away.
 * These tests pin the replacement contract: Granite leads where configured, the
 * free chain answers when it is not (or when it fails), and only an exhausted
 * chain is an error.
 *
 * watsonx and llmComplete are the credential boundary and are mocked; the real
 * tool handlers, real input schemas, and real JSON parsing run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { mcp3dGenerate: async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }) },
	clientIp: () => '203.0.113.9',
}));

const GRANITE_JSON = JSON.stringify({
	name: 'Granite chrome',
	pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 1, roughnessFactor: 0.05 },
});
const FALLBACK_JSON = JSON.stringify({
	name: 'Fallback chrome',
	prompt: 'A polished chrome sphere on a plain background.',
	pbrMetallicRoughness: { baseColorFactor: [0.7, 0.7, 0.7, 1], metallicFactor: 1, roughnessFactor: 0.1 },
});

let watsonxConfigured = true;
vi.mock('../../api/_lib/watsonx.js', () => ({
	watsonxConfig: vi.fn(() => ({ configured: watsonxConfigured, chatModel: 'ibm/granite-3-8b-instruct' })),
	watsonxChatComplete: vi.fn(),
}));

vi.mock('../../api/_lib/llm.js', () => ({
	llmComplete: vi.fn(),
}));

// The handlers read auth.userId for the rate-limit key; a signed-out MCP caller
// arrives with a rateKey instead. Either shape is valid, so pin the anonymous one.
const AUTH = { userId: null, rateKey: 'test-caller' };

async function toolNamed(name) {
	const { toolDefs } = await import('../../api/_mcp3d/tools/studio.js');
	const def = toolDefs.find((t) => t.name === name);
	expect(def, `tool ${name} should exist`).toBeTruthy();
	return def;
}

beforeEach(async () => {
	vi.clearAllMocks();
	watsonxConfigured = true;
	// clearAllMocks resets call history but not a queued mockRejectedValueOnce,
	// so a failure injected by one test would otherwise fire in the next. Re-pin
	// both rungs' default implementations explicitly.
	const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
	const { llmComplete } = await import('../../api/_lib/llm.js');
	watsonxChatComplete.mockReset();
	llmComplete.mockReset();
	watsonxChatComplete.mockImplementation(async () => ({ text: GRANITE_JSON, model: 'ibm/granite-3-8b-instruct' }));
	llmComplete.mockImplementation(async () => ({ text: FALLBACK_JSON, model: 'free-chain/test-model' }));
});

describe('generate_material author chain', () => {
	it('uses IBM Granite when watsonx is configured', async () => {
		const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		const { llmComplete } = await import('../../api/_lib/llm.js');
		const def = await toolNamed('generate_material');
		const out = await def.handler({ description: 'polished chrome' }, AUTH);
		expect(watsonxChatComplete).toHaveBeenCalledTimes(1);
		expect(llmComplete).not.toHaveBeenCalled();
		expect(out.structuredContent.material.name).toBe('Granite chrome');
	});

	it('answers through the free-first chain when watsonx has no credentials', async () => {
		watsonxConfigured = false;
		const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		const { llmComplete } = await import('../../api/_lib/llm.js');
		const def = await toolNamed('generate_material');
		const out = await def.handler({ description: 'polished chrome' }, AUTH);
		expect(watsonxChatComplete).not.toHaveBeenCalled();
		expect(llmComplete).toHaveBeenCalledTimes(1);
		expect(out.structuredContent.material.name).toBe('Fallback chrome');
	});

	it('falls back to the free-first chain when watsonx throws', async () => {
		const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		const { llmComplete } = await import('../../api/_lib/llm.js');
		watsonxChatComplete.mockRejectedValueOnce(new Error('watsonx 502'));
		const def = await toolNamed('generate_material');
		const out = await def.handler({ description: 'polished chrome' }, AUTH);
		expect(llmComplete).toHaveBeenCalledTimes(1);
		expect(out.structuredContent.material.name).toBe('Fallback chrome');
	});

	it('errors only when BOTH rungs are unavailable, naming the real reason', async () => {
		watsonxConfigured = false;
		const { llmComplete } = await import('../../api/_lib/llm.js');
		llmComplete.mockRejectedValueOnce(new Error('every provider refused'));
		const def = await toolNamed('generate_material');
		await expect(def.handler({ description: 'polished chrome' }, AUTH)).rejects.toThrow(/every provider refused/);
	});
});

describe('direct_prompt author chain', () => {
	it('answers through the free-first chain when watsonx has no credentials', async () => {
		watsonxConfigured = false;
		const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		const { llmComplete } = await import('../../api/_lib/llm.js');
		const def = await toolNamed('direct_prompt');
		const out = await def.handler({ idea: 'a chrome sphere' }, AUTH);
		expect(watsonxChatComplete).not.toHaveBeenCalled();
		expect(llmComplete).toHaveBeenCalledTimes(1);
		expect(out.structuredContent.optimized_prompt).toBe('A polished chrome sphere on a plain background.');
	});
});
