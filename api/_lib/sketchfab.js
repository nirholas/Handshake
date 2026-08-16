// @ts-check
// Sketchfab Data API v3 client for the official three.ws showcase account.
//
// Spec: https://docs.sketchfab.com/data-api/v3/index.html (swagger.json)
//   - Auth:   `Authorization: Token <key>` (account token, sketchfab.com/settings/password)
//   - Upload: POST /v3/models, multipart/form-data. `modelFile` is the only
//             required field; `tags`/`categories` are repeated form fields
//             (collectionFormat "multi"); 201 returns { uid, uri }.
//   - Status: processing is async. GET /v3/models/{uid} exposes
//             status.processing: PROCESSING | SUCCEEDED | FAILED.
//   - Limits: 50 MB per upload on the basic plan (200 MB pro, 500 MB biz).
//
// Sketchfab has no dedicated AI-generation field, so disclosure is the
// `ai-generated` tag plus a plain statement in the description. Every
// description carries the source prompt and UTM-tagged backlinks so referral
// conversion is measurable in analytics.

import { env } from './env.js';

const API_BASE = 'https://api.sketchfab.com/v3';
const NAME_MAX = 48; // Sketchfab truncates longer model names
const DESC_MAX = 1024; // description hard limit
// Basic-plan uploads cap at 50 MB; keep a margin so a boundary-size GLB never
// burns an attempt on a guaranteed 4xx.
export const GLB_MAX_BYTES = 45 * 1024 * 1024;

const SHOWCASE_UTM = 'utm_source=sketchfab&utm_medium=referral&utm_campaign=showcase';

// Brand-safety denylist for the OFFICIAL showcase account. Users can forge
// what the forge allows; the brand account does not publish firearms or
// explicit content under the three.ws name. Word-boundary matched, so
// "bullet train" style false positives are accepted as the cost of a
// conservative gate. This local list is always on; the NemoGuard classifier
// (api/_lib/publish-safety.js) runs as a second, fail-open layer in the cron.
// Both are limits on what THIS account publishes, not on what users may forge.
const DENY_TERMS = [
	'glock', 'gun', 'guns', 'firearm', 'firearms', 'rifle', 'pistol', 'shotgun',
	'revolver', 'ammo', 'bullet', 'bullets', 'grenade', 'bomb', 'explosive',
	'suppressor', 'silencer', 'nsfw', 'nude', 'naked', 'sex', 'sexy', 'porn',
	'hentai', 'swastika',
];

const DENY_RE = new RegExp(`\\b(${DENY_TERMS.join('|')})\\b`, 'i');

// Returns the matched term when the prompt is brand-unsafe, else null.
export function promptDenyMatch(prompt) {
	const m = String(prompt || '').match(DENY_RE);
	return m ? m[1].toLowerCase() : null;
}

// Same list as a POSIX regex for `prompt !~* ...` in selection SQL, so
// obviously unsafe models never even appear as candidates (dry-run included).
// \m and \M are postgres word boundaries.
export const DENY_SQL_PATTERN = `\\m(${DENY_TERMS.join('|')})\\M`;

export function sketchfabConfigured() {
	return Boolean(env.SKETCHFAB_API_TOKEN);
}

export function showcaseLink(path) {
	const origin = env.APP_ORIGIN || 'https://three.ws';
	return `${origin}${path}${path.includes('?') ? '&' : '?'}${SHOWCASE_UTM}`;
}

// The image-to-3D path has no user prompt, so it stores the literal route name
// as the prompt. The showcase's `accepted` tier filters that sentinel out in SQL,
// but the curated tiers (board winners, top-voted) deliberately skip the
// prompt-quality heuristics, a model the community actually voted for is never
// dropped over its title. Left alone, a winning image-to-3D model reaches the
// official account named "Image-To-3d"; a live dry run had exactly that as the
// second pick. Fall back to the category instead of publishing the sentinel.
const PLACEHOLDER_PROMPT_RE = /^(image-to-3d|untitled|test)$/i;

// `other` is the forge's catch-all bucket, not a description, so "Forged Other"
// is no better a public name than the sentinel it replaced. Fall through to the
// neutral generic for it and its siblings.
const VAGUE_CATEGORY_RE = /^(other|misc|miscellaneous|unknown|general|uncategorized)$/i;

function categoryName(modelCategory) {
	const cat = String(modelCategory || '').trim();
	if (!cat || VAGUE_CATEGORY_RE.test(cat)) return '3D Model';
	// Underscores are a slug separator; hyphens are part of the word ("sci-fi").
	return `Forged ${cat.replace(/_+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`;
}

