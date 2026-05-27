// Launchpad Studio — the "Wix of 3D avatars + Stripe of x402 payments" surface.
//
// Pick a template (Token Launchpad, Paid Concierge, …), fill the form, see a
// live preview, hit Publish. The published config is hosted at /p/<slug>;
// the same studio is also the CMS for that page — opening
// /launchpad?slug=<existing> hydrates the saved state and re-publish updates
// the live page in place. Anyone can edit if they hold the owner secret
// (returned on first publish, kept in localStorage on the publishing browser)
// or if they sign in as the owning user.
//
// This module is NEW — it does not replace src/editor/embed-editor.js. The
// classic embed editor remains the place-and-scale UX; this is the
// template-driven creation + CMS surface.
//
// Public API: import { mountLaunchpadStudio } from './launchpad-studio.js';
//             mountLaunchpadStudio(rootEl, { slug, template, wallet, ... });

import '../element.js'; // ensures <agent-3d> is registered

// ──────────────────────────────────────────────────────────────────────────
// Templates
// ──────────────────────────────────────────────────────────────────────────
const TEMPLATES = [
	{
		id: 'token-launchpad',
		label: 'Token Launchpad',
		tagline: 'White-label Pump.fun launcher with a 3D avatar host',
		hint: 'Visitors land on a 3D-hosted page and mint a Pump.fun coin in one click. Creator wallet receives the launch fee split.',
		monetize: { kind: 'pump-launch', defaultPrice: 0.02, currency: 'SOL', chain: 'solana' },
		defaultCta: 'Launch your coin',
		defaultTagline: 'Mint a Pump.fun coin in seconds — hosted by your own 3D agent.',
	},
	{
		id: 'paid-concierge',
		label: 'Paid Concierge',
		tagline: '3D avatar that answers questions for x402 USDC',
		hint: 'A hosted agent page that charges a per-question fee via x402. Replies stream from the configured agent skill.',
		monetize: { kind: 'x402-call', defaultPrice: 0.01, currency: 'USDC', chain: 'base' },
		defaultCta: 'Ask the concierge',
		defaultTagline: 'Get an answer from the team in 5 seconds — paid in USDC.',
	},
	{
		id: 'gated-showroom',
		label: 'Gated 3D Showroom',
		tagline: 'Pay-to-enter glTF gallery with avatar greeter',
		hint: 'Visitors pay a small USDC fee to unlock a private 3D scene. Use for product reveals, premium models, or NFT preview rooms.',
		monetize: { kind: 'x402-unlock', defaultPrice: 0.05, currency: 'USDC', chain: 'base' },
		defaultCta: 'Unlock the room',
		defaultTagline: 'Step inside a private 3D space — one-time USDC pass.',
	},
];

const DEFAULT_AVATAR_SRC = '/avatars/default.glb';
const AGENT_3D_VERSION = '1.5.1';
const AGENT_3D_HOST = 'https://three.ws';
const DRAFT_KEY = 'launchpadStudio:draft';
const SECRETS_KEY = 'launchpadStudio:secrets';   // { [slug]: ownerSecret }
const RECENT_KEY = 'launchpadStudio:recent';     // [{slug, template, headline, updatedAt}, ...]

