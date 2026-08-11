/**
 * workers/agent-forge: the forge driver's core path.
 *
 * runForge() is the state machine the headless Live Avatar Forge caster runs:
 * POST /api/forge on a free lane, then poll to a terminal state, narrating each
 * distinct real state on the way. These cases pin the contract it has with
 * /api/forge (verified live against production on 2026-08-11): the synchronous
 * done a warm lane returns inside the submit window, the queued-then-poll walk,
 * the `cold_start_seconds` → `cold_seconds` translation the shared narration
 * reads, the lane the API actually served (which is not always the one we asked
 * for), and every error the endpoint can hand back.
 *
 * `fetchImpl` is the function's own injection point, not a stand-in for the
 * service: the live end-to-end run is the other half of this coverage, and it
 * cannot assert on a cold start or a 402 on demand.
 */

import { describe, it, expect } from 'vitest';
import { runForge } from '../workers/agent-forge/forge-run.js';
import { forgeStageNarration } from '../src/shared/forge-frames.js';

// The narration strings under test are produced by src/shared/forge-frames.js and
// contain an em-dash. This repo bans that character in authored source, so the
// expectations name it by code point instead of pasting the glyph.
const DASH = '\u2014';
const READY_LINE = `Model ready ${DASH} loading into the cam`;

const BASE = 'https://three.ws';
const GLB = 'https://cdn.example.com/forge/abc.glb';

function jsonRes(status, body) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// A fetchImpl that answers the submit POST with `submit`, then walks `polls` in
// order (repeating the last one) for every GET. Records the request bodies so a
// test can assert what was actually asked of /api/forge.
function scriptedFetch(submit, polls = []) {
	const calls = [];
	let pollIndex = 0;
	const impl = async (url, init = {}) => {
		calls.push({ url, init });
		if (init.method === 'POST') return submit;
		const res = polls[Math.min(pollIndex, polls.length - 1)];
		pollIndex += 1;
		return res;
	};
	impl.calls = calls;
	return impl;
}

describe('runForge submit', () => {
	it('asks /api/forge for the free lane with the caller tier', async () => {
		const fetchImpl = scriptedFetch(jsonRes(200, { status: 'done', glb_url: GLB, backend: 'nvidia', tier: 'standard', durable: true }));
		await runForge({ base: BASE, prompt: 'a red origami crane', tier: 'standard', fetchImpl });

		expect(fetchImpl.calls).toHaveLength(1);
		expect(fetchImpl.calls[0].url).toBe(`${BASE}/api/forge`);
		const body = JSON.parse(fetchImpl.calls[0].init.body);
		expect(body).toEqual({ prompt: 'a red origami crane', tier: 'standard', backend: 'nvidia', path: 'image' });
	});

	it('accepts a synchronous done and shapes the result with a viewer link', async () => {
		const fetchImpl = scriptedFetch(jsonRes(200, { status: 'done', glb_url: GLB, backend: 'nvidia', tier: 'draft', durable: true }));
		const stages = [];
		const result = await runForge({ base: BASE, prompt: 'a brass owl', onStage: (s) => stages.push(s), fetchImpl });

		expect(result).toEqual({
			glbUrl: GLB,
			viewerUrl: `${BASE}/viewer?src=${encodeURIComponent(GLB)}`,
			tier: 'draft',
			backend: 'nvidia',
			durable: true,
		});
		// The caller owns the 'submitting' line, so the driver's first narration is
		// the first state the API actually reported. A duplicate here would push two
		// identical "Forging…" frames onto the live screen.
		expect(stages.map((s) => s.status)).toEqual(['done']);
	});

	it('reports the lane the API really served, not the one requested', async () => {
		// Production free-firsts across its own GPU workers; a request pinned to
		// backend:'nvidia' routinely comes back served by another free engine.
		const fetchImpl = scriptedFetch(jsonRes(200, { status: 'done', glb_url: GLB, backend: 'huggingface', tier: 'draft', durable: true }));
		const stages = [];
		const result = await runForge({ base: BASE, prompt: 'a brass owl', onStage: (s) => stages.push(s), fetchImpl });

		expect(result.backend).toBe('huggingface');
		expect(forgeStageNarration(stages[0])).toBe(READY_LINE);
	});
});

