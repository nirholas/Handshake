// Optional, additive output controls for the /forge generation pipeline.
//
// Every field here is OFF by default: a request that omits all of them produces
// byte-for-byte the same behavior the endpoint had before this module existed.
// They let a caller tune an individual generation without changing the tier
// contract:
//   • seed             — reproducibility (same seed + prompt + params → same mesh)
//   • output_format    — glb (default) or a compressed variant (draco / meshopt)
//   • texture_size     — bake textures at a specific resolution
//   • target_polycount — explicit geometry budget on poly-aware backends
//   • derive_pbr       — the ONE exception to "off by default": the material
//     completion pass (glb-pbr-derive.js) runs on every delivered mesh, because
//     an albedo-only material is a defect rather than a preference. Send
//     `derive_pbr: false` to receive the lane's own materials untouched.
//
// normalizeForgeOptions() validates and clamps; an explicitly-present but invalid
// value is reported in `errors` so the endpoint can answer 400 with an actionable
// message rather than silently doing something the caller didn't ask for. A value
// that is simply absent is never an error — it just keeps the current default.

// glb is the universal default. The two compressed variants run a post-generation
// pass (see glb-compress.js) that shrinks the delivered file without changing the
// rendered result — Draco for geometry, meshopt (EXT_meshopt_compression) for
// geometry + a faster GPU upload. Both stay valid glTF 2.0 with the right decoder.
export const OUTPUT_FORMATS = Object.freeze(['glb', 'glb-draco', 'glb-meshopt']);
export const TEXTURE_SIZES = Object.freeze([512, 1024, 2048, 4096]);

const POLYCOUNT_MIN = 100;
const POLYCOUNT_MAX = 500_000;
const SEED_MAX = 4_294_967_295; // uint32 — the range every provider's RNG accepts

function compressionFor(format) {
	if (format === 'glb-draco') return 'draco';
	if (format === 'glb-meshopt') return 'meshopt';
	return 'none';
}

/**
 * Parse the optional output controls from a /forge request body.
 *
 * @param {any} body
 * @returns {{
 *   seed: number | null,
 *   outputFormat: 'glb' | 'glb-draco' | 'glb-meshopt',
 *   compression: 'none' | 'draco' | 'meshopt',
 *   textureSize: number | null,
 *   targetPolycount: number | null,
 *   derivePbr: boolean,          // material completion pass — true unless opted out
 *   hasOptions: boolean,         // true iff any non-default option was supplied
 *   errors: Array<{ field: string, message: string }>,
 * }}
 */
export function normalizeForgeOptions(body) {
	const errors = [];
	const b = body && typeof body === 'object' ? body : {};

	// seed — accept any integer; clamp into the uint32 range providers accept.
	let seed = null;
	if (b.seed !== undefined && b.seed !== null) {
		const n = Number(b.seed);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
			errors.push({ field: 'seed', message: 'seed must be a non-negative integer.' });
		} else {
			seed = Math.min(n, SEED_MAX);
		}
	}

	// output_format / format — controls the post-generation compression variant.
	let outputFormat = 'glb';
	const rawFormat = b.output_format ?? b.format;
	if (rawFormat !== undefined && rawFormat !== null && rawFormat !== '') {
		const f = String(rawFormat).toLowerCase().trim();
		if (OUTPUT_FORMATS.includes(f)) outputFormat = f;
		else
			errors.push({
				field: 'output_format',
				message: `output_format must be one of: ${OUTPUT_FORMATS.join(', ')}.`,
			});
	}

	// texture_size / texture_resolution — bake resolution for poly-aware backends.
	let textureSize = null;
	const rawTex = b.texture_size ?? b.texture_resolution;
	if (rawTex !== undefined && rawTex !== null && rawTex !== '') {
		const n = Number(rawTex);
		if (TEXTURE_SIZES.includes(n)) textureSize = n;
		else
			errors.push({
				field: 'texture_size',
				message: `texture_size must be one of: ${TEXTURE_SIZES.join(', ')}.`,
			});
	}

	// target_polycount — explicit geometry budget (poly-aware backends only). A
	// `quality` alias maps coarse → fine for callers that prefer a word over a number.
	let targetPolycount = null;
	let rawPoly = b.target_polycount;
	if ((rawPoly === undefined || rawPoly === null) && typeof b.quality === 'string') {
		const map = { low: 5_000, draft: 5_000, medium: 30_000, standard: 50_000, high: 150_000, ultra: 300_000 };
		const q = b.quality.toLowerCase().trim();
		if (q in map) rawPoly = map[q];
		else errors.push({ field: 'quality', message: `quality must be one of: ${Object.keys(map).join(', ')}.` });
	}
	if (rawPoly !== undefined && rawPoly !== null && rawPoly !== '') {
		const n = Number(rawPoly);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n < POLYCOUNT_MIN || n > POLYCOUNT_MAX) {
			errors.push({
				field: 'target_polycount',
				message: `target_polycount must be an integer between ${POLYCOUNT_MIN} and ${POLYCOUNT_MAX}.`,
			});
		} else {
			targetPolycount = n;
		}
	}

	// derive_pbr — opt-OUT. Anything other than an explicit boolean false leaves
	// the completion pass on; a non-boolean value is reported rather than
	// silently coerced, so `derive_pbr: "no"` never reads as true.
	let derivePbr = true;
	if (b.derive_pbr !== undefined && b.derive_pbr !== null) {
		if (typeof b.derive_pbr !== 'boolean') {
			errors.push({ field: 'derive_pbr', message: 'derive_pbr must be true or false.' });
		} else {
			derivePbr = b.derive_pbr;
		}
	}

	const hasOptions =
		seed !== null || outputFormat !== 'glb' || textureSize !== null || targetPolycount !== null || !derivePbr;

	return {
		seed,
		outputFormat,
		compression: compressionFor(outputFormat),
		textureSize,
		targetPolycount,
		derivePbr,
		hasOptions,
		errors,
	};
}

// The subset of normalized options that is safe to forward to a provider's
// reconstruct call. Only fields a model actually consumes (seed, texture size,
// polycount) — never the post-generation compression, which we apply ourselves.
// Returns a plain object that callers spread into their existing reconstructParams,
// so an all-default options object contributes nothing (current behavior preserved).
export function providerReconstructParams(opts, { polyControl = false } = {}) {
	const out = {};
	if (!opts) return out;
	if (opts.seed !== null && opts.seed !== undefined) out.seed = opts.seed;
	if (polyControl) {
		if (opts.textureSize) out.texture_size = opts.textureSize;
		if (opts.targetPolycount) out.target_polycount = opts.targetPolycount;
	}
	return out;
}

// Compact, response-safe echo of what the caller actually got — included in the
// generation response so a client can confirm the seed used (for reproducibility)
// and which format/resolution was applied.
export function summarizeForgeOptions(opts) {
	if (!opts) return {};
	return {
		seed: opts.seed,
		output_format: opts.outputFormat,
		texture_size: opts.textureSize,
		target_polycount: opts.targetPolycount,
		derive_pbr: opts.derivePbr !== false,
	};
}
