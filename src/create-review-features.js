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
let keyTrapHandler = null;
let lastFocusedBeforeOpen = null;
const FOCUSABLE_SEL =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open a feature-preview modal. Body may be an HTMLElement or HTML string. */
export function openFeatureModal({ icon, title, lede, body, actions, dialogClass }) {
	closeFeatureModal();

	// Remember the tile (or any element) the user came from so focus can return
	// there on close — keyboard users get dropped back exactly where they were.
	lastFocusedBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;

	const backdrop = document.createElement('div');
	backdrop.className = 'fm-backdrop';
	backdrop.setAttribute('role', 'dialog');
	backdrop.setAttribute('aria-modal', 'true');
	backdrop.setAttribute('aria-labelledby', 'fm-title');
	backdrop.setAttribute('aria-describedby', 'fm-lede');
	backdrop.innerHTML = `
		<div class="fm-dialog${dialogClass ? ' ' + dialogClass : ''}" tabindex="-1">
			<div class="fm-head">
				<div class="fm-icon" aria-hidden="true">${icon}</div>
				<div class="fm-head-text">
					<h3 id="fm-title"></h3>
					<p id="fm-lede"></p>
				</div>
				<button class="fm-close" type="button" aria-label="Close">✕</button>
			</div>
			<div class="fm-body"></div>
			<div class="fm-actions"></div>
		</div>
	`;
	backdrop.querySelector('#fm-title').textContent = title;
	backdrop.querySelector('#fm-lede').textContent = lede;

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
		if (e.key === 'Escape') {
			e.stopPropagation();
			closeFeatureModal();
		}
	};
	document.addEventListener('keydown', escHandler);

	// Tab/Shift-Tab cycles focus inside the dialog only. Without this, the
	// underlying page tabs through anchors *behind* the modal — screen readers
	// and keyboard users see "modal open but focus is on the nav header."
	keyTrapHandler = (e) => {
		if (e.key !== 'Tab') return;
		const focusables = Array.from(backdrop.querySelectorAll(FOCUSABLE_SEL))
			.filter((el) => !el.hasAttribute('inert') && el.offsetParent !== null);
		if (!focusables.length) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};
	backdrop.addEventListener('keydown', keyTrapHandler);

	// Lock page scroll while the modal owns the viewport.
	document.documentElement.style.overflow = 'hidden';

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

	// Initial focus: first interactive control inside the body (CTA, copy
	// button, input) rather than the close X — this lets keyboard users hit
	// Enter immediately to act, not just dismiss.
	requestAnimationFrame(() => {
		const initial =
			backdrop.querySelector('.fm-body button, .fm-body a[href], .fm-body input') ||
			backdrop.querySelector('.fm-cta') ||
			backdrop.querySelector('.fm-close');
		initial?.focus({ preventScroll: true });
	});

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
	keyTrapHandler = null;
	document.documentElement.style.overflow = '';
	// Restore focus to whatever the user was on when they opened the modal.
	if (lastFocusedBeforeOpen && document.contains(lastFocusedBeforeOpen)) {
		lastFocusedBeforeOpen.focus({ preventScroll: true });
	}
	lastFocusedBeforeOpen = null;
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

