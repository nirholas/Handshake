// Agent Creation Wizard — /create-agent
//
// A six-step, state-driven flow that produces a real agent identity:
//   1. Basics       → name, description, tags
//   2. 3D model     → starter library | own GLB upload | attach later
//   3. Skills       → core (always on) + optional capabilities
//   4. Personality  → category, greeting, profile prompt
//   5. Voice        → built-in speech, or a recorded/uploaded sample cloned onto
//                     the agent (src/voice/voice-setup.js) the moment it exists
//   6. Review       → POST /api/agents, voice bind, optional marketplace publish
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
import { draftHasContent, isDraftFresh } from './create-agent-draft.js';
import { VoiceSetup } from './voice/voice-setup.js';
import {
	INTERVIEW_QUESTIONS,
	normalizeInterview,
	hasInterviewSignal,
	MAX_ANSWER_CHARS,
} from './agents/persona-interview.js';

const TOTAL_STEPS = 6;
const STEP_LABELS = ['Basics', 'Model', 'Skills', 'Personality', 'Voice', 'Review'];
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
	// Onboarding interview (step 4). answers maps question id to raw text;
	// result is the structured extraction returned by POST /api/persona/interview
	// ({base, traits, tone_tags, vocabulary, persona_prompt, interview}).
	// generated remembers the exact base text the extractor produced so skip can
	// tell "untouched generated profile" apart from "user-edited profile".
	interview: { answers: {}, result: null, generated: '', busy: false },
	voice: 'browser',
	publish: true,
	submitting: false,
	// Resolved in boot(). Signed-out visitors build the whole agent and only
	// hit the account requirement at the final "ship it" step — the wizard is
	// never walled up front (that killed the flow before anyone got invested).
	authed: false,
};

// Draft persistence — lets a signed-out visitor build their whole agent, get
// sent to sign in at the ship step, and land back on a fully-restored Review
// with zero rework. Keyed in localStorage; cleared on a successful create.
const DRAFT_KEY = 'threews:create-agent:draft';

function saveDraft() {
	try {
		const d = {
			v: 1,
			savedAt: Date.now(),
			step: state.step,
			name: state.name,
			description: state.description,
			tags: state.tags,
			// A picked File can't survive a navigation; persist the reusable
			// pointers (starter id, owned-avatar id) and let submit's default-body
			// fallback cover a lost upload — never a dead end.
			model: {
				mode: state.model.mode === 'upload' ? 'skip' : state.model.mode,
				starterId: state.model.starterId,
				avatarId: state.model.avatarId,
				avatarUrl: state.model.avatarUrl,
				avatarName: state.model.avatarName,
				uploadLost: state.model.mode === 'upload' && !!state.model.file,
			},
			skills: [...state.skills],
			category: state.category,
			greeting: state.greeting,
			persona: state.persona,
			interview: {
				answers: { ...state.interview.answers },
				result: state.interview.result,
				generated: state.interview.generated,
			},
			voice: state.voice,
			publish: state.publish,
		};
		localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
	} catch {
		/* storage disabled — the ship-step sign-in still works, just without restore */
	}
}

function loadDraft() {
	try {
		const raw = localStorage.getItem(DRAFT_KEY);
		if (!raw) return null;
		const d = JSON.parse(raw);
		if (!d || d.v !== 1 || typeof d.name !== 'string') return null;
		// Expire stale drafts so a long-abandoned build never silently resumes.
		if (!isDraftFresh(d)) {
			clearDraft();
			return null;
		}
		return d;
	} catch {
		return null;
	}
}

// Debounced autosave so a guest who builds and then closes the tab (without
// reaching the ship step) can pick up exactly where they left off. Only writes
// once there's real content; never overwrites a draft with an empty form.
let draftSaveTimer;
// Set once the agent is created — stops autosave from resurrecting a draft for
// an agent that already exists (the success screen still holds the state).
let submitted = false;
function scheduleDraftSave() {
	if (submitted) return;
	clearTimeout(draftSaveTimer);
	draftSaveTimer = setTimeout(() => {
		if (draftHasContent(state)) saveDraft();
	}, 600);
}

