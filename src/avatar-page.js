/**
 * Avatar studio page controller — /avatars/:id
 *
 * Renders an avatar with a 3D viewer, metadata, attachable skills + plugins,
 * a live LLM chat, embed snippets, and a related-avatars grid. Demo IDs
 * (avatar_demo_*) are resolved server-side via /api/avatars/[id].js so the
 * same code path serves both real and seeded avatars.
 */

import { openTalkMode } from './voice/talk-mode.js';
import { downloadAvatar } from './avatar-export.js';

const ATTACHED_KEY_PREFIX = 'avatar_attached_v1:';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

// ── Routing ───────────────────────────────────────────────────────────

// Avatar id: path-based in production (/avatars/:id) or `?id=` query param in
// dev (vite doesn't rewrite arbitrary paths to avatar-page.html).
const segments = location.pathname.split('/').filter(Boolean);
const queryId = new URLSearchParams(location.search).get('id');
const avatarId = (segments[0] === 'avatars' && segments[1]) || queryId || '';

// Embed mode: hide chrome (header, actionbar, related, footer) so the page
// looks clean inside an iframe.
const isEmbed = new URLSearchParams(location.search).get('embed') === '1';
if (isEmbed) {
	document.body.classList.add('av-embed');
	document.querySelectorAll('.site-header, .av-actionbar, .av-related, .h-footer-horizon')
		.forEach((el) => { el.style.display = 'none'; });
}

if (!avatarId) {
	$('av-shell').innerHTML = `<div class="av-error">No avatar specified.</div>`;
} else {
	init().catch((err) => {
		console.error('[avatar] init', err);
		$('av-shell').innerHTML = `<div class="av-error">${esc(err.message || 'Failed to load')}</div>`;
	});
}

// ── State ─────────────────────────────────────────────────────────────

let avatar = null;
let attachedSkills = new Set();
let attachedPlugins = new Set();
let chatHistory = [];
let selectedModelId = 'auto';

