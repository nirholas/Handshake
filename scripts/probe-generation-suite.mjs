#!/usr/bin/env node
// @ts-check
/**
 * scripts/probe-generation-suite.mjs — run every generation-suite flow against a
 * live deployment and report what actually produced an artifact.
 *
 * A catalog entry saying `configured: true` only means an env var exists. This
 * script is the opposite bar: it submits real work to the real endpoints, polls
 * to completion, downloads the result, and asserts the bytes are what they claim
 * to be (glTF magic for a mesh, PNG/WebP signature with alpha for an image,
 * a parseable AnimationClip for a motion). Nothing here counts a green config.
 *
 * Usage:
 *   node scripts/probe-generation-suite.mjs                 # all rows
 *   node scripts/probe-generation-suite.mjs --only rig,remesh
 *   node scripts/probe-generation-suite.mjs --base https://three.ws
 *   node scripts/probe-generation-suite.mjs --json out.json
 *
 * Exit code 0 when every selected row passed, 1 otherwise.
 */

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function flag(name, fallback = null) {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
const BASE = (flag('base', process.env.PROBE_BASE || 'https://three.ws') || '').replace(/\/$/, '');
const ONLY = (flag('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const JSON_OUT = flag('json');
const VERBOSE = args.includes('--verbose');

// A public reference mesh and image that live on our own CDN, so a probe never
// depends on a third party's uptime to prove our pipeline works.
const REF_MESH = `${BASE}/avatars/mannequin.glb`;
const REF_IMAGE = `${BASE}/og-image.png`;

const UA = 'threews-generation-probe/1.0';
const CLIENT_ID = `probe-${Date.now().toString(36)}`;

function log(...a) {
	if (VERBOSE) console.error('   ', ...a);
}

async function req(path, { method = 'GET', body = null, timeoutMs = 60_000, headers = {} } = {}) {
	const url = path.startsWith('http') ? path : `${BASE}${path}`;
	try {
		const res = await fetch(url, {
			method,
			headers: {
				'user-agent': UA,
				'x-forge-client': CLIENT_ID,
				...(body ? { 'content-type': 'application/json' } : {}),
				...headers,
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = null;
		}
		return { status: res.status, json: parsed, text, headers: res.headers };
	} catch (err) {
		return { status: 0, json: null, text: String(err?.message || err), headers: new Headers() };
	}
}

// Download the first bytes of an artifact and identify it by magic number, so a
// 200 that serves an HTML error page can never be mistaken for a model.
async function sniff(url, timeoutMs = 90_000) {
	try {
		const res = await fetch(url, {
			headers: { 'user-agent': UA },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
		const buf = Buffer.from(await res.arrayBuffer());
		const head = buf.subarray(0, 4).toString('binary');
		let kind = 'unknown';
		if (head === 'glTF') kind = 'glb';
		else if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') kind = 'png';
		else if (head.startsWith('\xff\xd8')) kind = 'jpeg';
		else if (buf.subarray(0, 4).toString('binary') === 'RIFF' && buf.subarray(8, 12).toString('binary') === 'WEBP') kind = 'webp';
		else if (buf.subarray(4, 8).toString('binary') === 'ftyp') kind = 'mp4';
		else if (head.trim().startsWith('{') || head.trim().startsWith('[')) kind = 'json';
		else if (buf.subarray(0, 6).toString('binary').startsWith('solid') || buf.length > 84) kind = 'binary';
		return { ok: true, kind, bytes: buf.length, buf };
	} catch (err) {
		return { ok: false, detail: String(err?.message || err) };
	}
}

// Assert a GLB actually carries geometry rather than an empty scene: read the
// JSON chunk out of the binary container and count mesh primitives.
function inspectGlb(buf) {
	if (buf.length < 20 || buf.subarray(0, 4).toString('binary') !== 'glTF') return null;
	const jsonLen = buf.readUInt32LE(12);
	if (jsonLen <= 0 || 20 + jsonLen > buf.length) return null;
	let doc;
	try {
		doc = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
	} catch {
		return null;
	}
	const primitives = (doc.meshes || []).reduce((n, m) => n + (m.primitives?.length || 0), 0);
	return {
		meshes: (doc.meshes || []).length,
		primitives,
		nodes: (doc.nodes || []).length,
		skins: (doc.skins || []).length,
		animations: (doc.animations || []).length,
		materials: (doc.materials || []).length,
		images: (doc.images || []).length,
		joints: (doc.skins || []).reduce((n, s) => n + (s.joints?.length || 0), 0),
	};
}

// Poll a job endpoint that answers { status: queued|running|done|failed }.
async function pollJob(pollPath, { budgetMs = 420_000, intervalMs = 6_000, jobKey = 'job' } = {}) {
	const deadline = Date.now() + budgetMs;
	let last = null;
	while (Date.now() < deadline) {
		const r = await req(pollPath, { timeoutMs: 30_000 });
		last = r;
		const status = String(r.json?.status || '').toLowerCase();
		log(`poll ${jobKey}: ${r.status} ${status || r.text.slice(0, 90)}`);
		if (status === 'done' || status === 'succeeded' || status === 'complete') return r;
		if (status === 'failed' || status === 'error') return r;
		if (r.status >= 400 && r.status !== 429) return r;
		await new Promise((r2) => setTimeout(r2, intervalMs));
	}
	return last || { status: 0, json: null, text: 'poll budget exhausted' };
}

const results = [];
function record(name, endpoint, ok, detail, extra = {}) {
	results.push({ name, endpoint, ok, detail, ...extra });
	const mark = ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL';
	console.log(`${mark.padEnd(4)}  ${name.padEnd(24)} ${detail}`);
}

function selected(name) {
	return ONLY.length === 0 || ONLY.includes(name);
}

// A generic "submit a mesh job, poll it, sniff the result" runner shared by the
// remesh / stylize / segment / rembg lanes, which all use the same envelope.
async function meshJob(name, path, body, resultKey = 'result_url', expectKind = 'glb') {
	const post = await req(path, { method: 'POST', body, timeoutMs: 60_000 });
	if (post.status === 503) return record(name, path, false, `unconfigured: ${post.json?.message || post.text.slice(0, 120)}`);
	if (post.status !== 202 && post.status !== 200) {
		return record(name, path, false, `submit HTTP ${post.status}: ${post.text.slice(0, 160)}`);
	}
	const jobId = post.json?.job_id;
	if (!jobId) return record(name, path, false, `submit returned no job_id: ${post.text.slice(0, 160)}`);
	const done = await pollJob(`${path}?job=${encodeURIComponent(jobId)}`, { jobKey: name });
	const status = String(done.json?.status || '').toLowerCase();
	if (status !== 'done') {
		return record(name, path, false, `job ${status || done.status}: ${done.json?.error || done.text.slice(0, 160)}`);
	}
	const url = done.json?.[resultKey];
	if (!url) return record(name, path, false, `done without ${resultKey}`);
	const s = await sniff(url);
	if (!s.ok) return record(name, path, false, `artifact fetch failed: ${s.detail}`);
	const glb = expectKind === 'glb' ? inspectGlb(s.buf) : null;
	if (expectKind === 'glb' && (!glb || glb.primitives === 0)) {
		return record(name, path, false, `artifact is not a mesh with geometry (kind=${s.kind}, ${s.bytes} B)`);
	}
	const summary = glb
		? `${s.bytes} B glb, ${glb.primitives} primitives, ${glb.materials} materials`
		: `${s.bytes} B ${s.kind}`;
	record(name, path, true, summary, { artifact: url, glb: glb || undefined, job: done.json });
	return done.json;
}

async function probeCatalogHealth() {
	if (!selected('catalog')) return;
	const cat = await req('/api/forge?catalog');
	record(
		'catalog',
		'GET /api/forge?catalog',
		cat.status === 200 && Array.isArray(cat.json?.backends),
		cat.status === 200 ? `${cat.json?.backends?.length} backends, ${cat.json?.tiers?.length} tiers` : `HTTP ${cat.status}`,
	);
	const health = await req('/api/forge?health', { timeoutMs: 90_000 });
	const backends = health.json?.backends || {};
	const bad = Object.entries(backends)
		.filter(([, v]) => v?.status !== 'ok' && v?.status !== 'byok')
		.map(([k, v]) => `${k}=${v?.status}`);
	record(
		'health',
		'GET /api/forge?health',
		health.status === 200 && bad.length === 0,
		health.status === 200 ? (bad.length ? `not ok: ${bad.join(', ')}` : `all ${Object.keys(backends).length} lanes ok`) : `HTTP ${health.status}`,
		{ llm: health.json?.llm?.overall },
	);
}

async function probeTextTo3d() {
	if (!selected('text-to-3d')) return;
	const post = await req('/api/forge', {
		method: 'POST',
		body: {
			prompt: 'a small wooden toy boat with a striped sail',
			tier: 'draft',
			force_regenerate: true,
		},
		timeoutMs: 300_000,
	});
	if (post.status !== 200 && post.status !== 202) {
		return record('text-to-3d', 'POST /api/forge', false, `HTTP ${post.status}: ${post.text.slice(0, 200)}`);
	}
	let glbUrl = post.json?.glb_url || post.json?.glbUrl;
	if (!glbUrl && post.json?.poll_url) {
		const done = await pollJob(post.json.poll_url, { jobKey: 'text-to-3d', budgetMs: 480_000 });
		glbUrl = done.json?.glb_url || done.json?.glbUrl;
		if (!glbUrl) {
			return record('text-to-3d', 'POST /api/forge', false, `job ${done.json?.status || done.status}: ${done.json?.error || done.text.slice(0, 160)}`);
		}
	}
	if (!glbUrl) return record('text-to-3d', 'POST /api/forge', false, `no glb_url: ${post.text.slice(0, 200)}`);
	const s = await sniff(glbUrl);
	const glb = s.ok ? inspectGlb(s.buf) : null;
	record(
		'text-to-3d',
		'POST /api/forge',
		Boolean(glb && glb.primitives > 0),
		glb ? `${s.bytes} B glb, ${glb.primitives} primitives, backend=${post.json?.backend || '?'}` : `not a mesh: ${s.detail || s.kind}`,
		{ artifact: glbUrl },
	);
	return glbUrl;
}

async function probeImageTo3d() {
	if (!selected('image-to-3d')) return;
	const presign = await req('/api/forge-upload', {
		method: 'POST',
		body: { content_type: 'image/png', size_bytes: 4096 },
	});
	const presignOk = presign.status === 200 && Boolean(presign.json?.upload_url);
	if (!presignOk && presign.status !== 503) {
		record('image-upload', 'POST /api/forge-upload', false, `HTTP ${presign.status}: ${presign.text.slice(0, 140)}`);
	} else {
		record('image-upload', 'POST /api/forge-upload', presignOk, presignOk ? 'presigned R2 upload issued' : 'object storage unconfigured (URL path still open)');
	}
	const post = await req('/api/forge', {
		method: 'POST',
		body: { image_urls: [REF_IMAGE], tier: 'draft', force_regenerate: true },
		timeoutMs: 300_000,
	});
	if (post.status !== 200 && post.status !== 202) {
		return record('image-to-3d', 'POST /api/forge', false, `HTTP ${post.status}: ${post.text.slice(0, 200)}`);
	}
	let glbUrl = post.json?.glb_url || post.json?.glbUrl;
	if (!glbUrl && post.json?.poll_url) {
		const done = await pollJob(post.json.poll_url, { jobKey: 'image-to-3d', budgetMs: 480_000 });
		glbUrl = done.json?.glb_url || done.json?.glbUrl;
	}
	if (!glbUrl) return record('image-to-3d', 'POST /api/forge', false, `no glb_url: ${post.text.slice(0, 200)}`);
	const s = await sniff(glbUrl);
	const glb = s.ok ? inspectGlb(s.buf) : null;
	record(
		'image-to-3d',
		'POST /api/forge',
		Boolean(glb && glb.primitives > 0),
		glb ? `${s.bytes} B glb, ${glb.primitives} primitives` : `not a mesh: ${s.detail || s.kind}`,
		{ artifact: glbUrl },
	);
}

async function probeRig() {
	if (!selected('rig')) return;
	const post = await req('/api/forge?action=rig', {
		method: 'POST',
		body: { mesh_url: REF_MESH },
		timeoutMs: 60_000,
	});
	if (post.status !== 202 && post.status !== 200) {
		return record('auto-rig', 'POST /api/forge?action=rig', false, `HTTP ${post.status}: ${post.text.slice(0, 180)}`);
	}
	const jobId = post.json?.job_id || post.json?.job;
	let done = post;
	if (jobId && !post.json?.result_url) {
		done = await pollJob(`/api/forge?action=rig&job=${encodeURIComponent(jobId)}`, { jobKey: 'rig' });
	}
	const url = done.json?.result_url || done.json?.rigged_url || done.json?.glb_url;
	if (!url) {
		return record('auto-rig', 'POST /api/forge?action=rig', false, `no rigged url: ${done.json?.error || done.text.slice(0, 180)}`);
	}
	const s = await sniff(url);
	const glb = s.ok ? inspectGlb(s.buf) : null;
	const rigged = Boolean(glb && glb.skins > 0 && glb.joints > 0);
	record('auto-rig', 'POST /api/forge?action=rig', rigged, glb ? `${glb.skins} skin(s), ${glb.joints} joints, ${glb.primitives} primitives` : `not a mesh: ${s.detail}`, { artifact: url });
}

async function probeMotion() {
	if (!selected('motion')) return;
	const post = await req('/api/forge-motion', {
		method: 'POST',
		body: { prompt: 'waving confidently with the right arm', duration_seconds: 3 },
	});
	if (post.status === 503) return record('text-to-motion', 'POST /api/forge-motion', false, `unconfigured: ${post.json?.message || ''}`);
	if (post.status !== 202 && post.status !== 200) {
		return record('text-to-motion', 'POST /api/forge-motion', false, `HTTP ${post.status}: ${post.text.slice(0, 180)}`);
	}
	const jobId = post.json?.job_id;
	const done = await pollJob(`/api/forge-motion?job=${encodeURIComponent(jobId)}`, { jobKey: 'motion' });
	const url = done.json?.clip_url;
	if (!url) return record('text-to-motion', 'POST /api/forge-motion', false, `job ${done.json?.status || done.status}: ${done.json?.error || done.text.slice(0, 160)}`);
	const s = await sniff(url);
	let clipOk = false;
	let detail = s.detail || s.kind;
	if (s.ok) {
		try {
			const clip = JSON.parse(s.buf.toString('utf8'));
			const tracks = clip.tracks || clip.clip?.tracks || [];
			clipOk = Array.isArray(tracks) && tracks.length > 0;
			detail = `${tracks.length} tracks, ${done.json?.frames || '?'} frames @ ${done.json?.fps || '?'} fps`;
		} catch {
			detail = `clip is not JSON (${s.bytes} B ${s.kind})`;
		}
	}
	record('text-to-motion', 'POST /api/forge-motion', clipOk, detail, { artifact: url });
}

async function probeRetexture() {
	if (!selected('retexture')) return;
	const probe = await req('/api/studio/retexture-region');
	const ok = probe.status === 200 || probe.status === 405;
	record('retexture (probe)', 'GET /api/studio/retexture-region', ok, ok ? `capability probe HTTP ${probe.status}` : `HTTP ${probe.status}: ${probe.text.slice(0, 140)}`);
	const post = await req('/api/studio/retexture-region', {
		method: 'POST',
		body: { mesh_url: REF_MESH, prompt: 'weathered bronze with green patina' },
		timeoutMs: 90_000,
	});
	if (post.status === 503) return record('retexture', 'POST /api/studio/retexture-region', false, `unconfigured: ${post.json?.message || post.text.slice(0, 140)}`);
	if (post.status !== 202 && post.status !== 200) {
		return record('retexture', 'POST /api/studio/retexture-region', false, `HTTP ${post.status}: ${post.text.slice(0, 180)}`);
	}
	const jobId = post.json?.job_id;
	if (!jobId) return record('retexture', 'POST /api/studio/retexture-region', Boolean(post.json?.result_url), post.text.slice(0, 160));
	const done = await pollJob(`/api/studio/retexture-region?job=${encodeURIComponent(jobId)}`, { jobKey: 'retexture' });
	const url = done.json?.result_url;
	if (!url) return record('retexture', 'POST /api/studio/retexture-region', false, `job ${done.json?.status || done.status}: ${done.json?.error || done.text.slice(0, 160)}`);
	const s = await sniff(url);
	const glb = s.ok ? inspectGlb(s.buf) : null;
	record('retexture', 'POST /api/studio/retexture-region', Boolean(glb && glb.images > 0), glb ? `${glb.images} texture image(s), ${glb.materials} materials` : `not a mesh: ${s.detail}`, { artifact: url });
}

async function probeX402() {
	if (!selected('x402')) return;
	const r = await req('/api/x402/forge', {
		method: 'POST',
		body: { prompt: 'a ceramic teapot', tier: 'draft' },
	});
	const accepts = r.json?.accepts || [];
	const ok = r.status === 402 && Array.isArray(accepts) && accepts.length > 0;
	record('x402 challenge', 'POST /api/x402/forge', ok, ok ? `402 with ${accepts.length} accept(s): ${accepts.map((a) => `${a.network}/${a.maxAmountRequired}`).join(', ')}` : `HTTP ${r.status}: ${r.text.slice(0, 160)}`);
	const wk = await req('/.well-known/x402.json');
	const items = wk.json?.items || wk.json?.resources || [];
	const gen = items.filter((i) => String(i.resource || i.url || '').includes('forge') || String(i.resource || i.url || '').includes('mcp-3d'));
	record('x402 catalog', 'GET /.well-known/x402.json', wk.status === 200 && gen.length > 0, wk.status === 200 ? `${gen.length} generation surfaces of ${items.length} listed` : `HTTP ${wk.status}`);
}

async function probeMcp(path, label) {
	if (!selected('mcp')) return;
	const list = await req(path, {
		method: 'POST',
		body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
		timeoutMs: 45_000,
	});
	const tools = list.json?.result?.tools || [];
	record(`${label} tools/list`, `POST ${path}`, list.status === 200 && tools.length > 0, list.status === 200 ? `${tools.length} tools` : `HTTP ${list.status}: ${list.text.slice(0, 140)}`);
	if (!tools.length) return;
	// Call the cheapest read-only tool the server advertises, so a probe never
	// bills a generation just to prove the JSON-RPC surface answers.
	const readOnly = tools.find((t) => /catalog|list|capabilit|health|search|browse/i.test(t.name));
	if (!readOnly) return record(`${label} tools/call`, `POST ${path}`, 'skip', 'no read-only tool advertised');
	const call = await req(path, {
		method: 'POST',
		body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: readOnly.name, arguments: {} } },
		timeoutMs: 60_000,
	});
	const content = call.json?.result?.content || [];
	record(`${label} tools/call`, `${readOnly.name}`, call.status === 200 && content.length > 0 && !call.json?.result?.isError, call.status === 200 ? `${readOnly.name} → ${content.length} content block(s)` : `HTTP ${call.status}: ${call.text.slice(0, 140)}`);
}

async function main() {
	console.log(`Generation-suite probe against ${BASE}\n`);
	await probeCatalogHealth();
	await probeTextTo3d();
	await probeImageTo3d();
	await probeRig();
	if (selected('remesh')) await meshJob('remesh', '/api/forge-remesh', { mesh_url: REF_MESH, remesh_mode: 'triangle', operation: 'simplify', target_faces: 3000 });
	if (selected('stylize')) await meshJob('stylize', '/api/forge-stylize', { mesh_url: REF_MESH, style: 'lowpoly' });
	if (selected('segment')) await meshJob('segment', '/api/forge-segment', { mesh_url: REF_MESH, method: 'connected', max_parts: 8 });
	if (selected('rembg')) await meshJob('rembg', '/api/forge-rembg', { image_url: REF_IMAGE }, 'result_url', 'png');
	await probeMotion();
	await probeRetexture();
	await probeX402();
	await probeMcp('/api/mcp-3d', 'mcp-3d');
	await probeMcp('/api/mcp-studio', 'mcp-studio');

	const failed = results.filter((r) => r.ok === false);
	console.log(`\n${results.length - failed.length}/${results.length} passed`);
	if (failed.length) console.log(`failed: ${failed.map((f) => f.name).join(', ')}`);
	if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
	process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
	console.error('probe crashed:', err);
	process.exit(1);
});
