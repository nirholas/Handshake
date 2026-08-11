// Render Lab: live composer for the public avatar render API.
//
// The premise: every control on this page is one parameter of a real request,
// and the page never lets you build a request the selected model cannot honor.
// Before the first render it asks GET /api/avatar/capabilities what the GLB
// actually carries, then builds the expression sliders out of the ARKit shapes
// that exist on THAT model and switches the pose panel off (with the reason)
// when the skeleton will not retarget. That is the difference between a form
// and a lab: nothing here silently no-ops.
//
// Two model sources, both fully live:
//   • a three.ws avatar id  → GET  /api/avatar/render        (cacheable image URL)
//   • any public .glb URL   → POST /api/render/avatar-clip   (raw GLB renderer)
// The code panel emits the call for whichever source is active, so what you
// copy is what the page just ran.

const $ = (id) => document.getElementById(id);

const SCENES = [
	{ id: 'headshot', label: 'Headshot', tip: 'Tight on the face. Best for profile pictures and comment avatars.' },
	{ id: 'portrait', label: 'Portrait', tip: 'Head and shoulders. The most forgiving framing for any rig.' },
	{ id: 'upper-body', label: 'Upper body', tip: 'Waist up. The API default.' },
	{ id: 'full-body', label: 'Full body', tip: 'Head to toe. Use this when the pose is the point.' },
];

// Curated starting points. Every weight below names a canonical ARKit-52 shape,
// so a model that reports the shape will move; one that does not is filtered
// out of the preset before it is offered.
const EXPRESSION_PRESETS = [
	{ id: 'neutral', label: 'Neutral', weights: {} },
	{ id: 'smile', label: 'Smile', weights: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7, cheekSquintLeft: 0.3, cheekSquintRight: 0.3 } },
	{ id: 'grin', label: 'Grin', weights: { mouthSmileLeft: 1, mouthSmileRight: 1, jawOpen: 0.28, eyeSquintLeft: 0.45, eyeSquintRight: 0.45 } },
	{ id: 'surprise', label: 'Surprise', weights: { jawOpen: 0.55, browInnerUp: 0.85, browOuterUpLeft: 0.7, browOuterUpRight: 0.7, eyeWideLeft: 0.6, eyeWideRight: 0.6 } },
	{ id: 'skeptical', label: 'Skeptical', weights: { browDownLeft: 0.6, browOuterUpRight: 0.7, mouthPressLeft: 0.4, eyeSquintLeft: 0.35 } },
	{ id: 'sad', label: 'Sad', weights: { mouthFrownLeft: 0.65, mouthFrownRight: 0.65, browInnerUp: 0.6, eyeLookDownLeft: 0.4, eyeLookDownRight: 0.4 } },
	{ id: 'wink', label: 'Wink', weights: { eyeBlinkLeft: 1, mouthSmileLeft: 0.6, mouthSmileRight: 0.35 } },
	{ id: 'speak', label: 'Mid-speech', weights: { jawOpen: 0.42, mouthFunnel: 0.3, browInnerUp: 0.25 } },
];

// Order the sliders the way a face reads, not the way the spec lists them.
const MORPH_GROUPS = [
	{ id: 'brow', label: 'Brows', test: (n) => n.startsWith('brow') },
	{ id: 'eye', label: 'Eyes', test: (n) => n.startsWith('eye') },
	{ id: 'jaw', label: 'Jaw', test: (n) => n.startsWith('jaw') },
	{ id: 'mouth', label: 'Mouth', test: (n) => n.startsWith('mouth') },
	{ id: 'face', label: 'Cheeks & nose', test: (n) => n.startsWith('cheek') || n.startsWith('nose') || n === 'tongueOut' },
];

const DEFAULTS = Object.freeze({
	scene: 'upper-body',
	size: 512,
	bg: 'transparent',
	format: 'png',
	quality: 90,
	pose: '',
});

const state = {
	source: null, // { kind: 'avatar', id, name } | { kind: 'url', url }
	...DEFAULTS,
	expression: {},
};

let capabilities = null;
let poseCatalog = [];
let avatars = [];
let codeLang = 'url';
let sheetAxis = 'scene';
let renderToken = 0;
let lastImageUrl = '';
let objectUrl = null;

const origin = location.origin;

// ── utilities ────────────────────────────────────────────────────────

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer = null;
function toast(message) {
	let el = document.querySelector('.rl-toast');
	if (!el) {
		el = document.createElement('div');
		el.className = 'rl-toast';
		el.setAttribute('role', 'status');
		el.setAttribute('aria-live', 'polite');
		document.body.appendChild(el);
	}
	el.textContent = message;
	requestAnimationFrame(() => el.classList.add('is-on'));
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove('is-on'), 2200);
}

async function copy(text, label) {
	try {
		await navigator.clipboard.writeText(text);
		toast(`${label} copied`);
	} catch {
		// Clipboard access is denied in some embedded and non-secure contexts;
		// a selectable prompt still gets the user their text.
		window.prompt(`Copy ${label}:`, text);
	}
}

