// Agent Creation Wizard — /create-agent
//
// A five-step, state-driven flow that produces a real agent identity:
//   1. Basics       → name, description, tags
//   2. 3D model     → starter library | own GLB upload | attach later
//   3. Skills       → core (always on) + optional capabilities
//   4. Personality  → category, greeting, profile prompt, voice
//   5. Review       → POST /api/agents, optional marketplace publish
//
// Everything writes through the same verified endpoints the agent editor uses
// (account.js#saveRemoteGlbToAccount for the model, /api/agents for the
// identity, /api/marketplace/agents/:id/publish for personality + listing) so
// there are no parallel code paths to drift out of sync.

import { apiFetch } from './api.js';
import { getMe, saveRemoteGlbToAccount } from './account.js';
import { peekGuestAgent, clearGuestAgent } from './agents/guest-agent.js';
import { log } from './shared/log.js';
import { isValidGlbMagic } from './shared/glb-magic.js';
import { track, trackFunnelStep, trackError, ANALYTICS_EVENTS } from './analytics.js';

const TOTAL_STEPS = 5;
const STEP_LABELS = ['Basics', 'Model', 'Skills', 'Personality', 'Review'];
const MAX_TAGS = 8;

// Marketplace categories — mirrors api/marketplace/[action].js CATEGORIES.
const CATEGORIES = [
	'academic',
	'career',
	'copywriting',
	'design',
	'education',
	'emotions',
	'entertainment',
	'games',
	'general',
	'life',
	'marketing',
	'office',
	'programming',
	'translation',
];

// Real starter models — public-domain / shipped GLBs already served from the
// site. Selecting one copies it into the user's own avatar library on create
// (saveRemoteGlbToAccount fetches the URL, uploads to their R2 namespace, and
// commits a real avatar record) — never a placeholder reference.
const STARTERS = [
	{ id: 'default', name: 'Vern', url: '/avatars/default.glb' },
	{ id: 'cz', name: 'CZ', url: '/avatars/cz.glb' },
	{ id: 'robot', name: 'Saga', url: '/animations/robotexpressive.glb' },
	{ id: 'soldier', name: 'Boss', url: '/animations/soldier.glb' },
];

// Every agent gets a real 3D body. If the user opts to "Add later", we still
// assign this real default starter on create — an agent is never bodiless.
const DEFAULT_AVATAR = STARTERS[0];

// Core skills every agent gets — matches the API default set. Locked on.
const CORE_SKILLS = [
	{ id: 'greet', name: 'Greet', desc: 'Welcomes visitors and opens the conversation.' },
	{ id: 'present-model', name: 'Present model', desc: 'Shows off and explains its own 3D body.' },
	{
		id: 'validate-model',
		name: 'Validate model',
		desc: 'Checks rig and animation health on load.',
	},
	{ id: 'remember', name: 'Remember', desc: 'Keeps memory across a conversation.' },
	{ id: 'think', name: 'Think', desc: 'Reasons step by step before answering.' },
];

// Optional skills — a curated, real set the user can toggle on. Ids are stored
// verbatim in the agent's skills[] array.
const OPTIONAL_SKILLS = [
	{ id: 'wave', name: 'Wave', desc: 'Waves at people on greet or on request.' },
	{ id: 'dance', name: 'Dance', desc: 'Plays a dance animation loop on cue.' },
	{
		id: 'pump-fun',
		name: 'Pump.fun market intel',
		desc: 'Read-only Solana market data: tokens, bonding curves, trending, rug-risk.',
	},
	{
		id: 'explain-gltf',
		name: 'Explain glTF',
		desc: 'Narrates mesh, material, and animation info from the scene.',
	},
	{ id: 'web-search', name: 'Web search', desc: 'Looks things up on the live web when asked.' },
];

// ── State ───────────────────────────────────────────────────────────────────

const state = {
	step: 0,
	name: '',
	description: '',
	tags: [],
	model: {
		mode: 'starter',
		starterId: '',
		starterUrl: '',
		file: null,
		fileName: '',
		skipAck: false,
		avatarId: '',
		avatarUrl: '',
		avatarName: '',
		_blobUrl: '',
	},
	skills: new Set(CORE_SKILLS.map((s) => s.id)),
	category: '',
	greeting: '',
	persona: '',
	voice: 'browser',
	publish: true,
	submitting: false,
};

// ── DOM refs ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const el = {};

// Set by wireTagInput so the magic generator can repaint the tag chips after it
// rewrites state.tags wholesale (the per-keystroke renderer lives in a closure).
let tagRenderer = () => {};

// ── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
	cacheEls();
	renderStepper();
	renderStarters();
	renderSkills();
	renderCategories();
	wireBasics();
	wireModel();
	wirePersonality();
	wireMagic();
	wireNav();

	// Resolve auth. The whole flow requires an account (the agent gets a wallet),
	// so gate the form behind a sign-in prompt rather than letting the user fill
	// everything out only to hit a wall at the end.
	let me = null;
	try {
		me = await getMe();
	} catch (err) {
		log.warn('[create-agent] auth probe failed', err?.message);
	}
	$('page-loading')?.remove();
	if (!me) {
		showAuthGate();
		return;
	}
	prefillFromGuestDraft();
	showStep(0);
}

// The corner companion mints an ephemeral agent for signed-out visitors
// (src/agents/guest-agent.js) and its "Claim →" CTA lands here. Carry the
// draft's name into the wizard so the agent they met is the agent they create.
// Never overwrite something the user already typed.
function prefillFromGuestDraft() {
	const draft = peekGuestAgent();
	if (!draft?.name) return;
	const nameEl = $('f-name');
	if (!nameEl || nameEl.value.trim()) return;
	nameEl.value = draft.name;
	state.name = draft.name;
	$('name-count').textContent = `${draft.name.length} / 60`;
	setMsg(`Claiming ${draft.name} — your companion becomes a real agent when you finish.`, '');
}

