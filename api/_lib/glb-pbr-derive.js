// Derived PBR channels for every finished /forge mesh.
//
// The reconstruction lanes (TRELLIS, Hunyuan3D, TripoSG, Meshy, Tripo, Rodin)
// all bake a single baseColor atlas and stop there. A glTF material with only
// baseColor has no normal map, no roughness/metallic map, and no ambient
// occlusion, so every surface reflects the environment identically: a knife
// blade, a wool sweater and a pane of glass all read as the same slightly shiny
// plastic under the viewer's IBL. That is the single biggest gap between "the
// mesh is right" and "the object looks real".
//
// This module closes it without a second generation pass. Everything it needs is
// already in the albedo the lane produced:
//
//   normal: the albedo's luminance is treated as a height field and
//                 differentiated (Sobel) into a tangent-space normal map, so
//                 wood grain, fabric weave, stone pitting and skin pores catch
//                 light as relief instead of staying painted-on flat.
//   roughness: local albedo contrast maps into the material class's MEASURED
//                 roughness range: smooth, low-contrast regions read polished,
//                 high-frequency regions read matte.
//   metallic: the class's measured metallic value (0.0 for every dielectric,
//                 ~0.9 for bare metal). Never guessed per pixel.
//   occlusion: a cavity map: where a pixel sits below its local neighborhood
//                 in the height field it is in a crevice, so it is darkened.
//
// Occlusion/roughness/metallic are packed into ONE texture (R/G/B), which is the
// glTF convention and means the derived set costs two images per material, not
// four. On top of the maps, the class's measured real-world extension layer is
// written into the GLB itself (KHR_materials_transmission for glass,
// _clearcoat for car paint and corneas, _sheen for fabric and skin, _specular
// for skin's below-default F0, _anisotropy for brushed metal), so the look
// survives download and export instead of living only in the three.ws viewer.
//
// Two lane defects measured on real 2026-08-01 output are repaired in the same
// pass, because both produce a wrong material and neither is recoverable later:
//
//   • The free TRELLIS lanes (nvidia NIM, HuggingFace Spaces) ship a GLB with NO
//     materials array at all: just POSITION + COLOR_0. glTF 2.0 3.7.2 says a
//     primitive without a material takes the DEFAULT material, whose
//     metallicFactor and roughnessFactor are both 1.0, so every free generation
//     renders as fully-metallic rough metal tinted by its vertex colors. Any
//     primitive found without a material gets a real, class-keyed one.
//   • Hunyuan3D declares `image/png` on texture bytes that are actually JPEG.
//     The mimeType is normalized to what the magic bytes say.
//
// Strictly best-effort and side-effect free on failure: any error returns the
// original bytes, exactly like glb-cleanup.js. `sharp` and the glTF codecs are
// imported lazily so a caller that never derives pays nothing.

import { Buffer } from 'node:buffer';