// Actionable "you're resumed, want a clean slate?" note for a returning guest.
function showResumeNote() {
	el.footMsg.className = 'foot-msg';
	el.footMsg.innerHTML =
		'Resumed your saved draft. <button type="button" class="msg-link" id="msg-start-fresh">Start fresh</button>';
	$('msg-start-fresh')?.addEventListener('click', startFresh);
}

// Abandon the restored draft and start a clean build. Stop autosave first — the
// `beforeunload` flush would otherwise re-save the draft during the reload and
// resurrect exactly what we just cleared.
function startFresh() {
	submitted = true;
	clearTimeout(draftSaveTimer);
	clearDraft();
	window.location.reload();
}

function clearDraft() {
	try {
		localStorage.removeItem(DRAFT_KEY);
	} catch {
		/* nothing to clear */
	}
}

// Replay a saved draft through the same DOM-sync path a generated spec uses,
// so restore and AI-autofill can never drift. Owned-avatar selections are
// re-connected by id (they survive a redirect); a lost upload falls through to
// the default body on submit.
function restoreDraft(d) {
	applySpec({
		name: d.name,
		description: d.description,
		tags: Array.isArray(d.tags) ? d.tags : [],
		avatar_starter: d.model?.starterId || '',
		skills: Array.isArray(d.skills) ? d.skills : [],
		category: d.category,
		greeting: d.greeting,
		persona: d.persona,
		interview: d.interview,
		voice: d.voice,
	});
	state.publish = Boolean(d.publish);
	if (d.model?.mode === 'library' && d.model.avatarId) {
		state.model.mode = 'library';
		state.model.avatarId = d.model.avatarId;
		state.model.avatarUrl = d.model.avatarUrl || '';
		state.model.avatarName = d.model.avatarName || '';
	}
	return { uploadLost: Boolean(d.model?.uploadLost) };
}

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

	// Resolve auth, but never wall the wizard. Signing in is only required at the
	// final "ship it" step (the agent gets a wallet + on-chain identity there);
	// letting a visitor build the whole thing first is what earns that sign-in.
	let me = null;
	try {
		me = await getMe();
	} catch (err) {
		log.warn('[create-agent] auth probe failed', err?.message);
	}
	$('page-loading')?.remove();
	state.authed = Boolean(me);

	// A saved draft means the visitor built something before and came back —
	// either via the ship-step sign-in bounce, or just by leaving and returning
	// (autosave). Restore it and put them back where they were.
	const draft = loadDraft();
	if (draft) {
		const { uploadLost } = restoreDraft(draft);
		if (state.authed) {
			// Signed in (typically the ship-step bounce): drop straight on Review.
			clearDraft();
			showStep(TOTAL_STEPS - 1);
			setMsg(
				`Welcome back — ${state.name ? `${state.name} is` : "your agent is"} ready. Ship it below.`,
				'ok',
			);
		} else {
			// Guest returning to an in-progress build: resume the exact step, and
			// offer a clean start so restore is never a surprise.
			const savedStep = Number.isInteger(draft.step)
				? Math.min(Math.max(draft.step, 0), TOTAL_STEPS - 1)
				: 0;
			showStep(uploadLost ? 1 : savedStep);
			if (!uploadLost) showResumeNote();
		}
		if (uploadLost) {
			setMsg('Re-attach your uploaded model on step 2, or we’ll give it the default body.', '');
		}
	} else {
		prefillFromGuestDraft();
		showStep(0);
	}

	// An avatar handoff always wins over a restored draft: the visitor just
	// finished building that body and asked to turn it into an agent.
	applyAvatarHandoff();

	// Autosave the in-progress build: one delegated listener covers every text,
	// select, and checkbox field; button-driven changes (model, voice, step nav)
	// are caught by showStep and the unload flush below.
	el.form.addEventListener('input', scheduleDraftSave);
	el.form.addEventListener('change', scheduleDraftSave);
	window.addEventListener('beforeunload', () => {
		if (!submitted && draftHasContent(state)) saveDraft();
	});

	applyAuthAffordances();
}

