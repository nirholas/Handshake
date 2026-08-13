// agentVoiceConfig: the mapper every surface uses to play an agent's bound voice.
//
// The failure this guards against is silent, which is why it is worth a test: an
// agent whose voice was cloned on its owner's own ElevenLabs key is only served
// by /api/tts/eleven when the request names the agent. Drop `agentId` from the
// TTS config and the embed still "works": it just goes mute for every visitor
// who is not the signed-in owner, which is everyone an embed exists for.

import { describe, it, expect } from 'vitest';
import { agentVoiceConfig, createTTS, ElevenLabsTTS } from '../../src/runtime/speech.js';

const BOUND_AGENT = {
	id: '11111111-2222-3333-4444-555555555555',
	voice_provider: 'elevenlabs',
	voice_id: 'voice_abc123',
	voice_model: 'eleven_turbo_v2_5',
	voice_settings: {
		stability: 0.31,
		similarity_boost: 0.82,
		style: 0.44,
		use_speaker_boost: false,
	},
};

describe('agentVoiceConfig', () => {
	it('carries the agent id so an owner-BYOK clone is reachable anonymously', () => {
		const cfg = agentVoiceConfig(BOUND_AGENT);
		expect(cfg.agentId).toBe(BOUND_AGENT.id);
		expect(cfg.provider).toBe('elevenlabs');
		expect(cfg.voiceId).toBe('voice_abc123');
		expect(cfg.proxyURL).toBe('/api/tts/eleven');
	});

	it('prefers an explicitly supplied agentId over the record id', () => {
		const cfg = agentVoiceConfig(BOUND_AGENT, { agentId: 'route-param-id' });
		expect(cfg.agentId).toBe('route-param-id');
	});

	it('falls back to the record id when the caller supplies none', () => {
		const cfg = agentVoiceConfig({ ...BOUND_AGENT }, {});
		expect(cfg.agentId).toBe(BOUND_AGENT.id);
	});

	it('maps the saved snake_case settings onto the TTS constructor names', () => {
		const cfg = agentVoiceConfig(BOUND_AGENT);
		expect(cfg.modelId).toBe('eleven_turbo_v2_5');
		expect(cfg.stability).toBe(0.31);
		expect(cfg.similarityBoost).toBe(0.82);
		expect(cfg.style).toBe(0.44);
		expect(cfg.useSpeakerBoost).toBe(false);
	});

	it('omits tuning the owner never set, so ElevenLabs defaults survive', () => {
		const cfg = agentVoiceConfig({ id: 'a1', voice_provider: 'elevenlabs', voice_id: 'v1' });
		expect(cfg).not.toHaveProperty('modelId');
		expect(cfg).not.toHaveProperty('stability');
		expect(cfg).not.toHaveProperty('useSpeakerBoost');
		const tts = createTTS(cfg);
		expect(tts).toBeInstanceOf(ElevenLabsTTS);
		expect(tts.modelId).toBe('eleven_flash_v2_5');
		expect(tts.stability).toBe(0.5);
		expect(tts.useSpeakerBoost).toBe(true);
	});

	it('honours use_speaker_boost:false rather than treating it as unset', () => {
		const cfg = agentVoiceConfig({
			id: 'a1',
			voice_provider: 'elevenlabs',
			voice_id: 'v1',
			voice_settings: { use_speaker_boost: false },
		});
		expect(cfg.useSpeakerBoost).toBe(false);
		expect(createTTS(cfg).useSpeakerBoost).toBe(false);
	});

	it('returns null when nothing is bound, so callers render their own empty state', () => {
		expect(agentVoiceConfig(null)).toBeNull();
		expect(agentVoiceConfig({})).toBeNull();
		expect(agentVoiceConfig({ id: 'a1', voice_provider: 'browser', voice_id: null })).toBeNull();
	});

	it('returns null for a non-ElevenLabs provider even when a voice id lingers', () => {
		expect(agentVoiceConfig({ id: 'a1', voice_provider: 'browser', voice_id: 'stale' })).toBeNull();
	});

	it('survives a malformed voice_settings blob instead of throwing', () => {
		const cfg = agentVoiceConfig({
			id: 'a1',
			voice_provider: 'elevenlabs',
			voice_id: 'v1',
			voice_settings: 'not-an-object',
		});
		expect(cfg.voiceId).toBe('v1');
		expect(cfg).not.toHaveProperty('stability');
	});

	it('builds a config createTTS accepts, with the agent id reaching the instance', () => {
		const tts = createTTS(agentVoiceConfig(BOUND_AGENT));
		expect(tts).toBeInstanceOf(ElevenLabsTTS);
		expect(tts.agentId).toBe(BOUND_AGENT.id);
		expect(tts.proxyURL).toBe('/api/tts/eleven');
		expect(tts.modelId).toBe('eleven_turbo_v2_5');
	});
});
