#!/usr/bin/env node
// Avatar likeness audit (prompts/finish/quality-bar-10-avatar-likeness-irl-people.md, task 1/7).
//
// Fires six SYNTHETIC personas through the REAL production avatar chain on
// https://three.ws twice each — once on the Standard tier (the "before": the
// lane the public MCP studio avatar tools actually request today) and once on
// the High tier (the "after": the only tier whose router mapping reaches the
// self-hosted Hunyuan3D lane) — then renders the canonical views with the same
// headless three.js renderer the platform uses for avatar thumbnails
// (api/_lib/render-clip.js) and scores every view with Vertex Gemini vision
// using the bench's own judge prompt (api/_lib/quality-bench.js, imported
// read-only).
//
// Nothing here forks the pipeline: the generate/poll/rig calls are the same
// HTTP contract api/_mcp-studio/forge-client.js speaks (POST /api/forge,
// GET /api/forge?job=, POST /api/forge?action=rig), carrying the same internal
// seed header (x-forge-seed: CRON_SECRET) that lets platform-originated studio
// traffic run the operator-funded High tier.
//
// Usage:
//   node scripts/avatar-likeness-audit.mjs [--cases=a,b] [--concurrency=2]
//     [--base-url=https://three.ws] [--out-dir=<dir>]
//     [--skip-generate] [--skip-render] [--skip-judge]
//
// Credentials (never committed): CRON_SECRET for the internal seed header and
// GCP_SERVICE_ACCOUNT_JSON for the Vertex judge. Both are read from the process
// env; AVATAR_AUDIT_SA_FILE may point at a service-account JSON file instead.
//
// Output: prompts/quality-bar/_generated/10/ — one PNG per rendered view plus
// audit-data.json (the full, resumable evidence record). Re-running resumes:
// a case that already has a finished GLB is never re-generated.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'prompts', 'quality-bar', '_generated', '10');
// Set by main() from --out-dir so one run's evidence never overwrites another's.
let OUT_DIR = DEFAULT_OUT_DIR;
let DATA_FILE = path.join(OUT_DIR, 'audit-data.json');

function setOutDir(dir) {
	OUT_DIR = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
	DATA_FILE = path.join(OUT_DIR, 'audit-data.json');
}

