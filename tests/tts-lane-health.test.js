// Unit tests for the voice-lane circuit breaker (api/_lib/tts-lane-health.js).
//
// The breaker exists because configuration presence is not health: on
// 2026-08-15 the Gemini lane was fully configured and answered every synthesis
// with a 403 (Google's billing dunning denied the project), so /api/tts/catalog
// advertised 30 voices that could not render. These pin the contract the
// catalog and synthesize handlers depend on: which failures take a lane off the
// menu, which must never, and that a lane comes back the moment it serves.
//
// No mocks: the cooldown store is the real shared cache, which falls back to
// per-process memory when Upstash is not configured (it is not, in tests).

import { describe, it, expect, beforeEach } from 'vitest';

import {
	ttsLaneKey,
	laneOutages,
	laneOutageCopy,
	noteLaneFailure,
	noteLaneHealthy,
} from '../api/_lib/tts-lane-health.js';
import { providersInCooldown, markProviderCooldown } from '../api/_lib/provider-health.js';

const LANES = ['edge', 'gemini', 'nvidia', 'openai', 'elevenlabs'];

beforeEach(async () => {
	await Promise.all(LANES.map((id) => noteLaneHealthy(id)));
});

describe('noteLaneFailure', () => {
	it('takes a lane off the menu when the provider refuses its credentials', async () => {
		await noteLaneFailure('gemini', 'invalid_key');
		const outages = await laneOutages(LANES);
		expect(outages.get('gemini')).toBe('auth');
		expect(outages.size).toBe(1);
	});

	it('cools a throttled or unreachable lane as a health blip, not an auth failure', async () => {
		await noteLaneFailure('openai', 'rate_limited');
		await noteLaneFailure('nvidia', 'provider_unreachable');
		const outages = await laneOutages(LANES);
		expect(outages.get('openai')).toBe('health');
		expect(outages.get('nvidia')).toBe('health');
	});

	it('never cools a lane for a caller-side failure', async () => {
		// Bad text or a blocked prompt says nothing about the lane's health, and
		// silently removing a working lane over one visitor's input would be worse
		// than the failure itself.
		await noteLaneFailure('edge', 'invalid_argument');
		await noteLaneFailure('edge', 'content_blocked');
		await noteLaneFailure('edge', undefined);
		expect((await laneOutages(LANES)).size).toBe(0);
	});

	it('ignores a missing provider id instead of cooling an empty key', async () => {
		await noteLaneFailure('', 'invalid_key');
		expect((await laneOutages(LANES)).size).toBe(0);
	});
});

describe('noteLaneHealthy', () => {
	it('restores a lane the moment it serves again', async () => {
		await noteLaneFailure('gemini', 'invalid_key');
		expect((await laneOutages(['gemini'])).has('gemini')).toBe(true);
		await noteLaneHealthy('gemini');
		expect((await laneOutages(['gemini'])).has('gemini')).toBe(false);
	});
});

describe('laneOutages', () => {
	it('keys the result by provider id, not by cache key', async () => {
		await noteLaneFailure('elevenlabs', 'invalid_key');
		const outages = await laneOutages(LANES);
		expect([...outages.keys()]).toEqual(['elevenlabs']);
	});

	it('does not collide with the LLM chain cooldown for the same provider name', async () => {
		// Both subsystems have an "openai"; a chat outage must not blank the voice
		// picker, and vice versa.
		await markProviderCooldown('openai', 60, 'auth');
		expect((await laneOutages(['openai'])).size).toBe(0);

		await noteLaneFailure('openai', 'invalid_key');
		expect((await providersInCooldown(['openai'])).get('openai')).toBe('auth');
		expect((await laneOutages(['openai'])).get('openai')).toBe('auth');
	});

	it('namespaces its cache keys', () => {
		expect(ttsLaneKey('gemini')).toBe('tts-lane:gemini');
	});
});

describe('laneOutageCopy', () => {
	it('explains an auth refusal and a transient failure differently', () => {
		expect(laneOutageCopy('auth')).toMatch(/credentials/);
		expect(laneOutageCopy('health')).toMatch(/error/);
	});
});