const DEMO_AVATARS = [
	{ id: 'demo-cz', name: 'CZ', model_url: '/avatars/cz.glb' },
	{ id: 'demo-default', name: 'Default', model_url: '/avatars/default.glb' },
	{ id: 'demo-robot', name: 'Robot Expressive', model_url: '/animations/robotexpressive.glb' },
	{ id: 'demo-soldier', name: 'Soldier', model_url: '/animations/soldier.glb' },
	{ id: 'demo-michelle', name: 'Michelle', model_url: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js/examples/models/gltf/Michelle.glb' },
	{ id: 'demo-xbot', name: 'Xbot', model_url: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js/examples/models/gltf/Xbot.glb' },
];

// ──────────────────────────────────────────────────────────────────────────
// Styles (single template literal; component is self-mounted into <body>)
// ──────────────────────────────────────────────────────────────────────────
const STYLE = `
	.studio-root {
		position: fixed;
		inset: 0;
		display: grid;
		grid-template-columns: 320px 1fr 380px;
		grid-template-rows: 56px minmax(0, 1fr);
		grid-template-areas: 'topbar topbar topbar' 'sidebar stage rail';
		background: #0b0d10;
		color: #f4f4f5;
		font: 14px/1.45 system-ui, -apple-system, sans-serif;
	}
	.topbar {
		grid-area: topbar;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 0 20px;
		background: #0f1216;
		border-bottom: 1px solid #1c2128;
	}
	.topbar .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -0.01em; }
	.topbar .brand .dot { width: 10px; height: 10px; border-radius: 50%; background: linear-gradient(135deg, #ffffff, #ec4899); }
	.topbar .pill { padding: 4px 10px; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: #a1a1aa; background: #1a1d22; border-radius: 999px; }
	.topbar .pill.editing { background: rgba(34,197,94,0.16); color: #4ade80; }
	.topbar .actions { display: flex; gap: 8px; align-items: center; position: relative; }
	.btn {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 8px 14px; font: inherit; font-size: 13px; font-weight: 500;
		color: #f4f4f5; background: #1f2329; border: 1px solid #2a2f37;
		border-radius: 8px; cursor: pointer; text-decoration: none;
		transition: background 0.12s, border 0.12s;
	}
	.btn:hover { background: #262b32; border-color: #353c46; }
	.btn.primary { background: linear-gradient(135deg, #ffffff, #ffffff); border-color: transparent; }
	.btn.primary:hover { filter: brightness(1.1); }
	.btn.ghost { background: transparent; border-color: transparent; color: #a1a1aa; }
	.btn.ghost:hover { color: #f4f4f5; background: #1a1d22; }
	.btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn.tiny { padding: 4px 8px; font-size: 11px; }
	.btn.danger { color: #f87171; border-color: #3a1f24; background: #1f1416; }
	.btn.danger:hover { background: #2a1a1d; }

	.dropdown {
		position: absolute; top: calc(100% + 6px); right: 0;
		min-width: 280px; max-width: 360px; max-height: 420px; overflow-y: auto;
		background: #15181d; border: 1px solid #262b32; border-radius: 10px;
		box-shadow: 0 20px 50px -10px rgba(0,0,0,0.6);
		padding: 6px; z-index: 50;
	}
	.dropdown-empty { padding: 14px; color: #71717a; font-size: 12px; }
	.dropdown-item {
		display: block; padding: 10px 12px; border-radius: 7px; cursor: pointer;
		text-decoration: none; color: inherit;
	}
	.dropdown-item:hover { background: #1c2027; }
	.dropdown-item .di-title { font-weight: 600; font-size: 13px; }
	.dropdown-item .di-meta { color: #71717a; font-size: 11px; margin-top: 2px; }

	.sidebar {
		grid-area: sidebar; overflow-y: auto;
		background: #0f1216; border-right: 1px solid #1c2128; padding: 20px 0;
	}
	.sidebar h3 {
		margin: 0 0 8px; padding: 0 20px;
		font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
		text-transform: uppercase; color: #71717a;
	}
	.template-card {
		display: block; margin: 8px 16px; padding: 14px;
		background: #181b21; border: 1px solid #232830; border-radius: 10px;
		cursor: pointer; transition: border 0.12s, background 0.12s;
	}
	.template-card:hover { border-color: #3a4150; background: #1c2027; }
	.template-card.active {
		border-color: #ffffff;
		background: linear-gradient(180deg, rgba(99,102,241,0.08), rgba(99,102,241,0));
	}
	.template-card .label { font-weight: 600; margin-bottom: 4px; }
	.template-card .tagline { color: #a1a1aa; font-size: 12px; line-height: 1.45; }
	.template-card .hint { color: #71717a; font-size: 11px; line-height: 1.5; margin-top: 8px; }

	.stage {
		grid-area: stage; overflow: auto; background: #15181d;
		display: flex; flex-direction: column; align-items: center; padding: 32px 28px;
	}
	.stage-frame {
		width: 100%; max-width: 980px;
		min-height: calc(100vh - 56px - 64px);
		background: var(--page-bg, #ffffff); color: var(--page-fg, #0f172a);
		border-radius: 16px; overflow: hidden;
		box-shadow: 0 30px 60px -20px rgba(0,0,0,0.5), 0 0 0 1px #1c2128;
		display: flex; flex-direction: column;
	}
	.stage-frame header {
		padding: 20px 32px; display: flex; justify-content: space-between; align-items: center;
		border-bottom: 1px solid rgba(0,0,0,0.06);
	}
	.stage-frame header .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; }
	.stage-frame header .brand .swatch {
		width: 22px; height: 22px; border-radius: 5px;
		background: var(--brand, #ffffff) center/cover no-repeat;
		box-shadow: 0 0 0 1px rgba(0,0,0,0.05);
	}
	.stage-frame header .links { display: flex; gap: 14px; font-size: 13px; color: #64748b; align-items: center; }
	.stage-frame header .links a { color: inherit; text-decoration: none; }
	.stage-frame header .links a:hover { color: var(--brand, #ffffff); }
	.stage-frame .hero {
		flex: 1; display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 32px;
		padding: 48px 32px 28px; align-items: center;
	}
	.stage-frame .hero-copy h1 {
		font-size: clamp(28px, 4vw, 44px); line-height: 1.1;
		margin: 0 0 16px; letter-spacing: -0.02em;
	}
	.stage-frame .hero-copy p { font-size: 17px; line-height: 1.55; color: #475569; margin: 0 0 28px; }
	.stage-frame .cta {
		display: inline-flex; align-items: center; gap: 8px;
		padding: 14px 22px; font-size: 15px; font-weight: 600;
		color: #fff; background: var(--brand, #ffffff); border: 0; border-radius: 12px;
		cursor: pointer; box-shadow: 0 6px 20px -8px var(--brand, #ffffff);
		transition: transform 0.12s;
	}
	.stage-frame .cta:hover { filter: brightness(1.06); }
	.stage-frame .price-chip { margin-left: 12px; font-size: 13px; color: #64748b; }
	.stage-frame .avatar-stage {
		position: relative; min-height: 380px; border-radius: 16px;
		background: linear-gradient(160deg, var(--brand, #ffffff) 0%, #1e1b4b 100%);
		overflow: hidden;
	}
	.stage-frame .avatar-stage agent-3d { position: absolute; inset: 0; width: 100%; height: 100%; }
	.stage-frame .token-strip {
		display: flex; align-items: center; gap: 14px;
		padding: 16px 32px; border-top: 1px solid rgba(0,0,0,0.06);
		background: rgba(0,0,0,0.02);
	}
	.stage-frame.dark .token-strip { background: rgba(255,255,255,0.02); border-top-color: rgba(255,255,255,0.06); }
	.stage-frame .token-logo {
		width: 44px; height: 44px; border-radius: 10px;
		background: rgba(0,0,0,0.06) center/cover no-repeat;
		flex: 0 0 auto;
	}
	.stage-frame.dark .token-logo { background-color: rgba(255,255,255,0.06); }
	.stage-frame .token-strip .token-meta { flex: 1; min-width: 0; }
	.stage-frame .token-strip .token-name { font-weight: 700; font-size: 14px; }
	.stage-frame .token-strip .token-desc { font-size: 12px; color: #64748b; line-height: 1.45; margin-top: 2px; }
	.stage-frame.dark .token-strip .token-desc { color: #94a3b8; }
	.stage-frame .skills-row {
		display: flex; flex-wrap: wrap; gap: 8px;
		padding: 12px 32px 24px;
	}
	.stage-frame .skill-pill {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 6px 10px 6px 12px; border-radius: 999px;
		background: rgba(99,102,241,0.08); color: var(--brand, #ffffff);
		font-size: 12px; font-weight: 500;
		border: 1px solid rgba(99,102,241,0.15);
	}
	.stage-frame.dark .skill-pill { background: rgba(99,102,241,0.16); }
	.stage-frame .skill-pill .price {
		background: var(--brand, #ffffff); color: #fff;
		padding: 2px 7px; border-radius: 999px;
		font-size: 10px; font-weight: 600;
	}
	.stage-frame footer {
		padding: 14px 32px; font-size: 12px; color: #94a3b8; text-align: center;
		border-top: 1px solid rgba(0,0,0,0.05);
	}
	.stage-frame footer a { color: inherit; text-decoration: underline; }

	.rail { grid-area: rail; overflow-y: auto; background: #0f1216; border-left: 1px solid #1c2128; }
	.panel { padding: 18px 20px; border-bottom: 1px solid #1c2128; }
	.panel h4 {
		margin: 0 0 12px; font-size: 11px; font-weight: 600;
		letter-spacing: 0.08em; text-transform: uppercase; color: #71717a;
		display: flex; align-items: center; justify-content: space-between; gap: 8px;
	}
	.field { margin-bottom: 12px; }
	.field:last-child { margin-bottom: 0; }
	.field label { display: block; font-size: 12px; color: #a1a1aa; margin-bottom: 5px; }
	.field input, .field select, .field textarea {
		width: 100%; box-sizing: border-box; padding: 8px 10px;
		font: inherit; font-size: 13px; color: #f4f4f5;
		background: #181b21; border: 1px solid #262b32; border-radius: 7px; outline: none;
	}
	.field input:focus, .field select:focus, .field textarea:focus { border-color: #ffffff; }
	.field textarea { min-height: 60px; resize: vertical; }
	.field .help { color: #71717a; font-size: 11px; margin-top: 4px; line-height: 1.4; }
	.field .row { display: flex; gap: 8px; }
	.field .row > * { flex: 1; }
	.color-input { display: flex; align-items: center; gap: 8px; }
	.color-input input[type=color] {
		width: 36px; height: 32px; padding: 0;
		border: 1px solid #262b32; border-radius: 6px; background: #181b21; cursor: pointer;
	}
	.color-input input[type=text] { font-family: ui-monospace, monospace; text-transform: uppercase; }

	.avatar-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 0 20px; }
	.avatar-tile {
		aspect-ratio: 1; background: #181b21;
		border: 1px solid #262b32; border-radius: 6px; cursor: pointer;
		display: flex; align-items: flex-end; justify-content: center;
		padding: 4px; font-size: 10px; color: #a1a1aa; text-align: center;
		overflow: hidden; transition: border 0.12s;
	}
	.avatar-tile:hover { border-color: #3a4150; }
	.avatar-tile.active { border-color: #ffffff; box-shadow: inset 0 0 0 1px #ffffff; }

	.skill-row {
		display: grid; grid-template-columns: 1fr 90px 80px 28px;
		gap: 6px; align-items: center; margin-bottom: 6px;
	}
	.skill-row input, .skill-row select {
		padding: 6px 8px; font-size: 12px;
		background: #181b21; border: 1px solid #262b32; border-radius: 6px; color: #f4f4f5;
	}
	.skill-row .skill-remove {
		display: flex; align-items: center; justify-content: center;
		width: 28px; height: 28px; padding: 0;
		font-size: 14px; line-height: 1;
		background: transparent; border: 1px solid #262b32; border-radius: 6px;
		color: #71717a; cursor: pointer;
	}
	.skill-row .skill-remove:hover { color: #f87171; border-color: #3a1f24; background: #1f1416; }

	.publish-status { font-size: 12px; color: #a1a1aa; line-height: 1.5; }
	.publish-status.ok { color: #4ade80; }
	.publish-status.err { color: #f87171; }
	.share-url { display: flex; gap: 6px; margin-top: 10px; }
	.share-url input { flex: 1; font-family: ui-monospace, monospace; font-size: 11px; padding: 8px 10px; background: #181b21; border: 1px solid #262b32; border-radius: 6px; color: #f4f4f5; }

	.snippet {
		font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.5;
		background: #0a0c0f; color: #cbd5e1;
		border: 1px solid #1c2128; border-radius: 8px; padding: 10px 12px;
		max-height: 220px; overflow: auto; white-space: pre;
	}
	.snippet-actions { display: flex; gap: 6px; margin-top: 8px; }

	.stage-frame.dark { --page-bg: #0f1216; --page-fg: #f4f4f5; }
	.stage-frame.dark header { border-bottom-color: rgba(255,255,255,0.06); }
	.stage-frame.dark header .links { color: #94a3b8; }
	.stage-frame.dark .hero-copy p { color: #cbd5e1; }
	.stage-frame.dark .price-chip { color: #94a3b8; }
	.stage-frame.dark footer { border-top-color: rgba(255,255,255,0.05); color: #64748b; }
`;

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) =>
	String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function lsGet(key, fallback) {
	try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
	catch { return fallback; }
}
function lsSet(key, value) {
	try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota — non-fatal */ }
}

