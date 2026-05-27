// dashboard-next — Brain page.
//
// AI command center: model selection grid, persona builder (interview /
// freeform / manual extraction), and multi-model streaming playground
// (compare side-by-side or single-model chat). All data from real
// /api/brain/chat and /api/persona/extract endpoints.

import { mountShell } from '../shell.js';
import { requireUser, get, put, esc, ApiError } from '../api.js';

// ── Provider registry ────────────────────────────────────────────────────

const PROVIDERS = [
	{ key: 'claude-opus-4-7',   label: 'Claude Opus 4.7',    short: 'Opus 4.7',    network: 'Anthropic',  color: '#c8a96e', ctx: '200K', tier: 'Flagship' },
	{ key: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',  short: 'Sonnet 4.6',  network: 'Anthropic',  color: '#d4b87a', ctx: '200K', tier: 'Balanced' },
	{ key: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',   short: 'Haiku 4.5',   network: 'Anthropic',  color: '#e0c88a', ctx: '200K', tier: 'Fast' },
	{ key: 'gpt-4o',            label: 'GPT-4o',             short: 'GPT-4o',      network: 'OpenAI',     color: '#74c0fc', ctx: '128K', tier: 'Flagship' },
	{ key: 'gpt-4o-mini',       label: 'GPT-4o-mini',        short: 'GPT-4o-mini', network: 'OpenAI',     color: '#90ccfc', ctx: '128K', tier: 'Fast' },
	{ key: 'o3-mini',           label: 'o3-mini',            short: 'o3-mini',     network: 'OpenAI',     color: '#5cb0f4', ctx: '128K', tier: 'Reasoning' },
	{ key: 'groq-llama',        label: 'Llama 3.3 70B',      short: 'Llama 3.3',   network: 'Groq',       color: '#ff9a3c', ctx: '128K', tier: 'Fast' },
	{ key: 'qwen-plus',         label: 'Qwen Plus',           short: 'Qwen+',       network: 'DashScope',  color: '#69db7c', ctx: '131K', tier: 'Balanced' },
	{ key: 'modelscope-qwen',   label: 'Qwen3-Coder 480B',   short: 'Qwen3-Code',  network: 'ModelScope', color: '#40c057', ctx: '32K',  tier: 'Flagship' },
	{ key: 'deepseek-r1',       label: 'DeepSeek R1',         short: 'DeepSeek',    network: 'DeepSeek',   color: '#b197fc', ctx: '64K',  tier: 'Reasoning' },
];
const PMAP = new Map(PROVIDERS.map(p => [p.key, p]));

const TIER_ICON = { Flagship: '★', Balanced: '◆', Fast: '⚡', Reasoning: '⚙' };

// ── Interview ────────────────────────────────────────────────────────────

const QUESTIONS = [
	{ q: 'How would you describe your personality in a few words?', placeholder: 'e.g. Curious, blunt, late.' },
	{ q: 'What do you spend most of your time doing?', placeholder: 'Work, hobbies, obsessions...' },
	{ q: "What topic could you talk about for an hour straight?", placeholder: 'The thing you geek out about...' },
	{ q: "What's a phrase or saying your friends know you for?", placeholder: 'Your catchphrase or motto...' },
	{ q: 'How would you describe your sense of humor?', placeholder: 'Dry, sarcastic, wholesome, chaotic...' },
	{ q: "What kind of language or phrases would you never use?", placeholder: 'Corporate jargon, slang, etc...' },
];
const EXAMPLES = [
	'Curious, blunt, late.',
	'Building small tools for crypto traders — Solana RPC, indexers, dashboards. Some skateboarding when the rain stops.',
	'Why most token launches fail in the first 90 minutes. The mechanics, the wallet patterns, the bot dynamics.',
	'"ship it ugly, fix it Friday"',
	'Dry. Self-deprecating. I laugh at my own bugs before anyone else can.',
	'"Per my last email." or anything that sounds like a LinkedIn post.',
];

// ── State ────────────────────────────────────────────────────────────────

const S = {
	tab: 'models',
	method: 'interview',
	persona: null,
	personaEnabled: true,
	playMode: 'compare',
	focusKey: 'claude-sonnet-4-6',
	active: new Set(['claude-sonnet-4-6', 'gpt-4o-mini', 'groq-llama', 'deepseek-r1']),
	sessions: [],
	currentId: null,
	streaming: false,
	agents: [],
	avail: null,
};

// ── DOM helpers ──────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function uuid() {
	return crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function load(k) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch { return null; } }

let _toastTimer;
function toast(msg) {
	const el = $('brnToast');
	if (!el) return;
	el.textContent = msg;
	el.classList.add('show');
	clearTimeout(_toastTimer);
	_toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Markdown ─────────────────────────────────────────────────────────────

function inlineMd(s) {
	s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
	s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
	s = s.replace(/`([^`\n]+)`/g, '<code class="brn-ic">$1</code>');
	s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
	return s;
}

function renderMd(text) {
	if (!text) return '';
	const lines = text.split('\n');
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.startsWith('```')) {
			const code = [];
			i++;
			while (i < lines.length && !lines[i].startsWith('```')) { code.push(esc(lines[i])); i++; }
			i++;
			out.push(`<pre class="brn-pre"><code>${code.join('\n')}</code></pre>`);
			continue;
		}
		const hm = line.match(/^(#{1,3})\s+(.+)/);
		if (hm) { out.push(`<h${hm[1].length} class="brn-md-h">${inlineMd(esc(hm[2]))}</h${hm[1].length}>`); i++; continue; }
		if (/^[-*+]\s/.test(line)) {
			const items = [];
			while (i < lines.length && /^[-*+]\s/.test(lines[i])) { items.push(`<li>${inlineMd(esc(lines[i].replace(/^[-*+]\s/, '')))}</li>`); i++; }
			out.push(`<ul class="brn-md-ul">${items.join('')}</ul>`);
			continue;
		}
		if (/^\d+\.\s/.test(line)) {
			const items = [];
			while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(`<li>${inlineMd(esc(lines[i].replace(/^\d+\.\s/, '')))}</li>`); i++; }
			out.push(`<ol class="brn-md-ol">${items.join('')}</ol>`);
			continue;
		}
		if (!line.trim()) { i++; continue; }
		const pLines = [];
		while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('```') && !/^[-*+]\s/.test(lines[i]) && !/^\d+\.\s/.test(lines[i])) {
			pLines.push(inlineMd(esc(lines[i])));
			i++;
		}
		if (pLines.length) out.push(`<p class="brn-md-p">${pLines.join('<br>')}</p>`);
	}
	return out.join('');
}

// ── Persistence ──────────────────────────────────────────────────────────

function persistSessions() { save('brain_sessions_v3', S.sessions); }
function persistPersona() { save('brain_persona_v1', S.persona); }

// ── Session helpers ──────────────────────────────────────────────────────

function newSession(system = '') {
	return { id: uuid(), name: 'New conversation', system, created: Date.now(), turns: [] };
}
function currentSession() { return S.sessions.find(s => s.id === S.currentId) || null; }
function autoName(session) {
	const first = session.turns[0]?.user;
	if (!first) return;
	const t = first.trim().replace(/\s+/g, ' ');
	session.name = t.length > 48 ? t.slice(0, 46) + '…' : t;
}

// ── Persona helpers ──────────────────────────────────────────────────────

function buildPersonaSystemPrompt(p) {
	if (!p) return '';
	const parts = ['You are an AI agent with a specific persona. Respond in character.'];
	if (p.tone) parts.push(`Tone: ${p.tone}`);
	if (p.communication_style) parts.push(`Communication style: ${p.communication_style}`);
	if (p.vocabulary?.length) parts.push(`Vocabulary you use: ${p.vocabulary.join(', ')}`);
	if (p.interests?.length) parts.push(`Interests: ${p.interests.join(', ')}`);
	if (p.dont_say?.length) parts.push(`Never say: ${p.dont_say.join(', ')}`);
	if (p.sample_greeting) parts.push(`Example greeting: "${p.sample_greeting}"`);
	return parts.join('\n');
}

function getEffectiveSystemPrompt() {
	const manual = $('brnSystem')?.value.trim();
	if (manual) return manual;
	if (S.persona && S.personaEnabled) return buildPersonaSystemPrompt(S.persona);
	return '';
}

// ── Provider availability ────────────────────────────────────────────────

function isAvailable(key) {
	if (!S.avail) return true;
	const found = S.avail.find(p => p.key === key);
	return found ? found.available : false;
}

// ── Boot ─────────────────────────────────────────────────────────────────