// Measured real-world values. Sources are the standard PBR reference charts
// (Substance/Disney): dielectrics have metallic exactly 0 and an F0 near 0.04;
// bare metals have metallic 1 and no diffuse term. Roughness is expressed as a
// RANGE because a derived map, not a flat factor, drives it, `base` is the
// value used when a material has no albedo texture to derive from.
//
// Kept deliberately in step with MATERIAL_CLASS_PBR in workers/texture/main.py:
// that table primes the SDXL texture bake, this one finishes the material the
// bake produced. The shared class ids (person, metal, wood, fabric, plastic,
// glass) carry the same metallic and the same base roughness in both places.
export const MATERIAL_CLASSES = Object.freeze({
	// person/skin: 0.45-0.6 measured for bare skin; sheen stands in for the
	// subsurface falloff glTF has no term for, and specular 0.5 pulls F0 down to
	// skin's real ~0.028 from the 0.04 dielectric default.
	person: {
		metallic: 0,
		roughness: { base: 0.52, min: 0.45, max: 0.6 },
		normalStrength: 0.6,
		aoStrength: 0.5,
		ext: { sheen: 0.35, sheenColor: [1, 0.878, 0.761], sheenRoughness: 0.6, specular: 0.7, ior: 1.4 },
	},
	hair: {
		metallic: 0,
		roughness: { base: 0.4, min: 0.3, max: 0.55 },
		normalStrength: 0.8,
		aoStrength: 0.6,
		ext: { sheen: 0.5, sheenRoughness: 0.4 },
	},
	// Cornea: real corneal IOR is 1.376 and the tear film is a near-mirror
	// clearcoat over it. This is what puts a catchlight in an eye.
	eye: {
		metallic: 0,
		roughness: { base: 0.08, min: 0.05, max: 0.15 },
		normalStrength: 0.1,
		aoStrength: 0.15,
		ext: { clearcoat: 1, clearcoatRoughness: 0.03, ior: 1.376 },
	},
	metal: {
		metallic: 0.9,
		roughness: { base: 0.35, min: 0.2, max: 0.55 },
		normalStrength: 0.7,
		aoStrength: 0.5,
		ext: {},
	},
	// Brushing carves parallel micro-grooves, so reflections stretch along one
	// axis. KHR_materials_anisotropy is the only honest way to express that.
	brushedMetal: {
		metallic: 0.95,
		roughness: { base: 0.45, min: 0.3, max: 0.6 },
		normalStrength: 0.5,
		aoStrength: 0.4,
		ext: { anisotropy: 0.85, anisotropyRotation: 0 },
	},
	// Automotive finish: a pigmented base coat under a separate, always-dielectric
	// lacquer layer. The clearcoat is what makes car paint read wet rather than
	// flat metallic.
	carPaint: {
		metallic: 0.6,
		roughness: { base: 0.35, min: 0.25, max: 0.45 },
		normalStrength: 0.25,
		aoStrength: 0.35,
		ext: { clearcoat: 1, clearcoatRoughness: 0.03 },
	},
	wood: {
		metallic: 0,
		roughness: { base: 0.72, min: 0.55, max: 0.9 },
		normalStrength: 1,
		aoStrength: 0.7,
		ext: {},
	},
	fabric: {
		metallic: 0,
		roughness: { base: 0.88, min: 0.75, max: 0.95 },
		normalStrength: 1.2,
		aoStrength: 0.8,
		ext: { sheen: 0.6, sheenColor: [0.541, 0.51, 0.447], sheenRoughness: 0.7 },
	},
	leather: {
		metallic: 0,
		roughness: { base: 0.65, min: 0.5, max: 0.85 },
		normalStrength: 1.1,
		aoStrength: 0.75,
		ext: { sheen: 0.25, sheenRoughness: 0.6 },
	},
	plastic: {
		metallic: 0,
		roughness: { base: 0.35, min: 0.15, max: 0.6 },
		normalStrength: 0.4,
		aoStrength: 0.4,
		ext: {},
	},
	ceramic: {
		metallic: 0,
		roughness: { base: 0.28, min: 0.15, max: 0.45 },
		normalStrength: 0.3,
		aoStrength: 0.35,
		ext: { clearcoat: 0.5, clearcoatRoughness: 0.08 },
	},
	// Real glass refracts rather than alpha-blending. IOR 1.45 is soda-lime.
	glass: {
		metallic: 0,
		roughness: { base: 0.05, min: 0.02, max: 0.12 },
		normalStrength: 0.1,
		aoStrength: 0.1,
		ext: { transmission: 1, ior: 1.45, thickness: 0.4, attenuationColor: [0.933, 0.973, 1], attenuationDistance: 1.2 },
	},
	stone: {
		metallic: 0,
		roughness: { base: 0.85, min: 0.7, max: 0.95 },
		normalStrength: 1.3,
		aoStrength: 0.85,
		ext: {},
	},
	rubber: {
		metallic: 0,
		roughness: { base: 0.95, min: 0.85, max: 1 },
		normalStrength: 0.9,
		aoStrength: 0.6,
		ext: {},
	},
	foliage: {
		metallic: 0,
		roughness: { base: 0.6, min: 0.45, max: 0.8 },
		normalStrength: 1,
		aoStrength: 0.7,
		ext: { sheen: 0.2, sheenRoughness: 0.5 },
	},
	// Everything unclassified: a neutral dielectric. Matches the worker's
	// DEFAULT_MATERIAL_PBR so an unclassified subject looks the same whichever
	// stage touched it last.
	object: {
		metallic: 0,
		roughness: { base: 0.8, min: 0.55, max: 0.92 },
		normalStrength: 0.8,
		aoStrength: 0.6,
		ext: {},
	},
});

export const MATERIAL_CLASS_IDS = Object.freeze(Object.keys(MATERIAL_CLASSES));

// Per-tier derived-map resolution. Free/draft keeps the lane's own atlas size so
// nothing about the free path gets heavier; standard and high derive at 2K/4K to
// match the albedo the tier already asks the lane for (forge-tiers.js:
// texture_size 1024 / 2048 / 4096). The derived maps are never larger than the
// albedo they came from: upsampling invents detail that is not there.
export const TIER_DERIVED_SIZE = Object.freeze({ draft: 1024, standard: 2048, high: 4096 });
const DEFAULT_DERIVED_SIZE = 2048;

// Material-name tokens, checked before the prompt. A lane that names its
// materials at all (Meshy, Tripo, Rodin, and every rigged avatar export) gives a
// far stronger signal than the prompt does, and it is per-material rather than
// per-model, so a knife's steel head and walnut handle can diverge.
const NAME_RULES = [
	[/(^|[_\s-])(cornea|iris|sclera|eyeball)|(^|[_\s-])eyes?(left|right)?(?=[_\s-]|$)/i, 'eye'],
	[/(^|[_\s-])(hair|eyebrow|eyelash|beard|fur|moustache)/i, 'hair'],
	[/(^|[_\s-])(skin|body|face|head|torso|wolf3d_(skin|body|head))/i, 'person'],
	[/brushed|anodi[sz]ed|satin[_\s-]?(steel|metal|alu)/i, 'brushedMetal'],
	[/car[_\s-]?paint|body[_\s-]?paint|lacquer|clear[_\s-]?coat/i, 'carPaint'],
	[/(chrome|steel|iron|metal|brass|bronze|copper|gold|silver|alumin|titanium|tin|nickel)/i, 'metal'],
	[/(glass|crystal|window|lens|acrylic|perspex)/i, 'glass'],
	[/(wood|timber|oak|walnut|birch|maple|pine|teak|mahogany|bamboo)/i, 'wood'],
	[/(leather|hide|suede)/i, 'leather'],
	[/(cloth|fabric|textile|linen|cotton|wool|denim|canvas|silk|velvet|weave|shirt|dress|robe|cape)/i, 'fabric'],
	[/(rubber|tyre|tire|tread)/i, 'rubber'],
	[/(ceramic|porcelain|china|glaze|enamel)/i, 'ceramic'],
	[/(stone|rock|granite|marble|concrete|brick|slate|gravel|boulder)/i, 'stone'],
	[/(leaf|leaves|foliage|plant|moss|grass|fern|petal)/i, 'foliage'],
	[/(plastic|nylon|resin|abs|polymer|vinyl)/i, 'plastic'],
];