const secrets = {
	get(slug) { return lsGet(SECRETS_KEY, {})[slug] || null; },
	set(slug, secret) { const all = lsGet(SECRETS_KEY, {}); all[slug] = secret; lsSet(SECRETS_KEY, all); },
	has(slug) { return Boolean(lsGet(SECRETS_KEY, {})[slug]); },
};

const recents = {
	all() { return lsGet(RECENT_KEY, []); },
	add(entry) {
		const list = lsGet(RECENT_KEY, []).filter((e) => e.slug !== entry.slug);
		list.unshift({ ...entry, updatedAt: new Date().toISOString() });
		lsSet(RECENT_KEY, list.slice(0, 12));
	},
	remove(slug) {
		lsSet(RECENT_KEY, lsGet(RECENT_KEY, []).filter((e) => e.slug !== slug));
	},
};

function loadDraft() { return lsGet(DRAFT_KEY, null); }
function saveDraft(state) { lsSet(DRAFT_KEY, state); }

function defaultStateFor(templateId) {
	const tpl = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES[0];
	return {
		template: tpl.id,
		identity: {
			slug: '', brand: '#ffffff', wallet: '', website: '', theme: 'light',
			socials: { twitter: '', telegram: '', discord: '' },
		},
		avatar: { src: DEFAULT_AVATAR_SRC, name: 'Default' },
		copy: { tagline: tpl.defaultTagline, cta: tpl.defaultCta, headline: tpl.label },
		token: { name: '', ticker: '', supply: 1_000_000_000, description: '', imageUrl: '', mint: '' },
		agentSkills: [],
		scene: { src: '' },
		monetize: {
			kind: tpl.monetize.kind, price: tpl.monetize.defaultPrice,
			currency: tpl.monetize.currency, chain: tpl.monetize.chain,
		},
		published: null,           // { slug, url, publishedAt }
		isEditing: false,          // true when hydrated from /api/launchpad/get
	};
}

// Hydrate state from a /api/launchpad/get payload. Returns the same shape as
// defaultStateFor with values from the published config layered in. Missing
// fields fall back to defaults so older rows still render.
function stateFromPayload(payload) {
	const tplId = payload.template || 'token-launchpad';
	const fresh = defaultStateFor(tplId);
	const c = payload.config || {};
	return {
		...fresh,
		template: tplId,
		identity: {
			...fresh.identity, ...(c.identity || {}),
			slug: payload.slug,
			socials: { ...fresh.identity.socials, ...((c.identity && c.identity.socials) || {}) },
		},
		avatar: { ...fresh.avatar, ...(c.avatar || {}) },
		copy: { ...fresh.copy, ...(c.copy || {}) },
		token: { ...fresh.token, ...(c.token || {}) },
		agentSkills: Array.isArray(c.agentSkills) ? c.agentSkills : [],
		scene: { ...fresh.scene, ...(c.scene || {}) },
		monetize: { ...fresh.monetize, ...(c.monetize || {}) },
		published: { slug: payload.slug, url: `${AGENT_3D_HOST}/p/${payload.slug}`, publishedAt: payload.updatedAt || payload.createdAt },
		isEditing: true,
	};
}

