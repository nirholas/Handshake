/**
 * Interactive "try it" actions for the /create-review feature grid.
 *
 * Each of the six capability tiles on /create-review opens a real preview of
 * that capability — not a marketing modal. Voice spins up the actual talk
 * overlay against the staged GLB; the others render concrete, copy-able
 * examples (embed snippet, USDC pricing, Solana wallet shape, reputation
 * card) so the user sees what they're signing up for *before* the auth wall.
 *
 * Wiring lives in create-review.js. This module only owns: feature-modal DOM,
 * emote-strip behaviour, and the talk-overlay invocation.
 */

import { openTalkMode } from './voice/talk-mode.js';
import { downloadAvatar } from './avatar-export.js';

// ── Feature-preview modal ────────────────────────────────────────────────────

let activeModal = null;
let escHandler = null;

/** Open a feature-preview modal. Body may be an HTMLElement or HTML string. */
export function openFeatureModal({ icon, title, lede, body, actions }) {
	closeFeatureModal();

	const backdrop = document.createElement('div');
	backdrop.className = 'fm-backdrop';
	backdrop.setAttribute('role', 'dialog');
	backdrop.setAttribute('aria-modal', 'true');
	backdrop.innerHTML = `
		<div class="fm-dialog">
			<div class="fm-head">
				<div class="fm-icon" aria-hidden="true">${icon}</div>
				<div class="fm-head-text">
					<h3></h3>
					<p></p>
				</div>
				<button class="fm-close" type="button" aria-label="Close">✕</button>
			</div>
			<div class="fm-body"></div>
			<div class="fm-actions"></div>
		</div>
	`;
	backdrop.querySelector('.fm-head-text h3').textContent = title;
	backdrop.querySelector('.fm-head-text p').textContent = lede;

	const bodyEl = backdrop.querySelector('.fm-body');
	if (body instanceof HTMLElement) bodyEl.appendChild(body);
	else if (typeof body === 'string') bodyEl.innerHTML = body;

	const actionsEl = backdrop.querySelector('.fm-actions');
	if (Array.isArray(actions) && actions.length) {
		for (const a of actions) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'fm-cta' + (a.ghost ? ' ghost' : '');
			btn.textContent = a.label;
			btn.addEventListener('click', () => {
				a.onClick?.();
				if (a.dismiss !== false) closeFeatureModal();
			});
			actionsEl.appendChild(btn);
		}
	} else {
		actionsEl.remove();
	}

	backdrop.addEventListener('click', (e) => {
		if (e.target === backdrop) closeFeatureModal();
	});
	backdrop.querySelector('.fm-close').addEventListener('click', closeFeatureModal);

	escHandler = (e) => {
		if (e.key === 'Escape') closeFeatureModal();
	};
	document.addEventListener('keydown', escHandler);

	document.body.appendChild(backdrop);
	activeModal = backdrop;

	// Wire any "Copy" buttons rendered inside the body.
	for (const copyBtn of backdrop.querySelectorAll('.fm-copy')) {
		copyBtn.addEventListener('click', async () => {
			const codeEl = copyBtn.closest('.fm-code');
			const text = codeEl?.dataset.copy ?? codeEl?.textContent.replace(/Copy\s*$/, '').trim();
			if (!text) return;
			try {
				await navigator.clipboard.writeText(text);
				copyBtn.classList.add('copied');
				copyBtn.textContent = 'Copied';
				setTimeout(() => {
					copyBtn.classList.remove('copied');
					copyBtn.textContent = 'Copy';
				}, 1600);
			} catch {
				copyBtn.textContent = 'Press ⌘C';
			}
		});
	}

	return backdrop;
}

export function closeFeatureModal() {
	if (!activeModal) return;
	activeModal.remove();
	activeModal = null;
	if (escHandler) {
		document.removeEventListener('keydown', escHandler);
		escHandler = null;
	}
}

// ── 3D Body: emote chip strip on the viewer ──────────────────────────────────

// Hand-picked subset of the talk-emote bar that reads as "show me the moves"
// rather than "play a 30-second cutscene". Wave/celebrate/dance/pray cover
// happy/social/expressive ranges; idle is the return-to-rest.
const PREVIEW_EMOTES = [
	{ name: 'av-idle-breath', icon: '🧍', label: 'Idle' },
	{ name: 'wave', icon: '👋', label: 'Wave' },
	{ name: 'celebrate', icon: '🎉', label: 'Celebrate' },
	{ name: 'dance', icon: '💃', label: 'Dance' },
	{ name: 'av-arm-flex', icon: '💪', label: 'Flex' },
	{ name: 'reaction', icon: '😲', label: 'React' },
	{ name: 'pray', icon: '🙏', label: 'Pray' },
];

let emoteStripWired = false;