// Prompt tokens, the per-model fallback when material names carry nothing (the
// TRELLIS/Hunyuan3D case, where every material is "material_0"). Matched by
// EARLIEST POSITION in the prompt, not by list order: English puts the defining
// material before the head noun and relegates secondary ones to a trailing
// "with …" clause, so first-mention tracks the dominant surface far better than
// any fixed priority can. "stainless steel chef knife with a dark walnut handle"
// resolves to metal, "leather lounge chair with tapered walnut legs" to leather,
// and "wooden-handled claw hammer with a scratched steel head" to wood, all from
// the same rule. List order below only breaks ties at the same position.
const PROMPT_RULES = [
	[/\b(brushed|anodi[sz]ed|satin)\s+(steel|metal|aluminium|aluminum)\b/i, 'brushedMetal'],
	[/\b(car|automotive|motorcycle|truck|vehicle)\s+paint\b|\bglossy\s+paint(work)?\b/i, 'carPaint'],
	[/\b(glass|crystal|acrylic|transparent|see[- ]through)\b/i, 'glass'],
	[/\b(steel|chrome|iron|metal(lic)?|brass|bronze|copper|gold(en)?|silver|alumini?um|titanium)\b/i, 'metal'],
	[/\b(wood(en)?|timber|oak|walnut|birch|maple|pine|teak|mahogany|bamboo)\b/i, 'wood'],
	[/\b(leather|suede|hide)\b/i, 'leather'],
	[/\b(fabric|cloth|textile|linen|cotton|wool(len)?|denim|canvas|silk|velvet|knit|sweater|shirt)\b/i, 'fabric'],
	[/\b(ceramic|porcelain|china|glazed|enamel)\b/i, 'ceramic'],
	[/\b(stone|rock|granite|marble|concrete|brick|slate|boulder)\b/i, 'stone'],
	[/\b(rubber|tyre|tire)\b/i, 'rubber'],
	[/\b(leaf|leaves|foliage|plant|moss|fern|petal)\b/i, 'foliage'],
	[/\b(plastic|nylon|resin|vinyl)\b/i, 'plastic'],
];

// forge-enhance.js's subject classes, mapped onto a material class. A person's
// defining surface is skin and a creature's is fur, whatever either is wearing,
// so those two can beat an explicit material word in the same sentence. The
// other classes carry no such certainty and only apply once the prompt's own
// material words have had their turn.
const SUBJECT_DOMINANT = Object.freeze({ person: 'person', animal: 'hair' });
const SUBJECT_FALLBACK = Object.freeze({ vehicle: 'carPaint', food: 'object', object: 'object' });

/**
 * Resolve the material class for one material.
 *
 * Order: an explicit override, then the material's own name (per-material, and
 * by far the strongest signal when a lane bothers to name its materials), then
 * the FIRST-MENTIONED of the prompt's subject and its material words, then the
 * weaker subject classes, then the neutral dielectric default.
 *
 * The first-mention contest is what separates the two ways a prompt can mix a
 * person word with a material word, which no fixed priority can:
 *
 *   "portrait bust of a woman ... wearing a navy wool sweater"
 *      person at 20 beats wool at 62  ->  person (skin, with a fabric detail)
 *   "a professional stainless steel chef knife with a walnut handle"
 *      steel at 25 beats chef at 36   ->  metal (a knife, not a cook)
 *
 * @param {{ materialName?: string, prompt?: string, subjectClass?: string, subjectIndex?: number, materialClass?: string }} ctx
 * @returns {string} a key of MATERIAL_CLASSES
 */
export function resolveMaterialClass({ materialName = '', prompt = '', subjectClass = '', subjectIndex = -1, materialClass = '' } = {}) {
	const explicit = String(materialClass || '').trim();
	if (explicit && MATERIAL_CLASSES[explicit]) return explicit;

	const name = String(materialName || '');
	if (name) {
		for (const [re, cls] of NAME_RULES) if (re.test(name)) return cls;
	}

	const subject = String(subjectClass || '').trim();
	const dominant = SUBJECT_DOMINANT[subject];

	const text = String(prompt || '');
	let material = null;
	if (text) {
		for (const [re, cls] of PROMPT_RULES) {
			const m = re.exec(text);
			if (m && (material === null || m.index < material.index)) material = { index: m.index, cls };
		}
	}

	if (dominant) {
		// A subject with no recorded position (an explicitly passed subjectClass
		// rather than one classified from this prompt) keeps its old precedence.
		if (!material || subjectIndex < 0 || subjectIndex < material.index) return dominant;
	}
	if (material) return material.cls;

	if (SUBJECT_FALLBACK[subject]) return SUBJECT_FALLBACK[subject];
	return 'object';
}