// Model choices surfaced in the chat dropdown. `auto` lets the server pick
// based on which keys are configured (Anthropic → OpenRouter → Groq → OpenAI).
const MODEL_OPTIONS = [
	{ id: 'auto', label: 'Auto', provider: null, model: null },
	{ id: 'anthropic:sonnet', label: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6' },
	{
		id: 'openrouter:llama-70b',
		label: 'Llama 3.3 70B (free)',
		provider: 'openrouter',
		model: 'meta-llama/llama-3.3-70b-instruct:free',
	},
	{
		id: 'openrouter:gpt-oss',
		label: 'GPT-OSS 120B (free)',
		provider: 'openrouter',
		model: 'openai/gpt-oss-120b:free',
	},
	{
		id: 'openrouter:hermes',
		label: 'Hermes 3 405B (free)',
		provider: 'openrouter',
		model: 'nousresearch/hermes-3-llama-3.1-405b:free',
	},
	{ id: 'groq:llama-70b', label: 'Groq Llama 3.3 70B', provider: 'groq', model: 'llama-3.3-70b-versatile' },
	{ id: 'openai:gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai', model: 'gpt-4o-mini' },
];
const MODEL_STORAGE_KEY = 'avatar_chat_model_v1';

// ── Init ──────────────────────────────────────────────────────────────

async function init() {
	avatar = await fetchAvatar(avatarId);
	if (!avatar.model_url && !avatar.url) throw new Error('This avatar has no GLB.');

	const glbUrl = avatar.model_url || avatar.url;

	// Persisted skill/plugin attachments (per-avatar, in localStorage)
	loadAttached();

	updateOg();
	renderShell(glbUrl);
	bindShareButtons();
	bindTabs();
	bindChat();
	bindOwnerActions();
	loadSkills();
	loadPlugins();
	loadRelated();
	loadUsedBy();
	measureModel(glbUrl);
}

// ── API ───────────────────────────────────────────────────────────────

async function fetchAvatar(id) {
	const r = await fetch(`/api/avatars/${encodeURIComponent(id)}`);
	if (!r.ok) {
		const j = await r.json().catch(() => ({}));
		throw new Error(j.error_description || `Avatar not found (${r.status})`);
	}
	return (await r.json()).avatar;
}

async function fetchRelated() {
	const url = new URL('/api/explore', location.origin);
	url.searchParams.set('source', 'avatar');
	url.searchParams.set('limit', '12');
	if (avatar.tags?.[0]) url.searchParams.set('q', avatar.tags[0]);
	const r = await fetch(url);
	if (!r.ok) return [];
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

function renderShell(glbUrl) {
	const tagsHtml = (avatar.tags || [])
		.map((t) => `<a class="av-tag" href="/marketplace?tag=${encodeURIComponent(t)}">${esc(t)}</a>`)
		.join('');
	const author = avatar.author || avatar.attribution;
	const byLine = author?.handle
		? author.profileUrl || author.url
			? `<p class="av-by">by <a href="${esc(author.profileUrl || author.url)}" target="_blank" rel="noopener">${esc(author.displayName || author.handle)}</a></p>`
			: `<p class="av-by">by ${esc(author.displayName || author.handle)}</p>`
		: avatar.owner_username
			? `<p class="av-by">by <a href="/u/${esc(avatar.owner_username)}">@${esc(avatar.owner_username)}</a></p>`
			: '';

	$('av-shell').innerHTML = `
		<div class="av-stage-col">
			<div class="av-stage" id="av-stage">
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
					ar
					ar-modes="webxr scene-viewer quick-look"
					ar-scale="auto"
				></model-viewer>
			</div>
			<div class="av-meta-strip" id="av-meta-strip">
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
					<span>Avatar · 3D Body</span>
					<a
						class="av-eyebrow-help"
						href="/docs/agents-vs-avatars"
						title="An avatar is the 3D body. Pair it with an agent to give that agent a presence."
						aria-label="What is an avatar?"
					>?</a>
				</div>
				<h1 class="av-name">${esc(avatar.name)}</h1>
				<div class="av-source-tag">${avatar.demo ? 'Curated · Public Domain' : 'Community avatar'}</div>
				${byLine}
				${tagsHtml ? `<div class="av-tags">${tagsHtml}</div>` : ''}
			</div>
			<div class="av-cta-talk-row">
				<button class="av-cta-talk" id="av-talk" type="button" aria-label="Talk to ${esc(avatar.name)}">
					<span class="av-cta-talk-dot" aria-hidden="true"></span>
					<span>Talk to ${esc(avatar.name)}</span>
				</button>
			</div>
			<div class="av-cta-row">
				<button class="av-cta" id="av-use">Start an agent</button>
				<a class="av-cta-sec" href="/brain" title="Build a persona and test with AI models">Brain</a>
				<a class="av-cta-sec" href="/studio?avatar=${encodeURIComponent(avatar.id || avatarId)}" title="Use this avatar in Widget Studio">Open in Studio</a>
				<button class="av-cta-sec" id="av-download" type="button">Download ▾</button>
			</div>
			<div class="av-ar-row">
				<a class="av-ar-btn" href="/avatars/${encodeURIComponent(avatar.id || avatarId)}/ar" id="av-ar-link">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
					View in AR
				</a>
			</div>
			${avatar.owner_id ? `
			<div class="av-owner-row" id="av-owner-row">
				<a class="av-owner-btn" href="/avatars/${encodeURIComponent(avatar.id || avatarId)}/edit">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
					Edit
				</a>
				<button class="av-owner-btn" id="av-deploy-onchain" type="button">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
					Deploy on-chain
				</button>
				<button class="av-owner-btn" id="av-launch-pumpfun" type="button">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
					Launch Pump.fun
				</button>
			</div>
			` : ''}
			<nav class="av-tabs" role="tablist">
				<button class="av-tab active" data-tab="overview" role="tab">Overview</button>
				<button class="av-tab" data-tab="chat" role="tab">Chat</button>
				<button class="av-tab" data-tab="skills" role="tab">Skills</button>
				<button class="av-tab" data-tab="plugins" role="tab">Plugins</button>
				<button class="av-tab" data-tab="embed" role="tab">Embed</button>
			</nav>
			<div class="av-panels">
				<div class="av-panel active" data-panel="overview" id="av-overview">
					${avatar.description ? `<p class="av-desc">${esc(avatar.description)}</p>` : '<p class="av-desc" style="color:var(--text-3)">No description provided.</p>'}
					<section class="av-used-by" id="av-used-by" hidden aria-labelledby="av-used-by-heading">
						<h3 class="av-used-by-heading" id="av-used-by-heading">Used by</h3>
						<div class="av-used-by-grid" id="av-used-by-grid"></div>
					</section>
					${renderAttribution()}
					${renderAttached()}
				</div>
				<div class="av-panel" data-panel="chat">
					<div class="av-chat">
						<div class="av-chat-modelbar">
							<label class="av-chat-modellabel" for="av-chat-model">Model</label>
							<select class="av-chat-model" id="av-chat-model">
								${MODEL_OPTIONS.map(
									(o) => `<option value="${o.id}">${esc(o.label)}</option>`,
								).join('')}
							</select>
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
				<div class="av-panel" data-panel="skills">
					<div class="av-list" id="av-skills-list">
						<div class="av-list-loading">Loading skills…</div>
					</div>
				</div>
				<div class="av-panel" data-panel="plugins">
					<div class="av-list" id="av-plugins-list">
						<div class="av-list-loading">Loading plugins…</div>
					</div>
				</div>
				<div class="av-panel" data-panel="embed">
					${renderEmbedPanel(glbUrl)}
				</div>
			</div>
		</div>
	`;

	const viewer = $('av-viewer');
	viewer?.addEventListener('load', () => {
		$('av-stage-loading')?.remove();
	});
	viewer?.addEventListener('error', () => {
		const ld = $('av-stage-loading');
		if (ld) ld.textContent = 'Failed to load 3D model.';
	});

	$('av-use')?.addEventListener('click', startAgentWithAvatar);
	$('av-talk')?.addEventListener('click', () => enterTalkMode());
	$('av-download')?.addEventListener('click', openDownloadMenu);
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
				console.error('[avatar] download failed', err);
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
	// The avatar studio page itself is iframe-friendly; embedders can drop the
	// page URL with `?embed=1` and we hide the chrome (handled below).
	const iframeSrc = `${fullUrl}?embed=1`;
	const webComponentSnippet = `<script type="module" src="https://three.ws/dist-lib/agent-3d.js"><\/script>
<agent-3d
  src="${glbUrl}"
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
	return `
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
	`;
}

// ── Tabs ──────────────────────────────────────────────────────────────

function bindTabs() {
	document.querySelectorAll('.av-tab').forEach((btn) => {
		btn.addEventListener('click', () => {
			document.querySelectorAll('.av-tab').forEach((b) => b.classList.remove('active'));
			btn.classList.add('active');
			const tab = btn.dataset.tab;
			document.querySelectorAll('.av-panel').forEach((p) => {
				p.classList.toggle('active', p.dataset.panel === tab);
			});
		});
	});

	// Embed copy buttons
	document.body.addEventListener('click', async (e) => {
		const btn = e.target.closest('.av-embed-copy');
		if (!btn) return;
		const which = btn.dataset.copy;
		const sourceMap = { wc: 'embed-wc', iframe: 'embed-iframe', link: 'embed-link' };
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
			console.error('[avatar] clipboard', err);
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
				console.error('[avatar] copy link', err);
			}
		});
	}
	if (twBtn && avatar) {
		const text = `Check out "${avatar.name}" — a 3D avatar on three.ws`;
		const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.href)}`;
		twBtn.href = url;
	}
}

// ── Owner actions (Edit / Deploy on-chain / Launch Pump.fun) ─────────

function bindOwnerActions() {
	$('av-deploy-onchain')?.addEventListener('click', openDeployOnchain);
	$('av-launch-pumpfun')?.addEventListener('click', openLaunchPumpFun);
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
		new RegisterUI(wrap, () => { wrap.remove(); }, { initial });
	} catch (err) {
		console.error('[avatar] deploy on-chain failed', err);
	} finally {
		btn.disabled = false;
		if (btn.lastChild) btn.lastChild.textContent = ' Deploy on-chain';
	}
}

