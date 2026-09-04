/**
 * Studio page controller: the canonical profile for every entity on three.ws.
 *
 * One template, two entity kinds:
 *   /avatars/:id  a 3D body (the avatar itself is the subject)
 *   /agents/:id   an agent identity, rendered wearing its bound body
 *
 * Both render the same shell: a 3D viewer, identity + wallet, metadata,
 * attachable skills + plugins, a live LLM chat, pose stage, embed snippets,
 * and a related grid. Whatever links to an entity anywhere on the platform
 * (search, /agents, /gallery, the marketplace) lands here.
 *
 * Agent mode projects the agent record onto the avatar shape (see
 * `agentStudioRecord`) so a single renderer drives both, and an agent with no
 * body yet still gets a full page instead of a broken viewer. Demo IDs
 * (avatar_demo_*) are resolved server-side via /api/avatars/[id].js so the
 * same code path serves both real and seeded avatars.
 */

import { openTalkMode } from './voice/talk-mode.js';
import { downloadAvatar } from './avatar-export.js';
import { fbxFromUrl } from './remesh-convert.js';
import { safeUrl } from './safe-url.js';
import { apiFetch } from './api.js';
import { log } from './shared/log.js';
import { emptyStateHTML, errorStateHTML } from './shared/state-kit.js';
import { mountViewSwitcher } from './view-switcher.js';
import { PoseStage, loadPoseManifest } from './avatar-pose.js';
import { walletChipHTML, wireWalletChips } from './shared/agent-wallet-chip.js';
import { mountAgentSolanaWalletCard } from './agent-solana-wallet.js';
import { mountAgentVanityGrinderCard } from './agent-vanity-grinder.js';
import { mountRoyaltySetting } from './shared/agent-fork-royalty.js';
import { hydrateAvatarWallet, walletTierBadge } from './shared/wallet-aura.js';
import { mountNameplate } from './shared/living-avatar.js';
import { mountPresence } from './shared/networth-presence.js';
import { emitRecallFromChat } from './agents/memory-client.js';
import { moodEngine } from './agents/mood-engine.js';
import { skillLabel } from './shared/skill-label.js';
import { mountCoinStatus } from './pump/coin-status-card.js';
import { renderHomeConfirmation } from './home-confirm-card.js';

const ATTACHED_KEY_PREFIX = 'avatar_attached_v1:';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

// ── Routing ───────────────────────────────────────────────────────────

// Entity id + kind: path-based in production (/avatars/:id, /agents/:id) or
// `?id=` + `?kind=` query params in dev (vite doesn't rewrite arbitrary paths
// to avatar-page.html).
const segments = location.pathname.split('/').filter(Boolean);
const params = new URLSearchParams(location.search);
const queryId = params.get('id');
const mode = segments[0] === 'agents' || params.get('kind') === 'agent' ? 'agent' : 'avatar';
const entityId =
	((segments[0] === 'avatars' || segments[0] === 'agents') && segments[1]) || queryId || '';

// The bound body's id. Identical to `entityId` on an avatar route; filled in
// from the agent's `avatar_id` once the agent record loads. Every avatar-scoped
// call (poses, forks, /api/avatars/*) keys off THIS, never off an agent id:
// the two live in separate tables with separate UUIDs. Empty string means the
// agent has no body yet, and body-scoped sections stay hidden.
let avatarId = mode === 'avatar' ? entityId : '';

// Canonical URL for this entity, used for OG/canonical tags and share links.
const entityPath = `/${mode === 'agent' ? 'agents' : 'avatars'}/${encodeURIComponent(entityId)}`;

// Embed mode: hide chrome (header, actionbar, related, footer) so the page
// looks clean inside an iframe.
const isEmbed = params.get('embed') === '1';
if (isEmbed) {
	document.body.classList.add('av-embed');
	document.querySelectorAll('.site-header, .av-actionbar, .av-related, .h-footer-horizon')
		.forEach((el) => { el.style.display = 'none'; });
}

mountBackLink();

// Stop the wallet-aura live poll and free its rAF when the page unloads.
window.addEventListener('pagehide', () => {
	coinStatus?.destroy?.(); coinStatus = null;
	netWorthAura?.destroy?.(); netWorthAura = null;
	netWorthPanel?.destroy?.(); netWorthPanel = null;
	netWorthPlate?.destroy?.(); netWorthPlate = null;
}, { once: true });

// ── State ─────────────────────────────────────────────────────────────

let avatar = null;
// The agent record in agent mode; null when the subject is a bare avatar.
let agent = null;
// Whether the current session owns the subject. In avatar mode `owner_id` is
// only present on the GET response for the owner; in agent mode the server
// answers directly with `is_owner`.
let viewerOwns = false;
// Live coin widget handle, so its refresh timer is cancelled on unload.
let coinStatus = null;
let netWorthAura = null;
let netWorthPanel = null;
let netWorthPlate = null;
let attachedSkills = new Set();
let attachedPlugins = new Set();
let chatHistory = [];
let selectedModelId = 'auto';

// Model choices surfaced in the chat dropdown. `auto` lets the server pick
// based on which keys are configured (Anthropic → OpenRouter → Groq → OpenAI).
const MODEL_OPTIONS = [
	{ id: 'auto', label: 'Auto (GPT-OSS 120B)', provider: null, model: null },
	{
		id: 'openrouter:gpt-oss',
		label: 'Nemotron 3 Super 120B (free)',
		provider: 'openrouter',
		model: 'nvidia/nemotron-3-super-120b-a12b:free',
	},
	{ id: 'anthropic:sonnet', label: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6' },
	{
		id: 'openrouter:llama-70b',
		label: 'Gemma 4 31B (free)',
		provider: 'openrouter',
		model: 'google/gemma-4-31b-it:free',
	},
	{
		id: 'openrouter:hermes',
		label: 'Gemma 4 31B (free)',
		provider: 'openrouter',
		model: 'google/gemma-4-31b-it:free',
	},
	{ id: 'groq:llama-70b', label: 'Groq Llama 3.3 70B', provider: 'groq', model: 'llama-3.3-70b-versatile' },
	{ id: 'openai:gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai', model: 'gpt-5.6-sol' },
	{ id: 'openai:gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai', model: 'gpt-5.6-terra' },
	{ id: 'openai:gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai', model: 'gpt-5.6-luna' },
	{ id: 'grok:grok-4.5', label: 'Grok 4.5 (xAI)', provider: 'grok', model: 'grok-4.5' },
	{ id: 'grok:grok-4.1-fast', label: 'Grok 4.1 Fast (xAI)', provider: 'grok', model: 'grok-4.1-fast' },
	{ id: 'watsonx:granite', label: 'IBM Granite 3 (watsonx)', provider: 'watsonx', model: 'ibm/granite-3-8b-instruct' },
	{ id: 'orchestrate:agent', label: 'watsonx Orchestrate', provider: 'orchestrate', model: 'orchestrate-agent' },
];
const MODEL_STORAGE_KEY = 'avatar_chat_model_v1';

// ── Init ──────────────────────────────────────────────────────────────

async function init() {
	({ agent, avatar } = await resolveEntity(entityId));
	avatarId = avatar.id || '';
	viewerOwns = mode === 'agent' ? !!agent.is_owner : !!avatar.owner_id;

	// An avatar always has geometry; an agent may not have been given a body
	// yet. The bodyless case is a designed state, not an error.
	const glbUrl = avatar.model_url || avatar.url || '';
	if (!glbUrl && mode === 'avatar') throw new Error('This avatar has no GLB.');

	// Persisted skill/plugin attachments (per-entity, in localStorage)
	loadAttached();

	updateOg();
	renderShell(glbUrl);
	mountSwitcher();
	bindShareButtons();
	bindTabs();
	bindChat();
	loadSkills();
	loadPlugins();
	loadRelated();

	// Body-scoped surfaces. An agent with no avatar has nothing to measure,
	// fork, or launch a coin against, so they stay off rather than rendering
	// empty shells.
	if (avatarId) {
		bindOwnerActions();
		loadForks();
		measureModel(glbUrl);
		trackView(avatarId);
	}
	// "Used by" is the inverse of agent mode's "Wearing" card: it belongs on the
	// body's page, listing the agents that wear it.
	if (mode === 'avatar') loadUsedBy();
}


/**
 * The two ways this page can fail need different words.
 *
 * A missing subject is a normal outcome of a stale or mistyped link, so it says
 * so plainly and points at the directory. Anything else (a network drop, a 500,
 * a bug in this module) is not the visitor's doing: it offers a retry instead of
 * a dead end, and it never presents the thrown message as the explanation. That
 * last part is not cosmetic. When a JavaScriptCore dead-zone error took this
 * page down, every Safari visitor was told the avatar was "not found" above the
 * raw string "Cannot access uninitialized variable.", which is both wrong and
 * unreadable. The engine's wording belongs in the console, where it is useful.
 */
function renderInitFailure(err) {
	const subject = mode === 'agent' ? 'agent' : 'avatar';
	const browse = mode === 'agent'
		? { href: '/agents', label: 'Browse agents' }
		: { href: '/marketplace', label: 'Browse the marketplace' };

	if (err?.code === 'not_found') {
		$('av-shell').innerHTML = `<div class="av-error">
			<strong>${esc(mode === 'agent' ? 'Agent not found' : 'Avatar not found')}</strong>
			<span>No ${subject} lives at this address. The link may be out of date, or the ${subject} may have been removed.</span>
			<a class="av-error-cta" href="${browse.href}">${browse.label} &rarr;</a>
		</div>`;
		return;
	}

	$('av-shell').innerHTML = `<div class="av-error">
		<strong>This ${subject} could not be loaded</strong>
		<span>Something went wrong on our end, not with your link. Try again in a moment.</span>
		<div class="av-error-actions">
			<button type="button" class="av-error-cta" id="av-error-retry">Try again</button>
			<a class="av-error-cta" href="${browse.href}">${browse.label} &rarr;</a>
		</div>
		<p class="av-error-detail">${esc(err?.message || 'Unknown error')}</p>
	</div>`;
	$('av-error-retry')?.addEventListener('click', () => { location.reload(); });
}

// The action bar's back link points at the directory this entity came from.
// Called before the entity resolves, because it depends only on the route:
// an agent page must not spend its loading second offering "Marketplace".
function mountBackLink() {
	const back = document.querySelector('.av-back');
	if (!back || mode !== 'agent') return;
	// The label is i18n-managed in avatar mode; drop the binding so the runtime
	// doesn't overwrite the agent-mode text on its pass.
	back.removeAttribute('data-i18n');
	back.href = '/agents';
	back.textContent = '\u2190 Agents';
}

// ── API ───────────────────────────────────────────────────────────────

/**
 * A subject that genuinely does not exist, as opposed to a request that failed.
 * The two need different words on screen: one is a stale link the visitor can
 * act on, the other is our problem and deserves a retry.
 */
function notFound(message) {
	const err = new Error(message);
	err.code = 'not_found';
	return err;
}

/**
 * Load whichever entity the URL names and hand back the pair the renderer
 * needs. Agents and avatars live in separate tables with separate UUIDs, so an
 * id can land on the wrong route (an old link, a shared URL). Rather than
 * dead-end on "not found", probe the other store and redirect to the canonical
 * path. The page looks the same either way, but the URL stays truthful.
 *
 * @param {string} id
 * @returns {Promise<{ agent: object|null, avatar: object }>}
 */
async function resolveEntity(id) {
	if (mode === 'agent') {
		const rec = await fetchAgentRecord(id);
		if (rec) return { agent: rec, avatar: await agentStudioRecord(rec) };
		if (await fetchAvatarRecord(id).catch(() => null)) {
			location.replace(`/avatars/${encodeURIComponent(id)}`);
			return new Promise(() => {}); // navigating away; never resolve
		}
		throw notFound('No agent with that id.');
	}

	const av = await fetchAvatarRecord(id);
	if (av) return { agent: null, avatar: av };
	if (await fetchAgentRecord(id).catch(() => null)) {
		location.replace(`/agents/${encodeURIComponent(id)}`);
		return new Promise(() => {});
	}
	throw notFound('No avatar with that id.');
}

/** GET an avatar record. Returns null on 404; throws on any other failure. */
async function fetchAvatarRecord(id) {
	const r = await fetch(`/api/avatars/${encodeURIComponent(id)}`, { credentials: 'include' });
	if (r.status === 404) return null;
	if (!r.ok) {
		const j = await r.json().catch(() => ({}));
		throw new Error(j.error_description || `Could not load this avatar (${r.status})`);
	}
	return (await r.json()).avatar || null;
}

// Fire-and-forget view tracking for the body on display. The server counts at
// most one view per IP per avatar per 30 min and only for public avatars, so
// calling on every load is safe, and without this ping the canonical page
// (where nearly all views now land) never moved the view_count that search
// and explore rank by. Demo ids are not uuids and are skipped server-side
// anyway; skip them here to save the request.
function trackView(id) {
	if (!id || String(id).startsWith('avatar_demo_')) return;
	fetch('/api/avatars/view', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ avatar_id: id }),
		keepalive: true,
	}).catch(() => {});
}

/** GET an agent record. Returns null on 404; throws on any other failure. */
async function fetchAgentRecord(id) {
	const r = await fetch(`/api/agents/${encodeURIComponent(id)}`, { credentials: 'include' });
	if (r.status === 404) return null;
	if (!r.ok) {
		const j = await r.json().catch(() => ({}));
		throw new Error(j.error_description || `Could not load this agent (${r.status})`);
	}
	return (await r.json()).agent || null;
}

/**
 * Project an agent onto the studio's avatar shape so one renderer drives both
 * entity kinds. The agent's identity (name, description, tags, wallet) wins;
 * its bound body supplies geometry, thumbnail, license, and fork lineage.
 *
 * An agent whose body is missing or private still yields a record, with no
 * model URL, which the stage renders as the "give this agent a body" state.
 */
