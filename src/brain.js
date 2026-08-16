// ── brain.js — Persona builder + multi-model playground ─────────────────────

import { renderMarkdown } from './shared/markdown.js';
import { apiFetch, noteSession } from './api.js';

// ── Provider roster ──────────────────────────────────────────────────────────
// The roster is NOT declared here. GET /api/brain/chat is the only place that
// knows which models this deployment can actually reach, and a second hardcoded
// copy on the client drifts against it in both directions: models the server
// added never appear in the picker, and keys the server dropped render as
// selectable entries that 400 at send time. Everything below is presentation
// applied to whatever that endpoint returns, with a fallback for every field so
// a model added server-side shows up here without a client change.
const NETWORK_COLORS = {
	'OpenAI · OpenRouter': '#a5b4fc',
	'Anthropic': '#caa24f',
	'OpenAI': '#74c0fc',
	'xAI': '#e8e8e8',
	'Groq': '#ff9a3c',
	'DashScope': '#69db7c',
	'ModelScope': '#40c057',
	'DeepSeek': '#888888',
	'IBM watsonx.ai': '#0f62fe',
	'NVIDIA NIM': '#76b900',
};
const UNKNOWN_NETWORK_COLOR = '#8a8a8a';

// Preferred opening line-up, filtered against what the server reports as
// usable for THIS visitor. Anything unusable falls through to the first live
// model, so the page never boots with a column that can only answer 401.
const DEFAULT_MODEL_KEYS = ['gpt-oss-120b', 'claude-sonnet-5', 'gpt-5.6-luna', 'groq-llama'];
const ANON_DEFAULT_MODEL_KEYS = ['gpt-oss-120b', 'nvidia-kimi-k2', 'nvidia-nemotron-120b', 'nvidia-llama4-maverick'];

const PMAP = new Map();

function decorateProvider(spec) {
	return {
		...spec,
		color: NETWORK_COLORS[spec.network] || UNKNOWN_NETWORK_COLOR,
		// The network already reads off the colour and the tooltip, so the pill
		// drops the redundant vendor prefix and keeps the part that identifies
		// the model. Any label without that prefix passes through untouched.
		short: String(spec.label || spec.key).replace(/^Claude\s+/, ''),
		meta: [spec.network, spec.tier, spec.maxOutput ? `${spec.maxOutput} tok out` : '']
			.filter(Boolean).join(' / '),
	};
}

function providerTitle(p) {
	const head = [p.label, p.network, p.tier].filter(Boolean).join(' · ');
	if (!p.available) return `${head} (not configured on this deployment)`;
	if (isLocked(p)) return `${head} (sign in to use this model)`;
	return p.description ? `${head}\n${p.description}` : head;
}

// A model the deployment can reach but this visitor cannot use yet. The server
// answers 401 for these while signed out, so the page marks them rather than
// letting a click turn into an error message inside a column.
function isLocked(p) {
	return Boolean(p.available && p.requiresAuth && !state.authed);
}
function isSelectable(p) {
	return Boolean(p.available) && !isLocked(p);
}

// ── Archetype quick-picks ────────────────────────────────────────────────────
const ARCHETYPES = [
	{
		label: 'Sharp Analyst',
		desc: 'Precise, data-driven, no fluff',
		persona: {
			tone: 'precise and analytical — cuts straight to the signal, no filler',
			communication_style: 'terse',
			vocabulary: ['signal', 'data shows', 'the numbers', 'bottom line', 'specifically'],
			interests: ['data analysis', 'systems thinking', 'metrics', 'pattern recognition'],
			dont_say: ['I think', 'maybe', 'sort of', 'kinda'],
			sample_greeting: 'Show me the data. What are we looking at?',
		},
	},
	{
		label: 'Casual Builder',
		desc: 'Relaxed, technical, maker energy',
		persona: {
			tone: 'chill but technical — perpetual builder mode, no corporate speak',
			communication_style: 'playful',
			vocabulary: ['ship it', 'hack it', "let's see", 'works for me', 'yeah no'],
			interests: ['building', 'Solana', 'crypto', 'side projects', 'tooling'],
			dont_say: ['synergy', 'leverage', 'pivot', 'stakeholder'],
			sample_greeting: 'Hey, what are we building today?',
		},
	},
	{
		label: 'Warm Helper',
		desc: 'Supportive, clear, encouraging',
		persona: {
			tone: 'warm and approachable — genuinely helpful, never condescending',
			communication_style: 'warm',
			vocabulary: ['happy to help', "let's figure this out", 'great question', 'of course'],
			interests: ['helping others', 'learning', 'problem solving', 'clarity'],
			dont_say: ["I can't", 'not my problem', 'as per my last email'],
			sample_greeting: 'Hey! What can I help you with today?',
		},
	},
	{
		label: 'Crypto Native',
		desc: 'On-chain mindset, degen fluent',
		persona: {
			tone: 'crypto-native, fast-thinking — direct and unfiltered, on-chain first',
			communication_style: 'terse',
			vocabulary: ['gm', 'ser', 'based', 'alpha', 'ngmi', 'wagmi', 'on-chain'],
			interests: ['DeFi', 'Solana', 'NFTs', 'token mechanics', 'on-chain data', 'wallets'],
			dont_say: ['traditional finance', 'guaranteed returns', 'trust me bro'],
			sample_greeting: "gm ser, what's the alpha today?",
		},
	},
	{
		label: 'Direct Expert',
		desc: 'No small talk, deep knowledge',
		persona: {
			tone: 'direct and authoritative — expertise over warmth, zero small talk',
			communication_style: 'terse',
			vocabulary: ['specifically', 'the issue is', 'correct approach', 'in practice', 'technically'],
			interests: ['deep technical work', 'first principles', 'correctness', 'architecture'],
			dont_say: ['just', 'basically', 'kind of', 'I feel like'],
			sample_greeting: 'What do you need?',
		},
	},
	{
		label: 'Playful Coach',
		desc: 'Energetic, motivating, fun',
		persona: {
			tone: 'high-energy and encouraging — real sense of humor, relentlessly positive',
			communication_style: 'playful',
			vocabulary: ["let's go", 'you got this', 'leveling up', 'crushing it', 'next level'],
			interests: ['growth', 'habits', 'productivity', 'mindset', 'momentum'],
			dont_say: ["can't", 'impossible', 'too hard', 'maybe later'],
			sample_greeting: "Let's gooo! What are we working on?",
		},
	},
	{
		label: 'Pro Advisor',
		desc: 'Thoughtful, structured, balanced',
		persona: {
			tone: 'measured and thorough — weighs tradeoffs carefully, avoids absolutes',
			communication_style: 'detailed',
			vocabulary: ['on one hand', 'consider that', 'the tradeoff is', 'in context', 'worth noting'],
			interests: ['strategy', 'decision making', 'risk', 'planning', 'nuance'],
			dont_say: ['definitely', 'obviously', 'always', 'never'],
			sample_greeting: "Happy to think through this with you. What's the situation?",
		},
	},
	{
		label: 'Creative Thinker',
		desc: 'Lateral connections, big ideas',
		persona: {
			tone: 'imaginative and curious — makes unexpected connections, always asks what if',
			communication_style: 'playful',
			vocabulary: ['imagine if', 'what if we', 'interesting angle', 'pattern here', 'reminds me of'],
			interests: ['creativity', 'design', 'art', 'innovation', 'lateral thinking'],
			dont_say: ["that's not possible", 'never been done', 'too risky'],
			sample_greeting: 'Ooh interesting — what are we exploring?',
		},
	},
];

