// /api/ibm/vision — IBM Granite Vision, the multimodal eye of the watsonx suite.
//
// POST /api/ibm/vision  { image | imageUrl, subject?, hint? }
//   Shows a single image to a Granite Vision model on watsonx.ai and returns a
//   structured "read" of it. The headline demo points it at a three.ws 3D avatar
//   (a rendered snapshot, or its thumbnail) and Granite Vision invents a complete
//   agent identity from how the avatar *looks* — appearance, vibe, persona, a name,
//   a bio, tone tags, a fitting voice. `subject:"token"` reads a coin's image; the
//   default reads any picture.
//
//   image     — a data: URL (client canvas capture or an uploaded file).
//   imageUrl  — an https URL we fetch server-side (SSRF-allowlisted) so the browser
//               never has to fight canvas cross-origin tainting to analyse an avatar.
//
// GET  /api/ibm/vision  → a handful of real public avatars to show Granite, so the
//   demo works for anonymous visitors without an upload.
//
// No mock path: every read is a real Granite Vision inference. When watsonx is
// unconfigured the endpoint says so (503) instead of inventing a description.

import { sql } from '../_lib/db.js';
import { cors, method, readJson, error, json, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { publicUrl, thumbnailUrl } from '../_lib/r2.js';
import { watsonxConfig, watsonxChatComplete } from '../_lib/watsonx.js';
import { assertSafePublicUrl } from '../_lib/ssrf-guard.js';

// Granite Vision 3.2 (2B) is the default multimodal model on watsonx.ai. Override
// per account/region with WATSONX_VISION_MODEL_ID.
export const VISION_MODEL =
	process.env.WATSONX_VISION_MODEL_ID?.trim() || 'ibm/granite-vision-3-2-2b';

// The exact watsonx.ai chat payload for a Granite Vision read: a system message
// plus a user message whose content is the multimodal block array Granite expects
// (a text instruction followed by the image as a data/base64 URL). Extracted so the
// verification script can assert this wire shape without a live call.
export function buildVisionMessages(subject, hint, dataUrl) {
	const { system, user } = buildPrompt(subject, hint);
	return [
		{ role: 'system', content: system },
		{
			role: 'user',
			content: [
				{ type: 'text', text: user },
				{ type: 'image_url', image_url: { url: dataUrl } },
			],
		},
	];
}

// Server-side image-fetch limits. Granite accepts png/jpeg/webp/gif; we cap bytes
// so a hostile URL can't stream us an unbounded body, and only follow https.
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

// SSRF allowlist for imageUrl. We only fetch from our own asset host and a small
// set of public, content-addressed media CDNs the platform already serves images
// from — never an arbitrary host, so this can't be turned into an internal probe.
export function allowedImageHost(host) {
	host = host.toLowerCase();
	const ours = [process.env.S3_PUBLIC_DOMAIN, process.env.APP_ORIGIN, 'https://three.ws']
		.map(hostOf)
		.filter(Boolean);
	if (ours.includes(host)) return true;
	const suffixes = [
		'.r2.dev',
		'.r2.cloudflarestorage.com',
		'three.ws',
		'.mypinata.cloud',
		'.pinata.cloud',
		'ipfs.io',
		'.ipfs.dweb.link',
		'cf-ipfs.com',
		'arweave.net',
		'.arweave.net',
		'pump.mypinata.cloud',
		'image-cdn.solana.fm',
		'.githubusercontent.com',
	];
	return suffixes.some((s) => (s.startsWith('.') ? host.endsWith(s) : host === s));
}
function hostOf(u) {
	try {
		return new URL(u).host.toLowerCase();
	} catch {
		return null;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Global hourly ceiling on the shared watsonx server key (same bucket as
	// api/watsonx/embed) — a hard aggregate cost cap independent of any one IP.
	// Only consumed when watsonx is configured, i.e. when a request can
	// actually bill Granite inference.
	if (watsonxConfig().configured) {
		const global = await limits.watsonxEmbedGlobal();
		if (!global.success)
			return rateLimited(res, global, 'watsonx capacity reached — try again shortly');
	}

	if (req.method === 'GET') return handleSubjects(req, res);
	return handleVision(req, res);
});

export const maxDuration = 60;

// ── GET: featured subjects to show Granite ───────────────────────────────────

async function handleSubjects(req, res) {
	// Public avatars that have both a thumbnail (for the image read) and a stored
	// GLB (for the live 3D render). Featured + most-viewed first so the lineup looks
	// intentional. Read-only; safe for anonymous visitors.
	let rows = [];
	try {
		rows = await sql`
			SELECT id, slug, name, storage_key, thumbnail_key,
			       COALESCE(featured, false) AS featured,
			       COALESCE(view_count, 0)   AS view_count
			FROM avatars
			WHERE deleted_at IS NULL
			  AND visibility = 'public'
			  AND thumbnail_key IS NOT NULL
			  AND storage_key IS NOT NULL
			ORDER BY COALESCE(featured, false) DESC, COALESCE(view_count, 0) DESC, created_at DESC
			LIMIT 18
		`;
	} catch (err) {
		console.error('[ibm/vision] subjects query failed', err);
		return json(res, 200, { subjects: [] });
	}

	const subjects = rows.map((r) => ({
		id: r.id,
		name: r.name || 'Avatar',
		slug: r.slug || null,
		thumbnail: thumbnailUrl(r.thumbnail_key),
		model_url: publicUrl(r.storage_key),
	}));
	// Subjects list changes at most once an hour; cache aggressively so the demo
	// loads instantly for repeat visitors while keeping CDN cost negligible.
	res.setHeader('cache-control', 's-maxage=3600, stale-while-revalidate=86400');
	return json(res, 200, { subjects, visionModel: VISION_MODEL });
}

// ── POST: read an image with Granite Vision ──────────────────────────────────

async function handleVision(req, res) {
	const cfg = watsonxConfig();
	if (!cfg.configured) {
		return error(
			res,
			503,
			'watsonx_unavailable',
			'IBM Granite Vision runs on watsonx.ai. Set WATSONX_API_KEY and WATSONX_PROJECT_ID ' +
				'(or WATSONX_SPACE_ID) to let Granite see your avatar.',
		);
	}

	let body;
	try {
		body = await readJson(req, 9_000_000); // a base64 data URL of a snapshot can be large
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const subject = ['avatar', 'token', 'image'].includes(body.subject) ? body.subject : 'avatar';
	const hint = typeof body.hint === 'string' ? body.hint.trim().slice(0, 200) : '';

	let dataUrl;
	try {
		dataUrl = await resolveImage(body);
	} catch (e) {
		return error(res, e.status || 400, e.code || 'bad_image', e.message);
	}

	let reply;
	try {
		reply = await watsonxChatComplete(cfg, {
			model: VISION_MODEL,
			maxTokens: 460,
			temperature: 0.4,
			messages: buildVisionMessages(subject, hint, dataUrl),
		});
	} catch (e) {
		// Surface the real upstream cause (auth, quota, model not deployed in region).
		// model_unavailable gives the operator a clear signal to check WATSONX_VISION_MODEL_ID
		// or the regional model catalogue; vision_failed covers everything else.
		const msg = String(e?.message || 'watsonx vision request failed');
		const code = /not.*found|not.*deployed|unsupported.*model/i.test(msg)
			? 'model_unavailable'
			: 'vision_failed';
		return error(res, 502, code, msg);
	}

	const vision = parseVision(reply.text);
	return json(res, 200, {
		subject,
		model: reply.model || VISION_MODEL,
		vision,
		raw: vision.structured ? undefined : reply.text,
		usage: reply.usage || null,
	});
}

// Resolve the request into a base64 data URL Granite can consume. Accepts a client
// data URL directly, or fetches an allowlisted https image server-side.
async function resolveImage(body) {
	const image = typeof body.image === 'string' ? body.image : '';
	const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : '';

	if (image.startsWith('data:image/')) {
		// Guard the decoded size (base64 is ~4/3 of the bytes).
		const commaAt = image.indexOf(',');
		const b64 = commaAt >= 0 ? image.slice(commaAt + 1) : '';
		if (!b64) throw fail(400, 'bad_image', 'image data URL is empty');
		if (b64.length * 0.75 > MAX_IMAGE_BYTES)
			throw fail(413, 'image_too_large', 'image exceeds 6MB');
		return image;
	}

	if (/^https:\/\//i.test(imageUrl)) {
		const host = hostOf(imageUrl);
		if (!host || !allowedImageHost(host)) {
			throw fail(400, 'image_host_not_allowed', 'imageUrl host is not allowed');
		}
		return await fetchImageAsDataUrl(imageUrl);
	}

	throw fail(400, 'bad_image', 'provide image (data URL) or imageUrl (https)');
}

const MAX_IMAGE_REDIRECTS = 5;

// Re-validate every redirect hop before following it. An allowlisted host (the
// list includes broad CDNs and open-redirect-prone providers) could otherwise
// 3xx us toward an internal/metadata address. Each hop must stay https, keep an
// allowlisted host, AND pass the DNS-resolving SSRF guard (private/loopback/
// link-local/metadata IPs blocked). Bounded by MAX_IMAGE_REDIRECTS.
async function fetchImageAsDataUrl(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let resp;
	try {
		let current = url;
		let redirects = 0;
		while (true) {
			const host = hostOf(current);
			if (!/^https:\/\//i.test(current) || !host || !allowedImageHost(host)) {
				throw fail(
					400,
					'image_host_not_allowed',
					'image redirect target host is not allowed',
				);
			}
			await assertSafePublicUrl(current);
			resp = await fetch(current, { signal: controller.signal, redirect: 'manual' });
			if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
				if (++redirects > MAX_IMAGE_REDIRECTS) {
					throw fail(502, 'image_fetch_failed', 'too many redirects');
				}
				current = new URL(resp.headers.get('location'), current).toString();
				continue;
			}
			break;
		}
	} catch (e) {
		if (e?.status && e?.code) throw e; // already a structured fail()
		throw fail(502, 'image_fetch_failed', `could not fetch image: ${e.message}`);
	} finally {
		clearTimeout(timer);
	}
	if (!resp.ok) throw fail(502, 'image_fetch_failed', `image fetch returned ${resp.status}`);
	const ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
	if (!ct.startsWith('image/'))
		throw fail(415, 'not_an_image', `unexpected content-type: ${ct || 'unknown'}`);
	const len = Number(resp.headers.get('content-length') || 0);
	if (len && len > MAX_IMAGE_BYTES) throw fail(413, 'image_too_large', 'image exceeds 6MB');
	const buf = Buffer.from(await resp.arrayBuffer());
	if (buf.length > MAX_IMAGE_BYTES) throw fail(413, 'image_too_large', 'image exceeds 6MB');
	return `data:${ct};base64,${buf.toString('base64')}`;
}

function fail(status, code, message) {
	const e = new Error(message);
	e.status = status;
	e.code = code;
	return e;
}

// ── Prompting ────────────────────────────────────────────────────────────────

export function buildPrompt(subject, hint) {
	const hintLine = hint
		? `\nThe person who made it adds: "${hint}". Take it into account but trust your eyes first.`
		: '';
	if (subject === 'token') {
		return {
			system:
				'You are a sharp, neutral brand analyst looking at a single cryptocurrency / memecoin image (its logo or art). ' +
				'Describe only what is visible and the vibe it projects. Never give financial advice or price opinions. ' +
				'Reply with ONLY a JSON object and nothing else.',
			user:
				'Read this coin image.' +
				hintLine +
				'\nReturn JSON exactly like: {"appearance":"2-3 sentences on what is in the image","vibe":"3-6 comma-separated adjectives",' +
				'"persona":"1-2 sentences on the character/brand this projects","bio":"a punchy one-line tagline",' +
				'"tone_tags":["3-6","lowercase","tags"],"voice":"a short phrase for a fitting narrator voice"}',
		};
	}
	if (subject === 'image') {
		return {
			system:
				'You are a perceptive art director describing a single image precisely and only from what is visible. ' +
				'Reply with ONLY a JSON object and nothing else.',
			user:
				'Read this image.' +
				hintLine +
				'\nReturn JSON exactly like: {"appearance":"2-3 sentences on what is visible","vibe":"3-6 comma-separated adjectives",' +
				'"persona":"1-2 sentences on the character/mood it suggests","suggested_name":"a fitting short name",' +
				'"bio":"a punchy one-line bio","tone_tags":["3-6","lowercase","tags"],"voice":"a short phrase for a fitting voice"}',
		};
	}
	// avatar (default)
	return {
		system:
			'You are a casting director giving a 3D avatar a personality. You are shown one rendered 3D character. ' +
			'Look only at what is visible — features, clothing, colors, style, posture — and infer a personality that fits the look. ' +
			'Be specific and vivid, never generic. Reply with ONLY a JSON object and nothing else.',
		user:
			'Read this 3D avatar and give it an identity.' +
			hintLine +
			'\nReturn JSON exactly like: {"appearance":"2-3 sentences on how the avatar looks","vibe":"3-6 comma-separated adjectives",' +
			'"persona":"1-2 sentences on the personality this look suggests","suggested_name":"a fitting character name",' +
			'"bio":"a punchy one-line bio for this character","tone_tags":["3-6","lowercase","tags"],' +
			'"voice":"a short phrase describing a fitting speaking voice"}',
	};
}

// Parse Granite's reply into a normalized identity. Tolerant of code fences and
// stray prose; falls back to { structured:false } so the UI shows the raw read
// rather than nothing — never fabricates fields the model didn't return.
export function parseVision(text) {
	const out = {
		structured: false,
		appearance: '',
		vibe: '',
		persona: '',
		suggested_name: '',
		bio: '',
		tone_tags: [],
		voice: '',
	};
	if (!text) return out;
	const m = String(text).match(/\{[\s\S]*\}/);
	if (!m) return out;
	let obj;
	try {
		obj = JSON.parse(m[0]);
	} catch {
		return out;
	}
	out.structured = true;
	out.appearance = str(obj.appearance);
	out.vibe = str(obj.vibe);
	out.persona = str(obj.persona);
	out.suggested_name = str(obj.suggested_name || obj.name).slice(0, 60);
	out.bio = str(obj.bio).slice(0, 200);
	out.voice = str(obj.voice).slice(0, 120);
	out.tone_tags = Array.isArray(obj.tone_tags)
		? obj.tone_tags
				.map((t) => str(t).toLowerCase().slice(0, 24))
				.filter(Boolean)
				.slice(0, 8)
		: typeof obj.tone_tags === 'string'
			? obj.tone_tags
					.split(',')
					.map((t) => t.trim().toLowerCase())
					.filter(Boolean)
					.slice(0, 8)
			: [];
	return out;
}
function str(v) {
	return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}