function cacheEls() {
	el.form = $('wizard');
	el.body = $('wizard-body');
	el.foot = $('wizard-foot');
	el.footMsg = $('foot-msg');
	el.back = $('btn-back');
	el.next = $('btn-next');
	el.create = $('btn-create');
	el.panels = Array.from(document.querySelectorAll('.panel'));
	el.success = $('success');
	el.authGate = $('auth-gate');
	el.preview = $('model-preview');
	el.previewEmpty = $('model-preview-empty');
	el.magicInput = $('magic-input');
	el.magicGo = $('magic-go');
	el.magicMsg = $('magic-msg');
}

function showAuthGate() {
	el.authGate.classList.add('show');
	el.form.style.display = 'none';
	// Carry the user back here after login.
	const next = encodeURIComponent('/create-agent');
	$('auth-gate-signin').href = `/login?next=${next}`;
}

// ── Stepper ─────────────────────────────────────────────────────────────────

function renderStepper() {
	const stepper = $('stepper');
	stepper.innerHTML = '';
	STEP_LABELS.forEach((label, i) => {
		if (i > 0) {
			const bar = document.createElement('li');
			bar.className = 'step-bar';
			bar.setAttribute('aria-hidden', 'true');
			bar.dataset.bar = String(i);
			stepper.appendChild(bar);
		}
		const li = document.createElement('li');
		li.className = 'step-pip';
		li.dataset.pip = String(i);
		li.innerHTML = `<span class="num">${i + 1}</span><span class="label">${label}</span>`;
		// Let users jump back to any completed step by clicking its pip.
		li.addEventListener('click', () => {
			if (i < state.step) showStep(i);
		});
		stepper.appendChild(li);
	});
}

function updateStepper() {
	document.querySelectorAll('.step-pip').forEach((pip) => {
		const i = Number(pip.dataset.pip);
		const done = i < state.step;
		pip.dataset.state = i === state.step ? 'active' : done ? 'done' : '';
		pip.dataset.clickable = done ? 'true' : 'false';
		if (done) pip.querySelector('.num').textContent = '✓';
		else pip.querySelector('.num').textContent = String(i + 1);
	});
	document.querySelectorAll('.step-bar').forEach((bar) => {
		bar.dataset.state = Number(bar.dataset.bar) <= state.step ? 'done' : '';
	});
}

// ── Step navigation ─────────────────────────────────────────────────────────

function showStep(n) {
	state.step = n;
	el.panels.forEach((p) => p.classList.toggle('is-active', Number(p.dataset.step) === n));
	updateStepper();
	clearMsg();

	el.back.hidden = n === 0;
	const isLast = n === TOTAL_STEPS - 1;
	el.next.hidden = isLast;
	el.create.hidden = !isLast;

	if (isLast) renderReview();
	if (n === 1) syncModelPreview();

	// Move focus to the first field of the step for keyboard users.
	const panel = el.panels.find((p) => Number(p.dataset.step) === n);
	const focusable = panel?.querySelector(
		'input, textarea, select, button.opt, .starter, .dropzone',
	);
	requestAnimationFrame(() => focusable?.focus?.({ preventScroll: true }));
	el.body.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function wireNav() {
	el.back.addEventListener('click', () => {
		if (state.step > 0) showStep(state.step - 1);
	});
	el.next.addEventListener('click', () => {
		if (validateStep(state.step)) showStep(state.step + 1);
	});
	el.form.addEventListener('submit', (e) => {
		e.preventDefault();
		submit();
	});
	// Enter on a text input advances rather than submitting the form early.
	el.form.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter') return;
		const t = e.target;
		if (t.tagName === 'TEXTAREA') return;
		if (t.id === 'f-tags-input') return; // tag input handles Enter itself
		if (t.tagName === 'INPUT' || t.tagName === 'SELECT') {
			e.preventDefault();
			if (state.step < TOTAL_STEPS - 1) {
				if (validateStep(state.step)) showStep(state.step + 1);
			} else {
				submit();
			}
		}
	});
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateStep(n) {
	clearMsg();
	if (n === 0) {
		if (!state.name.trim()) {
			$('f-name').classList.add('is-invalid');
			$('name-error').classList.add('show');
			$('f-name').focus();
			setMsg('Your agent needs a name.', 'err');
			return false;
		}
	}
	if (n === 1) {
		// Every agent gets a 3D avatar. Require a real choice — a starter, an
		// upload, or an explicit acknowledgment that they're skipping for now.
		const hasStarter = state.model.mode === 'starter' && !!state.model.starterUrl;
		const hasUpload = state.model.mode === 'upload' && !!state.model.file;
		const hasLibrary = state.model.mode === 'library' && !!state.model.avatarId;
		const acknowledgedSkip = state.model.mode === 'none' && state.model.skipAck;
		if (!hasStarter && !hasUpload && !hasLibrary && !acknowledgedSkip) {
			if (state.model.mode === 'none') {
				setMsg(
					'Tick the box to confirm you want to launch with the default 3D body for now.',
					'err',
				);
			} else {
				setMsg(
					'Pick a starter avatar or upload a 3D model — or choose “Add later” and confirm.',
					'err',
				);
			}
			return false;
		}
	}
	if (n === 3 && state.publish) {
		// Publishing needs a category + profile prompt. Don't hard-block the step —
		// just warn; the review step lets them turn off publishing instead.
		if (!state.category || !state.persona.trim()) {
			setMsg('Tip: add a category and a profile prompt to list on the marketplace.', '');
		}
	}
	return true;
}

// ── Step 1: Basics ──────────────────────────────────────────────────────────