// "Turn this into an agent" handoff. Every avatar surface that finishes with a
// body (marketplace avatar cards, /create/selfie, the gallery) sends the visitor
// here with ?avatar_id=&avatar_glb=&avatar_name=. This used to land on
// /agent/new, which minted a blank draft agent on page load; that route now 301s
// (or, when it carries these params, rewrites) to the canonical wizard, so the
// handoff has to be honoured here or the pre-selected body is silently lost.
//
// The params seed step 2's "library" mode directly — validateStep(1) only needs
// state.model.avatarId, so the selection is valid before /api/avatars has even
// answered, and renderLibrary() re-applies the highlight once it does.
function applyAvatarHandoff() {
	const params = new URLSearchParams(location.search);
	const avatarId = (params.get('avatar_id') || '').trim();
	const avatarGlb = (params.get('avatar_glb') || '').trim();
	const avatarName = (params.get('avatar_name') || '').trim();
	if (!avatarId && !avatarGlb) return;

	state.model = {
		mode: avatarId ? 'library' : 'starter',
		starterId: '',
		starterUrl: avatarId ? '' : avatarGlb,
		file: null,
		fileName: '',
		skipAck: false,
		avatarId,
		avatarUrl: avatarGlb,
		avatarName: avatarName || 'Untitled',
		_blobUrl: '',
	};

	// Open the pane that owns the seeded selection so the choice is visible
	// rather than implied. The library tab's own handler kicks off the fetch.
	const pane = avatarId ? 'library' : 'starter';
	document.querySelector(`.model-tab[data-pane="${pane}"]`)?.click();
	syncModelPreview();

	const nameEl = $('f-name');
	if (avatarName && nameEl && !nameEl.value.trim()) {
		const suggested = `${avatarName} Agent`.slice(0, 60);
		nameEl.value = suggested;
		state.name = suggested;
		$('name-count').textContent = `${suggested.length} / 60`;
	}
	setMsg(
		avatarName
			? `${avatarName} is attached as the 3D body — name it and keep going.`
			: 'Your avatar is attached as the 3D body — name it and keep going.',
		'ok',
	);

	// Canonicalise the URL: the handoff params have been consumed into state, and
	// a rewritten /agent/new?… request still shows the retired path in the bar.
	if (typeof history.replaceState === 'function') {
		history.replaceState({}, '', '/create-agent');
	}
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
	el.preview = $('model-preview');
	el.previewEmpty = $('model-preview-empty');
	el.magicInput = $('magic-input');
	el.magicGo = $('magic-go');
	el.magicMsg = $('magic-msg');
}

// Reflect auth state in the flow's affordances: honest ship-step CTA copy and a
// one-line "no account needed to build" reassurance for signed-out visitors.
function applyAuthAffordances() {
	if (el.create) {
		if (state.authed) {
			el.create.textContent = 'Create agent';
			el.create.setAttribute('aria-label', 'Create agent');
		} else {
			const who = firstWord(state.name) || 'your agent';
			el.create.textContent = `Sign in to ship ${who} →`;
			el.create.setAttribute('aria-label', `Sign in to ship ${who}`);
		}
	}
	const note = $('build-free-note');
	if (note) note.hidden = state.authed;
}