// ── Auth hint ────────────────────────────────────────────────────────────────
function isAuthedHint() {
	try {
		const raw = localStorage.getItem('3dagent:auth-hint');
		if (!raw) return false;
		return JSON.parse(raw).authed === true;
	} catch { return false; }
}

// ── State ────────────────────────────────────────────────────────────────────
const state = {
	activeTab: 'persona',
	persona: null,
	personaEnabled: true,
	authed: isAuthedHint(),

	playMode: 'compare',
	focusKey: '',
	active: new Set(),
	sessions: [],
	currentId: null,
	streaming: false,
	agents: [],

	// Roster lifecycle: 'loading' until GET /api/brain/chat answers, then
	// 'ready' or 'error'. Every model control and the send button read this, so
	// there is exactly one place that decides whether the page can be driven.
	providerState: 'loading',
	providerError: '',
	selectionRestored: false,
};

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const escHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function uuid() {
	if (crypto?.randomUUID) return crypto.randomUUID();
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Persistence ──────────────────────────────────────────────────────────────
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function load(key) { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch { return null; } }

function persistSessions() { save('brain_sessions_v3', state.sessions); }
function loadSessions() { state.sessions = load('brain_sessions_v3') || []; }
function persistPersona() { save('brain_persona_v1', state.persona); }
function loadPersona() { state.persona = load('brain_persona_v1'); }
function persistSelection() { save('brain_models_v1', { active: [...state.active], focusKey: state.focusKey }); }

// ── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
	const el = $('brToast');
	el.textContent = msg;
	el.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function showNotice(msg) {
	const el = $('brNotice');
	el.textContent = msg;
	el.style.display = 'block';
	clearTimeout(el._t);
	el._t = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

// ── Markdown renderer ────────────────────────────────────────────────────────
// Model output goes through the shared sanitized pipeline (marked + DOMPurify).
// The class map keeps this page's existing md-* stylesheet contract.
const MD_CLASSES = {
	pre: 'md-code',
	'code:not(pre code)': 'md-ic',
	h1: 'md-h1',
	h2: 'md-h2',
	h3: 'md-h3',
	ul: 'md-ul',
	ol: 'md-ol',
	p: 'md-p',
};

function renderMd(text) {
	return renderMarkdown(text, { classes: MD_CLASSES });
}

// ── Session helpers ──────────────────────────────────────────────────────────
function newSession(system = '') {
	return { id: uuid(), name: 'New conversation', system, created: Date.now(), turns: [] };
}
function currentSession() { return state.sessions.find(s => s.id === state.currentId) || null; }
function autoName(session) {
	const first = session.turns[0]?.user;
	if (!first) return;
	const trimmed = first.trim().replace(/\s+/g, ' ');
	session.name = trimmed.length > 48 ? trimmed.slice(0, 46) + '...' : trimmed;
}

// ── Persona helpers ──────────────────────────────────────────────────────────
function buildPersonaSystemPrompt(persona) {
	if (!persona) return '';
	const parts = [];
	parts.push(`You are an AI agent with a specific persona. Respond in character.`);
	if (persona.tone) parts.push(`Tone: ${persona.tone}`);
	if (persona.communication_style) parts.push(`Communication style: ${persona.communication_style}`);
	if (persona.vocabulary?.length) parts.push(`Vocabulary you use: ${persona.vocabulary.join(', ')}`);
	if (persona.interests?.length) parts.push(`Interests: ${persona.interests.join(', ')}`);
	if (persona.dont_say?.length) parts.push(`Never say: ${persona.dont_say.join(', ')}`);
	if (persona.sample_greeting) parts.push(`Example greeting: "${persona.sample_greeting}"`);
	return parts.join('\n');
}

function getEffectiveSystemPrompt() {
	const manual = $('brSystem').value.trim();
	if (manual) return manual;
	if (state.persona && state.personaEnabled) return buildPersonaSystemPrompt(state.persona);
	return '';
}

// ── Render: Tabs ─────────────────────────────────────────────────────────────
function setTab(tab) {
	state.activeTab = tab;
	document.querySelectorAll('.br-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
	$('brPanelPersona').classList.toggle('active', tab === 'persona');
	$('brPanelPlayground').classList.toggle('active', tab === 'playground');
}

// ── Render: Archetype quick-picks ────────────────────────────────────────────
function renderArchetypes() {
	const grid = $('brArchetypeGrid');
	if (!grid) return;
	grid.innerHTML = ARCHETYPES.map((a, i) => `
		<button class="br-archetype-chip" data-archetype="${i}" type="button" aria-pressed="false">
			<span class="br-archetype-chip-label">${escHtml(a.label)}</span>
			<span class="br-archetype-chip-desc">${escHtml(a.desc)}</span>
		</button>
	`).join('');
	grid.querySelectorAll('.br-archetype-chip').forEach(chip => {
		chip.addEventListener('click', () => applyArchetype(parseInt(chip.dataset.archetype, 10)));
	});
}

function applyArchetype(index) {
	const archetype = ARCHETYPES[index];
	if (!archetype) return;
	state.persona = { ...archetype.persona, _label: archetype.label };
	persistPersona();
	renderPersonaCard(state.persona);
	updateStatusBar(archetype.label);
	document.querySelectorAll('.br-archetype-chip').forEach((chip, i) => {
		chip.classList.toggle('selected', i === index);
		chip.setAttribute('aria-pressed', String(i === index));
	});
	autoSavePersonaToAgent(archetype.label);
}

// Clearing has to unwind every surface the persona lit up. The sidebar used to
// run its own shorter version and left the status bar, the persona card and the
// selected archetype chip behind, all describing a persona that no longer
// existed.
function clearPersona() {
	state.persona = null;
	persistPersona();
	$('brPersonaCard').classList.remove('show');
	$('brStatusBar').classList.remove('show');
	$('brToggleAdvanced').textContent = 'Customize';
	document.querySelectorAll('.br-archetype-chip').forEach(chip => {
		chip.classList.remove('selected');
		chip.setAttribute('aria-pressed', 'false');
	});
	updatePersonaMini();
	updatePersonaBanner();
	toast('Persona cleared');
}

function showAuthGate() {
	let gate = $('brAuthGate');
	if (gate) { gate.style.display = ''; return; }
	gate = document.createElement('div');
	gate.id = 'brAuthGate';
	gate.className = 'br-auth-gate';
	gate.innerHTML = `
		<div class="br-auth-gate-inner">
			<span class="br-auth-gate-icon">&#128274;</span>
			<strong>Sign in to build your persona</strong>
			<p>Your answers stay in your browser. Sign in so we can generate the persona on the server.</p>
			<a href="/login?redirect=/brain" class="br-btn br-btn-primary">Sign in</a>
		</div>
	`;
	const hero = document.querySelector('.br-persona-hero');
	if (hero) hero.after(gate);
	else document.querySelector('.br-persona-inner')?.prepend(gate);
}

function hideAuthGate() {
	const gate = $('brAuthGate');
	if (gate) gate.style.display = 'none';
}

// ── Status bar (simplified view of active persona) ───────────────────────────
function updateStatusBar(label) {
	const bar = $('brStatusBar');
	const text = $('brStatusText');
	if (!state.persona) {
		bar.classList.remove('show');
		return;
	}
	text.textContent = label || state.persona._label || 'Custom persona';
	bar.classList.add('show');
}

// ── Auto-save persona to the currently selected agent ───────────────────────
async function autoSavePersonaToAgent(label) {
	const agentId = $('brAgentSelect').value;
	if (!agentId || !state.persona) return;

	const bar = $('brStatusBar');
	bar.classList.add('saving');

	try {
		const persona = {
			system_prompt: buildPersonaSystemPrompt(state.persona),
			tone: state.persona.tone,
			traits: [
				...(state.persona.vocabulary || []),
				...(state.persona.interests || []),
			],
		};
		const res = await apiFetch(`/api/agents/${agentId}`, {
			method: 'PUT',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ persona }),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `HTTP ${res.status}`);
		}
		bar.classList.remove('saving');
		bar.classList.add('saved');
		setTimeout(() => bar.classList.remove('saved'), 2200);
	} catch (err) {
		bar.classList.remove('saving');
		toast(`Save failed: ${err.message}`);
	}
}

// ── Render: Persona card ─────────────────────────────────────────────────────
function renderPersonaCard(p) {
	$('brPcTone').textContent = p.tone || '-';
	$('brPcStyle').textContent = p.communication_style || '-';
	renderChips($('brPcVocab'), p.vocabulary, 'br-chip br-chip-blue');
	renderChips($('brPcInterests'), p.interests, 'br-chip br-chip-purple');
	renderChips($('brPcDont'), p.dont_say, 'br-chip br-chip-red');
	$('brPcGreet').textContent = p.sample_greeting ? `"${p.sample_greeting}"` : '-';
	$('brRawJson').textContent = JSON.stringify(p, null, 2);
	updatePersonaMini();
	updatePersonaBanner();
}

function renderChips(container, list, cls) {
	container.innerHTML = '';
	if (!list?.length) { container.innerHTML = '<span style="color:#4a4e6a;font-size:12px">-</span>'; return; }
	for (const item of list) {
		const span = document.createElement('span');
		span.className = cls;
		span.textContent = item;
		container.appendChild(span);
	}
}

function updatePersonaMini() {
	const mini = $('brPersonaMini');
	if (state.persona) {
		mini.classList.add('has-persona');
		$('brMiniTone').textContent = state.persona.tone || 'Custom persona';
		$('brMiniStyle').textContent = state.persona.communication_style ? `Style: ${state.persona.communication_style}` : '';
		$('brPersonaBadge').classList.add('on');
	} else {
		mini.classList.remove('has-persona');
		$('brPersonaBadge').classList.remove('on');
	}
}

function updatePersonaBanner() {
	const banner = $('brPersonaBanner');
	if (state.persona && state.personaEnabled) {
		banner.classList.add('show');
		$('brBannerTone').textContent = state.persona.tone || 'Active';
	} else {
		banner.classList.remove('show');
	}
}

// ── Persona: Synthesis from description ─────────────────────────────────────
async function synthesizeFromDescription() {
	const text = $('brDescribeInput').value.trim();
	if (!text) return;
	if (!state.authed) { showAuthGate(); return; }
	await runExtraction({ freeform: text });
}

async function runExtraction(payload) {
	$('brLoading').classList.add('show');
	$('brPersonaCard').classList.remove('show');

	try {
		const body = payload.answers
			? JSON.stringify({ answers: payload.answers })
			: JSON.stringify({ freeform: payload.freeform });

		const res = await fetch('/api/persona/extract', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body,
		});

		if (res.status === 401) {
			state.authed = false;
			showAuthGate();
			toast('Sign in to synthesize your persona.');
			return;
		}

		const data = await res.json();
		if (!res.ok) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);

		state.authed = true;
		state.persona = data.persona;
		persistPersona();
		renderPersonaCard(state.persona);
		updateStatusBar('Custom persona');
		autoSavePersonaToAgent('Custom persona');
	} catch (err) {
		toast(`Extraction failed: ${err.message}`);
	} finally {
		$('brLoading').classList.remove('show');
	}
}