// ---------------------------------------------------------------------------
// Env: .env for local credentials, plus an optional SA key file for Vertex.
// ---------------------------------------------------------------------------
// Values already present in the environment win, so a caller can override any
// local .env key (e.g. pointing CRON_SECRET at the deployment's own secret)
// without editing the file.
function loadDotEnv() {
	const file = path.join(ROOT, '.env');
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (!m) continue;
		const [, k, raw] = m;
		if (process.env[k]) continue;
		process.env[k] = raw.replace(/^["']|["']$/g, '').trim();
	}
}

// ---------------------------------------------------------------------------
// The six cases. Every persona is SYNTHETIC — a described archetype, never a
// real named individual. Cases (e) and (f) stand in for the prompt spec's two
// CC0 reference-photo cases: see audit.md for why the photo leg was substituted.
// `watch` feeds the judge's per-subject failure-mode checklist, matching the
// shape data/quality-bench/prompts.json uses.
// ---------------------------------------------------------------------------
const HUMAN_WATCH = [
	'fused, missing, or extra fingers; hands melted into blobs or into the hips',
	'melted or asymmetric face; eyes at different heights; no visible iris detail',
	'plastic/mannequin skin with no pores or subsurface response',
	'hair as one solid painted cap instead of strands',
	'texture seams or color breaks at the neck and hairline',
	'limbs fused to the torso, or feet melted into a single base',
];

const CASES = [
	{
		id: 'a',
		label: 'Athlete',
		subjectClass: 'person',
		stylized: false,
		prompt:
			'A synthetic persona, not a real person: a professional sprinter in her late twenties, lean muscular build, ' +
			'short natural curls, wearing a fitted team tracksuit and running shoes, standing relaxed with arms slightly ' +
			'away from the body and hands open, fingers separated.',
		watch: HUMAN_WATCH,
	},
	{
		id: 'b',
		label: 'Grandmother',
		subjectClass: 'person',
		stylized: false,
		prompt:
			'A synthetic persona, not a real person: a grandmother in her seventies, soft build, silver hair pinned in a ' +
			'bun, reading glasses, wearing a knitted cardigan over a floral blouse and a long skirt with flat shoes, ' +
			'standing relaxed with arms slightly away from the body and hands open, fingers separated.',
		watch: HUMAN_WATCH.concat(['skin that reads as a smooth young mannequin instead of a real older face with creases']),
	},
	{
		id: 'c',
		label: 'Stylized kid (child-safe)',
		subjectClass: 'person',
		stylized: true,
		prompt:
			'A clearly stylized cartoon toy character of a child: chunky vinyl-figure proportions, oversized round head, ' +
			'simple mitten-like hands, matte toy-plastic finish with visible seam lines, painted-on facial features, ' +
			'wearing dungarees and a striped shirt, standing upright with arms slightly away from the body. Deliberately ' +
			'non-photoreal: a collectible vinyl figure, never a photographic human child.',
		watch: [
			'any drift toward a photoreal human child instead of a clearly-stylized vinyl toy',
			'mitten hands melted into the body',
			'fused limbs or a melted face',
			'muddy, low-resolution toy-plastic texture',
		],
	},
	{
		id: 'd',
		label: 'Businessperson',
		subjectClass: 'person',
		stylized: false,
		prompt:
			'A synthetic persona, not a real person: a businessman in his forties, average build, short dark hair, ' +
			'clean-shaven, wearing a navy two-piece wool suit over a white shirt with an open collar and polished black ' +
			'leather shoes, standing relaxed with arms slightly away from the body and hands open, fingers separated.',
		watch: HUMAN_WATCH.concat(['suit rendered as painted-on color instead of wool cloth with lapel and seam geometry']),
	},
	{
		id: 'e',
		label: 'Construction worker in workwear',
		subjectClass: 'person',
		stylized: false,
		prompt:
			'A synthetic persona, not a real person: a construction worker in his fifties, stocky build, weathered face, ' +
			'wearing a yellow high-visibility vest with reflective bands over a grey long-sleeve shirt, heavy canvas work ' +
			'trousers, a white hard hat and scuffed steel-toe boots, standing relaxed with arms slightly away from the ' +
			'body and hands open, fingers separated.',
		watch: HUMAN_WATCH.concat(['hard hat fused into the skull instead of sitting as a separate shell', 'reflective bands baked as flat stripes with no material change']),
	},
	{
		id: 'f',
		label: 'Dancer mid-pose',
		subjectClass: 'person',
		stylized: false,
		prompt:
			'A synthetic persona, not a real person: a contemporary dancer in her thirties, tall athletic build, hair tied ' +
			'back, wearing a fitted dark leotard and a loose wrap skirt with bare feet, standing tall in a poised neutral ' +
			'stance with one arm raised slightly to the side and both hands open, fingers separated and clearly visible.',
		watch: HUMAN_WATCH.concat(['the raised arm fused to the head or torso', 'wrap skirt fused into the legs as one solid block']),
	},
];

// Standard is the BEFORE lane, High the AFTER lane: on the live router
// (/api/forge?catalog) the image path maps standard -> trellis_selfhost and
// high -> hunyuan3d, so the tier switch is exactly the lane switch this
// campaign is measuring.
const VARIANTS = [
	{ id: 'before', tier: 'standard' },
	{ id: 'after', tier: 'high' },
];

// Front / three-quarter / side are the bench's canonical judged views. The
// fourth, "hands", is evidence-only: a near-eye-level three-quarter framing
// where both hands sit in frame so fingers can be counted per case.
const HANDS_VIEW = { label: 'hands', theta: 25, phi: 88, width: 1536, height: 1536 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
	const args = {
		cases: 'all',
		baseUrl: 'https://three.ws',
		concurrency: 2,
		outDir: DEFAULT_OUT_DIR,
		skipGenerate: false,
		skipRender: false,
		skipJudge: false,
	};
	for (const raw of argv) {
		const [k, ...rest] = raw.replace(/^--/, '').split('=');
		const v = rest.join('=');
		if (k === 'cases') args.cases = v;
		else if (k === 'base-url') args.baseUrl = v;
		else if (k === 'concurrency') args.concurrency = Math.max(1, Number(v) || 2);
		else if (k === 'out-dir') args.outDir = v;
		else if (k === 'skip-generate') args.skipGenerate = true;
		else if (k === 'skip-render') args.skipRender = true;
		else if (k === 'skip-judge') args.skipJudge = true;
	}
	return args;
}

// ---------------------------------------------------------------------------
// Forge HTTP client — same contract as api/_mcp-studio/forge-client.js.
// ---------------------------------------------------------------------------
function internalHeaders() {
	const secret = process.env.CRON_SECRET;
	return secret ? { 'x-forge-seed': secret } : {};
}

async function submitForge(baseUrl, payload) {
	const res = await fetch(`${baseUrl}/api/forge`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...internalHeaders() },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(120_000),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok && !(data?.status === 'done' && data?.glb_url)) {
		throw new Error(`forge submit ${res.status}: ${data?.error || data?.message || 'no body'}`);
	}
	if (!data?.job_id && !(data?.status === 'done' && data?.glb_url)) {
		throw new Error(`forge submit returned no job handle: ${JSON.stringify(data).slice(0, 300)}`);
	}
	return data;
}