export async function toggleEmoteStrip({ scene, stripEl }) {
	if (!scene || !stripEl) return;
	const emotes = scene.getEmoteController();
	if (!emotes) return;

	// First call: populate the chips. Subsequent calls just toggle visibility.
	if (!emoteStripWired) {
		await emotes.loadManifest();
		const present = new Set(emotes.getAllDefs().map((d) => d.name));
		const available = PREVIEW_EMOTES.filter((e) => present.has(e.name));
		stripEl.innerHTML =
			available
				.map(
					(e) => `
				<button class="emote-chip" type="button" data-emote="${e.name}" title="${e.label}" aria-label="${e.label}">
					<span aria-hidden="true">${e.icon}</span>
				</button>
			`,
				)
				.join('') +
			`<button class="emote-strip-close" type="button" aria-label="Close animations">✕</button>`;

		stripEl.addEventListener('click', async (ev) => {
			const close = ev.target.closest('.emote-strip-close');
			if (close) {
				stripEl.classList.remove('is-visible');
				return;
			}
			const chip = ev.target.closest('.emote-chip');
			if (!chip) return;
			stripEl.querySelectorAll('.emote-chip.is-active').forEach((c) => c.classList.remove('is-active'));
			chip.classList.add('is-active');
			const name = chip.dataset.emote;
			const ok = await scene.playEmote(name);
			if (!ok) chip.classList.remove('is-active');
		});

		emoteStripWired = true;
	}

	stripEl.classList.toggle('is-visible');
}

// ── Voice: open the existing talk overlay against the staged GLB ─────────────

/**
 * Spin up the live talk overlay with the user's in-progress (unsaved) avatar.
 * No agent_id means TalkController falls back to edge TTS for voice and the
 * anonymous Groq tier for chat — both work without sign-in.
 */
export function openVoicePreview({ glbUrl, name }) {
	const previewName = name?.trim() || 'Your new avatar';
	const previewAvatar = {
		id: 'preview-' + Date.now(),
		name: previewName,
		model_url: glbUrl,
	};
	openTalkMode({
		avatar: previewAvatar,
		systemPromptFn: () =>
			`You are a friendly 3D avatar named "${previewName}" being previewed inside three.ws ` +
			`before its owner saves it. Keep replies short (1–2 sentences), warm, and curious. ` +
			`If asked what you can do, mention: voice, animations, on-chain identity on Solana, ` +
			`paid skills via x402, embedding anywhere with one snippet, and a public reputation.`,
	});
}

// ── Static info modals (identity / paid / embed / reputation) ────────────────

export function openIdentityModal() {
	openFeatureModal({
		icon: '🪪',
		title: 'On-Chain Identity',
		lede: 'Your agent becomes a Metaplex Core asset on Solana the moment you save — transferable, composable, browsable in any wallet.',
		body: `
			<ul class="fm-bullets">
				<li>Owned by your wallet, not by three.ws — transfer or sell at any time.</li>
				<li>Metadata (avatar URL, persona, voice) is mutable by you, signed on-chain.</li>
				<li>Discoverable in the registry by capability, price, and reputation.</li>
			</ul>
			<div class="fm-row">
				<div>
					<strong>Agent wallet</strong>
					<div class="muted">Solana address · generated when you save</div>
				</div>
				<code class="fm-placeholder">&lt;your·agent·wallet&gt;</code>
			</div>
			<p class="fm-note">No network calls happen until you save — this preview is local.</p>
		`,
		actions: [{ label: 'Got it' }],
	});
}

export function openPaidSkillsModal() {
	openFeatureModal({
		icon: '💸',
		title: 'Paid Skills (x402)',
		lede: 'Charge per call in USDC over the x402 protocol. Other agents (and apps) pay yours automatically — no API keys, no invoicing.',
		body: `
			<ul class="fm-bullets">
				<li>Set a price per skill — chat, render, custom endpoint, anything.</li>
				<li>Payments settle on Base in USDC, signed and verifiable.</li>
				<li>Your earnings stream into your agent's wallet, withdrawable any time.</li>
			</ul>
			<div class="fm-row">
				<div>
					<strong>Example pricing</strong>
					<div class="muted">You set this after saving</div>
				</div>
				<code style="color: var(--accent); font-weight: 600;">$0.05 / chat call</code>
			</div>
			<p class="fm-note">Listing your agent is free — you only pay if/when it earns.</p>
		`,
		actions: [{ label: 'Got it' }],
	});
}