// ── Persona: Edit inline ─────────────────────────────────────────────────────
function openEditMode() {
	if (!state.persona) return;
	const p = state.persona;
	$('brEditTone').value = p.tone || '';
	$('brEditStyle').value = p.communication_style || 'warm';
	$('brEditVocab').value = (p.vocabulary || []).join(', ');
	$('brEditInterests').value = (p.interests || []).join(', ');
	$('brEditDont').value = (p.dont_say || []).join(', ');
	$('brEditGreet').value = p.sample_greeting || '';
	$('brPcBody').style.display = 'none';
	$('brPcEditBody').style.display = 'flex';
	$('brEditPersona').style.display = 'none';
}

function saveEdit() {
	const split = v => v.split(',').map(s => s.trim()).filter(Boolean);
	state.persona = {
		_label: state.persona?._label || 'Custom persona',
		tone: $('brEditTone').value.trim() || 'Neutral',
		communication_style: $('brEditStyle').value,
		vocabulary: split($('brEditVocab').value),
		interests: split($('brEditInterests').value),
		dont_say: split($('brEditDont').value),
		sample_greeting: $('brEditGreet').value.trim(),
	};
	persistPersona();
	closeEditMode();
	renderPersonaCard(state.persona);
	updateStatusBar(state.persona._label);
	toast('Persona updated');
}