function mergeOptions(state, opts) {
	if (opts.template && TEMPLATES.find((t) => t.id === opts.template)) state.template = opts.template;
	if (opts.slug) state.identity.slug = slugify(opts.slug);
	if (opts.wallet) state.identity.wallet = String(opts.wallet);
	if (opts.website) state.identity.website = String(opts.website);
	if (opts.avatarSrc) state.avatar = { src: String(opts.avatarSrc), name: 'Custom' };
	return state;
}

// ──────────────────────────────────────────────────────────────────────────
// Snippets the user copies out
// ──────────────────────────────────────────────────────────────────────────
function buildEmbedSnippet(state) {
	const slug = state.identity.slug || '<your-slug>';
	return `<!-- Drop on any page to mount your three.ws launchpad -->
<script type="module"
  src="${AGENT_3D_HOST}/launchpad.js?v=${AGENT_3D_VERSION}"
  data-slug="${slug}">
</script>`;
}
function buildSkillManifest(state) {
	const tpl = TEMPLATES.find((t) => t.id === state.template) || TEMPLATES[0];
	const slug = state.identity.slug || 'unpublished';
	return JSON.stringify({
		name: `launchpad.${slug}`,
		version: '1.0.0',
		description: `${tpl.label} hosted by ${state.copy.headline || slug} on three.ws`,
		template: tpl.id,
		homepage: `${AGENT_3D_HOST}/p/${slug}`,
		skills: state.agentSkills?.length
			? state.agentSkills.map((s) => ({
				name: s.name, price: s.price, currency: s.currency,
				chain: s.chain, description: s.description || '',
			}))
			: [{
				name: tpl.id === 'token-launchpad' ? 'launch' : tpl.id === 'gated-showroom' ? 'unlock' : 'ask',
				price: state.monetize.price, currency: state.monetize.currency, chain: state.monetize.chain,
			}],
		pricing: {
			price: state.monetize.price, currency: state.monetize.currency,
			chain: state.monetize.chain, payout_address: state.identity.wallet || null,
		},
		x402: {
			endpoint: `${AGENT_3D_HOST}/api/launchpad/invoke?slug=${slug}`,
			facilitator: state.monetize.chain === 'base' ? 'cdp' : 'pump',
		},
	}, null, 2);
}

