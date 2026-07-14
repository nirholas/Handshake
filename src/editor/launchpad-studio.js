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
import { log } from '../shared/log.js';

// ──────────────────────────────────────────────────────────────────────────
// Templates
// ──────────────────────────────────────────────────────────────────────────
const TEMPLATES = [
	{
		id: 'token-launchpad',
		label: 'Token Launchpad',
		tagline: 'White-label Pump.fun launcher with a 3D avatar host',
		hint: 'A 3D-hosted landing page for your coin. Launch it through the guided flow; once it is live, the page flips to a one-click Trade button. Creator fees route to your wallet.',
		monetize: { kind: 'pump-launch', defaultPrice: 0.02, currency: 'SOL', chain: 'solana' },
		defaultCta: 'Launch your coin',
		defaultTagline: 'Mint a Pump.fun coin in seconds — hosted by your own 3D agent.',
	},
	{
		id: 'paid-concierge',
		label: 'Paid Concierge',
		tagline: '3D avatar that answers questions for x402 USDC',
		hint: 'A hosted agent page that charges a per-question fee via x402. Replies stream from the configured agent skill.',
		monetize: { kind: 'x402-call', defaultPrice: 0.01, currency: 'USDC', chain: 'solana' },
		defaultCta: 'Ask the concierge',
		defaultTagline: 'Get an answer from the team in 5 seconds — paid in USDC.',
	},
	{
		id: 'gated-showroom',
		label: 'Gated 3D Showroom',
		tagline: 'Pay-to-enter glTF gallery with avatar greeter',
		hint: 'Visitors pay a small USDC fee to unlock a private 3D scene. Use for product reveals, premium models, or NFT preview rooms.',
		monetize: { kind: 'x402-unlock', defaultPrice: 0.05, currency: 'USDC', chain: 'solana' },
		defaultCta: 'Unlock the room',
		defaultTagline: 'Step inside a private 3D space — one-time USDC pass.',
	},
];

const DEFAULT_AVATAR_SRC = '/avatars/default.glb';
const AGENT_3D_VERSION = '1.5.2';
const AGENT_3D_HOST = 'https://three.ws';
const DRAFT_KEY = 'launchpadStudio:draft';
const SECRETS_KEY = 'launchpadStudio:secrets';   // { [slug]: ownerSecret }
const RECENT_KEY = 'launchpadStudio:recent';     // [{slug, template, headline, updatedAt}, ...]

// Single active beforeunload guard: remounting the studio (landing to studio
// SPA navigation and back) must not stack stale listeners with dead closures.
let activeBeforeUnload = null;