function closeEditMode() {
	$('brPcBody').style.display = '';
	$('brPcEditBody').style.display = 'none';
	$('brEditPersona').style.display = '';
}

// ── Persona: Agent list + auto-select ────────────────────────────────────────
// Resolve the session once per tab. /api/auth/me answers 200 with
// `{ user: null }` when signed out, so this costs one clean request and buys
// the owner-only roster read (/api/agents) an answer up front instead of a 401
// that lands as a red console error on every signed-out visit.
let _sessionPromise = null;
function hasSession() {
	if (!_sessionPromise) {
		_sessionPromise = fetch('/api/auth/me', { credentials: 'include', headers: { accept: 'application/json' } })
			.then(r => (r.ok ? r.json() : null))
			.then(d => !!(d && d.user))
			.catch(() => false)
			.then(ok => { noteSession(ok); return ok; });
	}
	return _sessionPromise;
}

function setAgentSelectMessage(text) {
	const sel = $('brAgentSelect');
	sel.innerHTML = `<option value="">${escHtml(text)}</option>`;
	sel.disabled = true;
}

async function loadAgents() {
	const sel = $('brAgentSelect');
	state.authed = await hasSession();
	if (!state.authed) {
		setAgentSelectMessage('Sign in to save to an agent');
		return;
	}

	try {
		const res = await apiFetch('/api/agents', {
			credentials: 'include',
			allowAnonymous: true,
			headers: { accept: 'application/json' },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		state.agents = data.agents || data || [];
		renderAgentSelect();
		// Auto-select most recently used agent, or fall back to first
		const saved = load('brain_active_agent');
		if (saved && state.agents.find(a => a.id === saved)) {
			sel.value = saved;
		} else if (state.agents.length > 0) {
			sel.value = state.agents[0].id;
		}
	} catch {
		setAgentSelectMessage('Could not load your agents');
	}
}

function renderAgentSelect() {
	const sel = $('brAgentSelect');
	if (!state.agents.length) {
		setAgentSelectMessage('No agents yet');
		return;
	}
	sel.disabled = false;
	sel.innerHTML = state.agents.map(a =>
		`<option value="${escHtml(a.id)}">${escHtml(a.name || `Agent ${a.id.slice(0,8)}`)}</option>`
	).join('');
}

// ── Render: Sidebar sessions ─────────────────────────────────────────────────
function renderSidebar() {
	const el = $('brSessions');
	if (!state.sessions.length) {
		el.innerHTML = '<div class="br-empty">No sessions yet.<br>Send a message to start.</div>';
		return;
	}
	el.innerHTML = state.sessions.map(s => `
		<div class="br-sess${s.id === state.currentId ? ' active' : ''}">
			<button type="button" class="br-sess-name" data-id="${escHtml(s.id)}"${s.id === state.currentId ? ' aria-current="true"' : ''}>${escHtml(s.name)}</button>
			<button type="button" class="br-sess-del" data-del="${escHtml(s.id)}" title="Delete session" aria-label="Delete session ${escHtml(s.name)}">x</button>
		</div>
	`).join('');
}

// ── Render: Playground toolbar ───────────────────────────────────────────────
function renderPlayControls() {
	const ctrl = $('brPlayControls');
	const label = $('brPlayLabel');

	if (state.providerState === 'loading') {
		label.textContent = 'Models';
		ctrl.innerHTML = `<div class="br-play-status" role="status">
			<span class="br-spin"></span>
			<span>Loading models…</span>
		</div>`;
		return;
	}

	if (state.providerState === 'error') {
		label.textContent = 'Models';
		ctrl.innerHTML = `<div class="br-play-status br-play-status-error" role="alert">
			<span>Model list unavailable: ${escHtml(state.providerError)}</span>
			<button type="button" class="br-btn br-btn-secondary br-btn-sm" data-retry-providers>Retry</button>
		</div>`;
		return;
	}

	if (state.playMode === 'compare') {
		label.textContent = 'Models';
		ctrl.innerHTML = `<div class="br-provider-pills">${
			[...PMAP.values()].map(p => {
				const locked = isLocked(p);
				const cls = ['br-pill', state.active.has(p.key) ? 'on' : '', locked ? 'locked' : ''].filter(Boolean).join(' ');
				const badge = !p.available
					? '<span class="br-pill-na" aria-hidden="true">✕</span>'
					: locked ? '<span class="br-pill-lock" aria-hidden="true">&#128274;</span>' : '';
				return `<button type="button" class="${cls}" style="--pc:${p.color}" data-key="${escHtml(p.key)}"
					aria-pressed="${state.active.has(p.key)}"${p.available ? '' : ' disabled'}
					title="${escHtml(providerTitle(p))}">
					<span class="br-pill-dot"></span>
					<span>${escHtml(p.short)}</span>
					${badge}
				</button>`;
			}).join('')
		}</div>`;
	} else {
		label.textContent = 'Model';
		ctrl.innerHTML = `<select class="br-focus-sel" id="brFocusSel" aria-label="Model">${
			[...PMAP.values()].map(p => {
				const suffix = !p.available ? ' (unavailable)' : isLocked(p) ? ' (sign in)' : '';
				return `<option value="${escHtml(p.key)}"${p.key === state.focusKey ? ' selected' : ''}${p.available ? '' : ' disabled'}>${escHtml(p.label)}${suffix}</option>`;
			}).join('')
		}</select>`;
	}
	bindPlayControlEvents();
}

// Restore the saved line-up once, then drop anything this deployment cannot
// serve. Runs on every successful roster load, so a model that goes offline
// between visits is dropped instead of failing on the next send.
function reconcileSelection() {
	const usableKeys = [...PMAP.values()].filter(isSelectable).map(p => p.key);
	const usable = new Set(usableKeys);

	if (!state.selectionRestored) {
		const saved = load('brain_models_v1');
		if (Array.isArray(saved?.active)) state.active = new Set(saved.active);
		if (typeof saved?.focusKey === 'string') state.focusKey = saved.focusKey;
		state.selectionRestored = true;
	}

	for (const key of [...state.active]) if (!usable.has(key)) state.active.delete(key);
	if (!state.active.size) {
		const preferred = state.authed ? DEFAULT_MODEL_KEYS : ANON_DEFAULT_MODEL_KEYS;
		for (const key of preferred) if (usable.has(key)) state.active.add(key);
	}
	if (!state.active.size && usableKeys.length) state.active.add(usableKeys[0]);
	if (!usable.has(state.focusKey)) state.focusKey = [...state.active][0] || usableKeys[0] || '';
	persistSelection();
}

async function fetchProviderRoster() {
	state.providerState = 'loading';
	state.providerError = '';
	renderPlayControls();
	renderCanvas();
	updateSendAvailability();

	try {
		const res = await fetch('/api/brain/chat', { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const providers = Array.isArray(data.providers) ? data.providers.filter(p => p?.key) : [];
		if (!providers.length) throw new Error('no models returned');

		PMAP.clear();
		for (const spec of providers) PMAP.set(spec.key, decorateProvider(spec));
		state.providerState = 'ready';
		reconcileSelection();
	} catch (err) {
		state.providerState = 'error';
		state.providerError = err.message || 'network error';
	}

	renderPlayControls();
	renderCanvas();
	updateSendAvailability();
}

// One place decides whether a prompt can be sent, so the button never invites a
// click that can only fail.
function updateSendAvailability() {
	const send = $('brSend');
	const ready = state.providerState === 'ready';
	send.disabled = !ready || state.streaming;
	send.title = ready ? '' : 'Waiting for the model list';
}

// ── Render: Compare canvas ───────────────────────────────────────────────────
function renderCompareCanvas() {
	const canvas = $('brCanvas');
	const session = currentSession();
	const active = [...state.active];
	canvas.innerHTML = `<div class="br-compare">${
		active.map(key => {
			const p = PMAP.get(key);
			if (!p) return '';
			return `
				<div class="br-col" data-col="${escHtml(key)}" style="--pc:${p.color}">
					<div class="br-col-head">
						<div>
							<div class="br-col-name" title="${escHtml(providerTitle(p))}">${escHtml(p.short)}</div>
							<div class="br-col-meta">${escHtml(p.meta)}</div>
						</div>
						<div style="display:flex;gap:6px;align-items:center">
							<div class="br-col-stats" data-stats="${escHtml(key)}"></div>
							<button class="br-col-copy" data-copy="${escHtml(key)}">Copy</button>
						</div>
					</div>
					<div class="br-col-msgs" data-msgs="${escHtml(key)}">
						${session?.turns.length ? renderColTurns(session, key) : '<div class="br-col-empty">Waiting for a message...</div>'}
					</div>
				</div>`;
		}).join('')
	}</div>`;
}

function renderColTurns(session, provKey) {
	return session.turns.map(turn => {
		let html = `<div class="br-col-user">${escHtml(turn.user)}</div>`;
		const resp = turn.responses[provKey];
		if (resp?.text) html += `<div class="br-col-assistant">${renderMd(resp.text)}</div>`;
		else if (resp?.error) html += `<div class="br-col-assistant" style="color:#ff8a8a">${escHtml(resp.error)}</div>`;
		return html;
	}).join('');
}

// ── Render: Chat canvas ──────────────────────────────────────────────────────
function renderChatCanvas() {
	const canvas = $('brCanvas');
	const session = currentSession();
	const p = PMAP.get(state.focusKey);

	if (!session || !session.turns.length) {
		canvas.innerHTML = `
			<div class="br-chat">
				<div class="br-chat-empty">
					<h3>Start a conversation</h3>
					<p>Messages are sent to <strong style="color:${p?.color || '#fff'}">${escHtml(p?.label || state.focusKey)}</strong>.
					Switch to Compare mode to query all models at once.</p>
				</div>
			</div>`;
		return;
	}

	const msgHtml = session.turns.map(turn => {
		const resp = turn.responses[state.focusKey];
		let html = `
			<div class="br-msg user">
				<div class="br-msg-label">You</div>
				<div class="br-msg-body">${escHtml(turn.user)}</div>
			</div>`;
		if (resp?.text) {
			html += `
				<div class="br-msg assistant" style="--pc:${escHtml(p?.color || '#fff')}">
					<div class="br-msg-label">${escHtml(p?.short || state.focusKey)}</div>
					<div class="br-msg-body">${renderMd(resp.text)}</div>
				</div>`;
		} else if (resp?.error) {
			html += `
				<div class="br-msg assistant">
					<div class="br-msg-label" style="color:#ff8a8a">Error</div>
					<div class="br-msg-body" style="color:#ff8a8a">${escHtml(resp.error)}</div>
				</div>`;
		}
		return html;
	}).join('');

	canvas.innerHTML = `
		<div class="br-chat">
			<div class="br-chat-msgs" id="brChatMsgs">${msgHtml}</div>
		</div>`;
}

// Until the roster resolves there is no honest column to draw, so the canvas
// owns the loading and failure states rather than rendering an empty grid that
// looks ready and answers nothing.
function renderRosterState() {
	const canvas = $('brCanvas');
	if (state.providerState === 'loading') {
		canvas.innerHTML = `
			<div class="br-canvas-state" role="status">
				<span class="br-spin"></span>
				<p>Loading the model roster…</p>
			</div>`;
		return true;
	}
	if (state.providerState === 'error') {
		canvas.innerHTML = `
			<div class="br-canvas-state br-canvas-state-error" role="alert">
				<h3>Model list unavailable</h3>
				<p>The playground could not reach the model service (${escHtml(state.providerError)}), so no prompt can be sent yet. Your sessions and persona are safe in this browser.</p>
				<button type="button" class="br-btn br-btn-primary br-btn-sm" data-retry-providers>Try again</button>
			</div>`;
		return true;
	}
	return false;
}

function renderCanvas() {
	if (renderRosterState()) return;
	if (state.playMode === 'compare') renderCompareCanvas();
	else renderChatCanvas();
}

// ── Scroll ───────────────────────────────────────────────────────────────────
function scrollColToBottom(key) {
	const el = document.querySelector(`[data-msgs="${key}"]`);
	if (el) el.scrollTop = el.scrollHeight;
}
function scrollChatToBottom() {
	const el = document.getElementById('brChatMsgs');
	if (el) el.scrollTop = el.scrollHeight;
}

// ── Streaming ────────────────────────────────────────────────────────────────
async function streamProvider(provKey, messages, system, { onChunk, onDone, onError, signal }) {
	let res;
	try {
		res = await fetch('/api/brain/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal,
			body: JSON.stringify({ provider: provKey, messages, system: system || undefined, maxTokens: 1024 }),
		});
	} catch (err) {
		if (err.name !== 'AbortError') onError?.(err.message || 'Network error');
		return;
	}

	if (!res.ok || !res.body) {
		const txt = await res.text().catch(() => '');
		onError?.(`HTTP ${res.status}: ${txt || res.statusText}`);
		return;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let gotDone = false;
	const t0 = performance.now();

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf('\n\n')) !== -1) {
				const event = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				let evType = 'message', data = '';
				for (const line of event.split('\n')) {
					if (line.startsWith('event:')) evType = line.slice(6).trim();
					else if (line.startsWith('data:')) data += line.slice(5).trim();
				}
				if (evType === 'message' && data && data !== '[DONE]') {
					try { onChunk?.(JSON.parse(data)); } catch {}
				} else if (evType === 'done') {
					gotDone = true;
					try {
						const info = JSON.parse(data);
						onDone?.({ elapsedMs: info.elapsedMs, usage: info.usage });
					} catch {}
				} else if (evType === 'error') {
					try { onError?.(JSON.parse(data).message || 'upstream error'); } catch {}
				}
			}
		}
	} finally {
		if (!gotDone) onDone?.({ elapsedMs: Math.round(performance.now() - t0), usage: null });
	}
}

