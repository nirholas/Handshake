// Text → image helper for the 3D Studio MCP.
//
// The image-to-3D backend (Microsoft TRELLIS via Replicate) reconstructs a
// textured GLB from a single reference image. To support `text_to_3d` we first
// turn the prompt into an image with a fast text-to-image model, then feed that
// image into the same reconstruction pipeline. Both steps run on the one
// REPLICATE_API_TOKEN already provisioned for the avatar regen pipeline.
//
//   REPLICATE_API_TOKEN     — required, from replicate.com/account
//   REPLICATE_TXT2IMG_MODEL — optional override (owner/name[:version] or version hash)
//
// Default model: black-forest-labs/flux-schnell — Apache-2.0 weights,
// commercial-OK, ~1–3s per image on Replicate's fleet, $0.003/run. Pinned to
// the model slug (not a version hash) so it tracks Replicate's latest build.

const REPLICATE_BASE = 'https://api.replicate.com/v1';
const DEFAULT_TXT2IMG_MODEL = 'black-forest-labs/flux-schnell';

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name];
	return null;
}

// Pull the first https image URL out of Replicate's `output`, which flux models
// emit as an array of URLs (sometimes a bare string for single-image models).
function extractImageUrl(output) {
	if (!output) return null;
	if (typeof output === 'string') return /^https?:\/\//.test(output) ? output : null;
	if (Array.isArray(output)) {
		for (const v of output) if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
	}
	if (typeof output === 'object') {
		for (const k of ['image', 'url', 'output']) {
			if (typeof output[k] === 'string' && /^https?:\/\//.test(output[k])) return output[k];
		}
	}
	return null;
}

// Generate a single image from a text prompt. Uses Replicate's synchronous
// prediction mode (`Prefer: wait`) so the caller gets a URL back in one round
// trip — flux-schnell is fast enough that the request returns within the MCP
// tool-call window without needing a separate poll.
export async function textToImage(prompt, { aspectRatio = '1:1' } = {}) {
	const token = readEnv('REPLICATE_API_TOKEN');
	if (!token) {
		throw Object.assign(new Error('text-to-3D is not configured (REPLICATE_API_TOKEN missing)'), {
			code: 'unconfigured',
		});
	}

	const modelRef = readEnv('REPLICATE_TXT2IMG_MODEL') || DEFAULT_TXT2IMG_MODEL;
	const isVersionHash = /^[a-f0-9]{40,64}$/i.test(modelRef);
	const slug = modelRef.match(/^([a-z0-9-]+)\/([a-z0-9._-]+)(?::([a-f0-9]+))?$/i);

	const input = {
		prompt,
		aspect_ratio: aspectRatio,
		num_outputs: 1,
		output_format: 'png',
		// A clean, evenly-lit, single-subject image on a plain background
		// reconstructs into a far better mesh than a busy scene — steer flux
		// toward that without overriding a caller's own composition cues.
		go_fast: true,
	};

	let endpoint;
	let body;
	if (isVersionHash) {
		endpoint = `${REPLICATE_BASE}/predictions`;
		body = JSON.stringify({ version: modelRef, input });
	} else if (slug) {
		const [, owner, name, pinned] = slug;
		endpoint = `${REPLICATE_BASE}/models/${owner}/${name}/predictions`;
		body = JSON.stringify(pinned ? { version: pinned, input } : { input });
	} else {
		throw new Error(`invalid REPLICATE_TXT2IMG_MODEL reference: ${modelRef}`);
	}

	let res;
	try {
		res = await fetch(endpoint, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				prefer: 'wait',
			},
			body,
		});
	} catch (err) {
		throw Object.assign(new Error(`text-to-image provider unreachable: ${err?.message}`), {
			code: 'provider_unreachable',
		});
	}

	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data?.detail || data?.title || `text-to-image returned ${res.status}`);
	}

	// With `Prefer: wait` the prediction usually completes inline. If Replicate
	// returned before completion (slow model, timeout), surface the partial
	// state so the handler can decide — but for flux-schnell this is rare.
	const url = extractImageUrl(data.output);
	if (!url) {
		if (data.status && data.status !== 'succeeded') {
			throw new Error(`text-to-image did not complete (status: ${data.status})`);
		}
		throw new Error('text-to-image finished but produced no image');
	}
	return { imageUrl: url, predictionId: data.id, model: modelRef };
}