// ── image math ───────────────────────────────────────────────────────────────

function clamp255(v) {
	return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * Box-blur a single-channel buffer with a separable kernel. Used both to
 * de-noise the height field before differentiating (lossy albedo carries block
 * artifacts that a raw Sobel amplifies into visible grid noise) and to build the
 * local-neighborhood reference the cavity and roughness passes compare against.
 *
 * @param {Uint8Array} src
 * @param {number} width
 * @param {number} height
 * @param {number} radius  in pixels, >= 1
 * @returns {Uint8Array}
 */
export function boxBlur(src, width, height, radius) {
	const r = Math.max(1, Math.round(radius));
	const tmp = new Uint8Array(src.length);
	const out = new Uint8Array(src.length);
	const window = r * 2 + 1;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		let sum = 0;
		for (let x = -r; x <= r; x++) sum += src[row + Math.min(width - 1, Math.max(0, x))];
		for (let x = 0; x < width; x++) {
			tmp[row + x] = (sum / window) | 0;
			sum -= src[row + Math.min(width - 1, Math.max(0, x - r))];
			sum += src[row + Math.min(width - 1, Math.max(0, x + r + 1))];
		}
	}
	for (let x = 0; x < width; x++) {
		let sum = 0;
		for (let y = -r; y <= r; y++) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
		for (let y = 0; y < height; y++) {
			out[y * width + x] = (sum / window) | 0;
			sum -= tmp[Math.min(height - 1, Math.max(0, y - r)) * width + x];
			sum += tmp[Math.min(height - 1, Math.max(0, y + r + 1)) * width + x];
		}
	}
	return out;
}

/**
 * Sobel-differentiate a height field into a tangent-space normal map (RGB, +Y up
 * per the glTF spec). `strength` scales the gradient before normalization, so a
 * class with coarse relief (stone, fabric) gets deeper normals than a smooth one
 * (glass, a cornea).
 *
 * @param {Uint8Array} height  single-channel height field
 * @param {number} width
 * @param {number} h
 * @param {number} strength
 * @returns {Uint8Array} RGB triples, length width*h*3
 */
export function normalFromHeight(height, width, h, strength) {
	const out = new Uint8Array(width * h * 3);
	const at = (x, y) => height[Math.min(h - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
	// Scale so `strength` reads as "relief depth in the same units across
	// resolutions": a 4K atlas has 4x the samples across the same surface, so an
	// unscaled gradient would come out 4x shallower than the 1K one.
	const scale = (strength * 4 * Math.max(width, h)) / 1024 / 255;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < width; x++) {
			const tl = at(x - 1, y - 1);
			const t = at(x, y - 1);
			const tr = at(x + 1, y - 1);
			const l = at(x - 1, y);
			const r = at(x + 1, y);
			const bl = at(x - 1, y + 1);
			const b = at(x, y + 1);
			const br = at(x + 1, y + 1);
			const dx = tl + 2 * l + bl - (tr + 2 * r + br);
			const dy = tl + 2 * t + tr - (bl + 2 * b + br);
			// glTF tangent space is +X right, +Y up, +Z out of the surface. Image
			// rows run downward, so dy already carries the sign flip Y needs.
			let nx = dx * scale;
			let ny = dy * scale;
			const nz = 1;
			const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
			nx /= len;
			ny /= len;
			const i = (y * width + x) * 3;
			out[i] = clamp255((nx * 0.5 + 0.5) * 255);
			out[i + 1] = clamp255((ny * 0.5 + 0.5) * 255);
			out[i + 2] = clamp255((nz / len) * 0.5 * 255 + 127.5);
		}
	}
	return out;
}

/**
 * Pack occlusion (R), roughness (G) and metallic (B) into one RGB buffer, the
 * glTF ORM convention.
 *
 * Occlusion is a cavity map: where a pixel sits below its local neighborhood in
 * the height field it is inside a crevice and receives less ambient light.
 * Roughness is driven by local albedo contrast mapped into the class's measured
 * range, because a surface with high-frequency detail scatters more than a flat
 * one. Metallic is the class constant; per-pixel metallic guessing from albedo
 * is not physically recoverable and produces the "everything is chrome" failure.
 *
 * @param {Uint8Array} height single-channel height field (already de-noised)
 * @param {Uint8Array} blurred the same field, box-blurred (local neighborhood)
 * @param {number} width
 * @param {number} h
 * @param {{ roughness: {min:number,max:number}, metallic: number, aoStrength: number }} cls
 * @returns {Uint8Array} RGB triples
 */