(async function boot() {
	const main = await mountShell();
	await requireUser();

	S.sessions = load('brain_sessions_v3') || [];
	S.persona = load('brain_persona_v1');
	S.currentId = S.sessions[0]?.id || null;

	main.innerHTML = renderPage();
	injectStyles();

	renderModelGrid();
	renderQuestionCards();
	if (S.persona) renderPersonaCardContent(S.persona);
	renderPlayControls();
	renderSessions();
	renderCanvas();
	updateKpis();
	updatePersonaBanner();

	bindEvents();

	await Promise.all([fetchAvailability(), fetchAgents()]);
})().catch((err) => {
	if (err?.message === 'redirecting') return;
	if (err instanceof ApiError && err.status === 401) return;
	const main = document.querySelector('.dn-main-inner') || document.body;
	main.innerHTML = `
		<h1 class="dn-h1">Brain</h1>
		<div class="dn-panel" style="border-color:rgba(150,155,163,0.3)">
			<div class="dn-panel-title" style="color:var(--nxt-danger)">Failed to load</div>
			<div class="dn-panel-sub">${esc(err?.message || 'unknown error')}</div>
			<button class="dn-btn" onclick="location.reload()">Reload</button>
		</div>
	`;
});

// ── Page structure ───────────────────────────────────────────────────────

function renderPage() {
	return `
		<div class="brn-page">
			<h1 class="dn-h1">Brain</h1>
			<p class="dn-h1-sub">Configure your agent's intelligence, build personas, and test across models.</p>

			<div class="brn-kpis" id="brnKpis">
				<div class="brn-kpi">
					<div class="brn-kpi-label">Models Available</div>
					<div class="brn-kpi-value" id="brnKpiModels"><span class="dn-skeleton" style="height:20px;width:48px;display:inline-block"></span></div>
				</div>
				<div class="brn-kpi">
					<div class="brn-kpi-label">Active Persona</div>
					<div class="brn-kpi-value brn-kpi-persona" id="brnKpiPersona">None</div>
				</div>
				<div class="brn-kpi">
					<div class="brn-kpi-label">Sessions</div>
					<div class="brn-kpi-value" id="brnKpiSessions">0</div>
				</div>
				<div class="brn-kpi">
					<div class="brn-kpi-label">Messages</div>
					<div class="brn-kpi-value" id="brnKpiMessages">0</div>
				</div>
			</div>

			<nav class="brn-tabs" role="tablist" aria-label="Brain sections">
				<button class="brn-tab is-active" data-tab="models" role="tab" aria-selected="true" aria-controls="brnModels">Models</button>
				<button class="brn-tab" data-tab="persona" role="tab" aria-selected="false" aria-controls="brnPersona">Persona</button>
				<button class="brn-tab" data-tab="playground" role="tab" aria-selected="false" aria-controls="brnPlayground">Playground</button>
			</nav>

			<section class="brn-panel is-active" id="brnModels" role="tabpanel">
				<div class="brn-model-grid" id="brnModelGrid"></div>
			</section>

			<section class="brn-panel" id="brnPersona" role="tabpanel">
				<div class="brn-persona-wrap">
					<div class="brn-persona-hero">
						<h2 class="brn-section-title">Build Your Persona</h2>
						<p class="brn-section-sub">Define how your AI agent thinks, speaks, and behaves. Extract a structured persona and test it across models.</p>
					</div>
					<div class="brn-methods" role="tablist" aria-label="Persona methods">
						<button class="brn-method is-active" data-method="interview" role="tab">
							<span class="brn-method-icon">✎</span>
							<div><div class="brn-method-title">Guided Interview</div><div class="brn-method-desc">Answer targeted questions</div></div>
						</button>
						<button class="brn-method" data-method="freeform" role="tab">
							<span class="brn-method-icon">✂</span>
							<div><div class="brn-method-title">Freeform</div><div class="brn-method-desc">Paste writing samples</div></div>
						</button>
						<button class="brn-method" data-method="manual" role="tab">
							<span class="brn-method-icon">⚙</span>
							<div><div class="brn-method-title">Manual</div><div class="brn-method-desc">Set fields directly</div></div>
						</button>
					</div>

					<div class="brn-method-body is-active" id="brnInterview" role="tabpanel">
						<div id="brnQuestions"></div>
						<div class="brn-actions">
							<button class="brn-btn brn-btn-primary" id="brnSynthesize" disabled>Synthesize Persona</button>
							<button class="brn-btn brn-btn-ghost" id="brnFillExample">Fill example</button>
						</div>
					</div>

					<div class="brn-method-body" id="brnFreeform" role="tabpanel">
						<textarea class="brn-textarea" id="brnFreeformText" placeholder="Paste a bio, collection of tweets, LinkedIn summary, Reddit comments, or describe the personality you want...\n\nThe more context you provide, the richer the extraction." rows="8"></textarea>
						<div class="brn-form-hint">Paste real writing samples for the most authentic extraction.</div>
						<div class="brn-actions">
							<button class="brn-btn brn-btn-primary" id="brnFreeformSynth" disabled>Synthesize Persona</button>
						</div>
					</div>

					<div class="brn-method-body" id="brnManual" role="tabpanel">
						<div class="brn-form-grid">
							<div class="brn-field"><label for="brnManTone">Tone</label><input id="brnManTone" placeholder="Warm but direct, slightly sardonic" /></div>
							<div class="brn-field"><label for="brnManStyle">Communication Style</label>
								<select id="brnManStyle"><option value="terse">Terse</option><option value="detailed">Detailed</option><option value="playful">Playful</option><option value="analytical">Analytical</option><option value="warm" selected>Warm</option></select>
							</div>
							<div class="brn-field"><label for="brnManVocab">Vocabulary</label><input id="brnManVocab" placeholder="Comma-separated words or phrases" /><span class="brn-field-hint">Words and phrases this persona uses often</span></div>
							<div class="brn-field"><label for="brnManInterests">Interests</label><input id="brnManInterests" placeholder="Comma-separated interests" /></div>
							<div class="brn-field"><label for="brnManDont">Avoid</label><input id="brnManDont" placeholder="Phrases to avoid, comma-separated" /></div>
							<div class="brn-field brn-field-full"><label for="brnManGreet">Sample Greeting</label><textarea id="brnManGreet" placeholder="A greeting in the persona's voice" rows="2"></textarea></div>
						</div>
						<div class="brn-actions">
							<button class="brn-btn brn-btn-primary" id="brnManualSave">Set Persona</button>
						</div>
					</div>

					<div class="brn-loading" id="brnLoading"><div class="brn-spinner"></div><span>Synthesizing persona…</span></div>

					<div class="brn-persona-card" id="brnPersonaCard">
						<div class="brn-pc-header">
							<h3>Extracted Persona</h3>
							<div class="brn-pc-acts">
								<button class="brn-btn brn-btn-ghost brn-btn-sm" id="brnEditPersona">Edit</button>
								<button class="brn-btn brn-btn-ghost brn-btn-sm" id="brnToggleRaw">JSON</button>
								<button class="brn-btn brn-btn-ghost brn-btn-sm" id="brnCopyJson">Copy</button>
							</div>
						</div>
						<div class="brn-pc-body" id="brnPcBody">
							<div class="brn-pc-row"><div class="brn-pc-label">Tone</div><div class="brn-pc-val" id="brnPcTone"></div></div>
							<div class="brn-pc-row"><div class="brn-pc-label">Style</div><div class="brn-pc-val" id="brnPcStyle"></div></div>
							<div class="brn-pc-row"><div class="brn-pc-label">Vocabulary</div><div class="brn-chips" id="brnPcVocab"></div></div>
							<div class="brn-pc-row"><div class="brn-pc-label">Interests</div><div class="brn-chips" id="brnPcInterests"></div></div>
							<div class="brn-pc-row"><div class="brn-pc-label">Avoid</div><div class="brn-chips" id="brnPcDont"></div></div>
							<div class="brn-pc-row brn-pc-row-full"><div class="brn-pc-label">Sample Greeting</div><div class="brn-pc-greeting" id="brnPcGreet"></div></div>
						</div>
						<div class="brn-pc-edit" id="brnPcEdit" style="display:none">
							<div class="brn-form-grid">
								<div class="brn-field"><label>Tone</label><input id="brnEditTone" /></div>
								<div class="brn-field"><label>Style</label>
									<select id="brnEditStyle"><option value="terse">Terse</option><option value="detailed">Detailed</option><option value="playful">Playful</option><option value="analytical">Analytical</option><option value="warm">Warm</option></select>
								</div>
								<div class="brn-field"><label>Vocabulary</label><input id="brnEditVocab" placeholder="Comma-separated" /></div>
								<div class="brn-field"><label>Interests</label><input id="brnEditInterests" placeholder="Comma-separated" /></div>
								<div class="brn-field"><label>Avoid</label><input id="brnEditDont" placeholder="Comma-separated" /></div>
								<div class="brn-field brn-field-full"><label>Greeting</label><textarea id="brnEditGreet" rows="2"></textarea></div>
							</div>
							<div class="brn-actions" style="justify-content:flex-start">
								<button class="brn-btn brn-btn-primary brn-btn-sm" id="brnSaveEdit">Save Changes</button>
								<button class="brn-btn brn-btn-ghost brn-btn-sm" id="brnCancelEdit">Cancel</button>
							</div>
						</div>
						<pre class="brn-raw" id="brnRawJson"></pre>
						<div class="brn-pc-footer">
							<button class="brn-btn brn-btn-primary brn-btn-sm" id="brnTestPlay">Test in Playground</button>
							<button class="brn-btn brn-btn-ghost brn-btn-sm" id="brnResetPersona">Start Over</button>
							<div class="brn-pc-save-wrap">
								<select class="brn-select" id="brnAgentSelect"><option value="">Select agent…</option></select>
								<button class="brn-btn brn-btn-primary brn-btn-sm" id="brnSaveToAgent" disabled>Save to Agent</button>
							</div>
						</div>
					</div>
				</div>
			</section>

			<section class="brn-panel" id="brnPlayground" role="tabpanel">
				<div class="brn-play-layout">
					<aside class="brn-play-side">
						<div class="brn-play-side-head">
							<span class="brn-play-side-label">Sessions</span>
							<button class="brn-play-side-new" id="brnNewChat" title="New session" aria-label="New session">+</button>
						</div>
						<div class="brn-play-sessions" id="brnPlaySessions"></div>
					</aside>
					<div class="brn-play-main">
						<div class="brn-play-toolbar">
							<div class="brn-mode-toggle">
								<button class="brn-mode is-active" data-mode="compare">Compare</button>
								<button class="brn-mode" data-mode="chat">Chat</button>
							</div>
							<div class="brn-play-controls" id="brnPlayControls"></div>
							<div class="brn-play-toolbar-end">
								<button class="brn-btn brn-btn-ghost brn-btn-sm" id="brnExport">Export</button>
							</div>
						</div>
						<div class="brn-persona-banner" id="brnBanner"></div>
						<div class="brn-canvas" id="brnCanvas"></div>
						<div class="brn-input-wrap">
							<details class="brn-sys-details">
								<summary>System prompt</summary>
								<textarea class="brn-sys-area" id="brnSystem" placeholder="Custom system instructions…" rows="3"></textarea>
							</details>
							<div class="brn-input-row">
								<textarea class="brn-prompt" id="brnPrompt" placeholder="Send a message…" rows="1" aria-label="Message input"></textarea>
								<button class="brn-send" id="brnSend" aria-label="Send message">Send</button>
							</div>
							<div class="brn-input-hint">Ctrl+Enter to send</div>
						</div>
					</div>
				</div>
			</section>

			<div class="brn-toast" id="brnToast" role="status" aria-live="polite"></div>
		</div>
	`;
}

