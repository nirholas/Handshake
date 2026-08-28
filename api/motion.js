// Motion API: a sentence in, a real animation out.
// ---------------------------------------------------------------------------
//   GET  /api/motion?prompt=<text>[&loop=1][&effort=<name>][&lane=auto|fast|model]
//        Compile a movement. Returns the clip, the Motion Score that produced
//        it, and which lane wrote the score. Public.
//
//   GET  /api/motion?capabilities=1
//        The score schema, the vocabulary, and the actions the model-free lane
//        knows. This is what a tool definition or an editor is built from.
//
//   POST /api/motion   { score, name?, loop?, idle?, rootMotion?, fingers? }
//        Compile a Motion Score directly, with no model involved. This is the
//        path an editor uses: change a beat, recompile, see it move. Public.
//
// Nothing here is stored and nothing is generated twice: the compiler is
// deterministic, so the same prompt returns the same clip, and the response
// carries the score so a caller can edit and recompile without asking again.

import {
	compileScore,
	describeScore,
	motionCapabilities,
	validateScore,
} from '@three-ws/motion';
import { cors, json, error, method, wrap, readJson, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getSessionUser } from './_lib/auth.js';
import { authorScore } from './_lib/motion-author.js';

export const maxDuration = 60;

/** Longest prompt worth reading: a movement description, not a screenplay. */
const MAX_PROMPT = 400;

const LANES = new Set(['auto', 'fast', 'model']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	if (req.method === 'GET' && url.searchParams.has('capabilities')) {
		res.setHeader('cache-control', 'public, max-age=300, s-maxage=3600');
		return json(res, 200, motionCapabilities());
	}

	let userId = null;
	try { userId = (await getSessionUser(req))?.id ?? null; } catch { userId = null; }

	if (req.method === 'POST') return compileDirect(req, res, userId);
	return compileFromPrompt(req, res, url, userId);
});

async function compileFromPrompt(req, res, url, userId) {
	const prompt = (url.searchParams.get('prompt') || '').trim().slice(0, MAX_PROMPT);
	if (!prompt) {
		return error(res, 400, 'missing_prompt', 'Describe the movement, for example prompt=wave hello twice.');
	}

	const lane = LANES.has(url.searchParams.get('lane')) ? url.searchParams.get('lane') : 'auto';
	// Only the model lane costs anything, so only the model lane is metered
	// against the slower bucket; recognizing "wave" is free and should feel it.
	const rl = lane === 'fast'
		? await limits.publicIp(clientIp(req))
		: await limits.motionAuthor(userId || clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const options = readOptions(url.searchParams);

	let authored;
	try {
		authored = await authorScore(prompt, { ...options, lane, prefer: lane, userId });
	} catch (err) {
		return error(
			res,
			err.status ?? 500,
			err.code ?? 'author_failed',
			err.message,
			err.actions ? { actions: err.actions } : undefined,
		);
	}

	let compiled;
	try {
		compiled = compileScore(authored.score, options);
	} catch (err) {
		// The author lane validates before returning, so reaching here means the
		// solver disagreed with the validator, which is a bug worth naming rather
		// than a bad prompt.
		return error(res, 500, 'compile_failed', `The score validated but would not compile: ${err.message}`);
	}

	// Deterministic output: the same prompt is the same bytes, so the edge can
	// hold it. Short enough that a vocabulary change ships within the hour.
	res.setHeader('cache-control', 'public, max-age=600, s-maxage=3600');
	return json(res, 200, respond(compiled, { ...authored, prompt }));
}

async function compileDirect(req, res, userId) {
	const rl = await limits.motionCompile(userId || clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
	if (!body || typeof body !== 'object') return error(res, 400, 'invalid_body', 'Send a JSON object with a score.');

	const check = validateScore(body.score);
	if (!check.ok) {
		return error(res, 400, 'invalid_score', check.error.message, { path: check.error.path });
	}

	const options = readOptions(new URLSearchParams(), body);
	const compiled = compileScore(body.score, { ...options, name: body.name });
	return json(res, 200, respond(compiled, { lane: 'direct', matched: null, provider: null, model: null, note: null, prompt: null }));
}

function readOptions(params, body = {}) {
	const flag = (name, fallback) => {
		if (body[name] != null) return body[name] !== false;
		const raw = params.get(name.toLowerCase());
		if (raw == null) return fallback;
		return raw !== '0' && raw !== 'false';
	};
	return {
		loop: flag('loop', false),
		idle: flag('idle', true),
		rootMotion: flag('rootMotion', true),
		fingers: flag('fingers', true),
		effort: body.effort ?? params.get('effort') ?? undefined,
	};
}

function respond(compiled, authored) {
	return {
		clip: compiled.clip,
		score: compiled.score,
		summary: describeScore(compiled.score),
		duration: compiled.clip.duration,
		tracks: compiled.clip.tracks.length,
		warnings: compiled.warnings,
		source: {
			lane: authored.lane,
			matched: authored.matched,
			provider: authored.provider,
			model: authored.model,
			note: authored.note,
		},
		prompt: authored.prompt ?? null,
	};
}
