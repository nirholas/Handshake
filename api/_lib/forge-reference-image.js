// Reference-image builder for the text→3D forge (NEW, additive lane).
//
// ── Why this module exists ───────────────────────────────────────────────────
// The text→3D pipeline is: user prompt → prompt director rewrite → a reference
// IMAGE is generated → TRELLIS/Hunyuan3D reconstructs a textured GLB from that
// image. The realism of the final mesh is set almost entirely by the realism of
// that one reference image: a photoreal, single-subject, plain-seamless-
// background, evenly-lit image reconstructs into a real-looking mesh; a
// cartoonish or cluttered one does not.
//
// This module generates that reference image on the Vertex Gemini 2.5 Flash
// Image lane (GCP-credit funded, owner-approved spend), tuned specifically to
// produce the IDEAL reconstruction input:
//   - a single centered subject on a plain seamless studio background,
//   - soft even shadowless lighting,
//   - real-world materials and surface micro-detail (the photoreal look),
//   - the directed prompt's positive cues PLUS the director's negative prompt
//     folded in as explicit natural-language avoidance (Gemini honors "Do not
//     include: …" reliably; generateContent has no negative_prompt parameter),
//   - the highest resolution the model tier serves (imageConfig.imageSize "2K").
//
// It is ADDITIVE and never a gate: if the Vertex lane is unconfigured or fails
// for any reason, it falls through to the existing reference-image provider
// (api/_mcp3d/text-to-image.js - NIM FLUX free lane, Vertex Imagen, Replicate
// backstop), so nothing regresses relative to today's behavior.
//
// ── Router seam ──────────────────────────────────────────────────────────────
// api/forge.js currently synthesizes the text→3D reference view at ~line 1557:
//
//     const synthesized = await textToImage(directedPrompt, {
//       aspectRatio: aspect,
//       skipNim: nimGatewayDegraded,
//       seed: opts.seed ?? undefined,
//     });
//
// The router agent (which owns forge.js) can drop this module in as a direct
// replacement - the return shape { imageUrl, model } is identical, so nothing
// else in that function changes:
//
//     import { generateReferenceImage } from './_lib/forge-reference-image.js';
//     const synthesized = await generateReferenceImage(directedPrompt, {
//       aspectRatio: aspect,
//       skipNim: nimGatewayDegraded,
//       seed: opts.seed ?? undefined,
//       negativePrompt: directorNegativePrompt, // optional; auto-derived if omitted
//     });
//
// `negativePrompt` is optional: when omitted, a subject-aware default is derived
// from the prompt via subjectNegativePrompt() (the same assembly the
// /api/forge-enhance response uses), so the router gets subject-aware negatives
// for free without having to run the enhance endpoint first.
//
// Output: { imageUrl, model, lane } where imageUrl is a durable public https URL
// (persisted to R2, same as textToImage), model is a provider/model label, and
// lane is 'vertex-reference' or the fallthrough provider's own label.

import { createHash } from 'node:crypto';
import { getGcpAccessToken } from './gcp-auth.js';
import { putObject, publicUrl } from './r2.js';
import { subjectNegativePrompt } from '../forge-enhance.js';
import { isProviderRefusal } from './ai-image-lanes.js';
import { textToImage } from '../_mcp3d/text-to-image.js';
import { parseJsonLoose } from './vision.js';
import { getRedis } from './redis.js';

// Reference-set cache: the SAME enhanced prompt (already director-rewritten,
// so two users typing differently-worded ideas that converge on one directed
// spec both benefit) within 24h reuses its generated reference image set
// instead of re-spending a Vertex image (and QA-scoring) call. Keyed on a hash
// of everything that changes the output — prompt, aspect, negatives — mirroring
// the content-addressing idiom in forge-cache.js. Fail-open in every direction:
// no Redis, or any command error, degrades to "miss", never blocking generation.
const REF_CACHE_PREFIX = 'fr:ref:';
const REF_CACHE_TTL_S = Math.max(0, Number(process.env.FORGE_REFERENCE_CACHE_TTL_S) || 24 * 3600);