function buildMessages(session, provKey, newUserMessage) {
	const messages = [];
	for (const turn of session.turns) {
		messages.push({ role: 'user', content: turn.user });
		const resp = turn.responses[provKey];
		if (resp?.text) messages.push({ role: 'assistant', content: resp.text });
	}
	messages.push({ role: 'user', content: newUserMessage });
	return messages;
}

// ── Send message ─────────────────────────────────────────────────────────────
async function sendMessage() {
	const promptEl = $('brPrompt');
	const text = promptEl.value.trim();
	if (!text || state.streaming) return;
	if (state.providerState !== 'ready') {
		showNotice(state.providerState === 'error'
			? 'The model list failed to load. Retry it before sending.'
			: 'Still loading the model list. One moment.');
		return;
	}

	const activeKeys = (state.playMode === 'compare' ? [...state.active] : [state.focusKey]).filter(Boolean);
	if (!activeKeys.length) { showNotice('Select at least one model.'); return; }

	const system = getEffectiveSystemPrompt();
	promptEl.value = '';

	if (!state.currentId) {
		const s = newSession(system);
		state.sessions.unshift(s);
		state.currentId = s.id;
	}

	const session = currentSession();
	if (!session) return;

	const turn = { id: uuid(), user: text, responses: {} };
	session.turns.push(turn);
	autoName(session);
	persistSessions();
	renderSidebar();

	state.streaming = true;
	updateSendAvailability();

	renderCanvas();
	if (state.playMode === 'compare') activeKeys.forEach(scrollColToBottom);
	else scrollChatToBottom();

	// Add streaming indicators
	if (state.playMode === 'compare') {
		for (const key of activeKeys) {
			const el = document.querySelector(`[data-msgs="${key}"]`);
			if (el) {
				const spin = document.createElement('div');
				spin.className = 'br-col-assistant';
				spin.dataset.stream = key;
				spin.innerHTML = '<span class="br-spin"></span>';
				el.appendChild(spin);
				el.scrollTop = el.scrollHeight;
			}
		}
	} else {
		const msgs = document.getElementById('brChatMsgs');
		if (msgs) {
			const spin = document.createElement('div');
			spin.className = 'br-msg assistant';
			spin.dataset.streamChat = state.focusKey;
			spin.style.setProperty('--pc', PMAP.get(state.focusKey)?.color || '#fff');
			const p = PMAP.get(state.focusKey);
			spin.innerHTML = `<div class="br-msg-label">${escHtml(p?.short || state.focusKey)}</div><div class="br-msg-body"><span class="br-spin"></span></div>`;
			msgs.appendChild(spin);
			msgs.scrollTop = msgs.scrollHeight;
		}
	}

	const abortCtrl = new AbortController();

	await Promise.all(activeKeys.map(async key => {
		const messages = buildMessages(session, key, text);
		let accumulated = '';

		return streamProvider(key, messages, system, {
			signal: abortCtrl.signal,
			onChunk(delta) {
				accumulated += delta;
				turn.responses[key] = turn.responses[key] || { text: '', elapsedMs: 0, usage: null };
				turn.responses[key].text = accumulated;

				if (state.playMode === 'compare') {
					const streamEl = document.querySelector(`[data-stream="${key}"]`);
					if (streamEl) { streamEl.innerHTML = renderMd(accumulated) + '<span class="br-spin"></span>'; scrollColToBottom(key); }
				} else if (key === state.focusKey) {
					const streamEl = document.querySelector(`[data-stream-chat="${key}"] .br-msg-body`);
					if (streamEl) { streamEl.innerHTML = renderMd(accumulated) + '<span class="br-spin"></span>'; scrollChatToBottom(); }
				}
			},
			onDone({ elapsedMs, usage }) {
				turn.responses[key] = turn.responses[key] || {};
				turn.responses[key].elapsedMs = elapsedMs;
				turn.responses[key].usage = usage;

				if (state.playMode === 'compare') {
					const streamEl = document.querySelector(`[data-stream="${key}"]`);
					if (streamEl) { streamEl.removeAttribute('data-stream'); streamEl.innerHTML = renderMd(turn.responses[key].text || ''); }
					const statsEl = document.querySelector(`[data-stats="${key}"]`);
					if (statsEl && elapsedMs) {
						const tps = usage?.outputTokens ? (usage.outputTokens / (elapsedMs / 1000)).toFixed(1) : null;
						statsEl.innerHTML = `<strong>${elapsedMs}</strong>ms${usage?.outputTokens ? ` · <strong>${usage.outputTokens}</strong>t${tps ? ` · <strong>${tps}</strong> t/s` : ''}` : ''}`;
					}
				} else if (key === state.focusKey) {
					const streamEl = document.querySelector(`[data-stream-chat="${key}"]`);
					if (streamEl) {
						streamEl.removeAttribute('data-stream-chat');
						const body = streamEl.querySelector('.br-msg-body');
						if (body) body.innerHTML = renderMd(turn.responses[key].text || '');
					}
				}
				persistSessions();
			},
			onError(msg) {
				turn.responses[key] = { text: '', error: msg, elapsedMs: 0 };
				if (state.playMode === 'compare') {
					const streamEl = document.querySelector(`[data-stream="${key}"]`);
					if (streamEl) { streamEl.removeAttribute('data-stream'); streamEl.innerHTML = `<span style="color:#ff8a8a">${escHtml(msg)}</span>`; }
				} else if (key === state.focusKey) {
					const streamEl = document.querySelector(`[data-stream-chat="${key}"]`);
					if (streamEl) {
						streamEl.removeAttribute('data-stream-chat');
						const body = streamEl.querySelector('.br-msg-body');
						if (body) { body.style.color = '#ff8a8a'; body.textContent = msg; }
					}
				}
				persistSessions();
			},
		});
	}));

	state.streaming = false;
	updateSendAvailability();
}