// ── KPIs ─────────────────────────────────────────────────────────────────

function updateKpis() {
	const avail = S.avail ? S.avail.filter(p => p.available).length : PROVIDERS.length;
	const el = $('brnKpiModels');
	if (el) el.innerHTML = `<span>${avail}</span><span class="brn-kpi-dim"> / ${PROVIDERS.length}</span>`;
	const pEl = $('brnKpiPersona');
	if (pEl) {
		pEl.textContent = S.persona?.tone || 'None';
		pEl.classList.toggle('is-active', !!S.persona);
	}
	const sEl = $('brnKpiSessions');
	if (sEl) sEl.textContent = S.sessions.length;
	const mEl = $('brnKpiMessages');
	if (mEl) mEl.textContent = S.sessions.reduce((n, s) => n + s.turns.length, 0);
}

// ── Tab switching ────────────────────────────────────────────────────────

function setTab(tab) {
	S.tab = tab;
	document.querySelectorAll('.brn-tab').forEach(t => {
		const active = t.dataset.tab === tab;
		t.classList.toggle('is-active', active);
		t.setAttribute('aria-selected', String(active));
	});
	const map = { models: 'brnModels', persona: 'brnPersona', playground: 'brnPlayground' };
	document.querySelectorAll('.brn-panel').forEach(p => {
		p.classList.toggle('is-active', p.id === map[tab]);
	});
	if (tab === 'playground') {
		renderCanvas();
		const prompt = $('brnPrompt');
		if (prompt) setTimeout(() => prompt.focus(), 120);
	}
}

// ── Model grid ───────────────────────────────────────────────────────────

function renderModelGrid() {
	const grid = $('brnModelGrid');
	if (!grid) return;
	grid.innerHTML = PROVIDERS.map(p => {
		const avail = isAvailable(p.key);
		const selected = S.active.has(p.key);
		return `
			<div class="brn-mc${selected ? ' is-selected' : ''}${!avail ? ' is-unavail' : ''}" data-key="${esc(p.key)}" style="--mc:${p.color}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="${esc(p.label)}">
				<div class="brn-mc-bar"></div>
				<div class="brn-mc-head">
					<span class="brn-mc-dot${avail ? ' is-on' : ''}"></span>
					<span class="brn-mc-avail">${avail ? 'Available' : 'Unavailable'}</span>
				</div>
				<div class="brn-mc-name">${esc(p.label)}</div>
				<div class="brn-mc-network">${esc(p.network)}</div>
				<div class="brn-mc-specs">
					<span class="brn-mc-ctx">${esc(p.ctx)} ctx</span>
					<span class="brn-mc-tier">${TIER_ICON[p.tier] || ''} ${esc(p.tier)}</span>
				</div>
				<button class="brn-mc-action${selected ? ' is-on' : ''}" data-toggle="${esc(p.key)}" aria-label="Toggle ${esc(p.short)} for playground"${!avail ? ' disabled' : ''}>
					<span class="brn-mc-check">${selected ? '✓' : ''}</span>
					Playground
				</button>
			</div>
		`;
	}).join('');
}

// ── Persona questions ────────────────────────────────────────────────────

function renderQuestionCards() {
	const el = $('brnQuestions');
	if (!el) return;
	el.innerHTML = QUESTIONS.map((q, i) => `
		<div class="brn-q-card">
			<span class="brn-q-num">${i + 1}</span>
			<div class="brn-q-text">${esc(q.q)}</div>
			<textarea class="brn-q-input" id="brnQ${i}" placeholder="${esc(q.placeholder)}" rows="2"></textarea>
		</div>
	`).join('');
	el.querySelectorAll('.brn-q-input').forEach(input => input.addEventListener('input', updateSynthBtn));
}

function collectAnswers() {
	return QUESTIONS.map((q, i) => ({ question: q.q, answer: ($(`brnQ${i}`)?.value || '').trim() }));
}

function updateSynthBtn() {
	const btn = $('brnSynthesize');
	if (btn) btn.disabled = !collectAnswers().every(a => a.answer.length > 0);
}

// ── Persona methods ──────────────────────────────────────────────────────

function setMethod(m) {
	S.method = m;
	document.querySelectorAll('.brn-method').forEach(t => t.classList.toggle('is-active', t.dataset.method === m));
	$('brnInterview')?.classList.toggle('is-active', m === 'interview');
	$('brnFreeform')?.classList.toggle('is-active', m === 'freeform');
	$('brnManual')?.classList.toggle('is-active', m === 'manual');
}

// ── Persona synthesis ────────────────────────────────────────────────────

async function synthesizeFromInterview() {
	const answers = collectAnswers();
	if (!answers.every(a => a.answer.length > 0)) return;
	await runExtraction({ answers });
}

async function synthesizeFromFreeform() {
	const text = $('brnFreeformText')?.value.trim();
	if (!text) return;
	await runExtraction({ freeform: text });
}