async function openLaunchPumpFun() {
	const btn = $('av-launch-pumpfun');
	if (!btn || btn.disabled) return;
	btn.disabled = true;
	try {
		let user = null;
		try {
			const r = await fetch('/api/auth/me', { credentials: 'include' });
			if (r.ok) user = (await r.json()).user || null;
		} catch { /* best-effort */ }

		const backdrop = document.createElement('div');
		backdrop.className = 'av-pump-backdrop';

		const modal = document.createElement('div');
		modal.className = 'av-pump-modal';

		const header = document.createElement('div');
		header.className = 'av-pump-header';
		header.innerHTML = `
			<span class="av-pump-title">Launch on Pump.fun</span>
			<button class="av-pump-close" type="button" aria-label="Close">×</button>
		`;
		const inner = document.createElement('div');
		inner.className = 'av-pump-inner';

		modal.appendChild(header);
		modal.appendChild(inner);
		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);

		const closeModal = () => backdrop.remove();
		header.querySelector('.av-pump-close').addEventListener('click', closeModal);
		backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

		const launchPanelUrl = '/studio/launch-panel.js';
		const { mountLaunchPanel } = await import(/* @vite-ignore */ launchPanelUrl);
		mountLaunchPanel(inner, {
			getAvatar: () => ({ ...avatar, id: avatar.id || avatarId }),
			getUser: () => user,
			getPreviewViewer: () => null,
		});
	} catch (err) {
		console.error('[avatar] launch pump.fun failed', err);
	} finally {
		btn.disabled = false;
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
			avatar_id: avatar.id || avatarId,
		};
		const r = await fetch('/api/marketplace/agents', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(body),
		});
		if (r.status === 401) {
			location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
			return;
		}
		const j = await r.json();
		if (!r.ok) throw new Error(j.error_description || j.error || 'Failed to create agent');
		const newId = j?.data?.agent?.id;
		if (!newId) throw new Error('Server did not return new agent id');
		location.href = `/agent/${encodeURIComponent(newId)}/edit`;
	} catch (err) {
		console.error('[avatar] start agent', err);
		btn.textContent = original;
		btn.disabled = false;
		alert(err.message || 'Failed to start agent');
	}
}