async function agentStudioRecord(rec) {
	const body = rec.avatar_id ? await fetchAvatarRecord(rec.avatar_id).catch(() => null) : null;
	const base = body || {
		id: null,
		name: rec.name,
		description: rec.description,
		model_category: 'avatar',
		tags: [],
		visibility: 'public',
		attribution: null,
		source_meta: null,
	};
	return {
		...base,
		name: rec.name || base.name || 'Agent',
		description: rec.description || base.description || '',
		tags: rec.tags?.length ? rec.tags : base.tags || [],
		agent_id: rec.id,
		// The body keeps its own name so the "Wearing" card can show it even
		// though the agent's name wins for the page title.
		body_name: body?.name || null,
		// Wallet chip + net-worth aura read either shape; carry both spellings so
		// an agent with a wallet but no saved body still wears it.
		agent_solana_address: rec.solana_address || base.agent_solana_address || null,
		solana_address: rec.solana_address || null,
		model_url: base.model_url || rec.avatar_model_url || null,
		url: base.url || rec.avatar_model_url || null,
		thumbnail_url: base.thumbnail_url || rec.avatar_thumbnail_url || null,
	};
}

async function fetchRelated() {
	const url = new URL('/api/explore', location.origin);
	url.searchParams.set('source', 'avatar');
	url.searchParams.set('limit', '12');
	if (avatar.tags?.[0]) url.searchParams.set('q', avatar.tags[0]);
	// Related avatars are a side panel: an empty list is a designed state, but a
	// stalled request that never resolves is not, so it is bounded.
	const r = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
	if (!r?.ok) return [];
	const j = await r.json();
	return (j.items || []).filter((it) => it.kind === 'avatar' && it.avatarId !== avatarId).slice(0, 8);
}

async function fetchPlugins() {
	const r = await fetch('/api/plugins/list?limit=24');
	if (!r.ok) return [];
	const j = await r.json();
	return j?.data?.items || [];
}

// Skill catalogue. Every entry here is wired to something real:
//   - tts       → POST /api/tts/edge (Microsoft Edge TTS, free, no API key)
//   - stt       → window.SpeechRecognition (Web Speech API, browser-native)
//   - memory    → localStorage chat history per avatar
//   - animate-* → triggers a clip in the loaded GLB (only enabled if the GLB
//                 actually contains a clip with that name)
//   - wallet    → opens /pay (USDC tip flow already shipped)
//   - identity  → opens the ERC-8004 register flow
// Everything else (image gen, web search, lip sync) was speculative and has
// been removed until there's a real backend behind it.
const SKILL_CATALOG = [
	{ id: 'tts',          name: 'Voice replies (TTS)',  desc: 'Speak each chat reply out loud using Microsoft Edge Neural TTS.' },
	{ id: 'stt',          name: 'Voice input (STT)',    desc: 'Press the mic in the chat box to dictate via the browser Web Speech API.' },
	{ id: 'memory',       name: 'Conversation memory',  desc: 'Persist chat history across reloads (per-avatar, in this browser).' },
	{ id: 'animate-wave', name: 'Wave animation',       desc: 'Play a wave-style clip when the conversation starts. Requires a matching clip in the GLB.', requiresClip: ['wave', 'wavehello', 'hi'] },
	{ id: 'animate-idle', name: 'Auto-play idle',       desc: 'Loop the idle animation between replies. Requires an idle clip in the GLB.', requiresClip: ['idle', 'breathing', 'breath'] },
	{ id: 'wallet',       name: 'Accept USDC tips',     desc: 'Open the Solana Pay flow so visitors can tip this avatar.' },
	{ id: 'identity',     name: 'ERC-8004 identity',    desc: 'Register an on-chain agent identity for cross-app reputation.' },
];

async function fetchSkills() {
	return SKILL_CATALOG.map((s) => {
		if (!s.requiresClip) return { ...s, available: true };
		const has = s.requiresClip.some((c) =>
			[...availableAnimations].some((name) => name.includes(c)),
		);
		return { ...s, available: has };
	});
}

// ── Render ────────────────────────────────────────────────────────────

// The avatar's bound agent custodial wallet, rendered with the shared chip.
// owner_id is only present on the GET response when the viewer owns the avatar
// (the API strips it for everyone else), so it's a reliable owner signal — the
// owner gets the vanity entry point, everyone else gets the Tip action. Renders
// nothing when the bound agent has no wallet yet (showPending:false), which is
// fine: the avatar itself is an asset and the page already has a fork CTA.
function walletRowHTML() {
	const chip = walletChipHTML(avatar, { isOwner: viewerOwns, showPending: false });
	return chip ? `<div class="av-wallet-row" id="av-wallet-row">${chip}</div>` : '';
}

const CATEGORY_META = {
	avatar:    { label: 'Avatar · 3D Body',        tip: 'An avatar is the 3D body. Pair it with an agent to give that agent a presence.' },
	accessory: { label: 'Accessory · 3D Item',      tip: 'A wearable or attachable 3D accessory.' },
	item:      { label: 'Item · 3D Object',          tip: 'A standalone 3D object or prop.' },
	scene:     { label: 'Scene · 3D Environment',    tip: 'A 3D environment or backdrop.' },
	creature:  { label: 'Creature · 3D Character',   tip: 'A 3D creature or non-human character.' },
	vehicle:   { label: 'Vehicle · 3D Object',       tip: 'A 3D vehicle.' },
	other:     { label: '3D Model',                  tip: 'A 3D model.' },
	agent:     { label: 'Agent · AI Identity',       tip: 'An agent is the mind: a persona, skills, a wallet, and an on-chain identity. It wears an avatar as its body.' },
};

function categoryMeta() {
	if (mode === 'agent') return CATEGORY_META.agent;
	return CATEGORY_META[avatar.model_category] || CATEGORY_META.avatar;
}

// The line under the title: who made this, or what kind of thing it is.
function sourceTagText() {
	if (mode === 'agent') {
		return agent.author_name ? `Agent by ${agent.author_name}` : 'Agent on three.ws';
	}
	if (avatar.demo) return 'Curated · Public Domain';
	const kind = CATEGORY_META[avatar.model_category]?.label.split(' · ')[0].toLowerCase() || 'avatar';
	return `Community ${kind}`;
}

/**
 * Stage content for an agent that has no body yet. The studio is the page
 * every agent link lands on, so this has to be a real destination: it says
 * what is missing and hands the owner (or anyone) the two ways to fix it.
 */
function bodylessStageHTML() {
	return `<div class="av-stage-bodyless">
		<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="7.5" r="3.5"/><path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>
		</svg>
		<strong>${esc(avatar.name)} has no body yet</strong>
		<p>Agents wear an avatar. Give this one a 3D body and it renders here, in AR, in XR, and in every embed.</p>
		<div class="av-stage-bodyless-actions">
			<a class="av-cta" href="/create#avatar-options">Create a body</a>
			<a class="av-cta-sec" href="/marketplace">Pick one from the marketplace</a>
		</div>
	</div>`;
}

/**
 * Agent mode only: the body this agent wears, linking to that avatar's own
 * studio page. Keeps the agent/avatar distinction navigable in both directions
 * (the avatar page's "Used by" grid is the inverse link).
 */
function bodyCardHTML() {
	if (!avatarId) return '';
	const label = avatar.body_name || avatar.slug || 'Body';
	const thumb = avatar.thumbnail_url
		? `<img class="av-used-by-thumb" src="${esc(avatar.thumbnail_url)}" alt="" loading="lazy" />`
		: `<div class="av-used-by-thumb av-used-by-thumb--placeholder" aria-hidden="true">${esc(label.slice(0, 1).toUpperCase())}</div>`;
	return `<section class="av-used-by" aria-labelledby="av-body-heading">
		<h3 class="av-used-by-heading" id="av-body-heading">Wearing</h3>
		<div class="av-used-by-grid">
			<a class="av-used-by-card" href="/avatars/${encodeURIComponent(avatarId)}" title="Open this body's own page">
				${thumb}
				<div class="av-used-by-meta">
					<span class="av-used-by-name">${esc(avatar.body_name || avatar.slug || 'Body')}</span>
					<span class="av-used-by-badge">avatar</span>
				</div>
			</a>
		</div>
	</section>`;
}

/**
 * The at-a-glance counters under the title. Every number is a real column on
 * the record we already fetched, so this costs no extra request and can never
 * show a placeholder: a signal with nothing to say is simply omitted.
 */
function signalsHTML() {
	const items = [];
	const num = (n) => Number(n) || 0;
	if (mode === 'agent') {
		const skills = (agent.skills || []).length;
		if (skills) items.push({ v: skills, k: skills === 1 ? 'skill' : 'skills' });
		const chats = num(agent.chat_count);
		if (chats) items.push({ v: compactNumber(chats), k: chats === 1 ? 'chat' : 'chats' });
		// No wallet signal here on purpose: the chip directly below already shows
		// the address, its live value and the tip action. Two of the same fact is
		// noise, and the chip is the richer one.
		if (agent.is_registered) items.push({ v: 'On-chain', k: 'identity' });
		if (agent.created_at) items.push({ v: sinceLabel(agent.created_at), k: 'active since' });
	} else {
		const views = num(avatar.view_count);
		const forks = num(avatar.fork_count);
		if (views) items.push({ v: compactNumber(views), k: views === 1 ? 'view' : 'views' });
		if (forks) items.push({ v: compactNumber(forks), k: forks === 1 ? 'fork' : 'forks' });
		if (num(avatar.version) > 1) items.push({ v: `v${avatar.version}`, k: 'version' });
		if (avatar.created_at) items.push({ v: sinceLabel(avatar.created_at), k: 'created' });
	}
	if (!items.length) return '';
	return `<dl class="av-signals">${items
		.map((i) => `<div class="av-signal"><dt>${esc(i.k)}</dt><dd>${esc(String(i.v))}</dd></div>`)
		.join('')}</dl>`;
}