async function runExtraction(payload) {
	$('brnLoading')?.classList.add('show');
	$('brnPersonaCard')?.classList.remove('show');
	try {
		const res = await fetch('/api/persona/extract', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
		S.persona = data.persona;
		persistPersona();
		renderPersonaCardContent(S.persona);
		updateKpis();
		toast(`Persona extracted (${data.tokens_used ?? '?'} tokens, ${data.latency_ms ?? '?'}ms)`);
	} catch (err) {
		toast(`Extraction failed: ${err.message}`);
	} finally {
		$('brnLoading')?.classList.remove('show');
	}
}

function setPersonaFromManual() {
	const split = v => v.split(',').map(s => s.trim()).filter(Boolean);
	S.persona = {
		tone: $('brnManTone')?.value.trim() || 'Neutral',
		communication_style: $('brnManStyle')?.value,
		vocabulary: split($('brnManVocab')?.value || ''),
		interests: split($('brnManInterests')?.value || ''),
		dont_say: split($('brnManDont')?.value || ''),
		sample_greeting: $('brnManGreet')?.value.trim(),
	};
	persistPersona();
	renderPersonaCardContent(S.persona);
	updateKpis();
	toast('Persona set');
}

// ── Persona card rendering ───────────────────────────────────────────────

function renderPersonaCardContent(p) {
	const card = $('brnPersonaCard');
	if (!card) return;
	card.classList.add('show');
	const tone = $('brnPcTone');
	if (tone) tone.textContent = p.tone || '—';
	const style = $('brnPcStyle');
	if (style) style.innerHTML = `<span class="brn-badge">${esc(p.communication_style || '—')}</span>`;
	renderChips($('brnPcVocab'), p.vocabulary, 'brn-chip brn-chip-blue');
	renderChips($('brnPcInterests'), p.interests, 'brn-chip brn-chip-purple');
	renderChips($('brnPcDont'), p.dont_say, 'brn-chip brn-chip-red');
	const greet = $('brnPcGreet');
	if (greet) greet.textContent = p.sample_greeting ? `"${p.sample_greeting}"` : '—';
	const raw = $('brnRawJson');
	if (raw) raw.textContent = JSON.stringify(p, null, 2);
	updatePersonaBanner();
}

function renderChips(container, list, cls) {
	if (!container) return;
	container.innerHTML = '';
	if (!list?.length) { container.innerHTML = '<span class="brn-chip-empty">—</span>'; return; }
	for (const item of list) {
		const span = document.createElement('span');
		span.className = cls;
		span.textContent = item;
		container.appendChild(span);
	}
}

function updatePersonaBanner() {
	const banner = $('brnBanner');
	if (!banner) return;
	if (S.persona && S.personaEnabled) {
		banner.classList.add('show');
		banner.innerHTML = `
			<span class="brn-banner-dot"></span>
			Persona active: <strong>${esc(S.persona.tone || 'Custom')}</strong>
			<button class="brn-banner-dismiss" id="brnBannerDismiss">Disable for session</button>
		`;
		$('brnBannerDismiss')?.addEventListener('click', () => { S.personaEnabled = false; updatePersonaBanner(); });
	} else {
		banner.classList.remove('show');
		banner.innerHTML = '';
	}
}

// ── Persona edit mode ────────────────────────────────────────────────────

function openEditMode() {
	if (!S.persona) return;
	const p = S.persona;
	const set = (id, v) => { const el = $(id); if (el) el.value = v; };
	set('brnEditTone', p.tone || '');
	set('brnEditStyle', p.communication_style || 'warm');
	set('brnEditVocab', (p.vocabulary || []).join(', '));
	set('brnEditInterests', (p.interests || []).join(', '));
	set('brnEditDont', (p.dont_say || []).join(', '));
	set('brnEditGreet', p.sample_greeting || '');
	const body = $('brnPcBody'); if (body) body.style.display = 'none';
	const edit = $('brnPcEdit'); if (edit) edit.style.display = 'flex';
	const btn = $('brnEditPersona'); if (btn) btn.style.display = 'none';
}

function saveEdit() {
	const split = v => v.split(',').map(s => s.trim()).filter(Boolean);
	const val = id => $(id)?.value || '';
	S.persona = {
		tone: val('brnEditTone').trim() || 'Neutral',
		communication_style: val('brnEditStyle'),
		vocabulary: split(val('brnEditVocab')),
		interests: split(val('brnEditInterests')),
		dont_say: split(val('brnEditDont')),
		sample_greeting: val('brnEditGreet').trim(),
	};
	persistPersona();
	closeEditMode();
	renderPersonaCardContent(S.persona);
	updateKpis();
	toast('Persona updated');
}

function closeEditMode() {
	const body = $('brnPcBody'); if (body) body.style.display = '';
	const edit = $('brnPcEdit'); if (edit) edit.style.display = 'none';
	const btn = $('brnEditPersona'); if (btn) btn.style.display = '';
}

// ── Save persona to agent ────────────────────────────────────────────────

async function fetchAgents() {
	try {
		const data = await get('/api/agents');
		S.agents = data?.agents || data || [];
		renderAgentSelect();
	} catch {}
}

function renderAgentSelect() {
	const sel = $('brnAgentSelect');
	if (!sel) return;
	sel.innerHTML = '<option value="">Select agent…</option>';
	for (const a of S.agents) {
		const opt = document.createElement('option');
		opt.value = a.id;
		opt.textContent = a.name || `Agent ${a.id.slice(0, 8)}`;
		sel.appendChild(opt);
	}
}

async function saveToAgent() {
	const agentId = $('brnAgentSelect')?.value;
	if (!agentId || !S.persona) return;
	const btn = $('brnSaveToAgent');
	if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
	try {
		const persona = {
			system_prompt: buildPersonaSystemPrompt(S.persona),
			tone: S.persona.tone,
			traits: [...(S.persona.vocabulary || []), ...(S.persona.interests || [])],
		};
		await put(`/api/agents/${encodeURIComponent(agentId)}`, { persona });
		const name = S.agents.find(a => a.id === agentId)?.name || 'agent';
		toast(`Persona saved to ${name}`);
	} catch (err) {
		toast(`Save failed: ${err.message}`);
	} finally {
		if (btn) { btn.disabled = false; btn.textContent = 'Save to Agent'; }
	}
}

// ── Provider availability ────────────────────────────────────────────────

async function fetchAvailability() {
	try {
		const r = await fetch('/api/brain/chat', { method: 'GET', credentials: 'include' });
		if (!r.ok) return;
		const json = await r.json();
		if (Array.isArray(json.providers)) {
			S.avail = json.providers;
			for (const key of [...S.active]) {
				const found = json.providers.find(p => p.key === key);
				if (found && !found.available) S.active.delete(key);
			}
			if (S.active.size === 0) {
				const first = json.providers.find(p => p.available);
				if (first) S.active.add(first.key);
			}
			renderModelGrid();
			renderPlayControls();
			updateKpis();
		}
	} catch {}
}

// ── Playground controls ──────────────────────────────────────────────────

function renderPlayControls() {
	const ctrl = $('brnPlayControls');
	if (!ctrl) return;
	if (S.playMode === 'compare') {
		ctrl.innerHTML = `<div class="brn-pills">${
			PROVIDERS.map(p => {
				const avail = isAvailable(p.key);
				const on = S.active.has(p.key);
				return `<label class="brn-pill${on ? ' is-on' : ''}${!avail ? ' is-na' : ''}" style="--pc:${p.color}" data-pill="${esc(p.key)}"${!avail ? ` title="${esc(p.label)} — not configured"` : ''}>
					<span class="brn-pill-dot"></span><span>${esc(p.short)}</span>${!avail ? '<span class="brn-pill-x">✕</span>' : ''}
				</label>`;
			}).join('')
		}</div>`;
	} else {
		ctrl.innerHTML = `<select class="brn-select brn-focus-sel" id="brnFocusSel">${
			PROVIDERS.map(p => {
				const avail = isAvailable(p.key);
				return `<option value="${esc(p.key)}"${p.key === S.focusKey ? ' selected' : ''}${!avail ? ' disabled' : ''}>${esc(p.label)}${avail ? '' : ' (unavailable)'}</option>`;
			}).join('')
		}</select>`;
	}
	bindPlayCtrlEvents();
}

function bindPlayCtrlEvents() {
	if (S.playMode === 'compare') {
		document.querySelectorAll('.brn-pill').forEach(pill => {
			pill.addEventListener('click', () => {
				const key = pill.dataset.pill;
				if (!isAvailable(key)) return;
				if (S.active.has(key)) { if (S.active.size > 1) S.active.delete(key); }
				else S.active.add(key);
				pill.classList.toggle('is-on', S.active.has(key));
				renderCanvas();
			});
		});
	} else {
		const sel = $('brnFocusSel');
		if (sel) sel.addEventListener('change', () => { S.focusKey = sel.value; renderCanvas(); });
	}
}

function setPlayMode(m) {
	S.playMode = m;
	document.querySelectorAll('.brn-mode').forEach(b => b.classList.toggle('is-active', b.dataset.mode === m));
	renderPlayControls();
	renderCanvas();
}

// ── Sessions sidebar ─────────────────────────────────────────────────────

function renderSessions() {
	const el = $('brnPlaySessions');
	if (!el) return;
	if (!S.sessions.length) {
		el.innerHTML = '<div class="brn-play-empty">No sessions yet.<br>Send a message to start.</div>';
		return;
	}
	el.innerHTML = S.sessions.map(s => `
		<div class="brn-sess${s.id === S.currentId ? ' is-active' : ''}" data-sid="${esc(s.id)}" tabindex="0" role="button">
			<span class="brn-sess-name">${esc(s.name)}</span>
			<button class="brn-sess-del" data-del="${esc(s.id)}" title="Delete" aria-label="Delete session">×</button>
		</div>
	`).join('');
}

function loadSessionById(id) {
	S.currentId = id;
	const s = S.sessions.find(x => x.id === id);
	if (s?.system) { const el = $('brnSystem'); if (el) el.value = s.system; }
	renderSessions();
	renderCanvas();
}

function deleteSessionById(id) {
	S.sessions = S.sessions.filter(s => s.id !== id);
	if (S.currentId === id) S.currentId = S.sessions[0]?.id || null;
	persistSessions();
	renderSessions();
	renderCanvas();
	updateKpis();
}

// ── Canvas rendering ─────────────────────────────────────────────────────

function renderCanvas() {
	if (S.playMode === 'compare') renderCompareCanvas();
	else renderChatCanvas();
}

function renderCompareCanvas() {
	const canvas = $('brnCanvas');
	if (!canvas) return;
	const session = currentSession();
	const active = [...S.active];
	if (!active.length) {
		canvas.innerHTML = '<div class="brn-chat-empty"><h3>No models selected</h3><p>Toggle models in the toolbar above or visit the Models tab to configure.</p></div>';
		return;
	}
	canvas.innerHTML = `<div class="brn-compare">${
		active.map(key => {
			const p = PMAP.get(key);
			if (!p) return '';
			return `
				<div class="brn-col" data-col="${esc(key)}" style="--pc:${p.color}">
					<div class="brn-col-head">
						<div>
							<div class="brn-col-name">${esc(p.short)}</div>
							<div class="brn-col-meta">${esc(p.network)} · ${esc(p.ctx)} · ${esc(p.tier)}</div>
						</div>
						<div class="brn-col-head-right">
							<span class="brn-col-stats" data-stats="${esc(key)}"></span>
							<button class="brn-col-copy" data-copy="${esc(key)}">Copy</button>
						</div>
					</div>
					<div class="brn-col-msgs" data-msgs="${esc(key)}">
						${session?.turns.length ? renderColTurns(session, key) : '<div class="brn-col-empty">Waiting for a message…</div>'}
					</div>
				</div>`;
		}).join('')
	}</div>`;
}

function renderColTurns(session, provKey) {
	return session.turns.map(turn => {
		let html = `<div class="brn-col-user">${esc(turn.user)}</div>`;
		const resp = turn.responses[provKey];
		if (resp?.text) html += `<div class="brn-col-asst">${renderMd(resp.text)}</div>`;
		else if (resp?.error) html += `<div class="brn-col-asst brn-col-err">${esc(resp.error)}</div>`;
		return html;
	}).join('');
}

function renderChatCanvas() {
	const canvas = $('brnCanvas');
	if (!canvas) return;
	const session = currentSession();
	const p = PMAP.get(S.focusKey);

	if (!session || !session.turns.length) {
		canvas.innerHTML = `
			<div class="brn-chat-empty">
				<div class="brn-chat-empty-icon">${TIER_ICON.Flagship}</div>
				<h3>Start a conversation</h3>
				<p>Messages sent to <strong style="color:${p?.color || '#fff'}">${esc(p?.label || S.focusKey)}</strong>. Switch to Compare mode to query all models at once.</p>
			</div>`;
		return;
	}

	const msgs = session.turns.map(turn => {
		const resp = turn.responses[S.focusKey];
		let html = `<div class="brn-msg brn-msg-user"><div class="brn-msg-label">You</div><div class="brn-msg-body">${esc(turn.user)}</div></div>`;
		if (resp?.text) {
			html += `<div class="brn-msg brn-msg-asst" style="--pc:${p?.color || '#fff'}"><div class="brn-msg-label">${esc(p?.short || S.focusKey)}</div><div class="brn-msg-body">${renderMd(resp.text)}</div></div>`;
		} else if (resp?.error) {
			html += `<div class="brn-msg brn-msg-asst"><div class="brn-msg-label" style="color:var(--nxt-danger)">Error</div><div class="brn-msg-body" style="color:var(--nxt-danger)">${esc(resp.error)}</div></div>`;
		}
		return html;
	}).join('');

	canvas.innerHTML = `<div class="brn-chat"><div class="brn-chat-msgs" id="brnChatMsgs">${msgs}</div></div>`;
}

// ── Scroll ───────────────────────────────────────────────────────────────

function scrollCol(key) {
	const el = document.querySelector(`[data-msgs="${key}"]`);
	if (el) el.scrollTop = el.scrollHeight;
}
function scrollChat() {
	const el = $('brnChatMsgs');
	if (el) el.scrollTop = el.scrollHeight;
}

// ── Streaming ────────────────────────────────────────────────────────────

async function streamProvider(provKey, messages, system, { onChunk, onDone, onError, signal }) {
	let res;
	try {
		res = await fetch('/api/brain/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
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
					try { const info = JSON.parse(data); onDone?.({ elapsedMs: info.elapsedMs, usage: info.usage }); } catch {}
				} else if (evType === 'error') {
					try { onError?.(JSON.parse(data).message || 'upstream error'); } catch {}
				}
			}
		}
	} finally {
		if (!gotDone) onDone?.({ elapsedMs: Math.round(performance.now() - t0), usage: null });
	}
}

