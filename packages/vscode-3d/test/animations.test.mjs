// The library, clip fetch, and text to motion clients against a local stand-in
// for the three.ws API, so the paging, polling, and error paths are pinned.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { clipSlug, fetchClip, generateMotion, listLibrary, normalizeClip } from '../src/animations.js';
import { readRefineResult } from '../src/refine.js';
import { checkQuality, qualityMarkdown } from '../src/quality.js';

function serve(handler) {
	return new Promise((resolve) => {
		const server = createServer(handler);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
		});
	});
}

const CLIP = { name: 'mx-wave-abc', duration: 1, tracks: [{ name: 'Hips.quaternion', type: 'quaternion', times: [0], values: [0, 0, 0, 1] }] };

test('normalizeClip keeps only fetchable rows and clipSlug strips the hash', () => {
	assert.equal(normalizeClip({ label: 'X' }), null);
	assert.deepEqual(normalizeClip({ name: 'mx-happy-idle-c9cd5a01b96c', label: 'Happy Idle', loop: true, duration: 2.5, url: 'https://cdn/x.json', thumb: 'https://cdn/x.webp' }), {
		name: 'mx-happy-idle-c9cd5a01b96c',
		label: 'Happy Idle',
		loop: true,
		duration: 2.5,
		url: 'https://cdn/x.json',
		thumb: 'https://cdn/x.webp',
	});
	assert.equal(clipSlug('Happy Idle'), 'happy-idle');
	assert.equal(clipSlug('mx-happy-idle-c9cd5a01b96c'), 'happy-idle');
	assert.equal(clipSlug('waving confidently with the right hand'), 'waving-confidently-with-the-right-hand');
});

test('listLibrary pages through the manifest until next_offset is null', async () => {
	const seen = [];
	const { origin, close } = await serve((req, res) => {
		const url = new URL(req.url, origin);
		const offset = Number(url.searchParams.get('offset'));
		seen.push(offset);
		const page = offset === 0
			? { clips: [{ name: 'a', label: 'A', url: 'https://cdn/a.json' }, { name: 'bad' }], total: 3, next_offset: 1000 }
			: { clips: [{ name: 'b', label: 'B', url: 'https://cdn/b.json', loop: true }], total: 3, next_offset: null };
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(page));
	});
	try {
		const clips = await listLibrary(origin);
		assert.deepEqual(clips.map((c) => c.label), ['A', 'B']);
		assert.deepEqual(seen, [0, 1000]);
	} finally {
		await close();
	}
});

test('fetchClip rejects a clip with no tracks', async () => {
	const { origin, close } = await serve((req, res) => {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(req.url.includes('empty') ? { tracks: [] } : CLIP));
	});
	try {
		assert.equal((await fetchClip(`${origin}/clip.json`)).name, 'mx-wave-abc');
		await assert.rejects(fetchClip(`${origin}/empty.json`), /no animation tracks/);
	} finally {
		await close();
	}
});

test('generateMotion starts a job, polls it, and returns the finished clip', async () => {
	let polls = 0;
	const statuses = [];
	const { origin, close } = await serve((req, res) => {
		res.setHeader('content-type', 'application/json');
		if (req.method === 'POST') return res.end(JSON.stringify({ job_id: 'job-1', status: 'queued' }));
		if (req.url.startsWith('/api/forge-motion?job=job-1')) {
			polls++;
			return res.end(JSON.stringify(polls < 2 ? { status: 'running' } : { status: 'done', clip_url: `${origin}/clip.json` }));
		}
		res.end(JSON.stringify(CLIP));
	});
	try {
		const result = await generateMotion(origin, 'wave', { onStatus: (s) => statuses.push(s), pollMs: 20 });
		assert.equal(result.clipUrl, `${origin}/clip.json`);
		assert.equal(result.clip.name, 'mx-wave-abc');
		assert.ok(statuses.some((s) => /sampling/.test(s)));
	} finally {
		await close();
	}
});

test('generateMotion explains an unconfigured lane and a failed job', async () => {
	let mode = 'unconfigured';
	const { origin, close } = await serve((req, res) => {
		res.setHeader('content-type', 'application/json');
		if (mode === 'unconfigured') {
			res.statusCode = 503;
			return res.end(JSON.stringify({ error: 'unconfigured', message: 'Text-to-animation is not configured.' }));
		}
		if (req.method === 'POST') return res.end(JSON.stringify({ job_id: 'job-2' }));
		res.end(JSON.stringify({ status: 'failed', error: 'the motion model rejected the prompt' }));
	});
	try {
		await assert.rejects(generateMotion(origin, 'wave', { pollMs: 20 }), /not configured/);
		mode = 'failing';
		await assert.rejects(generateMotion(origin, 'wave', { pollMs: 20 }), /rejected the prompt/);
	} finally {
		await close();
	}
});

test('readRefineResult understands finished, pending, and refused answers', () => {
	const done = readRefineResult({
		structuredContent: {
			glbUrl: 'https://cdn/v2.glb',
			prompt: 'a robot, metallic',
			instruction: 'make it metallic',
			lineage: [
				{ index: 0, parentIndex: null, glbUrl: 'https://cdn/v1.glb', prompt: 'a robot' },
				{ index: 1, parentIndex: 0, glbUrl: 'https://cdn/v2.glb', prompt: 'a robot, metallic', instruction: 'make it metallic' },
			],
		},
	});
	assert.equal(done.pending, false);
	assert.equal(done.glbUrl, 'https://cdn/v2.glb');
	assert.equal(done.lineage.length, 2);
	assert.equal(done.lineage[1].instruction, 'make it metallic');
	assert.deepEqual(readRefineResult({ structuredContent: { status: 'pending', jobId: 'j' } }), { pending: true, jobId: 'j' });
	assert.throws(() => readRefineResult({ isError: true, content: [{ type: 'text', text: 'That prompt is not allowed.' }] }), /not allowed/);
});

test('checkQuality posts the render and renders the verdict as Markdown', async () => {
	let body = null;
	const { origin, close } = await serve((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			body = JSON.parse(raw);
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({
				verdict: { pass: false, score: 42, realism: 40, completeness: 50, subject: 'robot', subject_detected: 'a toy robot', is_photoreal: false, defects: ['fused fingers'], reason: 'plastic look', suggested_retry_hint: 'brushed steel, worn edges', qa_available: true, provider: 'vertex', model: 'gemini' },
				retry: { prompt: 'x' },
			}));
		});
	});
	try {
		const { verdict } = await checkQuality(origin, { image: 'data:image/png;base64,AAAA', prompt: 'a robot' });
		assert.equal(body.prompt, 'a robot');
		assert.equal(body.image, 'data:image/png;base64,AAAA');
		assert.equal(verdict.score, 42);
		const md = qualityMarkdown(verdict, { modelName: 'robot.glb', prompt: 'a robot' });
		assert.match(md, /\*\*Below the realism bar\*\* · score 42\/100/);
		assert.match(md, /- fused fingers/);
		assert.match(md, /brushed steel/);
		assert.match(md, /Refine this Model/);
		const unavailable = qualityMarkdown({ qa_available: false, reason: 'qa_unavailable: no provider' }, { modelName: 'x' });
		assert.match(unavailable, /could not run/);
		await assert.rejects(checkQuality(origin, { image: 'nope' }), /PNG, JPEG, or WebP/);
	} finally {
		await close();
	}
});
