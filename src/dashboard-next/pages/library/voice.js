// Library → Voice tab.
// Per-agent voice status (cloned ElevenLabs voice or browser fallback)
// with a TTS preview backed by /api/tts/eleven. The actual voice clone
// flow lives on /dashboard/voice — we link there from each row.

import { get, esc } from '../../api.js';

const ELEVEN_PREVIEW_MAX = 240;
const DEFAULT_PREVIEW = 'Hi, this is your agent speaking. Ready when you are.';

export async function renderVoice(host) {
	host.innerHTML = `
		<div class="voice-head">
			<div>
				<h2 class="dn-panel-title" style="font-size:17px;margin:0 0 4px">Agent voices</h2>
				<div class="dn-panel-sub" style="margin:0">Each agent has a voice clone (ElevenLabs) or browser TTS fallback. Preview below; clone or replace on the voice page.</div>
			</div>
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
				grid-template-columns: 1fr auto;
				gap:14px 18px;
				align-items:flex-start;
			}
			.voice-row1 { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
			.voice-name { font-size:15px; font-weight:600; color:var(--nxt-ink); }
			.voice-meta { font-size:11px; color:var(--nxt-ink-fade); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
			.voice-actions { display:flex; gap:8px; flex-wrap:wrap; align-self:center; }
			.voice-preview { grid-column:1/-1; display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
			.voice-preview input {
				flex:1; min-width:220px;
				background:#0a0a14; border:1px solid rgba(255,255,255,0.1); color:var(--nxt-ink);
				border-radius:8px; padding:8px 10px; font:inherit;
			}
			.voice-preview audio { height:32px; max-width:280px; }
			.voice-status { font-size:12px; color:var(--nxt-ink-fade); min-height:16px; flex-basis:100%; }
			.voice-status.err { color:#ff9ab1; }
		</style>
	`;

	const list = host.querySelector('#voice-list');

	let agents = [];
	try {
		const res = await get('/api/agents');
		agents = res?.agents || [];
	} catch (err) {
		list.innerHTML = `<div class="dn-empty"><h3>Couldn’t load agents</h3><p>${esc(err.message || 'Failed')}</p></div>`;
		return;
	}

	if (!agents.length) {
		list.innerHTML = `
			<div class="dn-empty">
				<h3>You don’t have any agents yet</h3>
				<p>Voices are scoped to an agent. Create one to start.</p>
				<div style="margin-top:12px"><a class="dn-btn primary" href="/create">Create an agent</a></div>
			</div>
		`;
		return;
	}

	let elevenEnabled = false;
	try {
		const v = await get('/api/tts/eleven/voices');
		elevenEnabled = !!v?.enabled;
	} catch {
		elevenEnabled = false;
	}

	for (const agent of agents) {
		list.appendChild(voiceCard(agent, { elevenEnabled }));
	}
}

function voiceCard(agent, { elevenEnabled }) {
	const wrap = document.createElement('div');
	wrap.className = 'voice-card';
	const voiceId  = agent.voice_id || null;
	const provider = agent.voice_provider || 'browser';
	const providerLabel = voiceId ? `${esc(provider)} · cloned` : `${esc(provider)} · default`;

	wrap.innerHTML = `
		<div>
			<div class="voice-row1">
				<span class="voice-name">${esc(agent.name || agent.id)}</span>
				<span class="dn-tag ${voiceId ? 'success' : ''}">${providerLabel}</span>
				${voiceId ? `<span class="voice-meta">${esc(voiceId)}</span>` : ''}
			</div>
		</div>
		<div class="voice-actions">
			<a class="dn-btn ghost" href="/dashboard/voice">${voiceId ? 'Manage' : 'Clone a voice'}</a>
		</div>
		<div class="voice-preview">
			<input type="text" maxlength="${ELEVEN_PREVIEW_MAX}" placeholder="Type sample text…" value="${esc(DEFAULT_PREVIEW)}" />
			<button class="dn-btn primary" data-action="preview" type="button" ${voiceId && elevenEnabled ? '' : 'disabled'}>Preview</button>
			<audio controls preload="none" hidden></audio>
			<span class="voice-status">${voiceId && elevenEnabled ? 'Click Preview to synthesize a sample.' : (elevenEnabled ? 'No cloned voice — clone one first to preview.' : 'ElevenLabs not configured on this server.')}</span>
		</div>
	`;

	const input   = wrap.querySelector('input');
	const btn     = wrap.querySelector('button[data-action="preview"]');
	const audioEl = wrap.querySelector('audio');
	const status  = wrap.querySelector('.voice-status');

	btn?.addEventListener('click', async () => {
		const text = input.value.trim();
		if (!text) { status.textContent = 'Type some text first.'; status.classList.add('err'); return; }
		btn.disabled = true;
		status.classList.remove('err');
		status.textContent = 'Synthesizing…';
		try {
			const res = await fetch('/api/tts/eleven', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ voiceId, text }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error_description || body.message || `HTTP ${res.status}`);
			}
			const blob = await res.blob();
			audioEl.src = URL.createObjectURL(blob);
			audioEl.hidden = false;
			audioEl.play().catch(() => {});
			status.textContent = 'Ready.';
		} catch (err) {
			status.classList.add('err');
			status.textContent = err.message || 'Preview failed.';
		} finally {
			btn.disabled = false;
		}
	});

	return wrap;
}
