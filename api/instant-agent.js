// POST /api/instant-agent — one sentence in, a complete playable agent out.
//
// The platform's front door used to be a multi-screen editor: pick a body, name
// it, write a personality, choose a voice, save, share. Every one of those is a
// decision a first-time visitor has no basis to make, and the drop-off is in the
// gap between "I have an idea" and "I have something to look at". This endpoint
// closes that gap into a single request: describe the agent in a sentence and
// get back a finished character with a name, a handle, a written personality, an
// opening line, three conversation starters, a real rigged body from the shipped
// avatar library, and a signature move from the real clip library.
//
//   Body: { idea: string }
//   200:  { agent: {...}, body: {...}, move: {...}, provider, model }
//   400:  idea_too_short | idea_rejected
//   429:  rate limited
//   503:  llm_unavailable   (no provider configured — the page says so plainly)
//
// Nothing here is persisted and no account is required: the result is a draft
// the visitor can talk to immediately, and /start turns it into a real agent
// through the normal authenticated POST /api/agents when they choose to keep it.
// That ordering is deliberate. Try-then-sign-up is the whole point.
//
// Runs on the same free-first LLM chain as the rest of the site (Groq /
// OpenRouter / NVIDIA lead, paid keys last). Anonymous input is moderated before
// it reaches a provider, exactly like anonymous chat.

import { cors, method, wrap, error, readJson, json, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { llmComplete, LlmUnavailableError } from './_lib/llm.js';
import { moderateAnonInput } from './_lib/moderation.js';

const MAX_IDEA = 400;
const MIN_IDEA = 8;

/**
 * The body catalog.
 *
 * Every entry is a GLB that ships in public/avatars and has been measured, not
 * assumed: `canonicalBones` is how many of the 52 canonical joints
 * src/glb-canonicalize.js resolves from that file's skin, and `morphMeshes` is
 * how many of its meshes carry morph targets (the ones that can lip-sync and
 * emote). Bodies below the full 52 are excluded rather than shipped with a
 * caveat: this is the first thing a new visitor sees move, and a partial rig
 * reads as broken. Re-measure with the same parse in tests/instant-agent.test.js
 * if a file is ever replaced.
 */
export const BODIES = Object.freeze([
	{
		id: 'studio',
		label: 'Studio',
		glb: '/avatars/studio.glb',
		blurb: 'Polished and neutral, with the fullest facial range in the library.',
		traits: ['professional', 'neutral', 'expressive', 'guide', 'support', 'assistant'],
		canonicalBones: 52,
		morphMeshes: 5,
	},
	{
		id: 'selfie-girl',
		label: 'Ada',
		glb: '/avatars/selfie-girl.glb',
		blurb: 'Warm and human, built for face-to-face conversation.',
		traits: ['warm', 'friendly', 'human', 'female', 'host', 'concierge', 'teacher'],
		canonicalBones: 52,
		morphMeshes: 4,
	},
	{
		id: 'realistic-female',
		label: 'Nova',
		glb: '/avatars/realistic-female.glb',
		blurb: 'Realistic proportions and a calm, grounded presence.',
		traits: ['realistic', 'calm', 'female', 'analyst', 'precise', 'expert'],
		canonicalBones: 52,
		morphMeshes: 2,
	},
	{
		id: 'realistic-male',
		label: 'Rex',
		glb: '/avatars/realistic-male.glb',
		blurb: 'Realistic proportions with a steady, matter-of-fact read.',
		traits: ['realistic', 'male', 'steady', 'analyst', 'coach', 'expert'],
		canonicalBones: 52,
		morphMeshes: 2,
	},
	{
		id: 'xbot',
		label: 'X-Bot',
		glb: '/avatars/xbot.glb',
		blurb: 'A clean robot shell. Reads as software, not as a person.',
		traits: ['robot', 'machine', 'ai', 'tech', 'bot', 'futuristic', 'developer'],
		canonicalBones: 52,
		morphMeshes: 0,
	},
	{
		id: 'default',
		label: 'Vertex',
		glb: '/avatars/default.glb',
		blurb: 'The house avatar: stylized, energetic, and unmistakably three.ws.',
		traits: ['stylized', 'playful', 'energetic', 'mascot', 'game'],
		canonicalBones: 52,
		morphMeshes: 4,
	},
	{
		id: 'michelle',
		label: 'Michelle',
		glb: '/avatars/michelle.glb',
		blurb: 'A dancer’s rig. Big, readable motion at small sizes.',
		traits: ['performer', 'dancer', 'entertainer', 'bold', 'creative'],
		canonicalBones: 52,
		morphMeshes: 0,
	},
	{
		id: 'parametric-base',
		label: 'Base',
		glb: '/avatars/parametric-base.glb',
		blurb: 'A neutral parametric body, the easiest starting point to restyle later.',
		traits: ['neutral', 'blank', 'custom', 'base', 'minimal'],
		canonicalBones: 52,
		morphMeshes: 4,
	},
]);

/**
 * Signature moves, keyed by mood. Every `clip` is a real entry in
 * public/animations/manifest.json, which is what the viewer loads, so a rename
 * upstream fails the test rather than silently falling back to idle.
 */
export const MOVES = Object.freeze({
	warm: { clip: 'av-idle-female', label: 'Open and relaxed' },
	bold: { clip: 'av-brag-claps', label: 'Chest out, confident' },
	playful: { clip: 'av-dance-shuffle', label: 'Shuffle step' },
	precise: { clip: 'av-waiting', label: 'Composed, waiting to be asked' },
	mysterious: { clip: 'av-spy', label: 'Low-key, watching the room' },
	energetic: { clip: 'av-conductor', label: 'Hands leading the tempo' },
});

export const MOODS = Object.freeze(Object.keys(MOVES));

/** The clip every body settles into between moves. */
export const RESTING_CLIP = 'av-idle-breath';

const RESERVED_HANDLES = new Set([
	'admin', 'root', 'system', 'support', 'help', 'api', 'app', 'www', 'null', 'undefined',
	'test', 'three', 'threews', 'agent', 'agents', 'avatar', 'avatars', 'me', 'new', 'start',
	'anthropic', 'claude', 'openai', 'settings', 'login', 'logout', 'signup', 'dashboard',
]);

/**
 * Reduce anything the model returns to a handle that is safe to show as a URL.
 * Never throws and never returns an empty string: an unusable suggestion falls
 * back to the name, and a name that survives nothing falls back to a stable
 * generic. The handle is a suggestion the visitor can edit, so being permissive
 * here costs nothing, while returning something malformed would render a broken
 * three.ws/@ link on the most important screen on the site.
 */
export function safeHandle(raw, name = '') {
	const clean = (s) =>
		String(s || '')
			.normalize('NFKD')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 20)
			.replace(/-+$/, '');
	let handle = clean(raw);
	if (handle.length < 3 || RESERVED_HANDLES.has(handle)) handle = clean(name);
	if (handle.length < 3 || RESERVED_HANDLES.has(handle)) handle = 'new-agent';
	return handle;
}

