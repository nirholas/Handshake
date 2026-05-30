// Embed editor — configure, preview live, and copy a ready-to-paste snippet
// for embedding a three.ws avatar on any website. Mounts into /embed
// (pages/embed.html).
//
// Four embed modes, all backed by runtimes that actually exist in this repo:
//   • Static  → /walk-embed  (controls=none, autoplay=false) — avatar stands.
//   • Idle    → /walk-embed  (controls=none, autoplay=true)  — avatar drifts.
//   • Walking → /walk-embed  (controls=joystick|keyboard)    — interactive.
//   • Chat    → /a/<id>?embed=1 iframe                        — talk to agent.
//
// Design goals:
//   • Live preview that renders the EXACT runtime the snippet ships.
//   • Real clipboard copy, no fake "copied!" states.
//   • Deep-linkable: every control reflects into the URL query so a
//     configured embed can be shared and re-opened (e.g. /embed?avatar=x).

const ORIGIN = 'https://three.ws';

const MODES = [
	{ id: 'static',  label: 'Static',  hint: 'Avatar stands in an idle pose. No controls.' },
	{ id: 'idle',    label: 'Idle',    hint: 'Avatar drifts and breathes on its own.' },
	{ id: 'walking', label: 'Walking', hint: 'Visitors move the avatar with a joystick or keys.' },
	{ id: 'chat',    label: 'Chat',    hint: 'Embedded agent page — visitors chat with the agent.' },
];

const CONTROL_OPTIONS = ['joystick', 'keyboard', 'none'];
const ENV_OPTIONS = [
	{ id: 'studio', label: 'Studio (transparent)' },
	{ id: 'void',   label: 'Void' },
	{ id: 'beach',  label: 'Beach' },
	{ id: 'sunset', label: 'Sunset' },
	{ id: 'night',  label: 'Night' },
	{ id: 'grid',   label: 'Grid' },
];
const SIZE_PRESETS = {
	S:      { w: 240, h: 360 },
	M:      { w: 320, h: 480 },
	L:      { w: 420, h: 640 },
	custom: null,
};

const DEFAULTS = {
	mode: 'walking',
	avatar: '',
	controls: 'joystick',
	bg: 'transparent',
	env: 'studio',
	size: 'M',
	width: 320,
	height: 480,
	autoplay: true,
	snippetVariant: 'iframe', // 'iframe' | 'script'
};

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	const { style, ...rest } = props;
	Object.assign(node, rest);
	for (const [k, v] of Object.entries(style || {})) node.style[k] = v;
	for (const c of [].concat(children)) {
		if (c == null) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}

function field(labelText, control) {
	return el('label', { className: 'ee-field' }, [
		el('span', { className: 'ee-label', textContent: labelText }),
		control,
	]);
}

