/**
 * The onboarding interview contract.
 *
 * `src/agents/persona-interview.js` is the single source of truth shared by the
 * browser (the create-agent wizard) and the server (POST /api/persona/interview
 * and the per-agent extract route). Because both sides import it, a drift here
 * shows up as the extractor being told a different question than the user was
 * actually asked, which silently poisons the persona instead of erroring.
 *
 * The load-bearing property these pin is that the interview is OPTIONAL, question
 * by question and as a whole: a skipped interview must still compile a real,
 * complete persona prompt rather than leaving the agent voiceless. That is the
 * behavior a user hits every time they click past the personality step, so it is
 * pinned end to end here (defaultPersonaBase -> compilePersona), not just asserted
 * as a non-empty string.
 */

import { describe, it, expect } from 'vitest';

import {
	INTERVIEW_QUESTIONS,
	INTERVIEW_QUESTION_IDS,
	MAX_INTERVIEW_ANSWERS,
	MIN_ANSWER_CHARS,
	MAX_ANSWER_CHARS,
	normalizeInterview,
	interviewTranscript,
	defaultPersonaBase,
	hasInterviewSignal,
} from '../src/agents/persona-interview.js';
import {
	compilePersona,
	PERSONA_TRAITS,
	bandIndex,
	DEFAULT_TRAIT_VALUE,
} from '../src/agents/persona-compile.js';

describe('the question set', () => {
	it('stays within the 5-to-8 question bound the extractor assumes', () => {
		expect(INTERVIEW_QUESTIONS.length).toBeGreaterThanOrEqual(5);
		expect(INTERVIEW_QUESTIONS.length).toBeLessThanOrEqual(MAX_INTERVIEW_ANSWERS);
	});

	it('gives every question a stable unique id and a real prompt', () => {
		expect(new Set(INTERVIEW_QUESTION_IDS).size).toBe(INTERVIEW_QUESTIONS.length);
		for (const q of INTERVIEW_QUESTIONS) {
			expect(q.id).toMatch(/^[a-z][a-z0-9-]*$/);
			expect(q.prompt.trim().length).toBeGreaterThan(10);
			// The hint and placeholder are rendered to the user, never submitted.
			expect(q.hint.trim()).not.toBe('');
			expect(q.placeholder.trim()).not.toBe('');
		}
	});
});

describe('normalizeInterview', () => {
	it('accepts the wizard map shape and carries the canonical question text', () => {
		const rows = normalizeInterview({ purpose: 'Read Solana launches and call them.' });
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe('purpose');
		// The extractor is told the question EXACTLY as the user saw it.
		expect(rows[0].question).toBe(INTERVIEW_QUESTIONS[0].prompt);
	});

	it('accepts the API array shape and backfills a known question from its id', () => {
		const rows = normalizeInterview([{ id: 'sound', answer: 'Blunt, fast, a bit dry.' }]);
		expect(rows).toHaveLength(1);
		expect(rows[0].question).toBe(INTERVIEW_QUESTIONS.find((q) => q.id === 'sound').prompt);
	});

	it('keeps a caller-supplied question for an id it does not know', () => {
		const rows = normalizeInterview([
			{ id: 'not-a-real-question', question: 'What music does it like?', answer: 'Dub techno.' },
		]);
		expect(rows).toEqual([
			{ id: 'not-a-real-question', question: 'What music does it like?', answer: 'Dub techno.' },
		]);
	});

	it('drops a row with an id it does not know and no question text', () => {
		// Nothing to tell the model it was asked, so the answer is unusable.
		expect(normalizeInterview([{ id: 'unknown', answer: 'Some answer here.' }])).toEqual([]);
	});

	it('treats blank and too-short answers as skips rather than errors', () => {
		const rows = normalizeInterview({
			purpose: 'Read Solana launches and call them.',
			sound: '   ',
			expertise: '',
			sample: 'x'.repeat(MIN_ANSWER_CHARS - 1),
		});
		expect(rows.map((r) => r.id)).toEqual(['purpose']);
	});

	it('collapses whitespace so the transcript is stable', () => {
		const [row] = normalizeInterview({ purpose: '  reads\n\n  launches\tfast  ' });
		expect(row.answer).toBe('reads launches fast');
	});

	it('clamps a runaway answer instead of rejecting it', () => {
		const [row] = normalizeInterview({ purpose: 'a'.repeat(MAX_ANSWER_CHARS + 500) });
		expect(row.answer).toHaveLength(MAX_ANSWER_CHARS);
	});

	it('caps the number of answers so the prompt stays bounded', () => {
		const many = Array.from({ length: MAX_INTERVIEW_ANSWERS + 6 }, (_, i) => ({
			id: `q${i}`,
			question: `Question number ${i}?`,
			answer: `Answer number ${i}.`,
		}));
		expect(normalizeInterview(many)).toHaveLength(MAX_INTERVIEW_ANSWERS);
	});

	it('returns an empty list for junk input rather than throwing', () => {
		for (const junk of [null, undefined, 42, 'a string', [null, 7, 'x'], {}]) {
			expect(normalizeInterview(junk)).toEqual([]);
		}
	});
});