// First word of the name, for compact CTA copy ("Sign in to ship Vern →").
function firstWord(s) {
	return String(s || '').trim().split(/\s+/)[0] || '';
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

	if (isLast) {
		renderReview();
		applyAuthAffordances();
	}
	if (n === 1) syncModelPreview();

	// Move focus to the first field of the step for keyboard users.
	const panel = el.panels.find((p) => Number(p.dataset.step) === n);
	const focusable = panel?.querySelector(
		'input, textarea, select, button.opt, .starter, .dropzone',
	);
	requestAnimationFrame(() => focusable?.focus?.({ preventScroll: true }));
	el.body.scrollIntoView({ behavior: 'smooth', block: 'start' });

	// Persist progress on every step change so a returning guest resumes here.
	scheduleDraftSave();
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
			// Anyone can generate before signing in (try-first). The one guest
			// limit is a tight hourly rate cap, so turn that 429 into a sign-in
			// nudge, which is the real next step, not a "wait a moment".
			let msg;
			if (res.status === 429) {
				msg = state.authed
					? data.error_description ||
						'You’re generating quickly. Give it a few seconds and try again.'
					: 'That’s the guest generation limit. Sign in to keep going, or fill the form in by hand.';
			} else if (res.status === 401) {
				msg = 'Sign in to generate, or just fill the form in by hand.';
			} else {
				msg =
					data.error_description ||
					'Couldn’t generate that one. Try a different description or fill the form by hand.';
			}
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

	// Interview answers and any extraction result ride along with the spec/draft.
	// A spec without interview data (a fresh magic-generator fill) resets the
	// interview, so a new concept never inherits the previous one's voice.
	const iv = spec.interview && typeof spec.interview === 'object' ? spec.interview : null;
	state.interview.answers = iv?.answers && typeof iv.answers === 'object' ? { ...iv.answers } : {};
	state.interview.result = iv?.result && typeof iv.result === 'object' ? iv.result : null;
	state.interview.generated = typeof iv?.generated === 'string' ? iv.generated : '';
	syncInterviewFields();
	if (state.interview.result) {
		renderInterviewTags(state.interview.result.tone_tags);
		setInterviewStatus(
			`Profile written from ${normalizeInterview(state.interview.answers).length} of ${INTERVIEW_QUESTIONS.length} answers. Edit it below, or tweak your answers and regenerate.`,
			'ok',
		);
	} else {
		renderInterviewTags([]);
		setInterviewStatus('', '');
	}
	if (normalizeInterview(state.interview.answers).length) setInterviewOpen(true);

	state.voice = spec.voice === 'custom' ? 'custom' : 'browser';
	document.querySelectorAll('[data-voice]').forEach((b) => {
		const on = b.dataset.voice === state.voice;
		b.classList.toggle('is-selected', on);
		b.setAttribute('aria-pressed', on ? 'true' : 'false');
	});
	// A restored draft (or generated spec) that picked cloning re-opens the
	// capture panel; the sample itself never survives a reload, by design.
	if (state.voice === 'custom') mountVoiceSetup();
	else unmountVoiceSetup();

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

let libraryState = 'idle'; // idle | loading | loaded | signedout | error
let libraryAvatars = [];
let libraryOffset = 0;
let libraryHasMore = false;
const LIBRARY_PAGE = 50;

// The avatars API exposes the GLB as model_url (public/unlisted) or
// base_model_url; private avatars have neither. Resolve a renderable URL or ''.
const avatarModelUrl = (av) => av?.model_url || av?.base_model_url || '';

async function loadLibraryAvatars({ append = false } = {}) {
	if (libraryState === 'loading') return;
	if (
		!append &&
		(libraryState === 'loaded' || libraryState === 'error' || libraryState === 'signedout')
	) {
		renderLibrary();
		return;
	}
	libraryState = 'loading';
	if (!append) renderLibrary();
	try {
		const url = `/api/avatars?limit=${LIBRARY_PAGE + 1}&offset=${libraryOffset}`;
		// allowAnonymous: /api/avatars answers 401 to a guest, and without this the
		// shared 401 handler in api.js would bounce the whole tab to /login the
		// moment a signed-out visitor opened this tab, mid-wizard, on a flow whose
		// entire design is "build first, sign in only at the ship step". Owning the
		// 401 here keeps them in the wizard and renders a real next step instead.
		const res = await apiFetch(url, { credentials: 'include', allowAnonymous: true });
		if (res.status === 401) {
			libraryState = 'signedout';
			renderLibrary();
			return;
		}
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
	if (libraryState === 'signedout') {
		grid.innerHTML = note(
			'Sign in to reuse an avatar you already made. Nothing here is required: the Starter library and Upload tabs both work without an account, and you can connect an owned avatar later from the editor.',
		);
		const signin = document.createElement('button');
		signin.type = 'button';
		signin.className = 'btn btn--ghost';
		signin.style = 'grid-column:1/-1;margin-top:6px;justify-self:start';
		signin.textContent = 'Sign in';
		// Save first: the wizard is restored on return, so signing in from here
		// costs the visitor nothing they have already built.
		signin.addEventListener('click', () => {
			saveDraft();
			window.location.href = `/login?next=${encodeURIComponent('/create-agent')}`;
		});
		grid.appendChild(signin);
		return;
	}
	if (libraryState === 'error') {
		grid.innerHTML = note(
			"Couldn't load your avatars. Pick a starter or upload instead — you can connect one later from the editor.",
		);
		const retry = document.createElement('button');
		retry.type = 'button';
		retry.className = 'btn btn--ghost';
		retry.style = 'grid-column:1/-1;margin-top:6px;justify-self:start';
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
		more.className = 'btn btn--ghost';
		more.style = 'grid-column:1/-1;margin-top:6px;justify-self:start';
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
	mv.setAttribute('shadow-intensity', '1.0');
	mv.setAttribute('shadow-softness', '0.9');
	mv.setAttribute('exposure', '1.5');
	mv.setAttribute('tone-mapping', 'aces');
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

	wireInterview();

	document.querySelectorAll('[data-voice]').forEach((btn) => {
		btn.addEventListener('click', () => {
			state.voice = btn.dataset.voice;
			document.querySelectorAll('[data-voice]').forEach((b) => {
				const on = b === btn;
				b.classList.toggle('is-selected', on);
				b.setAttribute('aria-pressed', on ? 'true' : 'false');
			});
			if (state.voice === 'custom') mountVoiceSetup();
			else unmountVoiceSetup();
		});
	});
}

// ── Step 4: onboarding interview ────────────────────────────────────────────
// The interview is the zero-writing path to a real voice: the creator answers
// any of the shared INTERVIEW_QUESTIONS in their own words, the stateless
// /api/persona/interview endpoint runs them through the platform LLM chain, and
// the extracted paragraph lands in the profile field, editable. The structured
// result (traits, tone tags, vocabulary, answer provenance) rides in state and
// is persisted through /api/agents/:id/persona/save the moment the agent exists.

function wireInterview() {
	const box = $('interview-questions');
	if (!box) return;

	// Render the exact question set the extractor is told about. The module is
	// the single source of truth shared with the server, so the questions a
	// user sees can never drift from the extraction contract.
	box.innerHTML = '';
	for (const q of INTERVIEW_QUESTIONS) {
		const field = document.createElement('div');
		field.className = 'field interview-q';
		field.innerHTML = `
			<label class="field-label" for="iq-${q.id}">
				<span>${escapeHtml(q.prompt)}</span>
				<span class="count" id="iq-count-${q.id}">0 / ${MAX_ANSWER_CHARS}</span>
			</label>
			<textarea class="textarea" id="iq-${q.id}" data-question-id="${q.id}"
				maxlength="${MAX_ANSWER_CHARS}" placeholder="${escapeHtml(q.placeholder)}"></textarea>
			<p class="field-hint">${escapeHtml(q.hint)}</p>`;
		box.appendChild(field);
		const ta = field.querySelector('textarea');
		ta.addEventListener('input', () => {
			state.interview.answers[q.id] = ta.value;
			$(`iq-count-${q.id}`).textContent = `${ta.value.length} / ${MAX_ANSWER_CHARS}`;
			// Answers edited after a generation no longer match the written
			// profile; say so instead of silently shipping a stale voice.
			if (state.interview.result) {
				setInterviewStatus(
					'Answers changed since the profile was written. Regenerate to refresh it.',
					'',
				);
			}
			syncGenerateButton();
		});
	}

	$('interview-toggle').addEventListener('click', () => {
		setInterviewOpen($('interview-body').hidden, { focus: true });
	});
	$('interview-skip').addEventListener('click', skipInterview);
	$('interview-generate').addEventListener('click', runInterviewExtraction);
	syncGenerateButton();
}

function setInterviewOpen(open, { focus = false } = {}) {
	const body = $('interview-body');
	const toggle = $('interview-toggle');
	if (!body || !toggle) return;
	body.hidden = !open;
	toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
	toggle.textContent = open ? 'Close' : state.interview.result ? 'Edit answers' : 'Start';
	if (open && focus) {
		requestAnimationFrame(() => $(`iq-${INTERVIEW_QUESTIONS[0].id}`)?.focus({ preventScroll: true }));
	}
}

function setInterviewStatus(text, kind) {
	const status = $('interview-status');
	if (!status) return;
	status.textContent = text;
	status.className = 'interview-status' + (kind ? ` ${kind}` : '');
}

function renderInterviewTags(tags) {
	const box = $('interview-tags');
	if (!box) return;
	box.innerHTML = '';
	const list = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && t.trim()) : [];
	box.hidden = list.length === 0;
	for (const t of list) {
		const chip = document.createElement('span');
		chip.className = 'interview-tag';
		chip.textContent = t;
		box.appendChild(chip);
	}
}

function syncGenerateButton() {
	const btn = $('interview-generate');
	if (!btn) return;
	const answered = normalizeInterview(state.interview.answers).length;
	btn.disabled = state.interview.busy || answered === 0;
	$('interview-generate-label').textContent = state.interview.result
		? 'Regenerate'
		: 'Write the profile';
}

// Write state.interview.answers back into the question fields (draft restore,
// skip reset) and refresh the generate button.
function syncInterviewFields() {
	for (const q of INTERVIEW_QUESTIONS) {
		const ta = $(`iq-${q.id}`);
		if (!ta) continue;
		const val =
			typeof state.interview.answers[q.id] === 'string' ? state.interview.answers[q.id] : '';
		ta.value = val;
		$(`iq-count-${q.id}`).textContent = `${val.length} / ${MAX_ANSWER_CHARS}`;
	}
	syncGenerateButton();
}

// Skipping is a first-class outcome: clear the answers and any extraction, and
// when the profile field still holds the untouched generated text, clear that
// too. A profile the user has since edited is their own words and stays.
function skipInterview() {
	const generated = state.interview.generated;
	state.interview.answers = {};
	state.interview.result = null;
	state.interview.generated = '';
	if (generated && state.persona === generated) {
		state.persona = '';
		$('f-persona').value = '';
		$('persona-count').textContent = '0 / 2000';
	}
	syncInterviewFields();
	renderInterviewTags([]);
	setInterviewStatus('', '');
	setInterviewOpen(false);
	$('f-persona').focus();
	scheduleDraftSave();
}

async function runInterviewExtraction() {
	if (state.interview.busy) return;
	const answers = normalizeInterview(state.interview.answers);
	if (!hasInterviewSignal(answers)) {
		setInterviewStatus('Answer at least one question first, or skip the interview.', 'err');
		return;
	}
	state.interview.busy = true;
	const btn = $('interview-generate');
	btn.disabled = true;
	btn.setAttribute('aria-busy', 'true');
	setInterviewStatus('Writing the profile from your answers…', '');
	try {
		const res = await apiFetch('/api/persona/interview', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: state.name.trim(),
				description: state.description.trim(),
				greeting: state.greeting.trim(),
				answers,
			}),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw Object.assign(
				new Error(data.error_description || data.error || `Interview failed (${res.status})`),
				{ status: res.status, code: data.error },
			);
		}
		state.interview.result = {
			base: typeof data.base === 'string' ? data.base : '',
			traits: data.traits && typeof data.traits === 'object' ? data.traits : {},
			tone_tags: Array.isArray(data.tone_tags) ? data.tone_tags : [],
			vocabulary: Array.isArray(data.vocabulary) ? data.vocabulary : [],
			persona_prompt: typeof data.persona_prompt === 'string' ? data.persona_prompt : '',
			interview: Array.isArray(data.interview) ? data.interview : answers,
		};
		state.interview.generated = state.interview.result.base;
		// The extracted paragraph becomes the profile: visible, editable, and
		// exactly what the ship step persists.
		state.persona = state.interview.result.base;
		$('f-persona').value = state.persona;
		$('persona-count').textContent = `${state.persona.length} / 2000`;
		renderInterviewTags(state.interview.result.tone_tags);
		setInterviewStatus(
			`Profile written from ${answers.length} of ${INTERVIEW_QUESTIONS.length} answers. Edit it below, or tweak your answers and regenerate.`,
			'ok',
		);
		track('persona_interview_generate', {
			source: 'create_wizard',
			questions_answered: answers.length,
			ok: true,
		});
		scheduleDraftSave();
	} catch (err) {
		log.warn('[create-agent] interview extraction failed', err);
		trackError('create_agent.interview', err);
		track('persona_interview_generate', { source: 'create_wizard', ok: false });
		setInterviewStatus(
			err?.code === 'llm_unavailable' || err?.status === 503
				? 'The writer is offline right now. Write the profile yourself below, or try again shortly.'
				: err?.status === 429
					? 'Too many tries in a row. Give it a minute, or write the profile yourself below.'
					: err?.message || 'Something went wrong. Try again, or write the profile yourself below.',
			'err',
		);
	} finally {
		state.interview.busy = false;
		btn.removeAttribute('aria-busy');
		syncGenerateButton();
	}
}

