// Tests for api/_lib/publish-safety.js, the NemoGuard classifier that screens
// what the platform PUBLISHES outward (the Sketchfab showcase cron). Pins the
// four mandated invariants:
//   1. BLOCK:   a parsed "unsafe" verdict flags the content.
//   2. ALLOW:   a parsed "safe" verdict lets it through.
//   3. FAIL-OPEN: any classifier outage (timeout / non-200 / network / garbage)
//                  proceeds unblocked; it can never stop publishing on failure.
//   4. FLAG-OFF: the kill switch (PUBLISH_SAFETY_DISABLED) bypasses entirely,
//                 without even touching the network.
//
// It also pins the boundary that motivated the module's rename: no chat surface
// imports it. Input a user sends to a model is never screened by us.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
	publishSafetyConfig,
	publishSafetyEnabled,
	classifyPublishSafety,
	parseVerdict,
} from '../../api/_lib/publish-safety.js';

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const fetchMock = vi.fn();

function nimReply(content) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ choices: [{ message: { content } }] }),
		text: async () => '',
	};
}

function clearEnv() {
	delete process.env.NVIDIA_API_KEY;
	delete process.env.PUBLISH_SAFETY_DISABLED;
	delete process.env.PUBLISH_SAFETY_MODEL;
	delete process.env.PUBLISH_SAFETY_TIMEOUT_MS;
}

beforeEach(() => {
	clearEnv();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearEnv();
});

describe('publishSafetyConfig / publishSafetyEnabled', () => {
	it('is disabled with no key (fail-open: nothing to call)', () => {
		expect(publishSafetyEnabled()).toBe(false);
		expect(publishSafetyConfig().enabled).toBe(false);
	});

	it('is enabled when the NIM key is present', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const cfg = publishSafetyConfig();
		expect(cfg.enabled).toBe(true);
		expect(cfg.key).toBe('nvapi-test');
		expect(cfg.model).toMatch(/nemoguard/);
		expect(cfg.timeoutMs).toBe(2000);
	});

	it('kill switch PUBLISH_SAFETY_DISABLED disables it even with a key', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.PUBLISH_SAFETY_DISABLED = 'true';
		expect(publishSafetyEnabled()).toBe(false);
	});

	it('honors model + timeout overrides (timeout is clamped)', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.PUBLISH_SAFETY_MODEL = 'meta/llama-guard-4-12b';
		process.env.PUBLISH_SAFETY_TIMEOUT_MS = '999999';
		const cfg = publishSafetyConfig();
		expect(cfg.model).toBe('meta/llama-guard-4-12b');
		expect(cfg.timeoutMs).toBe(8000); // clamped to MAX
	});
});

describe('parseVerdict', () => {
	it('parses NemoGuard unsafe JSON with categories', () => {
		const v = parseVerdict('{"User Safety": "unsafe", "Safety Categories": "Guns, Criminal Planning"} ');
		expect(v.unsafe).toBe(true);
		expect(v.parsed).toBe(true);
		expect(v.categories).toEqual(['Guns', 'Criminal Planning']);
	});

	it('parses NemoGuard safe JSON', () => {
		const v = parseVerdict('{"User Safety": "safe"} ');
		expect(v.unsafe).toBe(false);
		expect(v.parsed).toBe(true);
		expect(v.categories).toEqual([]);
	});

	it('parses the Llama-Guard text form', () => {
		expect(parseVerdict('unsafe\nS9').unsafe).toBe(true);
		expect(parseVerdict('unsafe\nS9').categories).toEqual(['S9']);
		expect(parseVerdict('safe').unsafe).toBe(false);
	});

	it('treats unrecognized output as safe (fail-open) and marks it unparsed', () => {
		const v = parseVerdict('I think maybe this could be a problem?');
		expect(v.unsafe).toBe(false);
		expect(v.parsed).toBe(false);
	});

	it('handles empty/nullish content as unparsed-safe', () => {
		expect(parseVerdict('').parsed).toBe(false);
		expect(parseVerdict(null).unsafe).toBe(false);
	});
});