// 1240 -> "1.2k". Kept local because the only alternative in reach formats
// currency, and a view count is not money.
function compactNumber(n) {
	const v = Number(n) || 0;
	if (v < 1000) return String(v);
	if (v < 1000000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
	return `${(v / 1000000).toFixed(1).replace(/\.0$/, '')}m`;
}

// "Mar 2026" from an ISO timestamp, in the visitor's locale.
function sinceLabel(iso) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function renderShell(glbUrl) {
	const tagsHtml = (avatar.tags || [])
		.map((t) => `<a class="av-tag" href="/marketplace?tag=${encodeURIComponent(t)}">${esc(t)}</a>`)
		.join('');
	const author = avatar.author || avatar.attribution;
	const byLine = author?.handle
		? author.profileUrl || author.url
			? `<p class="av-by">by <a href="${esc(safeUrl(author.profileUrl || author.url))}" target="_blank" rel="noopener">${esc(author.displayName || author.handle)}</a></p>`
			: `<p class="av-by">by ${esc(author.displayName || author.handle)}</p>`
		: avatar.owner_username
			? `<p class="av-by">by <a href="/u/${esc(avatar.owner_username)}">@${esc(avatar.owner_username)}</a></p>`
			: '';

	$('av-shell').innerHTML = `
		<div class="av-stage-col">
			<div class="av-stage" id="av-stage">
				${glbUrl ? `
				<div class="av-stage-loading" id="av-stage-loading">Loading 3D model…</div>
				<model-viewer
					id="av-viewer"
					src="${esc(glbUrl)}"
					${avatar.usdz_url ? `ios-src="${esc(avatar.usdz_url)}"` : ''}
					alt="${esc(avatar.name)}"
					camera-controls
					auto-rotate
					rotation-per-second="14deg"
					interaction-prompt="none"
					exposure="1.05"
					shadow-intensity="0.9"
					shadow-softness="0.7"
					tone-mapping="aces"
					environment-image="neutral"
					reveal="auto"
					autoplay
					animation-crossfade-duration="300"
					ar
					ar-modes="webxr scene-viewer quick-look"
					ar-scale="auto"
				>
					<div slot="hotspot-thought" data-position="0 1.9 0.08" data-normal="0 0 1" id="av-hotspot-thought">
						<div class="av-thought-bubble" id="av-thought-bubble">
							<div class="av-thought-content" id="av-thought-content"></div>
						</div>
					</div>
				</model-viewer>
				<div class="av-anim-bar" id="av-anim-bar" role="group" aria-label="Animation playback">
					<button class="av-anim-toggle" id="av-anim-toggle" type="button" aria-label="Pause animation" aria-pressed="true">
						<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
					</button>
					<div class="av-anim-clips" id="av-anim-clips"></div>
				</div>
				` : bodylessStageHTML()}
			</div>
			<div class="av-meta-strip" id="av-meta-strip"${glbUrl ? '' : ' hidden'}>
				<div class="av-meta-item"><span class="av-meta-key">Format</span><span class="av-meta-val">glTF 2.0</span></div>
				<div class="av-meta-item"><span class="av-meta-key">License</span><span class="av-meta-val" id="av-license">${esc(avatar.attribution?.license || 'Public')}</span></div>
				<div class="av-meta-item" id="av-size-item" hidden><span class="av-meta-key">Size</span><span class="av-meta-val" id="av-size">—</span></div>
				<div class="av-meta-item" id="av-vert-item" hidden><span class="av-meta-key">Vertices</span><span class="av-meta-val" id="av-vert">—</span></div>
				<div class="av-meta-item" id="av-tri-item" hidden><span class="av-meta-key">Triangles</span><span class="av-meta-val" id="av-tri">—</span></div>
				<div class="av-meta-item" id="av-mat-item" hidden><span class="av-meta-key">Materials</span><span class="av-meta-val" id="av-mat">—</span></div>
			</div>
		</div>

		<div class="av-side">
			<div class="av-side-head">
				<div class="av-eyebrow">
					<span>${esc(categoryMeta().label)}</span>
					<a
						class="av-eyebrow-help"
						href="/docs/agents-vs-avatars"
						title="${esc(categoryMeta().tip)}"
						aria-label="What is this?"
					>?</a>
				</div>
				<h1 class="av-name">${esc(avatar.name)}</h1>
				<div class="av-source-tag">${esc(sourceTagText())}</div>
				${byLine}
				${tagsHtml ? `<div class="av-tags">${tagsHtml}</div>` : ''}
				${signalsHTML()}
				${walletRowHTML()}
				${viewerOwns && avatar.agent_id ? `<div class="av-wallet-manage" id="av-wallet-manage"></div>` : ''}
			</div>
			<div class="av-cta-talk-row">
				<button class="av-cta-talk" id="av-talk" type="button" aria-label="Talk to ${esc(avatar.name)}">
					<span class="av-cta-talk-dot" aria-hidden="true"></span>
					<span>Talk to ${esc(avatar.name)}</span>
				</button>
			</div>
			<div class="av-cta-row">
				${mode === 'agent'
					? `<a class="av-cta" href="/agents/${encodeURIComponent(entityId)}/profile" title="Capabilities, economy, activity, trust and developer tools">Full profile</a>`
					: `<button class="av-cta" id="av-use">Start an agent</button>`}
				<a class="av-cta-sec" href="/brain" title="Build a persona and test with AI models">Brain</a>
				<a class="av-cta-sec" href="/voice" title="Clone a voice for this ${mode}">Voice Lab</a>
				${avatarId ? `<a class="av-cta-sec" href="/studio?avatar=${encodeURIComponent(avatarId)}" title="Use this body in Widget Studio">Open in Studio</a>` : ''}
				${glbUrl ? `<button class="av-cta-sec" id="av-download" type="button">Download ▾</button>` : ''}
			</div>
			${avatarId ? `
			<div class="av-ar-row">
				<a class="av-ar-btn" href="/avatars/${encodeURIComponent(avatarId)}/ar" id="av-ar-link">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
					View in AR
				</a>
				<a class="av-ar-btn" href="/irl?avatar=${encodeURIComponent(avatarId)}">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
					Walk IRL
				</a>
				<a class="av-ar-btn" href="/xr?avatar=${encodeURIComponent(avatarId)}">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7l9-4 9 4v10l-9 4-9-4V7z"/><path d="M12 3v18M3 7l9 4 9-4"/></svg>
					View in XR
				</a>
				<a class="av-ar-btn" href="/pose?avatar=${encodeURIComponent(avatarId)}" title="Pose and animate this avatar in the Animation Studio">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
					Animate
				</a>
			</div>
			` : ''}
			${avatarId ? `<avatar-actions id="av-actions" avatar-id="${esc(avatarId)}"${mode === 'agent' ? ' mode="fork"' : ''} style="margin-top:14px;display:block"></avatar-actions>` : ''}
			${viewerOwns ? `
			<div class="av-owner-row" id="av-owner-row">
				<a class="av-owner-btn" href="${mode === 'agent' ? `/agents/${encodeURIComponent(entityId)}/edit` : `/avatars/${encodeURIComponent(avatarId)}/edit`}">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
					Edit
				</a>
				${avatarId && avatar.source_meta?.generator === 'avatar-studio' ? `
				<a class="av-owner-btn" href="/create/studio?edit=${encodeURIComponent(avatarId)}">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
					Edit in Studio
				</a>
				` : ''}
				${avatarId ? `
				<button class="av-owner-btn" id="av-deploy-onchain" type="button">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
					Deploy on-chain
				</button>
				<button class="av-owner-btn" id="av-launch-pumpfun" type="button">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
					Launch Pump.fun
				</button>
				<button class="av-owner-btn" id="av-fees-rewards" type="button" hidden>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M14.5 9.3a2.6 2.6 0 0 0-4.9.9c0 2.7 4.9 1.4 4.9 4.1a2.6 2.6 0 0 1-4.9.9M12 6.5v11"/></svg>
					Fees &amp; rewards
				</button>
				` : ''}
			</div>
			` : ''}
			<nav class="av-tabs" role="tablist" aria-label="${esc(avatar.name)} sections">
				${tabList()
					.map(
						(t, i) => `<button
							class="av-tab${i === 0 ? ' active' : ''}"
							data-tab="${t.id}"
							role="tab"
							id="av-tab-${t.id}"
							aria-controls="av-panel-${t.id}"
							aria-selected="${i === 0 ? 'true' : 'false'}"
							tabindex="${i === 0 ? '0' : '-1'}"
						>${esc(t.label)}</button>`,
					)
					.join('')}
			</nav>
			<div class="av-panels">
				<div class="av-panel active" data-panel="overview" id="av-panel-overview" role="tabpanel" aria-labelledby="av-tab-overview" tabindex="0">
					${avatar.description ? `<p class="av-desc">${esc(avatar.description)}</p>` : '<p class="av-desc" style="color:var(--text-3)">No description provided.</p>'}
					${mode === 'agent'
						? `<section class="av-coin" id="av-coin" hidden aria-labelledby="av-coin-heading">
								<h3 class="av-used-by-heading" id="av-coin-heading">Its coin</h3>
								<div id="av-coin-slot"></div>
							</section>`
						: ''}
					${mode === 'agent' ? bodyCardHTML() : ''}
					<section class="av-used-by" id="av-used-by" hidden aria-labelledby="av-used-by-heading">
						<h3 class="av-used-by-heading" id="av-used-by-heading">Used by</h3>
						<div class="av-used-by-grid" id="av-used-by-grid"></div>
					</section>
						<section class="av-used-by" id="av-forks" hidden aria-labelledby="av-forks-heading">
							<h3 class="av-used-by-heading" id="av-forks-heading">Forks</h3>
							<div class="av-used-by-grid" id="av-forks-grid"></div>
						</section>
					${renderAttribution()}
					${renderAttached()}
				</div>
				<div class="av-panel" data-panel="chat" id="av-panel-chat" role="tabpanel" aria-labelledby="av-tab-chat" tabindex="0">
					<div class="av-chat">
						<div class="av-chat-modelbar">
							<label class="av-chat-modellabel" for="av-chat-model">Model</label>
							<select class="av-chat-model" id="av-chat-model">
								${MODEL_OPTIONS.map(
									(o) => `<option value="${o.id}">${esc(o.label)}</option>`,
								).join('')}
							</select>
								<span class="av-chat-ibm" id="av-chat-ibm" title="This avatar&#39;s brain runs on IBM watsonx (Granite) — fully embodied via Granite function calling">
									<span class="av-chat-ibm-dot" aria-hidden="true"></span>Powered by IBM watsonx
								</span>
						</div>
						<div class="av-chat-log" id="av-chat-log">
							<div class="av-chat-empty">
								<strong>Chat with ${esc(avatar.name)}</strong>
								Ask anything — the response uses the model configured for this server.
							</div>
						</div>
						<form class="av-chat-form" id="av-chat-form">
							<textarea class="av-chat-input" id="av-chat-input" placeholder="Say something…" rows="1" autocomplete="off"></textarea>
							<button type="button" class="av-chat-mic" id="av-chat-mic" aria-label="Dictate (voice input)" title="Dictate via microphone">🎤</button>
							<button type="submit" class="av-chat-send" id="av-chat-send">Send</button>
						</form>
					</div>
				</div>
				<div class="av-panel" data-panel="pose" id="av-panel-pose" role="tabpanel" aria-labelledby="av-tab-pose" tabindex="0">
					<div class="av-pose" id="av-pose">
						<div class="av-pose-loading" id="av-pose-loading">Loading the pose stage…</div>
						<div class="av-pose-body" id="av-pose-body" hidden>
							<div class="av-pose-transport" id="av-pose-transport">
								<span class="av-pose-now" id="av-pose-now">Idle</span>
								<div class="av-pose-controls">
									<label class="av-pose-speed">
										<span>Speed</span>
										<input type="range" id="av-pose-speed" min="0.25" max="2" step="0.05" value="1" aria-label="Playback speed" />
										<span class="av-pose-speed-val" id="av-pose-speed-val">1.0×</span>
									</label>
									<button type="button" class="av-pose-reset" id="av-pose-reset">Reset</button>
								</div>
							</div>
							<input type="search" class="av-pose-search" id="av-pose-search" placeholder="Search poses…" autocomplete="off" aria-label="Search poses" />
							<div class="av-pose-grid" id="av-pose-grid"></div>
						</div>
					</div>
				</div>
				<div class="av-panel" data-panel="skills" id="av-panel-skills" role="tabpanel" aria-labelledby="av-tab-skills" tabindex="0">
					<div class="av-list" id="av-skills-list">
						<div class="av-list-loading">Loading skills…</div>
					</div>
				</div>
				<div class="av-panel" data-panel="plugins" id="av-panel-plugins" role="tabpanel" aria-labelledby="av-tab-plugins" tabindex="0">
					<div class="av-list" id="av-plugins-list">
						<div class="av-list-loading">Loading plugins…</div>
					</div>
				</div>
				<div class="av-panel" data-panel="embed" id="av-panel-embed" role="tabpanel" aria-labelledby="av-tab-embed" tabindex="0">
					${renderEmbedPanel(glbUrl)}
				</div>
			</div>
		</div>
	`;

	// The skeleton is gone the moment real markup lands; tell assistive tech too.
	$('av-shell')?.removeAttribute('aria-busy');

	wireWalletChips($('av-wallet-row'));

	const viewer = $('av-viewer');
	viewer?.addEventListener('load', () => {
		$('av-stage-loading')?.remove();
		positionThoughtHotspot(viewer);
		setupAnimationControls(viewer);
	});
	viewer?.addEventListener('error', () => {
		const ld = $('av-stage-loading');
		if (ld) ld.textContent = 'Failed to load 3D model.';
	});

	// The wallet aura is an independent sibling layer over the stage — mount it
	// right away (the stage already has its CSS size) so the agent wears its
	// wallet even before the GLB finishes loading, and even if the model fails.
	mountNetWorthAura();

	$('av-use')?.addEventListener('click', startAgentWithAvatar);
	$('av-talk')?.addEventListener('click', () => enterTalkMode());
	$('av-download')?.addEventListener('click', openDownloadMenu);

	// Per-avatar ownership + wallet surface: owner gets the agent-wallet panel
	// (create / manage), everyone else gets "Save to my avatars" (fork). Seed it
	// with the already-loaded avatar to skip a re-fetch — falls back to the
	// avatar-id attribute (set in the template) if the element hasn't upgraded yet.
	const actions = $('av-actions');
	if (actions && customElements.get('avatar-actions')) actions.avatar = avatar;

	mountWalletManager();
	mountAgentCoin();
}

/**
 * The live market state of the coin this agent launched, using the same shared
 * widget the full profile mounts, so one mint reads identically on both. Real
 * data only: symbol, price, market cap and graduation come off the pump.fun
 * indexer, falling back to the bonding curve read straight from the cluster
 * (the only source on devnet, where the widget prices in SOL rather than
 * pretending a rehearsal coin is worth dollars).
 *
 * The mint is never hardcoded: it comes from this platform's own launch records
 * at runtime, so the section only exists for an agent that really launched.
 */
async function mountAgentCoin() {
	const slot = $('av-coin-slot');
	if (!slot || mode !== 'agent') return;
	const token = await resolveAgentCoin();
	if (!token?.mint) return; // no coin, section stays hidden
	$('av-coin').hidden = false;
	coinStatus = mountCoinStatus(slot, token.mint, {
		variant: 'chip',
		network: token.cluster === 'devnet' ? 'devnet' : 'mainnet',
		meta: {
			symbol: token.symbol || '',
			name: token.name || '',
			image: token.image || '',
			createdAt: token.launched_at ? Date.parse(token.launched_at) || null : null,
		},
	});
}

/**
 * Which coin, if any, this agent launched. `meta.token` is written by only one
 * of the two launch paths, so an agent that launched from its own custodial
 * wallet has an empty field and a real row in `pump_agent_mints`. Ask the
 * launch records rather than trusting the cached field alone.
 */
async function resolveAgentCoin() {
	if (agent?.token?.mint) return agent.token;
	try {
		const r = await fetch(`/api/pump/by-agent?agent_id=${encodeURIComponent(entityId)}`, {
			credentials: 'include',
		});
		if (!r.ok) return null;
		const rec = (await r.json())?.data;
		if (!rec?.mint) return null;
		return {
			mint: rec.mint,
			cluster: rec.network === 'devnet' ? 'devnet' : 'mainnet',
			symbol: rec.symbol || '',
			name: rec.name || '',
			image: rec.image || '',
			launched_at: rec.created_at || null,
		};
	} catch {
		return null; // optional section, stays hidden on network failure
	}
}

/**
 * Owner-only inline wallet management for the avatar's bound agent: generate a
 * random custodial Solana wallet, use it (balance, copy, explorer, devnet
 * airdrop, on-chain activity, replace), and grind a vanity address — all from
 * this page instead of routing the owner away to /agent-edit.
 *
 * Reuses the same server-verified cards the agent home panel mounts, so the
 * wallet behaves identically everywhere. Both cards self-gate on the server
 * (a 403 removes them), and we only mount when the viewer owns the avatar and
 * it has a bound agent, so visitor views never fire owner-only requests.
 */
function mountWalletManager() {
	const host = $('av-wallet-manage');
	if (!host || !viewerOwns || !avatar.agent_id) return;

	const identity = {
		id: avatar.agent_id,
		name: avatar.name || 'agent',
		solana_address: avatar.agent_solana_address || null,
		meta: {
			solana_address: avatar.agent_solana_address || null,
			solana_vanity_prefix: avatar.agent_solana_vanity_prefix || null,
			solana_vanity_suffix: avatar.agent_solana_vanity_suffix || null,
		},
	};

	// Keep the read-only chip above in sync after any provision/replace/grind so
	// the page reflects the new address (and vanity styling) without a reload.
	// The wallet card mutates `identity` itself; the vanity card hands the fresh
	// provision payload straight to its callback, so fold that in when present.
	const syncChip = (data) => {
		if (data) {
			identity.solana_address = data.address || null;
			identity.meta = {
				...(identity.meta || {}),
				solana_address: data.address || null,
				solana_vanity_prefix: data.vanity_prefix || null,
				solana_vanity_suffix: data.vanity_suffix || null,
			};
		}
		avatar.agent_solana_address = identity.solana_address || null;
		avatar.agent_solana_vanity_prefix = identity.meta?.solana_vanity_prefix || null;
		avatar.agent_solana_vanity_suffix = identity.meta?.solana_vanity_suffix || null;
		const row = $('av-wallet-row');
		const chip = walletChipHTML(avatar, { isOwner: true, showPending: false });
		if (chip) {
			if (row) {
				row.innerHTML = chip;
			} else {
				// First wallet on an avatar that had none — inject the chip row
				// directly above the management panel.
				const newRow = document.createElement('div');
				newRow.className = 'av-wallet-row';
				newRow.id = 'av-wallet-row';
				newRow.innerHTML = chip;
				host.parentNode?.insertBefore(newRow, host);
			}
			wireWalletChips($('av-wallet-row'));
		}
	};

	let walletCard = null;
	try {
		walletCard = mountAgentSolanaWalletCard({
			panel: host,
			identity,
			onProvisioned: (data) => syncChip(data),
		});
	} catch (err) {
		log.error('[avatar] wallet card', err);
	}
	try {
		mountAgentVanityGrinderCard({
			panel: host,
			identity,
			onProvisioned: (data) => {
				syncChip(data);
				walletCard?.refresh?.();
			},
		});
	} catch (err) {
		log.error('[avatar] vanity card', err);
	}

	// Fork Royalty Streams: let the owner earn provenance income when others fork
	// this avatar. Applies to future forks only; the forker always keeps the
	// majority. Mounts under the wallet manager on the owner's own avatar.
	try {
		mountRoyaltySetting({ host, agentId: avatar.agent_id });
	} catch (err) {
		log.error('[avatar] royalty setting', err);
	}
}

/**
 * The Net-Worth-Reactive Avatar: weld the agent's real wallet to its 3D body.
 * Once the model has loaded (so the stage has size), mount the aura on the
 * viewer stage and start the live inflow reaction. The agent's funded-ness is
 * then visible — a tiered glow + asset-mix palette, all from real chain data —
 * and a real confirmed deposit/tip plays a one-shot flourish on the model. A
 * net-worth tier badge is placed in the meta strip so the number is legible too.
 *
 * Only mounts when the avatar is bound to an agent with a wallet to read; an
 * unprovisioned avatar simply shows the clean dormant baseline.
 */
function mountNetWorthAura() {
	const stage = $('av-stage');
	const agentId = avatar?.agent_id;
	if (!stage || !agentId || netWorthAura) return;

	// The nameplate — the avatar's license plate: name + vanity-highlighted address
	// + a tier glyph anchored to the viewer. Identity renders immediately; the tier
	// hydrates from the same cached wallet read the aura uses (no extra request).
	if (!netWorthPlate) {
		netWorthPlate = mountNameplate(stage, avatar, {
			network: 'mainnet', isOwner: viewerOwns, live: true, position: 'bottom',
		});
	}

	hydrateAvatarWallet(stage, avatar, { lod: 'full', live: true, wealth: true, network: 'mainnet', fetchPrefs: false })
		.then((controller) => {
			if (!controller) return;
			netWorthAura = controller;
			// The presence panel: the legible, ownable face of the aura — the tier, the
			// reputation regalia (each a real number), and, for the owner, the
			// reactivity dial that drives the glow above. Lives at the top of Overview.
			if (!netWorthPanel) {
				const overview = $('av-panel-overview');
				if (overview) {
					mountPresence({ agentId, container: overview, aura: controller, position: 'prepend' })
						.then((panel) => { if (panel) netWorthPanel = panel; else netWorthPanel = null; })
						.catch(() => { /* read failed — aura still shows the look */ });
				}
			}
			// Surface the honest net-worth tier + USD in the meta strip so the
			// presence has a readable label, not just a glow.
			const strip = $('av-meta-strip');
			const state = controller.state;
			if (strip && state && !document.getElementById('av-networth')) {
				const item = document.createElement('div');
				item.className = 'av-meta-item';
				item.id = 'av-networth';
				const key = document.createElement('span');
				key.className = 'av-meta-key';
				key.textContent = 'Net worth';
				const val = document.createElement('span');
				val.className = 'av-meta-val';
				val.appendChild(walletTierBadge(state));
				item.append(key, val);
				strip.appendChild(item);
			}
		})
		.catch(() => { /* dormant baseline already shown */ });
}

/**
 * Anchored download menu. GLB / USDZ links straight to the R2-hosted artifacts
 * when present (no client work) and falls back to a fetched-and-converted blob
 * when only the canonical GLB is available. VRM is always built client-side.
 */
function openDownloadMenu(ev) {
	closeDownloadMenu();
	const trigger = ev.currentTarget;
	const glbUrl = avatar.model_url || avatar.url;
	const usdzUrl = avatar.usdz_url || null;
	const fileBase = sanitizeFilename(avatar.name || 'avatar');

	const menu = document.createElement('div');
	menu.className = 'av-download-menu';
	menu.id = 'av-download-menu';
	menu.setAttribute('role', 'menu');
	menu.innerHTML = `
		<button type="button" role="menuitem" data-format="glb">
			<strong>GLB</strong>
			<span>Universal — game engines, Blender, browsers</span>
		</button>
		<button type="button" role="menuitem" data-format="fbx">
			<strong>FBX</strong>
			<span>Unity &amp; Unreal — keeps the skeleton</span>
		</button>
		<button type="button" role="menuitem" data-format="vrm">
			<strong>VRM</strong>
			<span>VRChat, Resonite, Hubs, VTube Studio</span>
		</button>
		<button type="button" role="menuitem" data-format="usdz">
			<strong>USDZ</strong>
			<span>iOS AR — Safari Quick Look</span>
		</button>
		<div class="av-download-status" data-status></div>
	`;
	document.body.appendChild(menu);
	positionMenu(menu, trigger);

	const statusEl = menu.querySelector('[data-status]');
	menu.querySelectorAll('button[data-format]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const format = btn.dataset.format;
			if (menu.dataset.busy === '1') return;
			menu.dataset.busy = '1';
			statusEl.textContent = `Preparing ${format.toUpperCase()}…`;
			statusEl.dataset.tone = 'busy';

			try {
				// Fast paths: GLB and USDZ already exist on R2 for saved avatars.
				if (format === 'glb' && glbUrl) {
					triggerLink(glbUrl, `${fileBase}.glb`);
					statusEl.textContent = 'Download started.';
					statusEl.dataset.tone = 'ok';
				} else if (format === 'usdz' && usdzUrl) {
					triggerLink(usdzUrl, `${fileBase}.usdz`);
					statusEl.textContent = 'Download started.';
					statusEl.dataset.tone = 'ok';
				} else if (format === 'fbx') {
					// FBX is built server-side from the GLB so the skeleton survives.
					if (!glbUrl) throw new Error('No source GLB to convert.');
					const fbxUrl = await fbxFromUrl(glbUrl, {
						onStatus: (msg) => { statusEl.textContent = msg; },
					});
					triggerLink(fbxUrl, `${fileBase}.fbx`);
					statusEl.textContent = 'Download started.';
					statusEl.dataset.tone = 'ok';
				} else {
					// Build client-side from the GLB.
					if (!glbUrl) throw new Error('No source GLB to convert.');
					const result = await downloadAvatar(glbUrl, {
						format,
						filename: fileBase,
						meta: { name: avatar.name || 'three.ws avatar' },
					});
					statusEl.textContent = `Saved · ${prettyBytes(result.size)}`;
					statusEl.dataset.tone = 'ok';
				}
				setTimeout(closeDownloadMenu, 1500);
			} catch (err) {
				log.error('[avatar] download failed', err);
				statusEl.textContent =
					format === 'vrm' && /humanoid/i.test(err?.message || '')
						? "VRM needs a humanoid skeleton — try GLB."
						: `Couldn't export: ${err?.message || 'unknown error'}`;
				statusEl.dataset.tone = 'err';
			} finally {
				menu.dataset.busy = '0';
			}
		});
	});

	setTimeout(() => {
		document.addEventListener('click', onOutsideDownloadClick, { once: true });
	}, 0);
}

