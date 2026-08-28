// Diorama — server-side build + export orchestration.
//
// Two capabilities the browser create-flow (src/diorama/compose.js) already
// does client-side, made available headlessly so a non-browser caller (an MCP
// tool, an agent, a CLI) can get a real composed world in one HTTP call:
//
//   • exportDioramaGlb(diorama)   — merge an already-forged diorama's objects
//     + ground + lights into one GLB (api/_lib/scene-graph-compose.js) and
//     upload it to object storage. Mirrors bake.js/forge-store.js's storage
//     posture: best-effort, returns null when storage isn't configured rather
//     than throwing, so callers degrade instead of hard-failing.
//
//   • buildDiorama(prompt)         — compose a plan (same free-first LLM chain
//     as api/diorama.js action:compose, intentionally duplicated rather than
//     imported: action:compose is a live, working contract and this module
//     must never risk changing its behavior) then forge every object on the
//     free lane via a real HTTP call to this deployment's own /api/forge —
//     the identical public endpoint the browser flow drives, with the same
//     concurrency/deadline shape (src/diorama/compose.js) — so a "build" is
//     just that flow running headlessly instead of from a browser tab.
//
// No mocks: every forge is a real generation on the free NVIDIA NIM lane, and
// export is a real @gltf-transform merge. Partial failure is not an error —
// objects that never forge are reported back and simply excluded.

import { randomUUID } from 'node:crypto';
import { llmComplete, llmConfigured } from './llm.js';
import { putObject, publicUrl } from './r2.js';
import { composeSceneGlb } from './scene-graph-compose.js';
import { normalizeDiorama, MIN_OBJECTS, MAX_OBJECTS, MAX_PROMPT_LEN, ISLAND_RADIUS } from '../../src/diorama/schema.js';
import { fetchUpstream } from './upstream-fetch.js';

const SITE = process.env.PUBLIC_BASE_URL || 'https://three.ws';

export function dioramaExportStoreEnabled() {
	return Boolean(
		process.env.S3_ENDPOINT &&
			process.env.S3_BUCKET &&
			process.env.S3_PUBLIC_DOMAIN &&
			process.env.S3_ACCESS_KEY_ID &&
			process.env.S3_SECRET_ACCESS_KEY,
	);
}

/**
 * Compose a diorama's forged objects into one GLB and upload it. Returns null
 * (never throws for a config issue) when object storage isn't configured on
 * this deployment — callers should surface a designed 503 in that case.
 *
 * @param {object} diorama — a normalized-or-normalizable Diorama.
 * @returns {Promise<{ glbUrl: string, exportedCount: number, totalCount: number, skipped: object[] } | null>}
 */
export async function exportDioramaGlb(diorama) {
	if (!dioramaExportStoreEnabled()) return null;
	const { bytes, exportedCount, totalCount, skipped } = await composeSceneGlb(diorama);
	const key = `diorama-exports/${(diorama?.id || 'draft').slice(0, 64)}/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.glb`;
	await putObject({
		key,
		body: Buffer.from(bytes),
		contentType: 'model/gltf-binary',
		metadata: { source: 'diorama-export' },
	});
	return { glbUrl: publicUrl(key), exportedCount, totalCount, skipped };
}

// ── Headless compose (mirrors api/diorama.js's action:compose LLM step) ────

const COMPOSE_SYSTEM = `You are a 3D set designer. You turn ONE short sentence into a tiny diorama — a miniature scene that sits on a small floating island a viewer can orbit.

Return ONLY a JSON object (no prose, no markdown fence) with exactly this shape:
{
  "title": "2-4 word evocative title",
  "mood": one of "dawn" | "day" | "dusk" | "night",
  "ground": one of "grass" | "sand" | "snow" | "stone" | "water" | "meadow" | "void",
  "island": one of "round" | "craggy" | "plateau",
  "palette": { "sky": ["#RRGGBB","#RRGGBB"], "ground": "#RRGGBB", "fog": "#RRGGBB", "accent": "#RRGGBB" },
  "objects": [ { "label": "short", "prompt": "ONE physical object: subject + key material + color", "position": [x, 0, z], "scale": 0.5-2.5, "rotationY": radians } ]
}

Rules:
- ${MIN_OBJECTS} to ${MAX_OBJECTS} objects. Each "prompt" describes exactly ONE isolated physical object (a single tree, a single tent) — never a scene, never "and", never people unless one figure is the whole subject. Lead with the subject, then its dominant material and color, ≤ 12 words.
- Spread objects across the island: x and z each between -${ISLAND_RADIUS - 1} and ${ISLAND_RADIUS - 1}, keep at least 1.5 between any two, never stack them. y is always 0. One object may sit near the center as a focal point.
- "palette" sky is a 2-stop vertical gradient (top, horizon). Pick colors that match the mood and the scene. "accent" is the warm/cool glow color.
- Choose mood + ground that fit the sentence (a beach → sand/day, a haunted forest → night/grass).
- Output MUST be valid JSON. No trailing commas. No comments.`;

