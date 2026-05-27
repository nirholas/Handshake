// ── brain.js — Persona builder + multi-model playground ─────────────────────

// ── Provider registry ────────────────────────────────────────────────────────
const PROVIDERS = [
	{ key: 'claude-opus-4-7',   label: 'Claude Opus 4.7',    short: 'Opus 4.7',    network: 'Anthropic',  color: '#c8a96e', ctx: '200K', tier: 'Flagship' },
	{ key: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',  short: 'Sonnet 4.6',  network: 'Anthropic',  color: '#d4b87a', ctx: '200K', tier: 'Balanced' },
	{ key: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',   short: 'Haiku 4.5',   network: 'Anthropic',  color: '#e0c88a', ctx: '200K', tier: 'Fast'     },
	{ key: 'gpt-4o',            label: 'GPT-4o',             short: 'GPT-4o',      network: 'OpenAI',     color: '#74c0fc', ctx: '128K', tier: 'Flagship' },
	{ key: 'gpt-4o-mini',       label: 'GPT-4o-mini',        short: 'GPT-4o-mini', network: 'OpenAI',     color: '#90ccfc', ctx: '128K', tier: 'Fast'     },
	{ key: 'o3-mini',            label: 'o3-mini',            short: 'o3-mini',     network: 'OpenAI',     color: '#5cb0f4', ctx: '128K', tier: 'Reasoning' },
	{ key: 'groq-llama',        label: 'Llama 3.3 70B',      short: 'Llama 3.3',   network: 'Groq',       color: '#ff9a3c', ctx: '128K', tier: 'Fast'     },
	{ key: 'qwen-plus',         label: 'Qwen Plus',           short: 'Qwen+',       network: 'DashScope',  color: '#69db7c', ctx: '131K', tier: 'Balanced' },
	{ key: 'modelscope-qwen',   label: 'Qwen3-Coder 480B',   short: 'Qwen3-Code',  network: 'ModelScope', color: '#40c057', ctx: '32K',  tier: 'Flagship' },
	{ key: 'deepseek-r1',       label: 'DeepSeek R1',         short: 'DeepSeek',    network: 'DeepSeek',   color: '#b197fc', ctx: '64K',  tier: 'Reasoning' },
];
const PMAP = new Map(PROVIDERS.map(p => [p.key, p]));

// ── Interview questions ──────────────────────────────────────────────────────
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
	method: 'interview',
	persona: null,
	personaEnabled: true,
	authed: isAuthedHint(),

	playMode: 'compare',
	focusKey: 'groq-llama',
	active: new Set(['groq-llama', 'claude-sonnet-4-6', 'gpt-4o-mini', 'deepseek-r1']),
	sessions: [],
	currentId: null,
	streaming: false,
	agents: [],
	availableProviders: null, // set after API fetch; null = not yet loaded
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
function inlineMd(s) {
	s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
	s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
	s = s.replace(/`([^`\n]+)`/g, '<code class="md-ic">$1</code>');
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
			const codeLines = [];
			i++;
			while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(escHtml(lines[i])); i++; }
			i++;
			out.push(`<pre class="md-code"><code>${codeLines.join('\n')}</code></pre>`);
			continue;
		}
		const hm = line.match(/^(#{1,3})\s+(.+)/);
		if (hm) { out.push(`<h${hm[1].length} class="md-h${hm[1].length}">${inlineMd(escHtml(hm[2]))}</h${hm[1].length}>`); i++; continue; }
		if (/^[-*+]\s/.test(line)) {
			const items = [];
			while (i < lines.length && /^[-*+]\s/.test(lines[i])) { items.push(`<li>${inlineMd(escHtml(lines[i].replace(/^[-*+]\s/, '')))}</li>`); i++; }
			out.push(`<ul class="md-ul">${items.join('')}</ul>`);
			continue;
		}
		if (/^\d+\.\s/.test(line)) {
			const items = [];
			while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(`<li>${inlineMd(escHtml(lines[i].replace(/^\d+\.\s/, '')))}</li>`); i++; }
			out.push(`<ol class="md-ol">${items.join('')}</ol>`);
			continue;
		}
		if (!line.trim()) { i++; continue; }
		const pLines = [];
		while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('```') && !/^[-*+]\s/.test(lines[i]) && !/^\d+\.\s/.test(lines[i])) {
			pLines.push(inlineMd(escHtml(lines[i])));
			i++;
		}
		if (pLines.length) out.push(`<p class="md-p">${pLines.join('<br>')}</p>`);
	}
	return out.join('');
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

