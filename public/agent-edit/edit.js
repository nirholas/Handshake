// Agent persona editor: /agents/:id/edit
// Native DOM, no framework.

const agentId = location.pathname.split('/').filter(Boolean)[1];

const DEFAULT_PERSONA = {
	name: '',
	bio: '',
	systemPrompt: '',
	catchphrases: [],
	sentimentBias: 0,
	doNotSay: [],
};

let agent = null;
let templates = [];
let _saveDebounce = null;

// Voice picker state — managed separately from persona so changes survive
// template resets.
let _voiceProvider = 'web'; // 'web' | 'eleven'
let _voiceId = null; // voice name (web) or voice_id (eleven)
let _elevenEnabled = false;
let _elevenLoaded = false;
let _webVoices = [];

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function main() {
	if (!agentId) return showForbidden();

	// Auth check
	const me = await apiFetch('/api/auth/me').catch(() => null);
	if (!me?.user) {
		location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		return;
	}

	// Fetch agent
	const data = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`).catch(() => null);
	if (!data?.agent) return showForbidden();
	agent = data.agent;

	// Ownership check (user_id only present for owner)
	if (!agent.user_id || agent.user_id !== me.user.id) return showForbidden();

	// Check ElevenLabs availability
	try {
		const cfg = await apiFetch('/api/config').catch(() => ({}));
		_elevenEnabled = Boolean(cfg.elevenLabsEnabled);
	} catch {}

	// Load templates
	templates = await apiFetch('/agent-edit/templates.json').catch(() => []);

	// Restore voice config from meta
	const voiceMeta = agent.meta?.voice || {};
	_voiceProvider = voiceMeta.provider === 'eleven' ? 'eleven' : 'web';
	_voiceId = voiceMeta.voiceId || null;

	// Render
	document.getElementById('loading-screen').style.display = 'none';
	document.getElementById('layout').style.display = '';
	document.getElementById('header-title').textContent = `Edit — ${agent.name}`;
	const viewLink = document.getElementById('view-link');
	viewLink.href = `/agents/${agentId}`;

	loadPreview();
	renderTemplates();
	renderForm(agent.meta?.persona || DEFAULT_PERSONA);
	initVoicePicker();
	bindEvents();
	// Save button stays disabled until the user edits a field; input listeners
	// re-enable it via markDirty().
}

function showForbidden() {
	document.getElementById('loading-screen').style.display = 'none';
	document.getElementById('forbidden-screen').style.display = '';
}

// ── Preview iframe ─────────────────────────────────────────────────────────

function loadPreview() {
	const frame = document.getElementById('preview-frame');
	const loading = document.getElementById('preview-loading');
	frame.src = `/agents/${agentId}/embed`;
	frame.addEventListener(
		'load',
		() => {
			loading.style.display = 'none';
			frame.style.display = 'block';
		},
		{ once: true },
	);
}

function reloadPreview() {
	const frame = document.getElementById('preview-frame');
	const loading = document.getElementById('preview-loading');
	frame.style.display = 'none';
	loading.style.display = 'grid';
	frame.src = `/agents/${agentId}/embed?_t=${Date.now()}`;
	frame.addEventListener(
		'load',
		() => {
			loading.style.display = 'none';
			frame.style.display = 'block';
		},
		{ once: true },
	);
}

// ── Templates ──────────────────────────────────────────────────────────────

function renderTemplates() {
	const row = document.getElementById('templates-row');
	row.innerHTML = '';
	for (const tpl of templates) {
		const btn = document.createElement('button');
		btn.className = 'template-btn';
		btn.textContent = tpl.label;
		btn.title = tpl.description;
		btn.addEventListener('click', () => applyTemplate(tpl));
		row.appendChild(btn);
	}
}

function applyTemplate(tpl) {
	renderForm({ ...DEFAULT_PERSONA, ...tpl.persona });
	markDirty();
	toast('Template applied — review and save.');
}

// ── Form rendering ─────────────────────────────────────────────────────────

function renderForm(persona) {
	const p = { ...DEFAULT_PERSONA, ...persona };

	setVal('f-name', p.name);
	setVal('f-bio', p.bio);
	setVal('f-system-prompt', p.systemPrompt);

	const biasInput = document.getElementById('f-sentiment-bias');
	biasInput.value = p.sentimentBias;
	document.getElementById('bias-value').textContent = Number(p.sentimentBias).toFixed(2);

	renderCatchphrases(p.catchphrases || []);
	renderChips(p.doNotSay || []);
	updateCharCounts();
}

function setVal(id, val) {
	const el = document.getElementById(id);
	if (el) el.value = val || '';
}

function renderCatchphrases(list) {
	const container = document.getElementById('catchphrase-list');
	const addBtn = document.getElementById('add-catchphrase-btn');
	container.innerHTML = '';
	list.forEach((text, i) => addCatchphraseRow(text, i));
	addBtn.style.display = list.length < 5 ? '' : 'none';
}

function addCatchphraseRow(text = '', _index) {
	const container = document.getElementById('catchphrase-list');
	const addBtn = document.getElementById('add-catchphrase-btn');
	const row = document.createElement('div');
	row.className = 'catchphrase-row';

	const input = document.createElement('input');
	input.type = 'text';
	input.maxLength = 80;
	input.value = text;
	input.placeholder = 'e.g. "Let\'s figure this out"';
	input.addEventListener('input', scheduleSave);

	const removeBtn = document.createElement('button');
	removeBtn.textContent = '×';
	removeBtn.title = 'Remove';
	removeBtn.addEventListener('click', () => {
		row.remove();
		const count = container.querySelectorAll('.catchphrase-row').length;
		addBtn.style.display = count < 5 ? '' : 'none';
		scheduleSave();
	});

	row.appendChild(input);
	row.appendChild(removeBtn);
	container.appendChild(row);

	const count = container.querySelectorAll('.catchphrase-row').length;
	addBtn.style.display = count < 5 ? '' : 'none';
}

// ── Chip input (do-not-say) ────────────────────────────────────────────────

let _doNotSay = [];

function renderChips(list) {
	_doNotSay = [...list];
	rebuildChipDom();
}

function rebuildChipDom() {
	const wrap = document.getElementById('dns-wrap');
	const textInput = document.getElementById('dns-input');
	// Remove existing chips (not the text input)
	wrap.querySelectorAll('.chip').forEach((c) => c.remove());
	_doNotSay.forEach((word, i) => {
		const chip = document.createElement('span');
		chip.className = 'chip';
		chip.textContent = word;
		const del = document.createElement('button');
		del.textContent = '×';
		del.title = `Remove "${word}"`;
		del.addEventListener('click', () => {
			_doNotSay.splice(i, 1);
			rebuildChipDom();
			scheduleSave();
		});
		chip.appendChild(del);
		wrap.insertBefore(chip, textInput);
	});
}

// ── Char counters ──────────────────────────────────────────────────────────

function updateCharCounts() {
	updateCount('f-name', 'cnt-name', 40);
	updateCount('f-bio', 'cnt-bio', 280);
	updateCount('f-system-prompt', 'cnt-system-prompt', 2000);
}

function updateCount(fieldId, countId, max) {
	const field = document.getElementById(fieldId);
	const counter = document.getElementById(countId);
	if (field && counter) {
		const len = field.value.length;
		counter.textContent = `${len}/${max}`;
		counter.style.color = len > max * 0.9 ? '#ff9a3c' : '#555';
	}
}

// ── Voice picker ──────────────────────────────────────────────────────────

function initVoicePicker() {
	const group = document.getElementById('voice-picker-group');

	// Provider toggle
	const toggle = document.createElement('div');
	toggle.className = 'vp-toggle';
	toggle.innerHTML = `
		<button class="vp-toggle-btn${_voiceProvider === 'web' ? ' active' : ''}" data-vp="web">Web Speech</button>
		<button class="vp-toggle-btn${_voiceProvider === 'eleven' ? ' active' : ''}" data-vp="eleven"
			${_elevenEnabled ? '' : 'disabled title="ElevenLabs API key not configured"'}>ElevenLabs</button>
	`;
	group.appendChild(toggle);

	toggle.querySelectorAll('.vp-toggle-btn').forEach((btn) => {
		btn.addEventListener('click', () => setVoiceProvider(btn.dataset.vp));
	});

	// Voice list container
	const listWrap = document.createElement('div');
	listWrap.id = 'vp-list-wrap';
	group.appendChild(listWrap);

	renderVoiceSection();
}

function setVoiceProvider(p) {
	if (p === 'eleven' && !_elevenEnabled) return;
	_voiceProvider = p;
	document
		.querySelectorAll('.vp-toggle-btn')
		.forEach((b) => b.classList.toggle('active', b.dataset.vp === p));
	renderVoiceSection();
	scheduleSave();
}

function renderVoiceSection() {
	const wrap = document.getElementById('vp-list-wrap');
	if (!wrap) return;
	wrap.innerHTML = '';
	if (_voiceProvider === 'web') renderWebVoices(wrap);
	if (_voiceProvider === 'eleven') renderElevenVoices(wrap);
}

// Web Speech
function renderWebVoices(wrap) {
	if (!('speechSynthesis' in window)) {
		wrap.innerHTML = '<div class="vp-empty">Web Speech not available in this browser.</div>';
		return;
	}

	const doRender = () => {
		_webVoices = window.speechSynthesis.getVoices();
		if (!_webVoices.length) return;

		// Group by language family
		const groups = {};
		for (const v of _webVoices) {
			const lang = v.lang ? v.lang.slice(0, 2).toUpperCase() : '??';
			(groups[lang] = groups[lang] || []).push(v);
		}

		const list = document.createElement('div');
		list.className = 'vp-list';
		for (const [lang, voices] of Object.entries(groups).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			const label = document.createElement('div');
			label.className = 'vp-group-label';
			label.textContent = lang;
			list.appendChild(label);
			for (const v of voices) {
				const selected = _voiceProvider === 'web' && _voiceId === v.name;
				list.appendChild(
					buildVoiceItem(v.name, v.name, v.lang, selected, (btn) => {
						previewWebVoice(v.name, btn);
					}),
				);
			}
		}
		wrap.innerHTML = '';
		wrap.appendChild(list);
	};

	const voices = window.speechSynthesis.getVoices();
	if (voices.length) {
		doRender();
		return;
	}
	window.speechSynthesis.addEventListener('voiceschanged', doRender, { once: true });
	setTimeout(doRender, 250); // fallback for browsers that don't fire voiceschanged
}

// ElevenLabs
async function renderElevenVoices(wrap) {
	if (!_elevenEnabled) {
		wrap.innerHTML =
			'<div class="vp-empty">ElevenLabs API key not configured on this server.</div>';
		return;
	}

	if (!_elevenLoaded) {
		wrap.innerHTML = '<div class="vp-empty">Loading ElevenLabs voices…</div>';
		let data;
		try {
			data = await apiFetch('/api/tts/eleven/voices');
			_elevenLoaded = true;
		} catch (e) {
			wrap.innerHTML = `<div class="vp-empty">Failed to load voices: ${esc(e.message)}</div>`;
			return;
		}

		if (!data.enabled) {
			wrap.innerHTML = '<div class="vp-empty">ElevenLabs not configured.</div>';
			return;
		}

		const list = document.createElement('div');
		list.className = 'vp-list';
		list.id = 'vp-eleven-list';

		for (const v of data.voices) {
			const meta = [v.category, v.labels?.accent, v.labels?.gender]
				.filter(Boolean)
				.join(' · ');
			const selected = _voiceProvider === 'eleven' && _voiceId === v.voice_id;
			list.appendChild(
				buildVoiceItem(v.voice_id, v.name, meta, selected, (btn) => {
					previewElevenVoice(v.voice_id, btn);
				}),
			);
		}

		wrap.innerHTML = '';
		wrap.appendChild(list);
		return;
	}

	// Already loaded — just rebuild with correct selection
	const cached = document.getElementById('vp-eleven-list');
	if (cached) {
		wrap.innerHTML = '';
		wrap.appendChild(cached);
		cached.querySelectorAll('.vp-item').forEach((item) => {
			item.classList.toggle('selected', _voiceId === item.dataset.vid);
		});
	}
}

function buildVoiceItem(vid, displayName, meta, selected, previewFn) {
	const el = document.createElement('div');
	el.className = 'vp-item' + (selected ? ' selected' : '');
	el.dataset.vid = vid;
	el.innerHTML = `
		<div class="vp-radio"></div>
		<div style="flex:1;min-width:0">
			<div class="vp-name">${esc(displayName)}</div>
			${meta ? `<div class="vp-meta">${esc(meta)}</div>` : ''}
		</div>
		<button class="vp-preview-btn" type="button">Preview</button>
	`;
	el.addEventListener('click', (e) => {
		if (e.target.classList.contains('vp-preview-btn')) return;
		selectVoiceItem(el, vid);
	});
	el.querySelector('.vp-preview-btn').addEventListener('click', (e) => {
		e.stopPropagation();
		previewFn(e.target);
	});
	return el;
}

function selectVoiceItem(el, vid) {
	el.closest('.vp-list')
		.querySelectorAll('.vp-item')
		.forEach((i) => i.classList.remove('selected'));
	el.classList.add('selected');
	_voiceId = vid;
	scheduleSave();
}

function previewWebVoice(name, btn) {
	if (!('speechSynthesis' in window)) return;
	window.speechSynthesis.cancel();
	const utter = new SpeechSynthesisUtterance("Hi, I'm your agent.");
	const voice = window.speechSynthesis.getVoices().find((v) => v.name === name);
	if (voice) utter.voice = voice;
	if (btn) {
		btn.disabled = true;
		utter.onend = () => {
			btn.disabled = false;
		};
		utter.onerror = () => {
			btn.disabled = false;
		};
	}
	window.speechSynthesis.speak(utter);
}

async function previewElevenVoice(voiceId, btn) {
	if (btn) btn.disabled = true;
	try {
		const res = await fetch('/api/tts/eleven', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ voiceId, text: "Hi, I'm your agent." }),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			toast(err.error_description || `Preview failed (${res.status})`, true);
			return;
		}
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		const cleanup = () => {
			URL.revokeObjectURL(url);
			if (btn) btn.disabled = false;
		};
		audio.addEventListener('ended', cleanup, { once: true });
		audio.addEventListener('error', cleanup, { once: true });
		await audio.play();
	} catch (e) {
		toast(`Preview failed: ${e.message}`, true);
		if (btn) btn.disabled = false;
	}
}

// ── Read form → persona object ─────────────────────────────────────────────

function readForm() {
	const catchphrases = [...document.querySelectorAll('#catchphrase-list .catchphrase-row input')]
		.map((i) => i.value.trim())
		.filter(Boolean);

	return {
		name: document.getElementById('f-name').value.trim(),
		bio: document.getElementById('f-bio').value.trim(),
		systemPrompt: document.getElementById('f-system-prompt').value.trim(),
		catchphrases,
		sentimentBias: parseFloat(document.getElementById('f-sentiment-bias').value),
		doNotSay: [..._doNotSay],
	};
}

// ── Save ───────────────────────────────────────────────────────────────────

function setSaveStatus(state) {
	const el = document.getElementById('save-status');
	if (!el) return;
	el.classList.remove('saving', 'saved');
	if (state === 'saving') {
		el.classList.add('saving');
		el.textContent = 'Saving…';
	} else if (state === 'saved') {
		el.classList.add('saved');
		el.textContent = 'Saved';
		clearTimeout(setSaveStatus._t);
		setSaveStatus._t = setTimeout(() => {
			if (el.classList.contains('saved')) el.textContent = '';
		}, 2000);
	} else {
		el.textContent = '';
	}
}

function markDirty() {
	const btn = document.getElementById('save-btn');
	if (btn) btn.disabled = false;
	setSaveStatus('');
}

function scheduleSave() {
	markDirty();
	clearTimeout(_saveDebounce);
	_saveDebounce = setTimeout(() => {
		save({ auto: true });
	}, 2000);
}

async function save({ auto = false } = {}) {
	clearTimeout(_saveDebounce);
	const btn = document.getElementById('save-btn');
	btn.disabled = true;
	const prevLabel = btn.textContent;
	btn.textContent = 'Saving…';
	setSaveStatus('saving');
	try {
		const persona = readForm();
		if (!persona.name) {
			if (!auto) toast('Name is required.', true);
			setSaveStatus('');
			btn.disabled = false;
			btn.textContent = prevLabel;
			return;
		}

		// Merge voice config into meta alongside persona. We send the full meta
		// because the API replaces it wholesale via COALESCE.
		const currentMeta = agent.meta || {};
		const newMeta = {
			...currentMeta,
			persona,
			voice: { provider: _voiceProvider, voiceId: _voiceId || null },
		};

		await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, {
			method: 'PUT',
			body: JSON.stringify({
				name: persona.name,
				description: persona.bio,
				meta: newMeta,
			}),
		});

		// Update local agent reference so subsequent saves carry forward the new meta.
		agent = { ...agent, name: persona.name, description: persona.bio, meta: newMeta };

		setSaveStatus('saved');
		btn.textContent = 'Save';
		btn.disabled = true; // clean — re-enabled by next edit
		if (!auto) {
			toast('Saved!');
			reloadPreview();
		}
	} catch (err) {
		if (auto) {
			console.warn('Autosave failed:', err);
			setSaveStatus('');
		} else {
			toast(err.message || 'Save failed.', true);
			setSaveStatus('');
		}
		btn.disabled = false;
		btn.textContent = 'Save';
	}
}

// ── Events ─────────────────────────────────────────────────────────────────

function bindEvents() {
	document.getElementById('save-btn').addEventListener('click', () => save({ auto: false }));

	// Char counts + dirty tracking + autosave
	['f-name', 'f-bio', 'f-system-prompt'].forEach((id) => {
		const el = document.getElementById(id);
		if (!el) return;
		el.addEventListener('input', updateCharCounts);
		el.addEventListener('input', scheduleSave);
	});

	// Sentiment bias label
	document.getElementById('f-sentiment-bias').addEventListener('input', (e) => {
		document.getElementById('bias-value').textContent = Number(e.target.value).toFixed(2);
		scheduleSave();
	});

	// Add catchphrase
	document.getElementById('add-catchphrase-btn').addEventListener('click', () => {
		const count = document.querySelectorAll('#catchphrase-list .catchphrase-row').length;
		if (count < 5) addCatchphraseRow();
	});

	// Do-not-say chip input: Enter or comma adds chip
	document.getElementById('dns-input').addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			const word = e.target.value.trim().replace(/,$/, '');
			if (word && !_doNotSay.includes(word)) {
				_doNotSay.push(word);
				rebuildChipDom();
				scheduleSave();
			}
			e.target.value = '';
		} else if (e.key === 'Backspace' && !e.target.value && _doNotSay.length) {
			_doNotSay.pop();
			rebuildChipDom();
			scheduleSave();
		}
	});

	// Reset prompt to template
	document.getElementById('reset-prompt-btn').addEventListener('click', () => {
		const existing = agent?.meta?.persona;
		if (existing?.systemPrompt) {
			document.getElementById('f-system-prompt').value = existing.systemPrompt;
			updateCharCounts();
			markDirty();
			toast('Reset to last saved prompt.');
		} else {
			toast('No saved prompt to reset to.', false);
		}
	});
}

// ── Utilities ──────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
	const res = await fetch(path, {
		...opts,
		credentials: 'include',
		headers: {
			...(opts.body ? { 'content-type': 'application/json' } : {}),
			...opts.headers,
		},
	});
	const data = res.headers.get('content-type')?.includes('application/json')
		? await res.json()
		: await res.json().catch(() => null);
	if (!res.ok) {
		const msg = data?.error_description || data?.error || res.statusText;
		throw new Error(msg);
	}
	return data;
}

let _toastTimer = null;
function toast(msg, isError = false) {
	const el = document.getElementById('toast');
	el.textContent = msg;
	el.className = 'toast show' + (isError ? ' err' : '');
	clearTimeout(_toastTimer);
	_toastTimer = setTimeout(() => {
		el.className = 'toast';
	}, 3200);
}

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// ── Boot ───────────────────────────────────────────────────────────────────

main().catch((err) => {
	document.getElementById('loading-screen').textContent = `Error: ${err.message}`;
});