// ── Skills panel ──────────────────────────────────────────────────────

async function loadSkills() {
	const list = $('av-skills-list');
	if (!list) return;
	const skills = await fetchSkills();
	if (!skills.length) {
		list.innerHTML = '<div class="av-list-empty">No skills available.</div>';
		return;
	}
	list.innerHTML = skills.map(renderSkillRow).join('');
	list.querySelectorAll('[data-skill]').forEach((btn) => {
		btn.addEventListener('click', () => toggleSkill(btn.dataset.skill));
	});
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
	const overview = $('av-overview');
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
	viewer.animationName = clips[idx];
	viewer.autoplay = true;
	if (typeof viewer.play === 'function') viewer.play({ repetitions: loop ? Infinity : 1 });
}

// ── Plugins panel ─────────────────────────────────────────────────────

async function loadPlugins() {
	const list = $('av-plugins-list');
	if (!list) return;
	const plugins = await fetchPlugins();
	if (!plugins.length) {
		list.innerHTML = '<div class="av-list-empty">No plugins published yet.</div>';
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
	const overview = $('av-overview');
	if (overview) {
		const existing = overview.querySelector('.av-attached');
		if (existing) existing.remove();
		const html = renderAttached();
		if (html) overview.insertAdjacentHTML('beforeend', html);
	}
}

// ── Attached storage ──────────────────────────────────────────────────

function attachedKey() {
	return ATTACHED_KEY_PREFIX + (avatar?.id || avatarId);
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

// ── Chat panel ────────────────────────────────────────────────────────

function bindChat() {
	const form = $('av-chat-form');
	const input = $('av-chat-input');
	const send = $('av-chat-send');
	const mic = $('av-chat-mic');
	if (!form || !input || !send) return;

	const modelSelect = $('av-chat-model');
	if (modelSelect) {
		try {
			const stored = localStorage.getItem(MODEL_STORAGE_KEY);
			if (stored && MODEL_OPTIONS.some((o) => o.id === stored)) selectedModelId = stored;
		} catch {}
		modelSelect.value = selectedModelId;
		modelSelect.addEventListener('change', () => {
			selectedModelId = modelSelect.value;
			try { localStorage.setItem(MODEL_STORAGE_KEY, selectedModelId); } catch {}
		});
	}

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
			catch (err) { console.warn('[avatar] STT start', err.message); }
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
function memoryKey() { return MEMORY_KEY_PREFIX + (avatar?.id || avatarId); }

function hydrateChatHistory() {
	if (!attachedSkills.has('memory')) return;
	try {
		const raw = localStorage.getItem(memoryKey());
		if (!raw) return;
		const stored = JSON.parse(raw);
		if (!Array.isArray(stored) || stored.length === 0) return;
		chatHistory = stored.slice(-40); // cap so we don't blow context
		const log = $('av-chat-log');
		if (!log) return;
		log.querySelector('.av-chat-empty')?.remove();
		// Re-render the conversation from the persisted history.
		const existing = log.querySelectorAll('.av-chat-msg');
		existing.forEach((n) => n.remove());
		for (const m of chatHistory) appendChatMessage(m.role, m.content);
	} catch (err) {
		console.warn('[avatar] memory hydrate failed', err.message);
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
		console.warn('[avatar] TTS playback failed', err.message);
	}
}

async function sendChatMessage(text) {
	const log = $('av-chat-log');
	const send = $('av-chat-send');
	if (!log) return;

	// Drop empty-state once we have any message
	const empty = log.querySelector('.av-chat-empty');
	if (empty) empty.remove();

	// Wave on the very first user message of the session, if the avatar has
	// a wave clip and the wave skill is attached.
	if (chatHistory.length === 0 && attachedSkills.has('animate-wave')) {
		playClipByHint(['wave', 'wavehello', 'hi']);
	}

	chatHistory.push({ role: 'user', content: text });
	appendChatMessage('user', text);

	const assistantNode = appendChatMessage('assistant', '');
	const cursor = document.createElement('span');
	cursor.className = 'av-chat-cursor';
	assistantNode.appendChild(cursor);

	send.disabled = true;
	let acc = '';
	try {
		const systemContext = buildSystemContext();
		const agentIdMaybe = avatar?.id || avatarId;
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
					log.scrollTop = log.scrollHeight;
				} else if (evt.type === 'error') {
					throw new Error(evt.message || evt.error || 'Stream error');
				}
			}
		}
		chatHistory.push({ role: 'assistant', content: acc });
		persistChatHistory();
		// Speak the assistant's full reply (TTS skill).
		if (acc) speakReply(acc);
	} catch (err) {
		assistantNode.textContent = acc || `⚠ ${err.message}`;
		console.error('[avatar] chat', err);
	} finally {
		cursor.remove();
		send.disabled = false;
	}
}