// ── Render: Interview questions ──────────────────────────────────────────────
function renderQuestions() {
	const container = $('brQuestions');
	container.innerHTML = '';
	QUESTIONS.forEach((q, i) => {
		const card = document.createElement('div');
		card.className = 'br-q-card';
		card.innerHTML = `
			<span class="br-q-num">Question ${i + 1}</span>
			<div class="br-q-text">${escHtml(q.q)}</div>
			<textarea class="br-q-input" id="brQ${i}" placeholder="${escHtml(q.placeholder)}" rows="2"></textarea>
		`;
		container.appendChild(card);
	});
	container.querySelectorAll('.br-q-input').forEach(el => {
		el.addEventListener('input', updateSynthButton);
	});
}

function collectAnswers() {
	return QUESTIONS.map((q, i) => ({
		question: q.q,
		answer: ($(`brQ${i}`)?.value || '').trim(),
	}));
}

function updateSynthButton() {
	const allFilled = collectAnswers().every(a => a.answer.length > 0);
	$('brSynthesize').disabled = !allFilled || !state.authed;
	const freeBtn = $('brFreeformSynth');
	if (freeBtn) freeBtn.disabled = !$('brFreeformText')?.value.trim() || !state.authed;
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

// ── Render: Persona card ─────────────────────────────────────────────────────
function renderPersonaCard(p) {
	$('brPersonaCard').classList.add('show');
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

// ── Persona: Synthesis ───────────────────────────────────────────────────────
async function synthesizeFromInterview() {
	const answers = collectAnswers();
	if (!answers.every(a => a.answer.length > 0)) return;
	await runExtraction({ answers });
}

async function synthesizeFromFreeform() {
	const text = $('brFreeformText').value.trim();
	if (!text) return;
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
		toast(`Persona extracted (${data.tokens_used} tokens, ${data.latency_ms}ms)`);
	} catch (err) {
		toast(`Extraction failed: ${err.message}`);
	} finally {
		$('brLoading').classList.remove('show');
	}
}

function setPersonaFromManual() {
	const split = v => v.split(',').map(s => s.trim()).filter(Boolean);
	state.persona = {
		tone: $('brManTone').value.trim() || 'Neutral',
		communication_style: $('brManStyle').value,
		vocabulary: split($('brManVocab').value),
		interests: split($('brManInterests').value),
		dont_say: split($('brManDont').value),
		sample_greeting: $('brManGreet').value.trim(),
	};
	persistPersona();
	renderPersonaCard(state.persona);
	toast('Persona set');
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
	toast('Persona updated');
}

function closeEditMode() {
	$('brPcBody').style.display = '';
	$('brPcEditBody').style.display = 'none';
	$('brEditPersona').style.display = '';
}

// ── Persona: Save to agent ───────────────────────────────────────────────────
async function loadAgents() {
	try {
		const res = await fetch('/api/agents', { credentials: 'include' });
		if (!res.ok) return;
		const data = await res.json();
		state.agents = data.agents || data || [];
		renderAgentSelect();
	} catch {}
}

function renderAgentSelect() {
	const sel = $('brAgentSelect');
	sel.innerHTML = '<option value="">Select agent...</option>';
	for (const agent of state.agents) {
		const opt = document.createElement('option');
		opt.value = agent.id;
		opt.textContent = agent.name || `Agent ${agent.id.slice(0, 8)}`;
		sel.appendChild(opt);
	}
}

async function savePersonaToAgent() {
	const agentId = $('brAgentSelect').value;
	if (!agentId || !state.persona) return;

	const btn = $('brSaveToAgent');
	btn.disabled = true;
	btn.textContent = 'Saving...';

	try {
		const persona = {
			system_prompt: buildPersonaSystemPrompt(state.persona),
			tone: state.persona.tone,
			traits: [
				...(state.persona.vocabulary || []),
				...(state.persona.interests || []),
			],
		};
		const res = await fetch(`/api/agents/${agentId}`, {
			method: 'PUT',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ persona }),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `HTTP ${res.status}`);
		}
		const agentName = state.agents.find(a => a.id === agentId)?.name || 'agent';
		toast(`Persona saved to ${agentName}`);
	} catch (err) {
		toast(`Save failed: ${err.message}`);
	} finally {
		btn.disabled = false;
		btn.textContent = 'Save to Agent';
	}
}

