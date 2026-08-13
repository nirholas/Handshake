// Vertex AI image-generation client for the 3D forge pipeline.
//
// Turns a text prompt into a reference image that the image-to-3D backend
// (TRELLIS / Hunyuan3D / TripoSR) reconstructs into a textured GLB. The
// reference image drives 3D quality, so this lane's output quality directly
// affects the paid product.
//
// Why route this through Vertex when GCP credits are set:
//   - The $100k GCP credit pool makes it effectively free for the operator
//     (raw list price ~$0.02–0.04/image vs ~$0.003 on Replicate).
//   - Single dependency (GCP) instead of two third-party API keys.
//
// ── Model landscape (verified against Vertex docs, 2026-07) ────────────────
// Google is RETIRING the entire Imagen `:predict` family. The old defaults here
// are dead or dying:
//   - imagen-3.0-generate-001 / -002, imagen-3.0-capability-001 (edit):
//       shut down ~2026-06-30 (already past) — these 404 now.
//   - imagen-4.0-generate-001 / -fast / -ultra: deprecated, discontinued
//       2026-06-30…2026-08-17. A dead end even where still callable.
// The recommended, still-live replacement is the Gemini image model
// `gemini-2.5-flash-image` ("Nano Banana"), which uses the `:generateContent`
// API shape (not `:predict`). It still bills to GCP credits, so it remains the
// credit-burner this lane was built to be — it just talks a different endpoint.
//
// This client supports BOTH shapes and routes on the model id:
//   - id starts with "gemini" → `:generateContent` (default, live)
//   - id starts with "imagen" → legacy `:predict` (for an explicit override
//       while any Imagen endpoint is still callable)
//
// ── Env vars ───────────────────────────────────────────────────────────────
//   GOOGLE_CLOUD_PROJECT       — GCP project id (required)
//   GOOGLE_CLOUD_LOCATION      — region (default: us-central1). Set to "global"
//                                for models only served on the global endpoint.
//   GCP_SERVICE_ACCOUNT_JSON   — service-account key JSON (via gcp-auth.js)
//   VERTEX_IMAGEN_MODEL        — override the generation model
//                                (default: gemini-2.5-flash-image)
//   VERTEX_IMAGEN_EDIT_MODEL   — override the edit model
//                                (default: gemini-2.5-flash-image)
//   VERTEX_IMAGEN_LOCATION     — location for the image models only (falls back
//                                to GOOGLE_CLOUD_LOCATION). Some preview image
//                                models are served only from "global", not
//                                regionally; set it here if the configured
//                                model requires that.
//   VERTEX_IMAGE_SIZE          — requested output resolution, "1K"/"2K"/"4K"
//                                (default: 2K). gemini-2.5-flash-image ignores
//                                it (always 1024px); models that reject the
//                                knob get one retry without it.
//
// Output: a base64 image returned inline as a data: URI. The caller
// (text-to-image.js) uploads it to R2/S3 before handing it to the 3D backend.

import { getGcpAccessToken } from '../_lib/gcp-auth.js';

// Default to the live Gemini image model; the Imagen `:predict` ids it replaced
// are past or near their shutdown (see the model-landscape note above).
const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_EDIT_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_LOCATION = 'us-central1';

// Node's fetch has no default timeout, so a Vertex connection that opens and
// then stalls would pin the request open forever instead of failing over to
// FLUX. The turnaround-view fan-out (text-to-image.js) issues these calls in
// parallel and only waits, so one hung socket there stalls a whole generation.
const VERTEX_TIMEOUT_MS = 90_000;
// The edit lane's source/mask images are ours (R2/S3) in production but the
// argument is caller-supplied, so it gets the short public-fetch budget and a
// hard size ceiling like every other inbound-image path (api/_lib/vision.js).
const SOURCE_IMAGE_TIMEOUT_MS = 8_000;
const MAX_SOURCE_IMAGE_BYTES = 12 * 1024 * 1024;