function onOutsideDownloadClick(ev) {
	const menu = document.getElementById('av-download-menu');
	if (!menu) return;
	if (menu.contains(ev.target) || ev.target.id === 'av-download') return;
	closeDownloadMenu();
}

function closeDownloadMenu() {
	document.getElementById('av-download-menu')?.remove();
	document.removeEventListener('click', onOutsideDownloadClick);
}

function positionMenu(menu, trigger) {
	const r = trigger.getBoundingClientRect();
	const top = r.bottom + 6 + window.scrollY;
	const left = Math.max(8, r.right - 280 + window.scrollX);
	menu.style.top = `${top}px`;
	menu.style.left = `${left}px`;
}

function triggerLink(href, filename) {
	const a = document.createElement('a');
	a.href = href;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
}

function sanitizeFilename(name) {
	return String(name || 'avatar')
		.replace(/[^a-z0-9._-]+/gi, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 80) || 'avatar';
}

function prettyBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function renderAttribution() {
	const a = avatar.attribution;
	if (!a) return '';
	const url = a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.displayName || a.handle)}</a>` : esc(a.displayName || a.handle);
	const license = a.license ? ` · ${esc(a.license)}` : '';
	return `<div class="av-attribution">
		<strong>Attribution</strong>
		<div>${url}${license}</div>
	</div>`;
}

function renderAttached() {
	if (attachedSkills.size === 0 && attachedPlugins.size === 0) return '';
	const skills = [...attachedSkills].map((s) => {
		const sk = SKILL_CATALOG.find((x) => x.id === s);
		return `<span class="av-attached-pill">${esc(sk?.name || s)}</span>`;
	}).join('');
	const plugins = [...attachedPlugins].map((p) => `<span class="av-attached-pill">${esc(p)}</span>`).join('');
	return `<div class="av-attached">
		<strong>Attached to this avatar</strong>
		<div class="av-attached-list">${skills}${plugins}</div>
	</div>`;
}

function renderEmbedPanel(glbUrl) {
	const fullUrl = location.origin + location.pathname;
	// The studio page itself is iframe-friendly; embedders can drop the page URL
	// with `?embed=1` and we hide the chrome (handled below).
	const iframeSrc = `${fullUrl}?embed=1`;
	// In agent mode the component gets `agent-id` too, so the embed talks to the
	// agent's brain rather than just rendering its body.
	const webComponentSnippet = `<script type="module" src="https://three.ws/dist-lib/agent-3d.js"><\/script>
<agent-3d
  src="${glbUrl}"${mode === 'agent' ? `\n  agent-id="${entityId}"` : ''}
  style="width:480px;height:480px"
></agent-3d>`;
	const iframeSnippet = `<iframe
  src="${iframeSrc}"
  width="480"
  height="480"
  style="border:0;border-radius:14px"
  allow="autoplay; xr-spatial-tracking"