function mountEmbedEditor(root, opts = {}) {
	const cfg = { ...DEFAULTS, ...sanitize(opts) };
	// If an avatar was passed in but no explicit mode, default to Walking so
	// /embed?avatar=<id> lands on the interactive avatar embed.
	if (opts.avatar && !opts.mode) cfg.mode = 'walking';

	injectStyles();
	root.classList.add('embed-editor');

	// ── Left: controls panel ───────────────────────────────────────────────
	const panel = el('div', { className: 'ee-panel' });

	panel.append(
		el('h1', { className: 'ee-title', textContent: 'Embed editor' }),
		el('p', { className: 'ee-subtitle', textContent: 'Drop a live 3D avatar onto any site. Configure, preview, copy.' }),
	);

	// Mode toggle
	const modeRow = el('div', { className: 'ee-segment', role: 'tablist', 'aria-label': 'Embed mode' });
	const modeButtons = new Map();
	for (const m of MODES) {
		const b = el('button', {
			type: 'button',
			className: 'ee-seg-btn',
			textContent: m.label,
			role: 'tab',
			title: m.hint,
		});
		b.addEventListener('click', () => { cfg.mode = m.id; sync(); });
		modeButtons.set(m.id, b);
		modeRow.appendChild(b);
	}
	const modeHint = el('p', { className: 'ee-hint' });
	panel.append(field('Mode', modeRow), modeHint);

	// Avatar id (shared by all modes)
	const avatarInput = el('input', { type: 'text', placeholder: 'agent / avatar id (e.g. agt_abc123)', value: cfg.avatar });
	avatarInput.addEventListener('input', () => { cfg.avatar = avatarInput.value.trim(); sync(); });
	const avatarField = field('Avatar ID', avatarInput);

	// Controls (walking only)
	const controlsSelect = el('select', {}, CONTROL_OPTIONS.map((c) =>
		el('option', { value: c, textContent: c, selected: c === cfg.controls })));
	controlsSelect.addEventListener('change', () => { cfg.controls = controlsSelect.value; sync(); });
	const controlsField = field('Controls', controlsSelect);

	// Background color (avatar modes)
	const bgWrap = el('div', { className: 'ee-bgrow' });
	const bgTransparent = el('input', { type: 'checkbox', id: 'ee-bg-transparent', checked: cfg.bg === 'transparent' });
	const bgTransparentLabel = el('label', { htmlFor: 'ee-bg-transparent', className: 'ee-checklabel', textContent: 'Transparent' });
	const bgColor = el('input', { type: 'color', value: cfg.bg === 'transparent' ? '#101820' : cfg.bg, disabled: cfg.bg === 'transparent' });
	bgTransparent.addEventListener('change', () => {
		cfg.bg = bgTransparent.checked ? 'transparent' : bgColor.value;
		bgColor.disabled = bgTransparent.checked;
		sync();
	});
	bgColor.addEventListener('input', () => { if (!bgTransparent.checked) { cfg.bg = bgColor.value; sync(); } });
	bgWrap.append(bgColor, el('span', { className: 'ee-bgsep' }), bgTransparent, bgTransparentLabel);
	const bgField = field('Background', bgWrap);

	// Environment (avatar modes)
	const envSelect = el('select', {}, ENV_OPTIONS.map((e) =>
		el('option', { value: e.id, textContent: e.label, selected: e.id === cfg.env })));
	envSelect.addEventListener('change', () => { cfg.env = envSelect.value; sync(); });
	const envField = field('Environment', envSelect);

	// Size (all modes — every runtime renders a sized iframe)
	const sizeRow = el('div', { className: 'ee-segment ee-segment-sm' });
	const sizeButtons = new Map();
	for (const key of Object.keys(SIZE_PRESETS)) {
		const b = el('button', { type: 'button', className: 'ee-seg-btn', textContent: key === 'custom' ? 'Custom' : key });
		b.addEventListener('click', () => {
			cfg.size = key;
			if (SIZE_PRESETS[key]) { cfg.width = SIZE_PRESETS[key].w; cfg.height = SIZE_PRESETS[key].h; }
			syncDims();
			sync();
		});
		sizeButtons.set(key, b);
		sizeRow.appendChild(b);
	}
	const sizeField = field('Size', sizeRow);

	const dimRow = el('div', { className: 'ee-dimrow' });
	const widthInput = el('input', { type: 'number', min: '120', value: String(cfg.width) });
	const heightInput = el('input', { type: 'number', min: '120', value: String(cfg.height) });
	const onDim = () => {
		cfg.width = clampDim(widthInput.value);
		cfg.height = clampDim(heightInput.value);
		cfg.size = 'custom';
		sync();
	};
	widthInput.addEventListener('input', onDim);
	heightInput.addEventListener('input', onDim);
	dimRow.append(
		el('div', { className: 'ee-dim' }, [el('span', { className: 'ee-dim-label', textContent: 'W' }), widthInput]),
		el('div', { className: 'ee-dim' }, [el('span', { className: 'ee-dim-label', textContent: 'H' }), heightInput]),
	);
	const dimField = field('Dimensions (px)', dimRow);
	function syncDims() { widthInput.value = String(cfg.width); heightInput.value = String(cfg.height); }

	// Autoplay (walking only — static/idle imply it)
	const autoplayWrap = el('div', { className: 'ee-bgrow' });
	const autoplayCheck = el('input', { type: 'checkbox', id: 'ee-autoplay', checked: cfg.autoplay });
	const autoplayLabel = el('label', { htmlFor: 'ee-autoplay', className: 'ee-checklabel', textContent: 'Avatar starts moving on load' });
	autoplayCheck.addEventListener('change', () => { cfg.autoplay = autoplayCheck.checked; sync(); });
	autoplayWrap.append(autoplayCheck, autoplayLabel);
	const autoplayField = field('Autoplay', autoplayWrap);

	panel.append(avatarField, controlsField, envField, bgField, sizeField, dimField, autoplayField);

	// ── Right: preview + snippet ────────────────────────────────────────────
	const previewWrap = el('div', { className: 'ee-preview-wrap' });

	const previewBar = el('div', { className: 'ee-bar' }, [
		el('span', { className: 'ee-bar-title', textContent: 'Live preview' }),
		el('span', { className: 'ee-bar-note', textContent: 'rendered from the real embed runtime' }),
	]);
	const previewFrame = el('div', { className: 'ee-stage' });
	const previewEmpty = el('div', { className: 'ee-empty' });

	// Snippet variant tabs
	const variantRow = el('div', { className: 'ee-segment ee-segment-sm ee-variant' });
	const variantButtons = new Map();
	for (const v of [{ id: 'iframe', label: 'Iframe' }, { id: 'script', label: 'Script tag' }]) {
		const b = el('button', { type: 'button', className: 'ee-seg-btn', textContent: v.label });
		b.addEventListener('click', () => { cfg.snippetVariant = v.id; sync(); });
		variantButtons.set(v.id, b);
		variantRow.appendChild(b);
	}

	const snippetBar = el('div', { className: 'ee-bar' }, [
		el('span', { className: 'ee-bar-title', textContent: 'Snippet' }),
		variantRow,
	]);
	const snippetBox = el('textarea', { className: 'ee-snippet', readOnly: true, rows: 5, spellcheck: false });

	const copyBtn = el('button', { type: 'button', className: 'ee-copy', textContent: 'Copy snippet' });
	copyBtn.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(snippetBox.value);
			copyBtn.textContent = 'Copied!';
			copyBtn.classList.add('is-ok');
		} catch {
			// Fallback for non-secure contexts where the Clipboard API is blocked.
			snippetBox.select();
			const ok = document.execCommand && document.execCommand('copy');
			copyBtn.textContent = ok ? 'Copied!' : 'Copy failed — select & ⌘C';
			copyBtn.classList.toggle('is-ok', !!ok);
		}
		clearTimeout(copyBtn._t);
		copyBtn._t = setTimeout(() => { copyBtn.textContent = 'Copy snippet'; copyBtn.classList.remove('is-ok'); }, 1600);
	});

	previewWrap.append(previewBar, previewFrame, snippetBar, snippetBox, copyBtn);

	root.append(panel, previewWrap);

	// ── Sync: regenerate UI visibility + preview + snippet from cfg ──────────
	let previewEl = null;
	function sync() {
		const isAvatar = cfg.mode !== 'chat';
		const isWalking = cfg.mode === 'walking';

		// Active states
		for (const [id, b] of modeButtons) {
			const on = id === cfg.mode;
			b.classList.toggle('is-active', on);
			b.setAttribute('aria-selected', String(on));
		}
		for (const [id, b] of sizeButtons) b.classList.toggle('is-active', id === cfg.size);
		for (const [id, b] of variantButtons) b.classList.toggle('is-active', id === cfg.snippetVariant);
		modeHint.textContent = MODES.find((m) => m.id === cfg.mode)?.hint || '';

		// Field visibility per mode
		controlsField.style.display = isWalking ? '' : 'none';
		autoplayField.style.display = isWalking ? '' : 'none';
		envField.style.display = isAvatar ? '' : 'none';
		bgField.style.display = isAvatar ? '' : 'none';
		// Size applies to every mode — all runtimes render a sized iframe.
		sizeField.style.display = '';
		dimField.style.display = '';
		// Chat is a plain iframe to the agent page — no iframe/script choice.
		variantRow.style.display = isAvatar ? '' : 'none';

		reflectUrl();

		snippetBox.value = buildSnippet(cfg);
		renderPreview();
	}

	function renderPreview() {
		if (previewEl) { previewEl.remove(); previewEl = null; }
		previewEmpty.remove();

		if (!cfg.avatar) {
			previewEmpty.textContent = cfg.mode === 'chat'
				? 'Enter an agent ID to preview the chat embed.'
				: 'Enter an avatar ID to preview the embed.';
			previewFrame.appendChild(previewEmpty);
			return;
		}

		const host = el('div', { className: 'ee-host' });
		const src = cfg.mode === 'chat' ? chatSrc(cfg, true) : walkSrc(cfg, /* preview */ true);
		const iframe = el('iframe', {
			className: 'ee-iframe',
			src,
			title: cfg.mode === 'chat' ? 'Agent chat preview' : 'Walking avatar preview',
			loading: 'lazy',
			allow: cfg.mode === 'chat' ? 'microphone; autoplay; clipboard-write' : 'accelerometer; gyroscope; autoplay',
			style: {
				width: `${cfg.width}px`,
				height: `${cfg.height}px`,
				maxWidth: '100%',
				maxHeight: '100%',
				borderRadius: '16px',
			},
		});
		host.appendChild(iframe);
		previewFrame.appendChild(host);
		previewEl = host;
	}

	function reflectUrl() {
		const url = new URL(location.href);
		const q = url.searchParams;
		q.set('mode', cfg.mode);
		if (cfg.avatar) q.set('avatar', cfg.avatar); else q.delete('avatar');
		q.set('width', String(cfg.width));
		q.set('height', String(cfg.height));
		if (cfg.mode !== 'chat') {
			q.set('env', cfg.env);
			q.set('bg', cfg.bg);
		} else {
			q.delete('env'); q.delete('bg');
		}
		if (cfg.mode === 'walking') { q.set('controls', cfg.controls); q.set('autoplay', String(cfg.autoplay)); }
		else { q.delete('controls'); q.delete('autoplay'); }
		history.replaceState(null, '', url);
	}

	sync();
}

