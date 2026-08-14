// Likeness scoring: turns "does this avatar look like the person in the photos?"
// into a number, for the Phase 1 roadmap gate (README Roadmap: users mint an
// agent of themselves "with >=4/5 likeness score").
//
// The pipeline is deliberately the same shape as the realism bench
// (api/_lib/quality-bench.js): render the finished asset the way a user sees
// it, then score the render. What differs is the judge. The realism bench asks
// a vision LLM for an opinion; this asks a face-recognition model for a
// measurement. An opinion is the right instrument for "does this look real";
// it is the wrong one for identity, where the honest question is the one a
// phone's face unlock asks, and where a 128-d embedding gives a number two runs
// apart can actually be compared on.
//
// Three views, not one. A selfie pipeline that paints a photo onto a template
// head flatters a frontal check: head-on it already looks like the person while
// the skull underneath is still generic. The illusion breaks as the head turns
// (workers/avatar-reconstruction/eval/README.md makes the same point about
// geometry), so the score is taken at three yaws and the spread between them is
// itself a reported finding.
//
// Nothing here fabricates a score. A render that contains no detectable face,
// or a capture set that contains none, produces a status and a null score, not
// a zero: "the model failed to make a face" and "the face scored badly" are
// different findings and a table that conflates them is worse than no table.

import { renderAvatarScene, SCENE_PRESETS } from './avatar-render.js';
import {
	SCORER_VERSION,
	SFACE_SAME_IDENTITY_COSINE,
	cosineSimilarity,
	embedFace,
} from './face-embed.js';

export { SCORER_VERSION, SFACE_SAME_IDENTITY_COSINE };

// Yaw angles, in the renderer's orbit convention (theta degrees around +Y).
//
// `profile` is 65 degrees rather than a true 90. That is a measurement limit,
// not a shortcut: at a full side-on view no face-recognition model of this
// family has anything to work with, because it is trained and aligned on five
// landmarks of which a 90-degree view exposes at most three. 65 degrees is the
// steepest turn that still presents a measurable face, and it is well past the
// point where a frontal-only texture transfer stops covering the head, which is
// exactly the failure this view exists to catch.
export const LIKENESS_VIEWS = [
	{ label: 'head-on', theta: 0 },
	{ label: 'three-quarter', theta: 35 },
	{ label: 'profile', theta: 65 },
];

const RENDER_PHI = 86;
const RENDER_SIZE = 768;
// Solid, mid-grey-blue rather than transparent: the detector sees RGB only, and
// an alpha-cut render composited onto black puts a hard silhouette edge right
// where the jaw contour is, which shifts the landmark fit.
const RENDER_BACKGROUND = '#14151a';

// Cosine similarity is not linear in perceived likeness, so the 1-5 scale is
// anchored on the only two points that carry external meaning, and interpolated
// between them:
//
//   0.000 -> 1  no relationship between the faces
//   0.363 -> 3  OpenCV's published SFace decision boundary: the exact point
//               where the model stops calling this the same person
//   1.000 -> 5  identical embedding
//
// So "4/5" means a cosine of 0.68, roughly twice the same-identity threshold:
// not "arguably the same person" but "confidently the same person". That is the
// bar the roadmap's >=4/5 gate should mean, and it is set by the model's own
// calibration rather than by taste.
export function cosineToScore5(cosine) {
	if (!Number.isFinite(cosine)) return null;
	const c = Math.max(0, Math.min(1, cosine));
	const raw =
		c <= SFACE_SAME_IDENTITY_COSINE
			? 1 + (2 * c) / SFACE_SAME_IDENTITY_COSINE
			: 3 + (2 * (c - SFACE_SAME_IDENTITY_COSINE)) / (1 - SFACE_SAME_IDENTITY_COSINE);
	return Math.round(Math.max(1, Math.min(5, raw)) * 100) / 100;
}

