// Material Studio — server core: AI PBR restyle + seeded colorway variants +
// durable persistence for arbitrary (non-avatar) GLBs.
//
// Generalizes the Avatar Studio idea — "re-skin what you already have" — to any
// GLB. Two real capabilities live here, both non-destructive (the source GLB is
// never mutated; every call reads fresh bytes and writes a NEW object):
//
//   1. restyleMaterialFromInstruction — "make it chrome" / "wooden" / "cyberpunk"
//      → IBM Granite (watsonx.ai) proposes a glTF 2.0 PBR material (base color,
//      metalness, roughness, emissive) from the description, then @gltf-transform
//      applies those factors onto the target material(s) and re-exports. Mesh
//      geometry and UVs are never touched — only material factors — so the
//      output is guaranteed shape-identical to the input.
//   2. generateSeededVariants — fan one preset out into N reproducible colorway
//      variants using @three-ws/viewer-presets' materialVariants() (mulberry32
//      seeded PRNG — same base + seed always produces byte-identical configs).
//
// Both share one persistence path (validateAndPersistGlb) so every output is a
// real, gltf-validator-checked, durably-stored https URL — never a blob, never
// a mock. One implementation; the web Restyle Studio page (/restyle) calls it
// over api/material-studio.js for free (rate-limited), and the restyle_material
// MCP tool (mcp-server/src/tools/restyle-material.js) calls the SAME HTTP
// endpoint as a thin client, matching the forge_free / refine_model "one core,
// two transports" convention already used across the 3D stack.
//
// Both operations also record an immutable parent → child version lineage using
// the SAME lineage core refine_model uses (mcp-server/src/tools/_lineage.js) —
// a restyle or a variant fan-out is just another kind of version, not a special
// case. Pass the `lineage` array a previous call returned back in as
// `parentLineage` to extend one thread; omit it to start fresh, rooted at the
// source GLB. This is what makes restyle non-destructive in the durable sense
// (not just "Reset in the browser"): every version is a real, separately
// addressable asset, and the thread is exactly the shape prompt 09's remix
// bazaar already consumes for refine_model lineages.

import { randomUUID } from 'node:crypto';
import { putObject, publicUrl } from './r2.js';
import { assertPublicHttpsUrl } from './ssrf.js';
import { fetchSafePublicUrlPinned, MaxBytesExceededError } from './ssrf-guard.js';
import { watsonxConfig, watsonxChatComplete } from './watsonx.js';
import { llmComplete } from './llm.js';
import { materialVariants, materialPreset, MATERIAL_PRESET_NAMES } from '@three-ws/viewer-presets';
import { seedLineage, appendVersion, branchFrom, buildLineageChain } from '../../mcp-server/src/tools/_lineage.js';

const MAX_SOURCE_GLB_BYTES = 64 * 1024 * 1024;
const MAX_VARIANT_COUNT = 12;
const FETCH_TIMEOUT_MS = 30_000;

export class MaterialStudioError extends Error {
	constructor(message, { status = 500, code = 'material_studio_error' } = {}) {
		super(message);
		this.name = 'MaterialStudioError';
		this.status = status;
		this.code = code;
	}
}

