// Stability AI provider — fast single-image→3D (Stable Fast 3D).
//
//   image path → POST /v2beta/3d/stable-fast-3d  (multipart/form-data)
//       Reconstructs a textured GLB from one image. Unlike the async geometry
//       providers this responds *synchronously* with the binary GLB (the
//       `model/gltf-binary` body), so there is no task id to poll: we persist
//       the bytes to R2 and hand back a durable public URL, exactly like the
//       NVIDIA NIM synchronous-completion path.
//
// Image-input only — there is no native text→geometry endpoint here, so this
// provider exposes `imageTo3d` and no `textToGeometry`. BYOK only: the caller
// supplies their own Stability key (sk-…); when absent the forge endpoint never
// reaches this module.

import { fetchUpstream } from '../_lib/upstream-fetch.js';

const STABILITY_BASE = 'https://api.stability.ai/v2beta/3d';
const ENDPOINT = 'stable-fast-3d';

// Texture richness follows the tier; foreground_ratio/remesh use Stability's
// sane defaults for a clean, centered reconstruction.
function textureResolutionFor(tier) {
	return tier?.hd ? '2048' : '1024';
}

export function createStabilityProvider(apiKey) {
	if (!apiKey) {
		throw Object.assign(new Error('Stability API key is required'), { code: 'missing_key' });
	}

	return {
		// Single image → textured GLB, returned synchronously and persisted to R2.
		async imageTo3d({ imageUrl, tier }) {
			let imgRes;
			try {
				imgRes = await fetchUpstream(imageUrl, {}, { timeoutMs: 20_000, attempts: 2, okWhen: () => true });
			} catch (err) {
				throw Object.assign(new Error(`could not fetch reference image: ${err?.message}`), {
					code: 'bad_image',
					status: 400,
				});
			}
			if (!imgRes.ok) {
				throw Object.assign(new Error(`reference image fetch returned ${imgRes.status}`), {
					code: 'bad_image',
					status: 400,
				});
			}
			const imageBlob = await imgRes.blob();

			const form = new FormData();
			form.append('image', imageBlob, 'reference.png');
			form.set('texture_resolution', textureResolutionFor(tier));
			form.set('foreground_ratio', '0.85');
			form.set('remesh', 'triangle');

			let res;
			try {
				res = await fetchUpstream(`${STABILITY_BASE}/${ENDPOINT}`, {
					method: 'POST',
					headers: { authorization: `Bearer ${apiKey}`, accept: 'model/gltf-binary' },
					body: form,
				}, { name: 'stability', timeoutMs: 120_000, attempts: 1, okWhen: () => true });
			} catch (err) {
				throw Object.assign(new Error(`stability unreachable: ${err?.message}`), {
					code: 'provider_unreachable',
					status: 502,
				});
			}

			if (res.status === 401 || res.status === 403) {
				throw Object.assign(new Error('Stability rejected the API key.'), {
					code: 'invalid_key',
					status: 401,
					providerStatus: res.status,
				});
			}
			if (res.status === 402) {
				throw Object.assign(new Error('Stability account is out of credits.'), {
					code: 'insufficient_credits',
					status: 402,
					providerStatus: 402,
				});
			}
			if (res.status === 429) {
				throw Object.assign(new Error('Stability is rate limiting this key.'), {
					code: 'rate_limited',
					status: 429,
					providerStatus: 429,
				});
			}
			if (!res.ok) {
				// Errors come back as JSON ({ errors: [...] }); the success body is binary.
				const data = await res.json().catch(() => ({}));
				const msg = Array.isArray(data?.errors) ? data.errors.join('; ') : data?.message;
				throw Object.assign(new Error(msg || `stability returned ${res.status}`), {
					code: 'provider_error',
					status: 502,
					providerStatus: res.status,
				});
			}

			const bytes = Buffer.from(await res.arrayBuffer());
			if (!bytes.length) {
				throw Object.assign(new Error('stability returned an empty model'), {
					code: 'provider_error',
					status: 502,
				});
			}

			const { putObject, publicUrl } = await import('../_lib/r2.js');
			const key = `forge/stability/${globalThis.crypto.randomUUID()}.glb`;
			await putObject({ key, body: bytes, contentType: 'model/gltf-binary' });

			// Synchronous completion: no poll handle, just the durable GLB url.
			return { kind: 'image-to-3d', taskId: null, resultGlbUrl: publicUrl(key) };
		},
	};
}
