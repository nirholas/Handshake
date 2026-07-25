// Spatial MCP — the open shape for 3D-native tool results, and its validator.
//
// MCP tool results are text/JSON today. A *spatial* MCP artifact carries a live,
// interactive 3D scene as a first-class structured-content field so a host can
// render it (orbit, animate, AR) instead of printing a URL. This module is the
// single source of truth for that shape:
//
//   • buildSpatialArtifact(...) — assemble a conformant artifact from the
//     fields a generation tool already has (glbUrl, kind, prompt, …).
//   • validateSpatialArtifact(payload) — check conformance and return ACTIONABLE
//     errors ({ path, message }), not a bare boolean. Used as the gate every
//     three.ws 3D tool passes its artifact through, and callable by third-party
//     servers adopting the shape.
//
// WHY IT LIVES IN /public, NEXT TO THE RENDERER
// A spec's validator is only useful where the mistakes happen: in the browser of
// whoever is building an adapter. Sitting here it is loadable three ways from one
// implementation, with no copy to drift:
//
//   1. the reference renderer page (/spatial-mcp) imports it as a sibling module
//      and shows live conformance for every payload on screen;
//   2. a third party imports it straight off the published URL, exactly as
//      docs/spatial-mcp.md already instructs for the renderer:
//        import { validateSpatialArtifact } from 'https://three.ws/spatial-mcp/spatial-validator.js';
//   3. server-side code re-exports it from api/_lib/spatial-mcp.js, which is the
//      import path every three.ws tool already uses.
//
// It is intentionally dependency-free (no Ajv, no fetch, no DB) so it loads
// unchanged in the api/ bundle, a published npm package, the free OpenAI studio,
// a plain browser, and the unit tests, and carries ZERO payment, wallet, coin, or
// token surface, so the renderer and validator drop cleanly into the crypto-free
// OpenAI app. Spec: specs/SPATIAL_MCP.md.

export const SPATIAL_MCP_VERSION = '0.1';

// Versions this validator accepts. New minor versions are added here as the
// shape evolves; a host reads spatialMcpVersion to pick its renderer.
const KNOWN_VERSIONS = new Set(['0.1']);

// The subject a 3D artifact describes. Open enum — a host that doesn't know a
// kind still renders scene.glbUrl; the kind only drives labelling/affordances.
const KNOWN_KINDS = new Set(['model', 'mesh', 'avatar', 'rigged-model', 'scene']);

const TOP_LEVEL_KEYS = new Set([
	'spatialMcpVersion',
	'kind',
	'scene',
	'camera',
	'environment',
	'animation',
	'persona',
	'ar',
	'affordances',
	'meta',
]);

// A conservative https check — the renderer only ever loads assets over https,
// and rejecting other schemes at the boundary keeps data: / javascript: / http
// out of a field a host will feed to <model-viewer src>.
function isHttpsUrl(v) {
	if (typeof v !== 'string' || !v) return false;
	try {
		return new URL(v).protocol === 'https:';
	} catch {
		return false;
	}
}