function wireBasics() {
	const name = $('f-name');
	name.addEventListener('input', () => {
		state.name = name.value;
		$('name-count').textContent = `${name.value.length} / 60`;
		if (name.value.trim()) {
			name.classList.remove('is-invalid');
			$('name-error').classList.remove('show');
		}
	});

	const desc = $('f-description');
	desc.addEventListener('input', () => {
		state.description = desc.value;
		$('desc-count').textContent = `${desc.value.length} / 280`;
	});

	wireTagInput();
}

function wireTagInput() {
	const input = $('f-tags-input');
	const box = $('tagbox');

	const addTag = (raw) => {
		const t = raw.trim().toLowerCase().replace(/^#/, '');
		if (!t) return;
		if (state.tags.includes(t)) return;
		if (state.tags.length >= MAX_TAGS) {
			setMsg(`Up to ${MAX_TAGS} tags.`, '');
			return;
		}
		state.tags.push(t);
		renderTags();
	};

	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			addTag(input.value);
			input.value = '';
		} else if (e.key === 'Backspace' && !input.value && state.tags.length) {
			state.tags.pop();
			renderTags();
		}
	});
	input.addEventListener('blur', () => {
		if (input.value.trim()) {
			addTag(input.value);
			input.value = '';
		}
	});
	// Clicking anywhere in the box focuses the input.
	box.addEventListener('click', (e) => {
		if (e.target === box) input.focus();
	});

	function renderTags() {
		box.querySelectorAll('.tag').forEach((n) => n.remove());
		const frag = document.createDocumentFragment();
		state.tags.forEach((t) => {
			const chip = document.createElement('span');
			chip.className = 'tag';
			chip.innerHTML = `<span>${escapeHtml(t)}</span>`;
			const x = document.createElement('button');
			x.type = 'button';
			x.setAttribute('aria-label', `Remove tag ${t}`);
			x.textContent = '×';
			x.addEventListener('click', () => {
				state.tags = state.tags.filter((v) => v !== t);
				renderTags();
			});
			chip.appendChild(x);
			frag.appendChild(chip);
		});
		box.insertBefore(frag, input);
	}
	// Expose so the magic generator can repaint after replacing state.tags.
	tagRenderer = renderTags;
}

// ── Magic generator: describe it, we build it ───────────────────────────────

let generating = false;

function wireMagic() {
	const input = el.magicInput;
	const go = el.magicGo;
	if (!input || !go) return;

	// Auto-grow the brief box so longer ideas stay fully visible.
	const grow = () => {
		input.style.height = 'auto';
		input.style.height = Math.min(input.scrollHeight, 160) + 'px';
	};
	input.addEventListener('input', grow);
	// Enter generates; Shift+Enter inserts a newline.
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			generateSpec(input.value);
		}
	});

	go.addEventListener('click', () => generateSpec(input.value));

	// Example chips fill the brief (one-click, zero typing) and generate at once.
	document.querySelectorAll('#magic-chips .magic-chip[data-example]').forEach((chip) => {
		chip.addEventListener('click', () => {
			input.value = chip.dataset.example || '';
			grow();
			generateSpec(input.value);
		});
	});
	// "Surprise me" — generate with no brief at all.
	$('magic-surprise')?.addEventListener('click', () => generateSpec(''));
}

function setMagicMsg(text, kind) {
	if (!el.magicMsg) return;
	el.magicMsg.textContent = text || '';
	el.magicMsg.className = 'magic-msg' + (kind ? ' ' + kind : '');
}

function setMagicBusy(busy) {
	generating = busy;
	if (el.magicGo) {
		el.magicGo.setAttribute('aria-busy', busy ? 'true' : 'false');
		el.magicGo.disabled = busy;
		const label = el.magicGo.querySelector('.magic-go-label');
		if (label) label.textContent = busy ? 'Building…' : 'Generate';
	}
	if (el.magicInput) el.magicInput.disabled = busy;
	document
		.querySelectorAll('#magic-chips .magic-chip')
		.forEach((c) => (c.disabled = busy));
}

async function generateSpec(rawPrompt) {
	if (generating) return;
	const prompt = (rawPrompt || '').trim();
	setMagicBusy(true);
	setMagicMsg('Designing your agent…', '');
	try {
		const res = await apiFetch('/api/agents/suggest-spec', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || !data.spec) {
			const msg =
				data.error_description ||
				(res.status === 401
					? 'Please sign in first, then generate.'
					: res.status === 429
						? 'You’re generating quickly — give it a few seconds and try again.'
						: 'Couldn’t generate that one. Try a different description or fill the form by hand.');
			setMagicMsg(msg, 'err');
			setMagicBusy(false);
			return;
		}
		applySpec(data.spec);
		track(ANALYTICS_EVENTS.CTA_CLICKED, {
			cta: 'ai_generate_spec',
			location: 'create-agent',
			had_prompt: prompt.length > 0,
		});
		setMagicBusy(false);
		setMagicMsg('', '');
		// Drop the user on Review with everything filled — read it over and ship,
		// or jump back to any step via the pips to tweak.
		showStep(TOTAL_STEPS - 1);
		setMsg(`“${state.name}” is ready to review. Tweak anything, then create.`, 'ok');
	} catch (err) {
		log.warn('[create-agent] generate failed', err?.message);
		trackError('create_agent.generate', err);
		setMagicMsg('Network hiccup — try again in a moment.', 'err');
		setMagicBusy(false);
	}
}