describe('runForge poll walk', () => {
	it('narrates each distinct state once and resolves on the terminal done', async () => {
		const fetchImpl = scriptedFetch(
			jsonRes(200, { job_id: 'job-1', status: 'queued', backend: 'trellis_selfhost', eta_seconds: 40 }),
			[
				jsonRes(200, { job_id: 'job-1', status: 'running', backend: 'trellis_selfhost', eta_seconds: 20 }),
				jsonRes(200, { job_id: 'job-1', status: 'running', backend: 'trellis_selfhost' }),
				jsonRes(200, { job_id: 'job-1', status: 'done', glb_url: GLB, backend: 'trellis_selfhost', tier: 'draft', durable: true }),
			],
		);
		const lines = [];
		const result = await runForge({
			base: BASE,
			prompt: 'a brass owl',
			pollMs: 0,
			onStage: (s) => lines.push(forgeStageNarration(s)),
			fetchImpl,
		});

		expect(result.glbUrl).toBe(GLB);
		// queued → running → done; the repeated 'running' poll narrates nothing new.
		expect(lines).toEqual([
			`Queued on the TRELLIS lane ${DASH} ~40s`,
			`Building geometry & texturing ${DASH} ~20s`,
			READY_LINE,
		]);
		expect(fetchImpl.calls[1].url).toBe(`${BASE}/api/forge?job=job-1`);
	});

	it('names the booting GPU worker instead of going silent through a cold start', async () => {
		// /api/forge reports the spin-up budget as `cold_start_seconds`; the shared
		// narration reads `cold_seconds`. Without the translation this line degrades
		// to a bare "Queued" and a 90s worker boot reads as a stall.
		const fetchImpl = scriptedFetch(
			jsonRes(200, { job_id: 'job-2', status: 'queued', backend: 'hunyuan3d', cold_start: true, cold_start_seconds: 90 }),
			[jsonRes(200, { job_id: 'job-2', status: 'done', glb_url: GLB, backend: 'hunyuan3d', durable: true })],
		);
		const lines = [];
		await runForge({ base: BASE, prompt: 'a brass owl', pollMs: 0, onStage: (s) => lines.push(forgeStageNarration(s)), fetchImpl });

		expect(lines[0]).toBe('Waking up the Hunyuan3D GPU worker (about 90s), then sculpting starts');
	});

	it('keeps polling through a transient network blip and a 5xx', async () => {
		let n = 0;
		const fetchImpl = async (url, init = {}) => {
			if (init.method === 'POST') return jsonRes(200, { job_id: 'job-3', status: 'queued', backend: 'nvidia' });
			n += 1;
			if (n === 1) throw new Error('ECONNRESET');
			if (n === 2) return jsonRes(502, { message: 'bad gateway' });
			return jsonRes(200, { job_id: 'job-3', status: 'done', glb_url: GLB, backend: 'nvidia', durable: true });
		};
		const result = await runForge({ base: BASE, prompt: 'a brass owl', pollMs: 0, fetchImpl });
		expect(result.glbUrl).toBe(GLB);
		expect(n).toBe(3);
	});

	it('gives up with the elapsed budget when the job never finishes', async () => {
		const fetchImpl = scriptedFetch(
			jsonRes(200, { job_id: 'job-4', status: 'queued', backend: 'nvidia' }),
			[jsonRes(200, { job_id: 'job-4', status: 'running', backend: 'nvidia' })],
		);
		await expect(
			runForge({ base: BASE, prompt: 'a brass owl', pollMs: 0, budgetMs: 5, fetchImpl }),
		).rejects.toThrow(/did not finish within 0s/);
	});
});

describe('runForge failure modes', () => {
	it('surfaces a failed job with the provider reason', async () => {
		const fetchImpl = scriptedFetch(
			jsonRes(200, { job_id: 'job-5', status: 'queued', backend: 'nvidia' }),
			[jsonRes(200, { job_id: 'job-5', status: 'failed', error: 'the mesh came back empty' })],
		);
		await expect(runForge({ base: BASE, prompt: 'a brass owl', pollMs: 0, fetchImpl })).rejects.toThrow(
			'the mesh came back empty',
		);
	});

	it('falls back to prompt advice when a failed job carries no reason', async () => {
		const fetchImpl = scriptedFetch(
			jsonRes(200, { job_id: 'job-6', status: 'queued', backend: 'nvidia' }),
			[jsonRes(200, { job_id: 'job-6', status: 'failed' })],
		);
		await expect(runForge({ base: BASE, prompt: 'x y z', pollMs: 0, fetchImpl })).rejects.toThrow(
			/try a more concrete prompt/,
		);
	});

	it('names the ungated tiers when the High gate answers 402', async () => {
		// The worker forges unauthenticated, so the $THREE hold-or-pay gate on
		// forge.high is a tier choice, not an outage. The recovery must be in the
		// line, since this text is what a viewer reads on the live screen.
		const fetchImpl = scriptedFetch(
			jsonRes(402, { error: 'three_hold_required', message: 'High-quality generation requires holding $THREE (Bronze+).' }),
		);
		await expect(runForge({ base: BASE, prompt: 'a brass owl', tier: 'high', fetchImpl })).rejects.toThrow(
			/FORGE_TIER=draft or standard/,
		);
	});

	it('reports an unconfigured deployment (503) and a busy lane (429) distinctly', async () => {
		await expect(
			runForge({ base: BASE, prompt: 'a brass owl', fetchImpl: scriptedFetch(jsonRes(503, { message: 'no free engine here' })) }),
		).rejects.toThrow('no free engine here');

		await expect(
			runForge({ base: BASE, prompt: 'a brass owl', fetchImpl: scriptedFetch(jsonRes(429, {})) }),
		).rejects.toThrow(/busy/);
	});

	it('reports an unreachable endpoint rather than throwing a raw network error', async () => {
		const fetchImpl = async () => {
			throw new Error('getaddrinfo ENOTFOUND three.ws');
		};
		await expect(runForge({ base: BASE, prompt: 'a brass owl', fetchImpl })).rejects.toThrow(
			/free 3D lane unreachable: getaddrinfo ENOTFOUND/,
		);
	});

	it('rejects a submit that returns neither a job nor a mesh', async () => {
		const fetchImpl = scriptedFetch(jsonRes(400, { message: 'prompt is required' }));
		await expect(runForge({ base: BASE, prompt: 'a brass owl', fetchImpl })).rejects.toThrow('prompt is required');
	});
});