function debounce(fn, ms) {
	let t = null;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

// Mirror every tooltip into title= so touch and screen-reader users get the
// same explanation the hover card carries.
function mirrorTips(root = document) {
	for (const el of root.querySelectorAll('[data-tip]:not([title])')) {
		el.setAttribute('title', el.getAttribute('data-tip'));
	}
}

// ── request building ─────────────────────────────────────────────────

function activeExpression() {
	const out = {};
	for (const [name, weight] of Object.entries(state.expression)) {
		if (weight > 0) out[name] = Number(weight.toFixed(2));
	}
	return out;
}

function renderParams() {
	const p = new URLSearchParams();
	if (state.source?.kind === 'avatar') p.set('avatar', state.source.id);
	if (state.scene !== DEFAULTS.scene) p.set('scene', state.scene);
	if (state.size !== DEFAULTS.size) p.set('size', String(state.size));
	if (state.bg !== DEFAULTS.bg) p.set('bg', state.bg);
	if (state.pose) p.set('pose', state.pose);
	const expr = activeExpression();
	if (Object.keys(expr).length) p.set('expression', JSON.stringify(expr));
	if (state.format !== DEFAULTS.format) p.set('format', state.format);
	if (state.format !== 'png' && state.quality !== DEFAULTS.quality) p.set('quality', String(state.quality));
	return p;
}

function renderUrl(overrides = {}) {
	const p = renderParams();
	for (const [k, v] of Object.entries(overrides)) {
		if (v === null || v === undefined || v === '') p.delete(k);
		else p.set(k, String(v));
	}
	return `/api/avatar/render?${p.toString()}`;
}

// The raw-GLB renderer takes a JSON body rather than a query string, and its
// camera is an orbit rather than a named scene, so the framing presets map
// onto phi/radius here. Values match SCENE_PRESETS in api/_lib/avatar-render.js.
const ORBIT_FOR_SCENE = {
	headshot: { theta: 0, phi: 82, radius: 0.55 },
	portrait: { theta: 0, phi: 82, radius: 0.95 },
	'upper-body': { theta: 0, phi: 84, radius: 1.6 },
	'full-body': { theta: 0, phi: 88, radius: 3.1 },
};

function clipBody(overrides = {}) {
	const merged = { ...state, ...overrides };
	const expr = overrides.expression ? overrides.expression : activeExpression();
	const body = {
		glbUrl: state.source?.url,
		width: merged.size,
		height: merged.size,
		background: merged.bg === 'transparent' ? 'transparent' : merged.bg,
		cameraOrbit: ORBIT_FOR_SCENE[merged.scene] || ORBIT_FOR_SCENE['upper-body'],
	};
	if (merged.pose) body.posePresetId = merged.pose;
	if (Object.keys(expr).length) body.expression = expr;
	return body;
}

// ── capability card ──────────────────────────────────────────────────

function meter(label, value, tip) {
	const pct = Math.round(value * 100);
	const cls = pct === 0 ? 'is-none' : pct < 50 ? 'is-low' : '';
	return `
		<div class="rl-meter" ${tip ? `data-tip="${esc(tip)}"` : ''}>
			<div class="rl-meter-top"><span>${esc(label)}</span><b>${pct}%</b></div>
			<div class="rl-meter-track"><div class="rl-meter-fill ${cls}" style="width:${pct}%"></div></div>
		</div>`;
}

function verdictRow(name, verdict) {
	const status = verdict.supported ? (verdict.degraded ? 'partial' : 'yes') : verdict.partial ? 'partial' : 'no';
	const icon = status === 'yes' ? '✓' : status === 'partial' ? '△' : '✕';
	return `
		<li class="rl-verdict is-${status}">
			<span class="rl-verdict-icon" aria-hidden="true">${icon}</span>
			<span><strong>${esc(name)}</strong>${esc(verdict.reason)}</span>
		</li>`;
}

function renderCapabilities() {
	const panel = $('capPanel');
	if (!capabilities) {
		panel.hidden = true;
		return;
	}
	panel.hidden = false;

	const { rig, morphs, geometry, can } = capabilities;
	$('capHead').innerHTML = [
		`<span class="rl-tag" data-tip="Authoring pipeline inferred from the bone naming convention and the glTF generator string.">rig <b>${esc(rig.label)}</b></span>`,
		`<span class="rl-tag" data-tip="Joints in the skeleton, across every skin in the file.">bones <b>${rig.boneCount}</b></span>`,
		`<span class="rl-tag" data-tip="Triangle count across every mesh primitive. Under ~60k renders comfortably everywhere, including mobile.">tris <b>${geometry.triangles.toLocaleString()}</b></span>`,
		`<span class="rl-tag" data-tip="Named morph targets in the file, including custom shapes outside the ARKit set.">morphs <b>${morphs.total}</b></span>`,
	].join('');

	$('capMeters').innerHTML =
		meter('Canonical skeleton', rig.canonicalCoverage, 'Share of the 53-bone canonical humanoid skeleton this rig maps onto. Above 50% with all core bones present, every baked animation clip retargets.') +
		meter('ARKit-52 shapes', morphs.arkitCoverage, 'Share of Apple’s 52 facial blendshapes present on this model. Anything missing is reported back in the x-render-expression-missing header.');

	$('capVerdicts').innerHTML =
		verdictRow('Poses', can.pose) + verdictRow('Expressions', can.expression) + verdictRow('Lipsync', can.lipsync);

	mirrorTips(panel);
}

// ── controls ─────────────────────────────────────────────────────────

function renderSceneChips() {
	$('sceneChips').innerHTML = SCENES.map(
		(s) => `<button type="button" class="rl-chip" role="radio" data-scene="${s.id}" data-tip="${esc(s.tip)}" aria-checked="${state.scene === s.id}">${esc(s.label)}</button>`,
	).join('');
	mirrorTips($('sceneChips'));
}

function renderPoseChips() {
	const supported = capabilities ? capabilities.can.pose.supported : true;
	const panel = $('posePanel');
	panel.dataset.disabled = String(!supported);

	const stateEl = $('poseState');
	if (!capabilities) {
		stateEl.textContent = '';
		stateEl.className = 'rl-panel-state';
	} else {
		stateEl.textContent = supported ? 'available' : 'unavailable';
		stateEl.className = `rl-panel-state ${supported ? 'is-ok' : 'is-off'}`;
		stateEl.setAttribute('data-tip', capabilities.can.pose.reason);
	}

	if (!supported && capabilities) {
		$('poseChips').innerHTML = `<p class="rl-empty">${esc(capabilities.can.pose.reason)} <a href="/rig-doctor">Diagnose the skeleton in Rig Doctor</a>.</p>`;
		mirrorTips(panel);
		return;
	}

	const groups = new Map();
	for (const p of poseCatalog) {
		if (!groups.has(p.group)) groups.set(p.group, []);
		groups.get(p.group).push(p);
	}
	let html = `<button type="button" class="rl-chip" role="radio" data-pose="" data-tip="No pose parameter: the model renders in whatever pose its own baked animation or bind pose puts it in." aria-checked="${!state.pose}">None</button>`;
	for (const [group, poses] of groups) {
		html += `<span class="rl-chip-group">${esc(group)}</span>`;
		html += poses
			.map((p) => `<button type="button" class="rl-chip" role="radio" data-pose="${esc(p.id)}" aria-checked="${state.pose === p.id}">${esc(p.label)}</button>`)
			.join('');
	}
	$('poseChips').innerHTML = html;
	mirrorTips(panel);
}

function supportedMorphs() {
	if (!capabilities) return [];
	return capabilities.morphs.supported;
}

function renderExpressionControls() {
	const panel = $('exprPanel');
	const shapes = supportedMorphs();
	const supported = capabilities ? capabilities.can.expression.supported : true;
	panel.dataset.disabled = String(capabilities ? !shapes.length : false);

	const stateEl = $('exprState');
	if (!capabilities) {
		stateEl.textContent = '';
		stateEl.className = 'rl-panel-state';
	} else {
		stateEl.textContent = shapes.length ? `${shapes.length} shapes` : 'unavailable';
		stateEl.className = `rl-panel-state ${supported ? 'is-ok' : 'is-off'}`;
		stateEl.setAttribute('data-tip', capabilities.can.expression.reason);
	}

	const empty = $('exprEmpty');
	if (capabilities && !shapes.length) {
		empty.hidden = false;
		empty.innerHTML = `${esc(capabilities.can.expression.reason)} Try <button type="button" class="rl-chip" data-pick-morphy>a model with a full face rig</button>.`;
		$('exprPresets').innerHTML = '';
		$('exprSliders').innerHTML = '';
		mirrorTips(panel);
		return;
	}
	empty.hidden = true;

	// Only offer a preset whose shapes this model can actually move, and label
	// how much of it will land when it is partially supported.
	const available = new Set(shapes);
	$('exprPresets').innerHTML = EXPRESSION_PRESETS.map((preset) => {
		const names = Object.keys(preset.weights);
		const hit = names.filter((n) => !capabilities || available.has(n));
		if (names.length && capabilities && !hit.length) return '';
		const partial = names.length && hit.length < names.length;
		const tip = partial
			? `${hit.length} of ${names.length} shapes in this preset exist on the model; the rest are dropped.`
			: names.length
				? `Sets ${names.length} morph target${names.length === 1 ? '' : 's'}.`
				: 'Clear every morph weight.';
		return `<button type="button" class="rl-chip" data-preset="${preset.id}" data-tip="${esc(tip)}">${esc(preset.label)}${partial ? ' · partial' : ''}</button>`;
	}).join('');

	const list = capabilities ? shapes : [];
	let html = '';
	for (const group of MORPH_GROUPS) {
		const inGroup = list.filter((n) => group.test(n));
		if (!inGroup.length) continue;
		html += `<span class="rl-chip-group">${esc(group.label)}</span>`;
		html += inGroup
			.map((name) => {
				const value = state.expression[name] || 0;
				return `
					<div class="rl-slider-row">
						<label for="m-${esc(name)}">${esc(name)}</label>
						<span class="rl-slider-val" id="v-${esc(name)}">${value.toFixed(2)}</span>
						<input type="range" id="m-${esc(name)}" data-morph="${esc(name)}" min="0" max="1" step="0.05" value="${value}" />
					</div>`;
			})
			.join('');
	}
	$('exprSliders').innerHTML = html || '<p class="rl-empty">Select a model to load its facial shapes.</p>';
	mirrorTips(panel);
}

function renderAvatarStrip() {
	$('avatarStrip').innerHTML = avatars
		.map(
			(a) => `
			<button type="button" class="rl-av" role="radio" data-avatar="${esc(a.id)}" aria-checked="${state.source?.id === a.id}" title="${esc(a.name)}">
				<img src="${esc(a.thumb_url)}" alt="" loading="lazy" width="74" height="74" />
				<span class="rl-av-name">${esc(a.name)}</span>
			</button>`,
		)
		.join('');
}

function syncChipStates() {
	for (const el of document.querySelectorAll('[data-scene]')) {
		el.setAttribute('aria-checked', String(el.dataset.scene === state.scene));
	}
	for (const el of document.querySelectorAll('[data-pose]')) {
		el.setAttribute('aria-checked', String(el.dataset.pose === state.pose));
	}
	for (const el of document.querySelectorAll('[data-avatar]')) {
		el.setAttribute('aria-checked', String(el.dataset.avatar === state.source?.id));
	}
}

// ── code panel ───────────────────────────────────────────────────────

function codeFor(lang) {
	const isUrl = state.source?.kind === 'url';
	const absolute = `${origin}${renderUrl()}`;
	const expr = activeExpression();

	if (isUrl) {
		const body = JSON.stringify(clipBody(), null, 2);
		if (lang === 'curl') {
			return `curl -s -X POST ${origin}/api/render/avatar-clip \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(clipBody())}' \\\n  -o avatar.png`;
		}
		if (lang === 'js') {
			return `const res = await fetch('${origin}/api/render/avatar-clip', {\n  method: 'POST',\n  headers: { 'content-type': 'application/json' },\n  body: JSON.stringify(${body.replace(/\n/g, '\n  ')}),\n});\nconst blob = await res.blob();`;
		}
		if (lang === 'mcp') {
			return [
				'// The MCP tool render_avatar_image renders a STORED avatar by id.',
				'// A raw GLB URL has no id, so save it as an avatar first, or call',
				'// POST /api/render/avatar-clip directly (see the curl and JS tabs).',
				`// Capability check works on any URL right now:`,
				`//   GET ${origin}/api/avatar/capabilities?url=${encodeURIComponent(state.source.url)}`,
			].join('\n');
		}
		if (lang === 'component') {
			return `<script type="module" src="${origin}/agent-3d/latest/agent-3d.js"><\/script>\n<agent-3d\n  src="${state.source.url}"\n  style="width: ${state.size}px; height: ${state.size}px; display: block;"\n></agent-3d>`;
		}
		if (lang === 'html') {
			return `<!-- POST /api/render/avatar-clip returns image bytes, so render it\n     server-side and serve the result, or fetch it into an object URL. -->\n<img src="/your-cached-render.png" alt="" width="${state.size}" height="${state.size}" loading="lazy" />`;
		}
		return `POST ${origin}/api/render/avatar-clip\n\n${body}`;
	}

	const id = state.source?.id || 'AVATAR_ID';
	if (lang === 'html') {
		return `<img\n  src="${absolute}"\n  alt="${esc(state.source?.name || 'Avatar')}"\n  width="${state.size}"\n  height="${state.size}"\n  loading="lazy"\n/>`;
	}
	if (lang === 'curl') {
		return `curl -sL '${absolute}' -o avatar.${state.format}`;
	}
	if (lang === 'js') {
		return [
			'// Ask what the model supports before you build the request, so an',
			'// expression that cannot land never ships to production.',
			`const caps = await fetch('${origin}/api/avatar/capabilities?avatar=${id}').then((r) => r.json());`,
			'',
			`const expression = ${JSON.stringify(expr, null, 2)};`,
			'const usable = Object.fromEntries(',
			'  Object.entries(expression).filter(([shape]) => caps.morphs.supported.includes(shape)),',
			');',
			'',
			`const url = new URL('${origin}/api/avatar/render');`,
			`url.searchParams.set('avatar', '${id}');`,
			`url.searchParams.set('scene', '${state.scene}');`,
			`url.searchParams.set('size', '${state.size}');`,
			state.pose ? `url.searchParams.set('pose', '${state.pose}');` : null,
			'if (Object.keys(usable).length) url.searchParams.set(\'expression\', JSON.stringify(usable));',
			'',
			'const res = await fetch(url);',
			"// 'applied' | 'partial' | 'none': what the renderer could actually drive.",
			"console.log(res.headers.get('x-render-expression'));",
		]
			.filter((line) => line !== null)
			.join('\n');
	}
	if (lang === 'component') {
		return `<script type="module" src="${origin}/agent-3d/latest/agent-3d.js"><\/script>\n<agent-3d\n  avatar-id="${id}"\n  style="width: ${state.size}px; height: ${state.size}px; display: block;"\n></agent-3d>`;
	}
	if (lang === 'mcp') {
		const args = { avatar_id: id, scene: state.scene, size: state.size };
		if (state.pose) args.pose = state.pose;
		if (Object.keys(expr).length) args.expression = expr;
		if (state.bg !== DEFAULTS.bg) args.bg = state.bg;
		return `{\n  "tool": "render_avatar_image",\n  "arguments": ${JSON.stringify(args, null, 2).replace(/\n/g, '\n  ')}\n}`;
	}
	return absolute;
}

function renderCode() {
	$('codeOut').textContent = codeFor(codeLang);
	const notes = {
		url: 'Paste this straight into a browser, an <img> tag, or a game engine loader. Renders are cached on the CDN, keyed on these exact parameters.',
		html: 'Nothing to install: the endpoint is public and unauthenticated for public avatars.',
		curl: 'Follow redirects (-L): a cache hit answers with a 302 to the CDN copy.',
		js: 'The capability preflight is the point. It costs one cached JSON request and removes the whole class of "the expression did nothing" bugs.',
		component: 'The web component renders live, animated 3D rather than a still image. Install locally with npm i @three-ws/avatar, or use the CDN build above.',
		mcp: 'Call it from Claude, Cursor, or any MCP client pointed at https://three.ws/api/mcp.',
	};
	$('codeNote').textContent = notes[codeLang] || '';
}

// ── rendering ────────────────────────────────────────────────────────

function setStage(stateName, message) {
	const stage = $('stage');
	stage.dataset.state = stateName;
	if (message) $('stageMsg').textContent = message;
	$('stageImg').hidden = stateName !== 'ready';
}

function releaseObjectUrl() {
	if (objectUrl) {
		URL.revokeObjectURL(objectUrl);
		objectUrl = null;
	}
}

// Resolve when the image paints, reject with the API's own error message when
// it does not. An <img> failure carries no detail, so the rejection path asks
// the endpoint again with fetch(); an error response is same-origin JSON, so
// unlike the success path it is readable.
function loadImage(img, url) {
	return new Promise((resolve, reject) => {
		const onLoad = () => {
			cleanup();
			resolve();
		};
		const onError = async () => {
			cleanup();
			try {
				const res = await fetch(url, { redirect: 'follow' });
				const detail = await res.json().catch(() => ({}));
				reject(new Error(detail.error_description || detail.message || detail.error || `Render failed (${res.status}).`));
			} catch {
				reject(new Error('Render failed. The model may be too heavy for this size, or the endpoint is rate limited.'));
			}
		};
		const cleanup = () => {
			img.removeEventListener('load', onLoad);
			img.removeEventListener('error', onError);
		};
		img.addEventListener('load', onLoad);
		img.addEventListener('error', onError);
		img.src = url;
	});
}

// What the requested expression will actually do on the selected model, from
// the capability report. Mirrors the server's applied/partial/none semantics.
function expressionOutcome() {
	const requested = Object.keys(activeExpression());
	if (!requested.length) return null;
	if (!capabilities) return { state: 'unknown', missing: [] };
	const have = new Set(capabilities.morphs.supported);
	const missing = requested.filter((n) => !have.has(n));
	const stateName = missing.length === 0 ? 'applied' : missing.length === requested.length ? 'none' : 'partial';
	return { state: stateName, missing };
}

async function runRender() {
	if (!state.source) return;
	const token = ++renderToken;
	setStage('loading');
	$('stageMeta').textContent = 'rendering…';
	const started = performance.now();

	try {
		if (state.source.kind === 'url') {
			const res = await fetch('/api/render/avatar-clip', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(clipBody()),
			});
			if (!res.ok) {
				const detail = await res.json().catch(() => ({}));
				throw new Error(detail.message || detail.error || `render failed (${res.status})`);
			}
			const blob = await res.blob();
			if (token !== renderToken) return;
			releaseObjectUrl();
			objectUrl = URL.createObjectURL(blob);
			lastImageUrl = objectUrl;
			$('stageImg').src = objectUrl;
			$('btnOpen').href = objectUrl;
			$('stageMeta').textContent = `${state.size}px · ${Math.round(performance.now() - started)}ms · ${(blob.size / 1024).toFixed(0)}KB`;
		} else {
			// Load through the <img> element rather than fetch(): a cached render
			// answers 302 to the CDN, and that cross-origin hop has no CORS
			// headers, so fetch() fails on exactly the fast path. The image
			// loader follows the redirect the way a real caller's <img> does,
			// which is also the usage this page is teaching.
			const url = renderUrl();
			releaseObjectUrl();
			lastImageUrl = `${origin}${url}`;
			await loadImage($('stageImg'), url);
			if (token !== renderToken) return;
			$('btnOpen').href = url;

			// The renderer publishes an x-render-expression header, but an <img>
			// cannot read headers. The verdict is derivable from the capability
			// report we already hold, and it is the same comparison the server
			// makes, so it is computed here instead of costing a second request.
			const bits = [`${state.size}px`, `${Math.round(performance.now() - started)}ms`];
			const verdict = expressionOutcome();
			if (verdict) bits.push(`expression ${verdict.state}`);
			$('stageMeta').textContent = bits.join(' · ');
			if (verdict?.missing.length) {
				toast(`Model has no: ${verdict.missing.slice(0, 3).join(', ')}`);
			}
		}
		if (token !== renderToken) return;
		$('stageImg').alt = `${state.source.name || 'Avatar'}, ${state.scene} framing${state.pose ? `, ${state.pose} pose` : ''}`;
		setStage('ready');
	} catch (err) {
		if (token !== renderToken) return;
		setStage('error', err.message || 'Render failed. Try a different model or a smaller size.');
		$('stageMeta').textContent = '';
	}
}