function clamp01(n, fallback = 0) {
	const v = Number(n);
	return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

// glTF binary magic — first 4 bytes are ASCII "glTF". Mirrors
// api/_lib/pipeline-stage.js's isGlbMagic so a bad upload/fetch fails the same
// way everywhere in the pipeline.
function isGlbMagic(bytes) {
	return (
		bytes?.length >= 12 &&
		bytes[0] === 0x67 &&
		bytes[1] === 0x6c &&
		bytes[2] === 0x54 &&
		bytes[3] === 0x46
	);
}

function stripJsonFence(text) {
	const raw = String(text || '').trim();
	return raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw;
}

async function fetchGlbBytes(url) {
	let resp;
	try {
		// Pinned guard fetch: the URL is validated upstream, but a validated
		// host could still redirect to an internal address, and validation
		// alone leaves a DNS-rebinding window. The streaming cap replaces the
		// old post-hoc length check.
		resp = await fetchSafePublicUrlPinned(
			url,
			{ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
			{ maxBytes: MAX_SOURCE_GLB_BYTES },
		);
	} catch (err) {
		if (err instanceof MaxBytesExceededError) {
			throw new MaterialStudioError(`source GLB exceeds the ${MAX_SOURCE_GLB_BYTES}-byte limit`, {
				status: 413,
				code: 'source_too_large',
			});
		}
		throw new MaterialStudioError(`could not fetch glb_url: ${err.message}`, {
			status: 502,
			code: 'fetch_failed',
		});
	}
	if (!resp.ok) {
		throw new MaterialStudioError(`glb_url returned ${resp.status}`, {
			status: resp.status === 404 ? 404 : 502,
			code: 'fetch_failed',
		});
	}
	const buf = Buffer.from(await resp.arrayBuffer());
	if (!buf.length) throw new MaterialStudioError('glb_url is empty', { status: 502, code: 'empty_source' });
	if (!isGlbMagic(buf)) {
		throw new MaterialStudioError('glb_url is not a binary glTF (.glb) — its bytes lack the "glTF" magic header', {
			status: 415,
			code: 'unsupported_media_type',
		});
	}
	return buf;
}

// Validate a caller-supplied glb_url (scheme + SSRF + DNS) before ANY fetch.
export async function validateGlbUrl(raw, field = 'glb_url') {
	const value = typeof raw === 'string' ? raw.trim() : '';
	if (!value) throw new MaterialStudioError(`${field} is required`, { status: 400, code: 'missing_url' });
	try {
		return await assertPublicHttpsUrl(value);
	} catch (err) {
		throw new MaterialStudioError(`${field} rejected: ${err.message}`, { status: 400, code: 'invalid_url' });
	}
}

// ── glTF-Transform document I/O (lazy — keeps this module's static import cost
// low for the (more common) code paths that never touch a document, e.g. the
// discovery GET). ────────────────────────────────────────────────────────────

// EXT_meshopt_compression is in ALL_EXTENSIONS, but glTF-Transform still needs
// the codec injected before it can read or write one, and most three.ws avatars
// ship compressed. Without it every compressed source failed here as
// "source GLB failed to parse", which reads like a corrupt upload and is not.
async function meshoptIO() {
	const [{ NodeIO }, { ALL_EXTENSIONS }, { MeshoptDecoder, MeshoptEncoder }] = await Promise.all([
		import('@gltf-transform/core'),
		import('@gltf-transform/extensions'),
		import('meshoptimizer'),
	]);
	await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
	return new NodeIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

async function loadDocument(bytes) {
	const io = await meshoptIO();
	try {
		return await io.readBinary(new Uint8Array(bytes));
	} catch (err) {
		throw new MaterialStudioError(`source GLB failed to parse: ${err.message}`, {
			status: 415,
			code: 'invalid_glb',
		});
	}
}

async function writeAndValidate(doc) {
	const io = await meshoptIO();
	const bytes = await io.writeBinary(doc);

	const { validateBytes } = await import('gltf-validator');
	const report = await validateBytes(bytes).catch((err) => {
		throw new MaterialStudioError(`output GLB failed validation: ${err.message}`, {
			status: 502,
			code: 'validation_threw',
		});
	});
	const numErrors = report?.issues?.numErrors ?? 0;
	if (numErrors > 0) {
		const first = report.issues.messages?.find((m) => m.severity === 0)?.message;
		throw new MaterialStudioError(
			`restyled GLB failed glTF validation (${numErrors} error${numErrors === 1 ? '' : 's'})${first ? `: ${first}` : ''}`,
			{ status: 502, code: 'invalid_output' },
		);
	}
	return bytes;
}

// Apply a flat PBR factor set onto every material in the doc (or just
// `materialIndex` when given). Geometry, accessors, and UVs are untouched —
// this only ever calls the Material setters, never the Mesh/Primitive ones —
// which is what guarantees "preserve mesh + UVs" through a restyle.
//
// `factors` may additionally carry the measured-value extension fields
// (clearcoatFactor/clearcoatRoughnessFactor, transmissionFactor, ior,
// sheenColorFactor/sheenRoughnessFactor) — these are real KHR_materials_*
// extensions, lazily attached to the document only when a factor set
// actually uses them, so a plain restyle never grows a document with unused
// extension declarations.
async function applyFactorsToDoc(doc, factors, materialIndex) {
	const materials = doc.getRoot().listMaterials();
	if (!materials.length) {
		throw new MaterialStudioError('source GLB has no materials to restyle', {
			status: 422,
			code: 'no_materials',
		});
	}
	const targets =
		Number.isInteger(materialIndex) && materials[materialIndex] ? [materials[materialIndex]] : materials;

	const hasClearcoat = factors.clearcoatFactor != null || factors.clearcoatRoughnessFactor != null;
	const hasTransmission = factors.transmissionFactor != null;
	const hasIor = factors.ior != null;
	const hasSheen = Array.isArray(factors.sheenColorFactor) || factors.sheenRoughnessFactor != null;

	let KHRMaterialsClearcoat, KHRMaterialsTransmission, KHRMaterialsIOR, KHRMaterialsSheen;
	if (hasClearcoat || hasTransmission || hasIor || hasSheen) {
		// Extension classes import lazily — the (more common) factor-only
		// restyle path never pays this cost.
		({ KHRMaterialsClearcoat, KHRMaterialsTransmission, KHRMaterialsIOR, KHRMaterialsSheen } = await import(
			'@gltf-transform/extensions'
		));
	}
	let clearcoatExt, transmissionExt, iorExt, sheenExt;

	for (const mat of targets) {
		if (Array.isArray(factors.baseColorFactor) && factors.baseColorFactor.length === 4) {
			mat.setBaseColorFactor(factors.baseColorFactor.map((v, i) => (i === 3 ? clamp01(v, 1) : clamp01(v))));
		} else if (Array.isArray(factors.baseColorFactor) && factors.baseColorFactor.length === 3) {
			mat.setBaseColorFactor([...factors.baseColorFactor.map((v) => clamp01(v)), mat.getBaseColorFactor()[3] ?? 1]);
		}
		if (factors.metallicFactor != null) mat.setMetallicFactor(clamp01(factors.metallicFactor));
		if (factors.roughnessFactor != null) mat.setRoughnessFactor(clamp01(factors.roughnessFactor, 0.5));
		if (Array.isArray(factors.emissiveFactor) && factors.emissiveFactor.length === 3) {
			mat.setEmissiveFactor(factors.emissiveFactor.map((v) => clamp01(v)));
		}
		if (factors.name) mat.setName(factors.name);

		if (hasClearcoat) {
			clearcoatExt = clearcoatExt || doc.createExtension(KHRMaterialsClearcoat);
			const clearcoat = clearcoatExt.createClearcoat();
			if (factors.clearcoatFactor != null) clearcoat.setClearcoatFactor(clamp01(factors.clearcoatFactor));
			if (factors.clearcoatRoughnessFactor != null) {
				clearcoat.setClearcoatRoughnessFactor(clamp01(factors.clearcoatRoughnessFactor));
			}
			mat.setExtension('KHR_materials_clearcoat', clearcoat);
		}
		if (hasTransmission) {
			transmissionExt = transmissionExt || doc.createExtension(KHRMaterialsTransmission);
			const transmission = transmissionExt.createTransmission().setTransmissionFactor(clamp01(factors.transmissionFactor));
			mat.setExtension('KHR_materials_transmission', transmission);
		}
		if (hasIor) {
			iorExt = iorExt || doc.createExtension(KHRMaterialsIOR);
			const ior = iorExt.createIOR().setIOR(Math.min(2.333, Math.max(1, Number(factors.ior) || 1.5)));
			mat.setExtension('KHR_materials_ior', ior);
		}
		if (hasSheen) {
			sheenExt = sheenExt || doc.createExtension(KHRMaterialsSheen);
			const sheen = sheenExt.createSheen();
			if (Array.isArray(factors.sheenColorFactor) && factors.sheenColorFactor.length === 3) {
				sheen.setSheenColorFactor(factors.sheenColorFactor.map((v) => clamp01(v)));
			}
			if (factors.sheenRoughnessFactor != null) sheen.setSheenRoughnessFactor(clamp01(factors.sheenRoughnessFactor));
			mat.setExtension('KHR_materials_sheen', sheen);
		}
	}
	return targets.length;
}

function hexToFactor(hex, fallback = [0.6, 0.6, 0.6]) {
	const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
	if (!m) return fallback;
	const int = parseInt(m[1], 16);
	return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

// ── Lineage ─────────────────────────────────────────────────────────────────

// Resolve the starting lineage: extend the caller-supplied one (validated
// structurally — contiguous indices, single root, no cycles — with
// buildLineageChain), or seed a fresh one rooted at the source GLB. A malformed
// array (buggy client, stale/tampered state) falls back to a fresh lineage
// rather than corrupting history — mirrors handleRefineModel's contract exactly
// (api/_mcp-studio/tools.js) so both "kinds" of 3D versioning behave the same.
export function resolveBaseLineage(rootGlbUrl, parentLineage) {
	const fresh = () => seedLineage({ glbUrl: rootGlbUrl });
	if (!Array.isArray(parentLineage) || parentLineage.length === 0) return fresh();
	const rehydrated = parentLineage.map((v, i) => ({
		index: Number.isInteger(v?.index) ? v.index : i,
		parentIndex: v?.parentIndex ?? (i > 0 ? i - 1 : null),
		glbUrl: v?.glbUrl,
		viewerUrl: v?.viewerUrl || null,
		prompt: v?.prompt || null,
		instruction: v?.instruction || null,
		refKind: v?.refKind || (i === 0 ? 'origin' : 'text'),
	}));
	return buildLineageChain(rehydrated).ok ? rehydrated : fresh();
}

// Branch off an earlier version instead of the lineage's leaf. An out-of-range
// index falls back to `undefined` (appendVersion then defaults to the leaf)
// rather than throwing — a stale parent_index should never fail the call.
export function resolveParentIndex(baseLineage, parentIndex) {
	if (!Number.isInteger(parentIndex)) return undefined;
	try {
		return branchFrom(baseLineage, parentIndex);
	} catch {
		return undefined;
	}
}

// ── Persistence ─────────────────────────────────────────────────────────────

// Validate GLB bytes (magic + gltf-validator) and mirror into R2 under
// material-studio/<uuid>.glb. Every function below funnels through this so
// every URL this module ever hands back is a real, checked, durable asset.
export async function validateAndPersistGlb(bytes, { keyPrefix = 'material-studio' } = {}) {
	if (!bytes?.length) throw new MaterialStudioError('no GLB bytes to persist', { status: 400, code: 'empty_input' });
	if (bytes.length > MAX_SOURCE_GLB_BYTES) {
		throw new MaterialStudioError(`GLB is ${bytes.length} bytes; max is ${MAX_SOURCE_GLB_BYTES}`, {
			status: 413,
			code: 'too_large',
		});
	}
	if (!isGlbMagic(bytes)) {
		throw new MaterialStudioError('not a binary glTF (.glb) — bytes lack the "glTF" magic header', {
			status: 415,
			code: 'unsupported_media_type',
		});
	}
	const { validateBytes } = await import('gltf-validator');
	const report = await validateBytes(new Uint8Array(bytes)).catch((err) => {
		throw new MaterialStudioError(`GLB failed validation: ${err.message}`, { status: 422, code: 'validation_threw' });
	});
	const numErrors = report?.issues?.numErrors ?? 0;
	if (numErrors > 0) {
		throw new MaterialStudioError(`GLB failed glTF validation (${numErrors} error${numErrors === 1 ? '' : 's'})`, {
			status: 422,
			code: 'invalid_glb',
		});
	}
	const key = `${keyPrefix}/${randomUUID()}.glb`;
	await putObject({ key, body: bytes, contentType: 'model/gltf-binary', metadata: { source: 'material-studio' } });
	return { url: publicUrl(key), bytes: bytes.length, key };
}

// ── 1. AI restyle: instruction → PBR factors → applied + persisted GLB ──────

// A full PBR answer (name, three factor triples, the optional clearcoat /
// transmission / sheen blocks, and a notes sentence) measures ~300 tokens of
// JSON; 400 leaves headroom so a slightly more verbose model returns closing
// braces instead of a fragment that fails the JSON.parse below.
const MATERIAL_AUTHOR_MAX_TOKENS = 400;
// Overall budget across the whole fallback chain, matching the prompt
// director's. A restyle is interactive: the caller is watching a button.
const MATERIAL_AUTHOR_TIMEOUT_MS = 20_000;

// Ask IBM Granite (watsonx.ai) for a glTF PBR material from a plain-language
// description. Same system-prompt shape as the generate_material MCP tool
// (api/_mcp3d/tools/studio.js), factored out here so Material Studio doesn't
// duplicate the watsonx wiring — reuses watsonxConfig/watsonxChatComplete
// directly rather than the tool wrapper (which carries MCP-only concerns).
export async function generateMaterialFactorsFromInstruction(instruction) {
	const trimmed = typeof instruction === 'string' ? instruction.trim() : '';
	if (trimmed.length < 2) {
		throw new MaterialStudioError('instruction must be at least 2 characters', {
			status: 400,
			code: 'invalid_instruction',
		});
	}
	const system =
		'You are a 3D material author. Given a short restyle instruction (e.g. "make it chrome", "wooden", ' +
		'"cyberpunk neon", "car paint", "frosted glass"), return ONLY a valid JSON object describing a glTF 2.0 ' +
		'PBR material with keys: "name" (string), "baseColorFactor" ([r,g,b] 0-1), "metallicFactor" (0-1), ' +
		'"roughnessFactor" (0-1), "emissiveFactor" ([r,g,b] 0-1, [0,0,0] unless the instruction implies glow/light), ' +
		'and "notes" (one short sentence on the look). Additionally, ONLY when the instruction implies these real ' +
		'physical effects, include: "clearcoatFactor" (0-1) + "clearcoatRoughnessFactor" (0-1) for a lacquered/' +
		'wet/car-paint/varnished look; "transmissionFactor" (0-1) + "ior" (1-2.333, real glass is ~1.45, water ' +
		'~1.33, diamond ~2.42) for see-through glass/liquid/crystal; "sheenColorFactor" ([r,g,b] 0-1) + ' +
		'"sheenRoughnessFactor" (0-1) for fabric/velvet/skin-like soft grazing highlights. Omit any key that does ' +
		'not apply — do not invent clearcoat/transmission/sheen for a plain metal or plastic instruction. ' +
		'No markdown, no prose outside the JSON.';
	// Two-rung author chain. IBM Granite (watsonx) leads where it is configured
	// because its factors are what the shipped presets were tuned against, and the
	// shared free-first chain (llmComplete: the same ladder forge-enhance and the
	// prompt director ride) backs it up. Before this, an unset WATSONX_API_KEY made
	// restyle a hard 503 on any deployment without an IBM key, which is exactly how
	// production served a dead "AI restyle is not configured" button while a healthy
	// LLM chain sat one call away. Neither rung is required; only an exhausted chain
	// is an error.
	let result = null;
	let lastError = null;
	const cfg = watsonxConfig();
	if (cfg.configured) {
		try {
			result = await watsonxChatComplete(cfg, {
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: trimmed },
				],
				maxTokens: MATERIAL_AUTHOR_MAX_TOKENS,
				temperature: 0.4,
			});
		} catch (err) {
			lastError = err;
			result = null;
		}
	}
	if (!result?.text) {
		try {
			result = await llmComplete({
				system,
				user: trimmed,
				maxTokens: MATERIAL_AUTHOR_MAX_TOKENS,
				timeoutMs: MATERIAL_AUTHOR_TIMEOUT_MS,
				track: { tool: 'material-studio-restyle' },
			});
		} catch (err) {
			lastError = err;
			result = null;
		}
	}
	if (!result?.text) {
		throw new MaterialStudioError(
			`AI restyle could not reach a language model: ${lastError?.message || 'no provider is configured on this deployment'}`,
			{ status: 503, code: 'no_provider' },
		);
	}
	let parsed;
	try {
		parsed = JSON.parse(stripJsonFence(result.text));
	} catch {
		throw new MaterialStudioError('AI restyle model did not return usable material JSON', {
			status: 502,
			code: 'bad_model_output',
		});
	}
	return {
		name: typeof parsed.name === 'string' ? parsed.name.slice(0, 100) : trimmed.slice(0, 60),
		baseColorFactor: Array.isArray(parsed.baseColorFactor) ? parsed.baseColorFactor.slice(0, 3) : null,
		metallicFactor: typeof parsed.metallicFactor === 'number' ? parsed.metallicFactor : null,
		roughnessFactor: typeof parsed.roughnessFactor === 'number' ? parsed.roughnessFactor : null,
		emissiveFactor: Array.isArray(parsed.emissiveFactor) ? parsed.emissiveFactor.slice(0, 3) : [0, 0, 0],
		clearcoatFactor: typeof parsed.clearcoatFactor === 'number' ? parsed.clearcoatFactor : null,
		clearcoatRoughnessFactor: typeof parsed.clearcoatRoughnessFactor === 'number' ? parsed.clearcoatRoughnessFactor : null,
		transmissionFactor: typeof parsed.transmissionFactor === 'number' ? parsed.transmissionFactor : null,
		ior: typeof parsed.ior === 'number' ? parsed.ior : null,
		sheenColorFactor: Array.isArray(parsed.sheenColorFactor) ? parsed.sheenColorFactor.slice(0, 3) : null,
		sheenRoughnessFactor: typeof parsed.sheenRoughnessFactor === 'number' ? parsed.sheenRoughnessFactor : null,
		notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 300) : null,
		model: result.model,
		instruction: trimmed,
	};
}

// Full pipeline: instruction → factors → fetch source → apply → validate →
// persist. Returns the restyled GLB URL plus the factors that were applied, so
// a browser caller (which already has the model loaded) can also apply the
// SAME factors live to its in-memory THREE.Material for an instant preview
// while the durable copy is still uploading.
export async function restyleMaterialFromInstruction({
	glbUrl,
	instruction,
	materialIndex,
	parentLineage,
	parentIndex,
}) {
	const safeUrl = await validateGlbUrl(glbUrl);
	const factors = await generateMaterialFactorsFromInstruction(instruction);
	const sourceBytes = await fetchGlbBytes(safeUrl);
	const doc = await loadDocument(sourceBytes);
	const materialsEdited = await applyFactorsToDoc(doc, factors, materialIndex);
	const outBytes = await writeAndValidate(doc);
	const persisted = await validateAndPersistGlb(Buffer.from(outBytes), { keyPrefix: 'material-studio/restyle' });

	const baseLineage = resolveBaseLineage(safeUrl, parentLineage);
	const resolvedParentIndex = resolveParentIndex(baseLineage, parentIndex);
	const lineage = appendVersion(baseLineage, {
		glbUrl: persisted.url,
		instruction: factors.instruction,
		refKind: 'restyle',
		...(resolvedParentIndex !== undefined ? { parentIndex: resolvedParentIndex } : {}),
	});

	return {
		glbUrl: persisted.url,
		sourceGlbUrl: safeUrl,
		instruction: factors.instruction,
		factors,
		materialsEdited,
		bytes: persisted.bytes,
		lineage,
		activeIndex: lineage.length - 1,
	};
}

// ── 2. Seeded colorway variants ──────────────────────────────────────────────

// Fan one preset (or the model's current look, approximated by `preset`) out
// into `count` reproducible variants and persist each as its own GLB. Same
// base + seed always yields byte-identical factor sets (materialVariants'
// mulberry32 PRNG) and, downstream, byte-identical GLBs — reproducible in the
// literal sense, not just "looks similar."
export async function generateSeededVariants({
	glbUrl,
	preset = 'chrome',
	seed = 0,
	count = 6,
	materialIndex,
	parentLineage,
	parentIndex,
}) {
	if (!MATERIAL_PRESET_NAMES.includes(preset)) {
		throw new MaterialStudioError(`unknown preset "${preset}" — known: ${MATERIAL_PRESET_NAMES.join(', ')}`, {
			status: 400,
			code: 'invalid_preset',
		});
	}
	const safeUrl = await validateGlbUrl(glbUrl);
	const n = Math.max(1, Math.min(MAX_VARIANT_COUNT, Number(count) || 6));
	const seedNum = Number.isInteger(seed) ? seed >>> 0 : 0;
	const base = materialPreset(preset);
	const variants = materialVariants(base, { seed: seedNum, count: n });
	const sourceBytes = await fetchGlbBytes(safeUrl);

	// Every variant is an independent sibling branching off the SAME parent (the
	// source model) — resolve that shared parent once, up front, so appending
	// variant 2 never accidentally chains off variant 1.
	const baseLineage = resolveBaseLineage(safeUrl, parentLineage);
	const sharedParentIndex = resolveParentIndex(baseLineage, parentIndex) ?? baseLineage.length - 1;
	let lineage = baseLineage;

	const results = [];
	for (const variant of variants) {
		// Reload the document fresh from the untouched source bytes for every
		// variant — applying variant N onto a doc already mutated by variant
		// N-1 would compound edits instead of fanning out N independent looks.
		const doc = await loadDocument(sourceBytes);
		const factors = {
			baseColorFactor: hexToFactor(variant.config.color),
			metallicFactor: variant.config.metalness,
			roughnessFactor: variant.config.roughness,
			emissiveFactor: variant.config.emissive ? hexToFactor(variant.config.emissive, [0, 0, 0]) : [0, 0, 0],
			name: variant.label,
			clearcoatFactor: variant.config.clearcoat ?? null,
			clearcoatRoughnessFactor: variant.config.clearcoatRoughness ?? null,
			transmissionFactor: variant.config.transmission ?? null,
			ior: variant.config.ior ?? null,
			sheenColorFactor: variant.config.sheenColor ? hexToFactor(variant.config.sheenColor, [0, 0, 0]) : null,
			sheenRoughnessFactor: variant.config.sheenRoughness ?? null,
		};
		await applyFactorsToDoc(doc, factors, materialIndex);
		const outBytes = await writeAndValidate(doc);
		const persisted = await validateAndPersistGlb(Buffer.from(outBytes), {
			keyPrefix: 'material-studio/variants',
		});
		lineage = appendVersion(lineage, {
			glbUrl: persisted.url,
			instruction: variant.label,
			refKind: 'variant',
			parentIndex: sharedParentIndex,
		});
		results.push({
			glbUrl: persisted.url,
			label: variant.label,
			seed: variant.seed,
			config: variant.config,
			lineageIndex: lineage.length - 1,
		});
	}
	return {
		sourceGlbUrl: safeUrl,
		preset,
		seed: seedNum,
		count: n,
		variants: results,
		lineage,
		activeIndex: sharedParentIndex,
	};
}