></iframe>`;
	const linkSnippet = fullUrl;
	// The terminal viewer resolves an agent to its bound body through
	// /api/agents/:id, so the agent id is the right handle in agent mode.
	const ttySnippet = `npx @three-ws/tty-avatar ${mode === 'agent' ? `agent:${entityId}` : avatarId}`;
	// The Widget Studio absorbed the standalone /embed editor and reads the same
	// parameter names. An agent lands on the Agent Chat widget type (mode=chat
	// takes the agent id); an avatar lands on the walking-avatar embed. The old
	// editor silently ignored the `agent` key it used to be handed here, so the
	// agent case landed on an avatar embed instead of a chat one.
	const wizardUrl = `/studio?${new URLSearchParams(
		mode === 'agent' ? { mode: 'chat', avatar: entityId } : { avatar: avatarId },
	)}`;
	return `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">
			<p class="av-embed-intro" style="margin:0;font-size:13px;color:var(--ink-dim)">Drop this ${mode} on any website. Use the wizard for a live preview and platform instructions.</p>
			<a href="${esc(wizardUrl)}" class="av-embed-wizard" target="_blank" rel="noopener">Configure in wizard ↗</a>
		</div>
		<div class="av-embed-section">
			<div class="av-embed-label">
				<span>Web component</span>
				<button class="av-embed-copy" data-copy="wc">Copy</button>
			</div>
			<pre class="av-embed-code" id="embed-wc">${esc(webComponentSnippet)}</pre>
		</div>
		<div class="av-embed-section">
			<div class="av-embed-label">
				<span>Iframe</span>
				<button class="av-embed-copy" data-copy="iframe">Copy</button>
			</div>
			<pre class="av-embed-code" id="embed-iframe">${esc(iframeSnippet)}</pre>
		</div>
		<div class="av-embed-section">
			<div class="av-embed-label">
				<span>Direct link</span>
				<button class="av-embed-copy" data-copy="link">Copy</button>
			</div>
			<pre class="av-embed-code" id="embed-link">${esc(linkSnippet)}</pre>
		</div>
		<div class="av-embed-section">
			<div class="av-embed-label">
				<span>Terminal</span>
				<button class="av-embed-copy" data-copy="tty">Copy</button>
			</div>
			<pre class="av-embed-code" id="embed-tty">${esc(ttySnippet)}</pre>
			<p class="av-embed-intro" style="margin:8px 0 0;font-size:12px;color:var(--ink-dim)">Runs this ${mode} live in any terminal, no browser or GPU. Add <code>install-hooks --write</code> and it becomes your Claude Code agent's face. <a href="/docs/tty-avatar" target="_blank" rel="noopener">How it works ↗</a></p>
		</div>
	`;
}

// ── View switcher ─────────────────────────────────────────────────────

// Surface the page-level views (3D · Chat · AR · Embed, plus Profile for an
// agent) in the action bar. The active view tracks ?view= so Chat/Embed
// deep-links light up the right segment; the bare page is the 3D view.
function mountSwitcher() {
	if (isEmbed) return;
	const view = params.get('view');
	const active = view === 'chat' || view === 'embed' ? view : '3d';
	mountViewSwitcher($('view-switch-slot'), {
		kind: mode,
		id: entityId,
		active,
		hasBody: !!avatarId,
	});
}

// ── Tabs ──────────────────────────────────────────────────────────────

/**
 * The tabs this entity actually has. Pose needs a rig to drive, so an agent
 * with no body never gets a tab that would only apologise for itself.
 */
function tabList() {
	return [
		{ id: 'overview', label: 'Overview' },
		{ id: 'chat', label: 'Chat' },
		...(avatarId ? [{ id: 'pose', label: 'Pose' }] : []),
		{ id: 'skills', label: mode === 'agent' ? 'Capabilities' : 'Skills' },
		{ id: 'plugins', label: 'Plugins' },
		{ id: 'embed', label: 'Embed' },
	];
}

/**
 * Show one tab. `focus` moves keyboard focus onto the newly selected tab (true
 * for arrow-key navigation, false for a click or a deep link, where stealing
 * focus would be wrong). `push` writes the choice into the URL so a tab is a
 * shareable address and the browser's back button walks the tabs.
 */
function activateTab(tab, { focus = false, push = true } = {}) {
	const btn = document.querySelector(`.av-tab[data-tab="${tab}"]`);
	if (!btn) return false;
	document.querySelectorAll('.av-tab').forEach((b) => {
		const on = b === btn;
		b.classList.toggle('active', on);
		b.setAttribute('aria-selected', on ? 'true' : 'false');
		// Roving tabindex: only the selected tab is in the page's tab order, so
		// Tab moves past the strip and the arrow keys move within it (WAI-ARIA
		// tabs pattern).
		b.tabIndex = on ? 0 : -1;
	});
	if (focus) btn.focus();
	document.querySelectorAll('.av-panel').forEach((p) => {
		p.classList.toggle('active', p.dataset.panel === tab);
	});
	if (push) syncTabUrl(tab);
	// The Pose tab swaps the model-viewer stage for a live Three.js scene; every
	// other tab restores it. Driven from here so deep-links and the view switcher
	// enter/leave pose mode correctly too.
	if (tab === 'pose') enterPoseMode();
	else leavePoseMode();
	return true;
}

// One URL per tab, on the canonical path. Overview is the bare page, so it
// drops the parameter instead of shipping `?view=overview` around.
function syncTabUrl(tab) {
	const url = new URL(location.href);
	if (tab === 'overview') url.searchParams.delete('view');
	else url.searchParams.set('view', tab);
	if (url.href !== location.href) history.replaceState(history.state, '', url);
}

// ── Pose stage ────────────────────────────────────────────────────────
//
// The Pose tab replaces the model-viewer stage with a live Three.js scene
// (PoseStage) so the avatar can be driven through the shared clip library,
// which model-viewer can't play (most avatar GLBs ship no embedded clips).
// The stage mounts lazily on first open and only renders while visible, so
// the page pays zero GPU cost until someone actually opens the tab.

let poseStage = null;
let poseMode = false;
let poseDefs = null;
let poseControlsBound = false;

async function enterPoseMode() {
	if (poseMode) return;
	poseMode = true;
	const stageEl = $('av-stage');
	if (!stageEl) return;
	stageEl.dataset.pose = '1';

	if (!poseStage) {
		const glbUrl = avatar.model_url || avatar.url;
		if (!glbUrl) {
			showPoseMessage('No 3D model is available for this avatar.');
			return;
		}
		poseStage = new PoseStage(stageEl, { glbUrl });
		poseStage.onChange = (name) => reflectPoseState(name);
		try {
			const { supported } = await poseStage.mount();
			if (!poseMode) {
				// User switched away while the model was still loading.
				poseStage.stop();
				return;
			}
			if (!supported) {
				showPoseMessage(
					'This avatar’s rig can’t be driven by the motion library — pose playback needs a rigged humanoid skeleton.',
				);
			} else {
				revealPosePanel();
			}
		} catch (err) {
			log.warn('[pose] stage failed to mount', err?.message);
			showPoseMessage('The pose stage could not be loaded. Reload the page to try again.');
			return;
		}
	}
	poseStage.start();
}

function leavePoseMode() {
	if (!poseMode) return;
	poseMode = false;
	poseStage?.stop();
	const stageEl = $('av-stage');
	if (stageEl) delete stageEl.dataset.pose;
}

function showPoseMessage(msg) {
	const loadingEl = $('av-pose-loading');
	if (loadingEl) {
		loadingEl.hidden = false;
		loadingEl.textContent = msg;
	}
	$('av-pose-body')?.setAttribute('hidden', '');
}

function revealPosePanel() {
	const loadingEl = $('av-pose-loading');
	const bodyEl = $('av-pose-body');
	if (loadingEl) loadingEl.hidden = true;
	if (bodyEl) bodyEl.hidden = false;
	renderPoseGrid();
	wirePoseControls();
}

async function renderPoseGrid() {
	const grid = $('av-pose-grid');
	if (!grid) return;
	poseDefs = await loadPoseManifest();
	if (!poseDefs.length) {
		grid.innerHTML = emptyStateHTML({
			compact: true,
			icon: '🎭',
			title: 'No poses available',
			body: 'The motion library could not be loaded. Check your connection and reopen this tab.',
		});
		return;
	}
	grid.innerHTML = poseDefs
		.map(
			(d) => `
			<button type="button" class="av-pose-clip" data-clip="${esc(d.name)}" title="${esc(d.label)}">
				<span class="av-pose-clip-icon" aria-hidden="true">${esc(d.icon || '🎬')}</span>
				<span class="av-pose-clip-label">${esc(d.label)}</span>
			</button>`,
		)
		.join('');
	grid.querySelectorAll('[data-clip]').forEach((btn) => {
		btn.addEventListener('click', () => selectPose(btn.dataset.clip));
	});
	reflectPoseState('idle');
}

async function selectPose(name) {
	if (!poseStage) return;
	try {
		await poseStage.play(name);
	} catch (err) {
		log.warn('[pose] clip failed to play', err?.message);
	}
}

function reflectPoseState(name) {
	$('av-pose-grid')
		?.querySelectorAll('.av-pose-clip')
		.forEach((b) => b.classList.toggle('is-active', b.dataset.clip === name));
	const now = $('av-pose-now');
	if (now) {
		const def = poseDefs?.find((d) => d.name === name);
		now.textContent = def ? def.label : name || 'Idle';
	}
}

function wirePoseControls() {
	if (poseControlsBound) return;
	poseControlsBound = true;

	const speed = $('av-pose-speed');
	const speedVal = $('av-pose-speed-val');
	const fmtSpeed = (v) => `${v % 1 === 0 ? v.toFixed(1) : String(v)}×`;
	speed?.addEventListener('input', () => {
		const v = Number(speed.value);
		poseStage?.setSpeed(v);
		if (speedVal) speedVal.textContent = fmtSpeed(v);
	});

	$('av-pose-reset')?.addEventListener('click', async () => {
		if (speed) speed.value = '1';
		if (speedVal) speedVal.textContent = '1.0×';
		poseStage?.setSpeed(1);
		try {
			await poseStage?.reset();
		} catch (err) {
			log.warn('[pose] reset failed', err?.message);
		}
	});

	const search = $('av-pose-search');
	search?.addEventListener('input', () => {
		const q = search.value.trim().toLowerCase();
		$('av-pose-grid')
			?.querySelectorAll('.av-pose-clip')
			.forEach((b) => {
				const def = poseDefs?.find((d) => d.name === b.dataset.clip);
				const hay = `${def?.label || ''} ${def?.name || ''}`.toLowerCase();
				b.style.display = !q || hay.includes(q) ? '' : 'none';
			});
	});
}

function bindTabs() {
	const tabs = [...document.querySelectorAll('.av-tab')];
	tabs.forEach((btn) => {
		btn.addEventListener('click', () => activateTab(btn.dataset.tab));
	});

	// WAI-ARIA tabs keyboard contract: arrows move between tabs (wrapping),
	// Home/End jump to the ends. Without this the strip is a row of buttons a
	// keyboard user has to Tab through one at a time.
	document.querySelector('.av-tabs')?.addEventListener('keydown', (e) => {
		const i = tabs.indexOf(document.activeElement);
		if (i < 0) return;
		const last = tabs.length - 1;
		const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: last }[e.key];
		if (next === undefined) return;
		e.preventDefault();
		activateTab(tabs[(next + tabs.length) % tabs.length].dataset.tab, { focus: true });
	});

	// Deep-link a tab from the view switcher or a shared URL:
	// /avatars/:id?view=chat opens the Chat panel on load. `push:false` because
	// the URL already says this; rewriting it would clobber the entry.
	const view = params.get('view');
	if (view && view !== 'overview') activateTab(view, { push: false });

	// Embed copy buttons
	document.body.addEventListener('click', async (e) => {
		const btn = e.target.closest('.av-embed-copy');
		if (!btn) return;
		const which = btn.dataset.copy;
		const sourceMap = { wc: 'embed-wc', iframe: 'embed-iframe', link: 'embed-link', tty: 'embed-tty' };
		const src = $(sourceMap[which]);
		if (!src) return;
		try {
			await navigator.clipboard.writeText(src.textContent);
			btn.textContent = 'Copied ✓';
			btn.classList.add('copied');
			setTimeout(() => {
				btn.textContent = 'Copy';
				btn.classList.remove('copied');
			}, 1800);
		} catch (err) {
			log.error('[avatar] clipboard', err);
		}
	});
}

// ── Share buttons ─────────────────────────────────────────────────────

function bindShareButtons() {
	const linkBtn = $('share-link');
	const twBtn = $('share-twitter');
	if (linkBtn) {
		linkBtn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(location.href);
				linkBtn.textContent = 'Copied ✓';
				linkBtn.classList.add('copied');
				setTimeout(() => {
					linkBtn.textContent = 'Copy link';
					linkBtn.classList.remove('copied');
				}, 1800);
			} catch (err) {
				log.error('[avatar] copy link', err);
			}
		});
	}
	if (twBtn && avatar) {
		const text =
			mode === 'agent'
				? `Meet "${avatar.name}", a 3D AI agent on three.ws`
				: `Check out "${avatar.name}", a 3D avatar on three.ws`;
		const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.href)}`;
		twBtn.href = url;
	}
}

// ── Owner actions (Edit / Deploy on-chain / Launch Pump.fun) ─────────

function bindOwnerActions() {
	$('av-deploy-onchain')?.addEventListener('click', openDeployOnchain);
	$('av-launch-pumpfun')?.addEventListener('click', openLaunchPumpFun);
	$('av-fees-rewards')?.addEventListener('click', openFeesPanel);
	checkAvatarCoin();
}

// Resolve whether this avatar already has a launched coin. If so, reveal the
// "Fees & rewards" control so the owner gets full claim/split/delegation
// control. Also honors ?launch=1 (deep-link from the avatar-studio save flow)
// by opening the launch modal immediately.
let avatarCoin = null;
async function checkAvatarCoin() {
	if (new URLSearchParams(location.search).get('launch') === '1') openLaunchPumpFun();
	const id = avatarId;
	if (!id) return;
	try {
		const r = await fetch(`/api/pump/by-agent?avatar_id=${encodeURIComponent(id)}`, { credentials: 'include' });
		if (!r.ok) return;
		const { data } = await r.json();
		if (!data?.mint) return;
		avatarCoin = data;
		const feesBtn = $('av-fees-rewards');
		if (feesBtn) feesBtn.hidden = false;
	} catch { /* best-effort — no coin means no button, which is correct */ }
}

async function openDeployOnchain() {
	const btn = $('av-deploy-onchain');
	if (!btn || btn.disabled) return;
	btn.disabled = true;
	const origText = btn.textContent.trim();
	btn.lastChild.textContent = ' Opening…';
	try {
		const initial = {
			name: avatar.name || '',
			description: avatar.description || '',
			glbUrl: avatar.model_url || avatar.url || '',
			imageUrl: avatar.thumbnail_url || '',
		};
		const { RegisterUI } = await import('./erc8004/register-ui.js');
		const wrap = document.createElement('div');
		wrap.className = 'agent-register-overlay';
		document.body.appendChild(wrap);
		const ui = new RegisterUI(wrap, () => {}, {
			initial,
			// Keep the success screen (tx link, agent page CTA) up until the user
			// closes it; only then tear down the overlay.
			onClose: () => wrap.remove(),
		});
		wrap.addEventListener('click', (e) => {
			if (e.target === wrap) ui.destroy();
		});
	} catch (err) {
		log.error('[avatar] deploy on-chain failed', err);
	} finally {
		btn.disabled = false;
		if (btn.lastChild) btn.lastChild.textContent = ' Deploy on-chain';
	}
}

// Shared modal chrome for the pump.fun launch + fees panels. Returns the inner
// mount node plus a close() handle; closes on ×, backdrop click, and Escape.
function openPumpModal(title) {
	const backdrop = document.createElement('div');
	backdrop.className = 'av-pump-backdrop';
	const modal = document.createElement('div');
	modal.className = 'av-pump-modal';
	const header = document.createElement('div');
	header.className = 'av-pump-header';
	header.innerHTML = `
		<span class="av-pump-title">${esc(title)}</span>
		<button class="av-pump-close" type="button" aria-label="Close">×</button>
	`;
	const inner = document.createElement('div');
	inner.className = 'av-pump-inner';
	modal.appendChild(header);
	modal.appendChild(inner);
	backdrop.appendChild(modal);
	document.body.appendChild(backdrop);
	const onEsc = (e) => { if (e.key === 'Escape') close(); };
	const close = () => { backdrop.remove(); document.removeEventListener('keydown', onEsc); };
	header.querySelector('.av-pump-close').addEventListener('click', close);
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
	document.addEventListener('keydown', onEsc);
	return { inner, close };
}

async function fetchCurrentUser() {
	try {
		const r = await fetch('/api/auth/me', { credentials: 'include' });
		if (r.ok) return (await r.json()).user || null;
	} catch { /* best-effort */ }
	return null;
}

