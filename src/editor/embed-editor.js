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

import { openAvatarPicker } from '../avatar-gallery-picker.js';

const ORIGIN = 'https://three.ws';

const GALLERY_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;

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
	avatarMeta: null, // { name, thumbnail_url } — resolved for the picker chip, not serialized
	controls: 'joystick',
	bg: 'transparent',
	env: 'studio',
	size: 'M',
	width: 320,
	height: 480,
	autoplay: true,
	speed: 1, // walk-pace multiplier (?speed=0.3…3)
	ground: true, // show the ground disc + shadow (?ground=false floats the avatar)
	gestures: false, // show end-user wave/jump buttons (?gestures=true)
	badge: true, // show the three.ws attribution badge (?badge=false to remove)
	responsive: false, // emit a fluid (width:100%) snippet instead of fixed px
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

// A direct GLB/VRM URL (or site path) instead of a three.ws avatar id — the
// shape Forge/Scan hand off via /embed.html?avatar=<url>. walk-embed loads
// these directly; chat mode still needs a real agent id.
function isModelUrl(v) {
	return /^https?:\/\//i.test(v) || (typeof v === 'string' && v.startsWith('/'));
}

// Human-readable chip name for a bare model URL: the file name, de-slugged.
function modelUrlName(v) {
	try {
		var path = new URL(v, location.origin).pathname;
		var file = decodeURIComponent(path.split('/').pop() || '');
		var name = file.replace(/\.(glb|vrm|gltf)$/i, '').replace(/[-_]+/g, ' ').trim();
		return name ? name.slice(0, 60) : 'Your 3D model';
	} catch {
		return 'Your 3D model';
	}
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

	// The two embed builders are one product with two jobs: this editor makes a
	// snippet in seconds with no account, Widget Studio saves reusable widgets
	// with brand settings and analytics. Each says so and points at the other.
	const studioLink = el('a', { className: 'ee-crosslink', href: '/studio' });
	studioLink.textContent = 'Widget Studio →';
	const crossline = el('p', { className: 'ee-subtitle ee-crossline' });
	crossline.append(
		document.createTextNode('Want a saved, brandable widget you can update later? '),
		studioLink,
	);

	panel.append(
		el('h1', { className: 'ee-title', textContent: 'Embed editor' }),
		el('p', { className: 'ee-subtitle', textContent: 'Drop a live 3D avatar onto any site. Configure, preview, copy. No account needed.' }),
		crossline,
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

	// Avatar (shared by all modes) — primary action is the gallery picker so
	// visitors never have to know or type an ID. A collapsible "paste an ID"
	// fallback stays available for power users and deep links.
	const avatarTrigger = el('button', { type: 'button', className: 'ee-picker', 'aria-haspopup': 'dialog' });
	avatarTrigger.addEventListener('click', openPicker);

	const avatarInput = el('input', { type: 'text', className: 'ee-idinput', placeholder: 'or paste an avatar / agent id, or a GLB URL', value: cfg.avatar });
	avatarInput.addEventListener('input', () => {
		cfg.avatar = avatarInput.value.trim();
		cfg.avatarMeta = null;
		cfg.avatarMissing = false;
		renderTrigger();
		sync();
		if (cfg.avatar) resolveAvatarMeta(cfg.avatar);
	});

	const avatarField = field('Avatar', el('div', { className: 'ee-pickerwrap' }, [avatarTrigger, avatarInput]));

	function renderTrigger() {
		avatarTrigger.innerHTML = '';
		if (cfg.avatar) {
			const meta = cfg.avatarMeta;
			const missing = cfg.avatarMissing && !isModelUrl(cfg.avatar);
			const thumb = meta?.thumbnail_url
				? el('img', { className: 'ee-picker-thumb', src: meta.thumbnail_url, alt: '', loading: 'lazy', decoding: 'async' })
				: el('span', { className: 'ee-picker-thumb ee-picker-thumb--ph' });
			avatarTrigger.append(
				thumb,
				el('span', { className: 'ee-picker-name', textContent: meta?.name || cfg.avatar }),
				el('span', { className: 'ee-picker-action', textContent: missing ? 'Not found' : 'Change' }),
			);
			avatarTrigger.classList.add('is-selected');
			avatarTrigger.classList.toggle('is-missing', missing);
			avatarTrigger.setAttribute('aria-label', missing
				? `Avatar "${cfg.avatar}" not found. Click to choose a different one.`
				: `Selected avatar: ${meta?.name || cfg.avatar}. Click to change.`);
		} else {
			avatarTrigger.append(
				el('span', { className: 'ee-picker-icon', innerHTML: GALLERY_SVG }),
				el('span', { className: 'ee-picker-name', textContent: cfg.mode === 'chat' ? 'Browse agents' : 'Browse avatars' }),
				el('span', { className: 'ee-picker-action', textContent: 'Open' }),
			);
			avatarTrigger.classList.remove('is-selected', 'is-missing');
			avatarTrigger.setAttribute('aria-label', 'Browse avatars');
		}
	}

	async function openPicker() {
		const avatar = await openAvatarPicker({
			source: 'both',
			selectedId: cfg.avatar,
			showModes: false,
			title: cfg.mode === 'chat' ? 'Choose an agent' : 'Choose an avatar',
			ctaLabel: 'Use this avatar',
		});
		if (!avatar) return;
		cfg.avatar = avatar.id;
		cfg.avatarMeta = { name: avatar.name, thumbnail_url: avatar.thumbnail_url };
		cfg.avatarMissing = false; // gallery picks are always real, embeddable records
		avatarInput.value = avatar.id;
		renderTrigger();
		sync();
	}

	// Resolve name + thumbnail for a deep-linked or pasted ID so the trigger
	// shows a real chip instead of a bare UUID. Token guards against races.
	// Tries avatar first; falls back to agent (marketplace) so chat-mode deep
	// links from agent pages show the agent name/thumbnail instead of a bare ID.
	let _metaToken = 0;
	async function resolveAvatarMeta(id) {
		const token = ++_metaToken;
		// Direct model URLs have no avatar record to fetch — name the chip from
		// the file itself so the deep-linked handoff reads as the user's model.
		if (isModelUrl(id)) {
			cfg.avatarMeta = { name: modelUrlName(id), thumbnail_url: null };
			cfg.avatarMissing = false;
			renderTrigger();
			return;
		}
		try {
			const res = await fetch(`/api/avatars/${encodeURIComponent(id)}`, { credentials: 'include' });
			if (res.ok) {
				const { avatar } = await res.json();
				if (token !== _metaToken || cfg.avatar !== id || !avatar) return;
				cfg.avatarMeta = { name: avatar.name, thumbnail_url: avatar.thumbnail_url };
				cfg.avatarMissing = false;
				renderTrigger();
				renderWarning();
				return;
			}
		} catch { /* fall through to agent lookup */ }
		// Avatar lookup failed — try resolving as an agent identity
		try {
			const res = await fetch(`/api/marketplace/agents/${encodeURIComponent(id)}`, { credentials: 'include' });
			if (res.ok) {
				const { agent } = await res.json();
				if (token !== _metaToken || cfg.avatar !== id || !agent) return;
				cfg.avatarMeta = { name: agent.name, thumbnail_url: agent.avatar_thumbnail_url || null };
				cfg.avatarMissing = false;
				// Agent IDs default to chat mode if no mode was pre-set
				if (!opts.mode && cfg.mode !== 'chat') {
					cfg.mode = 'chat';
					sync(); // updates mode buttons, snippet, and preview
				}
				renderTrigger();
				renderWarning();
				return;
			}
		} catch { /* fall through to the not-found state */ }
		// Neither an avatar nor an agent resolved for this id. Surface an
		// actionable not-found state instead of silently keeping a dead id —
		// the live preview still renders the default body (the runtime falls
		// back), but the editor now tells the user why and what to do.
		if (token !== _metaToken || cfg.avatar !== id) return;
		cfg.avatarMissing = true;
		renderTrigger();
		renderWarning();
	}

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

	// Speed (avatar modes) — walk-pace multiplier baked into ?speed=.
	const speedWrap = el('div', { className: 'ee-bgrow' });
	const speedInput = el('input', { type: 'range', min: '0.3', max: '3', step: '0.1', value: String(cfg.speed), className: 'ee-range' });
	const speedVal = el('span', { className: 'ee-rangeval', textContent: `${cfg.speed.toFixed(1)}×` });
	speedInput.addEventListener('input', () => {
		cfg.speed = Math.min(3, Math.max(0.3, Number(speedInput.value) || 1));
		speedVal.textContent = `${cfg.speed.toFixed(1)}×`;
		sync();
	});
	speedWrap.append(speedInput, speedVal);
	const speedField = field('Walk speed', speedWrap);

	// A reusable on/off toggle row for the boolean embed options below.
	function toggleField(labelText, id, checked, hint, onChange) {
		const wrap = el('div', { className: 'ee-bgrow' });
		const box = el('input', { type: 'checkbox', id, checked });
		const lab = el('label', { htmlFor: id, className: 'ee-checklabel', textContent: hint });
		box.addEventListener('change', () => { onChange(box.checked); sync(); });
		wrap.append(box, lab);
		return field(labelText, wrap);
	}

	const groundField = toggleField('Ground', 'ee-ground', cfg.ground,
		'Show the ground disc + shadow', (v) => { cfg.ground = v; });
	const gesturesField = toggleField('Gestures', 'ee-gestures', cfg.gestures,
		'Show wave / jump buttons to visitors', (v) => { cfg.gestures = v; });
	const badgeField = toggleField('Badge', 'ee-badge', cfg.badge,
		'Show the three.ws badge', (v) => { cfg.badge = v; });
	const responsiveField = toggleField('Responsive', 'ee-responsive', cfg.responsive,
		'Fluid width (fills its container)', (v) => { cfg.responsive = v; });

	panel.append(avatarField, controlsField, envField, bgField, sizeField, dimField, autoplayField, speedField, groundField, gesturesField, badgeField, responsiveField);

	// ── Right: preview + snippet ────────────────────────────────────────────
	const previewWrap = el('div', { className: 'ee-preview-wrap' });

	const previewBar = el('div', { className: 'ee-bar' }, [
		el('span', { className: 'ee-bar-title', textContent: 'Live preview' }),
		el('span', { className: 'ee-bar-note', textContent: 'rendered from the real embed runtime' }),
	]);
	const previewFrame = el('div', { className: 'ee-stage' });
	const previewEmpty = el('div', { className: 'ee-empty' });
	// Surfaced when a pasted/deep-linked id resolves to neither an avatar nor an
	// agent. Hidden by default (the hidden-guard style makes [hidden] authoritative).
	const previewWarn = el('div', { className: 'ee-warn', role: 'status', hidden: true });

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

	// ── Platform instructions ─────────────────────────────────────────────────
	const PLATFORMS = [
		{ id: 'html',      label: 'HTML' },
		{ id: 'react',     label: 'React' },
		{ id: 'wordpress', label: 'WordPress' },
		{ id: 'webflow',   label: 'Webflow' },
		{ id: 'shopify',   label: 'Shopify' },
	];
	const PLATFORM_INSTRUCTIONS = {
		html:      'Paste the snippet anywhere inside your HTML file, between <body> tags. Works in any static site, Squarespace, Wix, or raw HTML.',
		react:     'In your React component, render a <div> with a ref and inject the iframe via dangerouslySetInnerHTML, or just paste the snippet verbatim into a JSX block using the <div dangerouslySetInnerHTML={{ __html: \`...\` }} /> pattern.',
		wordpress: '1. Open a page or post editor → click + to add a block → search "Custom HTML". 2. Paste the snippet into the block. 3. Click Preview or Publish.',
		webflow:   '1. Open your page in the Webflow Designer. 2. Add an Embed block (press A → search "Embed"). 3. Paste the snippet and click Save & Close. 4. Publish.',
		shopify:   '1. In your Shopify admin, go to Online Store → Themes → Customize. 2. Add a Custom HTML section where you want the avatar. 3. Paste the snippet. 4. Save.',
	};

	let activePlatform = 'html';
	const platformBar = el('div', { className: 'ee-bar ee-platform-bar' }, [
		el('span', { className: 'ee-bar-title', textContent: 'Where to paste' }),
	]);
	const platformTabs = el('div', { className: 'ee-segment ee-segment-sm ee-platform-tabs' });
	const platformNote = el('p', { className: 'ee-platform-note', textContent: PLATFORM_INSTRUCTIONS.html });

	const platformBtns = new Map();
	for (const p of PLATFORMS) {
		const b = el('button', { type: 'button', className: 'ee-seg-btn', textContent: p.label });
		b.addEventListener('click', () => {
			activePlatform = p.id;
			platformBtns.forEach((btn, id) => btn.classList.toggle('is-active', id === p.id));
			platformNote.textContent = PLATFORM_INSTRUCTIONS[p.id];
		});
		platformBtns.set(p.id, b);
		platformTabs.appendChild(b);
	}
	platformBtns.get('html').classList.add('is-active');

	const platformSection = el('div', { className: 'ee-platform-section' }, [platformBar, platformTabs, platformNote]);
	previewWrap.append(previewBar, previewWarn, previewFrame, snippetBar, snippetBox, copyBtn, platformSection);

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
		// Avatar-runtime-only knobs (walk-embed params); chat is a plain agent iframe.
		speedField.style.display = isAvatar ? '' : 'none';
		groundField.style.display = isAvatar ? '' : 'none';
		gesturesField.style.display = isAvatar ? '' : 'none';
		badgeField.style.display = isAvatar ? '' : 'none';
		// Responsive layout applies to every snippet (chat included).
		responsiveField.style.display = '';
		// Size applies to every mode — all runtimes render a sized iframe.
		sizeField.style.display = '';
		dimField.style.display = '';
		// Chat is a plain iframe to the agent page — no iframe/script choice.
		variantRow.style.display = isAvatar ? '' : 'none';

		reflectUrl();

		renderTrigger();
		renderWarning();
		snippetBox.value = buildSnippet(cfg);
		renderPreview();
	}

	// Actionable not-found banner. Only meaningful for bare ids (a model URL has
	// no record to resolve, and chat needs a real agent id either way).
	function renderWarning() {
		const missing = !!(cfg.avatarMissing && cfg.avatar && !isModelUrl(cfg.avatar));
		previewWarn.hidden = !missing;
		if (!missing) return;
		previewWarn.textContent = cfg.mode === 'chat'
			? "That agent ID couldn't be found. Chat embeds need a public agent — pick one from the gallery above."
			: "That avatar ID couldn't be found, or it isn't public. The preview falls back to the default avatar; pick a public or unlisted avatar from the gallery above to embed your own.";
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
		// A bare model URL has no agent behind it — chat needs a real agent id.
		if (cfg.mode === 'chat' && isModelUrl(cfg.avatar)) {
			previewEmpty.textContent = 'Chat embeds need an agent — pick one from the gallery above.';
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
			if (cfg.speed !== 1) q.set('speed', String(cfg.speed)); else q.delete('speed');
			if (!cfg.ground) q.set('ground', 'false'); else q.delete('ground');
			if (cfg.gestures) q.set('gestures', 'true'); else q.delete('gestures');
			if (!cfg.badge) q.set('badge', 'false'); else q.delete('badge');
		} else {
			q.delete('env'); q.delete('bg'); q.delete('speed');
			q.delete('ground'); q.delete('gestures'); q.delete('badge');
		}
		if (cfg.mode === 'walking') { q.set('controls', cfg.controls); q.set('autoplay', String(cfg.autoplay)); }
		else { q.delete('controls'); q.delete('autoplay'); }
		history.replaceState(null, '', url);
	}

	if (cfg.avatar) resolveAvatarMeta(cfg.avatar);
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
	// Only serialize non-default runtime knobs so the URL stays clean.
	if (cfg.speed && cfg.speed !== 1) q.set('speed', String(cfg.speed));
	if (cfg.ground === false) q.set('ground', 'false');
	if (cfg.gestures) q.set('gestures', 'true');
	if (cfg.badge === false) q.set('badge', 'false');
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
	if (cfg.mode === 'chat' && isModelUrl(cfg.avatar)) {
		return '<!-- Chat embeds need an agent id — pick an agent from the gallery above -->';
	}
	if (cfg.mode === 'chat') {
		return iframeSnippet(cfg, chatSrc(cfg), 'microphone; autoplay; clipboard-write');
	}
	if (cfg.snippetVariant === 'script') {
		const attrs = [
			`src="${ORIGIN}/walk-embed-sdk.js"`,
			`data-avatar="${esc(cfg.avatar)}"`,
			cfg.mode === 'walking' ? `data-controls="${cfg.controls}"` : `data-controls="none"`,
			cfg.bg !== 'transparent' ? `data-bg="${cfg.bg}"` : null,
			cfg.env !== 'studio' ? `data-env="${cfg.env}"` : null,
			autoplayFor(cfg) ? `data-autoplay="true"` : null,
			cfg.speed !== 1 ? `data-speed="${cfg.speed}"` : null,
			cfg.ground === false ? `data-ground="false"` : null,
			cfg.gestures ? `data-gestures="true"` : null,
			cfg.badge === false ? `data-badge="false"` : null,
			`data-width="${cfg.width}"`,
			`data-height="${cfg.height}"`,
		].filter(Boolean);
		return `<script\n  ${attrs.join('\n  ')}><\/script>`;
	}
	// iframe variant
	return iframeSnippet(cfg, walkSrc(cfg), 'accelerometer; gyroscope; autoplay');
}