function buildMessages(session, provKey, userMsg) {
	const msgs = [];
	for (const turn of session.turns) {
		msgs.push({ role: 'user', content: turn.user });
		const r = turn.responses[provKey];
		if (r?.text) msgs.push({ role: 'assistant', content: r.text });
	}
	msgs.push({ role: 'user', content: userMsg });
	return msgs;
}

// ── Send message ─────────────────────────────────────────────────────────

async function sendMessage() {
	const promptEl = $('brnPrompt');
	const text = promptEl?.value.trim();
	if (!text || S.streaming) return;

	const activeKeys = S.playMode === 'compare' ? [...S.active] : [S.focusKey];
	if (!activeKeys.length) { toast('Select at least one model.'); return; }

	const system = getEffectiveSystemPrompt();
	promptEl.value = '';

	if (!S.currentId) {
		const s = newSession(system);
		S.sessions.unshift(s);
		S.currentId = s.id;
	}

	const session = currentSession();
	if (!session) return;

	const turn = { id: uuid(), user: text, responses: {} };
	session.turns.push(turn);
	autoName(session);
	persistSessions();
	renderSessions();
	updateKpis();

	S.streaming = true;
	const sendBtn = $('brnSend');
	if (sendBtn) sendBtn.disabled = true;

	renderCanvas();
	if (S.playMode === 'compare') activeKeys.forEach(scrollCol);
	else scrollChat();

	if (S.playMode === 'compare') {
		for (const key of activeKeys) {
			const el = document.querySelector(`[data-msgs="${key}"]`);
			if (el) {
				const spin = document.createElement('div');
				spin.className = 'brn-col-asst';
				spin.dataset.stream = key;
				spin.innerHTML = '<span class="brn-spin"></span>';
				el.appendChild(spin);
				el.scrollTop = el.scrollHeight;
			}
		}
	} else {
		const msgs = $('brnChatMsgs');
		if (msgs) {
			const spin = document.createElement('div');
			spin.className = 'brn-msg brn-msg-asst';
			spin.dataset.streamChat = S.focusKey;
			spin.style.setProperty('--pc', PMAP.get(S.focusKey)?.color || '#fff');
			const p = PMAP.get(S.focusKey);
			spin.innerHTML = `<div class="brn-msg-label">${esc(p?.short || S.focusKey)}</div><div class="brn-msg-body"><span class="brn-spin"></span></div>`;
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
				if (S.playMode === 'compare') {
					const streamEl = document.querySelector(`[data-stream="${key}"]`);
					if (streamEl) { streamEl.innerHTML = renderMd(accumulated) + '<span class="brn-spin"></span>'; scrollCol(key); }
				} else if (key === S.focusKey) {
					const streamEl = document.querySelector(`[data-stream-chat="${key}"] .brn-msg-body`);
					if (streamEl) { streamEl.innerHTML = renderMd(accumulated) + '<span class="brn-spin"></span>'; scrollChat(); }
				}
			},
			onDone({ elapsedMs, usage }) {
				turn.responses[key] = turn.responses[key] || {};
				turn.responses[key].elapsedMs = elapsedMs;
				turn.responses[key].usage = usage;
				if (S.playMode === 'compare') {
					const streamEl = document.querySelector(`[data-stream="${key}"]`);
					if (streamEl) { streamEl.removeAttribute('data-stream'); streamEl.innerHTML = renderMd(turn.responses[key].text || ''); }
					const statsEl = document.querySelector(`[data-stats="${key}"]`);
					if (statsEl && elapsedMs) {
						const tps = usage?.outputTokens ? (usage.outputTokens / (elapsedMs / 1000)).toFixed(1) : null;
						statsEl.innerHTML = `<strong>${elapsedMs}</strong>ms${usage?.outputTokens ? ` · <strong>${usage.outputTokens}</strong>t${tps ? ` · <strong>${tps}</strong> t/s` : ''}` : ''}`;
					}
				} else if (key === S.focusKey) {
					const streamEl = document.querySelector(`[data-stream-chat="${key}"]`);
					if (streamEl) {
						streamEl.removeAttribute('data-stream-chat');
						const body = streamEl.querySelector('.brn-msg-body');
						if (body) body.innerHTML = renderMd(turn.responses[key].text || '');
					}
				}
				persistSessions();
			},
			onError(msg) {
				turn.responses[key] = { text: '', error: msg, elapsedMs: 0 };
				if (S.playMode === 'compare') {
					const streamEl = document.querySelector(`[data-stream="${key}"]`);
					if (streamEl) { streamEl.removeAttribute('data-stream'); streamEl.innerHTML = `<span class="brn-col-err">${esc(msg)}</span>`; }
				} else if (key === S.focusKey) {
					const streamEl = document.querySelector(`[data-stream-chat="${key}"]`);
					if (streamEl) {
						streamEl.removeAttribute('data-stream-chat');
						const body = streamEl.querySelector('.brn-msg-body');
						if (body) { body.style.color = 'var(--nxt-danger)'; body.textContent = msg; }
					}
				}
				persistSessions();
			},
		});
	}));

	S.streaming = false;
	if (sendBtn) sendBtn.disabled = false;
}

