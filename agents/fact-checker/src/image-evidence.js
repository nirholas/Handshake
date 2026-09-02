// Image evidence for the fact-checker (Consumer 2 of the shared vision helper).
//
// A claim often comes with an image: a screenshot of a chart, a photo of a
// label, a meme stating a "fact". The text-only pipeline can't see it. This
// module asks a free NIM vision lane to (a) describe the image, (b) transcribe
// any visible text, and (c) judge the image's stance toward the claim — then
// returns a source-shaped object that folds straight into the existing weighted
// verdict (computeVerdict in api/x402/fact-check.js) alongside web sources.
//
// FAIL-OPEN: if vision is unconfigured, errors, times out, or returns
// unparseable junk, imageEvidence() returns null and the fact check proceeds on
// web sources alone. An image attachment must never break a claim check.

import { describeImageJson, visionConfigured } from '../../../api/_lib/vision.js';

const TIMEOUT_MS = 20_000;
// User-submitted evidence — informative but not an authoritative third party, so
// it sits between a low-authority and a mainstream web source in the weighting.
const IMAGE_SOURCE_WEIGHT = 0.6;

const STANCES = new Set(['supports', 'contradicts', 'neutral']);

function buildPrompt(claim) {
	return (
		'You are the image-evidence analyst for a fact checker. A user submitted this image ' +
		`alongside the claim:\n\n"${claim}"\n\n` +
		'Examine the image and reply ONLY with compact JSON, no prose, in exactly this shape:\n' +
		'{"description":"<one sentence describing what the image shows>",' +
		'"visible_text":"<any text legible in the image, verbatim; empty string if none>",' +
		'"stance":"supports"|"contradicts"|"neutral",' +
		'"reason":"<one short clause: how the image relates to the claim>"}\n\n' +
		'stance = supports if the image is genuine evidence FOR the claim, contradicts if it ' +
		'is evidence AGAINST it, neutral if it is unrelated, ambiguous, or clearly manipulated. ' +
		'Do not speculate beyond what is visibly in the image.'
	);
}

// Analyze a claim's attached image. Returns a source object compatible with the
// fact-check verdict, or null on any degraded path.
//
//   { url, title, excerpt, stance, weight, retrievedAt, kind:'image',
//     description, visibleText, reason, provider }
//
// `track` is optional spend-ledger attribution passed to the vision helper.
export async function imageEvidence(claim, imageUrl, { track = null, now = () => new Date() } = {}) {
	if (!imageUrl || !visionConfigured()) return null;

	let result;
	try {
		result = await describeImageJson({
			prompt: buildPrompt(claim),
			imageUrl,
			maxTokens: 220,
			timeoutMs: TIMEOUT_MS,
			track: { tool: 'fact-check.image', ...(track || {}) },
		});
	} catch {
		return null; // outage / timeout / unparseable — proceed without the image.
	}

	const j = result.json;
	if (!j || typeof j !== 'object') return null;

	const stance = STANCES.has(j.stance) ? j.stance : 'neutral';
	const description = clip(j.description, 280);
	const visibleText = clip(j.visible_text, 280);
	const reason = clip(j.reason, 200);

	// The excerpt the verdict layer shows: the description plus any transcribed
	// text, since that text is often the substance of the "fact".
	const excerptParts = [];
	if (description) excerptParts.push(description);
	if (visibleText) excerptParts.push(`Text in image: "${visibleText}"`);
	const excerpt = excerptParts.join(' ').slice(0, 480) || 'Submitted image (no description available).';

	return {
		url: imageUrl,
		title: 'Submitted image evidence',
		excerpt,
		stance,
		weight: IMAGE_SOURCE_WEIGHT,
		retrievedAt: now().toISOString(),
		kind: 'image',
		description: description || null,
		visibleText: visibleText || null,
		reason: reason || null,
		provider: result.provider,
	};
}

function clip(s, max) {
	const t = String(s ?? '').trim();
	return t.length > max ? t.slice(0, max) : t;
}
