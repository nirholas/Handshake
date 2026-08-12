// Shared image persistence for generated images.
//
// Two call sites grew byte-identical copies of this (api/_mcp3d/text-to-image.js
// for the NIM FLUX artifact, api/_lib/forge-reference-image.js for the Vertex
// Gemini inline data) and the Livepeer federation provider needed a third. The
// rule it enforces matters enough to live in exactly one place:
//
//   Downstream image-to-3D providers take URLs, not inline data (Replicate caps
//   inline data URIs at ~256 KB - a 1024px image blows straight past that), so
//   every synthesized image is persisted to R2 and handed on as a durable
//   public https URL.
//
// The format is sniffed from the magic bytes so the object key extension and
// Content-Type always match the real payload: NIM FLUX returns JPEG artifacts,
// Vertex Imagen and Gemini return PNG, and the Livepeer gateway can serve
// either. Unknown bytes keep the PNG label (the historical default).

import { putObject, publicUrl } from './r2.js';

// 'jpg' | 'png' - sniffed from magic bytes. JPEG: FF D8 FF. Anything else is
// labeled png, matching the legacy behavior of every prior copy of this code.
export function sniffImageFormat(body) {
	const isJpeg = body.length > 2 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
	return isJpeg ? 'jpg' : 'png';
}

// True when the bytes start with a known image signature (JPEG or PNG). The
// federation adapter uses this as the cheap verification gate before paying
// the persistence write: a gateway that answers 200 with an HTML error page or
// an empty body fails here instead of poisoning the reference-image pipeline.
export function looksLikeImageBytes(body) {
	if (!body || body.length < 4) return false;
	if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return true; // JPEG
	return body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47; // PNG
}

// Persist raw image bytes to R2 and return a durable public https URL.
export async function persistImageBytes(body) {
	const ext = sniffImageFormat(body);
	const key = `forge/refs/${globalThis.crypto.randomUUID()}.${ext}`;
	await putObject({ key, body, contentType: ext === 'jpg' ? 'image/jpeg' : 'image/png' });
	return publicUrl(key);
}

// Persist a base64-encoded image. Same behavior as persistImageBytes; kept as
// the named entry point the NIM and Vertex lanes already call.
export async function persistImageBase64(b64) {
	return persistImageBytes(Buffer.from(b64, 'base64'));
}