function referenceCacheKey(prompt, { aspectRatio, negativePrompt }) {
	const text = String(prompt || '').trim().toLowerCase();
	if (!text) return null;
	const basis = JSON.stringify([text, aspectRatio || '1:1', String(negativePrompt || '').trim().toLowerCase()]);
	return createHash('sha256').update(basis).digest('hex').slice(0, 40);
}

function referenceCacheEnabled() {
	if (/^(0|false|off|no)$/i.test(String(process.env.FORGE_REFERENCE_CACHE ?? '').trim())) return false;
	return Boolean(getRedis());
}

async function getCachedReference(key) {
	const r = getRedis();
	if (!r || !key || !referenceCacheEnabled()) return null;
	try {
		const raw = await r.get(`${REF_CACHE_PREFIX}${key}`);
		if (!raw) return null;
		const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return value && typeof value.imageUrl === 'string' && value.imageUrl ? value : null;
	} catch {
		return null;
	}
}

async function putCachedReference(key, value) {
	const r = getRedis();
	if (!r || !key || !referenceCacheEnabled()) return;
	if (!value?.imageUrl) return;
	try {
		await r.set(`${REF_CACHE_PREFIX}${key}`, JSON.stringify(value), { ex: REF_CACHE_TTL_S });
	} catch {
		/* best-effort */
	}
}

// Gemini image model on Vertex ("Nano Banana"): live, credit-billed, uses the
// :generateContent shape. Overridable without a code change.
const DEFAULT_MODEL = process.env.VERTEX_IMAGEN_MODEL || 'gemini-2.5-flash-image';
// The Gemini image lane is served on the un-prefixed global host by default; a
// regional value ('us-central1') uses the region-prefixed host. Both verified
// live 2026-07-16. Separate from the text lanes so the image lane can be pinned
// independently.
const DEFAULT_LOCATION =
	process.env.GOOGLE_CLOUD_LOCATION_IMAGE ||
	process.env.VERTEX_IMAGEN_LOCATION ||
	process.env.GOOGLE_CLOUD_LOCATION ||
	'global';
// Request the highest resolution the model tier serves. "2K" is accepted today
// and currently renders at 1024px on this project's tier (harmless, and it
// upgrades automatically when the tier serves true 2K). Force 1K with
// VERTEX_IMAGE_SIZE=1K if a deployment wants the smaller/faster output.
const DEFAULT_IMAGE_SIZE = process.env.VERTEX_IMAGE_SIZE || '2K';

// Aspect ratios Gemini image generation accepts via generationConfig.imageConfig.
const GEMINI_ASPECTS = new Set([
	'1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
]);

