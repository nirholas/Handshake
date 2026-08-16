// Reusable zod schemas for API inputs.

import { z } from 'zod';
import { validateAppearance as _validateAppearance } from './accessories.js';

export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(10).max(200);
export const displayName = z.string().trim().min(1).max(80);
export const slug = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug must be lowercase alphanumeric with - or _');

export const avatarVisibility = z.enum(['private', 'unlisted', 'public']);

// Appearance: outfit + bone-attached accessories + arbitrary morph overrides.
// Shape is enforced here; preset-ID allowlist enforcement lives in
// validateAppearance() (accessories.js) and runs as a refine so we get one
// consolidated 400 with a clear error message.
export const avatarAppearance = z
	.object({
		outfit: z.string().min(1).max(64).nullable().optional(),
		accessories: z.array(z.string().min(1).max(64)).max(8).optional(),
		morphs: z.record(z.number().min(0).max(1)).optional(),
		// Garment layers: per-slot recolour (hex) + hidden slot ids. Slot-id and
		// hex validity is enforced in validateAppearance() (accessories.js).
		colors: z.record(z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
		hidden: z.array(z.string().min(1).max(32)).max(8).optional(),
		// Additive catalog garments ({slot, id} refs into the garment catalog —
		// specs/GARMENT_MANIFEST.md). Slot list mirrors GARMENT_SLOTS in
		// src/avatar-garment.js; existence against the live catalog is checked
		// at bake time so a retired garment degrades to "not worn", not a 400.
		garments: z
			.array(
				z
					.object({
						slot: z.enum([
							'top', 'bottom', 'footwear', 'outerwear',
							'hair', 'headwear', 'glasses', 'accessory',
						]),
						id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
					})
					.strict(),
			)
			.max(8)
			.optional(),
		// Custom bone-mounted props: a forged GLB parented to a named bone
		// (Scene Composer's "Save outfit"). Unlike `accessories`, whose entries
		// name presets in the curated catalog, these carry their own URL, so the
		// host allowlist in validateAppearance() (accessories.js) is what keeps
		// one owner's avatar from pointing every viewer's browser at an
		// arbitrary third-party host.
		attachments: z
			.array(
				z
					.object({
						bone: z.string().min(1).max(64),
						url: z.string().min(1).max(512),
						name: z.string().min(1).max(80).optional(),
					})
					.strict(),
			)
			.max(8)
			.optional(),
	})
	.strict()
	.superRefine((val, ctx) => {
		const err = _validateAppearance(val);
		if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
		if (val && val.morphs && Object.keys(val.morphs).length > 32) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'appearance.morphs max 32 keys',
			});
		}
		if (val?.garments) {
			const slots = val.garments.map((g) => g.slot);
			if (new Set(slots).size !== slots.length) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'appearance.garments: one garment per slot',
				});
			}
		}
	});

// Avatars are GLB/GLTF models. Lock the content-type allowlist here so both
// the presign URL and the stored object can only ever be model binaries —
// prevents an attacker uploading HTML/SVG to the public CDN for stored XSS.
export const avatarContentType = z.enum(['model/gltf-binary', 'model/gltf+json']);

export const username = z
	.string()
	.trim()
	.min(3)
	.max(30)
	.regex(/^[a-zA-Z0-9_-]+$/, 'username must be alphanumeric with _ or -');

// ── public profile fields (PATCH /api/auth/profile) ─────────────────────────
// All accept '' so the owner can clear a field; the handler normalises '' → null.
export const bio = z.string().trim().max(280);
export const profileLocation = z.string().trim().max(80);
// http(s) URL or empty. Capped well under any column limit; rejects javascript:
// and other schemes so a stored value can never become an XSS sink when rendered
// into an href. Empty string clears the field.
export const httpUrl = z
	.string()
	.trim()
	.max(500)
	.refine((v) => v === '' || /^https:\/\/[^\s]+$/i.test(v) || /^http:\/\/[^\s]+$/i.test(v), {
		message: 'must be an http(s) URL',
	});

export const registerBody = z.object({
	email,
	password,
	display_name: displayName.optional(),
	referralCode: z.string().trim().min(3).max(30).optional(),
});

export const usernameRegisterBody = z.object({
	username,
	password,
	referralCode: z.string().trim().min(3).max(30).optional(),
});

export const loginBody = z.object({
	email: z.string().trim().min(1).max(254), // accepts email address or username
	password: z.string().min(1).max(200),
});

export const createAvatarBody = z.object({
	name: z.string().trim().min(1).max(120),
	slug: slug.optional(),
	description: z.string().trim().max(2000).optional(),
	visibility: avatarVisibility.default('private'),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
	source: z.enum(['upload', 'avaturn', 'readyplayer', 'import', 'direct-upload', 'reconstruct', 'studio']).default('upload'),
	parent_avatar_id: z.string().uuid().optional(),
	source_meta: z.record(z.any()).default({}),
	content_type: avatarContentType.default('model/gltf-binary'),
	size_bytes: z
		.number()
		.int()
		.positive()
		.max(500 * 1024 * 1024),
	checksum_sha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	appearance: avatarAppearance.optional(),
});

export const presignUploadBody = z.object({
	size_bytes: z
		.number()
		.int()
		.positive()
		.max(500 * 1024 * 1024),
	content_type: avatarContentType.default('model/gltf-binary'),
	checksum_sha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
	return typeof value === 'string' && UUID_RE.test(value);
}

// Pagination / stream cursors arrive as caller-controlled strings and end up
// interpolated into a `::timestamptz` cast. Postgres rejects anything it cannot
// parse, so an unvalidated cursor turns a typo into either a 500 (the handler
// lets the query error bubble) or a permanently empty result (the handler
// swallows it). Both are wrong answers to what is plainly a client fault. Normalize
// here: a parseable instant comes back in ISO form, ready to hand straight to
// the cast; anything else comes back null so the caller can answer 400.
export function isoTimestamp(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const ms = Date.parse(trimmed);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ERC-8004 agent ids are uint256 token ids and are stored as TEXT, precisely
// because they can exceed what a JS number holds. A handler that does
// `parseInt(id, 10)` before the query therefore has two failure modes on a
// public endpoint: a non-numeric id becomes NaN, and an id past 2^53 becomes a
// rounded float in exponent notation that can never match the text column. Both
// are client faults; validate the raw digit string and pass it through as text.
// 78 digits is the width of 2^256 - 1, so nothing valid is rejected.
export function isErc8004AgentId(value) {
	return typeof value === 'string' && /^\d{1,78}$/.test(value);
}

export function isValidSolanaAddress(address) {
	return typeof address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

export function isValidEvmAddress(address) {
	return typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function parse(schema, input) {
	const res = schema.safeParse(input);
	if (!res.success) {
		const err = new Error(
			res.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
		);
		err.status = 400;
		err.code = 'validation_error';
		err.issues = res.error.issues.map((i) => ({
			path: i.path,
			code: i.code,
			message: i.message,
		}));
		throw err;
	}
	return res.data;
}

// Read JSON body and zod-parse in one call. Returns the parsed payload, or
// throws a structured 400 with `issues` for the API error envelope to surface.
//
// Pair with the `wrap()` helper in http.js to get consistent error responses.
export async function validateBody(req, schema, opts = {}) {
	const { readJson } = await import('./http.js');
	const raw = await readJson(req, opts.limit);
	return parse(schema, raw);
}

// Same idea for query strings — useful for GET endpoints that take typed filters.
export function validateQuery(req, schema) {
	const url = new URL(req.url, 'http://x');
	const obj = Object.fromEntries(url.searchParams.entries());
	return parse(schema, obj);
}
