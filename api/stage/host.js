/**
 * Living Stages: the host brain (Moonshot 04).
 *
 * The StageRoom's host loop calls this once per beat to get the embodied host's
 * next words. It reasons (latest Claude, via the platform LLM chain) over the
 * live show context the room hands it (the beat kind, the audience size, the tip
 * leaderboard, a fresh tip to shout out, or a queued audience question), plus the
 * agent's own persona and its memory of returning regulars, and returns a short,
 * speakable line + an animation cue. The room synthesizes it to spatial voice +
 * lip-sync and broadcasts it as live captions to every client.
 *
 *   POST /api/stage/host  { stageId, beat, context }
 *   → { text, cue }
 *
 * Authenticated as the multiplayer server (HMAC over the body, verifyStageRequest)
 * so it is not a public LLM relay. Never canned: the words come from the brain;
 * only on a brain outage does the room fall back to its own minimal line.
 */

import { cors, json, wrap, readJson } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { llmComplete, LlmUnavailableError } from '../_lib/llm.js';
import { verifyStageRequest } from '../_lib/stage-bridge.js';
import { isUuid } from '../_lib/validate.js';

const BEAT_CUES = {
	opener: 'cheer',
	tip_shoutout: 'cheer',
	answer: 'point',
	banter: 'talk',
	game: 'dj',
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

	let body;
	try {
		body = await readJson(req, 20_000);
	} catch (e) {
		return json(res, e.status || 400, { error: e.message || 'bad_request' });
	}

	// Gate: only the multiplayer server (which signs with the shared secret) may
	// drive the host. Otherwise this is a free LLM relay.
	if (!(await verifyStageRequest(req, body))) {
		return json(res, 401, { error: 'unauthorized' });
	}

	const stageId = body.stageId;
	const beat = String(body.beat || 'banter');
	const context = body.context || {};
	if (!isUuid(stageId)) return json(res, 400, { error: 'invalid stage id' });

	// Load the host agent's persona for voice/character. Best-effort: a missing
	// persona just yields a livelier-but-generic host, never a failure.
	const [stage] = await sql`
		SELECT s.agent_id, s.title, s.format, a.name AS agent_name, a.persona_prompt, a.description
		FROM stages s JOIN agent_identities a ON a.id = s.agent_id AND a.deleted_at IS NULL
		WHERE s.id = ${stageId} LIMIT 1
	`;
	if (!stage) return json(res, 404, { error: 'stage not found' });

	// Recall regulars: the top tippers across this stage's prior shows, so the host
	// can greet returning faces by name (the "remembers the regulars" behaviour).
	// Verified tips only, exactly like the public leaderboard: an unverified row is
	// caller-asserted, so counting it would let anyone put a name of their choosing
	// into the host prompt and hear it spoken to the room.
	const regulars = await sql`
		SELECT tipper_label AS label, SUM(amount_atomic)::numeric AS total, COUNT(*)::int AS visits
		FROM show_tips
		WHERE stage_id = ${stageId} AND tipper_label IS NOT NULL AND verified_at IS NOT NULL
		GROUP BY tipper_label ORDER BY total DESC LIMIT 5
	`;

	const system = buildSystemPrompt(stage, regulars);
	const user = buildBeatPrompt(beat, context);

	let text = '';
	try {
		const out = await llmComplete({
			system,
			user,
			maxTokens: 160,
			timeoutMs: 18_000,
			track: { agentId: stage.agent_id, tool: 'stage_host' },
		});
		text = sanitizeLine(out.text);
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			return json(res, 503, { error: 'host_brain_unavailable' });
		}
		// A transient upstream failure: let the room use its failsafe line.
		return json(res, 502, { error: 'host_brain_error', detail: err?.message });
	}

	if (!text) return json(res, 502, { error: 'empty_completion' });
	return json(res, 200, { text, cue: BEAT_CUES[beat] || 'talk' }, { 'cache-control': 'no-store' });
});