describe('classifyPublishSafety', () => {
	it('BLOCK: flags a parsed unsafe verdict', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		fetchMock.mockResolvedValueOnce(
			nimReply('{"User Safety": "unsafe", "Safety Categories": "Guns and Illegal Weapons"}'),
		);
		const r = await classifyPublishSafety('a prompt we would not publish');
		expect(r.flagged).toBe(true);
		expect(r.checked).toBe(true);
		expect(r.categories).toEqual(['Guns and Illegal Weapons']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(NIM_URL);
	});

	it('ALLOW: a safe verdict passes through', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		fetchMock.mockResolvedValueOnce(nimReply('{"User Safety": "safe"}'));
		const r = await classifyPublishSafety('a low-poly wooden chair');
		expect(r.flagged).toBe(false);
		expect(r.checked).toBe(true);
	});

	it('FAIL-OPEN: non-200 upstream does not flag', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' });
		const r = await classifyPublishSafety('anything');
		expect(r.flagged).toBe(false);
		expect(r.checked).toBe(false);
		expect(r.error).toMatch(/403/);
	});

	it('FAIL-OPEN: a thrown/aborted fetch does not flag', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
		const r = await classifyPublishSafety('anything');
		expect(r.flagged).toBe(false);
		expect(r.checked).toBe(false);
		expect(r.error).toBe('timeout');
	});

	it('FAIL-OPEN: garbage model output does not flag', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		fetchMock.mockResolvedValueOnce(nimReply('uh, I am not sure about that one'));
		const r = await classifyPublishSafety('anything');
		expect(r.flagged).toBe(false);
		expect(r.checked).toBe(false);
	});

	it('FLAG-OFF: kill switch bypasses without touching the network', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.PUBLISH_SAFETY_DISABLED = 'true';
		const r = await classifyPublishSafety('anything');
		expect(r.flagged).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('FAIL-OPEN: no key configured, no call and no flag', async () => {
		const r = await classifyPublishSafety('anything');
		expect(r.flagged).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('empty text is a no-op (nothing to classify)', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const r = await classifyPublishSafety('   ');
		expect(r.flagged).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends the NemoGuard request shape (single user turn, temp 0)', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		fetchMock.mockResolvedValueOnce(nimReply('{"User Safety": "safe"}'));
		await classifyPublishSafety('a low-poly wooden chair');
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.model).toMatch(/nemoguard/);
		expect(body.temperature).toBe(0);
		expect(body.messages).toEqual([{ role: 'user', content: 'a low-poly wooden chair' }]);
		expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer nvapi-test');
	});
});

// Owner directive 2026-08-07: the platform screens what it publishes, never what
// a user asks. This walks the real api/ tree so a future edit that reintroduces
// an input filter on a chat surface fails here instead of in production.
describe('no chat surface imports a content classifier', () => {
	const API_DIR = new URL('../../api/', import.meta.url).pathname;
	const ALLOWED = ['cron/sketchfab-showcase.js'];

	function walk(dir, prefix = '') {
		const out = [];
		for (const entry of readdirSync(dir)) {
			if (entry === 'node_modules') continue;
			const full = join(dir, entry);
			const rel = prefix ? `${prefix}/${entry}` : entry;
			if (statSync(full).isDirectory()) out.push(...walk(full, rel));
			else if (entry.endsWith('.js')) out.push({ rel, full });
		}
		return out;
	}

	it('only the outbound publishing cron imports publish-safety.js', () => {
		const importers = walk(API_DIR)
			.filter(({ full }) => /from\s+['"][^'"]*publish-safety\.js['"]/.test(readFileSync(full, 'utf8')))
			.map(({ rel }) => rel);
		expect(importers.sort()).toEqual([...ALLOWED].sort());
	});

	it('the retired moderation module is gone, not merely unused', () => {
		const survivors = walk(API_DIR).filter(({ rel }) => rel.endsWith('_lib/moderation.js'));
		expect(survivors).toEqual([]);
	});
});