export async function openIdentityModal(ctx = {}) {
	// Render the shell synchronously so the modal opens instantly. The keypair
	// generation is fast (~ms) but the import is a fat dependency — load it
	// in the background and patch the address in once it resolves.
	const body = document.createElement('div');
	body.innerHTML = `
		<ul class="fm-bullets">
			<li>Owned by your wallet, not by three.ws — transfer or sell at any time.</li>
			<li>Metadata (avatar URL, persona, voice) is mutable by you, signed on-chain.</li>
			<li>Discoverable in the agent registry by capability, price, and reputation.</li>
		</ul>
		<div class="fm-id-card" data-state="loading">
			<div class="fm-id-head">
				<span class="fm-id-chain">Solana mainnet</span>
				<span class="fm-id-pill" data-pill>generating…</span>
			</div>
			<div class="fm-id-addr" data-addr>—</div>
			<div class="fm-id-meta">
				<div><span class="muted">Name</span><strong data-name>${escapeHtml(ctx.name || 'Your new avatar')}</strong></div>
				<div><span class="muted">Asset standard</span><strong>Metaplex Core</strong></div>
			</div>
			<button class="fm-copy fm-id-copy" type="button" data-copy-addr disabled>Copy address</button>
		</div>
		<p class="fm-note">Sample keypair generated locally — your real agent gets a unique address on save. Nothing is broadcast.</p>
	`;

	openFeatureModal({
		icon: '🪪',
		title: 'On-Chain Identity',
		lede: 'Your agent becomes a Metaplex Core asset on Solana the moment you save — transferable, composable, browsable in any wallet.',
		body,
		actions: [{ label: 'Got it' }],
	});

	// Generate a real, throwaway sample keypair in-browser so the preview
	// shows a *real-shaped* base58 address rather than an obvious placeholder.
	// Private key is discarded — this is purely a visual proof of "real Solana
	// addresses, not lorem ipsum".
	try {
		const { Keypair } = await import('@solana/web3.js');
		const kp = Keypair.generate();
		const addr = kp.publicKey.toBase58();
		const card = body.querySelector('.fm-id-card');
		card.dataset.state = 'ready';
		card.querySelector('[data-pill]').textContent = 'preview';
		card.querySelector('[data-addr]').textContent = addr;
		const copy = card.querySelector('[data-copy-addr]');
		copy.disabled = false;
		copy.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(addr);
				copy.textContent = 'Copied';
				copy.classList.add('copied');
				setTimeout(() => {
					copy.textContent = 'Copy address';
					copy.classList.remove('copied');
				}, 1600);
			} catch {
				copy.textContent = 'Press ⌘C';
			}
		});
	} catch (err) {
		const card = body.querySelector('.fm-id-card');
		card.dataset.state = 'error';
		card.querySelector('[data-pill]').textContent = 'unavailable';
		card.querySelector('[data-addr]').textContent =
			'Couldn\'t load keypair generator — your real address is created on save.';
		console.warn('[identity-preview] keypair gen failed', err);
	}
}

