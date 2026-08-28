/**
 * Glance card model + renderers.
 * ------------------------------
 * One agent, reduced to what fits in a home screen slot: who it is, one live
 * number, and a way back into the app. The same model feeds four consumers, so
 * it is built once here rather than four times at the edges:
 *
 *   - JSON      -> the Windows 11 widgets board (Adaptive Card data binding),
 *                  the <agent-glance> element, and any third-party surface.
 *   - SVG       -> README badges, Slack unfurls, docs, and any <img> slot.
 *   - Adaptive  -> a fully bound Adaptive Card for consumers that render one
 *                  without doing their own templating.
 *
 * No widget runtime on any of those platforms can execute WebGL, which is why
 * a glance card is a flat card and not the live 3D avatar: the avatar's own
 * thumbnail is the image, and the 3D lives one tap away on the agent page.
 *
 * Everything here reads real platform state (agent_identities, agent_actions).
 * A card for an agent that has never acted is a designed state, not an error.
 */

import { sql } from './db.js';
import { getRedis } from './redis.js';
import { thumbnailUrl } from './r2.js';
import { sha256 } from './crypto.js';

export const GLANCE_CARD_VERSION = 1;

// Long enough that a widget board polling every few minutes mostly hits cache,
// short enough that "moves today" is not visibly stale on a busy agent.
export const GLANCE_CACHE_TTL_S = 120;
const CACHE_KEY = (id) => `glance:card:v${GLANCE_CARD_VERSION}:${id}`;

const SITE = 'https://three.ws';

/**
 * Load an agent's glance card from real platform state.
 *
 * @param {string} agentId agent uuid (caller validates the shape)
 * @param {{ fresh?: boolean }} [opts]
 * @returns {Promise<object|null>} card model, or null when no such agent
 */
export async function loadGlanceCard(agentId, { fresh = false } = {}) {
	const redis = await getRedis();
	if (!fresh && redis) {
		try {
			const cached = await redis.get(CACHE_KEY(agentId));
			if (cached) return { ...cached, cache: 'hit' };
		} catch {
			/* cache unavailable: recompute, never fail the read */
		}
	}

	const [[agent], [activity], [last]] = await Promise.all([
		sql`
			SELECT i.id, i.name, i.description, i.skills, i.created_at,
			       a.thumbnail_key AS avatar_thumbnail_key,
			       a.visibility    AS avatar_visibility
			FROM agent_identities i
			LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
			WHERE i.id = ${agentId} AND i.deleted_at IS NULL
			LIMIT 1
		`,
		sql`
			SELECT
				count(*)::int                                                              AS total,
				count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int      AS day,
				count(*) FILTER (WHERE created_at > now() - interval '7 days')::int        AS week
			FROM agent_actions
			WHERE agent_id = ${agentId}
		`,
		sql`
			SELECT type, created_at
			FROM agent_actions
			WHERE agent_id = ${agentId}
			ORDER BY created_at DESC
			LIMIT 1
		`,
	]);

	if (!agent) return null;

	const card = buildGlanceCard({ agent, activity: activity || {}, last: last || null });

	if (redis) {
		try {
			await redis.set(CACHE_KEY(agentId), card, { ex: GLANCE_CACHE_TTL_S });
		} catch {
			/* a cache write failure must never fail the read */
		}
	}
	return { ...card, cache: 'miss' };
}

/**
 * Shape the card from already-loaded rows. Pure, so the renderers and the
 * tests can build a card without touching the database.
 */
export function buildGlanceCard({ agent, activity = {}, last = null, now = new Date() }) {
	const day = Number(activity.day) || 0;
	const total = Number(activity.total) || 0;
	const week = Number(activity.week) || 0;
	const skills = Array.isArray(agent.skills) ? agent.skills.length : 0;
	const lastAt = last?.created_at ? new Date(last.created_at) : null;
	const createdAt = agent.created_at ? new Date(agent.created_at) : null;

	// The avatar thumbnail only resolves for an avatar the public may see;
	// a private or missing one falls back to the generated monogram, never to
	// a broken image.
	const publicAvatar =
		agent.avatar_visibility === 'public' || agent.avatar_visibility === 'unlisted';
	const image =
		publicAvatar && agent.avatar_thumbnail_key ? thumbnailUrl(agent.avatar_thumbnail_key) : null;

	const name = String(agent.name || 'Untitled agent').slice(0, 64);
	const status = deriveStatus({ total, lastAt, now });

	return {
		version: GLANCE_CARD_VERSION,
		id: agent.id,
		name,
		description: agent.description ? String(agent.description).slice(0, 160) : null,
		url: `${SITE}/agents/${agent.id}`,
		createUrl: `${SITE}/create`,
		image,
		monogram: monogramOf(name),
		accent: accentOf(String(agent.id)),
		status,
		headline: HEADLINE[status],
		metric: { label: 'Moves today', value: day },
		stats: [
			{ label: 'This week', value: week },
			{ label: 'All time', value: total },
			{ label: 'Skills', value: skills },
		],
		lastAction: lastAt
			? {
					type: String(last.type || 'action').slice(0, 40),
					at: lastAt.toISOString(),
					relative: relativeTime(lastAt, now),
				}
			: null,
		bornAt: createdAt ? createdAt.toISOString() : null,
		ageDays: createdAt ? Math.max(0, Math.floor((now - createdAt) / 86_400_000)) : null,
		updatedAt: now.toISOString(),
		ttl: GLANCE_CACHE_TTL_S,
	};
}

const HEADLINE = {
	// The empty state has to earn its slot too: it says what to do next
	// rather than showing a zero and leaving the owner to guess.
	new: 'Not started yet. Open to give it a first job.',
	idle: 'Quiet today. Tap to put it back to work.',
	active: 'Working.',
};

function deriveStatus({ total, lastAt, now }) {
	if (!total || !lastAt) return 'new';
	return now - lastAt < 86_400_000 ? 'active' : 'idle';
}

export function monogramOf(name) {
	const words = String(name || '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!words.length) return '3';
	const first = [...words[0]][0] || '';
	const second = words.length > 1 ? [...words[1]][0] || '' : '';
	return (first + second).toUpperCase().slice(0, 2);
}

/**
 * A stable pair of hues per agent, so a card without a thumbnail still looks
 * like that specific agent and not like every other blank card.
 */
export function accentOf(seed) {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	const hue = Math.abs(h) % 360;
	return { from: `hsl(${hue} 82% 58%)`, to: `hsl(${(hue + 48) % 360} 84% 46%)`, hue };
}

export function relativeTime(then, now = new Date()) {
	const s = Math.max(0, Math.floor((now - then) / 1000));
	if (s < 60) return 'just now';
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 30) return `${d}d ago`;
	const mo = Math.floor(d / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.floor(mo / 12)}y ago`;
}

export async function glanceEtag(card) {
	const digest = await sha256(
		[card.id, card.metric.value, card.stats.map((s) => s.value).join(','), card.status].join('|'),
	);
	return `W/"glance-${GLANCE_CARD_VERSION}-${digest.slice(0, 24)}"`;
}