// Match the private gate in text-to-image.js / ai-image-lanes.js: the Vertex
// image lane is active when GOOGLE_CLOUD_PROJECT is set unless VERTEX_IMAGEN_ENABLED
// explicitly disables it.
function vertexImageEnabled() {
	if (!process.env.GOOGLE_CLOUD_PROJECT) return false;
	const raw = process.env.VERTEX_IMAGEN_ENABLED;
	if (raw == null) return true;
	return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function aiplatformHost(location) {
	return location === 'global'
		? 'https://aiplatform.googleapis.com'
		: `https://${location}-aiplatform.googleapis.com`;
}

// Wrap the directed prompt into a reference-image instruction that pins the
// exact composition a reconstructor needs: one centered subject, plain seamless
// studio sweep, soft even shadowless light, photoreal real-world materials, and
// the negative prompt as explicit avoidance. This is the difference between
// "draw the thing" and "shoot the thing the way a photogrammetry rig needs it".
export function buildReferenceInstruction(prompt, negativePrompt) {
	const subject = String(prompt || '').trim();
	// The instruction never names the downstream use ("for 3D reconstruction"):
	// telling an image model its output feeds a reconstructor measurably nudges it
	// toward a CGI/render aesthetic. It only ever describes the desired LOOK - a
	// real studio photograph - and the composition a reconstructor happens to need.
	const lines = [
		'A single photorealistic studio photograph of the following subject, shot on a professional camera.',
		`Subject: ${subject}.`,
		'Composition: exactly one subject, centered and fully in frame, filling most of the frame, ' +
			'shot straight-on at eye level like a product or portrait catalog photo.',
		'Background: a plain, seamless, uncluttered light-grey studio sweep with nothing else in the scene.',
		'Lighting: soft, even, neutral studio lighting with no harsh shadows and no colored gels, so the ' +
			'subject is evenly lit from all sides.',
		'Look: this must read as a genuine photograph taken with a real camera, with true-to-life ' +
			'materials, natural surface micro-detail (grain, weave, pores, wear, brush marks), real depth ' +
			'of field and sharp focus. Absolutely not a 3D render, not CGI, not an illustration, not a cartoon.',
	];
	if (negativePrompt && String(negativePrompt).trim()) {
		lines.push(`Do NOT include: ${String(negativePrompt).trim()}.`);
	}
	return lines.join(' ');
}

// Persist a base64 image to R2 and return a durable public https URL. The 3D
// backends take URLs (Replicate caps inline data URIs at ~256 KB), so neither
// the Vertex inline data nor a NIM artifact can be forwarded as-is. Format is
// sniffed from the magic bytes so the key extension and Content-Type match the
// real payload (Gemini image returns PNG; sniff keeps it correct if that changes).
async function persistImageBase64(b64) {
	const body = Buffer.from(b64, 'base64');
	const isJpeg = body.length > 2 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
	const ext = isJpeg ? 'jpg' : 'png';
	const key = `forge/refs/${globalThis.crypto.randomUUID()}.${ext}`;
	await putObject({ key, body, contentType: isJpeg ? 'image/jpeg' : 'image/png' });
	return publicUrl(key);
}

// One Vertex Gemini image generation. Returns { b64, mime } on success; throws a
// designed error on any failure so the caller can fall through. Retries once
// without imageConfig.imageSize if the tier rejects that field (defensive: the
// field is accepted today, but a tier change must degrade to a valid request
// rather than a hard failure that skips the whole Vertex lane).
async function generateViaVertex({ instruction, aspectRatio }) {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	const location = DEFAULT_LOCATION;
	const model = DEFAULT_MODEL;
	const aspect = GEMINI_ASPECTS.has(aspectRatio) ? aspectRatio : '1:1';
	const endpoint =
		`${aiplatformHost(location)}/v1/projects/${project}` +
		`/locations/${location}/publishers/google/models/${model}:generateContent`;
	const token = await getGcpAccessToken();

	const request = async (withSize) => {
		const imageConfig = withSize
			? { aspectRatio: aspect, imageSize: DEFAULT_IMAGE_SIZE }
			: { aspectRatio: aspect };
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				contents: [{ role: 'user', parts: [{ text: instruction }] }],
				generationConfig: { responseModalities: ['IMAGE'], imageConfig },
			}),
			signal: AbortSignal.timeout(60_000),
		});
		return res;
	};

	const attempt = async () => {
		let res = await request(true);
		if (res.status === 400) {
			// Peek at the error: only retry-without-size when it is specifically about
			// imageConfig/imageSize, so a genuine bad request still fails fast.
			const detail = await res.text().catch(() => '');
			if (/imageSize|imageConfig/i.test(detail)) {
				res = await request(false);
			} else {
				throw Object.assign(new Error(`Vertex reference image 400: ${detail.slice(0, 200)}`), {
					providerStatus: 400,
				});
			}
		}
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			const err = Object.assign(
				new Error(`Vertex reference image returned ${res.status}: ${detail.slice(0, 200)}`),
				{ providerStatus: res.status },
			);
			if (res.status === 429) err.code = 'rate_limited';
			throw err;
		}
		const data = await res.json();
		const parts = data?.candidates?.[0]?.content?.parts || [];
		const imgPart = parts.find((p) => p?.inlineData?.data);
		const b64 = imgPart?.inlineData?.data;
		if (!b64) {
			const reason = data?.candidates?.[0]?.finishReason;
			throw new Error(`Vertex reference image produced no image${reason ? ` (finishReason: ${reason})` : ''}`);
		}
		return { b64, mime: imgPart.inlineData.mimeType || 'image/png', model: `vertex-ai/${model}` };
	};

	try {
		return await attempt();
	} catch (err) {
		// A no-image response with a transient finishReason (NO_IMAGE, OTHER, but not
		// the refusal classes) is a known Gemini flake worth exactly one re-roll:
		// falling through to the generic text→image ladder loses the art-directed
		// instruction, the negatives, and the QA gate, which is a far worse image
		// than a second attempt at this lane. Refusals and HTTP errors re-throw
		// unchanged so genuine blocks and outages still fail fast.
		const noImage = /produced no image/i.test(String(err?.message || ''));
		if (!noImage || isProviderRefusal(err)) throw err;
		return await attempt();
	}
}