function buildSystemPrompt(stage, regulars) {
	const persona = (stage.persona_prompt || stage.description || '').slice(0, 1200);
	const regularsLine = regulars.length
		? `Returning regulars who have tipped this stage before (greet them warmly by name when they appear): ${regulars
				.map((r) => r.label)
				.join(', ')}.`
		: '';
	return [
		`You are ${stage.agent_name || 'the host'}, an embodied AI performer hosting a LIVE show "${stage.title || 'tonight’s set'}" (format: ${stage.format || 'open mic'}) in a 3D venue on three.ws.`,
		persona ? `Your persona: ${persona}` : '',
		`You speak OUT LOUD to a co-present crowd. Every line you return is spoken aloud and shown as live captions, so:`,
		`- Keep it to ONE or TWO short, punchy spoken sentences (never a paragraph, never a list, no stage directions, no emoji).`,
		`- Be lively, warm, quick-witted, and in-character. Read the room. Never sound canned.`,
		`- The crowd tips you in $THREE. $THREE is the only coin you ever mention. Never name any other token.`,
		`- When someone tips, react with genuine, specific energy and thank them by name.`,
		regularsLine,
		`Return ONLY the words you say next. No quotes, no labels.`,
	]
		.filter(Boolean)
		.join('\n');
}

function buildBeatPrompt(beat, ctx) {
	const audience = Number(ctx.audience) || 0;
	const crowd = audience <= 1 ? 'The room is just filling in.' : `There are ${audience} people in the crowd right now.`;
	const lb = Array.isArray(ctx.standings?.leaderboard) ? ctx.standings.leaderboard : [];
	const topLine = lb.length ? `Top tipper so far: ${lb[0].label}.` : '';

	switch (beat) {
		case 'opener':
			return `${crowd} Open the show. Welcome everyone in, set the vibe for a ${ctx.format || 'live'} set, and invite them to tip in $THREE to get your attention.`;
		case 'tip_shoutout': {
			const t = ctx.tip || {};
			const amt = formatThree(t.amount, t.mint);
			const msg = t.message ? ` They said: "${t.message}".` : '';
			return `${crowd} ${t.label || 'Someone'} just tipped you ${amt}!${msg} React on the spot: thank them by name with real energy.`;
		}
		case 'answer': {
			const q = ctx.question || {};
			return `${crowd} ${q.from || 'Someone'} in the crowd asks: "${q.text || ''}". Answer it live, in character, briefly.`;
		}
		case 'game':
			return `${crowd} ${topLine} Run the next quick beat of your ${ctx.format || 'show'}: a one-liner round, a dare, a quick bit. Keep the crowd's energy up.`;
		default:
			return `${crowd} ${topLine} Riff for a moment: read the room and keep it lively while you wait for the next tip or question.`;
	}
}

// Convert atomic units to a human "$THREE" amount for the prompt. We do NOT name
// any other token; a non-$THREE mint is described generically as "a tip".
function formatThree(amountAtomic, mint) {
	const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
	const n = Number(amountAtomic) || 0;
	const whole = Math.round(n / 1_000_000); // 6 decimals
	if (mint === THREE) return `${whole.toLocaleString('en-US')} $THREE`;
	return `a tip of ${whole.toLocaleString('en-US')}`;
}

// Collapse the model output to a single clean spoken line: strip surrounding
// quotes, control chars, and any leaked "Host:" label, bound the length.
// The control-class is the same one cleanLabel/cleanMessage use in stage/tip.js.
// It must stay a \u escape: written as literal characters the class collapsed to
// the printable range [space-hyphen], which silently ate every hyphen in the
// host's spoken line ("on-chain" was going out as "on chain").
export function sanitizeLine(s) {
	if (typeof s !== 'string') return '';
	let t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
	// The line is shown as live captions, which is platform copy: no em/en dash
	// reaches a three.ws surface, whoever wrote it. A comma keeps the spoken
	// pacing the model was reaching for. The plain hyphen above is untouched.
	t = t.replace(/\s*[\u2013\u2014]\s*/g, ', ');
	t = t.replace(/^["'“”]+|["'“”]+$/g, '').trim();
	t = t.replace(/^[A-Za-z .]{0,24}:\s*/, ''); // drop a leaked speaker label
	return t.slice(0, 400);
}