// Pour a generated spec into the wizard's real state + DOM, reusing the same
// fields and selection paths a manual fill would touch — nothing bypasses the
// existing validation or submit flow.
function applySpec(spec) {
	// Step 1 — name, description, tags.
	state.name = spec.name || '';
	$('f-name').value = state.name;
	$('name-count').textContent = `${state.name.length} / 60`;
	$('f-name').classList.remove('is-invalid');
	$('name-error').classList.remove('show');

	state.description = spec.description || '';
	$('f-description').value = state.description;
	$('desc-count').textContent = `${state.description.length} / 280`;

	state.tags = Array.isArray(spec.tags) ? spec.tags.slice(0, MAX_TAGS) : [];
	tagRenderer();

	// Step 2 — pick the suggested starter body.
	const starter = STARTERS.find((s) => s.id === spec.avatar_starter) || DEFAULT_AVATAR;
	const starterTab = document.querySelector('.model-tab[data-pane="starter"]');
	if (starterTab && !starterTab.classList.contains('is-active')) starterTab.click();
	selectStarter(starter.id);

	// Step 3 — optional skills (core stay locked on).
	state.skills = new Set(CORE_SKILLS.map((s) => s.id));
	(Array.isArray(spec.skills) ? spec.skills : []).forEach((id) => {
		if (OPTIONAL_SKILLS.some((s) => s.id === id)) state.skills.add(id);
	});
	renderSkills();

	// Step 4 — category, greeting, persona, voice.
	state.category = CATEGORIES.includes(spec.category) ? spec.category : '';
	$('f-category').value = state.category;

	state.greeting = spec.greeting || '';
	$('f-greeting').value = state.greeting;
	$('greet-count').textContent = `${state.greeting.length} / 200`;

	state.persona = spec.persona || '';
	$('f-persona').value = state.persona;
	$('persona-count').textContent = `${state.persona.length} / 2000`;

	state.voice = spec.voice === 'custom' ? 'custom' : 'browser';
	document.querySelectorAll('[data-voice]').forEach((b) => {
		const on = b.dataset.voice === state.voice;
		b.classList.toggle('is-selected', on);
		b.setAttribute('aria-pressed', on ? 'true' : 'false');
	});

	// Publishing needs a category + persona; the generator supplies both, so
	// default the marketplace listing on — the review step lets them opt out.
	state.publish = Boolean(state.category && state.persona.trim());
}

// ── Step 2: Model ───────────────────────────────────────────────────────────

function renderStarters() {
	const grid = $('starter-grid');
	grid.innerHTML = '';
	STARTERS.forEach((s) => {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'starter';
		card.dataset.starter = s.id;
		card.setAttribute('aria-label', `Use the ${s.name} starter model`);
		card.innerHTML = `
			<span class="starter-thumb">
				<model-viewer src="${s.url}" alt="${s.name} preview" auto-rotate auto-rotate-delay="0"
					rotation-per-second="22deg" interaction-prompt="none" disable-zoom disable-pan disable-tap
					shadow-intensity="0.3" exposure="0.95" environment-image="neutral"
					camera-orbit="15deg 82deg auto" loading="lazy"></model-viewer>
			</span>
			<span class="starter-name">${s.name}</span>`;
		card.addEventListener('click', () => selectStarter(s.id));
		grid.appendChild(card);
	});
}

function selectStarter(id) {
	const s = STARTERS.find((x) => x.id === id);
	if (!s) return;
	state.model = {
		mode: 'starter',
		starterId: id,
		starterUrl: s.url,
		file: null,
		fileName: '',
		skipAck: false,
		avatarId: '',
		avatarUrl: '',
		avatarName: '',
	};
	document
		.querySelectorAll('.starter')
		.forEach((c) => c.classList.toggle('is-selected', c.dataset.starter === id));
	syncModelPreview();
}

// ── Step 2 (alt): connect an avatar you already own ──────────────────────────

// Only these model_category values can serve as an agent body.
// Items, scenes, accessories, vehicles, etc. are 3D assets — not characters.
const AGENTABLE_CATEGORIES = new Set(['avatar', 'creature']);

let libraryState = 'idle'; // idle | loading | loaded | error
let libraryAvatars = [];
let libraryOffset = 0;
let libraryHasMore = false;
const LIBRARY_PAGE = 50;

// The avatars API exposes the GLB as model_url (public/unlisted) or
// base_model_url; private avatars have neither. Resolve a renderable URL or ''.
const avatarModelUrl = (av) => av?.model_url || av?.base_model_url || '';