async function fetchImage(url, { maxBytes = 12 * 1024 * 1024 } = {}) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`capture fetch ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > maxBytes) throw new Error(`capture too large: ${buf.length} bytes`);
	return buf;
}

// A capture may arrive as an http(s) URL (an R2 upload, a generated reference
// image) or as an inline data: URI, because avatar_regen_jobs.params.images
// accepts both. Both are decoded here so the caller never has to care.
async function captureBytes(capture) {
	if (Buffer.isBuffer(capture)) return capture;
	const str = String(capture);
	if (str.startsWith('data:')) {
		const comma = str.indexOf(',');
		if (comma < 0) throw new Error('malformed data URI');
		return Buffer.from(str.slice(comma + 1), 'base64');
	}
	return fetchImage(str);
}

// Embed every input capture that contains a findable face. Captures that do not
// are reported by index, never silently dropped: a three-photo capture where
// two failed detection is a much weaker measurement than one where all three
// landed, and the row has to say so.
export async function embedCaptures(captures) {
	const embeddings = [];
	const rejected = [];
	for (let i = 0; i < captures.length; i += 1) {
		try {
			const result = await embedFace(await captureBytes(captures[i]));
			if (result) embeddings.push({ index: i, ...result });
			else rejected.push({ index: i, reason: 'no_face_detected' });
		} catch (err) {
			rejected.push({ index: i, reason: String(err?.message || err).slice(0, 200) });
		}
	}
	return { embeddings, rejected };
}

// How tightly the captures agree with each other. A selfie set whose own photos
// only match each other at 0.5 cannot support a claim about the avatar at 0.6,
// and this is the number that says so. Null for a single capture, where the
// question is not defined.
export function captureCohesion(embeddings) {
	if (embeddings.length < 2) return null;
	const sims = [];
	for (let i = 0; i < embeddings.length; i += 1) {
		for (let j = i + 1; j < embeddings.length; j += 1) {
			sims.push(cosineSimilarity(embeddings[i].embedding, embeddings[j].embedding));
		}
	}
	return sims.reduce((a, b) => a + b, 0) / sims.length;
}

// Score one finished reconstruction against the photos it was built from.
//
// `deadlineAt` is an absolute wall-clock instant the caller must be finished
// by; it stops the view loop at the line instead of running on past a response
// nobody is listening to, matching how the realism bench bounds itself.
export async function scoreLikeness({ glbUrl, captures, deadlineAt = Infinity }) {
	const startedAt = Date.now();
	const result = {
		scorerVersion: SCORER_VERSION,
		glbUrl,
		captureCount: Array.isArray(captures) ? captures.length : 0,
		views: [],
		startedAt: new Date(startedAt).toISOString(),
	};

	if (!glbUrl) {
		result.status = 'no_glb';
		result.finishedAt = new Date().toISOString();
		return result;
	}
	if (!Array.isArray(captures) || !captures.length) {
		result.status = 'no_captures';
		result.finishedAt = new Date().toISOString();
		return result;
	}

	const { embeddings, rejected } = await embedCaptures(captures);
	result.capturesEmbedded = embeddings.length;
	result.capturesRejected = rejected;
	if (!embeddings.length) {
		// The inputs were never measurable, so nothing about the avatar can be
		// concluded. This is a capture-quality finding, not an avatar finding.
		result.status = 'captures_unusable';
		result.finishedAt = new Date().toISOString();
		return result;
	}
	result.captureCohesion = captureCohesion(embeddings);

	for (const view of LIKENESS_VIEWS) {
		if (Date.now() >= deadlineAt) {
			result.budgetExhausted = true;
			break;
		}
		const entry = { view: view.label, theta: view.theta };
		try {
			const { png } = await renderAvatarScene({
				glbUrl,
				width: RENDER_SIZE,
				height: RENDER_SIZE,
				background: RENDER_BACKGROUND,
				cameraOrbit: { theta: view.theta, phi: RENDER_PHI },
				scenePreset: SCENE_PRESETS.headshot,
			});
			const rendered = await embedFace(png);
			if (!rendered) {
				entry.status = 'no_face_in_render';
			} else {
				const sims = embeddings.map((cap) => ({
					captureIndex: cap.index,
					cosine: cosineSimilarity(rendered.embedding, cap.embedding),
				}));
				const best = sims.reduce((a, b) => (b.cosine > a.cosine ? b : a));
				entry.status = 'ok';
				entry.detectionScore = rendered.detection.score;
				entry.cosine = best.cosine;
				entry.bestCaptureIndex = best.captureIndex;
				entry.meanCaptureCosine = sims.reduce((s, x) => s + x.cosine, 0) / sims.length;
				entry.score5 = cosineToScore5(best.cosine);
			}
		} catch (err) {
			entry.status = 'render_failed';
			entry.error = String(err?.message || err).slice(0, 300);
		}
		result.views.push(entry);
	}

	const scored = result.views.filter((v) => v.status === 'ok');
	if (result.budgetExhausted) {
		// A partial view sweep is not comparable to a full one, so it is kept for
		// diagnosis and withheld from the distribution, exactly as the realism
		// bench withholds a budget-truncated combo.
		result.status = 'budget_exhausted';
	} else if (!scored.length) {
		result.status = 'render_unusable';
	} else {
		result.status = 'ok';
		const headOn = scored.find((v) => v.view === 'head-on');
		// The headline number is the head-on view: it is the one every product
		// surface shows first (thumbnail, share card, embed), so it is the one a
		// user's "does that look like me?" is actually formed on.
		result.identityCosine = headOn ? headOn.cosine : scored[0].cosine;
		result.likenessScore = cosineToScore5(result.identityCosine);
		result.meanCosine = scored.reduce((s, v) => s + v.cosine, 0) / scored.length;
		result.meanScore = cosineToScore5(result.meanCosine);
		result.worstCosine = Math.min(...scored.map((v) => v.cosine));
		// How much identity is lost between the best and worst view. A pipeline
		// that only works head-on shows up here and nowhere else.
		result.turnFalloff = result.identityCosine - result.worstCosine;
		result.sameIdentity = result.identityCosine >= SFACE_SAME_IDENTITY_COSINE;
	}

	result.viewsScored = scored.length;
	result.elapsedMs = Date.now() - startedAt;
	result.finishedAt = new Date().toISOString();
	return result;
}
