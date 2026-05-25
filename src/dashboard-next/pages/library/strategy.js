// Library → Strategy tab.
// One editable JSON strategy per agent (POST /api/agent-strategy?id=…).
// Debounced auto-save on input (800 ms). Save indicator chip.

import { get, post, esc, relTime, ApiError } from '../../api.js';

function friendly(err) {
	if (!err) return 'Something went wrong.';
	const status = err.status || 0;
	const msg = err.message || String(err);
	if (status === 401 || /unauthorized|sign in|bearer/i.test(msg)) return 'Your session expired — refresh the page.';
	if (status === 403 || /forbidden/i.test(msg))                   return "You don't have permission for that.";
	if (status === 429 || /rate.?limit/i.test(msg))                 return 'Slow down — try again in a moment.';
	return msg.replace(/^HTTP\s+\d+\s*/i, '') || 'Save failed.';
}

export async function renderStrategy(host) {
	host.innerHTML = `
		<div class="strat-head">
			<div>
				<h2 class="dn-panel-title" style="font-size:17px;margin:0 0 4px">Strategy</h2>
				<div class="dn-panel-sub" style="margin:0">Freeform JSON your agent reads at runtime. Skills retrieve it via <code>getStrategy()</code>.</div>
			</div>
			<label class="strat-picker">
				<span>Agent</span>
				<select id="strat-agent"></select>
			</label>
		</div>

		<div id="strat-body"></div>

		<style>
			.strat-head { display:flex; align-items:flex-end; justify-content:space-between; gap:14px; margin-bottom:14px; flex-wrap:wrap; }
			.strat-picker { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--nxt-ink-dim); }
			.strat-picker select {
				background:#0a0a14; border:1px solid rgba(255,255,255,0.1); color:var(--nxt-ink);
				border-radius:8px; padding:8px 10px; font:inherit; min-width:220px;
			}
			.strat-panel { border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); border-radius:12px; padding:14px; }
			.strat-textarea {
				width:100%; min-height:380px;
				background:#0a0a14; border:1px solid rgba(255,255,255,0.12);
				color:var(--nxt-ink); border-radius:10px; padding:12px 14px;
				font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
				resize:vertical;
			}
			.strat-textarea:focus { outline:none; border-color: rgba(154,124,255,0.55); }
			.strat-bar { display:flex; align-items:center; gap:10px; margin-top:10px; flex-wrap:wrap; font-size:12px; color:var(--nxt-ink-fade); }
			.strat-chip { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; font-size:11px; border:1px solid rgba(255,255,255,0.10); }
			.strat-chip.dirty { color:#fcd34d; border-color:rgba(252,211,77,0.4); }
			.strat-chip.saving { color:#93c5fd; border-color:rgba(59,130,246,0.4); }
			.strat-chip.saved { color:#86efac; border-color:rgba(34,197,94,0.4); }
			.strat-chip.error { color:#fca5a5; border-color:rgba(239,68,68,0.5); }
		</style>
	`;

	const body = host.querySelector('#strat-body');
	const sel  = host.querySelector('#strat-agent');

	let agents = [];
	try {
		const res = await get('/api/agents');
		agents = res?.agents || [];
	} catch (err) {
		body.innerHTML = `<div class="dn-empty"><h3>Couldn't load agents</h3><p>${esc(friendly(err))}</p></div>`;
		return;
	}

	if (!agents.length) {
		body.innerHTML = `
			<div class="dn-empty">
				<h3>You don’t have any agents yet</h3>
				<p>Strategy is scoped to one agent. Create one to get started.</p>
				<div style="margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
					<a class="dn-btn primary" href="/create">Create an agent</a>
					<a class="dn-btn ghost"   href="/dashboard-next/account">Account</a>
				</div>
			</div>
		`;
		return;
	}

	sel.innerHTML = agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`).join('');

	const stored = sessionStorage.getItem('lib-strat-agent');
	if (stored && agents.some((a) => a.id === stored)) sel.value = stored;

	sel.addEventListener('change', () => {
		sessionStorage.setItem('lib-strat-agent', sel.value);
		loadAgent(sel.value);
	});

	await loadAgent(sel.value);

	async function loadAgent(agentId) {
		body.innerHTML = `<div class="dn-skeleton" style="height:380px;border-radius:10px"></div>`;
		let initial = '';
		let loadErr = null;
		try {
			const res = await get(`/api/agent-strategy?id=${encodeURIComponent(agentId)}`);
			const value = res?.data?.strategy;
			initial = value == null ? '' : JSON.stringify(value, null, 2);
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) {
				initial = '';
			} else {
				loadErr = err;
			}
		}

		if (loadErr) {
			body.innerHTML = `<div class="dn-empty"><h3>Couldn't load strategy</h3><p>${esc(friendly(loadErr))}</p></div>`;
			return;
		}

		const placeholder = '{\n  "objective": "describe what this agent is optimizing for",\n  "constraints": []\n}';
		body.innerHTML = `
			<div class="strat-panel">
				<textarea class="strat-textarea" id="strat-text" spellcheck="false" placeholder=${JSON.stringify(placeholder)}>${esc(initial)}</textarea>
				<div class="strat-bar">
					<span class="strat-chip" id="strat-chip">idle</span>
					<span id="strat-msg"></span>
					<span style="margin-left:auto">Strategy auto-saves 800 ms after you stop typing. Empty <code>{}</code> is valid.</span>
				</div>
			</div>
		`;

		const ta   = body.querySelector('#strat-text');
		const chip = body.querySelector('#strat-chip');
		const msg  = body.querySelector('#strat-msg');

		let timer = null;
		let inflight = 0;
		let lastSavedAt = null;

		function setChip(state, label) {
			chip.className = 'strat-chip ' + state;
			chip.textContent = label;
		}

		ta.addEventListener('input', () => {
			setChip('dirty', 'unsaved');
			msg.textContent = '';
			clearTimeout(timer);
			timer = setTimeout(save, 800);
		});

		async function save() {
			const text = ta.value.trim();
			let parsed;
			if (!text) {
				parsed = {};
			} else {
				try { parsed = JSON.parse(text); }
				catch (err) { setChip('error', 'invalid JSON'); msg.textContent = err.message; return; }
			}
			const seq = ++inflight;
			setChip('saving', 'saving…');
			try {
				await post(`/api/agent-strategy?id=${encodeURIComponent(agentId)}`, { strategy: parsed });
				if (seq !== inflight) return;
				lastSavedAt = new Date().toISOString();
				setChip('saved', `saved · ${relTime(lastSavedAt)}`);
			} catch (err) {
				if (seq !== inflight) return;
				setChip('error', 'save failed');
				msg.textContent = friendly(err);
			}
		}

		setInterval(() => {
			if (lastSavedAt && chip.classList.contains('saved')) {
				chip.textContent = `saved · ${relTime(lastSavedAt)}`;
			}
		}, 15_000);
	}
}