async function openLaunchPumpFun() {
	const btn = $('av-launch-pumpfun');
	if (btn?.disabled) return;
	if (btn) btn.disabled = true;
	try {
		const user = await fetchCurrentUser();
		const { inner } = openPumpModal('Launch on Pump.fun');
		// Path held in a variable so Vite's import-analysis treats this as a
		// runtime-only dynamic import and doesn't try to bundle a /public asset.
		const launchPanelUrl = '/studio/launch-panel.js';
		const { mountLaunchPanel } = await import(/* @vite-ignore */ launchPanelUrl);
		mountLaunchPanel(inner, {
			getAvatar: () => ({ ...avatar, id: avatarId }),
			getUser: () => user,
			getPreviewViewer: () => null,
		});
	} catch (err) {
		log.error('[avatar] launch pump.fun failed', err);
	} finally {
		if (btn) btn.disabled = false;
	}
}

// Full creator-fee control for the avatar's coin: claim, split/delegate to
// contributors, distribute, and view recent claims. Mounts the shared fees
// panel against the coin resolved from /api/pump/by-agent.
async function openFeesPanel() {
	const btn = $('av-fees-rewards');
	if (btn?.disabled) return;
	if (btn) btn.disabled = true;
	try {
		if (!avatarCoin?.mint) {
			const id = avatarId;
			const r = await fetch(`/api/pump/by-agent?avatar_id=${encodeURIComponent(id)}`, { credentials: 'include' });
			const { data } = r.ok ? await r.json() : { data: null };
			avatarCoin = data;
		}
		if (!avatarCoin?.mint) { alert('No coin launched for this avatar yet — launch one first.'); return; }
		const user = await fetchCurrentUser();
		const { inner } = openPumpModal('Fees & rewards');
		const feesPanelUrl = '/studio/fees-panel.js';
		const { mountFeesPanel } = await import(/* @vite-ignore */ feesPanelUrl);
		mountFeesPanel(inner, {
			mint: avatarCoin.mint,
			network: avatarCoin.network || 'mainnet',
			creator: avatarCoin.agent_authority || null,
			avatarId: avatarId,
			agentId: avatar.agent_id || null,
			symbol: avatarCoin.symbol || '',
			name: avatarCoin.name || '',
			getUser: () => user,
		});
	} catch (err) {
		log.error('[avatar] open fees panel failed', err);
	} finally {
		if (btn) btn.disabled = false;
	}
}

// ── Use this avatar → create + edit an agent ─────────────────────────
//
// Demo avatars don't exist in the DB; the marketplace API silently drops
// avatar_id for those, so the caller still gets an agent — just without the
// glb attached. Real (DB-backed) avatars get linked. Either way the user
// lands on the edit page for their new draft.

async function startAgentWithAvatar() {
	const btn = $('av-use');
	if (!btn) return;
	const original = btn.textContent;
	btn.disabled = true;
	btn.textContent = 'Creating…';
	try {
		const skillsArr = [...attachedSkills].map((s) => ({
			name: SKILL_CATALOG.find((x) => x.id === s)?.name || s,
			id: s,
		}));
		const body = {
			name: `${avatar.name} agent`,
			description: avatar.description?.slice(0, 480) || `An agent voiced by the "${avatar.name}" avatar.`,
			system_prompt: buildSystemContext(),
			greeting: `Hi! I'm ${avatar.name}.`,
			category: 'general',
			tags: (avatar.tags || []).slice(0, 8),
			capabilities: { skills: skillsArr, library: [], bullets: [] },
			avatar_id: avatarId,
		};
		// apiFetch attaches the single-use CSRF token every marketplace write needs.
		const r = await apiFetch('/api/marketplace/agents', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const j = await r.json();
		if (!r.ok) throw new Error(j.error_description || j.error || 'Failed to create agent');
		const newId = j?.data?.agent?.id;
		if (!newId) throw new Error('Server did not return new agent id');
		location.href = `/agents/${encodeURIComponent(newId)}/edit`;
	} catch (err) {
		// A signed-out caller is already on its way to /login (apiFetch owns that
		// redirect), so there is nothing to say and nothing to retry.
		if (err?.redirected) return;
		log.error('[avatar] start agent', err);
		btn.textContent = original;
		btn.disabled = false;
		alert(err.message || 'Failed to start agent');
	}
}

// ── Skills panel ──────────────────────────────────────────────────────
//
// Two different questions share this tab, because the subject is different:
//   agent mode  → "what can THIS agent do, and what does it charge?"
//                 (real capabilities off the agent record, priced in USDC)
//   avatar mode → "what can I attach to this body?"
//                 (the local catalog of animation/wallet/memory add-ons)

async function loadSkills() {
	const list = $('av-skills-list');
	if (!list) return;
	if (mode === 'agent') return renderAgentCapabilities(list);
	const skills = await fetchSkills();
	if (!skills.length) {
		list.innerHTML = emptyStateHTML({
			compact: true,
			icon: '🧩',
			title: 'No skills available',
			body: 'Skills give this avatar new abilities — wallet, memory, animations and more. None can be attached yet; check back soon.',
		});
		return;
	}
	list.innerHTML = skills.map(renderSkillRow).join('');
	list.querySelectorAll('[data-skill]').forEach((btn) => {
		btn.addEventListener('click', () => toggleSkill(btn.dataset.skill));
	});
}

/**
 * The agent's real, published capabilities: the skill names it exposes and, for
 * the priced ones, what a call actually costs. Prices are atomic integers in
 * the mint's own decimals (a 9-decimal mint overflows a float), so they are
 * formatted from the integer, never parsed into one.
 *
 * Buying is deliberately NOT reimplemented here. Checkout needs a connected
 * wallet, CSRF, trial accounting and receipt handling, all of which already
 * live on the full profile; every priced row links straight to it rather than
 * shipping a second, subtly different checkout.
 */
function renderAgentCapabilities(list) {
	const skills = (agent.skills || []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
	if (!skills.length) {
		list.innerHTML = emptyStateHTML({
			compact: true,
			icon: '\u{1f9e9}',
			title: 'No published capabilities yet',
			body: `${esc(avatar.name)} has not exposed any callable skills. You can still talk to it in the Chat tab.`,
		});
		return;
	}

	const prices = agent.skill_prices || {};
	const priced = skills.filter((n) => Number(prices[n]?.amount) > 0);
	// `#sec-capabilities` is the anchor the profile's own section nav uses.
	const profileHref = `/agents/${encodeURIComponent(entityId)}/profile#sec-capabilities`;

	const summary = priced.length
		? `<div class="av-cap-summary">
				<strong>${priced.length} paid skill${priced.length === 1 ? '' : 's'}</strong>
				<span>from ${esc(formatSkillPrice(cheapestPrice(priced, prices)))} per call</span>
			</div>`
		: `<div class="av-cap-summary av-cap-summary--free">
				<strong>Free to call</strong>
				<span>every skill this agent exposes is open</span>
			</div>`;

	list.innerHTML =
		summary +
		skills
			.map((name) => {
				const p = prices[name];
				const gated = p?.gate_type === 'nft';
				const amount = Number(p?.amount) || 0;
				const badge = gated
					? `<span class="av-cap-badge av-cap-badge--gated" title="Hold an NFT from the collection to unlock">Token gated</span>`
					: amount > 0
						? `<span class="av-cap-badge av-cap-badge--paid">${esc(formatSkillPrice(p))}</span>`
						: `<span class="av-cap-badge">Free</span>`;
				return `<div class="av-row">
					<div class="av-row-main">
						<p class="av-row-title">${esc(skillLabel(name))}</p>
						<p class="av-row-sub"><code class="av-row-slug">${esc(name)}</code></p>
					</div>
					${badge}
				</div>`;
			})
			.join('') +
		`<a class="av-cap-more" href="${profileHref}">Pricing, trials and purchase on the full profile &rarr;</a>`;
}

// Cheapest priced skill, compared on the atomic integer so a 9-decimal mint
// never rounds through a float on the way to the comparison.
function cheapestPrice(names, prices) {
	return names
		.map((n) => prices[n])
		.reduce((best, p) => (!best || BigInt(p.amount) < BigInt(best.amount) ? p : best), null);
}

// Atomic integer + mint decimals → a human amount, formatted from the digits
// rather than by dividing, so large mints stay exact.
function formatSkillPrice(price) {
	if (!price) return '';
	const decimals = Number(price.mint_decimals ?? 6);
	const digits = String(price.amount ?? '0').padStart(decimals + 1, '0');
	const whole = digits.slice(0, digits.length - decimals) || '0';
	const frac = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
	const symbol = price.mint_symbol || 'USDC';
	return `${whole}${frac ? `.${frac}` : ''} ${symbol}`;
}

function renderSkillRow(s) {
	const on = attachedSkills.has(s.id);
	const disabled = s.available === false;
	const action = disabled
		? `<button class="av-row-action" disabled title="No matching animation clip in this GLB">Unavailable</button>`
		: `<button class="av-row-action${on ? ' active' : ''}" data-skill="${esc(s.id)}">${on ? 'Attached' : 'Attach'}</button>`;
	return `<div class="av-row${disabled ? ' av-row-disabled' : ''}">
		<div class="av-row-main">
			<p class="av-row-title">${esc(s.name)}</p>
			<p class="av-row-sub">${esc(s.desc)}</p>
		</div>
		${action}
	</div>`;
}

async function toggleSkill(id) {
	const wasOn = attachedSkills.has(id);
	if (wasOn) attachedSkills.delete(id);
	else attachedSkills.add(id);
	saveAttached();
	await loadSkills();
	const overview = $('av-panel-overview');
	if (overview) {
		const existing = overview.querySelector('.av-attached');
		if (existing) existing.remove();
		const html = renderAttached();
		if (html) overview.insertAdjacentHTML('beforeend', html);
	}

	// Side effects on attach/detach for skills that act immediately:
	if (!wasOn) {
		switch (id) {
			case 'memory':
				// Re-hydrate stored chat history into the panel.
				hydrateChatHistory();
				break;
			case 'animate-wave':
				playClipByHint(['wave', 'wavehello', 'hi']);
				break;
			case 'animate-idle':
				playClipByHint(['idle', 'breathing', 'breath'], { loop: true });
				break;
			case 'wallet':
				window.open('/pay', '_blank', 'noopener');
				break;
			case 'identity':
				window.open('/dashboard', '_blank', 'noopener');
				break;
		}
	}
}

// ── Animation triggers ───────────────────────────────────────────────
//
// model-viewer surfaces playback through `availableAnimations` (array of
// clip names) + `animationName` setter + `play()/pause()` methods. We use
// only those public APIs — no scene-graph reach-in.

function playClipByHint(hints, { loop = false } = {}) {
	const viewer = $('av-viewer');
	if (!viewer) return;
	const clips = viewer.availableAnimations || [];
	if (!clips.length) return;
	const lower = clips.map((n) => n.toLowerCase());
	let idx = -1;
	for (const hint of hints) {
		idx = lower.findIndex((n) => n.includes(hint));
		if (idx !== -1) break;
	}
	if (idx === -1) return;
	playClip(viewer, clips[idx], { loop });
}

// Build the floating play/pause + clip-switcher bar once the model is loaded.
// Visible only when the GLB actually carries animation clips. A rigged avatar
// with a single embedded mocap take gets an autoplaying idle + a pause toggle;
// a model with several takes gets a pill switcher to jump between them.
function setupAnimationControls(viewer) {
	const bar = $('av-anim-bar');
	const clipsHost = $('av-anim-clips');
	const toggle = $('av-anim-toggle');
	if (!bar || !clipsHost || !toggle) return;

	const clips = (viewer.availableAnimations || []).slice();
	if (!clips.length) {
		bar.removeAttribute('data-visible');
		return;
	}

	// Mirror into the skills-panel detection set so wave/idle skills light up
	// even before the byte-range stats probe resolves.
	availableAnimations = new Set(clips.map((n) => n.toLowerCase()));

	// Pick a sensible default: prefer a calm idle/breathing take, then a wave,
	// then whatever ships first.
	const lower = clips.map((n) => n.toLowerCase());
	const preferred = ['idle', 'breath', 'stand', 'wave', 'dance'];
	let defaultIdx = -1;
	for (const hint of preferred) {
		defaultIdx = lower.findIndex((n) => n.includes(hint));
		if (defaultIdx !== -1) break;
	}
	if (defaultIdx === -1) defaultIdx = 0;

	if (clips.length === 1) {
		// One take — no switcher, just a label so the control reads clearly.
		const label = document.createElement('span');
		label.className = 'av-anim-label';
		label.textContent = prettyClipName(clips[0], 0, 1);
		clipsHost.replaceChildren(label);
	} else {
		const frag = document.createDocumentFragment();
		clips.forEach((name, i) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'av-anim-clip';
			btn.dataset.clip = name;
			btn.textContent = prettyClipName(name, i, clips.length);
			btn.addEventListener('click', () => playClip(viewer, name, { loop: true }));
			frag.appendChild(btn);
		});
		clipsHost.replaceChildren(frag);
	}

	toggle.addEventListener('click', () => {
		if (animPlaying) {
			viewer.pause();
			setAnimPlaying(false);
		} else {
			if (typeof viewer.play === 'function') viewer.play({ repetitions: Infinity });
			setAnimPlaying(true);
		}
	});

	playClip(viewer, clips[defaultIdx], { loop: true });
	bar.setAttribute('data-visible', '1');
}

// Play a named clip via model-viewer's public API and sync the control bar.
function playClip(viewer, name, { loop = true } = {}) {
	if (!viewer || !name) return;
	viewer.animationName = name;
	viewer.currentTime = 0;
	if (typeof viewer.play === 'function') viewer.play({ repetitions: loop ? Infinity : 1 });
	setAnimPlaying(true);
	const clipsHost = $('av-anim-clips');
	clipsHost?.querySelectorAll('.av-anim-clip').forEach((btn) => {
		btn.classList.toggle('is-active', btn.dataset.clip === name);
	});
}

// Toggle the play/pause button's icon + ARIA state.
function setAnimPlaying(playing) {
	animPlaying = playing;
	const toggle = $('av-anim-toggle');
	if (!toggle) return;
	toggle.setAttribute('aria-pressed', String(playing));
	toggle.setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation');
	toggle.innerHTML = playing
		? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
		: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
}

// Humanize a raw glTF clip name for the switcher. Mocap exporters leave noise
// like "mixamo.com" or "Armature|Take 001" — collapse those to a clean label.
function prettyClipName(name, i, total) {
	const raw = (name || '').trim();
	if (!raw || /^mixamo\.com$/i.test(raw) || /\.(glb|gltf|fbx|com)$/i.test(raw)) {
		return total > 1 ? `Clip ${i + 1}` : 'Animation';
	}
	const cleaned = raw
		.replace(/^armature[|/_-]*/i, '')
		.replace(/\|/g, ' ')
		.replace(/[_-]+/g, ' ')
		.trim();
	if (!cleaned) return total > 1 ? `Clip ${i + 1}` : 'Animation';
	return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

let animPlaying = false;

// ── Plugins panel ─────────────────────────────────────────────────────

async function loadPlugins() {
	const list = $('av-plugins-list');
	if (!list) return;
	let plugins;
	try {
		plugins = await fetchPlugins();
	} catch {
		list.innerHTML = errorStateHTML({
			title: 'Plugins unavailable',
			body: 'The plugin list could not be loaded. Check your connection and try again.',
		});
		list.querySelector('[data-sk-retry]')?.addEventListener('click', loadPlugins, { once: true });
		return;
	}
	if (!plugins.length) {
		list.innerHTML = emptyStateHTML({
			compact: true,
			icon: '🔌',
			title: 'No plugins yet',
			body: 'Plugins are community-built tools you can attach to extend what this avatar can do. None have been published yet — yours could be the first.',
		});
		return;
	}
	list.innerHTML = plugins.slice(0, 20).map(renderPluginRow).join('');
	list.querySelectorAll('[data-plugin]').forEach((btn) => {
		btn.addEventListener('click', () => togglePlugin(btn.dataset.plugin));
	});
}

function renderPluginRow(p) {
	const id = p.identifier || p.id;
	const on = attachedPlugins.has(id);
	const name = p.name || p.manifest_json?.meta?.title || id;
	const desc = p.description || p.manifest_json?.meta?.description || '';
	const tools = Array.isArray(p.manifest_json?.api) ? p.manifest_json.api.length : 0;
	return `<div class="av-row">
		<div class="av-row-main">
			<p class="av-row-title">${esc(name)}</p>
			<p class="av-row-sub">${tools ? `${tools} tool${tools === 1 ? '' : 's'} · ` : ''}${esc(desc.slice(0, 80))}</p>
		</div>
		<button class="av-row-action${on ? ' active' : ''}" data-plugin="${esc(id)}">
			${on ? 'Attached' : 'Attach'}
		</button>
	</div>`;
}

function togglePlugin(id) {
	if (attachedPlugins.has(id)) attachedPlugins.delete(id);
	else attachedPlugins.add(id);
	saveAttached();
	loadPlugins();
	const overview = $('av-panel-overview');
	if (overview) {
		const existing = overview.querySelector('.av-attached');
		if (existing) existing.remove();
		const html = renderAttached();
		if (html) overview.insertAdjacentHTML('beforeend', html);
	}
}

// ── Attached storage ──────────────────────────────────────────────────

// Storage is scoped per ENTITY, not per body: an agent and the avatar it wears
// are different subjects, so their attachments and chat memory must not merge.
function entityKey() {
	return mode === 'agent' ? `agent:${entityId}` : avatar?.id || entityId;
}

function attachedKey() {
	return ATTACHED_KEY_PREFIX + entityKey();
}
function loadAttached() {
	try {
		const raw = localStorage.getItem(attachedKey());
		if (!raw) return;
		const parsed = JSON.parse(raw);
		attachedSkills = new Set(parsed.skills || []);
		attachedPlugins = new Set(parsed.plugins || []);
	} catch {
		// ignore corrupt entries
	}
}
function saveAttached() {
	try {
		localStorage.setItem(attachedKey(), JSON.stringify({
			skills: [...attachedSkills],
			plugins: [...attachedPlugins],
		}));
	} catch {
		// localStorage full or disabled — non-fatal, attachments stay in-memory for the session
	}
}

// ── Thought bubble (above avatar) ────────────────────────────────────

function positionThoughtHotspot(viewer) {
	const hotspot = $('av-hotspot-thought');
	if (!hotspot || !viewer) return;
	try {
		const dims = viewer.getDimensions();
		if (dims && dims.y > 0) {
			const topY = (dims.y + 0.12).toFixed(3);
			hotspot.setAttribute('data-position', `0 ${topY} 0.08`);
		}
	} catch {}
}

function showThoughtThinking() {
	const bubble = $('av-thought-bubble');
	const content = $('av-thought-content');
	if (!bubble || !content) return;
	content.innerHTML = '<div class="av-thinking-dots"><span></span><span></span><span></span></div>';
	bubble.classList.remove('overflow');
	bubble.classList.add('visible');
}

function streamThoughtText(text) {
	const bubble = $('av-thought-bubble');
	const content = $('av-thought-content');
	if (!bubble || !content) return;
	content.textContent = text;
	const cursor = document.createElement('span');
	cursor.className = 'av-thought-cursor';
	content.appendChild(cursor);
	bubble.classList.toggle('overflow', content.scrollHeight > 150);
	if (!bubble.classList.contains('visible')) bubble.classList.add('visible');
}

function finalizeThought(text) {
	const bubble = $('av-thought-bubble');
	const content = $('av-thought-content');
	if (!bubble || !content) return;
	content.textContent = text;
	bubble.classList.toggle('overflow', content.scrollHeight > 150);
}

// ── Chat panel ────────────────────────────────────────────────────────

function bindChat() {
	const form = $('av-chat-form');
	const input = $('av-chat-input');
	const send = $('av-chat-send');
	const mic = $('av-chat-mic');
	if (!form || !input || !send) return;

	const modelSelect = $('av-chat-model');
	// Show a "Powered by IBM watsonx" badge whenever the active brain is a watsonx
	// provider (Granite or Orchestrate), so the IBM integration is visible the
	// moment it's driving the avatar.
	const ibmBadge = $('av-chat-ibm');
	const syncIbmBadge = () => {
		if (!ibmBadge) return;
		const choice = MODEL_OPTIONS.find((o) => o.id === selectedModelId);
		const onIbm = choice?.provider === 'watsonx' || choice?.provider === 'orchestrate';
		ibmBadge.dataset.on = onIbm ? '1' : '0';
	};
	if (modelSelect) {
		try {
			const stored = localStorage.getItem(MODEL_STORAGE_KEY);
			if (stored && MODEL_OPTIONS.some((o) => o.id === stored)) selectedModelId = stored;
		} catch {}
		modelSelect.value = selectedModelId;
		modelSelect.addEventListener('change', () => {
			selectedModelId = modelSelect.value;
			try { localStorage.setItem(MODEL_STORAGE_KEY, selectedModelId); } catch {}
			syncIbmBadge();
		});
	}
	syncIbmBadge();

	// Persistent memory (memory skill): replay stored history on first paint.
	if (attachedSkills.has('memory')) hydrateChatHistory();

	input.addEventListener('input', () => {
		input.style.height = 'auto';
		input.style.height = Math.min(input.scrollHeight, 120) + 'px';
	});
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			form.requestSubmit();
		}
	});
	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const text = input.value.trim();
		if (!text) return;
		input.value = '';
		input.style.height = 'auto';
		await sendChatMessage(text);
	});

	// Mic button → Web Speech API STT. Hidden if the browser doesn't support it.
	const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (mic && SR) {
		const rec = new SR();
		rec.continuous = false;
		rec.interimResults = false;
		rec.lang = 'en-US';
		let listening = false;
		mic.addEventListener('click', () => {
			if (!attachedSkills.has('stt')) {
				alert('Attach the "Voice input" skill first (Skills tab).');
				return;
			}
			if (listening) { rec.stop(); return; }
			try { rec.start(); listening = true; mic.classList.add('listening'); }
			catch (err) { log.warn('[avatar] STT start', err.message); }
		});
		rec.onresult = (e) => {
			const text = e.results[0]?.[0]?.transcript;
			if (text) input.value = (input.value ? input.value + ' ' : '') + text;
			input.dispatchEvent(new Event('input'));
			input.focus();
		};
		rec.onend = () => { listening = false; mic.classList.remove('listening'); };
		rec.onerror = () => { listening = false; mic.classList.remove('listening'); };
	} else if (mic) {
		mic.hidden = true; // unsupported browser — hide rather than show a dead button
	}
}