function isPlainObject(v) {
	return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Assemble a spec-conformant spatial artifact from the fields a generation tool
 * already has. Only `glbUrl` is required; everything else is optional and only
 * emitted when provided, so the output is always valid and never carries empty
 * scaffolding. Pure and deterministic.
 *
 * @param {object} a
 * @param {string} a.glbUrl                 the generated asset (https)
 * @param {string} [a.kind]                 one of KNOWN_KINDS (default 'model')
 * @param {string} [a.viewerUrl]            three.ws viewer link (meta)
 * @param {string} [a.poster]               preview image (https)
 * @param {string} [a.prompt]               the generating prompt (meta)
 * @param {string} [a.title]                human title (meta)
 * @param {boolean}[a.autoRotate]           camera auto-rotate (default true)
 * @param {string} [a.cameraOrbit]          model-viewer camera-orbit string
 * @param {boolean}[a.rigged]               true → animation hooks enabled
 * @param {string[]}[a.clips]               named animation clips
 * @param {string} [a.personaId]            persona binding (prompt 07)
 * @param {{usdzUrl?:string,glbUrl?:string,launchUrl?:string}} [a.ar]  AR handoff (prompt 21)
 * @returns {object} a conformant spatial artifact
 */
export function buildSpatialArtifact(a = {}) {
	const kind = KNOWN_KINDS.has(a.kind) ? a.kind : 'model';
	const artifact = {
		spatialMcpVersion: SPATIAL_MCP_VERSION,
		kind,
		scene: {
			glbUrl: a.glbUrl,
			format: 'glb',
			...(a.poster ? { poster: a.poster } : {}),
			...(a.alt ? { alt: a.alt } : {}),
		},
		camera: {
			autoRotate: a.autoRotate !== false,
			...(a.cameraOrbit ? { orbit: a.cameraOrbit } : {}),
		},
		environment: {
			image: a.environmentImage || 'neutral',
			exposure: typeof a.exposure === 'number' ? a.exposure : 1,
			shadowIntensity: typeof a.shadowIntensity === 'number' ? a.shadowIntensity : 1,
		},
		affordances: {
			orbit: true,
			zoom: true,
			fullscreen: true,
			download: a.download !== false,
		},
	};

	// Animation hooks only when the asset is actually rigged/animated.
	if (a.rigged || (Array.isArray(a.clips) && a.clips.length)) {
		artifact.animation = {
			autoplay: a.autoplay !== false,
			...(Array.isArray(a.clips) && a.clips.length ? { clips: a.clips.slice(0, 64) } : {}),
		};
	}

	// Persona hook (prompt 07) — a speakable embodied body.
	if (a.personaId) {
		artifact.persona = { id: String(a.personaId), speakable: true };
	}

	// AR handoff (prompt 21). `supported` is true when any concrete AR asset/link
	// is present; a host without AR ignores this block and renders the WebGL scene.
	if (a.ar && isPlainObject(a.ar)) {
		const ar = {};
		if (isHttpsUrl(a.ar.usdzUrl)) ar.usdzUrl = a.ar.usdzUrl;
		if (isHttpsUrl(a.ar.glbUrl)) ar.glbUrl = a.ar.glbUrl;
		if (isHttpsUrl(a.ar.launchUrl)) ar.launchUrl = a.ar.launchUrl;
		if (Object.keys(ar).length) {
			ar.supported = true;
			artifact.ar = ar;
		}
	}

	const meta = {};
	if (a.prompt) meta.prompt = String(a.prompt);
	if (a.title) meta.title = String(a.title);
	if (isHttpsUrl(a.viewerUrl)) meta.viewerUrl = a.viewerUrl;
	if (Object.keys(meta).length) artifact.meta = meta;

	return artifact;
}

// ── Validator ────────────────────────────────────────────────────────────────

function err(errors, path, message) {
	errors.push({ path, message });
}
function warn(warnings, path, message) {
	warnings.push({ path, message });
}

/**
 * Validate a spatial artifact against the spec. Returns actionable diagnostics —
 * every problem names the offending `path` and how to fix it — so a caller (a
 * third-party server adopting the shape, or a three.ws tool's self-check) can
 * correct its output, not just learn that it's wrong.
 *
 * @param {any} payload
 * @returns {{ valid:boolean, version:(string|null), errors:Array<{path,message}>,
 *             warnings:Array<{path,message}> }}
 */
export function validateSpatialArtifact(payload) {
	const errors = [];
	const warnings = [];

	if (!isPlainObject(payload)) {
		return {
			valid: false,
			version: null,
			errors: [{ path: '(root)', message: 'artifact must be a JSON object' }],
			warnings,
		};
	}

	// Version.
	const version = payload.spatialMcpVersion ?? null;
	if (version == null) {
		err(errors, 'spatialMcpVersion', `required — set it to "${SPATIAL_MCP_VERSION}"`);
	} else if (typeof version !== 'string' || !KNOWN_VERSIONS.has(version)) {
		err(errors, 'spatialMcpVersion', `unknown version ${JSON.stringify(version)} — supported: ${[...KNOWN_VERSIONS].join(', ')}`);
	}

	// Kind.
	if (payload.kind == null) {
		err(errors, 'kind', `required — one of ${[...KNOWN_KINDS].join(', ')}`);
	} else if (!KNOWN_KINDS.has(payload.kind)) {
		err(errors, 'kind', `unknown kind ${JSON.stringify(payload.kind)} — expected one of ${[...KNOWN_KINDS].join(', ')}`);
	}

	// Scene (required, with a required https glbUrl).
	if (!isPlainObject(payload.scene)) {
		err(errors, 'scene', 'required object with a `glbUrl`');
	} else {
		if (!isHttpsUrl(payload.scene.glbUrl)) {
			err(errors, 'scene.glbUrl', 'required — must be an https URL to a .glb asset');
		}
		if (payload.scene.format !== undefined && payload.scene.format !== 'glb') {
			err(errors, 'scene.format', 'only "glb" is supported in v0.1');
		} else if (payload.scene.format === undefined) {
			warn(warnings, 'scene.format', 'recommended — set to "glb"');
		}
		if (payload.scene.poster !== undefined && !isHttpsUrl(payload.scene.poster)) {
			err(errors, 'scene.poster', 'must be an https URL when present');
		}
	}

	// Optional blocks — validate shape/types only when present.
	if (payload.camera !== undefined) {
		if (!isPlainObject(payload.camera)) err(errors, 'camera', 'must be an object when present');
		else if (payload.camera.autoRotate !== undefined && typeof payload.camera.autoRotate !== 'boolean')
			err(errors, 'camera.autoRotate', 'must be a boolean');
	} else {
		warn(warnings, 'camera', 'recommended — include `{ autoRotate: true }` so hosts frame the model');
	}

	if (payload.environment !== undefined && !isPlainObject(payload.environment)) {
		err(errors, 'environment', 'must be an object when present');
	}

	if (payload.animation !== undefined) {
		if (!isPlainObject(payload.animation)) err(errors, 'animation', 'must be an object when present');
		else if (payload.animation.clips !== undefined && !Array.isArray(payload.animation.clips))
			err(errors, 'animation.clips', 'must be an array of clip names');
	}

	if (payload.persona !== undefined && !isPlainObject(payload.persona)) {
		err(errors, 'persona', 'must be an object when present');
	}

	if (payload.ar !== undefined) {
		if (!isPlainObject(payload.ar)) {
			err(errors, 'ar', 'must be an object when present');
		} else {
			for (const k of ['usdzUrl', 'glbUrl', 'launchUrl']) {
				if (payload.ar[k] !== undefined && !isHttpsUrl(payload.ar[k]))
					err(errors, `ar.${k}`, 'must be an https URL when present');
			}
			const hasAsset = ['usdzUrl', 'glbUrl', 'launchUrl'].some((k) => isHttpsUrl(payload.ar[k]));
			if (payload.ar.supported === true && !hasAsset)
				err(errors, 'ar.supported', 'true requires at least one of ar.usdzUrl / ar.glbUrl / ar.launchUrl');
		}
	}

	if (payload.affordances !== undefined && !isPlainObject(payload.affordances)) {
		err(errors, 'affordances', 'must be an object when present');
	}

	if (payload.meta !== undefined && !isPlainObject(payload.meta)) {
		err(errors, 'meta', 'must be an object when present');
	}

	// Unknown top-level keys are a warning, not an error — forward-compatibility
	// with hosts that carry extra fields, but flagged so typos surface.
	for (const key of Object.keys(payload)) {
		if (!TOP_LEVEL_KEYS.has(key)) warn(warnings, key, 'unknown top-level field — ignored by conformant renderers');
	}

	return {
		valid: errors.length === 0,
		version: typeof version === 'string' ? version : null,
		errors,
		warnings,
	};
}

/** Convenience: true iff `payload` is a conformant artifact. */
export function isConformantSpatialArtifact(payload) {
	return validateSpatialArtifact(payload).valid;
}

// ── Data-minimization lint ───────────────────────────────────────────────────
// The spec REQUIRES emitters to strip internal identifiers, wallets, prices, and
// auth material from the artifact: that is what keeps the shape reusable in
// crypto-free stores. The spec used to admit "the reference validator does not
// police this". This lint closes that gap as far as a generic checker can: it
// cannot know your internal field names, but it can flag the ones everyone uses.

// Key names that have no business in a human-facing artifact. Checked against
// meta (the free-form block) and any unknown top-level field an emitter carried.
const SUSPICIOUS_KEY = /(session|job|creation|prediction|trace|request|task|tenant|user)[-_]?id$|^(wallet|address|mint|price|amount|cost|fee|token|secret|bearer|auth|signature|payment)|api[-_]?key/i;

// Value shapes that look like credentials or on-chain identifiers, wherever they
// appear in meta: EVM address, plausible base58 account, JWT, bearer/hex secrets.
const SUSPICIOUS_VALUE = [
	{ re: /^0x[0-9a-fA-F]{40}$/, what: 'an EVM address' },
	{ re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, what: 'a base58 account/mint-shaped value' },
	{ re: /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\./, what: 'a JWT' },
	{ re: /^(sk|pk|rk)[-_][A-Za-z0-9]{16,}$/, what: 'an API-key-shaped value' },
];

/**
 * Lint an artifact for data-minimization violations. Returns warnings, not
 * errors: field names are heuristics, and a false positive must never block a
 * conformant render. An empty array means nothing suspicious was found, not a
 * guarantee — emitters still own the requirement.
 *
 * @param {any} payload
 * @returns {Array<{path:string, message:string}>}
 */
export function lintSpatialMeta(payload) {
	const findings = [];
	if (!isPlainObject(payload)) return findings;

	const scan = (obj, base) => {
		for (const [key, value] of Object.entries(obj)) {
			const path = `${base}.${key}`;
			if (SUSPICIOUS_KEY.test(key)) {
				findings.push({ path, message: 'looks like an internal/auth/coin field — the spec requires emitters to strip these (data minimization)' });
				continue;
			}
			if (typeof value === 'string') {
				// URLs are the block's job (viewerUrl, poster); skip them.
				if (/^https:\/\//.test(value)) continue;
				const hit = SUSPICIOUS_VALUE.find((s) => s.re.test(value.trim()));
				if (hit) findings.push({ path, message: `value looks like ${hit.what} — strip it before emitting (data minimization)` });
			} else if (isPlainObject(value)) {
				scan(value, path);
			}
		}
	};

	if (isPlainObject(payload.meta)) scan(payload.meta, 'meta');
	// Unknown top-level fields are already a conformance warning; here they also
	// get the privacy check, because that is where internal ids tend to ride.
	for (const key of Object.keys(payload)) {
		if (TOP_LEVEL_KEYS.has(key)) continue;
		if (SUSPICIOUS_KEY.test(key)) {
			findings.push({ path: key, message: 'looks like an internal/auth/coin field — the spec requires emitters to strip these (data minimization)' });
		} else if (isPlainObject(payload[key])) {
			scan(payload[key], key);
		}
	}
	return findings;
}