// ── Export ────────────────────────────────────────────────────────────────────
function exportSession() {
	const session = currentSession();
	if (!session?.turns.length) { showNotice('Nothing to export yet.'); return; }

	const lines = [`# ${session.name}\n`];
	const provKeys = state.playMode === 'compare' ? [...state.active] : [state.focusKey];

	for (const turn of session.turns) {
		lines.push(`**You:** ${turn.user}\n`);
		for (const key of provKeys) {
			const p = PMAP.get(key);
			const r = turn.responses[key];
			if (!r) continue;
			lines.push(`**${p?.label || key}:**\n${r.text || r.error || ''}\n`);
		}
		lines.push('---\n');
	}

	if (state.persona) {
		lines.push('\n## Persona\n```json\n' + JSON.stringify(state.persona, null, 2) + '\n```\n');
	}

	const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `brain-${Date.now()}.md`;
	a.click();
	URL.revokeObjectURL(url);
}

// ── Copy provider ────────────────────────────────────────────────────────────
function copyProvider(key) {
	const session = currentSession();
	if (!session) return;
	const p = PMAP.get(key);
	const lines = [`# ${p?.label || key}\n`];
	for (const turn of session.turns) {
		lines.push(`**You:** ${turn.user}\n`);
		const r = turn.responses[key];
		if (r?.text) lines.push(r.text + '\n');
	}
	navigator.clipboard.writeText(lines.join('\n')).then(() => toast('Copied'));
}