// ── Persistent chat memory ───────────────────────────────────────────

const MEMORY_KEY_PREFIX = 'avatar_chat_v1:';
function memoryKey() { return MEMORY_KEY_PREFIX + entityKey(); }

function hydrateChatHistory() {
	if (!attachedSkills.has('memory')) return;
	try {
		const raw = localStorage.getItem(memoryKey());
		if (!raw) return;
		const stored = JSON.parse(raw);
		if (!Array.isArray(stored) || stored.length === 0) return;
		chatHistory = stored.slice(-40); // cap so we don't blow context
		const logEl = $('av-chat-log');
		if (!logEl) return;
		logEl.querySelector('.av-chat-empty')?.remove();
		// Re-render the conversation from the persisted history.
		const existing = logEl.querySelectorAll('.av-chat-msg');
		existing.forEach((n) => n.remove());
		for (const m of chatHistory) appendChatMessage(m.role, m.content);
	} catch (err) {
		log.warn('[studio] memory hydrate failed', err.message);
	}
}

function persistChatHistory() {
	if (!attachedSkills.has('memory')) return;
	try {
		localStorage.setItem(memoryKey(), JSON.stringify(chatHistory.slice(-40)));
	} catch {
		// quota exceeded — drop oldest half and retry
		try {
			localStorage.setItem(memoryKey(), JSON.stringify(chatHistory.slice(-10)));
		} catch {/* give up */}
	}
}

// ── TTS playback ─────────────────────────────────────────────────────
//
// Hits the existing /api/tts/edge endpoint (Microsoft Edge Neural voices,
// no API key required, R2-cached server-side). Returns audio/mpeg which we
// play through a single shared Audio element.

let ttsAudio = null;
async function speakReply(text) {
	if (!attachedSkills.has('tts')) return;
	if (!text || !text.trim()) return;
	try {
		// Stop any prior playback so consecutive replies don't overlap.
		if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
		const r = await fetch('/api/tts/edge', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ voice: 'en-US-AriaNeural', text: text.slice(0, 1500) }),
		});
		if (!r.ok) throw new Error(`TTS failed (${r.status})`);
		const blob = await r.blob();
		const url = URL.createObjectURL(blob);
		ttsAudio = new Audio(url);
		ttsAudio.onended = () => { URL.revokeObjectURL(url); ttsAudio = null; };
		await ttsAudio.play();
	} catch (err) {
		log.warn('[avatar] TTS playback failed', err.message);
	}
}

async function sendChatMessage(text) {
	const logEl = $('av-chat-log');
	const send = $('av-chat-send');
	if (!logEl) return;

	// Drop empty-state once we have any message
	const empty = logEl.querySelector('.av-chat-empty');
	if (empty) empty.remove();

	// Wave on the very first user message of the session, if the avatar has
	// a wave clip and the wave skill is attached.
	if (chatHistory.length === 0 && attachedSkills.has('animate-wave')) {
		playClipByHint(['wave', 'wavehello', 'hi']);
	}

	chatHistory.push({ role: 'user', content: text });
	appendChatMessage('user', text);

	// Real conversation sentiment moves the agent's mood (deterministic lexicon,
	// never random). Scoped to this agent inside the engine.
	moodEngine.observeChat(chatAgentId(), text, 'user');

	const assistantNode = appendChatMessage('assistant', '');
	const cursor = document.createElement('span');
	cursor.className = 'av-chat-cursor';
	assistantNode.appendChild(cursor);

	showThoughtThinking();
	send.disabled = true;
	let acc = '';
	try {
		const systemContext = buildSystemContext();
		const agentIdMaybe = chatAgentId();
		const isUuid = typeof agentIdMaybe === 'string'
			&& /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentIdMaybe);
		const choice = MODEL_OPTIONS.find((o) => o.id === selectedModelId);
		const r = await fetch('/api/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				message: text,
				system_prompt: systemContext,
				history: chatHistory.slice(-10, -1),
				...(isUuid ? { agentId: agentIdMaybe } : {}),
				...(choice?.provider ? { provider: choice.provider, model: choice.model } : {}),
			}),
		});
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			throw new Error(j.error_description || j.error || `Chat failed (${r.status})`);
		}
		const reader = r.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let lines = buf.split('\n\n');
			buf = lines.pop() || '';
			for (const block of lines) {
				const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
				if (!dataLine) continue;
				const payload = dataLine.slice(5).trim();
				if (!payload) continue;
				let evt;
				try { evt = JSON.parse(payload); } catch { continue; }
				if (evt.type === 'chunk' && evt.text) {
					acc += evt.text;
					assistantNode.textContent = acc;
					logEl.scrollTop = logEl.scrollHeight;
					streamThoughtText(acc);
				} else if (evt.type === 'home_tool') {
					// The agent touched the connected house. A guarded action arrives
					// here as a pending confirmation and is rendered as a card the
					// person approves; the browser NEVER performs it itself, and there
					// is no path from this branch to the door.
					if (evt.status === 'pending_confirmation') {
						renderHomeConfirmation(logEl, evt.data);
					}
				} else if (evt.type === 'done') {
					// The server reports exactly which memories it recalled into this
					// reply's context — turn that into a `memory:recalled` bus event so
					// the HUD, Mind Palace, and any other surface can react live.
					emitRecallFromChat(isUuid ? agentIdMaybe : null, evt, text);
					// Let the agent's own words colour its mood too.
					moodEngine.observeChat(isUuid ? agentIdMaybe : null, evt.reply || acc, 'assistant');
				} else if (evt.type === 'error') {
					throw new Error(evt.message || evt.error || 'Stream error');
				}
			}
		}
		chatHistory.push({ role: 'assistant', content: acc });
		persistChatHistory();
		finalizeThought(acc);
		if (acc) speakReply(acc);
	} catch (err) {
		assistantNode.textContent = acc || `⚠ ${err.message}`;
		finalizeThought(acc || err.message);
		log.error('[studio] chat', err);
	} finally {
		cursor.remove();
		send.disabled = false;
	}
}