function formatPrice(m) {
	if (!m || !m.price) return '';
	const n = Number(m.price);
	return isFinite(n) && n > 0 ? `${n} ${m.currency || ''}`.trim() : '';
}
function short(addr) {
	if (!addr) return '';
	const s = String(addr);
	return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
function extraCopyFor(state, tpl) {
	if (tpl.id === 'token-launchpad') {
		const t = state.token, parts = [];
		if (t.name) parts.push(t.name);
		if (t.ticker) parts.push(`($${t.ticker})`);
		if (parts.length) return `Launching ${parts.join(' ')} on Pump.fun. Creator fees route to ${short(state.identity.wallet) || 'your wallet'}.`;
		return 'Set a token name and ticker on the right to seed the launch.';
	}
	if (tpl.id === 'paid-concierge') {
		return `Ask a question and pay ${formatPrice(state.monetize)} per call in USDC. Replies stream from the configured agent skill.`;
	}
	if (tpl.id === 'gated-showroom') {
		return `One-time ${formatPrice(state.monetize)} pass unlocks a private 3D scene${state.scene.src ? '' : ' — drop in any glTF/GLB URL on the right.'}`;
	}
	return tpl.tagline;
}

// ──────────────────────────────────────────────────────────────────────────
// Live preview (also rendered on /p/<slug> by public/p/render.js — keep them
// visually consistent so creators see what visitors will see)
// ──────────────────────────────────────────────────────────────────────────
// Stage skeleton — built once. updateStage() mutates text / class / style
// hooks via the data-* selectors below. Critically, the avatar mount slot
// stays untouched across updates so the persistent <agent-3d> element keeps
// its WebGL context alive (re-mounting tears it down mid-load and crashes
// viewer.js with "Cannot read properties of null (reading 'reset')").
function buildStageSkeleton() {
	return `
		<div class="stage-frame" data-stage-frame>
			<header>
				<div class="brand">
					<span class="swatch"></span>
					<span data-headline></span>
				</div>
				<nav class="links" data-links></nav>
			</header>
			<div class="hero">
				<div class="hero-copy">
					<h1 data-tagline></h1>
					<p data-extra-copy></p>
					<button class="cta" type="button" data-preview-cta></button>
					<span class="price-chip" data-price-chip></span>
				</div>
				<div class="avatar-stage" data-avatar-mount></div>
			</div>
			<div data-token-strip></div>
			<div data-skills-row></div>
			<footer data-footer></footer>
		</div>
	`;
}

// In-place stage updater — runs on every state change. No innerHTML on the
// avatar-stage slot, so the agent-3d element is never disconnected.
function updateStage(stage, state) {
	const tpl = TEMPLATES.find((t) => t.id === state.template) || TEMPLATES[0];
	const frame = stage.querySelector('[data-stage-frame]');
	const brand = state.identity.brand || '#ffffff';
	const headline = state.copy.headline || tpl.label;
	const tagline = state.copy.tagline || tpl.defaultTagline;
	const cta = state.copy.cta || tpl.defaultCta;
	const website = state.identity.website || '';
	const socials = state.identity.socials || {};
	const priceLabel = formatPrice(state.monetize);
	const slug = state.identity.slug || 'preview';
	const t = state.token || {};
	const showTokenStrip = tpl.id === 'token-launchpad' && (t.name || t.ticker || t.imageUrl || t.description);
	const skills = (state.agentSkills || []).filter((s) => s.name);

	frame.style.setProperty('--brand', brand);
	frame.classList.toggle('dark', state.identity.theme === 'dark');

	frame.querySelector('[data-headline]').textContent = headline;
	frame.querySelector('[data-tagline]').textContent = tagline;
	frame.querySelector('[data-extra-copy]').textContent = extraCopyFor(state, tpl);
	frame.querySelector('[data-preview-cta]').textContent = cta;

	const chip = frame.querySelector('[data-price-chip]');
	chip.textContent = priceLabel;
	chip.style.display = priceLabel ? '' : 'none';

	frame.querySelector('[data-links]').innerHTML = `
		${website ? `<a href="${esc(website)}" target="_blank" rel="noopener">Website</a>` : ''}
		${socials.twitter ? `<a href="${esc(socials.twitter)}" target="_blank" rel="noopener">X</a>` : ''}
		${socials.telegram ? `<a href="${esc(socials.telegram)}" target="_blank" rel="noopener">TG</a>` : ''}
		${socials.discord ? `<a href="${esc(socials.discord)}" target="_blank" rel="noopener">Discord</a>` : ''}
		<a href="${AGENT_3D_HOST}/p/${esc(slug)}" target="_blank" rel="noopener">${state.isEditing ? 'View live →' : 'Powered by three.ws'}</a>
	`;

	const tokenSlot = frame.querySelector('[data-token-strip]');
	tokenSlot.innerHTML = showTokenStrip ? `
		<div class="token-strip">
			<div class="token-logo" style="${t.imageUrl ? `background-image: url('${esc(t.imageUrl)}')` : ''}"></div>
			<div class="token-meta">
				<div class="token-name">${esc(t.name || 'Untitled')}${t.ticker ? ` · $${esc(t.ticker)}` : ''}</div>
				<div class="token-desc">${esc(t.description || (t.mint ? `mint ${short(t.mint)}` : 'Set token description on the right.'))}</div>
			</div>
		</div>
	` : '';

	const skillsSlot = frame.querySelector('[data-skills-row]');
	skillsSlot.innerHTML = skills.length ? `
		<div class="skills-row">
			${skills.map((s) => `
				<span class="skill-pill">
					${esc(s.name)}
					<span class="price">${esc(formatPrice(s) || 'free')}</span>
				</span>
			`).join('')}
		</div>
	` : '';

	frame.querySelector('[data-footer]').innerHTML = `
		Hosted on <a href="${AGENT_3D_HOST}" target="_blank" rel="noopener">three.ws</a> ·
		wallet ${esc(short(state.identity.wallet) || 'not connected')}
	`;
}

// ──────────────────────────────────────────────────────────────────────────
// Real-API helpers
// ──────────────────────────────────────────────────────────────────────────
async function fetchPublicAvatars() {
	try {
		const r = await fetch('/api/avatars/public?limit=18');
		if (!r.ok) return [];
		const data = await r.json();
		return Array.isArray(data?.avatars) ? data.avatars : [];
	} catch {
		return [];
	}
}
async function fetchLaunchpad(slug) {
	const r = await fetch(`/api/launchpad/get?slug=${encodeURIComponent(slug)}`);
	if (r.status === 404) return null;
	if (!r.ok) throw new Error(`Couldn't load /p/${slug} (${r.status})`);
	return r.json();
}
async function publishLaunchpad(state) {
	const slug = slugify(state.identity.slug);
	if (!slug) throw new Error('Choose a URL slug first.');
	if (!state.identity.wallet) throw new Error('Add your payout wallet address.');

	const body = {
		slug,
		template: state.template,
		identity: state.identity,
		avatar: state.avatar,
		copy: state.copy,
		token: state.token,
		agentSkills: state.agentSkills,
		scene: state.scene,
		monetize: state.monetize,
	};
	const existingSecret = secrets.get(slug);
	if (existingSecret) body.ownerSecret = existingSecret;

	const r = await fetch('/api/launchpad/publish', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error_description || data?.error || `Publish failed (${r.status})`);
	if (data.ownerSecret) secrets.set(slug, data.ownerSecret);
	recents.add({ slug, template: state.template, headline: state.copy.headline });
	return data;
}

// ──────────────────────────────────────────────────────────────────────────
// Mount
// ──────────────────────────────────────────────────────────────────────────
export function mountLaunchpadStudio(root, options = {}) {
	if (!root) throw new Error('mountLaunchpadStudio: root element required');

	const styleEl = document.createElement('style');
	styleEl.textContent = STYLE;
	document.head.appendChild(styleEl);

	const state = mergeOptions(loadDraft() || defaultStateFor(options.template || 'token-launchpad'), options);

	root.innerHTML = `
		<div class="studio-root">
			<div class="topbar">
				<div class="brand">
					<span class="dot"></span>
					<span>Launchpad Studio</span>
					<span class="pill" data-mode-pill>Template-driven</span>
				</div>
				<div class="actions">
					<a class="btn ghost" href="/embed" title="The original place-and-scale embed editor">Open classic editor</a>
					<button class="btn" data-action="open-recent">My launchpads ▾</button>
					<button class="btn" data-action="new-draft" title="Start a new draft (current draft cleared)">New</button>
					<button class="btn primary" data-action="publish">Publish</button>
				</div>
			</div>
			<aside class="sidebar">
				<h3>Templates</h3>
				<div data-templates></div>
				<h3 style="margin-top: 18px">Avatars</h3>
				<div class="avatar-grid" data-avatar-grid></div>
			</aside>
			<main class="stage" data-stage></main>
			<aside class="rail" data-rail></aside>
		</div>
	`;

	// Templates list
	const tplWrap = $('[data-templates]', root);
	tplWrap.innerHTML = TEMPLATES.map((t) => `
		<div class="template-card ${t.id === state.template ? 'active' : ''}" data-template-id="${t.id}">
			<div class="label">${esc(t.label)}</div>
			<div class="tagline">${esc(t.tagline)}</div>
			<div class="hint">${esc(t.hint)}</div>
		</div>
	`).join('');
	tplWrap.addEventListener('click', (e) => {
		const card = e.target.closest('[data-template-id]');
		if (!card || card.dataset.templateId === state.template) return;
		state.template = card.dataset.templateId;
		const tpl = TEMPLATES.find((t) => t.id === state.template);
		state.copy.headline = tpl.label;
		state.copy.tagline = tpl.defaultTagline;
		state.copy.cta = tpl.defaultCta;
		state.monetize = { kind: tpl.monetize.kind, price: tpl.monetize.defaultPrice, currency: tpl.monetize.currency, chain: tpl.monetize.chain };
		render();
	});

	// Avatar gallery
	const avatarWrap = $('[data-avatar-grid]', root);
	function renderAvatars(list) {
		avatarWrap.innerHTML = list.map((a) => `
			<div class="avatar-tile ${a.model_url === state.avatar.src ? 'active' : ''}"
				data-avatar-src="${esc(a.model_url)}"
				data-avatar-name="${esc(a.name || a.id)}"
				title="${esc(a.name || a.id)}">
				${esc((a.name || a.id || '').slice(0, 14))}
			</div>
		`).join('');
	}
	renderAvatars(DEMO_AVATARS);
	fetchPublicAvatars().then((extras) => {
		const seen = new Set(DEMO_AVATARS.map((a) => a.model_url));
		renderAvatars([...DEMO_AVATARS, ...extras.filter((a) => a.model_url && !seen.has(a.model_url))]);
	});
	avatarWrap.addEventListener('click', (e) => {
		const tile = e.target.closest('[data-avatar-src]');
		if (!tile) return;
		state.avatar = { src: tile.dataset.avatarSrc, name: tile.dataset.avatarName };
		render();
	});

	// Topbar + global actions (delegated)
	let recentDropdown = null;
	root.addEventListener('click', async (e) => {
		const action = e.target.closest('[data-action]')?.dataset.action;
		if (!action) {
			if (recentDropdown && !e.target.closest('.dropdown')) closeRecent();
			return;
		}
		if (action === 'new-draft') {
			if (!confirm('Discard current draft and start fresh?')) return;
			localStorage.removeItem(DRAFT_KEY);
			Object.assign(state, defaultStateFor(state.template));
			history.replaceState(null, '', '/launchpad');
			render();
			return;
		}
		if (action === 'open-recent') {
			toggleRecent(e.target.closest('button'));
			return;
		}
		if (action === 'load-recent') {
			const slug = e.target.closest('[data-slug]')?.dataset.slug;
			if (!slug) return;
			closeRecent();
			await hydrateFromSlug(slug);
			return;
		}
		if (action === 'forget-recent') {
			e.stopPropagation();
			const slug = e.target.closest('[data-slug]')?.dataset.slug;
			if (!slug) return;
			recents.remove(slug);
			renderRecentDropdown();
			return;
		}
		if (action === 'publish') {
			const btn = e.target.closest('[data-action="publish"]');
			btn.disabled = true;
			const orig = btn.textContent;
			btn.textContent = 'Publishing…';
			try {
				const result = await publishLaunchpad(state);
				state.published = {
					slug: result.slug,
					url: result.url || `${AGENT_3D_HOST}/p/${result.slug}`,
					publishedAt: result.publishedAt,
				};
				state.isEditing = true;
				history.replaceState(null, '', `/launchpad?slug=${encodeURIComponent(result.slug)}`);
			} catch (err) {
				state.published = { error: err.message || String(err) };
			} finally {
				btn.disabled = false;
				btn.textContent = orig;
				render();
			}
			return;
		}
		if (action === 'add-skill') {
			state.agentSkills.push({ name: '', price: 0.001, currency: 'USDC', chain: 'base', description: '' });
			render();
			return;
		}
		if (action === 'remove-skill') {
			const idx = Number(e.target.closest('[data-skill-idx]')?.dataset.skillIdx);
			if (Number.isFinite(idx)) {
				state.agentSkills.splice(idx, 1);
				render();
			}
			return;
		}
		if (action === 'copy-embed' || action === 'copy-skill' || action === 'copy-share') {
			const text = action === 'copy-embed' ? buildEmbedSnippet(state)
				: action === 'copy-skill' ? buildSkillManifest(state)
				: state.published?.url || '';
			if (!text) return;
			try {
				await navigator.clipboard.writeText(text);
				const btn = e.target.closest('button');
				const orig = btn.textContent;
				btn.textContent = 'Copied';
				setTimeout(() => { btn.textContent = orig; }, 1200);
			} catch {
				const snip = e.target.closest('.panel')?.querySelector('.snippet');
				if (snip) {
					const range = document.createRange();
					range.selectNodeContents(snip);
					const sel = window.getSelection();
					sel.removeAllRanges();
					sel.addRange(range);
				}
			}
		}
	});

	// "My launchpads" dropdown
	function toggleRecent(button) {
		if (recentDropdown) { closeRecent(); return; }
		recentDropdown = document.createElement('div');
		recentDropdown.className = 'dropdown';
		button.parentElement.appendChild(recentDropdown);
		renderRecentDropdown();
	}
	function closeRecent() {
		if (recentDropdown?.parentElement) recentDropdown.parentElement.removeChild(recentDropdown);
		recentDropdown = null;
	}
	function renderRecentDropdown() {
		if (!recentDropdown) return;
		const list = recents.all();
		if (!list.length) {
			recentDropdown.innerHTML = `<div class="dropdown-empty">No published launchpads on this browser yet. Hit Publish to start the list.</div>`;
			return;
		}
		recentDropdown.innerHTML = list.map((e) => `
			<div class="dropdown-item" data-action="load-recent" data-slug="${esc(e.slug)}" style="display:flex;align-items:flex-start;gap:8px;justify-content:space-between">
				<div style="min-width:0;flex:1">
					<div class="di-title">${esc(e.headline || e.slug)}</div>
					<div class="di-meta">/${esc(e.slug)} · ${esc(e.template)} · updated ${esc(new Date(e.updatedAt).toLocaleString())}</div>
				</div>
				<button class="btn tiny ghost" data-action="forget-recent" data-slug="${esc(e.slug)}" title="Remove from this list (does not unpublish)">×</button>
			</div>
		`).join('');
	}

	// Edit-mode hydration: ?slug=foo or options.slug
	async function hydrateFromSlug(slug) {
		try {
			const payload = await fetchLaunchpad(slug);
			if (!payload) {
				// No row yet — pre-fill the slug into a fresh draft so the user
				// can publish a new page at that URL.
				state.identity.slug = slug;
				state.isEditing = false;
				render();
				return;
			}
			Object.assign(state, stateFromPayload(payload));
			history.replaceState(null, '', `/launchpad?slug=${encodeURIComponent(slug)}`);
			render();
		} catch (err) {
			console.warn('[launchpad-studio] hydrate failed:', err.message);
			// Network failure shouldn't blow up the editor — start clean.
			state.identity.slug = slug;
			render();
		}
	}

	// Persistent across renders. Re-creating <agent-3d> on every keystroke
	// triggers a WebGL context rebuild that races with model load and crashes
	// the viewer ("Cannot read properties of null (reading 'reset')"). Keep
	// the element alive and just swap its `src` when the avatar changes.
	let avatarEl = null;
	let lastAvatarSrc = null;
	function ensureAvatarEl() {
		if (!avatarEl) {
			avatarEl = document.createElement('agent-3d');
			avatarEl.setAttribute('viewer', '');
			avatarEl.setAttribute('background', 'transparent');
			avatarEl.setAttribute('camera-controls', 'auto');
			avatarEl.setAttribute('auto-rotate', '');
		}
		if (state.avatar.src !== lastAvatarSrc) {
			avatarEl.setAttribute('src', state.avatar.src);
			lastAvatarSrc = state.avatar.src;
		}
		return avatarEl;
	}

	// Track structural state — only rebuild the rail when something changed
	// that needs new DOM (template switch, skills array length, edit mode).
	// Re-rendering the rail on every keystroke would steal focus from the
	// active input mid-typing.
	let lastTemplate = null;
	let lastSkillCount = -1;
	let lastEditing = null;

	let stageMounted = false;
	function renderStage() {
		const stage = $('[data-stage]', root);
		if (!stageMounted) {
			stage.innerHTML = buildStageSkeleton();
			stage.querySelector('[data-avatar-mount]').appendChild(ensureAvatarEl());
			stage.querySelector('[data-preview-cta]').addEventListener('click', (ev) => {
				ev.target.style.transform = 'scale(0.97)';
				setTimeout(() => { ev.target.style.transform = ''; }, 120);
			});
			stageMounted = true;
		} else {
			// Avatar src may have changed even without a structural rebuild.
			ensureAvatarEl();
		}
		updateStage(stage, state);
	}

	function renderRail(force = false) {
		const skillCount = (state.agentSkills || []).length;
		const needsRebuild = force ||
			state.template !== lastTemplate ||
			skillCount !== lastSkillCount ||
			state.isEditing !== lastEditing;
		if (needsRebuild) {
			$('[data-rail]', root).innerHTML = buildRailHTML(state);
			bindRailInputs(root, state, render);
			lastTemplate = state.template;
			lastSkillCount = skillCount;
			lastEditing = state.isEditing;
		} else {
			// Lightweight refresh: only the publish-status block + share URL.
			const pub = root.querySelector('[data-publish-block]');
			if (pub) pub.innerHTML = publishStatusHTML(state);
		}
	}

	function syncTopbar() {
		const pill = root.querySelector('[data-mode-pill]');
		pill.textContent = state.isEditing ? 'Editing' : 'New draft';
		pill.classList.toggle('editing', !!state.isEditing);
		root.querySelectorAll('[data-template-id]').forEach((el) => {
			el.classList.toggle('active', el.dataset.templateId === state.template);
		});
		root.querySelectorAll('[data-avatar-src]').forEach((el) => {
			el.classList.toggle('active', el.dataset.avatarSrc === state.avatar.src);
		});
	}

	function render({ force = false } = {}) {
		saveDraft(state);
		renderStage();
		renderRail(force);
		syncTopbar();
	}

	// Initial render
	if (options.slug) {
		hydrateFromSlug(slugify(options.slug)).finally(render);
	} else {
		render();
	}

	return {
		getState: () => JSON.parse(JSON.stringify(state)),
		render,
		hydrateFromSlug,
	};
}

// ──────────────────────────────────────────────────────────────────────────
// Right-rail (form panels per template + publish + snippets)
// ──────────────────────────────────────────────────────────────────────────
function buildRailHTML(state) {
	const tpl = TEMPLATES.find((t) => t.id === state.template) || TEMPLATES[0];

	const identityPanel = `
		<div class="panel">
			<h4>Identity</h4>
			${field('Public URL slug', `<input type="text" data-bind="identity.slug" value="${esc(state.identity.slug)}" placeholder="yourname" ${state.isEditing ? 'readonly' : ''} />`,
				state.isEditing ? `Live at ${AGENT_3D_HOST}/p/${state.identity.slug}` : `Your page will live at ${AGENT_3D_HOST}/p/${state.identity.slug || '<slug>'}`)}
			${field('Brand color', `
				<div class="color-input">
					<input type="color" data-bind="identity.brand" value="${esc(state.identity.brand)}" />
					<input type="text" data-bind="identity.brand" value="${esc(state.identity.brand)}" />
				</div>`)}
			${field('Payout wallet', `<input type="text" data-bind="identity.wallet" value="${esc(state.identity.wallet)}" placeholder="${state.monetize.chain === 'solana' ? 'Sol... (base58)' : '0x... (EVM)'}" />`, 'Receives launch fees / x402 payments. Used as the edit-key when you re-publish.')}
			${field('Your website (optional)', `<input type="text" data-bind="identity.website" value="${esc(state.identity.website)}" placeholder="https://your-site.com" />`)}
			${field('Theme', `
				<select data-bind="identity.theme">
					<option value="light" ${state.identity.theme === 'light' ? 'selected' : ''}>Light</option>
					<option value="dark" ${state.identity.theme === 'dark' ? 'selected' : ''}>Dark</option>
				</select>`)}
		</div>
	`;

	const socialsPanel = `
		<div class="panel">
			<h4>Socials</h4>
			${field('X / Twitter', `<input type="text" data-bind="identity.socials.twitter" value="${esc(state.identity.socials?.twitter || '')}" placeholder="https://x.com/yourhandle" />`)}
			${field('Telegram', `<input type="text" data-bind="identity.socials.telegram" value="${esc(state.identity.socials?.telegram || '')}" placeholder="https://t.me/yourgroup" />`)}
			${field('Discord', `<input type="text" data-bind="identity.socials.discord" value="${esc(state.identity.socials?.discord || '')}" placeholder="https://discord.gg/invite" />`)}
		</div>
	`;

	const copyPanel = `
		<div class="panel">
			<h4>Page copy</h4>
			${field('Headline', `<input type="text" data-bind="copy.headline" value="${esc(state.copy.headline)}" />`)}
			${field('Tagline', `<textarea data-bind="copy.tagline">${esc(state.copy.tagline)}</textarea>`)}
			${field('CTA button label', `<input type="text" data-bind="copy.cta" value="${esc(state.copy.cta)}" />`)}
		</div>
	`;

	let templatePanel = '';
	if (tpl.id === 'token-launchpad') {
		templatePanel = `
			<div class="panel">
				<h4>Token (CMS) ${state.token.mint ? `<span class="pill" style="background:rgba(34,197,94,0.16);color:#4ade80">live</span>` : ''}</h4>
				${field('Token name', `<input type="text" data-bind="token.name" value="${esc(state.token.name)}" placeholder="My Coin" />`)}
				${field('Ticker', `<input type="text" data-bind="token.ticker" value="${esc(state.token.ticker)}" placeholder="MOON" maxlength="10" />`)}
				${field('Initial supply', `<input type="number" data-bind="token.supply" value="${state.token.supply}" min="1" />`)}
				${field('Description', `<textarea data-bind="token.description" placeholder="Brief description shown on the launchpad page">${esc(state.token.description || '')}</textarea>`)}
				${field('Token image URL', `<input type="text" data-bind="token.imageUrl" value="${esc(state.token.imageUrl || '')}" placeholder="https://.../logo.png" />`, '512×512 recommended. Used as the on-page logo and Pump.fun metadata image.')}
				${field('Mint address (after launch)', `<input type="text" data-bind="token.mint" value="${esc(state.token.mint || '')}" placeholder="Auto-filled once minted on Pump.fun" />`, 'Paste the mint pubkey after you launch — links the page to the live token.')}
				${field('Launch fee (SOL)', `<input type="number" step="0.001" data-bind="monetize.price" value="${state.monetize.price}" />`, 'Charged to each visitor that mints. Routes via Pump.fun creator fee split.')}
			</div>
		`;
	} else if (tpl.id === 'paid-concierge') {
		templatePanel = `
			<div class="panel">
				<h4>Concierge</h4>
				${field('Default skill name', `<input type="text" data-bind="agentSkills.0.name" value="${esc(state.agentSkills[0]?.name || 'concierge')}" placeholder="concierge" />`)}
				${field('Price per call', `<input type="number" step="0.001" data-bind="monetize.price" value="${state.monetize.price}" />`, 'x402 charges visitors per question. Settled instantly to your wallet.')}
				${field('Chain', `
					<select data-bind="monetize.chain">
						<option value="base" ${state.monetize.chain === 'base' ? 'selected' : ''}>Base</option>
						<option value="polygon" ${state.monetize.chain === 'polygon' ? 'selected' : ''}>Polygon</option>
					</select>`)}
			</div>
		`;
	} else if (tpl.id === 'gated-showroom') {
		templatePanel = `
			<div class="panel">
				<h4>Gated scene</h4>
				${field('Scene URL (glTF / GLB)', `<input type="text" data-bind="scene.src" value="${esc(state.scene.src)}" placeholder="https://.../room.glb" />`)}
				${field('Unlock fee (USDC)', `<input type="number" step="0.001" data-bind="monetize.price" value="${state.monetize.price}" />`, 'One-time payment unlocks the scene for the visitor wallet for 24 h.')}
			</div>
		`;
	}

	const skillsPanel = `
		<div class="panel">
			<h4>
				Onchain agent skills
				<button class="btn tiny" data-action="add-skill">+ Add</button>
			</h4>
			${(state.agentSkills || []).length === 0
				? `<div class="help" style="color:#71717a;font-size:11px">No paid skills configured. Add one to charge visitors per call via x402 — each skill becomes its own pricing pill on your /p/ page.</div>`
				: state.agentSkills.map((s, i) => `
					<div class="skill-row" data-skill-idx="${i}">
						<input type="text" data-bind="agentSkills.${i}.name" value="${esc(s.name)}" placeholder="skill name" />
						<input type="number" step="0.001" data-bind="agentSkills.${i}.price" value="${s.price}" />
						<select data-bind="agentSkills.${i}.currency">
							<option value="USDC" ${s.currency === 'USDC' ? 'selected' : ''}>USDC</option>
							<option value="SOL" ${s.currency === 'SOL' ? 'selected' : ''}>SOL</option>
							<option value="ETH" ${s.currency === 'ETH' ? 'selected' : ''}>ETH</option>
						</select>
						<button type="button" class="skill-remove" data-action="remove-skill" data-skill-idx="${i}" title="Remove">×</button>
					</div>
				`).join('')}
		</div>
	`;

	const publishPanel = `
		<div class="panel">
			<h4>Publish</h4>
			<div data-publish-block>${publishStatusHTML(state)}</div>
		</div>
	`;
	const snippetsPanel = `
		<div class="panel">
			<h4>Embed snippet</h4>
			<div class="snippet">${esc(buildEmbedSnippet(state))}</div>
			<div class="snippet-actions">
				<button class="btn" data-action="copy-embed">Copy embed</button>
			</div>
		</div>
		<div class="panel">
			<h4>Agent skill manifest</h4>
			<div class="snippet">${esc(buildSkillManifest(state))}</div>
			<div class="snippet-actions">
				<button class="btn" data-action="copy-skill">Copy skill JSON</button>
			</div>
		</div>
	`;

	return identityPanel + socialsPanel + copyPanel + templatePanel + skillsPanel + publishPanel + snippetsPanel;
}

function publishStatusHTML(state) {
	if (!state.published) {
		return `<div class="publish-status">Set a slug + payout wallet, then hit Publish to mint your hosted page at ${AGENT_3D_HOST}/p/&lt;slug&gt;.</div>`;
	}
	if (state.published.error) {
		return `<div class="publish-status err">${esc(state.published.error)}</div>`;
	}
	const url = state.published.url || `${AGENT_3D_HOST}/p/${state.published.slug}`;
	return `
		<div class="publish-status ok">${state.isEditing ? 'Updated · ' : 'Live at '}${esc(url)}</div>
		<div class="share-url">
			<input type="text" readonly value="${esc(url)}" />
			<button class="btn" data-action="copy-share">Copy</button>
		</div>
	`;
}

function field(label, input, help) {
	return `
		<div class="field">
			<label>${esc(label)}</label>
			${input}
			${help ? `<div class="help">${esc(help)}</div>` : ''}
		</div>
	`;
}

function bindRailInputs(root, state, render) {
	root.querySelectorAll('[data-bind]').forEach((el) => {
		const path = el.dataset.bind.split('.');
		el.addEventListener('input', () => {
			let cur = state;
			for (let i = 0; i < path.length - 1; i++) {
				const key = path[i];
				// Numeric index → ensure array exists at the parent
				if (/^\d+$/.test(key)) {
					if (!Array.isArray(cur)) return;
					cur[key] = cur[key] || {};
					cur = cur[key];
				} else {
					cur[key] = cur[key] || (path[i + 1] && /^\d+$/.test(path[i + 1]) ? [] : {});
					cur = cur[key];
				}
			}
			let value = el.type === 'number' ? Number(el.value) : el.value;
			if (path[path.length - 1] === 'slug') value = slugify(value);
			cur[path[path.length - 1]] = value;
			// Brand color: keep both inputs in sync, hot-update preview without re-render.
			if (el.dataset.bind === 'identity.brand') {
				root.querySelectorAll('[data-bind="identity.brand"]').forEach((peer) => {
					if (peer !== el) peer.value = value;
				});
				const frame = root.querySelector('.stage-frame');
				if (frame) frame.style.setProperty('--brand', value);
				saveDraft(state);
				return;
			}
			render();
		});
	});
}