// ── URL + snippet builders (pure) ──────────────────────────────────────────

function walkSrc(cfg, preview = false) {
	const u = new URL(`${ORIGIN}/walk-embed`);
	const q = u.searchParams;
	if (cfg.avatar) q.set('avatar', cfg.avatar);
	// Mode → control + autoplay mapping.
	if (cfg.mode === 'walking') {
		q.set('controls', cfg.controls);
		if (cfg.autoplay) q.set('autoplay', 'true');
	} else if (cfg.mode === 'idle') {
		q.set('controls', 'none');
		q.set('autoplay', 'true');
	} else { // static
		q.set('controls', 'none');
		q.set('autoplay', 'false');
	}
	if (cfg.bg && cfg.bg !== 'transparent') q.set('bg', cfg.bg);
	if (cfg.env && cfg.env !== 'studio') q.set('env', cfg.env);
	// Preview frames load over the dev/local origin so the iframe actually
	// renders here; the copied snippet always points at the production origin.
	if (preview) return u.toString().replace(ORIGIN, location.origin);
	return u.toString();
}

function chatSrc(cfg, preview = false) {
	// The agent's standalone chat page, embed-chromed. Real, existing route
	// (vercel.json maps /a/(.*)). Same URL drives the preview and the snippet.
	const base = preview ? location.origin : ORIGIN;
	return `${base}/a/${encodeURIComponent(cfg.avatar)}?embed=1`;
}