const queueRender = debounce(() => {
	runRender();
	renderCode();
	writeUrl();
}, 260);

function commit({ immediate = false } = {}) {
	renderCode();
	writeUrl();
	if (immediate) runRender();
	else queueRender();
}

// ── contact sheet ────────────────────────────────────────────────────

function sheetCells() {
	if (sheetAxis === 'scene') {
		return SCENES.map((s) => ({ label: s.label, overrides: { scene: s.id }, apply: () => (state.scene = s.id) }));
	}
	if (sheetAxis === 'pose') {
		if (capabilities && !capabilities.can.pose.supported) return [];
		return poseCatalog.slice(0, 24).map((p) => ({
			label: p.label,
			overrides: { pose: p.id },
			apply: () => (state.pose = p.id),
		}));
	}
	const shapes = new Set(supportedMorphs());
	return EXPRESSION_PRESETS.filter((preset) => {
		const names = Object.keys(preset.weights);
		return !names.length || !capabilities || names.some((n) => shapes.has(n));
	}).map((preset) => {
		const weights = Object.fromEntries(
			Object.entries(preset.weights).filter(([n]) => !capabilities || shapes.has(n)),
		);
		return {
			label: preset.label,
			overrides: { expression: Object.keys(weights).length ? JSON.stringify(weights) : null },
			apply: () => {
				state.expression = { ...weights };
			},
		};
	});
}