// Aspect ratios the legacy Imagen `:predict` API accepts (our format → its enum).
const IMAGEN_ASPECT_MAP = {
  '1:1':  '1:1',
  '4:3':  '4:3',
  '3:4':  '3:4',
  '16:9': '16:9',
  '9:16': '9:16',
};

// Gemini image generation accepts a wider set via generationConfig.imageConfig.
const GEMINI_ASPECTS = new Set([
  '1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
]);

function readEnv(name) {
  if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
  return null;
}

// Token minting (service-account JWT→OAuth exchange, caching, metadata-server
// fallback) is shared with the Vertex Claude transport — see api/_lib/gcp-auth.js.

// A model id is a Gemini image model (generateContent shape) unless it's an
// Imagen `:predict` model. Default and unknown ids take the Gemini path.
function isImagenPredictModel(model) {
  return /^imagen/i.test(model);
}

// Vertex's `global` location is served from the un-prefixed host; every regional
// location uses a `${region}-` prefix. Getting this wrong yields a DNS failure.
function aiplatformHost(location) {
  return location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${location}-aiplatform.googleapis.com`;
}

// Map a fetch/HTTP failure onto the same designed error codes the caller's
// fallback ladder already branches on (rate_limited / provider_unreachable /
// providerStatus), so a broken Vertex call degrades to FLUX cleanly.
function throwVertexHttpError(res, data, label) {
  const message =
    data?.error?.message || data?.message || `Vertex AI ${label} returned ${res.status}`;
  if (res.status === 429) {
    throw Object.assign(new Error(message), { code: 'rate_limited', retryAfter: 10 });
  }
  throw Object.assign(new Error(message), { providerStatus: res.status });
}

// Return true if the Vertex image lane is configured (GCP project present).
export function isConfigured() {
  return Boolean(readEnv('GOOGLE_CLOUD_PROJECT'));
}

// Generate an image from a text prompt.
//
// Returns { imageUrl, model } where imageUrl is a data: URI containing the
// base64-encoded image. The caller uploads it to permanent storage.
// Location for the image models specifically. Gemini 3 Pro Image is only
// served from the `global` endpoint while the rest of our Vertex traffic
// (Claude transport, embeddings) stays regional, so the image lane gets its
// own override before falling back to the shared location.
function imageLaneLocation() {
  return (
    readEnv('VERTEX_IMAGEN_LOCATION') ||
    readEnv('GOOGLE_CLOUD_LOCATION_IMAGE') ||
    readEnv('GOOGLE_CLOUD_LOCATION') ||
    DEFAULT_LOCATION
  );
}

export async function generateImage(prompt, { aspectRatio = '1:1' } = {}) {
  const project = readEnv('GOOGLE_CLOUD_PROJECT');
  if (!project) {
    throw Object.assign(
      new Error('Vertex AI image lane is not configured (GOOGLE_CLOUD_PROJECT missing)'),
      { code: 'unconfigured' },
    );
  }

  const location = imageLaneLocation();
  const model = readEnv('VERTEX_IMAGEN_MODEL') || DEFAULT_MODEL;
  const token = await getGcpAccessToken();

  return isImagenPredictModel(model)
    ? generateViaImagenPredict({ prompt, aspectRatio, project, location, model, token })
    : generateViaGemini({ prompt, aspectRatio, project, location, model, token });
}

// ── Gemini image (generateContent) — the live default path ──────────────────
async function generateViaGemini({ prompt, aspectRatio, project, location, model, token }) {
  const aspect = GEMINI_ASPECTS.has(aspectRatio) ? aspectRatio : '1:1';
  const endpoint =
    `${aiplatformHost(location)}/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${model}:generateContent`;

  // Reference-image resolution is the cheapest photoreal lever in the whole
  // chain: the texture painter and multi-view fusion can never recover detail
  // the reference never had. Default to 2K (the model's max) and let
  // VERTEX_IMAGE_SIZE dial it back; credits absorb the price difference.
  const imageSize = (readEnv('VERTEX_IMAGE_SIZE') || '2K').toUpperCase();

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: aspect, imageSize },
    },
  };

  let data;
  try {
    data = await postJson(endpoint, body, token, 'image generation');
  } catch (err) {
    // Older Gemini image models reject imageSize with INVALID_ARGUMENT. Retry
    // once without it rather than failing the lane over an optional knob.
    if (err?.providerStatus !== 400) throw err;
    delete body.generationConfig.imageConfig.imageSize;
    data = await postJson(endpoint, body, token, 'image generation');
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p?.inlineData?.data);
  const b64 = imgPart?.inlineData?.data;
  if (!b64) {
    // A safety block returns candidates with no image part and a finishReason.
    const reason = data?.candidates?.[0]?.finishReason;
    throw new Error(
      `Vertex Gemini returned no image data${reason ? ` (finishReason: ${reason})` : ''}`,
    );
  }
  const mime = imgPart.inlineData.mimeType || 'image/png';
  return { imageUrl: `data:${mime};base64,${b64}`, model: `vertex-ai/${model}` };
}

// ── Imagen (predict) — legacy path for an explicit imagen-* override ─────────
async function generateViaImagenPredict({ prompt, aspectRatio, project, location, model, token }) {
  const aspectEnum = IMAGEN_ASPECT_MAP[aspectRatio] || '1:1';
  const endpoint =
    `${aiplatformHost(location)}/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${model}:predict`;

  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: aspectEnum,
      addWatermark: false,
      safetySetting: 'block_some',
      personGeneration: 'allow_adult',
    },
  };

  const data = await postJson(endpoint, body, token, 'image generation');
  const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('Vertex AI returned no image data');
  return { imageUrl: `data:image/png;base64,${b64}`, model: `vertex-ai/${model}` };
}

// POST a JSON body to Vertex and return the parsed response. Throws a designed
// error (rate_limited / provider_unreachable / providerStatus) on any failure so
// the caller's fallback ladder can branch on it.
async function postJson(endpoint, body, token, label) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VERTEX_TIMEOUT_MS),
    });
  } catch (err) {
    // A blown VERTEX_TIMEOUT_MS aborts the fetch and lands here too, so a stalled
    // socket degrades to the same fallback path as a refused connection.
    const detail = err?.name === 'TimeoutError' ? `no response in ${VERTEX_TIMEOUT_MS}ms` : err?.message;
    throw Object.assign(
      new Error(`Vertex AI ${label} unreachable: ${detail}`),
      { code: 'provider_unreachable' },
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwVertexHttpError(res, data, label);
  return data;
}

// Edit an existing image. Routes the same way as generation: a Gemini model
// takes an image + instruction via generateContent; an explicit imagen-* edit
// model takes the legacy `:predict` inpainting/product shape.
//
// Returns { imageUrl, model }.
export async function editImage(imageUrl, prompt, { maskUrl = null } = {}) {
  const project = readEnv('GOOGLE_CLOUD_PROJECT');
  if (!project) {
    throw Object.assign(
      new Error('Vertex AI image lane is not configured (GOOGLE_CLOUD_PROJECT missing)'),
      { code: 'unconfigured' },
    );
  }

  const location = imageLaneLocation();
  const model = readEnv('VERTEX_IMAGEN_EDIT_MODEL') || DEFAULT_EDIT_MODEL;
  const token = await getGcpAccessToken();

  const source = await imageToInlineData(imageUrl);

  return isImagenPredictModel(model)
    ? editViaImagenPredict({ source, prompt, maskUrl, project, location, model, token })
    : editViaGemini({ source, prompt, project, location, model, token });
}

// Vertex rejects an inlineData part whose mimeType disagrees with the bytes, and
// only accepts image/*. A CDN answering application/octet-stream or a mangled
// data: header falls back to PNG, which is what this lane's own output always is.
function normalizeImageMime(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  return mime.startsWith('image/') ? mime : 'image/png';
}

// Decode a caller-supplied image (data: URI or public URL) into the inline
// base64 + real mime type the edit models want.
async function imageToInlineData(imageUrl) {
  if (typeof imageUrl !== 'string' || !imageUrl) {
    throw Object.assign(
      new Error('editImage needs a base64 data: URI or a public image URL'),
      { code: 'bad_source_image' },
    );
  }

  if (imageUrl.startsWith('data:')) {
    const comma = imageUrl.indexOf(',');
    const header = comma === -1 ? '' : imageUrl.slice('data:'.length, comma);
    const data = comma === -1 ? '' : imageUrl.slice(comma + 1);
    // A percent-encoded (non-base64) data: URI would previously ride through as
    // if it were base64 and make Vertex reject the whole call with an opaque 400.
    if (!header.includes(';base64') || !data) {
      throw Object.assign(
        new Error('editImage source data: URI must be base64-encoded'),
        { code: 'bad_source_image' },
      );
    }
    return { data, mimeType: normalizeImageMime(header) };
  }

  // SSRF-guarded fetch (redirect hops re-validated): the source URL is
  // caller-supplied and the response is render-only input to the edit model.
  const { fetchSafePublicUrl } = await import('../_lib/ssrf-guard.js');
  const res = await fetchSafePublicUrl(imageUrl, {
    signal: AbortSignal.timeout(SOURCE_IMAGE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`cannot fetch image for editing (upstream ${res.status})`);
  // Reject on the advertised length first so an oversize body is never buffered.
  if (Number(res.headers.get('content-length') || 0) > MAX_SOURCE_IMAGE_BYTES) {
    throw Object.assign(new Error('image for editing exceeds the size cap'), { code: 'source_image_too_large' });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_SOURCE_IMAGE_BYTES) {
    throw Object.assign(new Error('image for editing exceeds the size cap'), { code: 'source_image_too_large' });
  }
  return {
    data: buf.toString('base64'),
    mimeType: normalizeImageMime(res.headers.get('content-type')),
  };
}

async function editViaGemini({ source, prompt, project, location, model, token }) {
  const endpoint =
    `${aiplatformHost(location)}/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${model}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: source.mimeType, data: source.data } },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      // Keep multi-view fusion frames at the same 2K bar as the primary
      // reference (see generateViaGemini); retry below strips it for models
      // that reject the knob.
      imageConfig: { imageSize: (readEnv('VERTEX_IMAGE_SIZE') || '2K').toUpperCase() },
    },
  };
  let data;
  try {
    data = await postJson(endpoint, body, token, 'edit');
  } catch (err) {
    if (err?.providerStatus !== 400) throw err;
    delete body.generationConfig.imageConfig;
    data = await postJson(endpoint, body, token, 'edit');
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p?.inlineData?.data);
  const b64 = imgPart?.inlineData?.data;
  if (!b64) throw new Error('Vertex Gemini edit returned no image data');
  const mime = imgPart.inlineData.mimeType || 'image/png';
  return { imageUrl: `data:${mime};base64,${b64}`, model: `vertex-ai/${model}` };
}

async function editViaImagenPredict({ source, prompt, maskUrl, project, location, model, token }) {
  const endpoint =
    `${aiplatformHost(location)}/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${model}:predict`;

  const instance = {
    prompt,
    image: { bytesBase64Encoded: source.data },
    editConfig: { editMode: maskUrl ? 'inpainting-insert' : 'product-image' },
  };
  if (maskUrl) {
    // Same guarded decoder as the source image: the mask URL is caller-supplied
    // too, so it gets the SSRF check, the status check and the size cap rather
    // than a bare fetch whose error body would base64 straight into the request.
    const mask = await imageToInlineData(maskUrl);
    instance.mask = { image: { bytesBase64Encoded: mask.data } };
  }

  const body = {
    instances: [instance],
    parameters: { sampleCount: 1, safetySetting: 'block_some' },
  };
  const data = await postJson(endpoint, body, token, 'edit');
  const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('Vertex AI edit returned no image data');
  return { imageUrl: `data:image/png;base64,${b64}`, model: `vertex-ai/${model}` };
}