function buildSnippet(cfg) {
	// No avatar yet → return guidance instead of a copyable-but-broken snippet.
	if (!cfg.avatar) {
		return cfg.mode === 'chat'
			? '<!-- Enter an agent ID above to generate the chat embed snippet -->'
			: '<!-- Enter an avatar ID above to generate the embed snippet -->';
	}
	if (cfg.mode === 'chat') {
		return `<iframe\n  src="${chatSrc(cfg)}"\n  width="${cfg.width}"\n  height="${cfg.height}"\n  style="border:0;border-radius:16px"\n  allow="microphone; autoplay; clipboard-write"\n  loading="lazy"><\/iframe>`;
	}
	if (cfg.snippetVariant === 'script') {
		const attrs = [
			`src="${ORIGIN}/walk-embed-sdk.js"`,
			`data-avatar="${esc(cfg.avatar)}"`,
			cfg.mode === 'walking' ? `data-controls="${cfg.controls}"` : `data-controls="none"`,
			cfg.bg !== 'transparent' ? `data-bg="${cfg.bg}"` : null,
			cfg.env !== 'studio' ? `data-env="${cfg.env}"` : null,
			autoplayFor(cfg) ? `data-autoplay="true"` : null,
			`data-width="${cfg.width}"`,
			`data-height="${cfg.height}"`,
		].filter(Boolean);
		return `<script\n  ${attrs.join('\n  ')}><\/script>`;
	}
	// iframe variant
	const src = walkSrc(cfg);
	return `<iframe\n  src="${src}"\n  width="${cfg.width}"\n  height="${cfg.height}"\n  style="border:0;border-radius:16px"\n  allow="accelerometer; gyroscope; autoplay"\n  loading="lazy"><\/iframe>`;
}