// Build an <iframe> snippet. Fixed-pixel by default; when cfg.responsive is set,
// wrap it in an aspect-ratio box so it fills its container fluidly (the layout
// most modern sites actually need). referrerpolicy keeps the host's full URL out
// of our logs — only the origin is sent.
function iframeSnippet(cfg, src, allow) {
	if (cfg.responsive) {
		const ratio = `${cfg.width} / ${cfg.height}`;
		return `<div style="position:relative;width:100%;max-width:${cfg.width}px;aspect-ratio:${ratio}">\n  <iframe\n    src="${src}"\n    style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:16px"\n    allow="${allow}"\n    referrerpolicy="strict-origin-when-cross-origin"\n    loading="lazy"><\/iframe>\n</div>`;
	}
	return `<iframe\n  src="${src}"\n  width="${cfg.width}"\n  height="${cfg.height}"\n  style="border:0;border-radius:16px"\n  allow="${allow}"\n  referrerpolicy="strict-origin-when-cross-origin"\n  loading="lazy"><\/iframe>`;
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
	if (opts.speed != null && opts.speed !== '') {
		const n = Number(opts.speed);
		if (Number.isFinite(n)) out.speed = Math.min(3, Math.max(0.3, n));
	}
	if (opts.ground != null && opts.ground !== '') out.ground = !(opts.ground === false || opts.ground === 'false');
	if (opts.gestures != null && opts.gestures !== '') out.gestures = opts.gestures === true || opts.gestures === 'true';
	if (opts.badge != null && opts.badge !== '') out.badge = !(opts.badge === false || opts.badge === 'false');
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
		.ee-crossline { margin:-14px 0 22px; }
		.ee-crosslink { color:#a1a1aa; text-decoration:none; border-bottom:1px solid #3a3f47; transition:color .15s ease, border-color .15s ease; }
		.ee-crosslink:hover, .ee-crosslink:focus-visible { color:#fff; border-color:#fff; }
		.ee-crosslink:focus-visible { outline:2px solid #6366f1; outline-offset:3px; border-radius:2px; }
		.ee-field { display:block; margin-bottom:16px; }
		.ee-label { display:block; font-size:12px; color:#a1a1aa; margin-bottom:7px; font-weight:600; }
		.ee-hint { font-size:12px; color:#71717a; margin:-8px 0 16px; min-height:16px; line-height:1.4; }
		.embed-editor input[type=text], .embed-editor input[type=number], .embed-editor select {
			width:100%; padding:9px 11px; background:#15181d; border:1px solid #2a2f37;
			border-radius:8px; color:#fff; font-size:13px; outline:none; font-family:inherit;
			transition:border-color .15s ease;
		}
		.embed-editor input:focus, .embed-editor select:focus { border-color:#6366f1; }
		.ee-pickerwrap { display:flex; flex-direction:column; gap:8px; }
		.ee-picker {
			display:flex; align-items:center; gap:10px; width:100%; padding:8px 10px; min-height:48px;
			background:#15181d; border:1px solid #2a2f37; border-radius:10px; color:#fff;
			font-family:inherit; font-size:13px; cursor:pointer; text-align:left;
			transition:border-color .15s ease, background .15s ease;
		}
		.ee-picker:hover { border-color:#3a4250; background:#181c22; }
		.ee-picker:focus-visible { outline:2px solid #6366f1; outline-offset:2px; }
		.ee-picker.is-selected { border-color:#2f3845; }
		.ee-picker-icon { display:flex; align-items:center; justify-content:center; width:32px; height:32px; flex:0 0 auto; border-radius:8px; background:#1f242c; color:#888888; }
		.ee-picker-thumb { width:32px; height:32px; flex:0 0 auto; border-radius:8px; object-fit:cover; background:#1f242c; }
		.ee-picker-thumb--ph { background:linear-gradient(135deg,#1f242c,#2a3340); }
		.ee-picker-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.ee-picker.is-selected .ee-picker-name { color:#e4e4e7; font-weight:600; }
		.ee-picker:not(.is-selected) .ee-picker-name { color:#a1a1aa; font-weight:500; }
		.ee-picker-action { flex:0 0 auto; font-size:11px; font-weight:600; color:#888888; padding:3px 9px; border-radius:6px; background:#1f242c; }
		.ee-picker:hover .ee-picker-action { color:#aaaaaa; }
		.ee-idinput { font-size:12px !important; padding:7px 11px !important; }
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
		.ee-range { flex:1; accent-color:#6366f1; cursor:pointer; height:4px; }
		.ee-rangeval { flex:0 0 auto; min-width:34px; text-align:right; font-size:12px; font-weight:600; color:#d4d4d8; font-variant-numeric:tabular-nums; }
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
		.ee-picker.is-missing { border-color:rgba(239,68,68,0.5); background:rgba(239,68,68,0.06); }
		.ee-picker.is-missing .ee-picker-action { color:#fca5a5; background:rgba(239,68,68,0.16); }
		.ee-warn { font-size:12.5px; line-height:1.5; color:#fca5a5; background:rgba(239,68,68,0.09); border:1px solid rgba(239,68,68,0.34); border-radius:9px; padding:9px 13px; margin:0; }
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
		.ee-platform-section { display:flex; flex-direction:column; gap:10px; border-top:1px solid #1c2026; padding-top:14px; }
		.ee-platform-bar { margin-bottom:0; }
		.ee-platform-tabs { flex-wrap:wrap; }
		.ee-platform-tabs .ee-seg-btn { padding:5px 10px; font-size:11.5px; flex:none; }
		.ee-platform-note { font-size:12.5px; color:#71717a; line-height:1.6; margin:0; padding:12px 14px; background:#0a0c0f; border:1px solid #1c2026; border-radius:9px; }
		@media (max-width:860px) {
			.embed-editor { grid-template-columns:1fr; height:auto; }
			.ee-panel { border-right:none; border-bottom:1px solid #1c2026; }
			.ee-stage { min-height:360px; }
		}
	`;
	document.head.appendChild(s);
}

export { mountEmbedEditor };