function appendChatMessage(role, text) {
	const log = $('av-chat-log');
	const node = document.createElement('div');
	node.className = `av-chat-msg ${role}`;
	node.textContent = text;
	log.appendChild(node);
	log.scrollTop = log.scrollHeight;
	return node;
}

function buildSystemContext() {
	const parts = [
		`You are voicing the avatar "${avatar.name}" on three.ws.`,
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

	const r = await fetch(`/api/avatars/${encodeURIComponent(avatarId)}/agents`);
	if (!r.ok) return;
	const { agents } = await r.json();
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
			return `<a class="av-used-by-card" href="${esc(a.url)}" title="${esc(a.name)}">
				${thumb}
				<div class="av-used-by-meta">
					<span class="av-used-by-name">${esc(a.name)}</span>
					${badge}
				</div>
			</a>`;
		})
		.join('');
}

// ── Related avatars ───────────────────────────────────────────────────

async function loadRelated() {
	const items = await fetchRelated();
	if (!items.length) return;
	const grid = $('av-related-grid');
	if (!grid) return;
	$('av-related').hidden = false;
	grid.innerHTML = items.map((a) => `
		<a class="av-related-card" href="/avatars/${encodeURIComponent(a.avatarId)}">
			<div class="av-related-thumb">
				${a.glbUrl ? `<model-viewer
					src="${esc(a.glbUrl)}"
					alt="${esc(a.name || 'Avatar')}"
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
				></model-viewer>` : ''}
			</div>
			<div class="av-related-info">
				<p class="av-related-name">${esc(a.name || 'Untitled')}</p>
				<p class="av-related-author">${esc(a.author?.displayName || a.author?.handle || 'Anonymous')}</p>
			</div>
		</a>
	`).join('');
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
		console.warn('[avatar] glb stats parse failed', err.message);
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
	document.title = `${avatar.name} — Avatar Studio · three.ws`;
	$('og-title')?.setAttribute('content', `${avatar.name} — Avatar Studio`);
	$('og-description')?.setAttribute('content', avatar.description || `A 3D avatar on three.ws`);
	$('og-url')?.setAttribute('content', location.href);
	$('tw-title')?.setAttribute('content', `${avatar.name} — Avatar Studio`);
	$('tw-description')?.setAttribute('content', avatar.description || `A 3D avatar on three.ws`);
	// Always point at /api/avatar/:id/og — that endpoint redirects to the real
	// thumbnail when one exists, falls back to a styled SVG card when it doesn't.
	// This way social cards never come up empty for demo avatars.
	const ogUrl = `${location.origin}/api/avatar/${encodeURIComponent(avatar.id || avatarId)}/og`;
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