export function packOrm(height, blurred, width, h, cls) {
	const out = new Uint8Array(width * h * 3);
	const metallic = clamp255(cls.metallic * 255);
	const rLo = cls.roughness.min;
	const rSpan = cls.roughness.max - cls.roughness.min;
	// Contrast that saturates the roughness range. 24/255 of local deviation is
	// a strongly textured surface (coarse weave, bark); anything above that is
	// already at the class maximum.
	const CONTRAST_SATURATION = 24;
	for (let i = 0, n = width * h; i < n; i++) {
		const dev = height[i] - blurred[i];
		const contrast = Math.min(1, Math.abs(dev) / CONTRAST_SATURATION);
		const roughness = rLo + rSpan * contrast;
		// Only negative deviation (darker than its neighborhood) is a cavity.
		const cavity = dev < 0 ? Math.min(1, -dev / 32) : 0;
		const ao = 1 - cavity * cls.aoStrength;
		const o = i * 3;
		out[o] = clamp255(ao * 255);
		out[o + 1] = clamp255(roughness * 255);
		out[o + 2] = metallic;
	}
	return out;
}

// ── glTF plumbing ────────────────────────────────────────────────────────────

let _ioPromise = null;
async function derivedIO() {
	if (!_ioPromise) {
		_ioPromise = (async () => {
			const { NodeIO } = await import('@gltf-transform/core');
			const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
			const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
			await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
			return new NodeIO()
				.registerExtensions(ALL_EXTENSIONS)
				.registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
		})();
	}
	return _ioPromise;
}

// Read an embedded texture into a de-noised, single-channel height field plus
// the RGB packers' target dimensions. Returns null when the image cannot be
// decoded (an unsupported codec, a zero-byte texture) so the caller skips the
// map derivation for that material and still applies the factor/extension layer.
async function heightFieldFrom(sharp, bytes, maxSize) {
	const img = sharp(Buffer.from(bytes), { failOn: 'none' });
	const meta = await img.metadata();
	if (!meta?.width || !meta?.height) return null;
	// Never upscale: the derived detail can only be as fine as the albedo's.
	const target = Math.min(maxSize, Math.max(meta.width, meta.height));
	const { data, info } = await img
		.resize(target, target, { fit: 'fill' })
		.greyscale()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const luma = new Uint8Array(data.buffer, data.byteOffset, info.width * info.height);
	// One pixel of blur removes the block artifacts lossy albedo carries without
	// eating real surface detail; the Sobel below would otherwise amplify them.
	const denoised = boxBlur(luma, info.width, info.height, 1);
	return { luma: denoised, width: info.width, height: info.height };
}

/**
 * Halve a single-channel field by 2x2 box average. The occlusion/roughness/
 * metallic map is low-frequency by construction (a cavity mask and a contrast
 * envelope, never fine detail), so deriving and storing it at half the albedo's
 * resolution costs nothing visible and roughly quarters its share of the
 * payload. Normal maps do NOT get this treatment: their whole job is the fine
 * detail.
 *
 * @param {Uint8Array} src
 * @param {number} width
 * @param {number} height
 * @returns {{ data: Uint8Array, width: number, height: number }}
 */
export function halveField(src, width, height) {
	const w = Math.max(1, width >> 1);
	const h = Math.max(1, height >> 1);
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const sx = x * 2;
			const sy = y * 2;
			const x1 = Math.min(width - 1, sx + 1);
			const y1 = Math.min(height - 1, sy + 1);
			out[y * w + x] = (src[sy * width + sx] + src[sy * width + x1] + src[y1 * width + sx] + src[y1 * width + x1]) >> 2;
		}
	}
	return { data: out, width: w, height: h };
}

// Derived maps ship as WebP, not PNG. A PNG normal + PNG ORM pair TRIPLES a
// finished GLB (measured: 2.25 MB to 6.79 MB on a real trellis_selfhost output),
// which would make every model slower to load in exchange for the realism. WebP
// carries both at a fraction of that and is decoded natively by three.js'
// GLTFLoader through EXT_texture_webp, which the three.ws viewer and
// scripts/compress-glbs.mjs already rely on.
//
// The two maps get different settings because they fail differently. A normal
// map's three channels are one unit vector, so chroma SUBSAMPLING (not quality
// as such) is what shows up as visible faceting: `smartSubsample: false` keeps
// it at 4:4:4 and the remaining lossy error stays below the threshold of
// visibility. The ORM map is three smooth masks and tolerates ordinary quality.
//
// Measured on a real 2048x2048 trellis_selfhost albedo, encoding the derived
// normal: nearLossless takes 10.4 s for 2732 KB, q92 at 4:4:4 takes 0.69 s for
// 927 KB. Near-lossless is both slower and larger on this kind of data (smooth
// gradients, no flat runs to exploit), so it buys nothing here and would have
// put a 45 s stall in the delivery path.
const NORMAL_WEBP = Object.freeze({ quality: 92, effort: 2, smartSubsample: false });
const ORM_WEBP = Object.freeze({ quality: 88, effort: 2 });

async function encodeMap(sharp, rgb, width, height, options) {
	return sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } })
		.webp(options)
		.toBuffer();
}

