// POST /api/persona/interview
//
// The onboarding interview behind the create-agent wizard's personality step.
// A person answers up to seven short questions in their own words (every one of
// them optional) and gets back a real, structured persona: a base paragraph, the
// personality trait values, tone tags, characteristic vocabulary, and the exact
// compiled system prompt the agent will run on.
//
// Two properties make this endpoint worth its own route rather than reusing the
// per-agent extractor (api/agents/[id]/persona/extract):
//
//   1. It is STATELESS and works before the agent exists. The wizard only
//      requires an account at the final "ship it" step, so the interview has to
//      run for a signed-out visitor with no agent id to write to. The wizard
//      holds the result in its draft and persists it through
//      POST /api/agents/:id/persona/save the moment the agent is created.
//   2. It compiles with the SAME compiler the server uses on save
//      (src/agents/persona-compile.js), so the prompt previewed in the wizard is
//      byte-for-byte the prompt that ends up signed on the agent.
//
// Extraction itself lives in api/_lib/persona-interview-extract.js and is shared
// with the per-agent re-run, so there is one prompt and one output contract.
// Anonymous callers carry a tight per-IP budget, mirroring
// /api/agents/suggest-spec.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { extractPersonaFromInterview } from '../_lib/persona-interview-extract.js';
import { compilePersona } from '../../src/agents/persona-compile.js';
import {
	normalizeInterview,
	hasInterviewSignal,
	MAX_ANSWER_CHARS,
} from '../../src/agents/persona-interview.js';

const clampStr = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	// Try-first, exactly like /api/agents/suggest-spec: the wizard runs the whole
	// build signed-out and only asks for an account at the ship step, so auth is
	// resolved but never required. Anonymous callers get the tighter budget.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;

	const ip = clientIp(req);
	const rl = userId ? await limits.personaInterview(ip) : await limits.personaInterviewAnon(ip);
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => ({}));
	const name = clampStr(body?.name, 80);
	const description = clampStr(body?.description, 240);
	const greeting = clampStr(body?.greeting, 200);
	const answers = normalizeInterview(body?.answers);

	if (!hasInterviewSignal(answers)) {
		return error(res, 400, 'validation_error',
			`Answer at least one question (${MAX_ANSWER_CHARS} characters max each), or skip the interview.`);
	}

	let persona;
	try {
		persona = await extractPersonaFromInterview({
			name,
			description,
			greeting,
			answers,
			userId,
			tool: 'persona_interview',
		});
	} catch (err) {
		return error(res, err.status || 502, err.code || 'extraction_failed', err.message);
	}

	return json(res, 200, {
		base: persona.base,
		traits: persona.traits,
		tone_tags: persona.toneTags,
		vocabulary: persona.vocabulary,
		persona_prompt: compilePersona({
			name,
			description,
			base: persona.base,
			traits: persona.traits,
			toneTags: persona.toneTags,
			vocabulary: persona.vocabulary,
		}),
		questions_answered: answers.length,
		interview: answers,
		provider: persona.provider,
	});
});