async function loadLibraryAvatars({ append = false } = {}) {
	if (libraryState === 'loading') return;
	if (!append && (libraryState === 'loaded' || libraryState === 'error')) {
		renderLibrary();
		return;
	}
	libraryState = 'loading';
	if (!append) renderLibrary();
	try {
		const url = `/api/avatars?limit=${LIBRARY_PAGE + 1}&offset=${libraryOffset}`;
		const res = await apiFetch(url, { credentials: 'include' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const all = (data.avatars || []).filter((a) => a && a.id);
		// Only show character-class models (avatar, creature) as agent bodies.
		// Props, scenes, accessories etc. are 3D assets but can't embody an agent.
		const page = all.filter(
			(a) => !a.model_category || AGENTABLE_CATEGORIES.has(a.model_category),
		);
		libraryHasMore = page.length > LIBRARY_PAGE;
		const fresh = page.slice(0, LIBRARY_PAGE);
		if (append) {
			libraryAvatars = [...libraryAvatars, ...fresh];
		} else {
			libraryAvatars = fresh;
		}
		libraryOffset = libraryAvatars.length;
		libraryState = 'loaded';
	} catch (err) {
		log.warn('[create-agent] avatar library load failed', err?.message);
		libraryState = 'error';
	}
	renderLibrary();
}

function renderLibrary() {
	const grid = $('library-grid');
	if (!grid) return;
	const note = (msg) =>
		`<p class="panel-help" style="grid-column:1/-1;margin:6px 0 0">${msg}</p>`;

	if (libraryState === 'loading') {
		grid.innerHTML = note('Loading your avatars…');
		return;
	}
	if (libraryState === 'error') {
		grid.innerHTML = note(
			"Couldn't load your avatars. Pick a starter or upload instead — you can connect one later from the editor.",
		);
		const retry = document.createElement('button');
		retry.type = 'button';
		retry.className = 'lib-load-more';
		retry.style = 'grid-column:1/-1;margin-top:6px;padding:6px 12px;font-size:0.75rem;opacity:0.6;cursor:pointer;background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:inherit;transition:opacity 0.15s';
		retry.textContent = 'Try again';
		retry.addEventListener('click', () => {
			libraryState = 'idle';
			loadLibraryAvatars();
		});
		grid.appendChild(retry);
		return;
	}
	if (!libraryAvatars.length) {
		grid.innerHTML = note(
			"No character models found. Agent bodies must be avatars or creatures — 3D objects like props and scenes live in your library but can't be deployed as agents. Choose a starter or upload a character GLB.",
		);
		return;
	}

	grid.innerHTML = '';
	libraryAvatars.forEach((av) => {
		const name = av.name || 'Untitled';
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'starter';
		card.dataset.avatar = av.id;
		card.setAttribute('aria-label', `Use your avatar ${name}`);
		const modelUrl = avatarModelUrl(av);
		const thumb = av.thumbnail_url
			? `<img src="${escapeHtml(av.thumbnail_url)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover" />`
			: modelUrl
				? `<model-viewer src="${escapeHtml(modelUrl)}" alt="${escapeHtml(name)} preview" auto-rotate
					auto-rotate-delay="0" rotation-per-second="22deg" interaction-prompt="none" disable-zoom disable-pan
					disable-tap shadow-intensity="0.3" exposure="0.95" environment-image="neutral"
					camera-orbit="15deg 82deg auto" loading="lazy"></model-viewer>`
				: '<span class="lib-noprev">3D</span>';
		card.innerHTML = `<span class="starter-thumb">${thumb}</span><span class="starter-name">${escapeHtml(name)}</span>`;
		card.addEventListener('click', () => selectLibraryAvatar(av.id));
		grid.appendChild(card);
	});

	if (libraryHasMore) {
		const more = document.createElement('button');
		more.type = 'button';
		more.className = 'lib-load-more';
		more.style = 'grid-column:1/-1;margin-top:6px;padding:6px 12px;font-size:0.75rem;opacity:0.6;cursor:pointer;background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:inherit;transition:opacity 0.15s';
		more.textContent = 'Load more';
		more.addEventListener('click', () => loadLibraryAvatars({ append: true }));
		grid.appendChild(more);
	}

	// Re-apply the highlight when re-rendering with an active selection.
	if (state.model.mode === 'library' && state.model.avatarId) {
		grid.querySelectorAll('.starter').forEach((c) =>
			c.classList.toggle('is-selected', c.dataset.avatar === state.model.avatarId),
		);
	}
}

function selectLibraryAvatar(id) {
	const av = libraryAvatars.find((x) => x.id === id);
	if (!av) return;
	state.model = {
		mode: 'library',
		starterId: '',
		starterUrl: '',
		file: null,
		fileName: '',
		skipAck: false,
		avatarId: av.id,
		avatarUrl: avatarModelUrl(av),
		avatarName: av.name || 'Untitled',
	};
	$('library-grid')
		.querySelectorAll('.starter')
		.forEach((c) => c.classList.toggle('is-selected', c.dataset.avatar === id));
	clearMsg();
	syncModelPreview();
}

function wireModel() {
	// Tabs
	document.querySelectorAll('.model-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			const pane = tab.dataset.pane;
			document.querySelectorAll('.model-tab').forEach((t) => {
				const on = t === tab;
				t.classList.toggle('is-active', on);
				t.setAttribute('aria-selected', on ? 'true' : 'false');
			});
			document
				.querySelectorAll('.model-pane')
				.forEach((p) => p.classList.toggle('is-active', p.dataset.pane === pane));
			if (pane === 'skip') {
				state.model = {
					mode: 'none',
					starterId: '',
					starterUrl: '',
					file: null,
					fileName: '',
					skipAck: !!$('f-skip-ack')?.checked,
					avatarId: '',
					avatarUrl: '',
					avatarName: '',
				};
				document
					.querySelectorAll('.starter')
					.forEach((c) => c.classList.remove('is-selected'));
				syncModelPreview();
			} else if (pane === 'library') {
				loadLibraryAvatars();
			} else if (pane === 'starter' && state.model.mode !== 'starter') {
				// re-entering starter tab with nothing chosen — leave unselected
			}
		});
	});

	// "Add later" acknowledgment — required to advance without an avatar.
	$('f-skip-ack')?.addEventListener('change', (e) => {
		state.model.skipAck = e.target.checked;
		if (state.step === 1) clearMsg();
	});

	// Dropzone + file input
	const dz = $('dropzone');
	const input = $('glb-input');
	dz.addEventListener('click', () => input.click());
	dz.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			input.click();
		}
	});
	['dragover', 'dragenter'].forEach((ev) =>
		dz.addEventListener(ev, (e) => {
			e.preventDefault();
			dz.classList.add('is-drag');
		}),
	);
	['dragleave', 'dragend', 'drop'].forEach((ev) =>
		dz.addEventListener(ev, () => dz.classList.remove('is-drag')),
	);
	dz.addEventListener('drop', (e) => {
		e.preventDefault();
		const f = e.dataTransfer?.files?.[0];
		if (f) acceptFile(f);
	});
	input.addEventListener('change', () => {
		const f = input.files?.[0];
		if (f) acceptFile(f);
		input.value = '';
	});
}

async function acceptFile(file) {
	if (!file.name.toLowerCase().endsWith('.glb')) {
		setMsg('Please choose a .glb file.', 'err');
		return;
	}
	if (file.size > 16 * 1024 * 1024) {
		setMsg('That file is over the 16 MB limit.', 'err');
		return;
	}
	if (!(await isValidGlbMagic(file))) {
		setMsg("That doesn't look like a valid GLB file (bad header).", 'err');
		return;
	}
	clearMsg();
	state.model = {
		mode: 'upload',
		starterId: '',
		starterUrl: '',
		file,
		fileName: file.name.replace(/\.glb$/i, ''),
		skipAck: false,
		avatarId: '',
		avatarUrl: '',
		avatarName: '',
	};
	$('dropzone-title').innerHTML = `<span class="file-name">${escapeHtml(file.name)}</span> ready`;
	$('dropzone-sub').textContent = 'Click to choose a different file';
	syncModelPreview();
}

