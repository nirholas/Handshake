// Library → Voice tab.
// Per-agent voice picker. Lists voices from the server's ElevenLabs
// library (/api/tts/eleven/voices), shows the currently assigned voice
// for each agent, lets the user swap voices (PUT /api/agents/:id/voice)
// and previews any voice with custom text via POST /api/tts/eleven.
// Cloning a fresh voice from a recording lives on /dashboard/voice.

import { get, put, esc } from '../../api.js';

const PREVIEW_MAX = 240;
const DEFAULT_PREVIEW = 'Hi, this is your agent speaking. Ready when you are.';
const BROWSER_OPTION_VALUE = '__browser__';

export async function renderVoice(host) {
	host.innerHTML = `
		<div class="voice-head">
			<div>
				<h2 class="dn-panel-title" style="font-size:17px;margin:0 0 4px">Agent voices</h2>
				<div class="dn-panel-sub" style="margin:0">Pick from the ElevenLabs library, preview against your own text, or clone a fresh voice from a recording.</div>
			</div>
			<a class="dn-btn ghost" href="/dashboard/voice">Clone a new voice →</a>
		</div>

		<div id="voice-list"></div>

		<style>
			.voice-head { display:flex; align-items:flex-end; justify-content:space-between; gap:14px; margin-bottom:14px; flex-wrap:wrap; }
			.voice-card {
				border:1px solid rgba(255,255,255,0.08);
				background:rgba(255,255,255,0.02);
				border-radius:12px;
				padding:16px;
				margin-bottom:10px;
				display:grid;
				grid-template-columns:1fr;
				gap:12px;
			}
			.voice-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
			.voice-name { font-size:15px; font-weight:600; color:var(--nxt-ink); }
			.voice-meta { font-size:11px; color:var(--nxt-ink-fade); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
			.voice-picker { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
			.voice-picker label { font-size:12px; color:var(--nxt-ink-dim); }
			.voice-picker select {
				min-width:240px;
				background:#0a0a14; border:1px solid rgba(255,255,255,0.1); color:var(--nxt-ink);
				border-radius:8px; padding:8px 10px; font:inherit;
			}
			.voice-preview { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
			.voice-preview input {
				flex:1; min-width:220px;
				background:#0a0a14; border:1px solid rgba(255,255,255,0.1); color:var(--nxt-ink);
				border-radius:8px; padding:8px 10px; font:inherit;
			}
			.voice-preview audio { height:32px; max-width:280px; }
			.voice-status { font-size:12px; color:var(--nxt-ink-fade); min-height:16px; flex-basis:100%; }
			.voice-status.err { color:#969ba3; }
			.voice-status.ok  { color:#dddfe4; }
		</style>
	`;

	const list = host.querySelector('#voice-list');

	let agents = [];
	let library = null;
	const [agentsRes, voicesRes] = await Promise.allSettled([
		get('/api/agents'),
		get('/api/tts/eleven/voices'),
	]);

	if (agentsRes.status === 'rejected') {
		list.innerHTML = `<div class="dn-empty"><h3>Couldn't load agents</h3><p>${esc(friendly(agentsRes.reason))}</p></div>`;
		return;
	}
	agents = agentsRes.value?.agents || [];

	if (voicesRes.status === 'fulfilled') {
		library = voicesRes.value || { enabled: false, voices: [] };
	} else {
		library = { enabled: false, voices: [] };
	}

	if (!agents.length) {
		list.innerHTML = `
			<div class="dn-empty">
				<h3>You don't have any agents yet</h3>
				<p>Voices are scoped to an agent. Create one to start.</p>
				<div style="margin-top:12px"><a class="dn-btn primary" href="/create">Create an agent</a></div>
			</div>
		`;
		return;
	}

	if (!library.enabled) {
		const banner = document.createElement('div');
		banner.className = 'dn-empty';
		banner.style.cssText = 'margin-bottom:14px;padding:14px 16px;text-align:left';
		banner.innerHTML = `
			<h3 style="margin:0 0 4px;font-size:14px">ElevenLabs is not configured</h3>
			<p style="margin:0;font-size:12px">Voice picking and previews are disabled until <code>ELEVENLABS_API_KEY</code> is set on the server. Agents will fall back to browser TTS.</p>
		`;
		list.appendChild(banner);
	}

	for (const agent of agents) list.appendChild(voiceCard(agent, library));
}