async function renderSheet() {
	const grid = $('sheetGrid');
	const note = $('sheetNote');
	const cells = sheetCells();

	if (!cells.length) {
		grid.innerHTML = '';
		note.textContent =
			sheetAxis === 'pose'
				? 'This model has no retargetable skeleton, so there are no poses to compare. Pick a rigged model to use this axis.'
				: 'This model carries no ARKit shapes, so there are no expressions to compare.';
		return;
	}

	const SHEET_SIZE = 256;
	note.textContent = `${cells.length} live renders at ${SHEET_SIZE}px. Click any tile to load it into the composer.`;
	grid.innerHTML = cells
		.map(
			(cell, i) => `
			<button type="button" class="rl-cell" data-cell="${i}" aria-label="Use ${esc(cell.label)}">
				<img alt="${esc(cell.label)}" loading="lazy" />
				<span class="rl-cell-label">${esc(cell.label)}</span>
			</button>`,
		)
		.join('');

	const imgs = [...grid.querySelectorAll('img')];
	if (state.source.kind === 'avatar') {
		cells.forEach((cell, i) => {
			const img = imgs[i];
			// Listener first: a CDN-cached tile can complete before the next
			// statement runs, and a load event fired before the listener attaches
			// would leave the tile permanently invisible.
			img.addEventListener('load', () => img.classList.add('is-in'), { once: true });
			img.addEventListener(
				'error',
				() => {
					img.closest('.rl-cell')?.classList.add('is-failed');
				},
				{ once: true },
			);
			img.src = renderUrl({ size: SHEET_SIZE, ...cell.overrides });
			if (img.complete && img.naturalWidth) img.classList.add('is-in');
		});
		return;
	}

	// The raw-GLB renderer is a POST, so tiles are fetched in a small pool
	// rather than by the browser's own image loader.
	let cursor = 0;
	const worker = async () => {
		while (cursor < cells.length) {
			const i = cursor++;
			const cell = cells[i];
			try {
				const overrides = { ...cell.overrides, size: SHEET_SIZE };
				if (typeof overrides.expression === 'string') overrides.expression = JSON.parse(overrides.expression);
				else if (overrides.expression === null) overrides.expression = {};
				const res = await fetch('/api/render/avatar-clip', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(clipBody(overrides)),
				});
				if (!res.ok) continue;
				const blob = await res.blob();
				imgs[i].src = URL.createObjectURL(blob);
				imgs[i].classList.add('is-in');
			} catch {
				// One failed tile must not abandon the sheet; the empty cell
				// still carries its label so the gap is legible.
			}
		}
	};
	await Promise.all([worker(), worker(), worker()]);
}