// ── Export ────────────────────────────────────────────────────────────────

function exportSession() {
	const session = currentSession();
	if (!session?.turns.length) { toast('Nothing to export yet.'); return; }
	const lines = [`# ${session.name}\n`];
	const provKeys = S.playMode === 'compare' ? [...S.active] : [S.focusKey];
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
	if (S.persona) lines.push('\n## Persona\n```json\n' + JSON.stringify(S.persona, null, 2) + '\n```\n');
	const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `brain-${Date.now()}.md`;
	a.click();
	URL.revokeObjectURL(url);
}

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

// ── Event binding ────────────────────────────────────────────────────────

function bindEvents() {
	document.querySelectorAll('.brn-tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
	document.querySelectorAll('.brn-method').forEach(t => t.addEventListener('click', () => setMethod(t.dataset.method)));

	$('brnSynthesize')?.addEventListener('click', synthesizeFromInterview);
	$('brnFillExample')?.addEventListener('click', () => {
		EXAMPLES.forEach((v, i) => { const el = $(`brnQ${i}`); if (el) el.value = v; });
		updateSynthBtn();
	});

	$('brnFreeformText')?.addEventListener('input', () => {
		const btn = $('brnFreeformSynth');
		if (btn) btn.disabled = !$('brnFreeformText').value.trim();
	});
	$('brnFreeformSynth')?.addEventListener('click', synthesizeFromFreeform);
	$('brnManualSave')?.addEventListener('click', setPersonaFromManual);

	$('brnEditPersona')?.addEventListener('click', openEditMode);
	$('brnSaveEdit')?.addEventListener('click', saveEdit);
	$('brnCancelEdit')?.addEventListener('click', closeEditMode);
	$('brnToggleRaw')?.addEventListener('click', () => {
		const raw = $('brnRawJson');
		if (!raw) return;
		raw.classList.toggle('show');
		const btn = $('brnToggleRaw');
		if (btn) btn.textContent = raw.classList.contains('show') ? 'Hide JSON' : 'JSON';
	});
	$('brnCopyJson')?.addEventListener('click', () => {
		if (S.persona) navigator.clipboard.writeText(JSON.stringify(S.persona, null, 2)).then(() => toast('Copied'));
	});
	$('brnTestPlay')?.addEventListener('click', () => {
		if (S.persona) { const el = $('brnSystem'); if (el) el.value = buildPersonaSystemPrompt(S.persona); }
		setTab('playground');
	});
	$('brnResetPersona')?.addEventListener('click', () => {
		S.persona = null;
		persistPersona();
		$('brnPersonaCard')?.classList.remove('show');
		updateKpis();
		updatePersonaBanner();
		toast('Persona cleared');
	});
	$('brnAgentSelect')?.addEventListener('change', () => {
		const btn = $('brnSaveToAgent');
		if (btn) btn.disabled = !$('brnAgentSelect')?.value;
	});
	$('brnSaveToAgent')?.addEventListener('click', saveToAgent);

	document.querySelectorAll('.brn-mode').forEach(b => b.addEventListener('click', () => setPlayMode(b.dataset.mode)));

	$('brnModelGrid')?.addEventListener('click', e => {
		const toggle = e.target.closest('[data-toggle]');
		if (toggle) {
			e.stopPropagation();
			const key = toggle.dataset.toggle;
			if (!isAvailable(key)) return;
			if (S.active.has(key)) { if (S.active.size > 1) S.active.delete(key); }
			else S.active.add(key);
			renderModelGrid();
			renderPlayControls();
			return;
		}
		const card = e.target.closest('.brn-mc[data-key]');
		if (card) {
			const key = card.dataset.key;
			if (!isAvailable(key)) return;
			S.focusKey = key;
			if (!S.active.has(key)) S.active.add(key);
			renderModelGrid();
			renderPlayControls();
		}
	});
	$('brnModelGrid')?.addEventListener('keydown', e => {
		if (e.key === 'Enter' || e.key === ' ') {
			const card = e.target.closest('.brn-mc[data-key]');
			if (card) { e.preventDefault(); card.click(); }
		}
	});

	$('brnSend')?.addEventListener('click', sendMessage);
	$('brnPrompt')?.addEventListener('keydown', e => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); }
	});

	$('brnNewChat')?.addEventListener('click', () => {
		const s = newSession($('brnSystem')?.value.trim() || '');
		S.sessions.unshift(s);
		S.currentId = s.id;
		persistSessions();
		renderSessions();
		renderCanvas();
		updateKpis();
	});

	$('brnExport')?.addEventListener('click', exportSession);

	$('brnPlaySessions')?.addEventListener('click', e => {
		const del = e.target.closest('[data-del]');
		if (del) { e.stopPropagation(); deleteSessionById(del.dataset.del); return; }
		const item = e.target.closest('[data-sid]');
		if (item) loadSessionById(item.dataset.sid);
	});

	$('brnCanvas')?.addEventListener('click', e => {
		const copy = e.target.closest('[data-copy]');
		if (copy) copyProvider(copy.dataset.copy);
	});
}

