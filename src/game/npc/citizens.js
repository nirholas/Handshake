// Citizens: every walker in the world is someone real.
//
// The ambient crowds (the deterministic pedestrians in ambient-life.js and the
// wanderers in ambient-crowd.js) dress themselves from the public avatar
// gallery, and every gallery avatar already carries a real identity: a name,
// a description, and (for most) the registered three.ws agent it represents,
// with an on-chain wallet and an earned reputation. The crowd used to throw
// all of that away and render anonymous scenery. This module keeps it.
//
// Select any walker (tap their body, click their nameplate) and their profile
// opens in the shared avatar inspector: the same live agent profile, trust
// score, and wallet every other surface reads. From there, "Talk 1-on-1"
// opens a real streamed conversation (npc-chat.js) where the citizen speaks
// as itself, in character, grounded in its actual public profile.
//
// Nothing here is invented client-side: names, bios, skills, wallets, and
// reputation all come from /api/avatars/public and /api/agents/:id. A walker
// wearing the bundled default avatar has no identity, and is honestly
// presented as plain scenery (no nameplate, no profile).

import { apiFetch } from '../../api.js';
import { openAvatarInspector } from '../../shared/avatar-inspector.js';
import { openChat } from './npc-chat.js';
import { log } from '../../shared/log.js';

const GALLERY_URL = '/api/avatars/public?limit=96';

// ── the shared identity pool ──────────────────────────────────────────────────
// One fetch per page life, shared by both crowd systems (each used to fetch the
// same URL independently). Records keep the identity fields alongside the model
// URL and size the crowds already needed.
let _poolPromise = null;

export function loadCitizenPool() {
	if (!_poolPromise) {
		_poolPromise = fetch(GALLERY_URL, { headers: { accept: 'application/json' } })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then(({ avatars }) => balancePool((avatars || []).map(toRecord).filter((r) => r.url)))
			.catch((e) => {
				_poolPromise = null; // allow a retry on the next crowd sync
				log.warn('[citizens] gallery pool failed:', e?.message);
				return [];
			});
	}
	return _poolPromise;
}

// Keep the crowd a crowd of individuals.
//
// The gallery is dominated by onboarding placeholders: a live sample of the
// first 96 public avatars was 62 copies of "My First Agent". Drawn straight,
// two thirds of the plaza would be identically-named clones, which reads as
// obviously fake the moment anyone looks twice. Every real identity is kept,
// and the anonymous remainder is capped at ANON_KEEP so those models still add
// body variety to the background without taking over the cast.
const ANON_KEEP = 6;

function balancePool(records) {
	const citizens = records.filter(isCitizen);
	const anonymous = records.filter((r) => !isCitizen(r));
	// Drop duplicate models among the anonymous keepers so the cap buys variety.
	const seen = new Set();
	const keptAnon = [];
	for (const r of anonymous) {
		if (keptAnon.length >= ANON_KEEP) break;
		if (seen.has(r.url)) continue;
		seen.add(r.url);
		keptAnon.push(r);
	}
	return [...citizens, ...keptAnon];
}

function toRecord(a) {
	return {
		url: a.model_url || a.base_model_url || null,
		bytes: Number(a.size_bytes) || 0,
		avatarId: a.id || null,
		slug: a.slug || null,
		name: String(a.name || '').trim() || null,
		description: String(a.description || '').trim() || null,
		altText: String(a.alt_text || '').trim() || null,
		tags: Array.isArray(a.tags) ? a.tags : [],
		viewCount: Number(a.view_count) || 0,
		thumbnailUrl: a.thumbnail_url || null,
		agentId: a.agent_id || null,
		wallet: a.agent_solana_address || a.agent_wallet_address || null,
		onchain: a.onchain || null,
	};
}

// Names that are not identities: the onboarding defaults an untouched agent
// still wears (mirrors PLACEHOLDER_NAMES in api/agents/public.js, which keeps
// the same rows off the live agent wall) and the raw export filenames that come
// off the generation lanes. An avatar wearing one of these has told us nothing
// about who it is, so introducing it by that name would be inventing a
// character the platform cannot back.
const PLACEHOLDER_NAMES = new Set([
	'my first agent', 'agent', 'avatar', 'my avatar', 'my agent',
	'untitled agent', 'new agent', 'untitled', 'character', 'model',
]);

