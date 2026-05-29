// Pay-As-You-Learn Tutor — LLM-backed explanation generator.
//
// Routes through the platform's shared provider policy (api/_lib/llm.js):
// Groq and OpenRouter are the funded free defaults; Anthropic is used only when
// the operator brings their own key. The tutor turns a learner's question
// (optionally with code/context) into a structured, level-appropriate
// explanation, returning the output-token count so the endpoint can bill the
// per-token surcharge accurately.

import { llmComplete } from '../../../api/_lib/llm.js';

const LEVELS = {
	beginner:
		'The learner is a BEGINNER. Assume no prior knowledge. Define jargon the first ' +
		'time it appears, use a concrete everyday analogy, and keep sentences short.',
	intermediate:
		'The learner is INTERMEDIATE. They know the basics. Skip trivial definitions, ' +
		'focus on the "why" and common pitfalls, and connect the idea to related concepts.',
	expert:
		'The learner is an EXPERT. Be precise and dense. Lead with the nuance, edge cases, ' +
		'performance/complexity characteristics, and trade-offs. Do not pad with basics.',
};

export const LEVEL_NAMES = Object.keys(LEVELS);

function buildSystemPrompt(level) {
	return [
		'You are the three.ws Tutor — a patient, rigorous teacher that explains one thing at a time.',
		LEVELS[level] || LEVELS.intermediate,
		'',
		'Rules:',
		'- Answer ONLY what was asked. Do not invent follow-up questions.',
		'- When code is provided, reference specific lines/identifiers from it.',
		'- Prefer a short worked example over abstract prose.',
		'- If the question is ambiguous, state the most useful interpretation in one line, then answer it.',
		'- Never fabricate APIs, citations, or facts. If unsure, say what is uncertain and why.',
		'',
		'Respond with a JSON object exactly matching this schema (no markdown fences, no preamble):',
		'{',
		'  "explanation": string,        // the core teaching answer, may use \\n for paragraphs',
		'  "keyPoints": string[],        // 2-5 takeaways the learner should remember',
		'  "example": string | null,     // a short worked example or code snippet, or null',
		'  "followUp": string | null     // one suggested next question to deepen understanding, or null',
		'}',
	].join('\n');
}

function buildUserPrompt({ question, context }) {
	const parts = [`Question: ${question}`];
	if (context && context.trim()) {
		parts.push('', 'Context / code provided by the learner:', '```', context.trim().slice(0, 6000), '```');
	}
	parts.push('', 'Return the JSON object only.');
	return parts.join('\n');
}

function coerceShape(parsed, rawText) {
	const out = {
		explanation: '',
		keyPoints: [],
		example: null,
		followUp: null,
	};
	if (parsed && typeof parsed === 'object') {
		out.explanation =
			typeof parsed.explanation === 'string' && parsed.explanation.trim()
				? parsed.explanation.trim()
				: (rawText || '').trim();
		if (Array.isArray(parsed.keyPoints)) {
			out.keyPoints = parsed.keyPoints
				.filter((p) => typeof p === 'string' && p.trim())
				.map((p) => p.trim())
				.slice(0, 5);
		}
		if (typeof parsed.example === 'string' && parsed.example.trim()) out.example = parsed.example.trim();
		if (typeof parsed.followUp === 'string' && parsed.followUp.trim()) out.followUp = parsed.followUp.trim();
	} else {
		out.explanation = (rawText || '').trim();
	}
	if (!out.explanation) out.explanation = 'No explanation could be generated for that question.';
	return out;
}

/**
 * Generate a structured tutoring explanation.
 *
 * @param {object} opts
 * @param {string} opts.question            What the learner asked.
 * @param {string} [opts.context]           Optional code/context to ground the answer.
 * @param {string} [opts.level]             beginner | intermediate | expert.
 * @param {string} [opts.anthropicKey]      Operator BYOK key (optional).
 * @returns {Promise<{ explanation, keyPoints, example, followUp, outputTokens, provider, model }>}
 */
export async function teach({ question, context = '', level = 'intermediate', anthropicKey = null }) {
	const lvl = LEVELS[level] ? level : 'intermediate';

	const { text, usage, provider, model } = await llmComplete({
		system: buildSystemPrompt(lvl),
		user: buildUserPrompt({ question, context }),
		maxTokens: 1200,
		anthropicKey,
		timeoutMs: 45_000,
	});

	let parsed = null;
	try {
		// Tolerate stray prose/fences around the JSON object.
		const match = text.match(/\{[\s\S]*\}/);
		parsed = JSON.parse(match ? match[0] : text);
	} catch {
		parsed = null;
	}

	const shaped = coerceShape(parsed, text);
	return {
		...shaped,
		level: lvl,
		outputTokens: usage?.output || 0,
		provider,
		model,
	};
}
