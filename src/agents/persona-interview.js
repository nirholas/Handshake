// The onboarding interview that turns a person's own words into an agent voice.
//
// This is the SINGLE source of truth for the question set, for what counts as an
// answered question, and for the persona an agent gets when the interview is
// skipped entirely. It is imported by BOTH the browser (the create-agent wizard,
// src/create-agent.js) and the server (POST /api/persona/interview and the
// per-agent extract route) so the questions a user sees are byte-identical to
// the questions the extractor is told were asked.
//
// The interview is always optional. Every question can be left blank, and the
// whole step can be skipped: `defaultPersonaBase()` produces a real, working
// base persona from the name/description/greeting the wizard already collected,
// so a skipped interview still compiles a complete persona_prompt through
// compilePersona() rather than leaving the agent voiceless.
//
// Pure ESM. No DOM, no Node, no imports — runs anywhere.

/**
 * The interview. Seven questions, ordered from the easiest to answer to the most
 * revealing, so a user who bails after three still leaves usable signal behind.
 *
 * `id`      stable key — persisted with the answer as interview provenance.
 * `prompt`  the question, exactly as the extractor is told it was asked.
 * `hint`    sub-label rendered under the field.
 * `placeholder` example answer; never submitted, only shown.
 */
export const INTERVIEW_QUESTIONS = [
	{
		id: 'purpose',
		prompt: 'What should this agent help people with?',
		hint: 'A sentence or two. The job, not the job title.',
		placeholder: 'Help builders read a Solana token launch and decide if it is worth their time.',
	},
	{
		id: 'sound',
		prompt: 'How should it sound when it talks?',
		hint: 'Describe the voice the way you would describe a person you know.',
		placeholder: 'Blunt, fast, a bit dry. Never salesy. Talks like a trader, not a brochure.',
	},
	{
		id: 'expertise',
		prompt: 'What should it know cold?',
		hint: 'The topics it should never have to hedge on.',
		placeholder: 'Bonding curves, liquidity, holder distribution, rug patterns.',
	},
	{
		id: 'sample',
		prompt: 'Write one line the way you want to hear it say something.',
		hint: 'One real sentence in its voice beats three paragraphs describing the voice.',
		placeholder: 'Curve is 60% through and the top holder owns 18%. That is not a moon, that is an exit.',
	},
	{
		id: 'avoid',
		prompt: 'What should it never do or say?',
		hint: 'Hard limits, pet peeves, phrases that would make you cringe.',
		placeholder: 'Never say "to the moon". Never give financial advice. No emoji.',
	},
	{
		id: 'uncertainty',
		prompt: 'When it is not sure, what should it do?',
		hint: 'How it behaves at the edge of what it knows.',
		placeholder: 'Say so in one line, then give the best read it has with the caveat attached.',
	},
	{
		id: 'vocabulary',
		prompt: 'Any words, phrases, or running jokes that belong to it?',
		hint: 'Verbal fingerprints. Leave blank if none come to mind.',
		placeholder: 'calls things "clean" or "cooked"; says "let me pull the chart" before every read.',
	},
];

/** Stable question ids, in order. */
export const INTERVIEW_QUESTION_IDS = INTERVIEW_QUESTIONS.map((q) => q.id);

/** The interview is between 5 and 8 questions; the extractor enforces the same bound. */
export const MAX_INTERVIEW_ANSWERS = 8;
/** Shortest answer that carries any signal. Anything shorter reads as a skip. */
export const MIN_ANSWER_CHARS = 4;
/** Per-answer ceiling. Long enough for a paragraph, short enough to bound the prompt. */
export const MAX_ANSWER_CHARS = 1000;

const collapse = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * Normalize raw interview input into the wire shape the extractor consumes.
 *
 * Accepts either the wizard's `{ [questionId]: answerText }` map or an array of
 * `{ id?, question?, answer }` rows (which is what the API receives). Blank and
 * too-short answers are dropped, so skipping questions is a first-class outcome
 * rather than an error: the result is simply shorter.
 *
 * @param {object|Array} input
 * @returns {{id: string, question: string, answer: string}[]}
 */
export function normalizeInterview(input) {
	const rows = [];
	if (Array.isArray(input)) {
		for (const row of input) {
			if (!row || typeof row !== 'object') continue;
			const id = collapse(row.id);
			const known = INTERVIEW_QUESTIONS.find((q) => q.id === id);
			const question = collapse(row.question) || known?.prompt || '';
			const answer = collapse(row.answer);
			if (!question || answer.length < MIN_ANSWER_CHARS) continue;
			rows.push({
				id: id || 'custom',
				question: question.slice(0, 240),
				answer: answer.slice(0, MAX_ANSWER_CHARS),
			});
		}
	} else if (input && typeof input === 'object') {
		for (const q of INTERVIEW_QUESTIONS) {
			const answer = collapse(input[q.id]);
			if (answer.length < MIN_ANSWER_CHARS) continue;
			rows.push({ id: q.id, question: q.prompt, answer: answer.slice(0, MAX_ANSWER_CHARS) });
		}
	}
	return rows.slice(0, MAX_INTERVIEW_ANSWERS);
}

/**
 * Render normalized answers as the Q/A block handed to the model. Deterministic:
 * the same answers always produce the same transcript, so the extraction is
 * reproducible and the stored provenance matches what the model actually read.
 *
 * @param {{question: string, answer: string}[]} answers
 * @returns {string}
 */
export function interviewTranscript(answers) {
	return answers
		.map((row, i) => `Q${i + 1}: ${row.question}\nA${i + 1}: ${row.answer}`)
		.join('\n\n');
}

/**
 * The base persona an agent gets when the interview is skipped (or produced
 * nothing usable). Built from what the wizard already knows, so the compiled
 * persona_prompt is a real, complete voice rather than an empty shell.
 *
 * @param {object} input
 * @param {string} [input.name]
 * @param {string} [input.description]
 * @param {string} [input.greeting]
 * @returns {string}
 */
export function defaultPersonaBase(input = {}) {
	const name = collapse(input.name) || 'this agent';
	const description = collapse(input.description);
	const greeting = collapse(input.greeting);

	const lines = [
		description
			? `You are ${name}. Your job is ${description.replace(/\.$/, '')}.`
			: `You are ${name}, an embodied agent on three.ws that helps people with whatever they bring you.`,
		'Answer from what you actually know. When you are not sure, say so plainly in one line and give your best read anyway, with the caveat attached.',
		'Never invent facts, numbers, or sources. Never give financial advice.',
	];
	if (greeting) {
		lines.push(`You open a conversation with something in the spirit of: "${greeting}"`);
	}
	return lines.join('\n');
}

/**
 * True when the interview produced enough signal to be worth sending to the
 * extractor. One answered question is enough — the extractor is told to infer
 * conservatively from a sparse interview rather than fabricate.
 * @param {{answer: string}[]} answers
 */
export function hasInterviewSignal(answers) {
	return Array.isArray(answers) && answers.length > 0;
}