/**
 * Score every body against the idea and the model's own hint, and return the
 * best one. Word-boundary matching so "botany" cannot select the robot and
 * "female" in "female founder" still reaches the bodies tagged female.
 */
export function pickBody(idea, hint = '') {
	const haystack = `${hint} ${idea}`.toLowerCase();
	let best = BODIES[0];
	let bestScore = -1;
	for (const body of BODIES) {
		let score = 0;
		// The hint is the model's deliberate choice, so it outweighs incidental
		// words in the idea.
		if (body.id === String(hint || '').toLowerCase().trim()) score += 10;
		for (const trait of body.traits) {
			if (new RegExp(`\\b${trait}\\b`, 'i').test(haystack)) score += 2;
		}
		// Ties break toward the body that can also emote, since a talking agent
		// with a face reads better than one without.
		score += body.morphMeshes * 0.1;
		if (score > bestScore) {
			bestScore = score;
			best = body;
		}
	}
	return best;
}

/** Resolve the mood to its signature move, defaulting to the warm one. */
export function pickMove(mood) {
	return MOVES[mood] || MOVES.warm;
}

const SYSTEM = `You are a character director for three.ws, a platform where AI agents have real 3D bodies.

Given one sentence describing an agent, invent the finished character. Reply with ONE JSON object and nothing else. No markdown fence, no commentary.

{
  "name": "short display name, 2-24 characters, no emoji, no quotes",
  "handle": "lowercase url-safe handle, 3-20 characters, letters/numbers/hyphens only",
  "tagline": "one line under 70 characters describing what it does, no period at the end",
  "personality": "2 to 4 sentences written as a system prompt in the second person, starting with 'You are'. Give it a job, a tone, and one honest limit (what it does not do or does not know).",
  "greeting": "the first line the agent says out loud, under 140 characters, in its own voice",
  "starters": ["three short questions a visitor could ask it, under 60 characters each"],
  "mood": "one of: warm, bold, playful, precise, mysterious, energetic",
  "body": "one of: studio, selfie-girl, realistic-female, realistic-male, xbot, default, michelle, parametric-base"
}

Rules: write in the language of the user's sentence. Never invent capabilities the agent cannot have, such as sending money, browsing private data, or acting on someone's behalf. Never claim to be human. Keep the personality specific to the idea rather than generic assistant filler.`;

