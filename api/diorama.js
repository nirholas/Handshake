/**
 * Diorama — speak a little world into being.
 *
 *   POST /api/diorama  { action:'compose', prompt }     → a diorama PLAN
 *       Decomposes one sentence into a placed set of single-object forge prompts
 *       plus a mood/palette/ground, using the platform's free-first LLM chain.
 *       Returns objects with status:'pending' and no meshes — the browser then
 *       forges each one on /api/forge and watches the world assemble.
 *
 *   POST /api/diorama  { action:'save', diorama, clientKey? } → { id, url }
 *       Persists a fully-forged world so it gets a permalink + gallery slot.
 *
 *   POST /api/diorama  { action:'export', diorama }       → { glbUrl, sceneStudioUrl, … }
 *       Merges an already-forged diorama's objects + ground + lights into ONE
 *       GLB (api/_lib/scene-graph-compose.js) and uploads it — a single file
 *       with named, selectable nodes that opens cleanly in Scene Studio
 *       (/scene) or any glTF viewer. 503 when object storage isn't configured.
 *
 *   POST /api/diorama  { action:'build', prompt }         → { diorama, glbUrl?, … }
 *       Headless one-shot: compose the plan, forge every object on the free
 *       lane, then export the merged GLB — all server-side, for callers with
 *       no browser to drive the progressive client flow (MCP tools, agents).
 *
 *   GET  /api/diorama?id=<uuid>                          → { diorama }
 *   GET  /api/diorama?list=recent|featured&limit=<n>     → { dioramas:[card] }
 *
 * No mocks: when the LLM chain is unreachable the compose route returns a clean
 * 503 and the page renders a designed retry state — it never fabricates a world.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { llmComplete, llmConfigured } from './_lib/llm.js';
import { saveDiorama, getDiorama, listDioramas, bumpViews, dioramaStoreEnabled } from './_lib/diorama-store.js';
import {
	exportDioramaGlb,
	dioramaExportStoreEnabled,
	composePlanFromPrompt,
	forgeDioramaObjects,
} from './_lib/diorama-build.js';
import {
	normalizeDiorama,
	MIN_OBJECTS,
	MAX_OBJECTS,
	MAX_PROMPT_LEN,
	ISLAND_RADIUS,
} from '../src/diorama/schema.js';

const SITE = process.env.PUBLIC_BASE_URL || 'https://three.ws';

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

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	// `method()` returns TRUE when the verb is allowed (and answers 405 itself
	// otherwise), so the guard must be negated. Gate before the GET dispatch so a
	// HEAD probe is normalized to GET in here rather than falling through to a 405.
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') return handleGet(req, res);

	const body = await readJson(req).catch(() => null);
	if (!body || typeof body !== 'object') {
		return json(res, 400, { error: 'invalid_body', message: 'Send a JSON body.' });
	}

	if (body.action === 'compose') return handleCompose(req, res, body);
	if (body.action === 'save') return handleSave(req, res, body);
	if (body.action === 'export') return handleExport(req, res, body);
	if (body.action === 'build') return handleBuild(req, res, body);
	return json(res, 400, {
		error: 'unknown_action',
		message: 'action must be "compose", "save", "export", or "build".',
	});
});

async function handleGet(req, res) {
	const url = new URL(req.url, 'http://x');
	const id = url.searchParams.get('id');
	const list = url.searchParams.get('list');

	if (id) {
		const diorama = await getDiorama(id);
		if (!diorama) {
			return json(res, 404, { error: 'not_found', message: 'No diorama with that id.' });
		}
		bumpViews(id); // fire and forget
		return json(res, 200, { diorama }, { 'cache-control': 'public, max-age=30, s-maxage=300' });
	}

	if (list !== null) {
		const scope = list === 'featured' ? 'featured' : 'recent';
		const limit = Number(url.searchParams.get('limit')) || 24;
		const dioramas = await listDioramas({ scope, limit });
		return json(
			res,
			200,
			{ dioramas, storage: dioramaStoreEnabled() },
			{ 'cache-control': 'public, max-age=30, s-maxage=120' },
		);
	}

	return json(res, 400, { error: 'bad_request', message: 'Pass ?id= or ?list=.' });
}

async function handleCompose(req, res, body) {
	const prompt = String(body.prompt ?? '').slice(0, MAX_PROMPT_LEN).trim();
	if (prompt.length < 3) {
		return json(res, 400, { error: 'prompt_required', message: 'Describe your world in a sentence.' });
	}
	if (!llmConfigured()) {
		return json(res, 503, {
			error: 'composer_unavailable',
			message: 'The world composer is warming up. Try again in a moment.',
		});
	}

	// Compose runs a paid LLM completion — gate per IP and behind a global hourly
	// circuit breaker so one caller (or an influx) can't drive unbounded inference
	// spend. The global bucket only trips under a genuine surge or distributed abuse.
	const ip = clientIp(req);
	const rl = await limits.dioramaComposeIp(ip);
	if (!rl.success) {
		return rateLimited(res, rl, 'World composer limit reached. Try again shortly.');
	}
	const globalRl = await limits.dioramaComposeGlobal();
	if (!globalRl.success) {
		return rateLimited(res, globalRl, 'The world composer is at capacity. Try again shortly.');
	}

	let completion;
	try {
		completion = await llmComplete({
			system: COMPOSE_SYSTEM,
			user: `Sentence: "${prompt}"\nReturn the diorama JSON.`,
			maxTokens: 900,
			timeoutMs: 30_000,
			track: { tool: 'diorama-compose' },
		});
	} catch (err) {
		console.error('[diorama] compose llm failed:', err?.message);
		return json(res, 503, {
			error: 'composer_unavailable',
			message: 'The world composer is busy. Try again in a moment.',
		});
	}

	const plan = parseJsonObject(completion?.text);
	if (!plan) {
		return json(res, 502, {
			error: 'compose_unparseable',
			message: 'The composer returned an unexpected shape. Try rephrasing your world.',
		});
	}

	plan.prompt = prompt;
	plan.objects = declump(Array.isArray(plan.objects) ? plan.objects : []);
	const { ok, diorama, errors } = normalizeDiorama(plan);
	if (!ok || diorama.objects.length < 1) {
		return json(res, 502, {
			error: 'compose_invalid',
			message: 'The composer could not place that world. Try a more concrete sentence.',
			detail: errors,
		});
	}
	// Force a clean pending plan: never trust model-supplied ids/meshes here.
	diorama.objects = diorama.objects.map((o, i) => ({
		...o,
		id: `obj-${i}`,
		status: 'pending',
		glbUrl: null,
	}));

	return json(res, 200, { diorama });
}

async function handleSave(req, res, body) {
	if (!dioramaStoreEnabled()) {
		return json(res, 503, {
			error: 'sharing_unavailable',
			message: 'Sharing is not configured on this deployment.',
		});
	}
	// Persisting a world is an anonymous public write — bound per IP so one caller
	// can't carpet the gallery table.
	const saveRl = await limits.dioramaSaveIp(clientIp(req));
	if (!saveRl.success) {
		return rateLimited(res, saveRl, 'Saving too fast. Try again in a moment.');
	}
	let saved;
	try {
		saved = await saveDiorama({
			diorama: body.diorama,
			clientKey: typeof body.clientKey === 'string' ? body.clientKey.slice(0, 128) : null,
		});
	} catch (err) {
		if (err?.code === 'invalid_diorama') {
			return json(res, 400, { error: 'invalid_diorama', message: err.message });
		}
		throw err;
	}
	if (!saved) {
		return json(res, 500, { error: 'save_failed', message: 'Could not save this world. Try again.' });
	}
	return json(res, 200, {
		id: saved.id,
		createdAt: saved.createdAt,
		url: `${SITE}/diorama?id=${saved.id}`,
	});
}

// Merge an already-forged diorama into one exportable GLB — the "Export +
// editability" leg of compositional scene generation: a single file with
// every object as a named, selectable node, ready for Scene Studio or any
// other glTF-aware app. Degrades cleanly (designed 503) when object storage
// isn't configured, and never fails whole-hog on a partial forge: whatever
// objects are 'ready' get merged, the rest come back in `skipped`.
async function handleExport(req, res, body) {
	if (!dioramaExportStoreEnabled()) {
		return json(res, 503, {
			error: 'export_unavailable',
			message: 'Scene export is not configured on this deployment.',
		});
	}
	const exportRl = await limits.dioramaExportIp(clientIp(req));
	if (!exportRl.success) {
		return rateLimited(res, exportRl, 'Exporting too fast. Try again in a moment.');
	}

	const { ok, diorama, errors } = normalizeDiorama(body.diorama);
	if (!ok) {
		return json(res, 400, { error: 'invalid_diorama', message: errors.join(', ') });
	}

	let result;
	try {
		result = await exportDioramaGlb(diorama);
	} catch (err) {
		if (err?.code === 'nothing_to_export') {
			return json(res, 400, { error: 'nothing_to_export', message: err.message });
		}
		console.error('[diorama] export failed:', err?.message);
		return json(res, 502, {
			error: 'export_failed',
			message: 'Could not merge this world into a scene. Try again in a moment.',
		});
	}
	// dioramaExportStoreEnabled() already gated this, but exportDioramaGlb also
	// self-checks storage config — keep the belt-and-suspenders 503 in case the
	// two checks ever diverge (e.g. a future env alias one reads and the other doesn't).
	if (!result) {
		return json(res, 503, {
			error: 'export_unavailable',
			message: 'Scene export is not configured on this deployment.',
		});
	}

	return json(res, 200, {
		glbUrl: result.glbUrl,
		sceneStudioUrl: `${SITE}/scene?model=${encodeURIComponent(result.glbUrl)}&name=${encodeURIComponent(diorama.title || 'Diorama')}`,
		title: diorama.title,
		objectCount: diorama.objects.length,
		exportedCount: result.exportedCount,
		skipped: result.skipped,
	});
}

// Headless one-shot world build: compose → forge every object → export — the
// full pipeline in a single call, for callers with no browser to drive the
// progressive client flow (MCP tools, autonomous agents). Real LLM inference
// plus N real free-lane forges, so it carries compose's fail-closed rate-limit
// posture. A forge failure on some objects never fails the whole build — the
// diorama returned reflects exactly what forged, and `skipped` names the rest.
async function handleBuild(req, res, body) {
	const prompt = String(body.prompt ?? '').slice(0, MAX_PROMPT_LEN).trim();
	if (prompt.length < 3) {
		return json(res, 400, { error: 'prompt_required', message: 'Describe your world in a sentence.' });
	}

	const ip = clientIp(req);
	const rl = await limits.dioramaBuildIp(ip);
	if (!rl.success) {
		return rateLimited(res, rl, 'World builder limit reached. Try again shortly.');
	}
	const globalRl = await limits.dioramaBuildGlobal();
	if (!globalRl.success) {
		return rateLimited(res, globalRl, 'The world builder is at capacity. Try again shortly.');
	}

	let plan;
	try {
		plan = await composePlanFromPrompt(prompt);
	} catch (err) {
		const status = err?.code === 'composer_unavailable' ? 503 : err?.code === 'prompt_required' ? 400 : 502;
		return json(res, status, { error: err?.code || 'compose_failed', message: err.message });
	}

	const forged = await forgeDioramaObjects(plan, {
		clientKey: typeof body.clientKey === 'string' ? body.clientKey.slice(0, 128) : undefined,
	});
	const readyCount = forged.objects.filter((o) => o.status === 'ready').length;

	const response = {
		diorama: forged,
		objectCount: forged.objects.length,
		readyCount,
		viewerUrl: `${SITE}/diorama`,
	};

	if (readyCount > 0) {
		try {
			const exported = await exportDioramaGlb(forged);
			if (exported) {
				response.glbUrl = exported.glbUrl;
				response.sceneStudioUrl = `${SITE}/scene?model=${encodeURIComponent(exported.glbUrl)}&name=${encodeURIComponent(forged.title || 'Diorama')}`;
				response.exportedCount = exported.exportedCount;
				response.skipped = exported.skipped;
			} else {
				response.exportNote = 'Scene export is not configured on this deployment; the diorama objects still forged individually.';
			}
		} catch (err) {
			console.error('[diorama] build export step failed:', err?.message);
			response.exportNote = 'The world forged but could not be merged into a single scene file. Try action:"export" again.';
		}
	}

	return json(res, 200, response);
}

// Extract the first balanced top-level JSON object from a model response that
// may be wrapped in prose or a ```json fence. Returns the parsed object or null.
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

// Guard against the model stacking objects at the origin (a common failure):
// if any two objects are closer than MIN_SPACING, re-seat everything on a tidy
// spiral so the world always reads as a composed scene, never a pile.
const MIN_SPACING = 1.4;
function declump(objects) {
	if (objects.length < 2) return objects;
	let clumped = false;
	for (let i = 0; i < objects.length && !clumped; i++) {
		for (let j = i + 1; j < objects.length; j++) {
			const a = objects[i]?.position || [0, 0, 0];
			const b = objects[j]?.position || [0, 0, 0];
			if (Math.hypot((a[0] || 0) - (b[0] || 0), (a[2] || 0) - (b[2] || 0)) < MIN_SPACING) {
				clumped = true;
				break;
			}
		}
	}
	if (!clumped) return objects;
	const n = objects.length;
	const golden = Math.PI * (3 - Math.sqrt(5));
	return objects.map((o, i) => {
		// Phyllotaxis: even, non-overlapping spread filling the island disc.
		const t = (i + 0.5) / n;
		const r = (ISLAND_RADIUS - 1.2) * Math.sqrt(t);
		const a = i * golden;
		return { ...o, position: [Math.cos(a) * r, 0, Math.sin(a) * r] };
	});
}