/** @returns {Promise<object>} a normalized, pending (no meshes yet) diorama plan. */
export async function composePlanFromPrompt(prompt) {
	const sentence = String(prompt ?? '').slice(0, MAX_PROMPT_LEN).trim();
	if (sentence.length < 3) {
		throw Object.assign(new Error('Describe your world in a sentence.'), { code: 'prompt_required' });
	}
	if (!llmConfigured()) {
		throw Object.assign(new Error('The world composer is warming up. Try again in a moment.'), {
			code: 'composer_unavailable',
		});
	}

	let completion;
	try {
		completion = await llmComplete({
			system: COMPOSE_SYSTEM,
			user: `Sentence: "${sentence}"\nReturn the diorama JSON.`,
			maxTokens: 900,
			timeoutMs: 30_000,
			track: { tool: 'diorama-build' },
		});
	} catch (err) {
		throw Object.assign(new Error('The world composer is busy. Try again in a moment.'), {
			code: 'composer_unavailable',
			cause: err,
		});
	}

	const plan = parseJsonObject(completion?.text);
	if (!plan) {
		throw Object.assign(new Error('The composer returned an unexpected shape. Try rephrasing your world.'), {
			code: 'compose_unparseable',
		});
	}
	plan.prompt = sentence;
	const { ok, diorama, errors } = normalizeDiorama(plan);
	if (!ok || diorama.objects.length < 1) {
		throw Object.assign(new Error('The composer could not place that world. Try a more concrete sentence.'), {
			code: 'compose_invalid',
			detail: errors,
		});
	}
	diorama.objects = diorama.objects.map((o, i) => ({ ...o, id: `obj-${i}`, status: 'pending', glbUrl: null }));
	return diorama;
}

function parseJsonObject(text) {
	if (typeof text !== 'string') return null;
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fence ? fence[1] : text;
	const start = candidate.indexOf('{');
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < candidate.length; i++) {
		const c = candidate[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(candidate.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

// ── Headless forge (mirrors src/diorama/compose.js's client orchestration) ─

const FORGE_CONCURRENCY = 3;
const POLL_INTERVAL_MS = 2500;
const FORGE_DEADLINE_MS = 180_000;

/**
 * Forge every object in a diorama plan on the free lane, with bounded
 * concurrency. Mutates nothing — returns a new diorama with each object's
 * `status`/`glbUrl` updated. A per-object failure never throws; it lands as
 * `status:'failed'` so the caller gets the best real world it can build.
 *
 * @param {object} diorama — a normalized, pending diorama plan.
 * @param {{ clientKey?: string }} [opts]
 */
export async function forgeDioramaObjects(diorama, { clientKey } = {}) {
	const key = clientKey || `diorama-build:${randomUUID()}`;
	const objects = diorama.objects.map((o) => ({ ...o }));
	const queue = objects.slice();

	async function worker() {
		for (;;) {
			const obj = queue.shift();
			if (!obj) return;
			try {
				const glbUrl = await runForge(obj.prompt, key);
				obj.status = glbUrl ? 'ready' : 'failed';
				obj.glbUrl = glbUrl || null;
			} catch (err) {
				console.warn(`[diorama-build] forge failed for "${obj.label}":`, err?.message);
				obj.status = 'failed';
				obj.glbUrl = null;
			}
		}
	}

	const workers = Array.from({ length: Math.min(FORGE_CONCURRENCY, queue.length) }, worker);
	await Promise.all(workers);

	return { ...diorama, objects };
}

async function runForge(prompt, clientKey) {
	// One attempt, bounded: this POST queues a paid generation, so a retry would
	// forge (and bill) the same prop twice. Forge's own error payload is read
	// below, so a non-2xx has to arrive as a Response rather than as a throw.
	const res = await fetchUpstream(`${SITE}/api/forge`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-forge-client': clientKey },
		body: JSON.stringify({ prompt, tier: 'draft', path: 'image' }),
	}, { name: 'self:forge-submit', timeoutMs: 30_000, attempts: 1, okWhen: () => true });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data?.message || data?.error || `forge returned HTTP ${res.status}`);
	if (data.status === 'done' && data.glb_url) return data.glb_url;
	if (data.status === 'failed') throw new Error(data.error || 'forge failed');
	if (!data.job_id) throw new Error('forge did not start a job');
	return pollForge(data.job_id, clientKey);
}

async function pollForge(jobId, clientKey) {
	const deadline = Date.now() + FORGE_DEADLINE_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		let data;
		try {
			// A status read is idempotent and cheap, so a stalled or failed poll is
			// worth exactly one thing: skipping this tick. Before it was bounded, a
			// single hung poll held the whole diorama build open past its deadline;
			// now the loop keeps its own deadline as the only limit.
			const res = await fetchUpstream(`${SITE}/api/forge?job=${encodeURIComponent(jobId)}`, {
				headers: { 'x-forge-client': clientKey },
			}, { name: 'self:forge-poll', timeoutMs: 10_000, attempts: 1 });
			data = await res.json().catch(() => ({}));
		} catch {
			continue;
		}
		if (data.status === 'done' && data.glb_url) return data.glb_url;
		if (data.status === 'failed') throw new Error(data.error || 'forge failed');
	}
	throw new Error('this piece took too long to forge');
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
