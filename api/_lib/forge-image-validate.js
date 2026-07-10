// Forge image→3D input validation (Consumer 1 of the shared vision helper).
//
// An image→3D generation is expensive — it burns a rate-limited slot and, on
// some backends, real credits. A photo that can't be reconstructed (a screenshot
// of text, a cluttered scene with no single subject, a near-black blur) wastes
// that slot and hands the user a garbage mesh. So before submit we ask a free
// NIM vision lane one question: is this a usable single-subject reference?
//
// FAIL-OPEN IS THE CONTRACT. This is a guardrail, never a gate on the platform's
// availability: if vision is unconfigured, times out, errors, or returns
// unparseable junk, validateForgeImage returns { ok: true } and generation
// proceeds exactly as it did before this check existed. A vision outage must
// never block a paying user's generation (CLAUDE.md: never block on an outage).

import { describeImageJson, visionConfigured } from './vision.js';

// Tight budget — this sits in front of an interactive submit. ~1–2 s is typical
// (probes/vision.md); 12 s is a generous ceiling before we fail open.
const VALIDATION_TIMEOUT_MS = 12_000;

const PROMPT =
	'You are the input checker for a photo→3D model generator. The user uploaded this ' +
	'image as the reference to reconstruct into a 3D object. Judge ONLY whether it is a ' +
	'usable reference: it should show ONE clear physical subject (an object, character, ' +
	'creature, or person) that could plausibly be turned into a 3D model.\n\n' +
	'Reply ONLY with compact JSON, no prose, in exactly this shape:\n' +
	'{"usable":true|false,"subject":"<2-5 word description of the main subject, or empty>",' +
	'"issue":"none"|"text_screenshot"|"multiple_subjects"|"no_clear_subject"|"too_dark_or_blurry"|"abstract_or_diagram"}\n\n' +
	'Mark usable=false ONLY when the image is genuinely unsuitable: a screenshot of text/UI ' +
	'(text_screenshot), a busy scene with no single dominant subject (multiple_subjects), ' +
	'no recognizable object at all (no_clear_subject), too dark/blurry to make out ' +
	'(too_dark_or_blurry), or an abstract pattern/chart/diagram (abstract_or_diagram). ' +
	'When in doubt, mark usable=true. A borderline photo still reconstructs.';

// Designed, actionable copy per failure reason. Each tells the user what is wrong
// AND how to fix it — never a bare "invalid image".
const ISSUE_MESSAGES = {
	text_screenshot:
		'That looks like a screenshot of text or an interface, not a photo of an object. ' +
		'Upload a clear picture of the single thing you want to turn into a 3D model.',
	multiple_subjects:
		'That image has several things in it with no single clear subject. ' +
		'Crop to one object — or upload a photo where one subject fills most of the frame.',
	no_clear_subject:
		'We couldn’t make out a clear object to reconstruct in that image. ' +
		'Upload a well-lit photo of one distinct subject against a simple background.',
	too_dark_or_blurry:
		'That image is too dark or blurry to reconstruct cleanly. ' +
		'Retake it in good light, hold steady, and keep the subject in focus.',
	abstract_or_diagram:
		'That looks like an abstract pattern, chart, or diagram rather than a physical object. ' +
		'Upload a photo of a real object, character, or creature instead.',
};

const FALLBACK_MESSAGE =
	'That image doesn’t look like a clear photo of a single object. ' +
	'Upload a well-lit picture of one subject for the best 3D result.';

// Validate a single reference image URL before an image→3D submit.
//
// Returns one of:
//   { ok: true,  skipped: 'unconfigured'|'error'|'bad_reply' }  — fail-open: proceed
//   { ok: true,  subject, provider }                            — vision says usable
//   { ok: false, issue, subject, message, provider }            — vision says reject
//
// `track` is optional spend-ledger attribution passed straight to the helper.
export async function validateForgeImage(imageUrl, { track = null } = {}) {
	if (!visionConfigured()) return { ok: true, skipped: 'unconfigured' };

	let result;
	try {
		result = await describeImageJson({
			prompt: PROMPT,
			imageUrl,
			maxTokens: 120,
			timeoutMs: VALIDATION_TIMEOUT_MS,
			track: { tool: 'forge.validate', ...(track || {}) },
		});
	} catch {
		// Outage, timeout, or unparseable reply — fail open, never block generation.
		return { ok: true, skipped: 'error' };
	}

	const j = result.json;
	if (!j || typeof j.usable !== 'boolean') return { ok: true, skipped: 'bad_reply' };

	if (j.usable) {
		return { ok: true, subject: cleanSubject(j.subject), provider: result.provider };
	}

	const issue = ISSUE_MESSAGES[j.issue] ? j.issue : 'no_clear_subject';
	return {
		ok: false,
		issue,
		subject: cleanSubject(j.subject),
		message: ISSUE_MESSAGES[issue] || FALLBACK_MESSAGE,
		provider: result.provider,
	};
}

function cleanSubject(s) {
	const t = String(s || '').trim();
	return t.length > 0 && t.length <= 80 ? t : null;
}