// Write the class's measured extension layer onto a material. Every extension is
// created through the Document's own extension instance, so the GLB declares
// exactly the extensions it uses and nothing more.
function applyExtensionLayer(doc, material, ext, exts) {
	if (ext.transmission != null) {
		const t = doc.createExtension(exts.KHRMaterialsTransmission).createTransmission();
		t.setTransmissionFactor(ext.transmission);
		material.setExtension('KHR_materials_transmission', t);
		// Transmission replaces alpha blending entirely; a material carrying both
		// double-composites and reads milky.
		material.setAlphaMode('OPAQUE');
		if (ext.thickness != null) {
			const v = doc.createExtension(exts.KHRMaterialsVolume).createVolume();
			v.setThicknessFactor(ext.thickness);
			if (ext.attenuationColor) v.setAttenuationColor(ext.attenuationColor);
			if (ext.attenuationDistance != null) v.setAttenuationDistance(ext.attenuationDistance);
			material.setExtension('KHR_materials_volume', v);
		}
	}
	if (ext.clearcoat != null) {
		const c = doc.createExtension(exts.KHRMaterialsClearcoat).createClearcoat();
		c.setClearcoatFactor(ext.clearcoat);
		if (ext.clearcoatRoughness != null) c.setClearcoatRoughnessFactor(ext.clearcoatRoughness);
		material.setExtension('KHR_materials_clearcoat', c);
	}
	if (ext.sheen != null) {
		const s = doc.createExtension(exts.KHRMaterialsSheen).createSheen();
		s.setSheenColorFactor(ext.sheenColor || [1, 1, 1]);
		s.setSheenRoughnessFactor(ext.sheenRoughness ?? 0.5);
		material.setExtension('KHR_materials_sheen', s);
	}
	if (ext.specular != null) {
		const s = doc.createExtension(exts.KHRMaterialsSpecular).createSpecular();
		s.setSpecularFactor(ext.specular);
		material.setExtension('KHR_materials_specular', s);
	}
	if (ext.ior != null) {
		const i = doc.createExtension(exts.KHRMaterialsIOR).createIOR();
		i.setIOR(ext.ior);
		material.setExtension('KHR_materials_ior', i);
	}
	if (ext.anisotropy != null) {
		const a = doc.createExtension(exts.KHRMaterialsAnisotropy).createAnisotropy();
		a.setAnisotropyStrength(ext.anisotropy);
		if (ext.anisotropyRotation != null) a.setAnisotropyRotation(ext.anisotropyRotation);
		material.setExtension('KHR_materials_anisotropy', a);
	}
}

/**
 * Area-weighted smooth vertex normals for an indexed triangle list.
 *
 * Every reconstruction lane measured on 2026-08-01 (nvidia NIM, HuggingFace,
 * trellis_selfhost, Hunyuan3D) ships POSITION with either COLOR_0 or TEXCOORD_0
 * and NO NORMAL attribute at all. glTF 2.0 3.7.2.1 then requires the client to
 * calculate FLAT normals, and three.js' GLTFLoader complies by forcing
 * `flatShading = true` on the material, so every forge model renders visibly
 * faceted. On marching-cubes organic surfaces that is the wrong answer, and it
 * also wastes the derived normal map: relief detail cannot read on a surface
 * whose base shading already breaks at every triangle edge.
 *
 * Accumulating the raw cross product (whose magnitude is twice the triangle
 * area) weights each face by its area automatically, which is what keeps a dense
 * cluster of small triangles from outvoting the large face it sits on.
 *
 * @param {Float32Array|number[]} positions  flat xyz triples
 * @param {Uint32Array|Uint16Array|number[]} indices  triangle list
 * @returns {Float32Array} flat xyz normal triples, one per vertex
 */
export function smoothNormals(positions, indices) {
	const out = new Float32Array(positions.length);
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const a = indices[i] * 3;
		const b = indices[i + 1] * 3;
		const c = indices[i + 2] * 3;
		const abx = positions[b] - positions[a];
		const aby = positions[b + 1] - positions[a + 1];
		const abz = positions[b + 2] - positions[a + 2];
		const acx = positions[c] - positions[a];
		const acy = positions[c + 1] - positions[a + 1];
		const acz = positions[c + 2] - positions[a + 2];
		const nx = aby * acz - abz * acy;
		const ny = abz * acx - abx * acz;
		const nz = abx * acy - aby * acx;
		out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
		out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
		out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
	}
	for (let i = 0; i < out.length; i += 3) {
		const len = Math.hypot(out[i], out[i + 1], out[i + 2]);
		if (len > 0) {
			out[i] /= len;
			out[i + 1] /= len;
			out[i + 2] /= len;
		} else {
			// A vertex referenced by no triangle (or by degenerate ones only) has no
			// defined normal; +Y keeps it a unit vector so the accessor stays valid.
			out[i + 1] = 1;
		}
	}
	return out;
}

/**
 * Fill in the NORMAL attribute on every indexed primitive that lacks one.
 * Existing normals are never touched: a lane that does emit them knows the
 * surface better than a recompute would.
 *
 * @param {import('@gltf-transform/core').Document} doc
 * @returns {number} primitives given normals
 */
export function ensureVertexNormals(doc) {
	let filled = 0;
	let buffer = null;
	for (const mesh of doc.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			if (prim.getAttribute('NORMAL')) continue;
			const position = prim.getAttribute('POSITION');
			const indices = prim.getIndices();
			// Un-indexed geometry has no shared vertices to smooth ACROSS, so the
			// only normals derivable from it are the flat ones the runtime already
			// generates. Leave it alone rather than bake the same result into bytes.
			if (!position || !indices) continue;
			const normals = smoothNormals(position.getArray(), indices.getArray());
			if (!buffer) buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();
			prim.setAttribute(
				'NORMAL',
				doc.createAccessor(`${mesh.getName() || 'mesh'}_normal`).setType('VEC3').setArray(normals).setBuffer(buffer),
			);
			filled++;
		}
	}
	return filled;
}