/**
 * Pull the JSON object out of a completion. Models wrap JSON in prose or a code
 * fence often enough that failing on it would make the endpoint flaky for a
 * purely cosmetic reason, so the first balanced `{...}` span is extracted before
 * parsing. Returns null when there is nothing parseable.
 */
export function extractJson(text) {
	const raw = String(text || '').trim();
	if (!raw) return null;
	const start = raw.indexOf('{');
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) {
			try {
				return JSON.parse(raw.slice(start, i + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}

const trim = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Turn a raw completion into the response contract, repairing whatever the model
 * left out. Every field has a usable value on return, so the page never has to
 * render a hole: a missing greeting is written from the name, missing starters
 * are filled from a generic set that works for any agent, and an out-of-range
 * mood becomes 'warm'.
 */
export function buildPersona(parsed, idea) {
	const source = parsed && typeof parsed === 'object' ? parsed : {};
	const name = trim(source.name, 24) || trim(idea, 24) || 'Your agent';
	const mood = MOODS.includes(source.mood) ? source.mood : 'warm';
	const tagline = trim(source.tagline, 70) || trim(idea, 70);
	const personality =
		trim(source.personality, 900) ||
		`You are ${name}. ${tagline}. You are helpful and concise, you answer in a few sentences, and you say plainly when something is outside what you know.`;
	const starters = (Array.isArray(source.starters) ? source.starters : [])
		.map((s) => trim(s, 60))
		.filter(Boolean)
		.slice(0, 3);
	while (starters.length < 3) {
		starters.push(['What can you help me with?', 'Who made you?', 'What do you not do?'][starters.length]);
	}
	return {
		name,
		handle: safeHandle(source.handle, name),
		tagline,
		personality,
		greeting: trim(source.greeting, 140) || `Hi, I'm ${name}. ${tagline}.`,
		starters,
		mood,
		bodyHint: trim(source.body, 40),
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	// A dedicated bucket, not the shared publicIp pool: every call here spends a
	// real LLM completion, so it must be cheaper to rate-limit than to serve.
	const rl = await limits.instantAgentIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
	const idea = typeof body?.idea === 'string' ? body.idea.trim().slice(0, MAX_IDEA) : '';
	if (idea.length < MIN_IDEA) {
		return error(res, 400, 'idea_too_short', 'Describe the agent in a few more words.');
	}

	// Anonymous free-text reaching a provider gets the same screening as
	// anonymous chat. A block is a 400 with a plain reason, never a silent
	// rewrite of what the visitor asked for.
	const verdict = await moderateAnonInput(idea);
	if (verdict.flagged) {
		return error(
			res,
			400,
			'idea_rejected',
			'That description cannot be used to create an agent. Try describing what it should help people do.',
		);
	}

	let result;
	try {
		result = await llmComplete({
			system: SYSTEM,
			user: idea,
			maxTokens: 700,
			// A deliberate one-shot generation the visitor is watching a progress
			// meter for, not a background enrichment: the free lanes need real time
			// to emit ~700 tokens of structured JSON, and the chain slices this
			// budget across every rung it tries. At the 25s default the lead free
			// provider was cut to an ~8s slice and its 200 response was abandoned
			// mid-body, which reads to the caller as "the model failed" when it was
			// only starved.
			timeoutMs: 55_000,
			track: { tool: 'instant-agent', clientId: clientIp(req) },
		});
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			return error(res, 503, 'llm_unavailable', 'Agent generation is not available right now.');
		}
		console.error('[instant-agent] LLM failed', err.status || '', err.message);
		return error(res, 502, 'llm_failed', 'Could not write the character. Try again.');
	}

	const parsed = extractJson(result.text);
	if (!parsed) {
		console.warn('[instant-agent] unparseable completion from', result.provider, result.model);
		return error(res, 502, 'llm_failed', 'Could not write the character. Try again.');
	}

	const agent = buildPersona(parsed, idea);
	const chosen = pickBody(idea, agent.bodyHint);
	const move = pickMove(agent.mood);

	return json(res, 200, {
		agent: {
			name: agent.name,
			handle: agent.handle,
			tagline: agent.tagline,
			personality: agent.personality,
			greeting: agent.greeting,
			starters: agent.starters,
			mood: agent.mood,
		},
		body: {
			id: chosen.id,
			label: chosen.label,
			glb: chosen.glb,
			blurb: chosen.blurb,
			canonical_bones: chosen.canonicalBones,
			can_emote: chosen.morphMeshes > 0,
		},
		move: { clip: move.clip, label: move.label, resting: RESTING_CLIP },
		idea,
		provider: result.provider,
		model: result.model,
	});
});