// ── permalink ────────────────────────────────────────────────────────

function writeUrl() {
	const p = new URLSearchParams();
	if (state.source?.kind === 'avatar') p.set('avatar', state.source.id);
	else if (state.source?.kind === 'url') p.set('url', state.source.url);
	if (state.scene !== DEFAULTS.scene) p.set('scene', state.scene);
	if (state.size !== DEFAULTS.size) p.set('size', String(state.size));
	if (state.bg !== DEFAULTS.bg) p.set('bg', state.bg);
	if (state.pose) p.set('pose', state.pose);
	if (state.format !== DEFAULTS.format) p.set('format', state.format);
	const expr = activeExpression();
	if (Object.keys(expr).length) p.set('expression', JSON.stringify(expr));
	const qs = p.toString();
	history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function readUrl() {
	const p = new URLSearchParams(location.search);
	if (p.get('scene') && SCENES.some((s) => s.id === p.get('scene'))) state.scene = p.get('scene');
	const size = Number(p.get('size'));
	if (size >= 128 && size <= 2048) state.size = size;
	if (p.get('bg')) state.bg = p.get('bg');
	if (p.get('pose')) state.pose = p.get('pose');
	if (['png', 'webp', 'jpeg'].includes(p.get('format'))) state.format = p.get('format');
	const expr = p.get('expression');
	if (expr) {
		try {
			const parsed = JSON.parse(expr);
			if (parsed && typeof parsed === 'object') {
				for (const [k, v] of Object.entries(parsed)) {
					const n = Number(v);
					if (n >= 0 && n <= 1) state.expression[k] = n;
				}
			}
		} catch {
			// A hand-edited or truncated permalink should open the lab at its
			// defaults, not blank it.
		}
	}
	return { avatar: p.get('avatar'), url: p.get('url') };
}

// ── model loading ────────────────────────────────────────────────────

async function loadCapabilities(query) {
	capabilities = null;
	renderCapabilities();
	try {
		const res = await fetch(`/api/avatar/capabilities?${query}`);
		const data = await res.json();
		if (!res.ok) throw new Error(data.message || data.error || 'inspection failed');
		capabilities = data;
	} catch (err) {
		// The composer still works without the report; it just cannot narrow the
		// controls, so say so rather than pretending everything is supported.
		toast(`Capability check failed: ${err.message}`);
		capabilities = null;
	}
	renderCapabilities();
	renderPoseChips();
	renderExpressionControls();
	pruneUnsupportedExpression();
}

// Switching models can strand weights for shapes the new model lacks. Drop
// them rather than sending a request that is guaranteed to come back partial.
function pruneUnsupportedExpression() {
	if (!capabilities) return;
	const ok = new Set(capabilities.morphs.supported);
	let dropped = 0;
	for (const name of Object.keys(state.expression)) {
		if (!ok.has(name)) {
			delete state.expression[name];
			dropped += 1;
		}
	}
	if (dropped) renderExpressionControls();
}

async function selectAvatar(id, name) {
	state.source = { kind: 'avatar', id, name: name || 'Avatar' };
	syncChipStates();
	commit({ immediate: true });
	await loadCapabilities(`avatar=${encodeURIComponent(id)}`);
	renderCode();
}

async function selectUrl(url) {
	state.source = { kind: 'url', url, name: url.split('/').pop() || 'Model' };
	syncChipStates();
	commit({ immediate: true });
	await loadCapabilities(`url=${encodeURIComponent(url)}`);
	renderCode();
}

// ── wiring ───────────────────────────────────────────────────────────

function wire() {
	$('sceneChips').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-scene]');
		if (!btn) return;
		state.scene = btn.dataset.scene;
		syncChipStates();
		commit();
	});

	$('poseChips').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-pose]');
		if (!btn) return;
		state.pose = btn.dataset.pose;
		syncChipStates();
		commit();
	});

	$('avatarStrip').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-avatar]');
		if (!btn) return;
		const avatar = avatars.find((a) => a.id === btn.dataset.avatar);
		selectAvatar(btn.dataset.avatar, avatar?.name);
	});

	$('sizeInput').addEventListener('input', (e) => {
		state.size = Number(e.target.value);
		$('sizeVal').textContent = String(state.size);
		commit();
	});

	$('bgInput').addEventListener('input', (e) => {
		state.bg = e.target.value.trim() || 'transparent';
		if (/^#[0-9a-f]{6}$/i.test(state.bg)) $('bgColor').value = state.bg;
		commit();
	});

	$('bgColor').addEventListener('input', (e) => {
		state.bg = e.target.value;
		$('bgInput').value = state.bg;
		commit();
	});

	$('formatInput').addEventListener('change', (e) => {
		state.format = e.target.value;
		$('qualityInput').disabled = state.format === 'png';
		commit();
	});

	$('qualityInput').addEventListener('input', (e) => {
		const q = Number(e.target.value);
		if (q >= 1 && q <= 100) state.quality = q;
		commit();
	});

	$('exprPresets').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-preset]');
		if (!btn) return;
		const preset = EXPRESSION_PRESETS.find((p) => p.id === btn.dataset.preset);
		if (!preset) return;
		const ok = capabilities ? new Set(capabilities.morphs.supported) : null;
		state.expression = {};
		for (const [name, weight] of Object.entries(preset.weights)) {
			if (!ok || ok.has(name)) state.expression[name] = weight;
		}
		renderExpressionControls();
		commit();
	});

	$('exprSliders').addEventListener('input', (e) => {
		const input = e.target.closest('[data-morph]');
		if (!input) return;
		const name = input.dataset.morph;
		const value = Number(input.value);
		if (value > 0) state.expression[name] = value;
		else delete state.expression[name];
		const label = $(`v-${name}`);
		if (label) label.textContent = value.toFixed(2);
		commit();
	});

	$('exprEmpty').addEventListener('click', (e) => {
		if (!e.target.closest('[data-pick-morphy]')) return;
		// Steer to a model that demonstrably has a full ARKit face rig rather
		// than leaving a dead end at the empty state.
		selectUrl(`${origin}/avatars/selfie-girl.glb`);
	});

	$('btnLoadCustom').addEventListener('click', () => {
		const value = $('customInput').value.trim();
		if (!value) return;
		if (/^https?:\/\//i.test(value)) selectUrl(value);
		else selectAvatar(value, 'Avatar');
	});
	$('customInput').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') $('btnLoadCustom').click();
	});

	for (const tab of document.querySelectorAll('.rl-tab')) {
		tab.addEventListener('click', () => {
			codeLang = tab.dataset.lang;
			for (const t of document.querySelectorAll('.rl-tab')) {
				const on = t === tab;
				t.classList.toggle('is-on', on);
				t.setAttribute('aria-selected', String(on));
			}
			renderCode();
		});
	}

	$('btnCopyCode').addEventListener('click', () => copy(codeFor(codeLang), codeLang === 'url' ? 'URL' : 'Snippet'));
	$('btnPermalink').addEventListener('click', () => copy(location.href, 'Link'));

	$('btnSheet').addEventListener('click', () => {
		const sheet = $('sheet');
		sheet.hidden = !sheet.hidden;
		$('btnSheet').textContent = sheet.hidden ? 'Contact sheet' : 'Hide sheet';
		if (!sheet.hidden) renderSheet();
	});
	$('btnSheetClose').addEventListener('click', () => {
		$('sheet').hidden = true;
		$('btnSheet').textContent = 'Contact sheet';
	});

	for (const btn of document.querySelectorAll('.rl-seg-btn')) {
		btn.addEventListener('click', () => {
			sheetAxis = btn.dataset.axis;
			for (const b of document.querySelectorAll('.rl-seg-btn')) b.classList.toggle('is-on', b === btn);
			renderSheet();
		});
	}

	$('sheetGrid').addEventListener('click', (e) => {
		const cell = e.target.closest('[data-cell]');
		if (!cell) return;
		const cells = sheetCells();
		const chosen = cells[Number(cell.dataset.cell)];
		if (!chosen) return;
		chosen.apply();
		renderSceneChips();
		renderPoseChips();
		renderExpressionControls();
		syncChipStates();
		commit({ immediate: true });
		$('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
	});

	$('btnReset').addEventListener('click', () => {
		Object.assign(state, DEFAULTS);
		state.expression = {};
		$('sizeInput').value = String(state.size);
		$('sizeVal').textContent = String(state.size);
		$('bgInput').value = state.bg;
		$('formatInput').value = state.format;
		$('qualityInput').disabled = true;
		renderSceneChips();
		renderPoseChips();
		renderExpressionControls();
		syncChipStates();
		commit({ immediate: true });
		toast('Reset to defaults');
	});

	window.addEventListener('beforeunload', releaseObjectUrl);
}