// ── Styles ───────────────────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('brn-styles')) return;
	const style = document.createElement('style');
	style.id = 'brn-styles';
	style.textContent = `
.brn-page { max-width: var(--dn-content-max, 1280px); }

.brn-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 20px 0 28px; }
.brn-kpi { background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); padding: 16px 18px; transition: border-color 0.2s; }
.brn-kpi:hover { border-color: var(--nxt-stroke-strong); }
.brn-kpi-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--nxt-ink-dim); margin-bottom: 6px; }
.brn-kpi-value { font-size: 22px; font-weight: 700; color: var(--nxt-ink); line-height: 1.2; }
.brn-kpi-dim { font-weight: 400; color: var(--nxt-ink-fade); font-size: 16px; }
.brn-kpi-persona { font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brn-kpi-persona.is-active { color: var(--nxt-success); }
@media (max-width: 700px) { .brn-kpis { grid-template-columns: repeat(2, 1fr); } }

.brn-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--nxt-stroke); margin-bottom: 24px; }
.brn-tab { background: none; border: none; color: var(--nxt-ink-dim); font-size: 14px; font-weight: 600; padding: 10px 20px; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; }
.brn-tab:hover { color: var(--nxt-ink); }
.brn-tab.is-active { color: var(--nxt-accent); border-bottom-color: var(--nxt-accent); }
.brn-tab:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: -2px; border-radius: 4px; }

.brn-panel { display: none; }
.brn-panel.is-active { display: block; animation: brn-fadeIn 0.2s ease; }
@keyframes brn-fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.brn-model-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
.brn-mc { background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); padding: 20px 20px 16px; position: relative; overflow: hidden; transition: all 0.2s; cursor: pointer; }
.brn-mc:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.25); }
.brn-mc:focus-visible { outline: 2px solid var(--mc, #fff); outline-offset: 2px; }
.brn-mc.is-selected { border-color: var(--mc); box-shadow: 0 0 0 1px var(--mc), inset 0 0 20px rgba(255,255,255,0.02); }
.brn-mc.is-unavail { opacity: 0.45; }
.brn-mc.is-unavail:hover { transform: none; box-shadow: none; }
.brn-mc-bar { position: absolute; top: 0; left: 0; width: 3px; height: 100%; background: var(--mc); opacity: 0.7; transition: opacity 0.2s; }
.brn-mc:hover .brn-mc-bar, .brn-mc.is-selected .brn-mc-bar { opacity: 1; }
.brn-mc-head { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
.brn-mc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--nxt-ink-fade); transition: background 0.2s; }
.brn-mc-dot.is-on { background: var(--nxt-success); box-shadow: 0 0 6px rgba(74,222,128,0.4); }
.brn-mc-avail { font-size: 11px; color: var(--nxt-ink-fade); font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; }
.brn-mc-name { font-size: 16px; font-weight: 700; color: var(--nxt-ink); margin-bottom: 2px; }
.brn-mc-network { font-size: 12px; color: var(--nxt-ink-dim); margin-bottom: 14px; }
.brn-mc-specs { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.brn-mc-ctx { font-size: 12px; color: var(--nxt-ink-dim); background: var(--nxt-accent-soft); padding: 3px 8px; border-radius: var(--nxt-radius-pill); }
.brn-mc-tier { font-size: 12px; font-weight: 600; color: var(--mc); }
.brn-mc-action { width: 100%; background: var(--nxt-bg-3); border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-dim); border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; gap: 6px; justify-content: center; }
.brn-mc-action:hover { background: var(--nxt-bg-2); color: var(--nxt-ink); border-color: var(--nxt-stroke-strong); }
.brn-mc-action.is-on { background: rgba(255,255,255,0.06); border-color: var(--mc); color: var(--nxt-ink); }
.brn-mc-action:disabled { opacity: 0.4; cursor: not-allowed; }
.brn-mc-check { font-size: 13px; color: var(--mc); }

.brn-persona-wrap { max-width: 720px; }
.brn-section-title { font-size: 20px; font-weight: 700; color: var(--nxt-ink); margin: 0 0 6px; }
.brn-section-sub { font-size: 14px; color: var(--nxt-ink-dim); margin: 0 0 24px; line-height: 1.5; }
.brn-methods { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 24px; }
.brn-method { background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); padding: 14px 16px; cursor: pointer; transition: all 0.15s; display: flex; align-items: flex-start; gap: 12px; text-align: left; color: var(--nxt-ink); }
.brn-method:hover { border-color: var(--nxt-stroke-strong); background: var(--nxt-bg-3); }
.brn-method.is-active { border-color: var(--nxt-accent); background: rgba(255,255,255,0.04); }
.brn-method:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.brn-method-icon { font-size: 18px; flex-shrink: 0; margin-top: 2px; }
.brn-method-title { font-size: 13px; font-weight: 700; }
.brn-method-desc { font-size: 11.5px; color: var(--nxt-ink-dim); margin-top: 2px; }
@media (max-width: 600px) { .brn-methods { grid-template-columns: 1fr; } }
.brn-method-body { display: none; }
.brn-method-body.is-active { display: block; animation: brn-fadeIn 0.2s ease; }

.brn-q-card { background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); padding: 18px; margin-bottom: 12px; }
.brn-q-num { display: inline-block; width: 22px; height: 22px; line-height: 22px; text-align: center; border-radius: 50%; background: var(--nxt-accent-soft); color: var(--nxt-ink-dim); font-size: 11px; font-weight: 700; margin-bottom: 8px; }
.brn-q-text { font-size: 14px; font-weight: 600; color: var(--nxt-ink); margin-bottom: 10px; }
.brn-q-input { width: 100%; background: var(--nxt-bg-1); border: 1px solid var(--nxt-stroke); border-radius: 8px; color: var(--nxt-ink); font: inherit; font-size: 13px; padding: 10px 12px; resize: vertical; transition: border-color 0.15s; }
.brn-q-input:focus { border-color: var(--nxt-accent); outline: none; }
.brn-q-input::placeholder { color: var(--nxt-ink-fade); }

.brn-textarea { width: 100%; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); color: var(--nxt-ink); font: inherit; font-size: 13px; padding: 14px 16px; resize: vertical; transition: border-color 0.15s; min-height: 140px; }
.brn-textarea:focus { border-color: var(--nxt-accent); outline: none; }
.brn-textarea::placeholder { color: var(--nxt-ink-fade); }
.brn-form-hint { font-size: 12px; color: var(--nxt-ink-fade); margin-top: 8px; }

.brn-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.brn-field { display: flex; flex-direction: column; gap: 6px; }
.brn-field-full { grid-column: 1 / -1; }
.brn-field label { font-size: 12px; font-weight: 600; color: var(--nxt-ink-dim); text-transform: uppercase; letter-spacing: 0.06em; }
.brn-field input, .brn-field select, .brn-field textarea { background: var(--nxt-bg-1); border: 1px solid var(--nxt-stroke); border-radius: 8px; color: var(--nxt-ink); font: inherit; font-size: 13px; padding: 9px 12px; transition: border-color 0.15s; }
.brn-field input:focus, .brn-field select:focus, .brn-field textarea:focus { border-color: var(--nxt-accent); outline: none; }
.brn-field input::placeholder, .brn-field textarea::placeholder { color: var(--nxt-ink-fade); }
.brn-field select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23888'%3E%3Cpath d='M2 4l4 4 4-4'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px; }
.brn-field-hint { font-size: 11px; color: var(--nxt-ink-fade); }
@media (max-width: 500px) { .brn-form-grid { grid-template-columns: 1fr; } }

.brn-actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
.brn-btn { font: inherit; font-size: 13px; font-weight: 600; padding: 9px 18px; border-radius: 8px; cursor: pointer; transition: all 0.15s; border: 1px solid transparent; white-space: nowrap; }
.brn-btn:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.brn-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.brn-btn-primary { background: #fff; color: #000; border-color: #fff; }
.brn-btn-primary:hover:not(:disabled) { background: #e8e8e8; }
.brn-btn-ghost { background: transparent; color: var(--nxt-ink-dim); border-color: var(--nxt-stroke); }
.brn-btn-ghost:hover:not(:disabled) { color: var(--nxt-ink); border-color: var(--nxt-stroke-strong); background: var(--nxt-accent-soft); }
.brn-btn-sm { font-size: 12px; padding: 6px 12px; }
.brn-select { background: var(--nxt-bg-1); border: 1px solid var(--nxt-stroke); border-radius: 8px; color: var(--nxt-ink); font: inherit; font-size: 12px; padding: 6px 28px 6px 10px; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23888'%3E%3Cpath d='M2 4l4 4 4-4'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; }
.brn-select:focus { border-color: var(--nxt-accent); outline: none; }

.brn-loading { display: none; align-items: center; justify-content: center; gap: 12px; padding: 40px 0; color: var(--nxt-ink-dim); font-size: 14px; }
.brn-loading.show { display: flex; }
.brn-spinner { width: 20px; height: 20px; border: 2px solid var(--nxt-stroke-strong); border-top-color: var(--nxt-accent); border-radius: 50%; animation: brn-spin 0.7s linear infinite; }
@keyframes brn-spin { to { transform: rotate(360deg); } }

.brn-persona-card { display: none; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); margin-top: 24px; overflow: hidden; }
.brn-persona-card.show { display: block; animation: brn-fadeIn 0.3s ease; }
.brn-pc-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--nxt-stroke); }
.brn-pc-header h3 { margin: 0; font-size: 15px; font-weight: 700; color: var(--nxt-ink); }
.brn-pc-acts { display: flex; gap: 6px; }
.brn-pc-body { padding: 20px; }
.brn-pc-row { display: flex; gap: 12px; margin-bottom: 14px; align-items: flex-start; }
.brn-pc-row-full { flex-direction: column; gap: 6px; }
.brn-pc-label { width: 90px; flex-shrink: 0; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--nxt-ink-fade); padding-top: 2px; }
.brn-pc-row-full .brn-pc-label { width: auto; }
.brn-pc-val { font-size: 14px; color: var(--nxt-ink); }
.brn-pc-greeting { font-size: 14px; color: var(--nxt-ink-dim); font-style: italic; }
.brn-badge { display: inline-block; background: var(--nxt-accent-soft); color: var(--nxt-ink); padding: 3px 10px; border-radius: var(--nxt-radius-pill); font-size: 12px; font-weight: 600; }
.brn-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.brn-chip { display: inline-block; padding: 3px 10px; border-radius: var(--nxt-radius-pill); font-size: 12px; font-weight: 500; }
.brn-chip-blue { background: rgba(116,192,252,0.12); color: #74c0fc; }
.brn-chip-purple { background: rgba(177,151,252,0.12); color: #b197fc; }
.brn-chip-red { background: rgba(248,113,113,0.12); color: #f87171; }
.brn-chip-empty { font-size: 12px; color: var(--nxt-ink-fade); }
.brn-pc-edit { padding: 20px; flex-direction: column; gap: 16px; border-top: 1px solid var(--nxt-stroke); }
.brn-raw { display: none; background: var(--nxt-bg-1); border-top: 1px solid var(--nxt-stroke); padding: 16px 20px; font-size: 12px; color: var(--nxt-ink-dim); font-family: 'SF Mono', 'Fira Code', monospace; white-space: pre-wrap; max-height: 240px; overflow-y: auto; margin: 0; }
.brn-raw.show { display: block; }
.brn-pc-footer { display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--nxt-stroke); flex-wrap: wrap; }
.brn-pc-save-wrap { display: flex; gap: 8px; align-items: center; margin-left: auto; }
@media (max-width: 600px) { .brn-pc-row { flex-direction: column; gap: 4px; } .brn-pc-label { width: auto; } .brn-pc-footer { flex-direction: column; align-items: stretch; } .brn-pc-save-wrap { margin-left: 0; } }

.brn-play-layout { display: flex; gap: 0; min-height: max(500px, calc(100vh - 380px)); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); overflow: hidden; background: var(--nxt-bg-1); }
.brn-play-side { width: 210px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--nxt-stroke); background: var(--nxt-bg-0); }
.brn-play-side-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--nxt-stroke); }
.brn-play-side-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--nxt-ink-fade); }
.brn-play-side-new { background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-dim); border-radius: 6px; width: 26px; height: 26px; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s; padding: 0; }
.brn-play-side-new:hover { background: var(--nxt-bg-3); color: var(--nxt-ink); }
.brn-play-sessions { flex: 1; overflow-y: auto; padding: 8px; }
.brn-play-empty { padding: 20px 12px; text-align: center; color: var(--nxt-ink-fade); font-size: 12px; line-height: 1.7; }
.brn-sess { padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 12px; color: var(--nxt-ink-dim); display: flex; align-items: center; gap: 6px; border: 1px solid transparent; transition: all 0.12s; margin-bottom: 2px; }
.brn-sess:hover { background: var(--nxt-bg-2); color: var(--nxt-ink); }
.brn-sess.is-active { background: rgba(255,255,255,0.04); color: var(--nxt-ink); border-color: var(--nxt-stroke); }
.brn-sess:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: -2px; }
.brn-sess-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brn-sess-del { background: none; border: none; color: var(--nxt-ink-fade); cursor: pointer; padding: 2px 4px; font-size: 14px; border-radius: 4px; opacity: 0; transition: all 0.1s; line-height: 1; }
.brn-sess:hover .brn-sess-del { opacity: 1; }
.brn-sess-del:hover { color: var(--nxt-danger); }

.brn-play-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.brn-play-toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--nxt-stroke); background: var(--nxt-bg-0); flex-wrap: wrap; }
.brn-play-toolbar-end { margin-left: auto; }
.brn-mode-toggle { display: flex; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: 8px; overflow: hidden; flex-shrink: 0; }
.brn-mode { background: none; border: none; color: var(--nxt-ink-dim); font-size: 12px; font-weight: 600; padding: 6px 14px; cursor: pointer; transition: all 0.15s; }
.brn-mode:hover { color: var(--nxt-ink); }
.brn-mode.is-active { background: rgba(255,255,255,0.08); color: var(--nxt-accent); }

.brn-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.brn-pill { display: flex; align-items: center; gap: 5px; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-pill); padding: 4px 10px 4px 8px; font-size: 11.5px; font-weight: 600; color: var(--nxt-ink-dim); cursor: pointer; transition: all 0.15s; white-space: nowrap; }
.brn-pill:hover { border-color: var(--nxt-stroke-strong); color: var(--nxt-ink); }
.brn-pill.is-on { border-color: var(--pc); color: var(--nxt-ink); background: rgba(255,255,255,0.04); }
.brn-pill.is-na { opacity: 0.35; cursor: not-allowed; }
.brn-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--pc); flex-shrink: 0; }
.brn-pill-x { font-size: 10px; color: var(--nxt-ink-fade); }
.brn-focus-sel { min-width: 180px; }

.brn-persona-banner { display: none; align-items: center; gap: 8px; padding: 8px 16px; font-size: 12px; color: var(--nxt-ink-dim); background: rgba(74,222,128,0.06); border-bottom: 1px solid rgba(74,222,128,0.15); }
.brn-persona-banner.show { display: flex; }
.brn-banner-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--nxt-success); animation: brn-pulse 2s ease-in-out infinite; }
@keyframes brn-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.brn-banner-dismiss { background: none; border: none; color: var(--nxt-ink-fade); font-size: 11px; cursor: pointer; margin-left: auto; text-decoration: underline; text-underline-offset: 2px; }
.brn-banner-dismiss:hover { color: var(--nxt-ink); }

.brn-canvas { flex: 1; overflow-y: auto; min-height: 200px; }
.brn-compare { display: flex; height: 100%; }
.brn-col { flex: 1; min-width: 200px; display: flex; flex-direction: column; border-right: 1px solid var(--nxt-stroke); }
.brn-col:last-child { border-right: none; }
.brn-col-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--nxt-stroke); background: var(--nxt-bg-0); position: sticky; top: 0; z-index: 1; }
.brn-col-name { font-size: 13px; font-weight: 700; color: var(--pc); }
.brn-col-meta { font-size: 10.5px; color: var(--nxt-ink-fade); }
.brn-col-head-right { display: flex; gap: 8px; align-items: center; }
.brn-col-stats { font-size: 10.5px; color: var(--nxt-ink-fade); white-space: nowrap; }
.brn-col-stats strong { color: var(--nxt-ink-dim); font-weight: 700; }
.brn-col-copy { background: none; border: 1px solid var(--nxt-stroke); border-radius: 5px; color: var(--nxt-ink-fade); font-size: 10px; font-weight: 600; padding: 2px 8px; cursor: pointer; transition: all 0.15s; }
.brn-col-copy:hover { color: var(--nxt-ink-dim); border-color: var(--nxt-stroke-strong); }
.brn-col-msgs { flex: 1; overflow-y: auto; padding: 12px; }
.brn-col-empty { text-align: center; color: var(--nxt-ink-fade); font-size: 12px; padding: 30px 10px; }
.brn-col-user { background: rgba(255,255,255,0.04); border-radius: 8px; padding: 10px 12px; font-size: 13px; color: var(--nxt-ink); margin-bottom: 8px; }
.brn-col-asst { font-size: 13px; color: var(--nxt-ink-dim); margin-bottom: 14px; line-height: 1.6; padding: 0 2px; }
.brn-col-err { color: var(--nxt-danger); }

.brn-chat { display: flex; flex-direction: column; height: 100%; }
.brn-chat-msgs { flex: 1; overflow-y: auto; padding: 16px 20px; }
.brn-chat-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--nxt-ink-dim); padding: 40px; }
.brn-chat-empty-icon { font-size: 32px; margin-bottom: 16px; opacity: 0.3; }
.brn-chat-empty h3 { margin: 0 0 8px; font-size: 16px; color: var(--nxt-ink); }
.brn-chat-empty p { font-size: 13px; line-height: 1.5; max-width: 360px; margin: 0; }
.brn-msg { margin-bottom: 16px; }
.brn-msg-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--nxt-ink-fade); margin-bottom: 6px; }
.brn-msg-asst .brn-msg-label { color: var(--pc); }
.brn-msg-body { font-size: 14px; line-height: 1.65; color: var(--nxt-ink); }
.brn-msg-user .brn-msg-body { background: rgba(255,255,255,0.04); border-radius: 10px; padding: 12px 14px; }
.brn-msg-asst .brn-msg-body { color: var(--nxt-ink-dim); padding: 0 2px; }

.brn-input-wrap { border-top: 1px solid var(--nxt-stroke); padding: 12px 16px; background: var(--nxt-bg-0); }
.brn-sys-details { margin-bottom: 10px; }
.brn-sys-details summary { font-size: 11.5px; font-weight: 600; color: var(--nxt-ink-fade); cursor: pointer; user-select: none; }
.brn-sys-details summary:hover { color: var(--nxt-ink-dim); }
.brn-sys-area { width: 100%; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: 8px; color: var(--nxt-ink-dim); font: inherit; font-size: 12px; padding: 10px 12px; margin-top: 8px; resize: vertical; }
.brn-sys-area:focus { border-color: var(--nxt-accent); outline: none; }
.brn-sys-area::placeholder { color: var(--nxt-ink-fade); }
.brn-input-row { display: flex; gap: 8px; }
.brn-prompt { flex: 1; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: 10px; color: var(--nxt-ink); font: inherit; font-size: 13px; padding: 10px 14px; resize: none; min-height: 40px; max-height: 120px; transition: border-color 0.15s; }
.brn-prompt:focus { border-color: var(--nxt-accent); outline: none; }
.brn-prompt::placeholder { color: var(--nxt-ink-fade); }
.brn-send { background: #fff; color: #000; border: none; border-radius: 10px; padding: 0 20px; font-size: 13px; font-weight: 700; cursor: pointer; transition: all 0.15s; flex-shrink: 0; }
.brn-send:hover:not(:disabled) { background: #e8e8e8; }
.brn-send:disabled { opacity: 0.4; cursor: not-allowed; }
.brn-send:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.brn-input-hint { font-size: 11px; color: var(--nxt-ink-fade); margin-top: 6px; text-align: right; }

.brn-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--nxt-stroke-strong); border-top-color: var(--nxt-ink-dim); border-radius: 50%; animation: brn-spin 0.6s linear infinite; vertical-align: middle; }

.brn-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px); background: #fff; color: #000; padding: 10px 20px; border-radius: var(--nxt-radius-pill); font-size: 13px; font-weight: 600; opacity: 0; pointer-events: none; transition: all 0.25s ease; z-index: 9999; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
.brn-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }

.brn-ic { background: var(--nxt-accent-soft); padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
.brn-pre { background: var(--nxt-bg-1); border: 1px solid var(--nxt-stroke); border-radius: 8px; padding: 12px 14px; overflow-x: auto; font-size: 12px; line-height: 1.5; margin: 10px 0; }
.brn-md-h { margin: 14px 0 6px; font-size: 15px; color: var(--nxt-ink); }
.brn-md-ul, .brn-md-ol { padding-left: 20px; margin: 8px 0; }
.brn-md-ul li, .brn-md-ol li { margin-bottom: 4px; }
.brn-md-p { margin: 8px 0; }

@media (max-width: 768px) {
	.brn-play-side { display: none; }
	.brn-play-layout { min-height: max(400px, calc(100vh - 340px)); }
	.brn-compare { flex-direction: column; }
	.brn-col { min-width: 0; border-right: none; border-bottom: 1px solid var(--nxt-stroke); }
	.brn-col:last-child { border-bottom: none; }
	.brn-col-msgs { max-height: 300px; }
	.brn-play-toolbar { gap: 8px; }
	.brn-pills { gap: 4px; }
}
	`;
	document.head.appendChild(style);
}
