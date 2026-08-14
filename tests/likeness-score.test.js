/**
 * Likeness harness: the score mapping, the aggregation, and the refusals.
 *
 * The Phase 1 roadmap gate is a likeness number, so the number has to mean one
 * fixed thing forever. Contracts under test:
 *   1. The 1-5 mapping is pinned to the embedding model's own calibration:
 *      cosine 0 is 1/5, SFace's published same-identity boundary (0.363) is
 *      exactly 3/5, and a perfect match is 5/5. If this drifts, every stored
 *      score silently stops being comparable to every earlier one.
 *   2. A missing input is a REPORTED STATUS, never a zero. "the captures were
 *      unusable", "no face survived the render" and "the avatar looks nothing
 *      like them" are three different findings, and a harness that collapses
 *      them into one low number is worse than no harness.
 *   3. The headline score is the head-on view specifically, and turn falloff is
 *      measured against the worst view, because a texture-transfer pipeline
 *      that only holds up frontally is the exact failure this exists to catch.
 *   4. A budget-truncated sweep is withheld from the distribution rather than
 *      scored short, mirroring how the realism bench treats the same case.
 *   5. Captures are read from the shape avatar_regen_jobs actually stores, for
 *      both the selfie path (params.images) and the text-to-avatar path
 *      (params.referenceImageUrl).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const renderAvatarScene = vi.fn();
vi.mock('../api/_lib/avatar-render.js', () => ({
	renderAvatarScene: (...a) => renderAvatarScene(...a),
	SCENE_PRESETS: { headshot: { phi: 86, theta: 5 } },
}));

// Face embedding stand-in. Real vectors, real cosine arithmetic: only the ONNX
// session is replaced, so the aggregation under test does genuine math on
// genuine unit vectors rather than on canned scores.
const embedFace = vi.fn();
vi.mock('../api/_lib/face-embed.js', async () => {
	const actual = await vi.importActual('../api/_lib/face-embed.js');
	return { ...actual, embedFace: (...a) => embedFace(...a) };
});

// The store's read path is exercised against a stand-in `sql` tag so the
// null-vs-zero contract below is testable without a database.
const sqlRows = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlRows(...a),
	isDbUnavailableError: () => false,
}));
vi.mock('../api/_lib/env.js', () => ({ databaseConfigured: () => true }));

const {
	LIKENESS_VIEWS,
	SFACE_SAME_IDENTITY_COSINE,
	captureCohesion,
	cosineToScore5,
	scoreLikeness,
} = await import('../api/_lib/likeness-score.js');
const { capturesFromParams, recentLikenessScores } = await import('../api/_lib/likeness-store.js');

// A unit vector at a chosen angle from the reference, so a test can request an
// exact cosine instead of hoping a random pair lands near one.
function vectorAtCosine(cosine) {
	const v = new Float32Array(128);
	v[0] = cosine;
	v[1] = Math.sqrt(Math.max(0, 1 - cosine * cosine));
	return v;
}

const REFERENCE = vectorAtCosine(1);

function detection(embedding) {
	return { embedding, detection: { score: 0.95, box: [0, 0, 10, 10] } };
}

beforeEach(() => {
	renderAvatarScene.mockReset();
	embedFace.mockReset();
	renderAvatarScene.mockResolvedValue({ png: Buffer.from('png') });
});

describe('cosineToScore5', () => {
	it('anchors on the embedding model rather than on taste', () => {
		expect(cosineToScore5(0)).toBe(1);
		expect(cosineToScore5(SFACE_SAME_IDENTITY_COSINE)).toBe(3);
		expect(cosineToScore5(1)).toBe(5);
	});

	it('puts the 4/5 roadmap gate well above the same-identity boundary', () => {
		const gateCosine = SFACE_SAME_IDENTITY_COSINE + (1 - SFACE_SAME_IDENTITY_COSINE) / 2;
		expect(cosineToScore5(gateCosine)).toBe(4);
		// "Confidently the same person", not "arguably".
		expect(gateCosine).toBeGreaterThan(SFACE_SAME_IDENTITY_COSINE * 1.8);
	});

	it('is monotonic and clamped to the 1-5 scale', () => {
		let previous = 0;
		for (let c = 0; c <= 1; c += 0.05) {
			const score = cosineToScore5(c);
			expect(score).toBeGreaterThanOrEqual(previous);
			expect(score).toBeGreaterThanOrEqual(1);
			expect(score).toBeLessThanOrEqual(5);
			previous = score;
		}
		// A negative cosine is a real embedding outcome, not an error.
		expect(cosineToScore5(-0.4)).toBe(1);
		expect(cosineToScore5(Number.NaN)).toBeNull();
	});
});

describe('scoreLikeness refusals', () => {
	it('reports a missing GLB instead of scoring it', async () => {
		const result = await scoreLikeness({ glbUrl: null, captures: ['https://x.test/a.jpg'] });
		expect(result.status).toBe('no_glb');
		expect(result.likenessScore).toBeUndefined();
		expect(renderAvatarScene).not.toHaveBeenCalled();
	});

	it('reports a missing capture set instead of scoring it', async () => {
		const result = await scoreLikeness({ glbUrl: 'https://x.test/a.glb', captures: [] });
		expect(result.status).toBe('no_captures');
		expect(renderAvatarScene).not.toHaveBeenCalled();
	});

	it('blames the captures, not the avatar, when no input photo has a face', async () => {
		embedFace.mockResolvedValue(null);
		const result = await scoreLikeness({
			glbUrl: 'https://x.test/a.glb',
			captures: [Buffer.from('a'), Buffer.from('b')],
		});
		expect(result.status).toBe('captures_unusable');
		expect(result.capturesRejected).toHaveLength(2);
		expect(result.capturesRejected[0]).toMatchObject({ index: 0, reason: 'no_face_detected' });
		// Never renders: there is nothing to compare a render against.
		expect(renderAvatarScene).not.toHaveBeenCalled();
	});

	it('separates "the render has no face" from a low score', async () => {
		embedFace.mockImplementation(async (buf) =>
			Buffer.isBuffer(buf) && buf.toString() === 'png' ? null : detection(REFERENCE),
		);
		const result = await scoreLikeness({
			glbUrl: 'https://x.test/a.glb',
			captures: [Buffer.from('capture')],
		});
		expect(result.status).toBe('render_unusable');
		expect(result.likenessScore).toBeUndefined();
		expect(result.views.every((v) => v.status === 'no_face_in_render')).toBe(true);
	});

	it('withholds a score when the run ran out of budget mid-sweep', async () => {
		embedFace.mockResolvedValue(detection(REFERENCE));
		const result = await scoreLikeness({
			glbUrl: 'https://x.test/a.glb',
			captures: [Buffer.from('capture')],
			deadlineAt: Date.now() - 1,
		});
		expect(result.status).toBe('budget_exhausted');
		expect(result.budgetExhausted).toBe(true);
		expect(result.likenessScore).toBeUndefined();
	});
});

describe('scoreLikeness aggregation', () => {
	it('takes the headline from the head-on view and falloff from the worst', async () => {
		const byView = new Map([
			['head-on', 0.90],
			['three-quarter', 0.70],
			['profile', 0.50],
		]);
		let call = 0;
		embedFace.mockImplementation(async (buf) => {
			if (!Buffer.isBuffer(buf) || buf.toString() !== 'png') return detection(REFERENCE);
			const label = LIKENESS_VIEWS[call].label;
			call += 1;
			return detection(vectorAtCosine(byView.get(label)));
		});

		const result = await scoreLikeness({
			glbUrl: 'https://x.test/a.glb',
			captures: [Buffer.from('capture')],
		});

		expect(result.status).toBe('ok');
		expect(result.viewsScored).toBe(3);
		expect(result.identityCosine).toBeCloseTo(0.90, 5);
		expect(result.likenessScore).toBe(cosineToScore5(0.90));
		expect(result.worstCosine).toBeCloseTo(0.50, 5);
		// The whole point of rendering three yaws: a frontally-flattering
		// pipeline is visible here and in no single-view number.
		expect(result.turnFalloff).toBeCloseTo(0.40, 5);
		expect(result.meanCosine).toBeCloseTo(0.70, 5);
		expect(result.sameIdentity).toBe(true);
	});

	it('scores against the best-matching capture, and names which one', async () => {
		const captures = [vectorAtCosine(0.2), vectorAtCosine(0.85)];
		let captureCall = 0;
		embedFace.mockImplementation(async (buf) => {
			if (Buffer.isBuffer(buf) && buf.toString() === 'png') return detection(REFERENCE);
			const emb = captures[captureCall];
			captureCall += 1;
			return detection(emb);
		});

		const result = await scoreLikeness({
			glbUrl: 'https://x.test/a.glb',
			captures: [Buffer.from('a'), Buffer.from('b')],
		});

		expect(result.capturesEmbedded).toBe(2);
		expect(result.views[0].bestCaptureIndex).toBe(1);
		expect(result.views[0].cosine).toBeCloseTo(0.85, 5);
		expect(result.views[0].meanCaptureCosine).toBeCloseTo(0.525, 5);
	});

	it('flags a below-threshold reconstruction as not the same person', async () => {
		embedFace.mockImplementation(async (buf) =>
			Buffer.isBuffer(buf) && buf.toString() === 'png'
				? detection(vectorAtCosine(0.2))
				: detection(REFERENCE),
		);
		const result = await scoreLikeness({
			glbUrl: 'https://x.test/a.glb',
			captures: [Buffer.from('capture')],
		});
		expect(result.status).toBe('ok');
		expect(result.sameIdentity).toBe(false);
		expect(result.likenessScore).toBeLessThan(3);
	});

	it('renders the three declared yaws, head-framed', async () => {
		embedFace.mockResolvedValue(detection(REFERENCE));
		await scoreLikeness({ glbUrl: 'https://x.test/a.glb', captures: [Buffer.from('c')] });
		const thetas = renderAvatarScene.mock.calls.map((c) => c[0].cameraOrbit.theta);
		expect(thetas).toEqual(LIKENESS_VIEWS.map((v) => v.theta));
		expect(renderAvatarScene.mock.calls[0][0].scenePreset).toEqual({ phi: 86, theta: 5 });
	});
});

describe('captureCohesion', () => {
	it('is undefined for a single capture and mean-pairwise beyond that', () => {
		expect(captureCohesion([{ embedding: REFERENCE }])).toBeNull();
		const cohesion = captureCohesion([
			{ embedding: REFERENCE },
			{ embedding: vectorAtCosine(0.6) },
			{ embedding: vectorAtCosine(0.8) },
		]);
		expect(cohesion).toBeGreaterThan(0);
		expect(cohesion).toBeLessThan(1);
	});
});

describe('capturesFromParams', () => {
	it('reads the selfie path', () => {
		expect(capturesFromParams({ images: ['https://x.test/1.jpg', 'https://x.test/2.jpg'] }))
			.toEqual(['https://x.test/1.jpg', 'https://x.test/2.jpg']);
	});

	it('falls back to the text-to-avatar reference image', () => {
		expect(capturesFromParams({ source: 'prompt', referenceImageUrl: 'https://x.test/ref.png' }))
			.toEqual(['https://x.test/ref.png']);
	});

	it('accepts a params column that came back as text rather than jsonb', () => {
		expect(capturesFromParams(JSON.stringify({ images: ['https://x.test/1.jpg'] })))
			.toEqual(['https://x.test/1.jpg']);
	});

	it('yields nothing rather than throwing on junk', () => {
		expect(capturesFromParams(null)).toEqual([]);
		expect(capturesFromParams('not json')).toEqual([]);
		expect(capturesFromParams({ images: [null, 42, ''] })).toEqual([]);
	});
});

describe('recentLikenessScores column mapping', () => {
	it('keeps "not measured" null instead of reporting it as zero', async () => {
		// A single-capture reconstruction stores capture_cohesion as NULL, because
		// agreement between photos is undefined with one photo. Number(null) is 0
		// and Number.isFinite(0) is true, so a naive conversion turns that into a
		// cohesion of 0.000, which reads as "these photos are of different people":
		// the opposite of what the row says.
		sqlRows.mockResolvedValueOnce([
			{
				creation_id: 'c-1',
				status: 'ok',
				likeness_score: '4.12',
				identity_cosine: '0.7011',
				mean_score: null,
				worst_cosine: null,
				turn_falloff: null,
				same_identity: true,
				captures_total: 1,
				captures_embedded: 1,
				capture_cohesion: null,
				views_scored: 3,
				score_ms: 61000,
				scored_at: '2026-08-14T01:00:00.000Z',
			},
		]);

		const [row] = await recentLikenessScores({ limit: 1 });
		expect(row.captureCohesion).toBeNull();
		expect(row.meanScore).toBeNull();
		expect(row.turnFalloff).toBeNull();
		// Real numeric columns still come back as numbers, not strings.
		expect(row.likenessScore).toBe(4.12);
		expect(row.identityCosine).toBeCloseTo(0.7011, 6);
	});

	it('preserves a genuine zero, which is a different fact from null', async () => {
		sqlRows.mockResolvedValueOnce([
			{
				creation_id: 'c-2',
				status: 'ok',
				likeness_score: '2.0',
				identity_cosine: '0.2',
				mean_score: '2.0',
				worst_cosine: '0.2',
				turn_falloff: 0,
				same_identity: false,
				captures_total: 3,
				captures_embedded: 3,
				capture_cohesion: 0,
				views_scored: 3,
				score_ms: 60000,
				scored_at: '2026-08-14T01:00:00.000Z',
			},
		]);

		const [row] = await recentLikenessScores({ limit: 1 });
		expect(row.turnFalloff).toBe(0);
		expect(row.captureCohesion).toBe(0);
	});
});