async function startRig(baseUrl, glbUrl) {
	const res = await fetch(`${baseUrl}/api/forge?action=rig`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...internalHeaders() },
		body: JSON.stringify({ glb_url: glbUrl }),
		signal: AbortSignal.timeout(60_000),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || !data?.job_id) {
		throw new Error(`rig start ${res.status}: ${data?.error || data?.message || 'no body'}`);
	}
	return data;
}

async function pollJob(baseUrl, jobId, { timeoutMs = 900_000, intervalMs = 5_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let data;
		try {
			const res = await fetch(`${baseUrl}/api/forge?job=${encodeURIComponent(jobId)}`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(30_000),
			});
			data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(`poll ${res.status}: ${data?.error || data?.message || ''}`);
		} catch (err) {
			if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
				await sleep(intervalMs);
				continue;
			}
			throw err;
		}
		if (data.status === 'done' && data.glb_url) return data;
		if (data.status === 'failed') throw new Error(`job failed: ${data.error || 'generation failed'}`);
		await sleep(intervalMs);
	}
	throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
}

async function generate(baseUrl, payload) {
	const job = await submitForge(baseUrl, payload);
	if (job.status === 'done' && job.glb_url) return job;
	const done = await pollJob(baseUrl, job.job_id);
	return { ...job, ...done };
}

