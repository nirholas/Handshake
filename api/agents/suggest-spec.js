// POST /api/agents/suggest-spec  { prompt?: string }
//
// The "describe it, don't fill it in" engine behind the Create-Agent wizard.
// Anyone (signed in or not) types one sentence (or nothing at all — "surprise
// me") and gets back a COMPLETE, ready-to-ship agent spec: name, description,
// tags, optional skills, marketplace category, greeting, persona/system-prompt,
// a fitting starter body, and a voice. The wizard pours it straight into its
// form so the whole flow becomes review-and-tweak instead of type-everything.
//
// Try-first: the wizard only requires an account at the final "ship it" step, so
// generation is OPEN to signed-out visitors too. Anonymous callers hit the paid
// LLM chain with no user identity, so they carry a much tighter per-IP rate
// budget (limits.agentSuggestAnon) than signed-in users and no spend attribution.
//
// Real model, real provider chain (api/_lib/llm.js — free providers first, paid
// backstop last), real spend metering. No canned responses, no fake data.
//
// $THREE (FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump) is the only coin three.ws
// promotes; the generator is instructed never to name or invent any other token.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { llmComplete, llmConfigured, LlmUnavailableError } from '../_lib/llm.js';

// Mirrors the optional skill set in src/create-agent.js (OPTIONAL_SKILLS). Core
// skills are always-on and not chosen here, so they're intentionally omitted.
const OPTIONAL_SKILLS = [
	{ id: 'wave', desc: 'Waves at people on greet or on request.' },
	{ id: 'dance', desc: 'Plays a dance animation loop on cue.' },
	{ id: 'pump-fun', desc: 'Read-only Solana market data: tokens, bonding curves, trending, rug-risk.' },
	{ id: 'explain-gltf', desc: 'Narrates mesh, material, and animation info from the 3D scene.' },
	{ id: 'web-search', desc: 'Looks things up on the live web when asked.' },
];
const OPTIONAL_SKILL_IDS = new Set(OPTIONAL_SKILLS.map((s) => s.id));

// Mirrors CATEGORIES in src/create-agent.js / api/marketplace/[action].js.
const CATEGORIES = [
	'academic', 'career', 'copywriting', 'design', 'education', 'emotions',
	'entertainment', 'games', 'general', 'life', 'marketing', 'office',
	'programming', 'translation',
];
const CATEGORY_SET = new Set(CATEGORIES);

// Mirrors STARTERS in src/create-agent.js — the real, shipped GLB bodies the
// wizard can pre-select. The model picks the one that best fits the vibe.
const STARTERS = [
	{ id: 'default', vibe: 'a friendly, approachable humanoid host (good default)' },
	{ id: 'cz', vibe: 'a sharp, confident finance/markets persona' },
	{ id: 'robot', vibe: 'a playful, expressive robot — tech, games, fun' },
	{ id: 'soldier', vibe: 'a serious, disciplined, tactical character' },
];
const STARTER_SET = new Set(STARTERS.map((s) => s.id));

// Field bounds — kept just inside the wizard's own input maxlengths so a
// generated value never lands truncated in the form.
const LIMITS = { name: 48, description: 240, greeting: 160, persona: 1800, tag: 24 };

function buildSystem() {
	const skillLines = OPTIONAL_SKILLS.map((s) => `  - "${s.id}": ${s.desc}`).join('\n');
	return [
		'You are the agent-design copilot for three.ws, a platform where people deploy 3D AI agents with their own on-chain identity and wallet.',
		'Given a short brief (or none at all), design ONE complete, polished, marketplace-ready agent. Be specific and characterful — never generic filler like "a helpful assistant".',
		'',
		'Return ONLY a single JSON object, no prose, no code fences, with exactly these keys:',
		'{',
		'  "name": string — a punchy display name, 2–48 chars (e.g. "Market Oracle", "Nova", "Zen Coach"). Letters, numbers, spaces only.',
		'  "description": string — one or two sentences, <=240 chars, says what it does and who it is for.',
		'  "tags": string[] — 3 to 6 lowercase discovery tags, each one or two words, no "#".',
		'  "skills": string[] — zero or more skill ids chosen ONLY from this list, matched to the agent\'s purpose:',
		skillLines,
		`  "category": string — exactly one of: ${CATEGORIES.join(', ')}.`,
		'  "greeting": string — the agent\'s first-person opening line to a visitor, <=160 chars, in character.',
		'  "persona": string — the agent\'s system prompt / character profile, 120–600 chars: voice, expertise, how it behaves, what it refuses. Written as instructions to the agent ("You are…").',
		`  "avatar_starter": string — the best-fitting starter body id, one of: ${STARTERS.map((s) => `"${s.id}" (${s.vibe})`).join(', ')}.`,
		'  "voice": "browser"',
		'}',
		'',
		'Rules:',
		'- The ONLY coin or token you may ever name is $THREE. Never mention, invent, or recommend any other coin, token, ticker, or contract address — not in the name, description, tags, persona, or greeting.',
		'- Pick skills only when they genuinely fit the brief; an art critic does not need market data, a trader does not need to dance.',
		'- Output must be valid JSON parseable by JSON.parse. No trailing commas, no comments, no surrounding text.',
	].join('\n');
}

