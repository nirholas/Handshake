// Turn whatever the user typed into GLB bytes plus a display name.
//
// Accepted sources, tried in this order:
//   a local file path                       ./hero.glb
//   an http(s) URL to a GLB                 https://…/model.glb
//   a three.ws avatar id (uuid)             81a076b6-55ff-…
//   a three.ws agent id (uuid)              bd1b56b0-5494-…  (its bound body)
//   a three.ws page URL                     https://three.ws/avatars/<id>, /agents/<id>
// Ids are looked up against the live API (`/api/avatars/:id`, then
// `/api/agents/:id`), which is the same resolution the web studio performs.

import { access, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_ORIGIN = 'https://three.ws';

/**
 * @typedef {object} Resolved
 * @property {Uint8Array} bytes
 * @property {string} name
 * @property {string} source  file | url | avatar | agent
 * @property {string} [url]
 * @property {string} [page]  the three.ws page for this entity, when known
 */

/**
 * @param {string} input
 * @param {{ origin?: string, fetch?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<Resolved>}
 */
export async function resolveSource(input, opts = {}) {
	const origin = (opts.origin || process.env.THREE_WS_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, '');
	const doFetch = opts.fetch || fetch;
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const raw = String(input || '').trim();
	if (!raw) throw new Error('no source given: pass a .glb path, a URL, or a three.ws avatar/agent id');

	if (await exists(raw)) {
		return { bytes: new Uint8Array(await readFile(raw)), name: basename(raw), source: 'file' };
	}

	let url = null;
	if (/^https?:\/\//i.test(raw)) {
		url = new URL(raw);
		const m = url.pathname.match(/^\/(avatars|agents)\/([0-9a-f-]{36})(?:\/|$)/i);
		if (m) return resolveId(m[2], m[1] === 'agents' ? ['agent', 'avatar'] : ['avatar', 'agent'], url.origin, doFetch, timeoutMs);
		const bytes = await fetchBytes(url.href, doFetch, timeoutMs);
		return { bytes, name: basename(url.pathname) || url.hostname, source: 'url', url: url.href };
	}

	const id = raw.replace(/^(avatar|agent):/i, '');
	const kindFirst = /^agent:/i.test(raw) ? ['agent', 'avatar'] : ['avatar', 'agent'];
	if (UUID.test(id)) return resolveId(id, kindFirst, origin, doFetch, timeoutMs);

	throw new Error(`"${raw}" is not a file, a URL, or a three.ws avatar/agent id`);
}

async function resolveId(id, order, origin, doFetch, timeoutMs) {
	const errors = [];
	for (const kind of order) {
		try {
			if (kind === 'avatar') {
				const res = await fetchJson(`${origin}/api/avatars/${id}`, doFetch, timeoutMs);
				const a = res.avatar || res;
				const glb = a.model_url || a.url;
				if (!glb) throw new Error('avatar record has no model_url');
				return {
					bytes: await fetchBytes(glb, doFetch, timeoutMs),
					name: a.name || a.slug || id,
					source: 'avatar',
					url: glb,
					page: `${origin}/avatars/${id}`,
				};
			}
			const res = await fetchJson(`${origin}/api/agents/${id}`, doFetch, timeoutMs);
			const a = res.data || res.agent || res;
			const glb = a.avatar_model_url;
			if (!glb) throw new Error(`agent "${a.name || id}" has no 3D body attached yet`);
			return {
				bytes: await fetchBytes(glb, doFetch, timeoutMs),
				name: a.name || id,
				source: 'agent',
				url: glb,
				page: `${origin}/agents/${id}`,
			};
		} catch (err) {
			errors.push(`${kind}: ${err.message}`);
		}
	}
	throw new Error(`could not resolve ${id} on ${origin} (${errors.join('; ')})`);
}

async function fetchJson(url, doFetch, timeoutMs) {
	const res = await doFetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`${res.status} from ${url}`);
	return res.json();
}

async function fetchBytes(url, doFetch, timeoutMs) {
	const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
	return new Uint8Array(await res.arrayBuffer());
}

async function exists(p) {
	try { await access(p); return true; } catch { return false; }
}
