// Library → Memory tab.
// Lists every memory entry across all of the user's agents and lets
// them add a note attached to a chosen agent.

import { get, post, esc, relTime } from '../../api.js';

export async function renderMemory(host) {
	host.innerHTML = `
		<div class="mem-head">
			<div>
				<h2 class="dn-panel-title" style="font-size:17px;margin:0 0 4px">Persistent agent memory</h2>
				<div class="dn-panel-sub" style="margin:0">Notes your agents have saved from past conversations — or add your own.</div>
			</div>
			<button class="dn-btn primary" id="mem-add-toggle" type="button">+ Add a note</button>
		</div>

		<div id="mem-add" class="mem-add" hidden>
			<form class="mem-add-form" id="mem-add-form">
				<label class="mem-field">
					<span>Attach to agent</span>
					<select id="mem-add-agent" required></select>
				</label>
				<label class="mem-field">
					<span>Type</span>
					<select id="mem-add-type">
						<option value="user">user</option>
						<option value="feedback">feedback</option>
						<option value="project" selected>project</option>
						<option value="reference">reference</option>
					</select>
				</label>
				<label class="mem-field mem-field-full">
					<span>Content</span>
					<textarea id="mem-add-content" maxlength="10000" rows="4" placeholder="What should this agent remember?"></textarea>
				</label>
				<div class="mem-add-actions">
					<span id="mem-add-status" class="mem-add-status"></span>
					<button type="button" class="dn-btn ghost" id="mem-add-cancel">Cancel</button>
					<button type="button" class="dn-btn primary" id="mem-add-submit">Save</button>
				</div>
			</form>
		</div>

		<div id="mem-list"></div>

		<style>
			.mem-head { display:flex; align-items:flex-end; justify-content:space-between; gap:14px; margin-bottom:14px; flex-wrap:wrap; }
			.mem-add { border:1px solid rgba(255,255,255,0.10); background:rgba(255,255,255,0.03); border-radius:12px; padding:14px; margin-bottom:14px; }
			.mem-add-form { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
			.mem-field { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--nxt-ink-dim); }
			.mem-field-full { grid-column:1/-1; }
			.mem-field select, .mem-field textarea {
				background:#0a0a14; border:1px solid rgba(255,255,255,0.1); color:var(--nxt-ink);
				border-radius:8px; padding:8px 10px; font:inherit; resize:vertical;
			}
			.mem-add-actions { grid-column:1/-1; display:flex; justify-content:flex-end; gap:8px; align-items:center; }
			.mem-add-status { font-size:12px; color:var(--nxt-ink-fade); margin-right:auto; }

			.mem-list { display:flex; flex-direction:column; gap:8px; }
			.mem-card { border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); border-radius:10px; padding:12px 14px; }
			.mem-card-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; font-size:12px; color:var(--nxt-ink-fade); }
			.mem-card-body { font-size:13px; color:var(--nxt-ink); white-space:pre-wrap; word-break:break-word; line-height:1.5; }
			.mem-card-body.collapsed { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
			.mem-card-expand { background:none; border:none; color:var(--nxt-accent, #9a7cff); cursor:pointer; padding:4px 0 0; font-size:12px; font:inherit; }
			.mem-type-user      { color:#93c5fd; border-color:rgba(59,130,246,0.4) !important; }
			.mem-type-feedback  { color:#d8b4fe; border-color:rgba(168,85,247,0.4) !important; }
			.mem-type-project   { color:#86efac; border-color:rgba(34,197,94,0.4) !important;  }
			.mem-type-reference { color:#fdba74; border-color:rgba(251,146,60,0.4) !important; }
		</style>
	`;

	const listEl = host.querySelector('#mem-list');

	let agents = [];
	try {
		const res = await get('/api/agents');
		agents = res?.agents || [];
	} catch (err) {
		listEl.innerHTML = `<div class="dn-empty"><h3>Couldn’t load agents</h3><p>${esc(err.message || 'Failed')}</p></div>`;
		return;
	}

	if (!agents.length) {
		listEl.innerHTML = `
			<div class="dn-empty">
				<h3>You don’t have any agents yet</h3>
				<p>Memories are scoped to an agent. Create one to start saving notes.</p>
				<div style="margin-top:12px"><a class="dn-btn primary" href="/create">Create an agent</a></div>
			</div>
		`;
		host.querySelector('#mem-add-toggle').disabled = true;
		return;
	}

	const agentSel = host.querySelector('#mem-add-agent');
	agentSel.innerHTML = agents
		.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`)
		.join('');

	const agentNameById = new Map(agents.map((a) => [a.id, a.name || a.id]));

	const all = [];
	const errors = [];
	await Promise.all(
		agents.map(async (a) => {
			try {
				const r = await get(`/api/agent-memory?agentId=${encodeURIComponent(a.id)}&limit=500`);
				for (const e of (r?.entries || [])) all.push({ ...e, _agentId: a.id });
			} catch (err) {
				errors.push({ agent: a.name || a.id, message: err.message || String(err) });
			}
		}),
	);

	all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

	renderList();

	function renderList() {
		const html = [];
		if (errors.length) {
			html.push(`<div class="dn-empty" style="margin-bottom:12px"><h3>Some agents’ memories couldn’t be loaded</h3><p>${errors.map((e) => `${esc(e.agent)}: ${esc(e.message)}`).join(' · ')}</p></div>`);
		}
		if (!all.length) {
			html.push(`
				<div class="dn-empty">
					<h3>No memories yet</h3>
					<p>Your agents will save notes here from their conversations — or you can add one yourself.</p>
				</div>
			`);
		} else {
			html.push('<div class="mem-list">');
			for (const e of all) {
				const t = e.type || 'project';
				html.push(`
					<div class="mem-card">
						<div class="mem-card-head">
							<span class="dn-tag mem-type-${esc(t)}">${esc(t)}</span>
							<span><strong>${esc(agentNameById.get(e._agentId) || 'agent')}</strong></span>
							<span>· ${esc(relTime(e.createdAt || Date.now()))}</span>
							${typeof e.salience === 'number' ? `<span>· salience ${e.salience.toFixed(2)}</span>` : ''}
						</div>
						<div class="mem-card-body collapsed" data-mem-body>${esc(e.content || '')}</div>
						${e.content && e.content.length > 240 ? '<button class="mem-card-expand" type="button">Show more</button>' : ''}
					</div>
				`);
			}
			html.push('</div>');
		}
		listEl.innerHTML = html.join('');
		listEl.querySelectorAll('.mem-card-expand').forEach((btn) => {
			btn.addEventListener('click', () => {
				const body = btn.previousElementSibling;
				const collapsed = body.classList.toggle('collapsed');
				btn.textContent = collapsed ? 'Show more' : 'Show less';
			});
		});
	}

	const addPanel  = host.querySelector('#mem-add');
	const toggleBtn = host.querySelector('#mem-add-toggle');
	const cancelBtn = host.querySelector('#mem-add-cancel');
	const submitBtn = host.querySelector('#mem-add-submit');
	const statusEl  = host.querySelector('#mem-add-status');

	toggleBtn.addEventListener('click', () => {
		addPanel.hidden = !addPanel.hidden;
	});
	cancelBtn.addEventListener('click', () => { addPanel.hidden = true; });
	submitBtn.addEventListener('click', async () => {
		const agentId = agentSel.value;
		const type    = host.querySelector('#mem-add-type').value;
		const content = host.querySelector('#mem-add-content').value.trim();
		if (!agentId)  { statusEl.textContent = 'Pick an agent.';      return; }
		if (!content)  { statusEl.textContent = 'Write something.';     return; }
		submitBtn.disabled = true;
		statusEl.textContent = 'Saving…';
		try {
			const res = await post('/api/agent-memory', {
				agentId,
				entry: { type, content, salience: 0.6 },
			});
			const saved = res?.entry;
			if (saved) all.unshift({ ...saved, _agentId: agentId });
			renderList();
			statusEl.textContent = 'Saved.';
			host.querySelector('#mem-add-content').value = '';
			setTimeout(() => { statusEl.textContent = ''; addPanel.hidden = true; }, 600);
		} catch (err) {
			statusEl.textContent = err.message || 'Save failed.';
		} finally {
			submitBtn.disabled = false;
		}
	});
}