// Pull the first balanced JSON object out of a model response, tolerating code
// fences or stray prose around it. Returns the parsed object or null.
function parseSpec(text) {
	if (!text) return null;
	let s = String(text).trim();
	const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) s = fence[1].trim();
	const start = s.indexOf('{');
	const end = s.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	const slice = s.slice(start, end + 1);
	try {
		return JSON.parse(slice);
	} catch {
		return null;
	}
}

const clampStr = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

// Validate + clamp the raw model object into a spec the wizard can trust. Every
// field is defended: bad/missing values fall back to safe defaults so the user
// always gets a usable result, never a broken form.
function normalize(raw) {
	const out = {};
	out.name = clampStr(raw?.name, LIMITS.name).replace(/[^\p{L}\p{N} ]/gu, '').trim() || 'New Agent';
	out.description = clampStr(raw?.description, LIMITS.description);
	out.greeting = clampStr(raw?.greeting, LIMITS.greeting);
	out.persona = clampStr(raw?.persona, LIMITS.persona);

	const tags = Array.isArray(raw?.tags) ? raw.tags : [];
	out.tags = [...new Set(
		tags
			.map((t) => clampStr(t, LIMITS.tag).toLowerCase().replace(/^#/, '').replace(/[^a-z0-9 +-]/g, '').trim())
			.filter(Boolean),
	)].slice(0, 8);

	const skills = Array.isArray(raw?.skills) ? raw.skills : [];
	out.skills = [...new Set(skills.filter((s) => OPTIONAL_SKILL_IDS.has(s)))];

	out.category = CATEGORY_SET.has(raw?.category) ? raw.category : 'general';
	out.avatar_starter = STARTER_SET.has(raw?.avatar_starter) ? raw.avatar_starter : 'default';
	out.voice = raw?.voice === 'custom' ? 'custom' : 'browser';
	return out;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	// Try-first: the create-agent wizard lets a signed-out visitor build (and now
	// generate) a whole agent before making an account — sign-in is only required
	// at the final "ship it" step. So authentication is resolved but NOT required
	// here. Anonymous calls still hit the paid LLM chain, so they get a much
	// tighter per-IP budget than signed-in users and carry no user attribution.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;

	const ip = clientIp(req);
	const rl = userId ? await limits.agentSuggest(ip) : await limits.agentSuggestAnon(ip);
	if (!rl.success) return rateLimited(res, rl);

	if (!llmConfigured()) {
		return error(res, 503, 'llm_unavailable', 'Agent generation is offline right now. Fill the form in manually — it only takes a minute.');
	}

	const body = await readJson(req).catch(() => ({}));
	const prompt = clampStr(body?.prompt, 600);
	const userMsg = prompt
		? `Brief: ${prompt}`
		: 'No brief given — invent one distinctive, genuinely useful agent a person would be excited to deploy. Surprise me.';

	let completion;
	try {
		completion = await llmComplete({
			system: buildSystem(),
			user: userMsg,
			maxTokens: 700,
			timeoutMs: 30_000,
			track: { userId, tool: 'agent_suggest_spec' },
		});
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			return error(res, 503, 'llm_unavailable', 'Agent generation is offline right now. Fill the form in manually.');
		}
		if (err?.code === 'daily_spend_cap_exceeded') {
			return error(res, 429, 'daily_spend_cap_exceeded', err.message);
		}
		return error(res, 502, 'generation_failed', 'The model could not be reached. Try again in a moment.');
	}

	const parsed = parseSpec(completion.text);
	if (!parsed) {
		return error(res, 502, 'generation_failed', 'The generator returned an unreadable result. Try again or tweak your description.');
	}

	return json(res, 200, { spec: normalize(parsed), provider: completion.provider });
});