// Bundled starter avatars — real GLBs shipped in /public, so the gallery is
// never empty even before the public-avatars API responds. { src, name, thumb }.
const STARTER_AVATARS = [
	{ name: 'Default', src: '/avatars/default.glb', thumb: '/avatars/thumbs/default.png' },
	{ name: 'CZ', src: '/avatars/cz.glb', thumb: '/avatars/thumbs/cz.png' },
	{ name: 'Robot', src: '/animations/robotexpressive.glb', thumb: '/avatars/thumbs/robotexpressive.png' },
	{ name: 'Soldier', src: '/animations/soldier.glb', thumb: '/avatars/thumbs/soldier.png' },
	{ name: 'Michelle', src: '/avatars/michelle.glb', thumb: '' },
	{ name: 'Xbot', src: '/avatars/xbot.glb', thumb: '' },
	{ name: 'Mannequin', src: '/avatars/mannequin.glb', thumb: '' },
	{ name: 'Fox', src: '/avatars/fox.glb', thumb: '' },
];
const FALLBACK_THUMB = '/avatars/thumbs/default.png';

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
		background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0));
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
		background: rgba(255,255,255,0.04); color: var(--brand, #ffffff);
		font-size: 12px; font-weight: 500;
		border: 1px solid rgba(255,255,255,0.07);
	}
	.stage-frame.dark .skill-pill { background: rgba(255,255,255,0.08); }
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

	/* Avatar picker — My agents · Platform gallery · Custom URL */
	.lsp-avatar-picker { display: flex; flex-direction: column; gap: 16px; padding: 0 16px; }
	.lsp-section-label {
		font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
		text-transform: uppercase; color: #71717a; margin: 0 0 8px;
	}
	.lsp-strip {
		display: flex; gap: 8px; overflow-x: auto; padding: 2px 2px 6px;
		-webkit-overflow-scrolling: touch; scrollbar-width: thin; scrollbar-color: #262b32 transparent;
	}
	.lsp-strip::-webkit-scrollbar { height: 6px; }
	.lsp-strip::-webkit-scrollbar-thumb { background: #262b32; border-radius: 999px; }
	.lsp-avatar-card {
		flex: 0 0 auto; width: 64px; padding: 0; border: 0; background: transparent;
		cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px;
		font: inherit;
	}
	.lsp-avatar-card .thumb {
		width: 64px; height: 64px; border-radius: 10px; object-fit: cover; display: block;
		background: #181b21; border: 1px solid #262b32;
		transition: border 0.12s, box-shadow 0.12s;
	}
	.lsp-avatar-card:hover .thumb { border-color: #3a4150; }
	.lsp-avatar-card:focus-visible { outline: none; }
	.lsp-avatar-card:focus-visible .thumb { box-shadow: 0 0 0 2px #ffffff; }
	.lsp-avatar-card.is-selected .thumb { border-color: #ffffff; box-shadow: 0 0 0 4px rgba(255,255,255,0.2); }
	.lsp-avatar-card .cap {
		max-width: 64px; font-size: 10px; color: #a1a1aa; text-align: center;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.lsp-avatar-card.is-selected .cap { color: #f4f4f5; }
	.lsp-skel {
		flex: 0 0 auto; width: 64px; height: 64px; border-radius: 10px;
		background: linear-gradient(90deg, #181b21 25%, #20252c 50%, #181b21 75%);
		background-size: 200% 100%; animation: lsp-shimmer 1.2s ease-in-out infinite;
	}
	@keyframes lsp-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
	.lsp-more { flex: 0 0 auto; align-self: center; height: 64px; white-space: nowrap; }
	.lsp-custom { border-top: 1px solid #1c2128; padding-top: 12px; }
	.lsp-custom summary {
		cursor: pointer; list-style: none; font-size: 12px; color: #a1a1aa;
		padding: 2px 0; user-select: none;
	}
	.lsp-custom summary::-webkit-details-marker { display: none; }
	.lsp-custom summary:hover { color: #f4f4f5; }
	.lsp-custom[open] summary { color: #f4f4f5; margin-bottom: 8px; }
	.lsp-custom input {
		width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit; font-size: 12px;
		color: #f4f4f5; background: #181b21; border: 1px solid #262b32; border-radius: 7px; outline: none;
		font-family: ui-monospace, monospace;
	}
	.lsp-custom input:focus { border-color: #ffffff; }
	.lsp-hint { color: #71717a; font-size: 11px; margin-top: 4px; line-height: 1.4; }

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

	/* Primary button: near-white gradient background needs dark text (was
	   inheriting the light foreground color and rendering white-on-white). */
	.btn.primary, .btn.primary:hover { color: #0b0d10; }

	/* Template cards are real buttons (keyboard operable) */
	.template-card { width: calc(100% - 32px); text-align: left; font: inherit; color: inherit; }

	/* Visible keyboard focus everywhere */
	.btn:focus-visible, .template-card:focus-visible, .skill-remove:focus-visible,
	.dropdown-item .di-open:focus-visible, .stage-frame .cta:focus-visible {
		outline: 2px solid #f4f4f5; outline-offset: 2px;
	}
	.field input:focus-visible, .field select:focus-visible, .field textarea:focus-visible,
	.share-url input:focus-visible, .skill-row input:focus-visible, .skill-row select:focus-visible {
		border-color: #ffffff; box-shadow: 0 0 0 2px rgba(255,255,255,0.22);
	}

	/* Topbar save/publish state */
	.topbar .save-state { font-size: 12px; color: #71717a; white-space: nowrap; }
	.topbar .save-state.saved { color: #4ade80; }
	.topbar .save-state.dirty { color: #fbbf24; }
	.topbar .save-state.busy { color: #a1a1aa; }

	/* Inline field validation */
	.field input.invalid, .field textarea.invalid, .field select.invalid { border-color: #f87171; }
	.field-error { color: #f87171; font-size: 11px; margin-top: 4px; line-height: 1.4; }

	/* Notice banner (hydration 404, informational states) */
	.studio-notice { width: 100%; max-width: 980px; margin-bottom: 14px; padding: 10px 14px;
		border-radius: 10px; font-size: 13px; line-height: 1.5;
		display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
	.studio-notice.info { background: rgba(99,102,241,0.1); border: 1px solid rgba(99,102,241,0.3); color: #c7d2fe; }
	.studio-notice.err { background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.3); color: #fca5a5; }

	/* Hydration loading / error states */
	.stage-loading { display: flex; flex-direction: column; align-items: center; justify-content: center;
		gap: 12px; min-height: 50vh; padding: 24px; color: #a1a1aa; font-size: 14px; text-align: center; }
	.stage-loading .spin { width: 30px; height: 30px; border-radius: 50%;
		border: 3px solid #262b32; border-top-color: #f4f4f5; animation: lsp-spin 0.8s linear infinite; }
	@keyframes lsp-spin { to { transform: rotate(360deg); } }
	.stage-loading-title { font-size: 16px; font-weight: 600; color: #f4f4f5; }
	.stage-loading-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 4px; }
	.stage { position: relative; }
	.stage-veil { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center;
		justify-content: center; background: rgba(11,13,16,0.78); }
	.rail-skel { height: 36px; border-radius: 8px; margin-bottom: 10px;
		background: linear-gradient(90deg, #181b21 25%, #20252c 50%, #181b21 75%);
		background-size: 200% 100%; animation: lsp-shimmer 1.2s ease-in-out infinite; }

	/* Publish success card: the live URL is the payoff, make it unmissable */
	.publish-live { padding: 12px; border-radius: 10px;
		background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.25); }
	.publish-live-head { display: flex; align-items: center; gap: 7px;
		font-size: 12px; font-weight: 600; color: #4ade80; margin-bottom: 8px; }
	.publish-live-head .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; }
	.publish-live .share-url { margin-top: 0; }
	.publish-retry { margin-top: 8px; }

	/* Recent-launchpads dropdown rows are buttons, not divs */
	.dropdown-item { display: flex; align-items: flex-start; gap: 8px; justify-content: space-between; }
	.dropdown-item .di-open { flex: 1; min-width: 0; text-align: left; background: transparent;
		border: 0; padding: 0; color: inherit; font: inherit; cursor: pointer; }

	/* Responsive: the fixed 3-pane grid degrades to a stacked, document-scrolled
	   layout on small screens (320px must work with zero horizontal scroll). */
	@media (max-width: 1100px) {
		.studio-root { grid-template-columns: 260px 1fr 340px; }
	}
	@media (max-width: 880px) {
		.studio-root { position: static; display: block; min-height: 100vh; }
		.topbar { position: sticky; top: 0; z-index: 40; height: auto; min-height: 56px;
			padding: 10px 12px; flex-wrap: wrap; row-gap: 8px; }
		.topbar .actions { flex-wrap: wrap; row-gap: 8px; }
		.sidebar, .rail { border-right: 0; border-left: 0; border-bottom: 1px solid #1c2128; overflow: visible; }
		.stage { padding: 20px 12px; border-bottom: 1px solid #1c2128; }
		.stage-frame { min-height: 0; }
		.stage-frame .hero { grid-template-columns: 1fr; padding: 28px 20px 20px; gap: 24px; }
		.stage-frame .avatar-stage { min-height: 280px; }
		.stage-frame header { padding: 16px 20px; }
		.stage-frame .token-strip { padding: 14px 20px; }
		.stage-frame .skills-row { padding: 12px 20px 20px; }
		.stage-frame footer { padding: 14px 20px; }
	}
	@media (pointer: coarse) {
		.btn { min-height: 44px; }
		.field input, .field select { min-height: 44px; }
		.skill-row { grid-template-columns: 1fr 84px 76px 44px; }
		.skill-row .skill-remove { width: 44px; height: 44px; }
	}

	@media (prefers-reduced-motion: reduce) {
		.studio-root *, .studio-root, .stage-loading *, .rail-skel {
			animation: none !important; transition: none !important;
		}
	}
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
		<div class="studio-notice" data-notice hidden role="status"></div>
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
					<button class="cta" type="button" data-preview-cta aria-label="Preview of your call-to-action button"></button>
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
// Caller's own three.ws avatars (one per agent identity). Requires a session
// cookie — anonymous visitors get 401, which we map to null so the "My agents"
// section is hidden rather than erroring. Returns [{ src, name, thumb }].
async function fetchMyAgentAvatars() {
	try {
		const r = await fetch('/api/agents?owner=me&limit=20', { credentials: 'include' });
		if (!r.ok) return null; // 401 (signed out) or transient — hide the section
		const data = await r.json();
		const list = Array.isArray(data?.agents) ? data.agents : [];
		return list
			.map((a) => ({
				src: a.avatar_model_url || a.meta?.avatar?.url || a.avatar_url || '',
				thumb: a.avatar_thumbnail_url || a.meta?.avatar?.thumbnail_url || '',
				name: a.name || 'Agent',
			}))
			.filter((a) => a.src);
	} catch {
		return null;
	}
}

// One page of the public avatar gallery (newest first, cursor-paginated).
// Returns { items: [{ src, name, thumb }], nextCursor }.
async function fetchPublicAvatars(cursor, limit = 12) {
	try {
		const u = new URL('/api/avatars/public', location.origin);
		u.searchParams.set('limit', String(limit));
		if (cursor) u.searchParams.set('cursor', cursor);
		const r = await fetch(u, { credentials: 'include' });
		if (!r.ok) return { items: [], nextCursor: null };
		const data = await r.json();
		const items = (Array.isArray(data?.avatars) ? data.avatars : [])
			.map((a) => ({
				src: a.model_url || a.glb_url || '',
				thumb: a.thumbnail_url || '',
				name: a.name || 'Avatar',
			}))
			.filter((a) => a.src);
		return { items, nextCursor: data?.next_cursor || null };
	} catch {
		return { items: [], nextCursor: null };
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

	// Dirty tracking. "Dirty" means edits not yet published. Drafts auto-save to
	// localStorage on every render, so a never-published draft survives leaving
	// the page; edits to an already-published page are clobbered by the next
	// ?slug= re-hydration, so only those get the beforeunload warning.
	let dirty = false;
	let publishing = false;
	let publishError = null;
	const markDirty = () => { dirty = true; updateSaveState(); };
	function updateSaveState() {
		const el = root.querySelector('[data-save-state]');
		if (!el) return;
		if (publishing) { el.textContent = 'Publishing…'; el.className = 'save-state busy'; return; }
		if (dirty && state.isEditing) { el.textContent = 'Unpublished changes'; el.className = 'save-state dirty'; return; }
		if (dirty) { el.textContent = 'Draft saved'; el.className = 'save-state saved'; return; }
		el.textContent = '';
		el.className = 'save-state';
	}
	if (activeBeforeUnload) window.removeEventListener('beforeunload', activeBeforeUnload);
	activeBeforeUnload = (e) => {
		if (!dirty || !state.isEditing) return;
		e.preventDefault();
		e.returnValue = '';
	};
	window.addEventListener('beforeunload', activeBeforeUnload);

	root.innerHTML = `
		<div class="studio-root">
			<div class="topbar">
				<div class="brand">
					<span class="dot"></span>
					<span>Launchpad Studio</span>
					<span class="pill" data-mode-pill>Template-driven</span>
				</div>
				<div class="actions">
					<span class="save-state" data-save-state role="status" aria-live="polite"></span>
					<a class="btn ghost" href="/launches" title="Public feed of every coin launched by a three.ws agent">See all launched coins →</a>
					<a class="btn ghost" href="/embed" title="The original place-and-scale embed editor">Open classic editor</a>
					<button class="btn" data-action="open-recent" aria-haspopup="true" aria-expanded="false">My launchpads ▾</button>
					<button class="btn" data-action="new-draft" title="Start a new draft (current draft cleared)">New</button>
					<button class="btn primary" data-action="publish">Publish</button>
				</div>
			</div>
			<aside class="sidebar">
				<h3>Templates</h3>
				<div data-templates></div>
				<h3 style="margin-top: 18px">Avatar</h3>
				<div class="lsp-avatar-picker" data-avatar-picker></div>
			</aside>
			<main class="stage" data-stage></main>
			<aside class="rail" data-rail></aside>
		</div>
	`;

	// Templates list (real buttons: keyboard operable, aria-pressed reflects choice)
	const tplWrap = $('[data-templates]', root);
	tplWrap.innerHTML = TEMPLATES.map((t) => `
		<button type="button" class="template-card ${t.id === state.template ? 'active' : ''}" data-template-id="${t.id}" aria-pressed="${t.id === state.template}">
			<div class="label">${esc(t.label)}</div>
			<div class="tagline">${esc(t.tagline)}</div>
			<div class="hint">${esc(t.hint)}</div>
		</button>
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
		markDirty();
		render();
	});

	// Avatar picker — three sections: My agents · Platform gallery · Custom URL.
	// Built once, then refreshed in place as the two data sources resolve. The
	// live <agent-3d> preview is driven by render() (it swaps src on the
	// persistent element), so selecting a card never re-mounts the viewer.
	const pickerEl = $('[data-avatar-picker]', root);
	let agentsLoading = true;
	let galleryLoading = true;
	let myAgents = [];
	let galleryItems = [];
	let galleryCursor = null;
	let galleryDone = false;
	let galleryLoadingMore = false;
	let customExpanded = false;
	const seenSrc = new Set(STARTER_AVATARS.map((a) => a.src));

	const isCustomUrl = (src) => Boolean(src) && !seenSrc.has(src);

	function avatarCardHTML(item) {
		const selected = item.src === state.avatar.src;
		const thumb = item.thumb || FALLBACK_THUMB;
		return `
			<button class="lsp-avatar-card${selected ? ' is-selected' : ''}" type="button"
				data-avatar-src="${esc(item.src)}" data-avatar-name="${esc(item.name)}"
				aria-pressed="${selected}" aria-label="Use ${esc(item.name)} avatar" title="${esc(item.name)}">
				<img class="thumb" loading="lazy" alt="" src="${esc(thumb)}" />
				<span class="cap">${esc(item.name)}</span>
			</button>`;
	}
	const section = (label, inner) =>
		`<div class="lsp-section"><div class="lsp-section-label">${esc(label)}</div><div class="lsp-strip">${inner}</div></div>`;
	const skeletonStrip = () => Array.from({ length: 5 }).map(() => '<div class="lsp-skel"></div>').join('');

	function renderPicker() {
		let html = '';
		// Section 1 — My agents (only when signed in and at least one has an avatar)
		if (agentsLoading) {
			html += section('My agents', skeletonStrip());
		} else if (myAgents.length) {
			html += section('My agents', myAgents.map(avatarCardHTML).join(''));
		}
		// Section 2 — Platform gallery (starter avatars + public gallery, paginated)
		if (galleryLoading) {
			html += section('Platform gallery', skeletonStrip());
		} else {
			const cards = [...STARTER_AVATARS, ...galleryItems].map(avatarCardHTML).join('');
			const more = galleryDone
				? ''
				: `<button class="btn tiny lsp-more" type="button" data-action="gallery-more"${galleryLoadingMore ? ' disabled' : ''}>${galleryLoadingMore ? 'Loading…' : 'Show more'}</button>`;
			html += section('Platform gallery', cards + more);
		}
		// Section 3 — Custom URL (collapsed; power-user fallback)
		const open = customExpanded || isCustomUrl(state.avatar.src);
		html += `
			<details class="lsp-custom"${open ? ' open' : ''}>
				<summary>Or enter a URL →</summary>
				<div class="lsp-custom-body">
					<input type="url" data-avatar-url spellcheck="false" placeholder="https://.../avatar.glb"
						aria-label="Custom avatar model URL"
						value="${isCustomUrl(state.avatar.src) ? esc(state.avatar.src) : ''}" />
					<div class="lsp-hint">Direct link to a hosted .glb or .gltf model.</div>
				</div>
			</details>`;
		pickerEl.innerHTML = html;
	}

	// Lightweight highlight refresh — called from render() so card selection
	// stays in sync without rebuilding (and losing scroll position / focus).
	function syncPickerSelection() {
		pickerEl.querySelectorAll('[data-avatar-src]').forEach((el) => {
			const selected = el.dataset.avatarSrc === state.avatar.src;
			el.classList.toggle('is-selected', selected);
			el.setAttribute('aria-pressed', String(selected));
		});
	}

	async function loadMoreGallery() {
		if (galleryLoadingMore || galleryDone) return;
		galleryLoadingMore = true;
		renderPicker();
		const { items, nextCursor } = await fetchPublicAvatars(galleryCursor);
		const fresh = items.filter((a) => {
			if (seenSrc.has(a.src)) return false;
			seenSrc.add(a.src);
			return true;
		});
		galleryItems = galleryItems.concat(fresh);
		galleryCursor = nextCursor;
		galleryDone = !nextCursor;
		galleryLoadingMore = false;
		renderPicker();
	}

	renderPicker(); // skeletons first

	Promise.allSettled([fetchMyAgentAvatars(), fetchPublicAvatars(null)]).then(([agentsRes, galRes]) => {
		const agents = agentsRes.status === 'fulfilled' ? agentsRes.value : null;
		myAgents = Array.isArray(agents) ? agents : [];
		myAgents.forEach((a) => seenSrc.add(a.src)); // don't repeat an agent's avatar in the gallery
		agentsLoading = false;

		const gal = galRes.status === 'fulfilled' ? galRes.value : { items: [], nextCursor: null };
		galleryItems = gal.items.filter((a) => {
			if (seenSrc.has(a.src)) return false;
			seenSrc.add(a.src);
			return true;
		});
		galleryCursor = gal.nextCursor;
		galleryDone = !gal.nextCursor;
		galleryLoading = false;
		renderPicker();
	});

	pickerEl.addEventListener('click', (e) => {
		if (e.target.closest('[data-action="gallery-more"]')) {
			e.preventDefault();
			loadMoreGallery();
			return;
		}
		const card = e.target.closest('[data-avatar-src]');
		if (!card) return;
		state.avatar = { src: card.dataset.avatarSrc, name: card.dataset.avatarName || 'Avatar' };
		markDirty();
		render();
	});
	pickerEl.addEventListener('input', (e) => {
		const inp = e.target.closest('[data-avatar-url]');
		if (!inp) return;
		const url = inp.value.trim();
		state.avatar = url ? { src: url, name: 'Custom URL' } : { src: DEFAULT_AVATAR_SRC, name: 'Default' };
		markDirty();
		render();
	});
	// Remember a manual expand so a gallery "Show more" rebuild doesn't collapse it.
	pickerEl.addEventListener('toggle', (e) => {
		const d = e.target.closest('.lsp-custom');
		if (d) customExpanded = d.open;
	}, true);
	// Broken thumbnails (404, an agent's private avatar, a dead custom URL) fall
	// back to the generic avatar icon. Delegated on the capture phase because the
	// `error` event doesn't bubble; the data flag prevents a fallback loop.
	pickerEl.addEventListener('error', (e) => {
		const img = e.target;
		if (img.tagName !== 'IMG' || !img.classList.contains('thumb') || img.dataset.fallback) return;
		img.dataset.fallback = '1';
		img.src = FALLBACK_THUMB;
	}, true);

	// Topbar + global actions (delegated)
	let recentDropdown = null;
	let recentBtn = null;
	root.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && recentDropdown) {
			closeRecent();
			recentBtn?.focus();
		}
	});
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
			dirty = false;
			publishError = null;
			history.replaceState(null, '', '/launchpad');
			render({ force: true });
			return;
		}
		if (action === 'retry-hydrate') {
			const slug = e.target.closest('[data-slug]')?.dataset.slug;
			if (slug) hydrateFromSlug(slug);
			return;
		}
		if (action === 'hydrate-fresh') {
			const slug = e.target.closest('[data-slug]')?.dataset.slug || '';
			Object.assign(state, defaultStateFor(state.template));
			state.identity.slug = slug;
			dirty = false;
			publishError = null;
			render({ force: true });
			return;
		}
		if (action === 'dismiss-notice') {
			const n = root.querySelector('[data-notice]');
			if (n) n.hidden = true;
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
			// Inline validation before the network round-trip: mark the offending
			// fields, focus the first one, and surface the reason in the publish panel.
			const errors = validateForPublish(state);
			if (errors.length) {
				publishError = errors[0].message;
				const pub = root.querySelector('[data-publish-block]');
				if (pub) pub.innerHTML = publishStatusHTML(state, publishError);
				applyFieldErrors(root, errors);
				return;
			}
			publishing = true;
			updateSaveState();
			btn.disabled = true;
			btn.setAttribute('aria-busy', 'true');
			const orig = btn.textContent;
			btn.textContent = 'Publishing…';
			try {
				const result = await publishLaunchpad(state);
				state.published = {
					slug: result.slug,
					url: result.url || `${AGENT_3D_HOST}/p/${result.slug}`,
					publishedAt: result.publishedAt,
				};
				publishError = null;
				dirty = false;
				state.isEditing = true;
				history.replaceState(null, '', `/launchpad?slug=${encodeURIComponent(result.slug)}`);
			} catch (err) {
				publishError = err.message || String(err);
			} finally {
				publishing = false;
				btn.disabled = false;
				btn.removeAttribute('aria-busy');
				btn.textContent = orig;
				render();
				const pub = root.querySelector('[data-publish-block]');
				if (!publishError) {
					// Success: put the live URL front and center. Scroll it into
					// view and pre-select it for an instant copy.
					const share = pub?.querySelector('.share-url input');
					share?.closest('.panel')?.scrollIntoView({ block: 'nearest' });
					share?.focus();
					share?.select();
				} else {
					pub?.scrollIntoView({ block: 'nearest' });
				}
			}
			return;
		}
		if (action === 'add-skill') {
			state.agentSkills.push({ name: '', price: 0.001, currency: 'USDC', chain: 'solana', description: '' });
			markDirty();
			render();
			return;
		}
		if (action === 'remove-skill') {
			const idx = Number(e.target.closest('[data-skill-idx]')?.dataset.skillIdx);
			if (Number.isFinite(idx)) {
				state.agentSkills.splice(idx, 1);
				markDirty();
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
		recentBtn = button;
		button.setAttribute('aria-expanded', 'true');
		recentDropdown = document.createElement('div');
		recentDropdown.className = 'dropdown';
		button.parentElement.appendChild(recentDropdown);
		renderRecentDropdown();
	}
	function closeRecent() {
		if (recentDropdown?.parentElement) recentDropdown.parentElement.removeChild(recentDropdown);
		recentDropdown = null;
		recentBtn?.setAttribute('aria-expanded', 'false');
	}
	function renderRecentDropdown() {
		if (!recentDropdown) return;
		const list = recents.all();
		if (!list.length) {
			recentDropdown.innerHTML = `<div class="dropdown-empty">No published launchpads on this browser yet. Hit Publish to start the list.</div>`;
			return;
		}
		recentDropdown.innerHTML = list.map((e) => `
			<div class="dropdown-item">
				<button type="button" class="di-open" data-action="load-recent" data-slug="${esc(e.slug)}">
					<div class="di-title">${esc(e.headline || e.slug)}</div>
					<div class="di-meta">/${esc(e.slug)} · ${esc(e.template)} · updated ${esc(new Date(e.updatedAt).toLocaleString())}</div>
				</button>
				<button type="button" class="btn tiny ghost" data-action="forget-recent" data-slug="${esc(e.slug)}" title="Remove from this list (does not unpublish)" aria-label="Remove ${esc(e.slug)} from this list">×</button>
			</div>
		`).join('');
	}

	// Hydration loading state, shown while /api/launchpad/get resolves so a
	// ?slug= visit never opens on a blank stage or a flash of default content.
	// When the studio is already on screen (loading a recent launchpad) the
	// stage keeps its DOM and gets a veil instead: wiping it would disconnect
	// the live <agent-3d> element mid-load and can crash the viewer.
	function hydrateStatusHTML(inner, role) {
		return `
			<div class="stage-loading" role="${role}"${role === 'status' ? ' aria-live="polite"' : ''}>
				${inner}
			</div>`;
	}
	function renderHydrating(slug) {
		const stage = $('[data-stage]', root);
		const inner = `
			<div class="spin" aria-hidden="true"></div>
			<div>Loading /p/${esc(slug)}…</div>`;
		if (stageMounted) {
			ensureStageVeil(stage).innerHTML = hydrateStatusHTML(inner, 'status');
		} else {
			stage.innerHTML = hydrateStatusHTML(inner, 'status');
		}
		$('[data-rail]', root).innerHTML = `
			<div class="panel" aria-hidden="true">${'<div class="rail-skel"></div>'.repeat(6)}</div>`;
		lastTemplate = null; // rail was wiped, force a rebuild on the next render
		const pill = root.querySelector('[data-mode-pill]');
		pill.textContent = 'Loading…';
		pill.classList.remove('editing');
	}

	// Hydration failure: say what happened and offer a way forward instead of
	// silently dropping the visitor into an unrelated blank draft.
	function renderHydrateError(slug, err) {
		const stage = $('[data-stage]', root);
		const inner = `
			<div class="stage-loading-title">Couldn't load /p/${esc(slug)}</div>
			<div>${esc(err.message || 'Network error while fetching the saved page.')}</div>
			<div class="stage-loading-actions">
				<button type="button" class="btn primary" data-action="retry-hydrate" data-slug="${esc(slug)}">Retry</button>
				<button type="button" class="btn" data-action="hydrate-fresh" data-slug="${esc(slug)}">Start a fresh draft</button>
			</div>`;
		if (stageMounted) {
			ensureStageVeil(stage).innerHTML = hydrateStatusHTML(inner, 'alert');
		} else {
			stage.innerHTML = hydrateStatusHTML(inner, 'alert');
		}
	}

	function ensureStageVeil(stage) {
		let veil = stage.querySelector('[data-hydrate-veil]');
		if (!veil) {
			veil = document.createElement('div');
			veil.className = 'stage-veil';
			veil.setAttribute('data-hydrate-veil', '');
			stage.appendChild(veil);
		}
		return veil;
	}

	function showNotice(kind, html) {
		const n = root.querySelector('[data-notice]');
		if (!n) return;
		n.className = `studio-notice ${kind}`;
		n.innerHTML = `
			<div class="notice-body">${html}</div>
			<button type="button" class="btn tiny ghost" data-action="dismiss-notice" aria-label="Dismiss notice">×</button>`;
		n.hidden = false;
	}

	// Edit-mode hydration: ?slug=foo or options.slug
	async function hydrateFromSlug(slug) {
		renderHydrating(slug);
		try {
			const payload = await fetchLaunchpad(slug);
			if (!payload) {
				// No row yet — pre-fill the slug into a fresh draft so the user
				// can publish a new page at that URL, and say so.
				state.identity.slug = slug;
				state.isEditing = false;
				dirty = false;
				render({ force: true });
				showNotice('info', `Nothing is published at <strong>/p/${esc(slug)}</strong> yet. Fill in the page and hit Publish to claim that URL.`);
				return;
			}
			Object.assign(state, stateFromPayload(payload));
			dirty = false;
			publishError = null;
			history.replaceState(null, '', `/launchpad?slug=${encodeURIComponent(slug)}`);
			render({ force: true });
		} catch (err) {
			log.warn('[launchpad-studio] hydrate failed:', err.message);
			renderHydrateError(slug, err);
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
		stage.querySelector('[data-hydrate-veil]')?.remove();
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
			$('[data-rail]', root).innerHTML = buildRailHTML(state, publishError);
			bindRailInputs(root, state, render, markDirty);
			lastTemplate = state.template;
			lastSkillCount = skillCount;
			lastEditing = state.isEditing;
		} else {
			// Lightweight refresh: only the publish-status block + share URL.
			const pub = root.querySelector('[data-publish-block]');
			if (pub) pub.innerHTML = publishStatusHTML(state, publishError);
		}
	}

	function syncTopbar() {
		const pill = root.querySelector('[data-mode-pill]');
		pill.textContent = state.isEditing ? 'Editing' : 'New draft';
		pill.classList.toggle('editing', !!state.isEditing);
		root.querySelectorAll('[data-template-id]').forEach((el) => {
			const active = el.dataset.templateId === state.template;
			el.classList.toggle('active', active);
			el.setAttribute('aria-pressed', String(active));
		});
		syncPickerSelection();
		updateSaveState();
	}

	function render({ force = false } = {}) {
		saveDraft(state);
		renderStage();
		renderRail(force);
		syncTopbar();
	}

	// Initial render. hydrateFromSlug owns its own loading / error / success
	// rendering; a trailing render() here would paint default state over the
	// hydration-failure screen.
	if (options.slug) {
		hydrateFromSlug(slugify(options.slug));
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
function buildRailHTML(state, publishError = null) {
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
				${field('Mint address (after launch)', `<input type="text" data-bind="token.mint" value="${esc(state.token.mint || '')}" placeholder="Auto-filled once minted on Pump.fun" />`, 'Paste the mint pubkey after you launch — the page flips from "Launch" to a live "Trade" button.')}
				${field('Initial buy (SOL)', `<input type="number" step="0.001" min="0" data-bind="monetize.price" value="${state.monetize.price}" />`, 'Optional dev buy seeded into the launch flow when you mint from this page. Set 0 to skip. Creator fees from trades route to your payout wallet automatically.')}
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
						<option value="solana" ${state.monetize.chain === 'solana' ? 'selected' : ''}>Solana</option>
					</select>`, 'x402 settles the per-call fee in USDC on the chosen chain.')}
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
						<input type="text" data-bind="agentSkills.${i}.name" value="${esc(s.name)}" placeholder="skill name" aria-label="Skill ${i + 1} name" />
						<input type="number" step="0.001" data-bind="agentSkills.${i}.price" value="${s.price}" aria-label="Skill ${i + 1} price" />
						<select data-bind="agentSkills.${i}.currency" aria-label="Skill ${i + 1} currency">
							<option value="USDC" ${s.currency === 'USDC' ? 'selected' : ''}>USDC</option>
							<option value="SOL" ${s.currency === 'SOL' ? 'selected' : ''}>SOL</option>
							<option value="ETH" ${s.currency === 'ETH' ? 'selected' : ''}>ETH</option>
						</select>
						<button type="button" class="skill-remove" data-action="remove-skill" data-skill-idx="${i}" title="Remove" aria-label="Remove skill ${i + 1}">×</button>
					</div>
				`).join('')}
		</div>
	`;

	const publishPanel = `
		<div class="panel">
			<h4>Publish</h4>
			<div data-publish-block aria-live="polite">${publishStatusHTML(state, publishError)}</div>
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

function publishStatusHTML(state, publishError = null) {
	// A publish failure must not erase the last-known live URL, so the error
	// travels separately from state.published (state.published.error is only
	// read here for drafts persisted by older builds).
	const error = publishError || state.published?.error || null;
	const live = state.published && !state.published.error ? state.published : null;
	let html = '';
	if (error) {
		html += `
			<div class="publish-status err" role="alert">${esc(error)}</div>
			<div class="publish-retry"><button type="button" class="btn" data-action="publish">Retry publish</button></div>
		`;
	}
	if (live) {
		const url = live.url || `${AGENT_3D_HOST}/p/${live.slug}`;
		html += `
			<div class="publish-live">
				<div class="publish-live-head"><span class="live-dot" aria-hidden="true"></span>${state.isEditing ? 'Live · updated' : 'Live'}</div>
				<div class="share-url">
					<input type="text" readonly value="${esc(url)}" aria-label="Live page URL" />
					<button type="button" class="btn" data-action="copy-share">Copy</button>
					<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open</a>
				</div>
			</div>
		`;
	} else if (!error) {
		html = `<div class="publish-status">Set a slug + payout wallet, then hit Publish to mint your hosted page at ${AGENT_3D_HOST}/p/&lt;slug&gt;.</div>`;
	}
	return html;
}

// Pre-publish validation. Returns [{ bind, message }] keyed by data-bind path.
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
function validateForPublish(state) {
	const errors = [];
	if (!slugify(state.identity.slug)) {
		errors.push({ bind: 'identity.slug', message: 'Choose a URL slug. It becomes your page address.' });
	}
	const wallet = String(state.identity.wallet || '').trim();
	if (!wallet) {
		errors.push({ bind: 'identity.wallet', message: 'Add your payout wallet address.' });
	} else if (state.monetize.chain === 'solana' && !SOL_ADDR_RE.test(wallet)) {
		errors.push({ bind: 'identity.wallet', message: 'That does not look like a Solana address (base58, 32 to 44 characters).' });
	} else if (state.monetize.chain === 'base' && !EVM_ADDR_RE.test(wallet)) {
		errors.push({ bind: 'identity.wallet', message: 'That does not look like an EVM address (0x followed by 40 hex characters).' });
	}
	return errors;
}

// Mark invalid fields inline and move focus to the first one.
function applyFieldErrors(root, errors) {
	root.querySelectorAll('.field-error').forEach((n) => n.remove());
	root.querySelectorAll('[data-bind].invalid').forEach((n) => {
		n.classList.remove('invalid');
		n.removeAttribute('aria-invalid');
	});
	let first = null;
	for (const { bind, message } of errors) {
		const input = root.querySelector(`[data-bind="${bind}"]:not([type=color])`);
		if (!input) continue;
		input.classList.add('invalid');
		input.setAttribute('aria-invalid', 'true');
		const holder = input.closest('.field') || input.parentElement;
		const msg = document.createElement('div');
		msg.className = 'field-error';
		msg.textContent = message;
		holder.appendChild(msg);
		if (!first) first = input;
	}
	if (first) {
		first.scrollIntoView({ block: 'center' });
		first.focus({ preventScroll: true });
	}
}

// Each field gets a generated id wired to its <label> so screen readers and
// label-clicks work. The id is injected into the first form control in the
// markup string (color pickers have two inputs; the swatch gets the label).
let fieldSeq = 0;
function field(label, input, help) {
	const id = `lsf-${++fieldSeq}`;
	const wired = input.replace(/<(input|select|textarea)(?![^>]*\bid=)/, `<$1 id="${id}"`);
	return `
		<div class="field">
			<label for="${id}">${esc(label)}</label>
			${wired}
			${help ? `<div class="help">${esc(help)}</div>` : ''}
		</div>
	`;
}

function bindRailInputs(root, state, render, markDirty) {
	root.querySelectorAll('[data-bind]').forEach((el) => {
		const path = el.dataset.bind.split('.');
		el.addEventListener('input', () => {
			// Typing clears this field's inline validation error immediately.
			if (el.classList.contains('invalid')) {
				el.classList.remove('invalid');
				el.removeAttribute('aria-invalid');
				el.closest('.field')?.querySelector('.field-error')?.remove();
			}
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
			let value = el.value;
			if (el.type === 'number') {
				// An emptied or mid-edit number field must not persist NaN; it
				// would render as the literal string "NaN" on the next rebuild.
				const n = Number(el.value);
				value = el.value === '' || Number.isNaN(n) ? '' : n;
			}
			if (path[path.length - 1] === 'slug') value = slugify(value);
			cur[path[path.length - 1]] = value;
			markDirty();
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