function syncModelPreview() {
	// Revoke any previously-created blob URL before creating a new one to avoid
	// accumulating unreachable blob entries for the lifetime of the page.
	if (state.model._blobUrl) {
		URL.revokeObjectURL(state.model._blobUrl);
		state.model._blobUrl = '';
	}
	let url;
	if (state.model.mode === 'starter') {
		url = state.model.starterUrl;
	} else if (state.model.mode === 'library') {
		url = state.model.avatarUrl;
	} else if (state.model.mode === 'upload' && state.model.file) {
		url = URL.createObjectURL(state.model.file);
		state.model._blobUrl = url;
	} else {
		url = '';
	}

	// Clear any previous viewer.
	el.preview.querySelector('model-viewer')?.remove();
	if (!url) {
		el.previewEmpty.style.display = '';
		return;
	}
	el.previewEmpty.style.display = 'none';
	const mv = document.createElement('model-viewer');
	mv.setAttribute('src', url);
	mv.setAttribute('alt', 'Selected model preview');
	mv.setAttribute('auto-rotate', '');
	mv.setAttribute('auto-rotate-delay', '0');
	mv.setAttribute('rotation-per-second', '18deg');
	mv.setAttribute('camera-controls', '');
	mv.setAttribute('interaction-prompt', 'none');
	mv.setAttribute('shadow-intensity', '0.4');
	mv.setAttribute('exposure', '0.95');
	mv.setAttribute('environment-image', 'neutral');
	mv.setAttribute('camera-orbit', '15deg 80deg auto');
	mv.setAttribute('loading', 'eager');
	el.preview.appendChild(mv);
}

// ── Step 3: Skills ──────────────────────────────────────────────────────────

function renderSkills() {
	const core = $('core-skills');
	core.innerHTML = '';
	CORE_SKILLS.forEach((s) => core.appendChild(skillRow(s, true)));

	const opt = $('optional-skills');
	opt.innerHTML = '';
	OPTIONAL_SKILLS.forEach((s) => opt.appendChild(skillRow(s, false)));
	updateSkillsMeta();
}

function skillRow(skill, locked) {
	const row = document.createElement('div');
	row.className = 'skill-row' + (locked ? ' locked' : '');
	const checked = state.skills.has(skill.id);
	row.innerHTML = `
		<div class="skill-info">
			<div class="skill-name">${escapeHtml(skill.name)}${locked ? '<span class="core-pill">Core</span>' : ''}</div>
			<div class="skill-desc">${escapeHtml(skill.desc)}</div>
		</div>
		<label class="toggle">
			<input type="checkbox" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}
				aria-label="${escapeHtml(skill.name)}" />
			<span class="track"></span>
			<span class="knob"></span>
		</label>`;
	if (!locked) {
		const cb = row.querySelector('input');
		cb.addEventListener('change', () => {
			if (cb.checked) state.skills.add(skill.id);
			else state.skills.delete(skill.id);
			updateSkillsMeta();
		});
	}
	return row;
}

function updateSkillsMeta() {
	const n = state.skills.size;
	$('skills-meta').textContent = `${n} skill${n === 1 ? '' : 's'} selected`;
}

// ── Step 4: Personality & voice ─────────────────────────────────────────────

function renderCategories() {
	const sel = $('f-category');
	CATEGORIES.forEach((c) => {
		const o = document.createElement('option');
		o.value = c;
		o.textContent = c.charAt(0).toUpperCase() + c.slice(1);
		sel.appendChild(o);
	});
}

function wirePersonality() {
	$('f-category').addEventListener('change', (e) => {
		state.category = e.target.value;
	});
	const greet = $('f-greeting');
	greet.addEventListener('input', () => {
		state.greeting = greet.value;
		$('greet-count').textContent = `${greet.value.length} / 200`;
	});
	const persona = $('f-persona');
	persona.addEventListener('input', () => {
		state.persona = persona.value;
		$('persona-count').textContent = `${persona.value.length} / 2000`;
	});

	document.querySelectorAll('[data-voice]').forEach((btn) => {
		btn.addEventListener('click', () => {
			state.voice = btn.dataset.voice;
			document.querySelectorAll('[data-voice]').forEach((b) => {
				const on = b === btn;
				b.classList.toggle('is-selected', on);
				b.setAttribute('aria-pressed', on ? 'true' : 'false');
			});
		});
	});
}

// ── Step 5: Review ──────────────────────────────────────────────────────────