// ── boot ─────────────────────────────────────────────────────────────

async function boot() {
	mirrorTips();
	wire();
	const linked = readUrl();

	$('sizeInput').value = String(state.size);
	$('sizeVal').textContent = String(state.size);
	$('bgInput').value = state.bg;
	$('formatInput').value = state.format;
	$('qualityInput').disabled = state.format === 'png';
	renderSceneChips();
	renderExpressionControls();

	const [catalogRes, featuredRes] = await Promise.allSettled([
		fetch('/api/render/avatar-clip').then((r) => r.json()),
		fetch('/api/avatars/featured?limit=12').then((r) => r.json()),
	]);

	if (catalogRes.status === 'fulfilled' && Array.isArray(catalogRes.value?.poses)) {
		poseCatalog = catalogRes.value.poses;
	}
	renderPoseChips();

	if (featuredRes.status === 'fulfilled' && Array.isArray(featuredRes.value?.avatars)) {
		avatars = featuredRes.value.avatars.filter((a) => a.thumb_url);
	}
	renderAvatarStrip();

	if (linked.url) {
		$('customInput').value = linked.url;
		await selectUrl(linked.url);
	} else if (linked.avatar) {
		$('customInput').value = linked.avatar;
		const known = avatars.find((a) => a.id === linked.avatar);
		await selectAvatar(linked.avatar, known?.name);
	} else if (avatars.length) {
		await selectAvatar(avatars[0].id, avatars[0].name);
	} else {
		// The featured feed is the only thing that can leave this page with
		// nothing to show; fall back to a first-party model that always exists.
		await selectUrl(`${origin}/avatars/selfie-girl.glb`);
	}
}

boot();