describe('interviewTranscript', () => {
	it('is deterministic, so an extraction is reproducible', () => {
		const rows = normalizeInterview({ purpose: 'Call launches.', sound: 'Blunt and dry.' });
		expect(interviewTranscript(rows)).toBe(interviewTranscript(rows));
	});

	it('numbers every question and answer it was given', () => {
		const rows = normalizeInterview({ purpose: 'Call launches.', sound: 'Blunt and dry.' });
		const transcript = interviewTranscript(rows);
		expect(transcript).toContain('Q1: ');
		expect(transcript).toContain('A1: Call launches.');
		expect(transcript).toContain('A2: Blunt and dry.');
		// Only the answered questions reach the model; skips leave no trace.
		expect(transcript).not.toContain('Q3: ');
	});
});

describe('hasInterviewSignal', () => {
	it('is true for a single answer and false for a full skip', () => {
		expect(hasInterviewSignal(normalizeInterview({ purpose: 'Call launches.' }))).toBe(true);
		expect(hasInterviewSignal(normalizeInterview({}))).toBe(false);
		expect(hasInterviewSignal(null)).toBe(false);
	});
});

describe('skipping the interview still leaves a working persona', () => {
	it('builds a base from what the wizard already collected', () => {
		const base = defaultPersonaBase({
			name: 'Curve Reader',
			description: 'reads a Solana token launch and tells you if it is worth your time',
			greeting: 'Drop a mint and I will pull the curve.',
		});
		expect(base).toContain('Curve Reader');
		expect(base).toContain('reads a Solana token launch');
		expect(base).toContain('Drop a mint and I will pull the curve.');
	});

	it('still produces a real persona when the wizard collected nothing', () => {
		const base = defaultPersonaBase({});
		expect(base.trim().length).toBeGreaterThan(80);
		expect(base).toContain('this agent');
		// The safety floor a default voice must carry.
		expect(base).toContain('Never give financial advice.');
	});

	it('compiles to a complete system prompt, not an empty shell', () => {
		// This is the skip path exactly as the server runs it: no traits, no tone
		// tags, no vocabulary, just the default base.
		const prompt = compilePersona({
			name: 'Curve Reader',
			description: 'reads a Solana token launch',
			base: defaultPersonaBase({ name: 'Curve Reader', description: 'reads a Solana token launch' }),
		});
		expect(prompt.trim().length).toBeGreaterThan(200);
		expect(prompt).toContain('Curve Reader');
		expect(prompt).toContain('How you communicate:');
		// Every trait axis still lands a behavior line at its neutral default, so
		// a skipped interview yields a fully specified voice rather than a prompt
		// with holes in it where the unanswered questions would have gone.
		for (const trait of PERSONA_TRAITS) {
			expect(prompt).toContain(trait.bands[bandIndex(DEFAULT_TRAIT_VALUE)]);
		}
	});

	it('does not fabricate a greeting the owner never wrote', () => {
		expect(defaultPersonaBase({ name: 'Curve Reader' })).not.toContain('You open a conversation');
	});
});