// glTF 2.0 permits exactly two image types, and both are identifiable from their
// first bytes. A texture whose declared mimeType disagrees with its magic is a
// spec violation that strict validators reject and that makes every downstream
// size/format read (including this module's own) return nonsense.
function sniffMime(bytes) {
	if (!bytes || bytes.byteLength < 8) return null;
	const b = bytes;
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
	return null;
}

/**
 * Repair textures whose declared mimeType contradicts their bytes. Returns the
 * number of textures corrected.
 *
 * @param {import('@gltf-transform/core').Document} doc
 * @returns {number}
 */
export function normalizeTextureMimeTypes(doc) {
	let fixed = 0;
	for (const tex of doc.getRoot().listTextures()) {
		const actual = sniffMime(tex.getImage());
		if (actual && actual !== tex.getMimeType()) {
			tex.setMimeType(actual);
			fixed++;
		}
	}
	return fixed;
}

/**
 * Give every primitive that has no material a real one. Without this the glTF
 * default material applies, and its metallicFactor of 1.0 makes vertex-colored
 * reconstruction output render as rough metal.
 *
 * One material is created per resolved class and shared across the primitives
 * that resolve to it, so a multi-primitive mesh does not grow a material each.
 *
 * @param {import('@gltf-transform/core').Document} doc
 * @param {{ prompt?: string, subjectClass?: string, materialClass?: string }} ctx
 * @returns {Array<{ name: string, materialClass: string }>} the materials created
 */
export function ensureMaterials(doc, ctx = {}) {
	const created = [];
	const byClass = new Map();
	for (const mesh of doc.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			if (prim.getMaterial()) continue;
			const clsId = resolveMaterialClass({ materialName: mesh.getName() || '', ...ctx });
			let material = byClass.get(clsId);
			if (!material) {
				const cls = MATERIAL_CLASSES[clsId];
				const name = `${clsId}_derived`;
				material = doc
					.createMaterial(name)
					.setBaseColorFactor([1, 1, 1, 1])
					.setMetallicFactor(cls.metallic)
					.setRoughnessFactor(cls.roughness.base);
				byClass.set(clsId, material);
				created.push({ name, materialClass: clsId });
			}
			prim.setMaterial(material);
		}
	}
	return created;
}

/**
 * Derive the missing PBR channels for every material in a GLB.
 *
 * A material that already carries a channel keeps it: this pass only ever fills
 * gaps, so a lane that starts emitting real normals (or a user's own textured
 * upload) is never overwritten by an estimate.
 *
 * @param {Buffer|Uint8Array} buf  source GLB bytes
 * @param {object} [opts]
 * @param {string} [opts.prompt]         the generation prompt, for classification
 * @param {string} [opts.subjectClass]   forge-enhance.js's subject class
 * @param {string} [opts.materialClass]  explicit override, a MATERIAL_CLASSES key
 * @param {string} [opts.tier]           'draft' | 'standard' | 'high', derived-map size
 * @param {number} [opts.maxSize]        explicit derived-map cap, overrides tier
 * @returns {Promise<{
 *   buffer: Buffer,
 *   changed: boolean,
 *   inputBytes: number,
 *   outputBytes: number,
 *   materialsCreated: number,
 *   normalsFilled: number,
 *   mimeTypesFixed: number,
 *   materials: Array<{ name: string, materialClass: string, derived: string[] }>,
 * }>}
 */