// ---------------------------------------------------------------------------
// Art director — the platform's own avatar director instruction
// (api/_lib/forge-director-prompts.js) run over the deployment's public /api/chat
// free chain, exactly like mcp-server's directPrompt does. Vertex Gemini is the
// fallback rung so a throttled free chain can't silently strip the photoreal
// briefing from the audit. Returns { text, via } or null (fail-soft: the caller
// then forges the raw persona prompt, never a fabricated one).
// ---------------------------------------------------------------------------
async function directViaChat(baseUrl, instruction, rawPrompt) {
	let res;
	try {
		res = await fetch(`${baseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify({ message: `${instruction}\n\nIdea: ${rawPrompt}` }),
			signal: AbortSignal.timeout(60_000),
		});
	} catch {
		return null;
	}
	if (!res.ok || !res.body) return null;
	let acc = '';
	try {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				let evt;
				try {
					evt = JSON.parse(line.slice(6));
				} catch {
					continue;
				}
				if (evt.type === 'chunk' && typeof evt.text === 'string') acc += evt.text;
				else if (evt.type === 'error') return null;
				else if (evt.type === 'done' && typeof evt.text === 'string' && !acc) acc = evt.text;
			}
		}
	} catch {
		return null;
	}
	return cleanDirected(acc);
}

async function directViaVertex(instruction, rawPrompt) {
	const { vertexGeminiChatUrl, vertexGeminiHeaders } = await import('../api/_lib/vertex-gemini.js');
	const headers = await vertexGeminiHeaders();
	const res = await fetch(vertexGeminiChatUrl(), {
		method: 'POST',
		headers,
		body: JSON.stringify({
			model: 'google/gemini-2.5-flash',
			temperature: 0.4,
			max_tokens: 1200,
			messages: [
				{ role: 'system', content: instruction },
				{ role: 'user', content: `Idea: ${rawPrompt}` },
			],
		}),
		signal: AbortSignal.timeout(90_000),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`vertex director ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
	return cleanDirected(data?.choices?.[0]?.message?.content || '');
}

function cleanDirected(text) {
	if (!text) return null;
	const firstLine = String(text).trim().split('\n').filter(Boolean)[0]?.trim() || '';
	const refined = firstLine.replace(/^["'“”]+|["'“”]+$/g, '').trim();
	return refined.length >= 3 && refined.length <= 1000 ? refined : null;
}

async function directPrompt(baseUrl, instruction, rawPrompt) {
	const viaChat = await directViaChat(baseUrl, instruction, rawPrompt);
	if (viaChat) return { text: viaChat, via: 'prod /api/chat free chain' };
	try {
		const viaVertex = await directViaVertex(instruction, rawPrompt);
		if (viaVertex) return { text: viaVertex, via: 'vertex gemini-2.5-flash (chat chain returned nothing)' };
	} catch (err) {
		return { text: null, via: null, error: err.message };
	}
	return { text: null, via: null, error: 'director produced no usable line' };
}

// ---------------------------------------------------------------------------
// Judge — the bench's own prompt/model, with a token budget wide enough for a
// reasoning model. api/_lib/quality-bench.js caps replies at 700 tokens, which
// gemini-2.5-pro spends on internal reasoning before emitting the JSON, so its
// judgeOnce() truncates mid-object; this local call keeps the identical prompt
// and model and only widens max_tokens. Throws on any failure — a failed score
// is recorded as failed, never invented.
// ---------------------------------------------------------------------------
const JUDGE_MAX_TOKENS = 4096;

function parseJudgeJson(text) {
	const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	const start = trimmed.search(/[{[]/);
	const candidate = start >= 0 ? trimmed.slice(start) : trimmed;
	const parsed = JSON.parse(candidate);
	for (const k of ['photorealism', 'geometryIntegrity', 'textureFidelity', 'promptAdherence']) {
		const n = Number(parsed[k]);
		if (!Number.isFinite(n)) throw new Error(`judge reply missing numeric ${k}`);
		parsed[k] = Math.max(1, Math.min(10, n));
	}
	if (typeof parsed.critique !== 'string') parsed.critique = '';
	return parsed;
}

async function judgeView({ png, promptEntry, viewLabel }) {
	const { buildJudgePrompt, JUDGE_MODEL } = await import('../api/_lib/quality-bench.js');
	const { vertexGeminiAvailable, vertexGeminiChatUrl, vertexGeminiHeaders } = await import('../api/_lib/vertex-gemini.js');
	if (!vertexGeminiAvailable()) {
		throw Object.assign(new Error('Vertex Gemini unavailable: GOOGLE_CLOUD_PROJECT is not set'), { code: 'judge_unconfigured' });
	}
	const headers = await vertexGeminiHeaders();
	const body = {
		model: JUDGE_MODEL,
		temperature: 0,
		max_tokens: JUDGE_MAX_TOKENS,
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'text', text: buildJudgePrompt({ ...promptEntry, viewLabel }) },
					{ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
				],
			},
		],
	};
	const res = await fetch(vertexGeminiChatUrl(), {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(180_000),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`judge call ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
	const parsed = parseJudgeJson(data?.choices?.[0]?.message?.content || '');
	return { ...parsed, modelVersion: data?.model || JUDGE_MODEL };
}

function avgScores(scores) {
	const dims = ['photorealism', 'geometryIntegrity', 'textureFidelity', 'promptAdherence'];
	const out = {};
	for (const d of dims) out[d] = scores.reduce((s, x) => s + x[d], 0) / scores.length;
	out.mean = dims.reduce((s, d) => s + out[d], 0) / dims.length;
	return out;
}

// ---------------------------------------------------------------------------
// Evidence record (resumable).
// ---------------------------------------------------------------------------
async function loadData() {
	if (!existsSync(DATA_FILE)) {
		return {
			startedAt: new Date().toISOString(),
			finishedAt: null,
			baseUrl: null,
			cases: {},
		};
	}
	return JSON.parse(await readFile(DATA_FILE, 'utf8'));
}

let _saveQueue = Promise.resolve();
function saveData(data) {
	_saveQueue = _saveQueue.then(async () => {
		await mkdir(OUT_DIR, { recursive: true });
		await writeFile(DATA_FILE, JSON.stringify(data, null, '\t') + '\n', 'utf8');
	});
	return _saveQueue;
}

function log(...parts) {
	console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
}

// ---------------------------------------------------------------------------
// Per-case pipeline.
// ---------------------------------------------------------------------------
async function runCase(args, data, testCase) {
	const rec = (data.cases[testCase.id] ??= {
		id: testCase.id,
		label: testCase.label,
		prompt: testCase.prompt,
		subjectClass: testCase.subjectClass,
		stylized: testCase.stylized,
		variants: {},
	});

	// 1. Director pass (shared by both variants so tier is the only difference).
	if (!rec.directed && !args.skipGenerate) {
		const { avatarDirectorFor } = await import('../api/_lib/forge-director-prompts.js');
		const directed = await directPrompt(args.baseUrl, avatarDirectorFor('person'), testCase.prompt);
		rec.directed = directed.text || null;
		rec.directedVia = directed.via || null;
		rec.directorError = directed.error || null;
		await saveData(data);
		log(`case ${testCase.id}: director ${rec.directed ? `ok via ${rec.directedVia}` : `FAILED (${rec.directorError}) — forging the raw persona prompt`}`);
	}
	const forgePrompt = rec.directed || testCase.prompt;

	for (const variant of VARIANTS) {
		const vrec = (rec.variants[variant.id] ??= { id: variant.id, tierRequested: variant.tier, views: {} });

		// 2. Generate the mesh.
		if (!vrec.glbUrl && !args.skipGenerate) {
			const started = Date.now();
			try {
				const job = await generate(args.baseUrl, {
					prompt: forgePrompt,
					aspect_ratio: '1:1',
					tier: variant.tier,
				});
				vrec.glbUrl = job.glb_url;
				vrec.backend = job.backend ?? null;
				vrec.tierServed = job.tier ?? null;
				vrec.previewImageUrl = job.preview_image_url ?? null;
				vrec.creationId = job.creation_id ?? null;
				vrec.generationMs = Date.now() - started;
				vrec.error = null;
			} catch (err) {
				vrec.error = err.message;
				vrec.generationMs = Date.now() - started;
			}
			await saveData(data);
			log(`case ${testCase.id}/${variant.id}: ${vrec.glbUrl ? `mesh ok backend=${vrec.backend} ${Math.round(vrec.generationMs / 1000)}s` : `GENERATION FAILED: ${vrec.error}`}`);
		}
		if (!vrec.glbUrl) continue;

		// 3. Rig the after-lane mesh (the animation-ready avatar path).
		if (variant.id === 'after' && !vrec.riggedGlbUrl && !vrec.rigError && !args.skipGenerate) {
			const started = Date.now();
			try {
				const rigJob = await startRig(args.baseUrl, vrec.glbUrl);
				const rigged = await pollJob(args.baseUrl, rigJob.job_id, { timeoutMs: 600_000 });
				vrec.riggedGlbUrl = rigged.glb_url;
				vrec.rigMs = Date.now() - started;
			} catch (err) {
				vrec.rigError = err.message;
				vrec.rigMs = Date.now() - started;
			}
			await saveData(data);
			log(`case ${testCase.id}/${variant.id}: ${vrec.riggedGlbUrl ? `rig ok ${Math.round(vrec.rigMs / 1000)}s` : `RIG FAILED: ${vrec.rigError}`}`);
		}

		// 4. Render the canonical views + the hands evidence view.
		if (!args.skipRender) {
			const { renderClip } = await import('../api/_lib/render-clip.js');
			const { CANONICAL_VIEWS, RENDER_BACKGROUND } = await import('../api/_lib/quality-bench.js');
			const views = [...CANONICAL_VIEWS.map((v) => ({ ...v, width: 1024, height: 1024 })), HANDS_VIEW];
			for (const view of views) {
				const vv = (vrec.views[view.label] ??= {});
				const file = `${testCase.id}-${variant.id}-${view.label}.png`;
				if (vv.file && existsSync(path.join(OUT_DIR, file))) continue;
				try {
					const { png } = await renderClip({
						glbUrl: vrec.glbUrl,
						width: view.width,
						height: view.height,
						background: RENDER_BACKGROUND,
						cameraOrbit: { theta: view.theta, phi: view.phi },
					});
					await mkdir(OUT_DIR, { recursive: true });
					await writeFile(path.join(OUT_DIR, file), png);
					vv.file = file;
					vv.renderError = null;
				} catch (err) {
					vv.renderError = err.message;
				}
				await saveData(data);
			}
			log(`case ${testCase.id}/${variant.id}: rendered ${Object.values(vrec.views).filter((v) => v.file).length}/${views.length} views`);
		}

		// 5. Judge the three canonical views, twice each (bench protocol).
		if (!args.skipJudge) {
			const { CANONICAL_VIEWS } = await import('../api/_lib/quality-bench.js');
			const promptEntry = { prompt: testCase.prompt, subjectClass: testCase.subjectClass, watch: testCase.watch };
			for (const view of CANONICAL_VIEWS) {
				const vv = vrec.views[view.label];
				if (!vv?.file || vv.avg) continue;
				try {
					const png = await readFile(path.join(OUT_DIR, vv.file));
					const scores = [];
					for (let i = 0; i < 2; i += 1) scores.push(await judgeView({ png, promptEntry, viewLabel: view.label }));
					vv.scores = scores;
					vv.avg = avgScores(scores);
					vv.judgeError = null;
				} catch (err) {
					vv.judgeError = err.message;
				}
				await saveData(data);
			}
			const judged = Object.values(vrec.views).filter((v) => v.avg);
			vrec.meanScore = judged.length ? judged.reduce((s, v) => s + v.avg.mean, 0) / judged.length : null;
			vrec.dimMeans = judged.length
				? avgScores(judged.map((v) => ({
					photorealism: v.avg.photorealism,
					geometryIntegrity: v.avg.geometryIntegrity,
					textureFidelity: v.avg.textureFidelity,
					promptAdherence: v.avg.promptAdherence,
				})))
				: null;
			await saveData(data);
			log(`case ${testCase.id}/${variant.id}: mean ${vrec.meanScore == null ? 'n/a (judge failed)' : vrec.meanScore.toFixed(2)}`);
		}
	}
}

async function pool(items, size, worker) {
	const queue = [...items];
	const runners = Array.from({ length: Math.min(size, queue.length) }, async () => {
		for (;;) {
			const item = queue.shift();
			if (!item) return;
			await worker(item);
		}
	});
	await Promise.all(runners);
}

async function main() {
	loadDotEnv();
	if (process.env.AVATAR_AUDIT_SA_FILE && existsSync(process.env.AVATAR_AUDIT_SA_FILE)) {
		process.env.GCP_SERVICE_ACCOUNT_JSON = await readFile(process.env.AVATAR_AUDIT_SA_FILE, 'utf8');
	}
	const args = parseArgs(process.argv.slice(2));
	setOutDir(args.outDir);
	const selected = args.cases === 'all' ? CASES : CASES.filter((c) => args.cases.split(',').includes(c.id));
	if (!selected.length) throw new Error(`no cases matched --cases=${args.cases}`);

	const data = await loadData();
	data.baseUrl = args.baseUrl;
	data.variants = VARIANTS;
	data.judge = { model: (await import('../api/_lib/quality-bench.js')).JUDGE_MODEL, maxTokens: JUDGE_MAX_TOKENS, callsPerView: 2 };
	await saveData(data);

	log(`avatar likeness audit: ${selected.length} cases x ${VARIANTS.length} tiers against ${args.baseUrl} (concurrency ${args.concurrency})`);
	if (!process.env.CRON_SECRET) log('WARNING: CRON_SECRET is unset — the High tier will 402 on the $THREE holder gate');

	await pool(selected, args.concurrency, (c) => runCase(args, data, c).catch((err) => {
		data.cases[c.id] = { ...(data.cases[c.id] || {}), fatalError: err.message };
		return saveData(data);
	}));

	data.finishedAt = new Date().toISOString();
	await saveData(data);

	console.log('\ncase   before(std)   after(high)   delta');
	for (const c of selected) {
		const rec = data.cases[c.id] || {};
		const b = rec.variants?.before?.meanScore;
		const a = rec.variants?.after?.meanScore;
		const fmt = (n) => (typeof n === 'number' ? n.toFixed(2).padStart(5) : ' n/a ');
		const delta = typeof a === 'number' && typeof b === 'number' ? (a - b).toFixed(2).padStart(6) : '   n/a';
		console.log(`${c.id}      ${fmt(b)}         ${fmt(a)}      ${delta}`);
	}
	log(`evidence -> ${DATA_FILE}`);
}

main().catch((err) => {
	console.error('avatar-likeness-audit failed:', err.stack || err.message);
	process.exitCode = 1;
});
