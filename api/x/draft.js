// POST /api/x/draft
// Body: { agent_id?, prompt?, tone?, thread?, count? }
// Generates tweet drafts in the agent's voice with the platform LLM chain and
// returns { drafts: [{ text, length } | { thread_parts, length }] }, the shape
// the dashboard X panel renders. `count` asks for that many DIFFERENT options
// (each generated from its own angle), not that many paraphrases of one.

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, method, wrap, error, readJson, json, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import { llmComplete, LlmUnavailableError } from '../_lib/llm.js';
import { MAX_TWEET_LEN } from '../_lib/x-post.js';

const MAX_DRAFTS = 3;
// The dashboard sends whatever is in the compose box as the prompt, and that box
// legitimately holds a whole multi-part thread, so the ceiling has to clear a few
// tweets' worth of text while still bounding what reaches the model.
const MAX_PROMPT_LEN = 2000;
const MAX_THREAD_PARTS = 5;

// Mirrors the tone select in the dashboard X panel (src/dashboard/dashboard.js).
const TONE_GUIDE = {
	neutral: 'Plain and confident. No hype words, no exclamation marks.',
	hype: 'High energy and punchy. Short sentences. Specific excitement, never generic hype.',
	sarcastic: 'Dry wit, understated, self-aware. Never mean.',
	technical: 'Precise and concrete. Name the mechanism, not the vibe.',
	deadpan: 'Flat delivery, no exclamation marks. Humor comes from understatement.',
};

// One angle per requested draft, so "Draft x3" returns three genuinely different
// openings instead of three rewrites of the same sentence.
const ANGLES = [
	'Open with a concrete detail only this agent would know.',
	'Open with a question that makes a scrolling reader stop.',
	'Open with a claim, then back it with one specific fact.',
];

function buildSystem({ tone, thread }) {
	const lines = [
		'You write tweets for AI agents on three.ws.',
		'Rules:',
		`- Each tweet is under ${MAX_TWEET_LEN} characters. This is a hard limit.`,
		"- Write in the agent's voice: first person, matching its description.",
		'- At most one hashtag. No hashtag spam.',
		'- Plain text only. No surrounding quotes, no markdown, no emoji spam.',
		'- Never use an em-dash or an en-dash.',
		`- Tone: ${TONE_GUIDE[tone]}`,
	];
	if (thread) {
		lines.push(
			'- Write a thread of 2 to 4 tweets. Separate each tweet with a line containing only three hyphens.',
			'Output ONLY the thread, nothing else.',
		);
	} else {
		lines.push('Output ONLY the tweet text, nothing else.');
	}
	return lines.join('\n');
}

// Strip the wrapping quotes an LLM sometimes adds, then hard-cap at the tweet
// limit so a long completion can never produce a draft X would reject.
function normalizeTweet(raw) {
	let text = String(raw || '').trim();
	if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
	if (text.length > MAX_TWEET_LEN) text = `${text.slice(0, MAX_TWEET_LEN - 1).trimEnd()}…`;
	return text;
}

function toDraft(raw, thread) {
	if (!thread) {
		const text = normalizeTweet(raw);
		return text ? { text, length: text.length } : null;
	}
	const parts = String(raw || '')
		.split(/^[ \t]*-{3,}[ \t]*$/m)
		.map(normalizeTweet)
		.filter(Boolean)
		.slice(0, MAX_THREAD_PARTS);
	if (!parts.length) return null;
	// A single-part "thread" is just a tweet; return it in the shape the client
	// renders for one so it doesn't show a one-item thread picker.
	if (parts.length === 1) return { text: parts[0], length: parts[0].length };
	return { thread_parts: parts, length: parts.reduce((n, p) => n + p.length, 0) };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	// Drafting spends real LLM budget on the platform's keys, so it is gated like
	// the rest of the authenticated write surface: CSRF stops another origin from
	// burning a signed-in user's budget, and the bucket stops a single session
	// from turning the endpoint into a free LLM relay.
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.xDraftIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
	const agentId = typeof body?.agent_id === 'string' ? body.agent_id : null;
	if (agentId && !isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id must be a uuid');

	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	if (prompt.length > MAX_PROMPT_LEN) {
		return error(res, 400, 'validation_error', `prompt must be ${MAX_PROMPT_LEN} characters or fewer`);
	}

	const requestedTone = typeof body?.tone === 'string' ? body.tone : '';
	if (requestedTone && !TONE_GUIDE[requestedTone]) {
		return error(res, 400, 'validation_error', `tone must be one of: ${Object.keys(TONE_GUIDE).join(', ')}`);
	}
	const thread = body?.thread === true;

	const rawCount = body?.count === undefined ? 1 : Number(body.count);
	if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > MAX_DRAFTS) {
		return error(res, 400, 'validation_error', `count must be an integer between 1 and ${MAX_DRAFTS}`);
	}

	// Persona context. The dashboard sends `avatar.agent_id || avatar.id`, so the
	// id can address either table; resolve both, scoped to the caller, so nobody
	// can pull another owner's private agent description into a prompt.
	let agentContext = '';
	let storedTone = '';
	if (agentId) {
		const [identity] = await sql`
			select name, description from agent_identities
			where id = ${agentId} and user_id = ${user.id} and deleted_at is null
			limit 1
		`;
		const [avatar] = identity
			? []
			: await sql`select name, description, tone from avatars where id = ${agentId} and user_id = ${user.id} limit 1`;
		const a = identity || avatar;
		if (a) {
			agentContext = `Agent name: ${a.name || 'Unnamed'}\nAgent description: ${a.description || '(none)'}`;
			if (typeof a.tone === 'string' && TONE_GUIDE[a.tone]) storedTone = a.tone;
		}
	}
	// Explicit tone wins; otherwise fall back to the agent's saved tone.
	const tone = requestedTone || storedTone || 'neutral';

	const system = buildSystem({ tone, thread });
	const topic = prompt
		? `What to post about: ${prompt}`
		: 'Write something engaging about being an autonomous AI agent.';

	const settled = await Promise.allSettled(
		Array.from({ length: rawCount }, (_, i) =>
			llmComplete({
				system,
				user: [agentContext, topic, `Angle: ${ANGLES[i % ANGLES.length]}`].filter(Boolean).join('\n\n'),
				maxTokens: thread ? 600 : 200,
				track: { userId: user.id, agentId, tool: 'x/draft' },
			}),
		),
	);

	const drafts = [];
	const seen = new Set();
	let unavailable = false;
	let lastError = null;
	for (const outcome of settled) {
		if (outcome.status === 'rejected') {
			if (outcome.reason instanceof LlmUnavailableError) unavailable = true;
			else lastError = outcome.reason;
			continue;
		}
		const draft = toDraft(outcome.value?.text, thread);
		if (!draft) continue;
		// Different angles occasionally converge on the same line; show it once.
		const key = draft.thread_parts ? draft.thread_parts.join('\u0000') : draft.text;
		if (seen.has(key)) continue;
		seen.add(key);
		drafts.push(draft);
	}

	if (!drafts.length) {
		if (unavailable) return error(res, 503, 'llm_unavailable', 'draft generation is not available right now');
		if (lastError) {
			console.error('[x-draft] LLM failed', lastError.status || '', lastError.message);
			return error(res, 502, 'llm_failed', 'draft generation failed');
		}
		return error(res, 502, 'llm_empty', 'the model returned no usable draft, try again');
	}

	return json(res, 200, { drafts, tone, thread });
});