// ── Reference-image QA gate ──────────────────────────────────────────────────
// GPU reconstruction time (self-host TRELLIS/Hunyuan3D, or a paid vendor) is
// far more expensive than one more Gemini vision call, so before handing a
// reference off to the mesh step we score it with a cheap Vertex flash vision
// pass: is the subject complete, centered, photorealistic, and the background
// clean? A single retry with corrective feedback folded into the instruction
// gets a second roll; whichever scored higher ships (best-of-2), never a hard
// gate — any scoring failure just ships the first image unscored.
const QA_PASS_SCORE = Number(process.env.FORGE_REFERENCE_QA_PASS_SCORE) || 70;
const QA_MODEL = process.env.VERTEX_QUALITY_MODEL || 'gemini-2.5-flash';

function qaRubric(prompt) {
	return [
		'You are a quality inspector for a text-to-3D pipeline. You are shown ONE reference image that will be ' +
			'reconstructed into a 3D mesh — its quality directly determines the mesh quality.',
		prompt ? `It was generated for this subject: "${String(prompt).slice(0, 300)}".` : '',
		'Judge four things: (1) is exactly ONE subject present, fully in frame, not cropped or cut off; ' +
			'(2) is it centered; (3) does it read as a real photograph (not a cartoon, illustration, or CG render); ' +
			'(4) is the background a plain, clean, uncluttered studio sweep with nothing else in the scene.',
		'Reply with ONLY this JSON object, nothing else:',
		'{"score": <int 0-100 overall>, "complete": <bool>, "centered": <bool>, "photoreal": <bool>, ' +
			'"clean_background": <bool>, "issue": "<one short phrase naming the main problem, or empty string>"}',
	].filter(Boolean).join(' ');
}

// Score one generated reference image via the same Vertex Gemini vision lane.
// Returns a normalized verdict or null on any failure (fail-open: the caller
// ships the image unscored rather than blocking on a QA outage).
async function scoreReferenceImage({ b64, mime, prompt }) {
	try {
		const project = process.env.GOOGLE_CLOUD_PROJECT;
		if (!project) return null;
		const location = process.env.GOOGLE_CLOUD_LOCATION_QUALITY || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
		const token = await getGcpAccessToken();
		const host = location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
		const endpoint = `${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${QA_MODEL}:generateContent`;
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				contents: [{ role: 'user', parts: [{ text: qaRubric(prompt) }, { inlineData: { mimeType: mime, data: b64 } }] }],
				generationConfig: {
					temperature: 0,
					responseMimeType: 'application/json',
					maxOutputTokens: 300,
					thinkingConfig: { thinkingBudget: 0 },
				},
			}),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return null;
		const data = await res.json();
		const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join('').trim();
		if (!text) return null;
		const raw = parseJsonLoose(text);
		const score = Number(raw?.score);
		if (!Number.isFinite(score)) return null;
		return {
			score: Math.max(0, Math.min(100, Math.round(score))),
			complete: raw?.complete !== false,
			centered: raw?.centered !== false,
			photoreal: raw?.photoreal !== false,
			cleanBackground: raw?.clean_background !== false,
			issue: typeof raw?.issue === 'string' ? raw.issue.slice(0, 160) : '',
		};
	} catch (err) {
		console.warn(`[forge-reference-image] QA scoring failed, shipping unscored: ${err?.message}`);
		return null;
	}
}