export function openEmbedModal() {
	// Template, not a fake value: the placeholder reads as a parameter the user
	// has to fill in after saving. Copy still works — they get the exact tag
	// shape they'll need.
	const snippet = `<script src="https://three.ws/embed.js"
        data-agent="<your-agent-id>"
        data-mode="full"
        async></script>`;
	openFeatureModal({
		icon: '🧩',
		title: 'Embed Anywhere',
		lede: 'One tag drops your agent on any site — Webflow, Framer, raw HTML, React, Squarespace, you name it.',
		body: `
			<ul class="fm-bullets">
				<li>WebGL renders in-browser. No install, no plugin.</li>
				<li>Modes: floating bubble, fullscreen, inline card, or sidebar.</li>
				<li>The <code>agent-3d</code> Web Component works in any framework.</li>
			</ul>
			<div class="fm-code" data-copy='${snippet.replace(/'/g, '&apos;')}'>${escapeHtml(snippet)}<button class="fm-copy" type="button">Copy</button></div>
			<p class="fm-note">Save your avatar to get a real <code>data-agent</code> ID and a one-click copy of the live snippet.</p>
		`,
		actions: [{ label: 'Got it' }],
	});
}

// ── Download: real GLB / USDZ / VRM export from the staged blob ──────────────

const DOWNLOAD_FORMATS = [
	{
		id: 'glb',
		label: 'GLB',
		blurb: 'Universal 3D format. Works in Unity, Unreal, Blender, Sketchfab, model-viewer, every browser.',
		ext: '.glb',
		size: 'original',
	},
	{
		id: 'vrm',
		label: 'VRM',
		blurb: 'Humanoid avatar standard. Plug into VRChat, Resonite, Mozilla Hubs, Warudo, VTube Studio, TalkingHead.',
		ext: '.vrm',
		size: 'similar to GLB',
	},
	{
		id: 'usdz',
		label: 'USDZ',
		blurb: 'Apple AR. Tap-to-view in Safari on iPhone/iPad via Quick Look.',
		ext: '.usdz',
		size: 'similar to GLB',
	},
];

/**
 * @param {{ blob: Blob, name: string }} ctx
 */
export function openDownloadModal(ctx) {
	const safeName = (ctx?.name || 'avatar').trim() || 'avatar';
	const body = document.createElement('div');
	body.innerHTML = `
		<ul class="fm-download-list" role="list">
			${DOWNLOAD_FORMATS.map(
				(f) => `
				<li>
					<button class="fm-download-row" type="button" data-format="${f.id}">
						<div class="fm-download-head">
							<strong>${f.label}</strong>
							<span class="fm-download-ext">${f.ext}</span>
						</div>
						<div class="fm-download-blurb">${f.blurb}</div>
						<div class="fm-download-status" data-status></div>
					</button>
				</li>
			`,
			).join('')}
		</ul>
		<p class="fm-note">All conversion runs in your browser — no upload, no server.</p>
	`;

	openFeatureModal({
		icon: '📦',
		title: 'Download your avatar',
		lede: 'Take your avatar anywhere — game engine, VR world, AR scene, sticker pack pipeline.',
		body,
		actions: [{ label: 'Done', ghost: true }],
	});

	body.querySelectorAll('.fm-download-row').forEach((row) => {
		row.addEventListener('click', async () => {
			const format = row.dataset.format;
			const statusEl = row.querySelector('[data-status]');
			if (row.dataset.busy === '1') return;
			row.dataset.busy = '1';
			statusEl.textContent = 'Preparing…';
			statusEl.dataset.tone = 'busy';
			try {
				const result = await downloadAvatar(ctx.blob, {
					format,
					filename: safeName,
					meta: { name: safeName },
				});
				statusEl.textContent = `Saved ${result.filename} · ${prettyBytes(result.size)}`;
				statusEl.dataset.tone = 'ok';
			} catch (err) {
				console.error('[create-review] download failed', err);
				statusEl.textContent =
					err?.message?.includes('humanoid') && format === 'vrm'
						? "Couldn't write VRM — this avatar's skeleton isn't humanoid enough. Try GLB instead."
						: `Couldn't export ${format.toUpperCase()}: ${err?.message || 'unknown error'}`;
				statusEl.dataset.tone = 'err';
			} finally {
				row.dataset.busy = '0';
			}
		});
	});
}

function prettyBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function openReputationModal() {
	openFeatureModal({
		icon: '⭐',
		title: 'Reputation',
		lede: 'Signed feedback, call history, and validation events accrue to your agent — visible to anyone deciding whether to trust it.',
		body: `
			<ul class="fm-bullets">
				<li>Every paid call is logged with a signed receipt — verifiable, non-repudiable.</li>
				<li>Users can leave reviews; reviews carry the reviewer's own reputation weight.</li>
				<li>Validators can attest to capability (e.g. "this agent reliably ships valid SQL").</li>
			</ul>
			<div class="fm-row">
				<div>
					<strong>Your starting rep</strong>
					<div class="muted">Reviews accrue as your agent is used</div>
				</div>
				<code style="color: var(--muted);">★★★★★ · 0 reviews</code>
			</div>
			<p class="fm-note">Your reputation lives on-chain alongside your agent — it travels with the asset.</p>
		`,
		actions: [{ label: 'Got it' }],
	});
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