// ── Session management ───────────────────────────────────────────────────────
function loadSession(id) {
	state.currentId = id;
	const s = state.sessions.find(x => x.id === id);
	if (s?.system) $('brSystem').value = s.system;
	renderSidebar();
	renderCanvas();
}

function deleteSession(id) {
	state.sessions = state.sessions.filter(s => s.id !== id);
	if (state.currentId === id) state.currentId = state.sessions[0]?.id || null;
	persistSessions();
	renderSidebar();
	renderCanvas();
}

function setPlayMode(m) {
	state.playMode = m;
	document.querySelectorAll('.br-mode-btn').forEach(b => {
		const on = b.dataset.mode === m;
		b.classList.toggle('active', on);
		b.setAttribute('aria-pressed', String(on));
	});
	renderPlayControls();
	renderCanvas();
}

// Below 900px the sessions rail is off-canvas, so the topbar carries the only
// route to it. Without this the New-session button and the whole session list
// were unreachable on a phone.
function setSideOpen(open) {
	$('brSide').classList.toggle('open', open);
	document.body.classList.toggle('br-side-open', open);
	const toggle = $('brSideToggle');
	toggle.setAttribute('aria-expanded', String(open));
	toggle.setAttribute('aria-label', open ? 'Hide sessions' : 'Show sessions');
}