// Generate the reconstruction reference image for a directed text→3D prompt.
//
//   generateReferenceImage(directedPrompt, {
//     aspectRatio = '1:1',    // Gemini aspect; unknown values → '1:1'
//     negativePrompt = null,  // director negatives; auto-derived from the prompt if omitted
//     seed,                   // honored only on the fallthrough lanes (Gemini image has no seed)
//     skipNim = false,        // forwarded to the fallthrough textToImage lane
//   })
//
// Vertex-first (high-res, reference-tuned), then automatic fallthrough to the
// existing provider chain. Returns { imageUrl, model, lane }. Never throws for a
// recoverable Vertex issue - only the fallthrough's terminal error surfaces when
// every lane is exhausted, exactly as textToImage does today.
export async function generateReferenceImage(
	prompt,
	{ aspectRatio = '1:1', negativePrompt = null, seed, skipNim = false } = {},
) {
	const negatives =
		negativePrompt && String(negativePrompt).trim()
			? String(negativePrompt).trim()
			: subjectNegativePrompt(prompt, { realistic: true });

	// Same directed prompt (+aspect +negatives) within 24h reuses its reference
	// set instead of re-spending a Vertex image generation + QA-scoring pass.
	// Credits are approved, but latency is a UX cost this avoids for free.
	const cacheKey = referenceCacheKey(prompt, { aspectRatio, negativePrompt: negatives });
	const cached = await getCachedReference(cacheKey);
	if (cached) {
		console.log(`[forge-reference-image] cache hit (24h) for key ${cacheKey}`);
		return { ...cached, lane: 'vertex-reference-cached' };
	}

	if (vertexImageEnabled()) {
		try {
			const instruction = buildReferenceInstruction(prompt, negatives);
			let generated = await generateViaVertex({ instruction, aspectRatio });
			let verdict = await scoreReferenceImage({ b64: generated.b64, mime: generated.mime, prompt });

			// One retry with corrective feedback on a scoring failure: fold the
			// vision model's own named issue into the instruction as an explicit
			// "the previous attempt failed on X, fix it" line, then keep whichever
			// of the two attempts scored higher (best-of-2). GPU reconstruction
			// time dwarfs the cost of one extra vision call, so this is cheap
			// insurance against a bad reference wasting the expensive step downstream.
			if (verdict && verdict.score < QA_PASS_SCORE) {
				const issue = verdict.issue || 'the subject was incomplete, off-center, not photoreal, or the background was cluttered';
				const retryInstruction = `${instruction} IMPORTANT: a previous attempt at this shot failed on: ${issue}. Fix that specifically this time.`;
				try {
					const retried = await generateViaVertex({ instruction: retryInstruction, aspectRatio });
					const retryVerdict = await scoreReferenceImage({ b64: retried.b64, mime: retried.mime, prompt });
					if (!verdict || (retryVerdict && retryVerdict.score > verdict.score)) {
						generated = retried;
						verdict = retryVerdict;
					}
				} catch (err) {
					console.warn(`[forge-reference-image] QA retry generation failed, keeping first attempt: ${err?.message}`);
				}
			}

			if (verdict) {
				console.log(
					`[forge-reference-image] qa score=${verdict.score} complete=${verdict.complete} ` +
						`centered=${verdict.centered} photoreal=${verdict.photoreal} clean_bg=${verdict.cleanBackground}` +
						(verdict.issue ? ` issue="${verdict.issue}"` : ''),
				);
			}

			const imageUrl = await persistImageBase64(generated.b64);
			console.log(`[forge-reference-image] served by ${generated.model} (vertex-reference lane)`);
			const result = { imageUrl, model: generated.model, qaScore: verdict?.score ?? null };
			await putCachedReference(cacheKey, result);
			return { ...result, lane: 'vertex-reference' };
		} catch (err) {
			// Any Vertex failure (unconfigured token, safety block, throttle, tier
			// change) degrades to the existing chain - the reference image still gets
			// made, just on the prior path. Warn, don't error.
			console.warn(`[forge-reference-image] vertex lane failed, falling through: ${err?.message}`);
		}
	}

	// Fallthrough: the current reference-image provider (NIM FLUX free → Vertex
	// Imagen → Replicate). Same call the router makes today, so this can only ever
	// add the Vertex-reference lane in front, never remove a path.
	const served = await textToImage(prompt, { aspectRatio, skipNim, seed });
	return { ...served, lane: served.lane || (served.predictionId ? 'replicate' : 'fallthrough') };
}