function appendChatMessage(role, text) {
	const logEl = $('av-chat-log');
	const node = document.createElement('div');
	node.className = `av-chat-msg ${role}`;
	node.textContent = text;
	logEl.appendChild(node);
	logEl.scrollTop = logEl.scrollHeight;
	return node;
}

/**
 * The id /api/chat should key memory, persona, and metering on. In agent mode
 * that is the agent itself (its brain, its memories); in avatar mode the avatar
 * id is the only stable handle the page has.
 */
function chatAgentId() {
	return mode === 'agent' ? entityId : avatar?.id || entityId;
}

function buildSystemContext() {
	const parts = [
		mode === 'agent'
			? `You are the agent "${avatar.name}" on three.ws, speaking as yourself.`
			: `You are voicing the avatar "${avatar.name}" on three.ws.`,
		avatar.description ? `Your character description: ${avatar.description}` : '',
		avatar.tags?.length ? `Tags: ${avatar.tags.join(', ')}` : '',
	];
	if (attachedSkills.size > 0) {
		const skills = [...attachedSkills].map((s) => SKILL_CATALOG.find((x) => x.id === s)?.name || s);
		parts.push(`Skills attached: ${skills.join(', ')}`);
	}
	parts.push('Respond in character, keep replies under 3 short paragraphs.');
	return parts.filter(Boolean).join('\n');
}

// ── Talk mode entry ──────────────────────────────────────────────────
//
// Opens the live-voice overlay: three.js renderer + lipsync + push-to-talk.
// Implementation lives in src/voice/talk-mode.js so this page only needs the
// click handler and a system-prompt provider.

function enterTalkMode() {
	if (!avatar) return;
	openTalkMode({ avatar, systemPromptFn: buildSystemContext });
}

// ── Agents wearing this avatar ────────────────────────────────────────

async function loadUsedBy() {
	const grid = $('av-used-by-grid');
	const section = $('av-used-by');
	if (!grid || !section) return;

	let agents;
	try {
		const r = await fetch(`/api/avatars/${encodeURIComponent(avatarId)}/agents`);
		if (!r.ok) return;
		({ agents } = await r.json());
	} catch {
		return; // optional section — stays hidden on network failure
	}
	if (!Array.isArray(agents) || agents.length === 0) return;

	section.hidden = false;
	grid.innerHTML = agents
		.map((a) => {
			const thumb = a.profileImage
				? `<img class="av-used-by-thumb" src="${esc(a.profileImage)}" alt="${esc(a.name)} avatar" loading="lazy" />`
				: `<div class="av-used-by-thumb av-used-by-thumb--placeholder" aria-hidden="true">${esc((a.name || 'A').slice(0, 1).toUpperCase())}</div>`;
			const badge = a.onchain
				? `<span class="av-used-by-badge" title="Registered on-chain">on-chain</span>`
				: '';
			// Each agent here is an agent surface — render the shared wallet chip
			// (tip for visitors, vanity entry for the owner). Hidden when the
			// used-by row carries no address, so we never show a misleading state.
			const chip = walletChipHTML(a, { isOwner: false, showPending: false });
			return `<a class="av-used-by-card" href="${esc(a.url)}" title="${esc(a.name)}">
				${thumb}
				<div class="av-used-by-meta">
					<span class="av-used-by-name">${esc(a.name)}</span>
					${badge}
				</div>
				${chip ? `<div class="av-used-by-wallet">${chip}</div>` : ''}
			</a>`;
		})
		.join('');
	wireWalletChips(grid);
}

// ── Forks (GitHub-style network) ──────────────────────────────────────

async function loadForks() {
	const grid = $('av-forks-grid');
	const section = $('av-forks');
	if (!grid || !section) return;

	let forks;
	try {
		const r = await fetch(`/api/avatars/fork?of=${encodeURIComponent(avatarId)}&limit=12`);
		if (!r.ok) return;
		({ forks } = await r.json());
	} catch {
		return; // optional section — stays hidden on network failure
	}
	if (!Array.isArray(forks) || forks.length === 0) return;

	section.hidden = false;
	grid.innerHTML = forks
		.map((f) => {
			const thumb = f.thumbnail_url
				? `<img class="av-used-by-thumb" src="${esc(f.thumbnail_url)}" alt="${esc(f.name)}" loading="lazy" />`
				: `<div class="av-used-by-thumb av-used-by-thumb--placeholder" aria-hidden="true">${esc((f.name || 'A').slice(0, 1).toUpperCase())}</div>`;
			const by = f.owner_name ? `<span class="av-used-by-badge">by ${esc(f.owner_name)}</span>` : '';
			return `<a class="av-used-by-card" href="/avatars/${encodeURIComponent(f.id)}" title="${esc(f.name)}">
				${thumb}
				<div class="av-used-by-meta">
					<span class="av-used-by-name">${esc(f.name)}</span>
					${by}
				</div>
			</a>`;
		})
		.join('');
}

// ── Related entities ──────────────────────────────────────────────────
//
// Same grid, same 3D cards, different neighbours: a body's neighbours are other
// bodies, an agent's are other agents doing similar work (server-side
// similarity over name, description, category and tags).

async function loadRelated() {
	let items;
	try {
		items = mode === 'agent' ? await fetchSimilarAgents() : await fetchRelated();
	} catch {
		return; // optional below-the-fold section, stays hidden on network failure
	}
	if (!items.length) return;
	const grid = $('av-related-grid');
	if (!grid) return;
	const heading = $('av-related')?.querySelector('h2');
	if (heading) {
		heading.removeAttribute('data-i18n');
		heading.textContent = mode === 'agent' ? 'Similar agents' : 'Related avatars';
	}
	$('av-related').hidden = false;
	grid.innerHTML = items.map((a) => {
		const id = encodeURIComponent(a.avatarId);
		return `
		<div class="av-related-card">
			<a class="av-related-main" href="${esc(a.href || `/avatars/${id}`)}" aria-label="Open ${esc(a.name || 'avatar')}">
				<div class="av-related-thumb">
					${a.glbUrl
						? `<model-viewer
						src="${esc(a.glbUrl)}"
						alt="${esc(a.name || 'Avatar')}"
						${a.image ? `poster="${esc(a.image)}"` : ''}
						auto-rotate
						rotation-per-second="14deg"
						interaction-prompt="none"
						disable-zoom
						disable-pan
						disable-tap
						exposure="1"
						shadow-intensity="0.4"
						tone-mapping="aces"
						loading="lazy"
					></model-viewer>`
						: a.image
							? `<img class="av-related-img" src="${esc(a.image)}" alt="${esc(a.name || 'Avatar')}" loading="lazy" decoding="async" />`
							: `<span class="av-related-initial" aria-hidden="true">${esc((a.name || '?').slice(0, 1).toUpperCase())}</span>`}
				</div>
				<div class="av-related-info">
					<p class="av-related-name">${esc(a.name || 'Untitled')}</p>
					<p class="av-related-author">${esc(a.subtitle || a.author?.displayName || a.author?.handle || 'Anonymous')}</p>
				</div>
			</a>
			${a.avatarId ? `<a class="av-related-irl" href="/irl?avatar=${id}" title="Walk ${esc(a.name || 'this avatar')} IRL" aria-label="Walk ${esc(a.name || 'this avatar')} IRL">
				<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
				IRL
			</a>` : ''}
		</div>`;
	}).join('');
}

/**
 * Agents doing similar work, from the marketplace's own similarity ranking
 * (name, description, category and tag overlap, scored in SQL). Normalised
 * into the same card shape the avatar grid uses so one renderer draws both.
 */
async function fetchSimilarAgents() {
	const r = await fetch(`/api/marketplace/agents/${encodeURIComponent(entityId)}/similar`, {
		credentials: 'include',
	});
	if (!r.ok) return [];
	const j = await r.json();
	const items = j?.data?.items || j?.data?.agents || j?.data || [];
	if (!Array.isArray(items)) return [];
	return items.slice(0, 8).map((a) => ({
		avatarId: a.avatar_id || null,
		href: `/agents/${encodeURIComponent(a.id)}`,
		name: a.name,
		glbUrl: a.avatar_glb_url || null,
		// Doubles as the model-viewer poster, so the card shows the agent even
		// before its GLB is fetched, and as the whole card when it has no body.
		image: a.thumbnail_url || null,
		subtitle: relatedAgentSubtitle(a),
	}));
}

// One honest line under a similar agent's name: its category if it has one,
// else its real reach. Never a fabricated "Anonymous" when we know better.
function relatedAgentSubtitle(a) {
	const views = Number(a.views_count) || 0;
	const forks = Number(a.forks_count) || 0;
	if (views || forks) {
		return [views ? `${compactNumber(views)} views` : '', forks ? `${compactNumber(forks)} forks` : '']
			.filter(Boolean)
			.join(' \u00b7 ');
	}
	return a.category || 'Agent';
}

// ── Model measurement ─────────────────────────────────────────────────

async function measureModel(glbUrl) {
	// Stable approach: parse the GLB binary header ourselves (range-fetched,
	// JSON chunk only — usually under 100 KB). No model-viewer internals,
	// no THREE.js, no scene-graph walking. Survives library upgrades.
	let stats;
	try {
		const { fetchGlbStats } = await import('./lib/glb-stats.js');
		stats = await fetchGlbStats(glbUrl);
	} catch (err) {
		log.warn('[avatar] glb stats parse failed', err.message);
		return;
	}

	if (stats.sizeBytes) {
		const mb = (stats.sizeBytes / 1_048_576).toFixed(1);
		$('av-size').textContent = `${mb} MB`;
		$('av-size-item').hidden = false;
	}
	if (stats.vertices > 0) {
		$('av-vert').textContent = stats.vertices.toLocaleString();
		$('av-vert-item').hidden = false;
	}
	if (stats.triangles > 0) {
		$('av-tri').textContent = stats.triangles.toLocaleString();
		$('av-tri-item').hidden = false;
	}
	if (stats.materials > 0) {
		$('av-mat').textContent = stats.materials;
		$('av-mat-item').hidden = false;
	}

	// Animation clip names → expose to the skills panel so we can wire animation
	// triggers (e.g. wave skill) to clips that actually exist in this GLB.
	if (stats.animationNames?.length) {
		availableAnimations = new Set(stats.animationNames.map((n) => n.toLowerCase()));
		// Re-render the skills list so disabled/enabled state reflects what
		// the GLB can actually do.
		const skillsList = $('av-skills-list');
		if (skillsList && !skillsList.querySelector('.av-list-loading')) loadSkills();
	}
}

let availableAnimations = new Set();

// ── OG meta ───────────────────────────────────────────────────────────

function updateOg() {
	const suffix = mode === 'agent' ? 'Agent Studio' : 'Avatar Studio';
	const fallbackDesc = mode === 'agent' ? 'A 3D AI agent on three.ws' : 'A 3D avatar on three.ws';
	document.title = `${avatar.name} · ${suffix} · three.ws`;
	$('og-title')?.setAttribute('content', `${avatar.name} · ${suffix}`);
	$('og-description')?.setAttribute('content', avatar.description || fallbackDesc);
	$('og-url')?.setAttribute('content', location.origin + entityPath);
	$('tw-title')?.setAttribute('content', `${avatar.name} · ${suffix}`);
	$('tw-description')?.setAttribute('content', avatar.description || fallbackDesc);
	setCanonical(location.origin + entityPath);
	// Always point at the entity's /og endpoint, which redirects to the real
	// thumbnail when one exists, falls back to a styled SVG card when it doesn't.
	// This way social cards never come up empty for demo avatars or new agents.
	const ogUrl =
		mode === 'agent'
			? `${location.origin}/api/og/agent?id=${encodeURIComponent(entityId)}`
			: `${location.origin}/api/avatar/${encodeURIComponent(avatarId)}/og`;
	$('og-image')?.setAttribute('content', ogUrl);
	const twImage = document.querySelector('meta[name="twitter:image"]');
	if (twImage) twImage.setAttribute('content', ogUrl);
	else {
		const m = document.createElement('meta');
		m.name = 'twitter:image';
		m.content = ogUrl;
		document.head.appendChild(m);
	}
}

// One canonical URL per entity: /avatars/:id or /agents/:id, never the ?view=
// or ?embed= variants, so search engines and social unfurls collapse to a
// single page instead of indexing every tab as its own document.
function setCanonical(href) {
	let link = document.querySelector('link[rel="canonical"]');
	if (!link) {
		link = document.createElement('link');
		link.rel = 'canonical';
		document.head.appendChild(link);
	}
	link.href = href;
}

// ── bootstrap (must run last) ────────────────────────────────────────
// Kept at the very end of the module, below every `let` this page owns.
// init() runs during module evaluation and writes module-level state
// (`agent`, `avatar`, `avatarId`, `viewerOwns`). JavaScriptCore checks an
// assignment target's temporal dead zone EAGERLY, before it evaluates the
// right-hand side, so `avatar = await fetch...()` threw
// "Cannot access uninitialized variable." in Safari (desktop and iOS) while
// V8 deferred the same check past the await and never noticed. That took the
// whole studio page down to its "Avatar not found" error state in Safari only.
// Declaring every binding before this call removes the ordering dependency
// instead of relying on which engine checks when.
if (!entityId) {
	$('av-shell').removeAttribute('aria-busy');
	$('av-shell').innerHTML = `<div class="av-error">No ${mode} specified.</div>`;
} else {
	init().catch((err) => {
		log.error('[studio] init', err);
		$('av-shell')?.removeAttribute('aria-busy');
		renderInitFailure(err);
	});
}