// Model name from the generation prompt: first clause, title-cased, article
// stripped, clamped to Sketchfab's display limit. A prompt that is a placeholder
// rather than a description names the model from its category instead.
export function buildModelName(prompt, modelCategory) {
	const raw = String(prompt || '').trim();
	if (!raw || PLACEHOLDER_PROMPT_RE.test(raw)) return categoryName(modelCategory);
	const trimmed = raw.replace(/^(a|an|the)\s+/i, '');
	const firstClause = trimmed.split(/[,.;:\n]/)[0].trim() || trimmed || '3D Model';
	const titled = firstClause.replace(/\b\w/g, (c) => c.toUpperCase());
	if (titled.length <= NAME_MAX) return titled;
	// Cut on a word boundary so the public name never ends mid-word.
	const cut = titled.slice(0, NAME_MAX);
	const lastSpace = cut.lastIndexOf(' ');
	return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}

// Sketchfab tags are slugs: lowercase, alphanumeric + hyphen.
function slugTag(value) {
	return String(value || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

export function buildTags(modelCategory) {
	const tags = ['ai-generated', 'generative-ai', 'text-to-3d', 'threews'];
	const cat = slugTag(modelCategory);
	if (cat && !tags.includes(cat)) tags.push(cat);
	return tags;
}

export function buildDescription({ prompt, creationId, source }) {
	const pickLine =
		source === 'board_winner'
			? 'Weekly Forge-Off winner, crowned by community vote.'
			: source === 'top_voted'
				? 'Community pick: one of the top-voted models on the forge board.'
				: 'Curated pick from the three.ws forge gallery.';
	const share = showcaseLink(`/forge/share/${creationId}`);
	const forge = showcaseLink('/forge');
	const fixed = [
		'',
		`AI-generated on the three.ws Forge (text to 3D). ${pickLine}`,
		'',
		`View and remix in the browser: ${share}`,
		`Forge your own, free, no account: ${forge}`,
	].join('\n');
	// The prompt is the only variable-length piece; clamp it so the backlinks
	// always survive the 1024-char description limit.
	const promptBudget = DESC_MAX - fixed.length - 12;
	const cleanPrompt = String(prompt || '').trim().slice(0, Math.max(0, promptBudget));
	return `Prompt: "${cleanPrompt}"${fixed}`.slice(0, DESC_MAX);
}

// Download the stored GLB and push it to Sketchfab. Returns { uid, url }.
// Throws on any failure; the caller records the error and retry budget.
export async function uploadModel({ glbUrl, name, description, tags }) {
	const token = env.SKETCHFAB_API_TOKEN;
	if (!token) throw new Error('SKETCHFAB_API_TOKEN unset');

	const glbRes = await fetch(glbUrl, {
		headers: { 'user-agent': 'threews-sketchfab-showcase/1.0' },
		signal: AbortSignal.timeout(60_000),
	});
	if (!glbRes.ok) throw new Error(`glb fetch failed: ${glbRes.status} ${glbUrl}`);
	const buf = await glbRes.arrayBuffer();
	if (buf.byteLength === 0) throw new Error(`glb is empty: ${glbUrl}`);
	if (buf.byteLength > GLB_MAX_BYTES) {
		throw new Error(`glb too large for basic plan: ${buf.byteLength} bytes`);
	}

	const form = new FormData();
	form.append(
		'modelFile',
		new Blob([buf], { type: 'model/gltf-binary' }),
		`${slugTag(name) || 'model'}.glb`,
	);
	form.append('name', name);
	form.append('description', description);
	for (const tag of tags) form.append('tags', tag);
	form.append('isPublished', 'true');
	form.append('isInspectable', 'true');

	const res = await fetch(`${API_BASE}/models`, {
		method: 'POST',
		headers: { authorization: `Token ${token}` },
		body: form,
		signal: AbortSignal.timeout(180_000),
	});
	const body = await res.json().catch(() => null);
	if (res.status !== 201 || !body?.uid) {
		throw new Error(
			`sketchfab upload failed: ${res.status} ${JSON.stringify(body || {}).slice(0, 300)}`,
		);
	}
	return { uid: body.uid, url: `https://sketchfab.com/models/${body.uid}` };
}

// Poll async processing. Returns 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | null
// (null = status not readable yet; treat as still processing).
export async function getProcessingStatus(uid) {
	const token = env.SKETCHFAB_API_TOKEN;
	if (!token) throw new Error('SKETCHFAB_API_TOKEN unset');
	const res = await fetch(`${API_BASE}/models/${encodeURIComponent(uid)}`, {
		headers: { authorization: `Token ${token}` },
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) return null;
	const body = await res.json().catch(() => null);
	const processing = body?.status?.processing;
	return typeof processing === 'string' ? processing.toUpperCase() : null;
}