function looksAnonymous(name) {
	const n = name.toLowerCase();
	if (PLACEHOLDER_NAMES.has(n)) return true;
	if (/^avatar[\s#_-]/.test(n)) return true;        // "Avatar #e6f105"
	if (/^model\s*[({[]?\d+/.test(n)) return true;    // "model (11)"
	if (/_(merged|meshy|biped|animations)/i.test(name)) return true; // export blob
	if (name.length > 40) return true;                // a filename, not a display name
	return false;
}

// A record is a citizen (someone you can meet) when it carries a name that
// actually identifies somebody. Nameless and placeholder-named gallery models
// stay honest anonymous scenery: they still walk the plaza, but with no
// nameplate, no profile, and no conversation.
export function isCitizen(record) {
	return !!(record && record.name && !looksAnonymous(record.name));
}

// ── profile card ──────────────────────────────────────────────────────────────
// `citizen` is a live walker wrapper: { record, name, position?, say?, hold?,
// release? }. `world` is the { mint, name, symbol } block the world already
// carries; it feeds the world facts and the chat's world-awareness.
export function openCitizenProfile(citizen, { world, ui, trigger } = {}) {
	const rec = citizen.record || {};
	const facts = [];
	if (world && (world.name || world.symbol)) {
		facts.push({
			label: 'World',
			value: world.symbol ? `$${String(world.symbol).toUpperCase()}` : world.name,
			href: world.mint ? `/play?coin=${encodeURIComponent(world.mint)}` : undefined,
		});
	}
	if (rec.avatarId) {
		facts.push({ label: 'Gallery', value: rec.name || 'view avatar', href: `/avatars/${encodeURIComponent(rec.avatarId)}` });
	}
	if (rec.viewCount > 0) {
		facts.push({ label: 'Gallery views', value: String(rec.viewCount) });
	}

	openAvatarInspector({
		kind: 'citizen',
		name: citizen.name || rec.name || 'wanderer',
		world: world?.symbol ? `$${String(world.symbol).toUpperCase()} town` : 'play',
		agentId: rec.agentId || '',
		wallet: rec.wallet || '',
		avatarUrl: rec.url || '',
		bio: rec.description || rec.altText || '',
		facts,
		actions: [
			{
				label: 'Talk 1-on-1',
				primary: true,
				onClick: () => talkToCitizen(citizen, { world, ui }),
			},
		],
	}, {
		trigger,
		onClose: () => { if (!isTalking(citizen)) citizen.release?.(); },
	});
	citizen.hold?.();
}

// ── 1-on-1 conversation ───────────────────────────────────────────────────────
// The persona is grounded entirely in the citizen's real public data. When the
// avatar pilots a registered agent, its live profile (bio + skills) is fetched
// so the character speaks as that actual agent; otherwise the gallery entry's
// own name/description carry the voice. npc-chat's system prompt supplies the
// world rules (stay in character, $three is the only promoted coin).
let _talkingTo = null;
function isTalking(citizen) { return _talkingTo === citizen; }

export async function talkToCitizen(citizen, { world, ui } = {}) {
	const rec = citizen.record || {};
	const name = citizen.name || rec.name || 'a wanderer';
	// Stop the walker before the (network) persona build so they don't stroll
	// away between the click and the panel appearing.
	citizen.hold?.();
	_talkingTo = citizen;

	let agent = null;
	if (rec.agentId) {
		try {
			const res = await apiFetch(`/api/agents/${encodeURIComponent(rec.agentId)}`, { allowAnonymous: true });
			if (res.ok) agent = (await res.json()).agent || null;
		} catch (e) {
			log.warn('[citizens] agent profile fetch failed:', e?.message);
		}
	}

	const parts = [];
	if (agent) {
		parts.push(`You are a registered three.ws agent, out for a stroll through the town plaza. You genuinely live on this platform: you have a public profile, an on-chain wallet, and a reputation you have earned.`);
		if (agent.description) parts.push(`Your public profile describes you like this: "${agent.description}". Speak as that person.`);
		const skills = (Array.isArray(agent.skills) ? agent.skills : [])
			.map((s) => (typeof s === 'string' ? s : s?.name))
			.filter(Boolean)
			.slice(0, 8);
		if (skills.length) parts.push(`Things you actually know how to do: ${skills.join(', ')}. Bring them up naturally if the conversation goes there.`);
		if (agent.author_name) parts.push(`You were created by ${agent.author_name}.`);
	} else {
		parts.push(`You are one of the townsfolk out walking the plaza. You wear a community-made avatar from the three.ws gallery and you are proud of the look.`);
		const look = rec.description || rec.altText;
		if (look) parts.push(`Your look, as the gallery describes it: "${look}". Let that shape your personality.`);
		if (rec.tags?.length) parts.push(`People tag your style as: ${rec.tags.slice(0, 6).join(', ')}.`);
	}
	parts.push(`You are friendly, curious about visitors, and you love this town.`);

	const greeting = `Hey, I'm ${name.split(/[·.]/)[0].trim()}.`;
	citizen.say?.(greeting);

	openChat(
		{
			id: `citizen-${rec.avatarId || name}`,
			name,
			say: (t) => citizen.say?.(t),
		},
		{
			ui,
			world,
			persona: parts.join('\n\n'),
			greeting,
			role: agent ? 'Agent · three.ws' : 'Citizen · three.ws',
			onClose: () => {
				if (_talkingTo === citizen) _talkingTo = null;
				citizen.release?.();
			},
		},
	);
}