// ── Render: Sidebar sessions ─────────────────────────────────────────────────
function renderSidebar() {
	const el = $('brSessions');
	if (!state.sessions.length) {
		el.innerHTML = '<div class="br-empty">No sessions yet.<br>Send a message to start.</div>';
		return;
	}
	el.innerHTML = state.sessions.map(s => `
		<div class="br-sess${s.id === state.currentId ? ' active' : ''}" data-id="${escHtml(s.id)}">
			<span class="br-sess-name">${escHtml(s.name)}</span>
			<button class="br-sess-del" data-del="${escHtml(s.id)}" title="Delete">x</button>
		</div>
	`).join('');
}

// ── Render: Playground toolbar ───────────────────────────────────────────────
function isProviderAvailable(key) {
	if (!state.availableProviders) return true; // optimistic before load
	const found = state.availableProviders.find(p => p.key === key);
	return found ? found.available : false;
}

function renderPlayControls() {
	const ctrl = $('brPlayControls');
	const label = $('brPlayLabel');
	if (state.playMode === 'compare') {
		label.textContent = 'Models';
		ctrl.innerHTML = `<div class="br-provider-pills">${
			PROVIDERS.map(p => {
				const avail = isProviderAvailable(p.key);
				const cls = [
					'br-pill',
					state.active.has(p.key) ? 'on' : '',
					!avail ? 'unavailable' : '',
				].filter(Boolean).join(' ');
				const title = avail ? '' : ` title="${p.label} — not configured on this deployment"`;
				return `<label class="${cls}" style="--pc:${p.color}" data-key="${p.key}"${title}>
					<span class="br-pill-dot"></span>
					<span>${p.short}</span>
					${!avail ? '<span class="br-pill-na" aria-hidden="true">✕</span>' : ''}
				</label>`;
			}).join('')
		}</div>`;
	} else {
		label.textContent = 'Model';
		ctrl.innerHTML = `<select class="br-focus-sel" id="brFocusSel">${
			PROVIDERS.map(p => {
				const avail = isProviderAvailable(p.key);
				return `<option value="${p.key}"${p.key === state.focusKey ? ' selected' : ''}${!avail ? ' disabled' : ''}>${p.label}${avail ? '' : ' (unavailable)'}</option>`;
			}).join('')
		}</select>`;
	}
	bindPlayControlEvents();
}