function renderReview() {
	const modelLabel =
		state.model.mode === 'starter'
			? `${STARTERS.find((s) => s.id === state.model.starterId)?.name || 'Starter'} (starter)`
			: state.model.mode === 'library'
				? `${state.model.avatarName || 'Avatar'} (your library)`
				: state.model.mode === 'upload'
					? `${state.model.fileName}.glb (upload)`
					: `${DEFAULT_AVATAR.name} (default — add your own later)`;

	const skillNames = [...CORE_SKILLS, ...OPTIONAL_SKILLS]
		.filter((s) => state.skills.has(s.id))
		.map((s) => s.name);

	const rows = [
		{
			key: 'Name',
			step: 0,
			html: state.name.trim() ? escapeHtml(state.name) : '<span class="dim">Unnamed</span>',
		},
		{
			key: 'About',
			step: 0,
			html: state.description.trim()
				? escapeHtml(state.description)
				: '<span class="dim">No description</span>',
		},
		{
			key: 'Tags',
			step: 0,
			html: state.tags.length
				? `<div class="chips">${state.tags.map((t) => `<span class="mini-chip">${escapeHtml(t)}</span>`).join('')}</div>`
				: '<span class="dim">None</span>',
		},
		{ key: 'Body', step: 1, html: escapeHtml(modelLabel) },
		{
			key: 'Skills',
			step: 2,
			html: `<div class="chips">${skillNames.map((n) => `<span class="mini-chip">${escapeHtml(n)}</span>`).join('')}</div>`,
		},
		{
			key: 'Category',
			step: 3,
			html: state.category
				? escapeHtml(state.category.charAt(0).toUpperCase() + state.category.slice(1))
				: '<span class="dim">Not set</span>',
		},
		{
			key: 'Greeting',
			step: 3,
			html: state.greeting.trim()
				? escapeHtml(state.greeting)
				: '<span class="dim">Default</span>',
		},
		{
			key: 'Profile',
			step: 3,
			html: state.persona.trim()
				? escapeHtml(truncate(state.persona, 160))
				: '<span class="dim">Not set</span>',
		},
		{
			key: 'Voice',
			step: 3,
			html: state.voice === 'browser' ? 'Built-in voice' : 'Custom (set up later)',
		},
	];

	const grid = $('review-grid');
	grid.innerHTML = '';
	rows.forEach((r) => {
		const row = document.createElement('div');
		row.className = 'review-row';
		row.innerHTML = `
			<div class="review-key">${r.key}</div>
			<div class="review-val">${r.html}</div>
			<button type="button" class="review-edit" aria-label="Edit ${r.key}">Edit</button>`;
		row.querySelector('.review-edit').addEventListener('click', () => showStep(r.step));
		grid.appendChild(row);
	});

	// Publish toggle reflects state + gates on having what publish needs.
	const pub = $('f-publish');
	pub.checked = state.publish;
	pub.onchange = () => {
		state.publish = pub.checked;
		updatePublishNote();
	};
	updatePublishNote();
}

function updatePublishNote() {
	const note = $('publish-note');
	if (!state.publish) {
		note.textContent = 'Your agent will be private. You can list it anytime from its editor.';
		return;
	}
	const missing = [];
	if (!state.category) missing.push('a category');
	if (!state.persona.trim()) missing.push('a profile prompt');
	if (missing.length) {
		note.innerHTML = `Add ${missing.join(' and ')} (step 4) to list it. Otherwise it'll be created privately.`;
	} else {
		note.textContent =
			'Discoverable on the marketplace right after creation. You can unlist anytime.';
	}
}

// ── Submit ──────────────────────────────────────────────────────────────────

async function submit() {
	if (state.submitting) return;
	if (!state.name.trim()) {
		showStep(0);
		validateStep(0);
		return;
	}
	state.submitting = true;
	el.create.setAttribute('aria-busy', 'true');
	el.create.disabled = true;
	el.back.disabled = true;

	try {
		// 1. Resolve the 3D body to a real, owned avatar_id (if any).
		let avatarId = null;
		if (state.model.mode === 'starter' && state.model.starterUrl) {
			setMsg('Adding the 3D body to your library…', '');
			const av = await saveRemoteGlbToAccount(state.model.starterUrl, {
				source: 'import',
				name: state.name.trim(),
				source_meta: { provider: 'starter-library', source_url: state.model.starterUrl },
				visibility: 'public',
			});
			avatarId = av?.id || null;
		} else if (state.model.mode === 'upload' && state.model.file) {
			setMsg('Uploading your 3D model… 0%', '');
			const av = await saveRemoteGlbToAccount(state.model.file, {
				source: 'upload',
				name: state.model.fileName || state.name.trim(),
				visibility: 'public',
			}, {
				onProgress: (pct) => setMsg(`Uploading your 3D model… ${pct}%`, ''),
			});
			avatarId = av?.id || null;
		} else if (state.model.mode === 'library' && state.model.avatarId) {
			// Already an owned avatar — connect it directly, no copy needed.
			avatarId = state.model.avatarId;
		}

		// Every agent gets a real 3D body. If the user skipped (or a save above
		// silently returned nothing), assign the default starter so the agent is
		// never bodiless — no placeholder, a real owned avatar.
		if (!avatarId) {
			setMsg('Setting up a 3D body…', '');
			const av = await saveRemoteGlbToAccount(DEFAULT_AVATAR.url, {
				source: 'import',
				name: state.name.trim(),
				source_meta: {
					provider: 'starter-library',
					source_url: DEFAULT_AVATAR.url,
					default_assigned: true,
				},
				visibility: 'public',
			});
			avatarId = av?.id || null;
		}

		// 2. Create the agent identity.
		setMsg('Creating your agent…', '');
		const createBody = {
			name: state.name.trim(),
			description: state.description.trim() || undefined,
			skills: [...state.skills],
			avatar_id: avatarId || undefined,
			meta: {
				created_via: 'wizard',
				...(state.greeting.trim() ? { greeting: state.greeting.trim() } : {}),
				...(state.voice ? { voice_preference: state.voice } : {}),
				...(state.tags.length ? { wizard_tags: state.tags } : {}),
			},
		};
		const createRes = await apiFetch('/api/agents', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(createBody),
		});
		const createData = await createRes.json().catch(() => ({}));
		if (!createRes.ok) {
			if (createRes.status === 409) {
				// Identity conflict — send them back to rename.
				state.submitting = false;
				resetSubmitButton();
				showStep(0);
				const nameEl = $('f-name');
				nameEl.classList.add('is-invalid');
				nameEl.focus();
				setMsg(
					createData.error_description ||
						'That identity conflicts with an existing agent. Try a different name.',
					'err',
				);
				return;
			}
			throw new Error(
				createData.error_description ||
					createData.error ||
					`Create failed (${createRes.status})`,
			);
		}
		const agent = createData.agent;
		if (!agent?.id) throw new Error('Create succeeded but no agent was returned.');

		// The ephemeral companion draft is claimed — the real agent replaces it.
		clearGuestAgent();

		// Activation funnel: a real agent identity now exists.
		trackFunnelStep('activation', ANALYTICS_EVENTS.AGENT_CREATED, {
			agent_id: agent.id,
			source: 'wizard',
		});

		// 3. Personality + marketplace listing. Publish writes the system prompt,
		//    greeting, category, and tags to the real columns and lists the agent.
		//    Only attempted when the user opted in AND supplied what publish needs.
		const canPublish = state.publish && state.category && state.persona.trim();
		if (canPublish) {
			setMsg('Publishing to the marketplace…', '');
			try {
				const pubRes = await apiFetch(`/api/marketplace/agents/${agent.id}/publish`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						category: state.category,
						tags: state.tags,
						system_prompt: state.persona.trim(),
						greeting: state.greeting.trim() || undefined,
					}),
				});
				if (!pubRes.ok) {
					const pj = await pubRes.json().catch(() => ({}));
					// Non-fatal: the agent exists. Surface a soft warning on success.
					log.warn('[create-agent] publish failed', pj);
					agent._publishWarning =
						pj.error_description ||
						'Created, but listing on the marketplace failed — you can publish from the editor.';
				} else {
					agent._published = true;
				}
			} catch (err) {
				log.warn('[create-agent] publish error', err);
				agent._publishWarning =
					'Created, but listing on the marketplace failed — you can publish from the editor.';
			}
		}

		succeed(agent);
	} catch (err) {
		log.error('[create-agent] submit failed', err);
		trackError('create_agent.submit', err);
		state.submitting = false;
		resetSubmitButton();
		const code = err.data?.error || err.code || '';
		if (code === 'plan_limit_count' || code === 'plan_limit_storage') {
			showPlanLimitMsg();
		} else if (err.status === 413 || code === 'plan_limit_size') {
			setMsg(
				'That model file is too large for your plan — upload a smaller GLB or connect an avatar you already own.',
				'err',
			);
		} else {
			setMsg(err.message || 'Something went wrong. Please try again.', 'err');
		}
	}
}

