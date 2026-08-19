// Optional three.ws import: give an agent a body someone already built.
//
// Both endpoints are public, CORS-open, and read-only, so a static page can
// call them directly. Nothing here is required to deploy: the deployer works
// entirely on URLs the visitor supplies, and this is the shortcut for people
// who already have (or want) a three.ws avatar.
//
//   GET /api/explore?source=avatar&only3d=1   browse avatars that have a GLB
//   GET /api/explore-item?kind=avatar&id=…    one avatar: image + GLB + name

const BASE = 'https://three.ws';

async function getJson(url, { timeoutMs = 15000 } = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`three.ws returned HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

const normalize = (item) => ({
	id: item.avatarId || item.id,
	name: item.name || 'Untitled',
	description: item.description || '',
	image: item.image || '',
	modelUrl: item.glbUrl || '',
	pageUrl: `${BASE}/avatars/${item.avatarId || item.id}`,
});

/** A page of three.ws avatars that actually have a 3D body. */
export async function browseAvatars({ query = '', limit = 12, cursor = '' } = {}) {
	const params = new URLSearchParams({ source: 'avatar', only3d: '1', limit: String(limit) });
	if (query) params.set('q', query);
	if (cursor) params.set('cursor', cursor);
	const body = await getJson(`${BASE}/api/explore?${params}`);
	const items = (body.items || []).filter((i) => i.glbUrl).map(normalize);
	return { items, cursor: body.nextCursor || body.cursor || '' };
}

/**
 * Resolve one avatar from an id or any three.ws URL that carries one, so
 * pasting a link from the address bar just works.
 */
export async function importAvatar(input) {
	const raw = String(input || '').trim();
	if (!raw) throw new Error('Paste a three.ws avatar link or id.');
	const uuid = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
	if (!uuid) throw new Error('That does not contain a three.ws avatar id.');
	const body = await getJson(`${BASE}/api/explore-item?kind=avatar&id=${uuid}`);
	if (!body.item) throw new Error('No three.ws avatar with that id.');
	const item = normalize(body.item);
	if (!item.modelUrl) throw new Error('That avatar has no 3D model to attach.');
	return item;
}

/** The most recent agents to land in the registry, for the landing page. */
export async function recentDeployments(limit = 8) {
	const body = await getJson(`${BASE}/api/deployments?chain=101&network=mainnet&limit=${limit}`);
	return (body?.data?.deployments || []).map((d) => ({
		asset: d.agent_id,
		name: d.name || d.agent_id.slice(0, 6),
		image: d.image || '',
		has3d: Boolean(d.has_3d),
		x402: Boolean(d.x402_support),
		at: d.registered_at,
	}));
}
