// Kill-test for the forge_avatar / text_to_avatar rig-stage degrade path
// (prompt 10 of the realism campaign — avatar likeness / IRL people quality).
//
// The mission's definition of done requires: "no regression in the humanoid-gate
// degrade paths — specifically kill-test one rig-failure case and confirm the
// mesh still ships with a working fallback (never a broken/blank result)."
//
// This drives runForgeAvatar end-to-end against a mocked fetch: mesh generation
// succeeds, the rig stage fails outright, and the chain must still return a
// SUCCESSFUL (ok:true) result carrying the real mesh URL with rigged:false —
// never an error, never a blank/broken payload.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.FORGE_AVATAR_DIRECTOR = '0'; // skip the LLM director call in this test
process.env.FORGE_AVATAR_POLL_MS = '5';
process.env.FORGE_AVATAR_RIG_TIMEOUT_MS = '200';

const { runForgeAvatar } = await import('../mcp-server/src/tools/_studio-core.js');

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

describe('runForgeAvatar — rig-stage kill-test', () => {
	let calls;

	beforeEach(() => {
		calls = [];
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('degrades to a mesh-only SUCCESS (never a broken/blank result) when the rig stage fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url, init) => {
				const u = String(url);
				calls.push({ url: u, method: init?.method || 'GET' });

				// Stage 1: mesh generation — succeeds synchronously with a real GLB.
				if (u.includes('/api/forge') && !u.includes('action=rig') && !u.includes('?job=')) {
					const body = JSON.parse(init.body);
					// The avatar chain must always request the strongest ('high') tier.
					expect(body.tier).toBe('high');
					return jsonResponse({
						status: 'done',
						glb_url: 'https://cdn.three.ws/mesh/kill-test.glb',
						creation_id: 'mesh-kill-test',
						backend: 'hunyuan3d',
					});
				}

				// Stage 2: rig submit — accepted, returns a job id.
				if (u.includes('action=rig')) {
					return jsonResponse({ job_id: 'rig-job-kill-test' });
				}

				// Stage 2 poll: the rig job comes back FAILED.
				if (u.includes('?job=rig-job-kill-test')) {
					return jsonResponse({ status: 'failed', error: 'unirig worker OOM' });
				}

				throw new Error(`unexpected fetch: ${u}`);
			}),
		);

		const result = await runForgeAvatar({ prompt: 'a friendly cartoon astronaut in a glossy white suit' });

		// Never a broken/blank result: the call must still report success...
		expect(result.ok).toBe(true);
		// ...with rigging explicitly marked failed...
		expect(result.rigged).toBe(false);
		expect(result.animationReady).toBe(false);
		expect(result.rigError).toBeTruthy();
		expect(result.rigError.code).toBe('rig_failed');
		// ...and the real, finished mesh asset still attached and usable.
		expect(result.meshGlbUrl).toBe('https://cdn.three.ws/mesh/kill-test.glb');
		expect(result.viewerUrl).toContain(encodeURIComponent(result.meshGlbUrl));
		expect(result.riggedGlbUrl).toBeNull();

		// Both stages were actually attempted (no silent short-circuit).
		expect(calls.some((c) => c.url.includes('action=rig'))).toBe(true);
		expect(calls.some((c) => c.url.includes('?job=rig-job-kill-test'))).toBe(true);
	});
});