function resetSubmitButton() {
	el.create.removeAttribute('aria-busy');
	el.create.disabled = false;
	el.back.disabled = false;
}

function succeed(agent) {
	// Swap the form body for the success state.
	el.panels.forEach((p) => p.classList.remove('is-active'));
	el.foot.style.display = 'none';
	$('stepper').style.display = 'none';
	el.success.classList.add('show');

	$('success-title').textContent = `${agent.name} is ready`;
	const sub = agent._published
		? 'It now has its own wallet and on-chain identity, and it’s live on the marketplace.'
		: agent._publishWarning ||
			'It now has its own wallet and on-chain identity. Open it to chat, customize, or share.';
	$('success-sub').textContent = sub;

	const open = $('success-open');
	open.href = agent.home_url || `/agent/${agent.id}`;
	$('success-edit').href = `/agent/${agent.id}/edit`;
	// Lead with "Go live" — the highest-value first step. The activation tab claims
	// the one-time on-chain welcome grant that funds the wallet AND lands the agent
	// on the Money Pulse in a single transaction.
	const activate = $('success-activate');
	if (activate) activate.href = `/agent/${agent.id}/wallet#activate`;
	// Funding by hand stays one tap away — the Deposit tab (QR + copy + live
	// confirmation) for owners who'd rather send their own SOL.
	const fund = $('success-fund');
	if (fund) fund.href = `/agent/${agent.id}/wallet#deposit`;

	// Show the 3D body if it's publicly readable.
	const modelUrl = agent.avatar_model_url;
	if (modelUrl) {
		const box = $('success-preview');
		box.hidden = false;
		const mv = document.createElement('model-viewer');
		mv.setAttribute('src', modelUrl);
		mv.setAttribute('alt', `${agent.name} 3D model`);
		mv.setAttribute('auto-rotate', '');
		mv.setAttribute('auto-rotate-delay', '0');
		mv.setAttribute('rotation-per-second', '20deg');
		mv.setAttribute('interaction-prompt', 'none');
		mv.setAttribute('disable-zoom', '');
		mv.setAttribute('shadow-intensity', '0.4');
		mv.setAttribute('exposure', '0.95');
		mv.setAttribute('environment-image', 'neutral');
		mv.setAttribute('camera-orbit', '15deg 80deg auto');
		box.appendChild(mv);
	}
	el.body.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function setMsg(text, kind) {
	el.footMsg.textContent = text;
	el.footMsg.className = 'foot-msg' + (kind ? ' ' + kind : '');
}

// Avatar-quota failures get recovery paths instead of the raw server message.
// Connecting an owned avatar is the one wizard path that doesn't create a new
// avatar record, so it always works at the cap — lead with it. Static markup
// only: never interpolate server text into innerHTML.
function showPlanLimitMsg() {
	el.footMsg.className = 'foot-msg err';
	el.footMsg.innerHTML =
		'Your avatar library is full for your plan. ' +
		'<button type="button" class="msg-link" id="msg-use-library">Connect an avatar you already own</button>, ' +
		'<a class="msg-link" href="/dashboard/avatars" target="_blank" rel="noopener">free up a slot</a>, or ' +
		'<a class="msg-link" href="/dashboard/monetize" target="_blank" rel="noopener">upgrade your plan</a>.';
	$('msg-use-library')?.addEventListener('click', () => {
		showStep(1);
		document.querySelector('.model-tab[data-pane="library"]')?.click();
	});
}
function clearMsg() {
	setMsg('', '');
}
function escapeHtml(s) {
	return String(s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
function truncate(s, n) {
	const t = String(s);
	return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

boot();