export function openPaidSkillsModal(ctx = {}) {
	const handle = slugify(ctx.name) || 'your-agent';
	const endpoint = `https://three.ws/api/agent/${handle}/ask`;
	const snippets = {
		curl: `# 1. Make the request — server replies 402 with payment terms
curl -sS -X POST ${endpoint} \\
  -H 'content-type: application/json' \\
  -d '{"message":"hello"}'

# → HTTP/1.1 402 Payment Required
# → {"accepts":[{"network":"solana","asset":"USDC",
# →   "amount":"0.05","payTo":"<agent·wallet>"}]}

# 2. Sign a USDC transfer for the quoted amount, retry with X-PAYMENT
curl -sS -X POST ${endpoint} \\
  -H 'content-type: application/json' \\
  -H 'x-payment: <base64-signed-payload>' \\
  -d '{"message":"hello"}'

# → HTTP/1.1 200 OK
# → {"reply":"Hi! How can I help?","tx":"<solana·tx·sig>"}`,
		fetch: `import { withX402 } from '@three.ws/x402-fetch';

// withX402 wraps fetch — intercepts 402, signs USDC, retries.
const fetchPaid = withX402(fetch, { wallet, network: 'solana' });

const res = await fetchPaid('${endpoint}', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: 'hello' }),
});

console.log(await res.json()); // { reply, tx }`,
		python: `from three_ws import X402Client

client = X402Client(wallet=wallet, network="solana")

reply = client.post(
    "${endpoint}",
    json={"message": "hello"},
)
print(reply.json())  # {"reply": "...", "tx": "<sig>"}`,
	};

	const body = document.createElement('div');
	body.innerHTML = `
		<ul class="fm-bullets">
			<li>Quoted in USDC on Solana — payments settle in seconds, signed end-to-end.</li>
			<li>Set a price per skill (chat, render, custom endpoint) after saving.</li>
			<li>Earnings stream into your agent's wallet, withdrawable any time.</li>
		</ul>

		<div class="fm-handshake" aria-label="x402 handshake">
			<div class="fm-handshake-step">
				<span class="fm-handshake-num">1</span>
				<div>
					<strong>Client calls</strong>
					<div class="muted">No auth, just hits the endpoint.</div>
				</div>
				<span class="fm-handshake-code">POST</span>
			</div>
			<div class="fm-handshake-arrow">→</div>
			<div class="fm-handshake-step">
				<span class="fm-handshake-num">2</span>
				<div>
					<strong>Server replies <code>402</code></strong>
					<div class="muted">Quotes <code>$0.05</code> USDC on Solana.</div>
				</div>
				<span class="fm-handshake-code">402</span>
			</div>
			<div class="fm-handshake-arrow">→</div>
			<div class="fm-handshake-step">
				<span class="fm-handshake-num">3</span>
				<div>
					<strong>Client signs &amp; retries</strong>
					<div class="muted"><code>X-PAYMENT</code> header carries the signed transfer.</div>
				</div>
				<span class="fm-handshake-code">200</span>
			</div>
		</div>

		<div class="fm-tabs" role="tablist" aria-label="Client language">
			<button class="fm-tab is-active" role="tab" data-tab="curl">cURL</button>
			<button class="fm-tab" role="tab" data-tab="fetch">JavaScript</button>
			<button class="fm-tab" role="tab" data-tab="python">Python</button>
		</div>
		<div class="fm-code" data-copy-target>
			<pre data-snippet></pre>
			<button class="fm-copy" type="button">Copy</button>
		</div>
		<p class="fm-note">Endpoint shape is real — your handle is filled in as you name your avatar. Pricing &amp; gating is configured after save.</p>
	`;

	openFeatureModal({
		icon: '💸',
		title: 'Paid Skills (x402)',
		lede: 'Charge per call in USDC over the x402 protocol. Other agents (and apps) pay yours automatically — no API keys, no invoicing.',
		body,
		actions: [{ label: 'Got it' }],
		dialogClass: 'fm-dialog--wide',
	});

	const codeEl = body.querySelector('[data-copy-target]');
	const snippetEl = body.querySelector('[data-snippet]');
	function setTab(name) {
		body.querySelectorAll('.fm-tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
		snippetEl.textContent = snippets[name];
		codeEl.dataset.copy = snippets[name];
	}
	body.querySelectorAll('.fm-tab').forEach((t) => {
		t.addEventListener('click', () => setTab(t.dataset.tab));
	});
	setTab('curl');
}

export function openEmbedModal(ctx = {}) {
	const handle = slugify(ctx.name) || 'your-agent';
	const snippets = {
		script: `<script async src="https://three.ws/embed.js"
        data-widget="${handle}"
        data-type="talking-agent"></script>`,
		webcomponent: `<agent-3d agent="${handle}" mode="full"></agent-3d>
<script type="module"
  src="https://three.ws/embed/agent-3d.js"></script>`,
		react: `import { Agent3D } from '@three.ws/react';

export default function Page() {
  return <Agent3D agent="${handle}" mode="full" />;
}`,
		iframe: `<iframe
  src="https://three.ws/widget#widget=${handle}&kiosk=true"
  width="420" height="600"
  style="border:0;border-radius:14px"
  allow="microphone; autoplay"
  loading="lazy"></iframe>`,
	};

	const body = document.createElement('div');
	body.innerHTML = `
		<ul class="fm-bullets">
			<li>WebGL renders in-browser. No install, no plugin.</li>
			<li>Modes: floating bubble, fullscreen, inline card, or sidebar.</li>
			<li>Works in Webflow, Framer, raw HTML, React, Next.js, Squarespace.</li>
		</ul>

		<div class="fm-tabs" role="tablist" aria-label="Embed format">
			<button class="fm-tab is-active" role="tab" data-tab="script">Script tag</button>
			<button class="fm-tab" role="tab" data-tab="webcomponent">Web Component</button>
			<button class="fm-tab" role="tab" data-tab="react">React</button>
			<button class="fm-tab" role="tab" data-tab="iframe">iframe</button>
		</div>
		<div class="fm-code" data-copy-target>
			<pre data-snippet></pre>
			<button class="fm-copy" type="button">Copy</button>
		</div>

		<div class="fm-browser" aria-label="Live embed preview">
			<div class="fm-browser-bar">
				<span class="fm-browser-dot"></span>
				<span class="fm-browser-dot"></span>
				<span class="fm-browser-dot"></span>
				<div class="fm-browser-url">three.ws/@${escapeHtml(handle)}</div>
			</div>
			<div class="fm-browser-stage" data-stage>
				<img class="fm-browser-shot" alt="" data-shot hidden />
				<div class="fm-browser-skeleton" data-skel>Rendering live preview…</div>
			</div>
		</div>
		<p class="fm-note">Save your avatar to claim the real <code>data-widget</code> ID — copies above keep working with the placeholder.</p>
	`;

	openFeatureModal({
		icon: '🧩',
		title: 'Embed Anywhere',
		lede: 'One tag drops your avatar on any site. Real snippet, real iframe shape, real preview of how it renders.',
		body,
		actions: [{ label: 'Got it' }],
		dialogClass: 'fm-dialog--wide',
	});

	// Wire tabs ↔ snippet swap.
	const codeEl = body.querySelector('[data-copy-target]');
	const snippetEl = body.querySelector('[data-snippet]');
	function setTab(name) {
		body.querySelectorAll('.fm-tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
		snippetEl.textContent = snippets[name];
		codeEl.dataset.copy = snippets[name];
	}
	body.querySelectorAll('.fm-tab').forEach((t) => {
		t.addEventListener('click', () => setTab(t.dataset.tab));
	});
	setTab('script');

	// Live preview: capture a snapshot from the actual viewer canvas so the
	// "this is what your embed will look like" frame shows *this avatar*,
	// not a stock image. Falls back to a styled placeholder if the canvas
	// isn't ready.
	const stage = body.querySelector('[data-stage]');
	const shot = body.querySelector('[data-shot]');
	const skel = body.querySelector('[data-skel]');
	const sourceCanvas = document.querySelector('#mv-container canvas');
	if (sourceCanvas) {
		try {
			sourceCanvas.toBlob((b) => {
				if (!b) return;
				shot.src = URL.createObjectURL(b);
				shot.hidden = false;
				skel.hidden = true;
			}, 'image/png');
		} catch (err) {
			console.warn('[embed-preview] canvas snapshot failed', err);
		}
	} else {
		skel.textContent = 'Preview will render here once your avatar is loaded.';
	}
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

export function openReputationModal(ctx = {}) {
	const handle = slugify(ctx.name) || 'your-agent';
	// Sample reviews — clearly labelled as such ("EXAMPLE" pill on the card).
	// Structure mirrors src/reputation-ui.js so the user sees the actual
	// production shape (truncated reviewer address, stars, comment, tx link).
	const sample = [
		{ author: '7xK…aN4q', stars: 5, comment: 'Sharp at SQL — saved me an hour on a gnarly join.', when: '2d ago' },
		{ author: '9mR…vT8p', stars: 5, comment: 'Voice felt natural over a 30-min call. Recommend.', when: '5d ago' },
		{ author: 'Bcj…F2zL', stars: 4, comment: 'Solid embed, easy to drop on our docs site.', when: '1w ago' },
	];

	const reviewsHtml = sample
		.map(
			(r) => `
		<div class="rep-review-item">
			<div class="rep-review-header">
				<span class="rep-review-author">${escapeHtml(r.author)}</span>
				<span class="rep-stars" aria-label="${r.stars} stars">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</span>
			</div>
			<p class="rep-comment">${escapeHtml(r.comment)}</p>
			<div class="rep-review-footer">
				<span class="muted">${escapeHtml(r.when)}</span>
				<span class="rep-link">↗ tx</span>
			</div>
		</div>
	`,
		)
		.join('');

	openFeatureModal({
		icon: '⭐',
		title: 'Reputation',
		lede: 'Signed feedback, call history, and validation events accrue to your agent — public, verifiable, portable.',
		body: `
			<ul class="fm-bullets">
				<li>Every paid call is logged with a signed receipt — verifiable, non-repudiable.</li>
				<li>Reviews carry the reviewer's own reputation weight — Sybil-resistant.</li>
				<li>Validators can attest to capability (e.g. "ships valid SQL 9.6/10 of the time").</li>
			</ul>

			<div class="rep-card">
				<div class="rep-card-head">
					<div>
						<strong>${escapeHtml(handle)}</strong>
						<div class="muted">three.ws/@${escapeHtml(handle)}</div>
					</div>
					<span class="rep-sample-pill">EXAMPLE</span>
				</div>
				<div class="rep-stats">
					<div><strong class="rep-stat-big">4.8</strong><span class="rep-stars">★★★★★</span><span class="muted">37 reviews</span></div>
					<div><strong>1,204</strong><span class="muted">paid calls</span></div>
					<div><strong>0.41 SOL</strong><span class="muted">staked on rep</span></div>
				</div>
				<div class="rep-reviews">${reviewsHtml}</div>
			</div>

			<p class="fm-note">Your starting rep is empty — every paid call and review accrues to your asset, on-chain, and travels with it if you ever transfer.</p>
		`,
		actions: [{ label: 'Got it' }],
		dialogClass: 'fm-dialog--wide',
	});
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** URL-safe slug derived from the user's typed avatar name. */
export function slugify(s) {
	if (!s) return '';
	return String(s)
		.toLowerCase()
		.trim()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32);
}