async function fetchProviderAvailability() {
	try {
		const r = await fetch('/api/brain/chat', { method: 'GET' });
		if (!r.ok) return;
		const data = await r.json();
		if (Array.isArray(data.providers)) {
			state.availableProviders = data.providers;
			for (const key of [...state.active]) {
				const found = data.providers.find(p => p.key === key);
				if (found && !found.available) state.active.delete(key);
			}
			if (state.active.size === 0) {
				const first = data.providers.find(p => p.available);
				if (first) state.active.add(first.key);
			}
			const focusAvail = data.providers.find(p => p.key === state.focusKey);
			if (!focusAvail || !focusAvail.available) {
				const first = data.providers.find(p => p.available);
				if (first) state.focusKey = first.key;
			}
			renderPlayControls();
		}
	} catch {
		// Non-fatal — providers just show as all-available
	}
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
							<div class="br-col-name">${escHtml(p.short)}</div>
							<div class="br-col-meta">${escHtml(p.network)} / ${escHtml(p.ctx)} / ${escHtml(p.tier)}</div>
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

function renderCanvas() {
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

	const activeKeys = state.playMode === 'compare' ? [...state.active] : [state.focusKey];
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
	$('brSend').disabled = true;

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
	$('brSend').disabled = false;
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
	document.querySelectorAll('.br-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
	renderPlayControls();
	renderCanvas();
}

// ── Bind playground control events ───────────────────────────────────────────
function bindPlayControlEvents() {
	if (state.playMode === 'compare') {
		document.querySelectorAll('.br-pill').forEach(pill => {
			pill.addEventListener('click', () => {
				const key = pill.dataset.key;
				if (state.active.has(key)) { if (state.active.size > 1) state.active.delete(key); }
				else state.active.add(key);
				pill.classList.toggle('on', state.active.has(key));
				renderCanvas();
			});
		});
	} else {
		const sel = document.getElementById('brFocusSel');
		if (sel) sel.addEventListener('change', () => { state.focusKey = sel.value; renderCanvas(); });
	}
}

// ── Method tabs ──────────────────────────────────────────────────────────────
function setMethod(method) {
	state.method = method;
	document.querySelectorAll('.br-method-tab').forEach(t => t.classList.toggle('active', t.dataset.method === method));
	$('brInterview').classList.toggle('active', method === 'interview');
	$('brFreeform').classList.toggle('active', method === 'freeform');
	$('brManual').classList.toggle('active', method === 'manual');
}

// ── Bind all events ──────────────────────────────────────────────────────────
function bindEvents() {
	// Tab switching
	document.querySelectorAll('.br-tab').forEach(t => {
		t.addEventListener('click', () => setTab(t.dataset.tab));
	});

	// Method tabs
	document.querySelectorAll('.br-method-tab').forEach(t => {
		t.addEventListener('click', () => setMethod(t.dataset.method));
	});

	// Interview
	$('brSynthesize').addEventListener('click', synthesizeFromInterview);
	$('brFillExample').addEventListener('click', () => {
		EXAMPLES.forEach((v, i) => { const el = $(`brQ${i}`); if (el) el.value = v; });
		updateSynthButton();
	});

	// Freeform
	$('brFreeformText').addEventListener('input', () => {
		$('brFreeformSynth').disabled = !$('brFreeformText').value.trim();
	});
	$('brFreeformSynth').addEventListener('click', synthesizeFromFreeform);

	// Manual
	$('brManualSave').addEventListener('click', setPersonaFromManual);

	// Persona card actions
	$('brEditPersona').addEventListener('click', openEditMode);
	$('brSaveEdit').addEventListener('click', saveEdit);
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
	$('brTestInPlayground').addEventListener('click', () => {
		if (state.persona) {
			$('brSystem').value = buildPersonaSystemPrompt(state.persona);
		}
		setTab('playground');
	});
	$('brResetPersona').addEventListener('click', () => {
		state.persona = null;
		persistPersona();
		$('brPersonaCard').classList.remove('show');
		updatePersonaMini();
		updatePersonaBanner();
		toast('Persona cleared');
	});

	// Save to agent
	$('brAgentSelect').addEventListener('change', () => {
		$('brSaveToAgent').disabled = !$('brAgentSelect').value;
	});
	$('brSaveToAgent').addEventListener('click', savePersonaToAgent);

	// Sidebar: build persona shortcut
	$('brBuildPersonaBtn').addEventListener('click', () => setTab('persona'));
	$('brMiniClear').addEventListener('click', () => {
		state.persona = null;
		persistPersona();
		updatePersonaMini();
		updatePersonaBanner();
		toast('Persona cleared');
	});

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
	});

	// Export
	$('brExport').addEventListener('click', exportSession);

	// Session list (delegated)
	$('brSessions').addEventListener('click', e => {
		const del = e.target.closest('[data-del]');
		if (del) { deleteSession(del.dataset.del); return; }
		const item = e.target.closest('[data-id]');
		if (item) loadSession(item.dataset.id);
	});

	// Canvas clicks (delegated)
	$('brCanvas').addEventListener('click', e => {
		const copy = e.target.closest('[data-copy]');
		if (copy) copyProvider(copy.dataset.copy);
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

renderQuestions();
renderPlayControls();
renderSidebar();
renderCanvas();
bindEvents();
fetchProviderAvailability();

if (!state.authed) showAuthGate();

if (state.persona) {
	renderPersonaCard(state.persona);
}
updatePersonaMini();
updatePersonaBanner();

const activeSess = currentSession();
if (activeSess?.system) $('brSystem').value = activeSess.system;

loadAgents();