// ── Bind playground control events ───────────────────────────────────────────
function bindPlayControlEvents() {
	if (state.playMode === 'compare') {
		document.querySelectorAll('.br-pill').forEach(pill => {
			pill.addEventListener('click', () => {
				const key = pill.dataset.key;
				const spec = PMAP.get(key);
				if (isLocked(spec)) {
					showNotice(`${spec.label} needs an account. Sign in to add it.`);
					return;
				}
				if (state.active.has(key)) {
					if (state.active.size === 1) { showNotice('Keep at least one model selected.'); return; }
					state.active.delete(key);
				} else {
					state.active.add(key);
				}
				const on = state.active.has(key);
				pill.classList.toggle('on', on);
				pill.setAttribute('aria-pressed', String(on));
				persistSelection();
				renderCanvas();
			});
		});
	} else {
		const sel = document.getElementById('brFocusSel');
		if (sel) sel.addEventListener('change', () => { state.focusKey = sel.value; persistSelection(); renderCanvas(); });
	}
}


// ── Bind all events ──────────────────────────────────────────────────────────
function bindEvents() {
	// Tab switching
	document.querySelectorAll('.br-tab').forEach(t => {
		t.addEventListener('click', () => setTab(t.dataset.tab));
	});

	// Sessions drawer (mobile)
	$('brSideToggle').addEventListener('click', () => {
		setSideOpen(!$('brSide').classList.contains('open'));
	});
	$('brSideBackdrop').addEventListener('click', () => setSideOpen(false));
	document.addEventListener('keydown', e => {
		if (e.key === 'Escape' && $('brSide').classList.contains('open')) setSideOpen(false);
	});

	// Describe input — Enter submits (Shift+Enter = newline)
	$('brDescribeInput').addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); synthesizeFromDescription(); }
	});

	// Persona card (advanced view) actions
	$('brEditPersona').addEventListener('click', openEditMode);
	$('brSaveEdit').addEventListener('click', () => { saveEdit(); autoSavePersonaToAgent(state.persona?._label || 'Custom persona'); });
	$('brCancelEdit').addEventListener('click', closeEditMode);
	$('brToggleRaw').addEventListener('click', () => {
		const raw = $('brRawJson');
		raw.classList.toggle('show');
		$('brToggleRaw').textContent = raw.classList.contains('show') ? 'Hide JSON' : 'JSON';
	});
	$('brCopyJson').addEventListener('click', () => {
		if (state.persona) {
			navigator.clipboard.writeText(JSON.stringify(state.persona, null, 2)).then(() => toast('Copied to clipboard'));
		}
	});

	// Status bar actions
	$('brTestInPlayground').addEventListener('click', () => {
		if (state.persona) $('brSystem').value = buildPersonaSystemPrompt(state.persona);
		setTab('playground');
	});
	$('brToggleAdvanced').addEventListener('click', () => {
		const card = $('brPersonaCard');
		const isOpen = card.classList.contains('show');
		card.classList.toggle('show', !isOpen);
		$('brToggleAdvanced').textContent = isOpen ? 'Customize' : 'Done';
	});
	$('brResetPersona').addEventListener('click', clearPersona);

	// Agent switcher — persist selection and re-save persona if one is active
	$('brAgentSelect').addEventListener('change', () => {
		save('brain_active_agent', $('brAgentSelect').value);
		if (state.persona) autoSavePersonaToAgent(state.persona._label || 'Custom persona');
	});

	// Sidebar: build persona shortcut
	$('brBuildPersonaBtn').addEventListener('click', () => setTab('persona'));
	$('brMiniClear').addEventListener('click', clearPersona);

	// Playground mode toggle
	document.querySelectorAll('.br-mode-btn').forEach(b => {
		b.addEventListener('click', () => setPlayMode(b.dataset.mode));
	});

	// Send
	$('brSend').addEventListener('click', sendMessage);
	$('brPrompt').addEventListener('keydown', e => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); }
	});

	// New chat
	$('brNewChat').addEventListener('click', () => {
		const s = newSession($('brSystem').value.trim());
		state.sessions.unshift(s);
		state.currentId = s.id;
		persistSessions();
		renderSidebar();
		renderCanvas();
		setSideOpen(false);
	});

	// Export
	$('brExport').addEventListener('click', exportSession);

	// Session list (delegated)
	$('brSessions').addEventListener('click', e => {
		const del = e.target.closest('[data-del]');
		if (del) { deleteSession(del.dataset.del); return; }
		const item = e.target.closest('[data-id]');
		if (item) { loadSession(item.dataset.id); setSideOpen(false); }
	});

	// Canvas clicks (delegated)
	$('brCanvas').addEventListener('click', e => {
		const copy = e.target.closest('[data-copy]');
		if (copy) copyProvider(copy.dataset.copy);
	});

	// Roster retry: the button is rendered into both the play bar and the
	// canvas error state, so one delegated handler covers whichever the user
	// reaches first.
	document.addEventListener('click', e => {
		if (e.target.closest('[data-retry-providers]')) fetchProviderRoster();
	});

	// Persona banner
	$('brBannerDismiss').addEventListener('click', () => {
		state.personaEnabled = false;
		updatePersonaBanner();
	});
}

// ── Boot ─────────────────────────────────────────────────────────────────────
loadSessions();
loadPersona();

renderArchetypes();
renderSidebar();
bindEvents();
fetchProviderRoster();

if (state.persona) {
	renderPersonaCard(state.persona);
	updateStatusBar(state.persona._label || 'Custom persona');
	// Reflect a persisted archetype pick in the grid, so a returning visitor
	// sees which vibe is live instead of an unselected row.
	const picked = ARCHETYPES.findIndex(a => a.label === state.persona._label);
	if (picked >= 0) {
		document.querySelectorAll('.br-archetype-chip').forEach((chip, i) => {
			chip.classList.toggle('selected', i === picked);
			chip.setAttribute('aria-pressed', String(i === picked));
		});
	}
}
updatePersonaMini();
updatePersonaBanner();

const activeSess = currentSession();
if (activeSess?.system) $('brSystem').value = activeSess.system;

loadAgents();