export async function derivePbrChannels(buf, opts = {}) {
	if (!buf || typeof buf.byteLength !== 'number' || buf.byteLength < 20) {
		throw new Error('derivePbrChannels: input is not a GLB buffer');
	}
	const input = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	const inputBytes = input.byteLength;
	const maxSize = Number.isFinite(opts.maxSize)
		? Math.max(64, Math.min(4096, Math.round(opts.maxSize)))
		: TIER_DERIVED_SIZE[opts.tier] || DEFAULT_DERIVED_SIZE;

	const io = await derivedIO();
	const exts = await import('@gltf-transform/extensions');
	const sharpMod = await import('sharp');
	const sharp = sharpMod.default ?? sharpMod;

	const doc = await io.readBinary(input);
	const root = doc.getRoot();
	const report = [];

	// A derived map is written as WebP, so the document has to declare
	// EXT_texture_webp for the GLB to be valid. Created LAZILY on the first
	// derived texture: gltf-transform keeps a created-but-unused extension in
	// extensionsUsed, and a run that derives no map at all (an untextured
	// vertex-colored mesh, where only the measured factors land) must not ship a
	// GLB claiming an extension it never uses.
	let webpExtension = null;
	const declareWebp = () => {
		if (!webpExtension) webpExtension = doc.createExtension(exts.EXTTextureWebP).setRequired(false);
		return webpExtension;
	};

	// Classify the subject once from the prompt when the caller did not, keeping
	// the match position: resolveMaterialClass weighs the subject against the
	// prompt's material words by which one is mentioned first, and that contest
	// needs both offsets.
	let subjectClass = String(opts.subjectClass || '').trim();
	let subjectIndex = -1;
	if (!subjectClass && opts.prompt) {
		try {
			const { classifySubjectAt } = await import('../forge-enhance.js');
			const hit = classifySubjectAt(opts.prompt);
			subjectClass = hit.subject;
			subjectIndex = hit.index;
		} catch (err) {
			console.warn('[pbr-derive] subject classification unavailable:', err?.message);
		}
	}
	const classifyCtx = { prompt: opts.prompt, subjectClass, subjectIndex, materialClass: opts.materialClass };

	// Repair first: a mislabeled mime breaks the decode below, and a primitive
	// with no material has nothing to derive onto.
	const mimeTypesFixed = normalizeTextureMimeTypes(doc);
	const created = ensureMaterials(doc, classifyCtx);
	const normalsFilled = ensureVertexNormals(doc);
	let changed = mimeTypesFixed > 0 || created.length > 0 || normalsFilled > 0;

	for (const material of root.listMaterials()) {
		const name = material.getName() || '';
		const clsId = resolveMaterialClass({ materialName: name, ...classifyCtx });
		const cls = MATERIAL_CLASSES[clsId];
		const derived = [];

		const baseTex = material.getBaseColorTexture();
		const hasNormal = !!material.getNormalTexture();
		const hasMr = !!material.getMetallicRoughnessTexture();
		const hasAo = !!material.getOcclusionTexture();

		let field = null;
		if (baseTex && (!hasNormal || !hasMr || !hasAo)) {
			try {
				field = await heightFieldFrom(sharp, baseTex.getImage(), maxSize);
			} catch (err) {
				console.warn(`[pbr-derive] height field failed for "${name || '(unnamed)'}":`, err?.message);
			}
		}

		if (field && !hasNormal) {
			const rgb = normalFromHeight(field.luma, field.width, field.height, cls.normalStrength);
			const webp = await encodeMap(sharp, rgb, field.width, field.height, NORMAL_WEBP);
			declareWebp();
			const tex = doc.createTexture(`${name || 'material'}_normal`).setImage(webp).setMimeType('image/webp');
			material.setNormalTexture(tex);
			// Match the albedo's UV set, or the derived map samples the wrong atlas.
			const info = material.getNormalTextureInfo();
			const baseInfo = material.getBaseColorTextureInfo();
			if (info && baseInfo) info.setTexCoord(baseInfo.getTexCoord());
			material.setNormalScale(1);
			derived.push('normal');
			changed = true;
		}

		if (field && (!hasMr || !hasAo)) {
			const half = halveField(field.luma, field.width, field.height);
			const blurred = boxBlur(half.data, half.width, half.height, Math.max(2, Math.round(half.width / 128)));
			const rgb = packOrm(half.data, blurred, half.width, half.height, cls);
			const webp = await encodeMap(sharp, rgb, half.width, half.height, ORM_WEBP);
			declareWebp();
			const tex = doc.createTexture(`${name || 'material'}_orm`).setImage(webp).setMimeType('image/webp');
			const baseInfo = material.getBaseColorTextureInfo();
			if (!hasMr) {
				material.setMetallicRoughnessTexture(tex);
				// A metallicRoughness texture is MULTIPLIED by the factors, so the
				// factors must be 1 for the map to drive the result rather than
				// scale it toward whatever the lane happened to leave behind.
				material.setMetallicFactor(1);
				material.setRoughnessFactor(1);
				const info = material.getMetallicRoughnessTextureInfo();
				if (info && baseInfo) info.setTexCoord(baseInfo.getTexCoord());
				derived.push('metallicRoughness');
			}
			if (!hasAo) {
				material.setOcclusionTexture(tex);
				material.setOcclusionStrength(1);
				const info = material.getOcclusionTextureInfo();
				if (info && baseInfo) info.setTexCoord(baseInfo.getTexCoord());
				derived.push('occlusion');
			}
			changed = true;
		}

		// No albedo to derive from (or every map already present): the measured
		// factors still have to land, otherwise an untextured lane output keeps
		// the lane's arbitrary metallic/roughness guess.
		if (!hasMr && !derived.includes('metallicRoughness')) {
			material.setMetallicFactor(cls.metallic);
			material.setRoughnessFactor(cls.roughness.base);
			derived.push('factors');
			changed = true;
		}

		if (Object.keys(cls.ext).length) {
			applyExtensionLayer(doc, material, cls.ext, exts);
			derived.push('extensions');
			changed = true;
		}

		report.push({ name: name || '(unnamed)', materialClass: clsId, derived });
	}

	if (!changed) {
		return {
			buffer: Buffer.from(input),
			changed: false,
			inputBytes,
			outputBytes: inputBytes,
			materialsCreated: 0,
			normalsFilled: 0,
			mimeTypesFixed: 0,
			materials: report,
		};
	}

	const out = Buffer.from(await io.writeBinary(doc));
	return {
		buffer: out,
		changed: true,
		inputBytes,
		outputBytes: out.byteLength,
		materialsCreated: created.length,
		normalsFilled,
		mimeTypesFixed,
		materials: report,
	};
}