// ── Step 5: Voice cloning ───────────────────────────────────────────────────

// The agent does not exist until the ship step, so the panel runs in
// bind:'later' mode: it holds the recorded/uploaded sample in memory and
// submit() calls bindTo(agent.id) the moment the agent is real. The same
// VoiceSetup component powers the editor and talk-mode clone modal, so the
// wizard gets record/upload, sample validation, and the inline BYOK key entry
// (PATCH /api/user/provider-keys) for free.
let voiceSetup = null;

function mountVoiceSetup() {
	const field = $('voice-clone-field');
	const host = $('voice-setup-host');
	if (!field || !host) return;
	field.hidden = false;
	if (voiceSetup) return;
	voiceSetup = new VoiceSetup(host, {
		bind: 'later',
		agentName: state.name.trim() || 'Agent',
		authed: state.authed,
	});
	voiceSetup
		.mount()
		.catch((err) => log.warn('[create-agent] voice setup mount failed', err));
	track(ANALYTICS_EVENTS.CTA_CLICKED, { cta: 'voice_custom', location: 'create_agent' });
}

function unmountVoiceSetup() {
	const field = $('voice-clone-field');
	if (field) field.hidden = true;
	voiceSetup?.destroy();
	voiceSetup = null;
}

// ── Step 6: Review ──────────────────────────────────────────────────────────

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
			step: 4,
			html:
				state.voice !== 'custom'
					? 'Built-in voice'
					: voiceSetup?.ready
						? 'Your voice (sample ready, clones on create)'
						: '<span class="dim">Custom, no sample yet: starts on the built-in voice</span>',
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
	// The one place an account is actually required: minting the agent's wallet +
	// on-chain identity. Save the finished draft, send them to sign in, and boot()
	// restores it on return so they ship in a single click — no rework.
	if (!state.authed) {
		saveDraft();
		trackFunnelStep('activation', ANALYTICS_EVENTS.AGENT_CREATED, {
			source: 'wizard',
			stage: 'signin_prompt',
		});
		const next = encodeURIComponent('/create-agent');
		window.location.href = `/login?next=${next}`;
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
		clearDraft();

		// Activation funnel: a real agent identity now exists.
		trackFunnelStep('activation', ANALYTICS_EVENTS.AGENT_CREATED, {
			agent_id: agent.id,
			source: 'wizard',
		});

		// 2.5 Voice: a held sample is cloned onto the agent now that it exists.
		//     Non-fatal by design: the agent is real either way, and the editor
		//     (or talk mode) can bind a voice later. A failure here must never
		//     fail the create.
		if (state.voice === 'custom' && voiceSetup?.ready) {
			setMsg('Cloning your voice…', '');
			voiceSetup.agentName = state.name.trim() || 'Agent';
			try {
				const bound = await voiceSetup.bindTo(agent.id);
				agent._voiceBound = Boolean(bound?.voice_id);
				track(ANALYTICS_EVENTS.VOICE_CLONE_BOUND, {
					agent_id: agent.id,
					billing: bound?.billing,
					source: 'wizard',
				});
			} catch (err) {
				log.warn('[create-agent] voice bind failed', err);
				trackError('create_agent.voice_bind', err);
				agent._voiceWarning = `${err.message} You can bind a voice anytime from the editor.`;
			}
		}

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

		// 4. Interview persona: when the onboarding interview produced a voice,
		//    persist the structured persona (base, traits, tone, vocabulary) with
		//    the interview provenance. Chat reads the compiled persona_prompt this
		//    write produces, and the public manifest reports the interview counts,
		//    so the interview visibly changes how the agent speaks. Best-effort,
		//    exactly like publish: identity and listing already exist, so a hiccup
		//    here is a soft warning, never a failed create.
		if (state.interview.result) {
			setMsg('Saving the interviewed voice…', '');
			try {
				const personaRes = await apiFetch(`/api/agents/${agent.id}/persona/save`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						// The profile textarea is the source of truth: it holds the
						// extracted paragraph plus any edits the user made on top.
						base: state.persona.trim(),
						traits: state.interview.result.traits,
						tone_tags: state.interview.result.tone_tags,
						vocabulary: state.interview.result.vocabulary,
						interview: state.interview.result.interview,
						changelog: 'Voice written from the onboarding interview',
					}),
				});
				if (!personaRes.ok) {
					const pj = await personaRes.json().catch(() => ({}));
					log.warn('[create-agent] persona save failed', pj);
					agent._publishWarning =
						agent._publishWarning ||
						pj.error_description ||
						'Created, but saving the interviewed voice failed. Re-run the interview from the Brain Studio.';
				}
			} catch (err) {
				log.warn('[create-agent] persona save error', err);
				agent._publishWarning =
					agent._publishWarning ||
					'Created, but saving the interviewed voice failed. Re-run the interview from the Brain Studio.';
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
	// The agent exists now — stop autosave from writing the draft back after it
	// was cleared (the success screen still holds the form state).
	submitted = true;
	clearTimeout(draftSaveTimer);
	// The sample was either bound above or abandoned; release the mic and the
	// object URLs before the form body is swapped for the success screen.
	voiceSetup?.destroy();
	voiceSetup = null;
	// Swap the form body for the success state.
	el.panels.forEach((p) => p.classList.remove('is-active'));
	el.foot.style.display = 'none';
	$('stepper').style.display = 'none';
	el.success.classList.add('show');

	$('success-title').textContent = `${agent.name} is ready`;
	const subParts = [
		agent._published
			? 'It now has its own wallet and on-chain identity, and it’s live on the marketplace.'
			: agent._publishWarning ||
					'It now has its own wallet and on-chain identity. Open it to chat, customize, or share.',
	];
	if (agent._voiceBound) subParts.push('It speaks in your cloned voice.');
	else if (agent._voiceWarning) subParts.push(agent._voiceWarning);
	$('success-sub').textContent = subParts.join(' ');

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

	// Pipeline handoffs: the agent is the hub, deployment is the next stage.
	// Each link opens the next-stage surface; the embed link pre-loads this
	// agent's 3D body into Widget Studio when the model is publicly readable.
	const embed = $('success-embed');
	if (embed) {
		embed.href = agent.avatar_model_url
			? `/studio?model=${encodeURIComponent(agent.avatar_model_url)}`
			: '/studio';
	}

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
		mv.setAttribute('shadow-intensity', '1.0');
		mv.setAttribute('shadow-softness', '0.9');
		mv.setAttribute('exposure', '1.5');
		mv.setAttribute('tone-mapping', 'aces');
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