function voiceCard(agent, library) {
	const wrap = document.createElement('div');
	wrap.className = 'voice-card';
	const selectId = `voice-sel-${agent.id}`;
	const currentVoiceId = agent.voice_id || null;
	const currentVoiceName = currentVoiceId
		? (library.voices.find((v) => v.voice_id === currentVoiceId)?.name || 'Custom clone')
		: 'Browser TTS';

	const options = [
		`<option value="${BROWSER_OPTION_VALUE}"${!currentVoiceId ? ' selected' : ''}>— Browser TTS (no clone) —</option>`,
		...(library.voices || []).map((v) => {
			const sel = v.voice_id === currentVoiceId ? ' selected' : '';
			const cat = v.category ? ` · ${esc(v.category)}` : '';
			return `<option value="${esc(v.voice_id)}"${sel}>${esc(v.name)}${cat}</option>`;
		}),
	];

	// Edge case: agent holds a cloned voice that isn't in the library list
	// (e.g., a personal clone that doesn't show up in the shared /voices
	// listing). Surface it so the user doesn't accidentally lose it.
	if (currentVoiceId && !library.voices.some((v) => v.voice_id === currentVoiceId)) {
		options.splice(1, 0,
			`<option value="${esc(currentVoiceId)}" selected>Current clone (${esc(currentVoiceId).slice(0, 8)}…)</option>`,
		);
	}

	wrap.innerHTML = `
		<div class="voice-row">
			<span class="voice-name">${esc(agent.name || agent.id)}</span>
			<span class="dn-tag ${currentVoiceId ? 'success' : ''}">${esc(currentVoiceName)}</span>
			${currentVoiceId ? `<span class="voice-meta">${esc(currentVoiceId)}</span>` : ''}
		</div>

		<div class="voice-picker">
			<label for="${selectId}">Voice</label>
			<select id="${selectId}" data-role="picker" ${library.enabled ? '' : 'disabled'}>
				${options.join('')}
			</select>
			<button class="dn-btn primary" data-role="save" type="button" ${library.enabled ? '' : 'disabled'}>Save</button>
		</div>

		<div class="voice-preview">
			<input type="text" maxlength="${PREVIEW_MAX}" placeholder="Type sample text…" value="${esc(DEFAULT_PREVIEW)}" data-role="preview-text" />
			<button class="dn-btn" data-role="preview-btn" type="button" ${library.enabled ? '' : 'disabled'}>Preview</button>
			<audio controls preload="none" hidden data-role="audio"></audio>
			<span class="voice-status" data-role="status">${library.enabled
				? (currentVoiceId ? 'Click Preview to synthesize a sample.' : 'Pick a voice above, then Preview to hear it.')
				: 'ElevenLabs not configured — previews unavailable.'}</span>
		</div>
	`;

	const sel       = wrap.querySelector('[data-role="picker"]');
	const saveBtn   = wrap.querySelector('[data-role="save"]');
	const previewBtn= wrap.querySelector('[data-role="preview-btn"]');
	const textInput = wrap.querySelector('[data-role="preview-text"]');
	const audioEl   = wrap.querySelector('[data-role="audio"]');
	const status    = wrap.querySelector('[data-role="status"]');
	const tagEl     = wrap.querySelector('.dn-tag');
	const metaEl    = wrap.querySelector('.voice-meta');
	const headRow   = wrap.querySelector('.voice-row');

	function readPick() {
		const v = sel.value;
		return v === BROWSER_OPTION_VALUE ? null : v;
	}

	function setStatus(text, kind) {
		status.textContent = text;
		status.classList.remove('err', 'ok');
		if (kind) status.classList.add(kind);
	}

	saveBtn.addEventListener('click', async () => {
		const pick = readPick();
		saveBtn.disabled = true;
		setStatus(pick ? 'Saving voice…' : 'Removing voice…');
		try {
			const result = await put(
				`/api/agents/${encodeURIComponent(agent.id)}/voice`,
				{ voice_id: pick },
			);
			const newId = result?.voice_id || null;
			agent.voice_id = newId;
			agent.voice_provider = result?.voice_provider || (newId ? 'elevenlabs' : 'browser');
			const newName = newId
				? (library.voices.find((v) => v.voice_id === newId)?.name || 'Custom clone')
				: 'Browser TTS';
			tagEl.textContent = newName;
			tagEl.classList.toggle('success', !!newId);
			if (metaEl) {
				metaEl.textContent = newId || '';
				metaEl.style.display = newId ? '' : 'none';
			} else if (newId) {
				const span = document.createElement('span');
				span.className = 'voice-meta';
				span.textContent = newId;
				headRow.appendChild(span);
			}
			setStatus('Saved.', 'ok');
		} catch (err) {
			setStatus(friendly(err), 'err');
		} finally {
			saveBtn.disabled = false;
		}
	});

	previewBtn.addEventListener('click', async () => {
		const text = textInput.value.trim();
		if (!text) { setStatus('Type some text first.', 'err'); return; }
		const pick = readPick();
		if (!pick) { setStatus('Pick a voice above first.', 'err'); return; }
		previewBtn.disabled = true;
		setStatus('Synthesizing…');
		try {
			const res = await fetch('/api/tts/eleven', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ voiceId: pick, text }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error_description || body.message || `HTTP ${res.status}`);
			}
			const blob = await res.blob();
			audioEl.src = URL.createObjectURL(blob);
			audioEl.hidden = false;
			audioEl.play().catch(() => {});
			setStatus('Ready.', 'ok');
		} catch (err) {
			setStatus(friendly(err), 'err');
		} finally {
			previewBtn.disabled = false;
		}
	});

	return wrap;
}

function friendly(err) {
	if (!err) return 'Something went wrong.';
	const status = err.status || 0;
	const msg = err.message || String(err);
	if (status === 401 || /unauthorized|sign in|bearer/i.test(msg)) return 'Your session expired — refresh the page.';
	if (status === 403 || /forbidden/i.test(msg))                   return "You don't have permission for that.";
	if (status === 429 || /rate.?limit/i.test(msg))                 return 'Slow down — try again in a moment.';
	if (status === 503 || /not.?configured/i.test(msg))             return 'ElevenLabs is not configured on this server.';
	return msg.replace(/^HTTP\s+\d+\s*/i, '') || 'Unknown error.';
}