function autoplayFor(cfg) {
	if (cfg.mode === 'idle') return true;
	if (cfg.mode === 'static') return false;
	return cfg.autoplay;
}

// ── helpers ────────────────────────────────────────────────────────────────

function sanitize(opts) {
	const out = {};
	if (opts.mode && MODES.some((m) => m.id === opts.mode)) out.mode = opts.mode;
	if (opts.avatar) out.avatar = String(opts.avatar).trim();
	if (opts.controls && CONTROL_OPTIONS.includes(opts.controls)) out.controls = opts.controls;
	if (opts.env && ENV_OPTIONS.some((e) => e.id === opts.env)) out.env = opts.env;
	if (opts.bg) out.bg = opts.bg;
	if (opts.width) out.width = clampDim(opts.width);
	if (opts.height) out.height = clampDim(opts.height);
	if (opts.width || opts.height) out.size = 'custom';
	if (opts.autoplay != null && opts.autoplay !== '') out.autoplay = opts.autoplay === true || opts.autoplay === 'true';
	return out;
}

function clampDim(v) {
	const n = parseInt(v, 10);
	if (!Number.isFinite(n)) return 320;
	return Math.max(120, Math.min(1200, n));
}

function esc(s) {
	return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function injectStyles() {
	if (document.getElementById('ee-styles')) return;
	const s = el('style', { id: 'ee-styles' });
	s.textContent = `
		.embed-editor { display:grid; grid-template-columns:minmax(300px,380px) 1fr; height:100vh; }
		.embed-editor *, .embed-editor *::before, .embed-editor *::after { box-sizing:border-box; }
		.ee-panel { padding:24px; border-right:1px solid #1c2026; overflow-y:auto; background:#0d0f12; }
		.ee-title { font-size:18px; margin:0 0 4px; font-weight:700; }
		.ee-subtitle { font-size:13px; color:#71717a; margin:0 0 22px; line-height:1.5; }
		.ee-field { display:block; margin-bottom:16px; }
		.ee-label { display:block; font-size:12px; color:#a1a1aa; margin-bottom:7px; font-weight:600; }
		.ee-hint { font-size:12px; color:#71717a; margin:-8px 0 16px; min-height:16px; line-height:1.4; }
		.embed-editor input[type=text], .embed-editor input[type=number], .embed-editor select {
			width:100%; padding:9px 11px; background:#15181d; border:1px solid #2a2f37;
			border-radius:8px; color:#fff; font-size:13px; outline:none; font-family:inherit;
			transition:border-color .15s ease;
		}
		.embed-editor input:focus, .embed-editor select:focus { border-color:#6366f1; }
		.ee-segment { display:flex; gap:6px; background:#121519; border:1px solid #21262e; border-radius:10px; padding:4px; }
		.ee-segment-sm { gap:4px; }
		.ee-seg-btn {
			flex:1; padding:8px 10px; background:transparent; border:none; border-radius:7px;
			color:#a1a1aa; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit;
			transition:background .15s ease, color .15s ease; white-space:nowrap;
		}
		.ee-seg-btn:hover { color:#e4e4e7; }
		.ee-seg-btn:focus-visible { outline:2px solid #6366f1; outline-offset:2px; }
		.ee-seg-btn.is-active { background:#6366f1; color:#fff; }
		.ee-bgrow { display:flex; align-items:center; gap:10px; }
		.ee-bgsep { flex:1; }
		.ee-checklabel { font-size:13px; color:#d4d4d8; cursor:pointer; }
		.embed-editor input[type=color] { width:44px; height:34px; padding:2px; background:#15181d; border:1px solid #2a2f37; border-radius:8px; cursor:pointer; }
		.embed-editor input[type=color]:disabled { opacity:.4; cursor:not-allowed; }
		.embed-editor input[type=checkbox] { width:16px; height:16px; accent-color:#6366f1; cursor:pointer; }
		.ee-dimrow { display:flex; gap:10px; }
		.ee-dim { display:flex; align-items:center; gap:6px; flex:1; }
		.ee-dim-label { font-size:12px; color:#71717a; font-weight:600; }
		.ee-preview-wrap { padding:24px; display:flex; flex-direction:column; gap:14px; overflow:hidden; }
		.ee-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; }
		.ee-bar-title { font-size:12px; color:#a1a1aa; font-weight:600; }
		.ee-bar-note { font-size:11px; color:#52525b; }
		.ee-variant { flex:0 0 auto; }
		.ee-variant .ee-seg-btn { padding:5px 12px; font-size:12px; }
		.ee-stage {
			flex:1; border-radius:14px; border:1px solid #1c2026;
			background:
				radial-gradient(circle at 30% 20%, #14181f 0, #08090b 60%),
				repeating-conic-gradient(#0c0e11 0% 25%, #0a0b0e 0% 50%) 50% / 28px 28px;
			position:relative; overflow:hidden; min-height:300px;
			display:flex; align-items:center; justify-content:center;
		}
		.ee-host { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; }
		.ee-iframe { border:0; background:transparent; }
		.ee-empty { color:#52525b; font-size:13px; text-align:center; max-width:240px; line-height:1.5; }
		.ee-snippet {
			width:100%; background:#0d0f12; border:1px solid #1c2026; border-radius:10px;
			color:#d4d4d8; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px;
			padding:12px; resize:none; line-height:1.5; outline:none; min-height:108px;
		}
		.ee-snippet:focus { border-color:#2a3340; }
		.ee-copy {
			align-self:flex-start; padding:10px 20px; background:#6366f1; border:none; border-radius:9px;
			color:#fff; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit;
			transition:background .15s ease, transform .1s ease;
		}
		.ee-copy:hover { background:#4f52e0; }
		.ee-copy:active { transform:translateY(1px); }
		.ee-copy.is-ok { background:#22c55e; }
		@media (max-width:860px) {
			.embed-editor { grid-template-columns:1fr; height:auto; }
			.ee-panel { border-right:none; border-bottom:1px solid #1c2026; }
			.ee-stage { min-height:360px; }
		}
	`;
	document.head.appendChild(s);
}

export { mountEmbedEditor };
