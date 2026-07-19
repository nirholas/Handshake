// POST /api/agents/a2a-paid — A2A (Agent-to-Agent) x402 endpoint.
//
// Exposes the three.ws glTF/GLB inspector as a paid A2A skill. Other agents
// invoke it by sending JSON-RPC `message/send` with the X-A2A-Extensions
// header set to https://github.com/google-a2a/a2a-x402/v0.1.
//
// First call (no payment metadata): replies with a task in state
//   `input-required` carrying `x402.payment.required`.
// Retry with the signed `x402.payment.payload`: replies with state
//   `completed`, a settlement receipt, and an `artifacts` entry containing
//   the structured inspection report.
//
// Verification + settlement reuse api/_lib/x402-spec.js so this endpoint
// inherits Base / Solana / BSC support automatically from the env config.

import { a2aPaidEndpoint } from '../_lib/x402/a2a-server.js';
import { inspectModel, suggestOptimizations } from '../_lib/model-inspect.js';
import { assertSafePublicUrl, SsrfBlockedError } from '../_lib/ssrf-guard.js';

const ROUTE = '/api/agents/a2a-paid';
const MAX_FETCH_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// SSRF-safe fetch: re-validate every redirect hop with assertSafePublicUrl
// before following it. The model URL is fully attacker-controlled, so following
// redirects with the global `redirect:'follow'` would let an allowlisted public
// host 302 us to 169.254.169.254 / RFC1918, defeating the guard. Bounded hops.
async function fetchModelFollowingValidatedRedirects(parsed) {
	let url = parsed;
	let redirects = 0;
	while (true) {
		const res = await fetch(url.toString(), {
			redirect: 'manual',
			headers: { accept: 'model/gltf-binary,model/gltf+json,application/octet-stream' },
			signal: AbortSignal.timeout(20_000),
		});
		if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
			if (++redirects > MAX_REDIRECTS) {
				const e = new Error('too many redirects');
				e.code = 'fetch_failed';
				e.status = 502;
				throw e;
			}
			const next = new URL(res.headers.get('location'), url);
			url = await assertSafePublicUrl(next.toString(), { allowHttp: true });
			continue;
		}
		return res;
	}
}

const DESCRIPTION =
	'three.ws A2A glTF/GLB Inspector — pay per call (USDC). Fetch a 3D model ' +
	'from a public URL and return structural stats (vertices, triangles, ' +
	'materials, textures, extensions) plus a prioritized list of optimization ' +
	'recommendations. Used by other agents to vet 3D assets before minting, ' +
	'rendering, or buying them.';

const SKILL = {
	id: 'inspect-glb-a2a',
	name: 'Inspect glTF/GLB (A2A)',
	description:
		'Run the canonical glTF-Transform inspector against a remote model URL. ' +
		'Returns counts, extensions used, and prioritized optimization suggestions.',
	tags: ['model', 'gltf', 'glb', 'inspect', 'a2a'],
	examples: [
		'Inspect https://three.ws/avatars/mannequin.glb',
		'Vet this GLB before I mint it',
	],
	inputModes: ['application/json', 'text/plain'],
	outputModes: ['application/json'],
};

// Pull the model URL out of the A2A `message.parts[]`. Clients send the
// request either as a plain text part ("Inspect https://...") or as a
// `data` part with `{ url: "..." }`.
function extractUrl(message) {
	const parts = Array.isArray(message?.parts) ? message.parts : [];
	for (const part of parts) {
		if (part?.kind === 'data' && part.data && typeof part.data.url === 'string') {
			return part.data.url.trim();
		}
		if (part?.kind === 'text' && typeof part.text === 'string') {
			const match = /\bhttps?:\/\/\S+\.(?:glb|gltf)\b/i.exec(part.text);
			if (match) return match[0];
			// Allow a bare URL with no extension when the part is *only* a URL.
			const trimmed = part.text.trim();
			try {
				const u = new URL(trimmed);
				if (u.protocol === 'http:' || u.protocol === 'https:') return trimmed;
			} catch {
				/* not a URL, keep scanning */
			}
		}
	}
	return null;
}

async function fetchAndInspect(targetUrl) {
	let parsed;
	try {
		parsed = await assertSafePublicUrl(targetUrl, { allowHttp: true });
	} catch (err) {
		if (err instanceof SsrfBlockedError) {
			const e = new Error(err.message);
			e.code = 'invalid_url';
			e.status = 400;
			throw e;
		}
		throw err;
	}
	let upstream;
	try {
		upstream = await fetchModelFollowingValidatedRedirects(parsed);
	} catch (err) {
		if (err instanceof SsrfBlockedError) {
			const e = new Error(err.message);
			e.code = 'invalid_url';
			e.status = 400;
			throw e;
		}
		const e = new Error(`could not fetch model: ${err.message}`);
		e.code = 'fetch_failed';
		e.status = 502;
		throw e;
	}
	if (!upstream.ok) {
		const err = new Error(`upstream returned ${upstream.status} ${upstream.statusText}`);
		err.code = 'fetch_failed';
		err.status = 502;
		throw err;
	}
	const contentLength = Number(upstream.headers.get('content-length') || 0);
	if (contentLength && contentLength > MAX_FETCH_BYTES) {
		const err = new Error(`model is ${contentLength} bytes; max is ${MAX_FETCH_BYTES}`);
		err.code = 'too_large';
		err.status = 413;
		throw err;
	}
	const buf = new Uint8Array(await upstream.arrayBuffer());
	if (buf.byteLength > MAX_FETCH_BYTES) {
		const err = new Error(`model is ${buf.byteLength} bytes; max is ${MAX_FETCH_BYTES}`);
		err.code = 'too_large';
		err.status = 413;
		throw err;
	}
	let info;
	try {
		info = await inspectModel(buf, { fileSize: buf.byteLength });
	} catch (err) {
		const e = new Error(err.message || 'failed to parse model');
		e.code = 'invalid_model';
		e.status = 422;
		throw e;
	}
	return {
		url: parsed.toString(),
		fetchedBytes: buf.byteLength,
		model: info,
		suggestions: suggestOptimizations(info),
	};
}

export default a2aPaidEndpoint({
	route: ROUTE,
	description: DESCRIPTION,
	priceAtomics: '1000',
	networks: ['base', 'solana'],
	prompt:
		'Send the URL of a glTF or GLB model in the next message (text or data part). ' +
		'Inspection completes after payment settles.',
	skill: SKILL,
	services: ['gltf-inspect'],
	async handler({ taskId, payer, message }) {
		const url = extractUrl(message);
		if (!url) {
			const err = new Error(
				'no model URL found in message — include a text part with the URL or a data part with { url }',
			);
			err.code = 'missing_url';
			throw err;
		}
		const report = await fetchAndInspect(url);
		const headline =
			`Inspected ${report.url} (${report.fetchedBytes} bytes). ` +
			`Found ${report.model?.counts?.totalTriangles ?? '?'} triangles across ` +
			`${report.model?.counts?.meshes ?? '?'} meshes. ` +
			`${report.suggestions.length} optimization suggestion(s).`;
		return {
			text: headline,
			artifacts: [
				{
					artifactId: taskId,
					name: 'gltf-inspection.json',
					description: 'glTF-Transform inspection report + optimization suggestions.',
					parts: [{ kind: 'data', data: report }],
				},
			],
			metadata: {
				'three.ws.payer': payer || null,
				'three.ws.skill': SKILL.id,
			},
		};
	},
});
