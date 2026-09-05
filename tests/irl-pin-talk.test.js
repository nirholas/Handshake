// Talking to a discovered pin (src/irl/pin-talk.js): the pure parts.
//
// The live loop (mic, /api/chat, TTS, lipsync) is the shared TalkController and
// is exercised on device; what this file pins is how a pin becomes a
// conversation partner. A pin bound to an agent identity must chat AS that agent
// (so /api/chat loads its persona, memories and cloned voice by agentId); an
// anonymous pin must never send a made-up agentId; and the fallback persona has
// to carry the one fact that makes IRL different: the person is standing there.

import { describe, it, expect } from 'vitest';

import { talkAvatarRecord, pinPersonaPrompt } from '../src/irl/pin-talk.js';

const AGENT = '0b9e0f8e-6c9a-4a2f-9a55-2c1d4a1b7e33';
const PIN = 'c1d4a1b7-e33a-4a2f-9a55-0b9e0f8e6c9a';

describe('talkAvatarRecord', () => {
	it('keys the conversation on the agent identity when the pin has one', () => {
		const rec = talkAvatarRecord({ id: PIN, agent_id: AGENT, avatar_name: 'Nova' });
		expect(rec.id).toBe(AGENT);
		expect(rec.agent_id).toBe(AGENT);
		expect(rec.name).toBe('Nova');
	});

	it('never fabricates an agentId for an anonymous pin', () => {
		const rec = talkAvatarRecord({ id: PIN, agent_id: null, avatar_name: 'Nova' });
		expect(rec.agent_id).toBeUndefined();
		// A non-UUID id is what stops TalkController from sending agentId at all.
		expect(rec.id).toBe(`irl-pin:${PIN}`);
		expect(/^[0-9a-f-]{36}$/i.test(rec.id)).toBe(false);
	});

	it('rejects a malformed agent_id rather than passing it to the chat API', () => {
		const rec = talkAvatarRecord({ id: PIN, agent_id: 'not-a-uuid' });
		expect(rec.agent_id).toBeUndefined();
		expect(rec.name).toBe('Agent');
	});
});

describe('pinPersonaPrompt', () => {
	const pin = { avatar_name: 'Nova', caption: 'Ask me about the pier' };

	it('speaks as the agent and grounds it in a person standing in front of it', () => {
		const p = pinPersonaPrompt(pin);
		expect(p).toMatch(/^You are Nova, a 3D AI agent standing at a real place/);
		expect(p).toMatch(/walked up to you in person/);
		expect(p).toMatch(/The placard next to you reads: "Ask me about the pier"/);
		expect(p).toMatch(/Never claim to be a human/);
	});

	it('keeps replies short because they are spoken aloud', () => {
		expect(pinPersonaPrompt(pin)).toMatch(/one to three short sentences/);
	});

	it('prefers the agent card name and folds in its bio', () => {
		const p = pinPersonaPrompt(pin, { agent: { name: 'Nova Prime', bio: 'Guide to the waterfront.' } });
		expect(p).toMatch(/^You are Nova Prime,/);
		expect(p).toMatch(/About you: Guide to the waterfront\./);
	});

	it('omits the placard and bio lines when the pin has neither', () => {
		const p = pinPersonaPrompt({ avatar_name: 'Nova' });
		expect(p).not.toMatch(/placard/);
		expect(p).not.toMatch(/About you/);
	});

	it('clamps oversized captions and bios so a prompt-as-caption cannot flood the system prompt', () => {
		const p = pinPersonaPrompt({ avatar_name: 'Nova', caption: 'c'.repeat(2000) }, { agent: { bio: 'b'.repeat(5000) } });
		expect(p.length).toBeLessThan(1400);
	});
});
