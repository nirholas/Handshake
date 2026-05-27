/**
 * Memory Seed Module
 * ------------------
 * Reusable identity synthesis + memory management UI that can be mounted
 * into any page. Handles connector fetching, Claude synthesis, and saving
 * memories to agents via the real API.
 *
 * Usage:
 *   import { mountMemorySeed } from './memory-seed.js';
 *   mountMemorySeed(document.getElementById('container'), { agentId: '...' });
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
	({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function uuid() {
	return crypto.randomUUID ? crypto.randomUUID()
		: Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function relTime(ts) {
	const d = Date.now() - ts;
	if (d < 60000) return 'just now';
	if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
	if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
	return Math.floor(d / 86400000) + 'd ago';
}

function renderMdBasic(md) {
	if (!md) return '';
	return md.split('\n').map(line => {
		const h = line.match(/^(#{1,3})\s+(.+)/);
		if (h) return `<h${h[1].length + 1}>${inl(h[2])}</h${h[1].length + 1}>`;
		const li = line.match(/^[-*]\s+(.+)/);
		if (li) return `<li>${inl(li[1])}</li>`;
		if (!line.trim()) return '';
		return `<p>${inl(line)}</p>`;
	}).join('\n');
}

function inl(s) {
	return esc(s)
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>')
		.replace(/`([^`]+)`/g, '<code>$1</code>');
}

// ── Connector fetching ───────────────────────────────────────────────────────

export async function fetchConnector(name, handle) {
	const r = await fetch(`/api/seed/${name}?handle=${encodeURIComponent(handle)}`, {
		credentials: 'include',
	});
	if (!r.ok) {
		const body = await r.json().catch(() => ({}));
		throw new Error(body.error_description || body.error || `HTTP ${r.status}`);
	}
	const data = await r.json();
	if (data.ok === false) throw new Error(data.reason || 'Connector not configured');
	return data;
}

export async function synthesizeMemorySeed(connectors) {
	const payload = {};
	for (const [name, data] of Object.entries(connectors)) {
		if (data) payload[name] = data;
	}
	if (!Object.keys(payload).length) throw new Error('No connector data');

	const r = await fetch('/api/seed/synthesize', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ connectors: payload }),
	});
	const body = await r.json();
	if (!r.ok || body.ok === false) {
		throw new Error(body.error_description || body.error || 'Synthesis failed');
	}
	return body;
}

export async function saveMemoryToAgent(agentId, content, opts = {}) {
	const entry = {
		id: uuid(),
		type: opts.type || 'user',
		content,
		tags: opts.tags || ['identity', 'seed'],
		salience: opts.salience ?? 0.9,
		context: opts.context || {
			source: 'memory_seed_synthesis',
			synthesized_at: new Date().toISOString(),
		},
	};
	const r = await fetch('/api/agent-memory', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ agentId, entry }),
	});
	if (!r.ok) {
		const body = await r.json().catch(() => ({}));
		throw new Error(body.error_description || body.error || `HTTP ${r.status}`);
	}
	return await r.json();
}

export async function loadAgentMemories(agentId, opts = {}) {
	const params = new URLSearchParams({ agentId, limit: String(opts.limit || 500) });
	if (opts.type) params.set('type', opts.type);
	const r = await fetch(`/api/agent-memory?${params}`, { credentials: 'include' });
	if (!r.ok) return [];
	const data = await r.json();
	return data.entries || [];
}

export async function deleteAgentMemory(agentId, memoryId) {
	await fetch(`/api/agent-memory/${memoryId}?agentId=${encodeURIComponent(agentId)}`, {
		method: 'DELETE',
		credentials: 'include',
	});
}

export async function addAgentMemory(agentId, entry) {
	const payload = {
		id: uuid(),
		type: entry.type || 'project',
		content: entry.content,
		tags: entry.tags || [],
		salience: entry.salience ?? 0.5,
	};
	const r = await fetch('/api/agent-memory', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ agentId, entry: payload }),
	});
	if (!r.ok) throw new Error('Failed to save memory');
	return await r.json();
}

export async function loadUserAgents() {
	const r = await fetch('/api/agents', { credentials: 'include' });
	if (!r.ok) return [];
	const data = await r.json();
	return data.agents || [];
}

// ── Mountable seed widget ────────────────────────────────────────────────────

export function mountSeedWidget(host, opts = {}) {
	const { agentId, compact = false, onSaved } = opts;

	const state = {
		agentId: agentId || '',
		connectors: { github: null, x: null, farcaster: null },
		seedMarkdown: '',
	};

	host.innerHTML = `
		<div class="msw" data-compact="${compact}">
			<div class="msw-conns">
				${['github', 'x', 'farcaster'].map(n => `
					<div class="msw-conn" data-name="${n}">
						<div class="msw-conn-head">
							<span class="msw-conn-icon">${n === 'github' ? 'GH' : n === 'x' ? 'X' : 'FC'}</span>
							<span class="msw-conn-label">${n === 'github' ? 'GitHub' : n === 'x' ? 'X' : 'Farcaster'}</span>
							<span class="msw-conn-dot" data-dot="${n}"></span>
						</div>
						<div class="msw-conn-row">
							<input type="text" data-input="${n}" placeholder="${n === 'farcaster' ? 'username or fid' : 'handle'}" autocomplete="off" spellcheck="false" />
							<button class="msw-btn msw-btn-sm" data-fetch="${n}">Fetch</button>
						</div>
					</div>
				`).join('')}
			</div>
			<button class="msw-btn msw-btn-full" data-fetch-all>Fetch all & synthesize</button>
			<div class="msw-data" data-data hidden></div>
			<div class="msw-synth" data-synth hidden>
				<div class="msw-synth-output" data-output></div>
				<div class="msw-synth-meta" data-meta></div>
				<div class="msw-btn-row">
					<button class="msw-btn msw-btn-sm" data-copy>Copy</button>
					<button class="msw-btn msw-btn-sm" data-save ${!state.agentId ? 'disabled' : ''}>Save to agent</button>
					<span class="msw-notice" data-notice></span>
				</div>
			</div>
		</div>
	`;

	function q(sel) { return host.querySelector(sel); }
	function qAll(sel) { return host.querySelectorAll(sel); }

	async function doFetch(name) {
		const input = q(`[data-input="${name}"]`);
		const handle = (input.value || '').trim();
		if (!handle) return;

		const btn = q(`[data-fetch="${name}"]`);
		const dot = q(`[data-dot="${name}"]`);
		btn.disabled = true;
		btn.textContent = '…';
		dot.className = 'msw-conn-dot loading';

		try {
			state.connectors[name] = await fetchConnector(name, handle);
			dot.className = 'msw-conn-dot ok';
			q(`[data-name="${name}"]`).classList.add('ok');
		} catch {
			state.connectors[name] = null;
			dot.className = 'msw-conn-dot err';
		} finally {
			btn.disabled = false;
			btn.textContent = 'Fetch';
		}
	}

	async function doFetchAllAndSynthesize() {
		const btn = q('[data-fetch-all]');
		btn.disabled = true;
		btn.textContent = 'Fetching…';

		const names = ['github', 'x', 'farcaster'];
		const fetches = names
			.filter(n => (q(`[data-input="${n}"]`).value || '').trim())
			.map(n => doFetch(n));
		await Promise.allSettled(fetches);

		const hasData = Object.values(state.connectors).some(v => v);
		if (!hasData) {
			btn.disabled = false;
			btn.textContent = 'Fetch all & synthesize';
			return;
		}

		btn.textContent = 'Synthesizing…';
		renderData();

		try {
			const result = await synthesizeMemorySeed(state.connectors);
			state.seedMarkdown = result.memory_seed || '';
			const synthEl = q('[data-synth]');
			synthEl.hidden = false;
			q('[data-output]').innerHTML = renderMdBasic(state.seedMarkdown);
			q('[data-meta]').innerHTML = `Sources: <b>${result.sources_used.join(' + ')}</b> · <b>${result.tokens_used}</b> tokens`;
		} catch (err) {
			const synthEl = q('[data-synth]');
			synthEl.hidden = false;
			q('[data-output]').innerHTML = `<span style="color:#ff5a5a">${esc(err.message)}</span>`;
		} finally {
			btn.disabled = false;
			btn.textContent = 'Fetch all & synthesize';
		}
	}

	function renderData() {
		const container = q('[data-data]');
		const panels = [];

		const gh = state.connectors.github;
		if (gh) {
			panels.push(`<div class="msw-panel">
				<div class="msw-panel-head">
					${gh.avatar_url ? `<img class="msw-panel-av" src="${esc(gh.avatar_url)}" alt="" referrerpolicy="no-referrer"/>` : ''}
					<div><div class="msw-panel-name">${esc(gh.name || gh.handle)}</div><div class="msw-panel-sub">@${esc(gh.handle)}</div></div>
				</div>
				<div class="msw-panel-stats"><span><b>${gh.public_repos}</b> repos</span><span><b>${gh.followers}</b> followers</span></div>
			</div>`);
		}
		const x = state.connectors.x;
		if (x) {
			panels.push(`<div class="msw-panel">
				<div class="msw-panel-head">
					${x.avatar_url ? `<img class="msw-panel-av" src="${esc(x.avatar_url)}" alt="" referrerpolicy="no-referrer"/>` : ''}
					<div><div class="msw-panel-name">${esc(x.name || x.handle)}</div><div class="msw-panel-sub">@${esc(x.handle)}</div></div>
				</div>
				<div class="msw-panel-stats"><span><b>${x.follower_count}</b> followers</span><span><b>${x.tweet_count}</b> posts</span></div>
			</div>`);
		}
		const fc = state.connectors.farcaster;
		if (fc) {
			panels.push(`<div class="msw-panel">
				<div class="msw-panel-head">
					${fc.avatar_url ? `<img class="msw-panel-av" src="${esc(fc.avatar_url)}" alt="" referrerpolicy="no-referrer"/>` : ''}
					<div><div class="msw-panel-name">${esc(fc.display_name || fc.handle)}</div><div class="msw-panel-sub">@${esc(fc.handle)}</div></div>
				</div>
				<div class="msw-panel-stats"><span><b>${fc.follower_count}</b> followers</span></div>
			</div>`);
		}

		if (panels.length) {
			container.innerHTML = panels.join('');
			container.hidden = false;
		}
	}

	qAll('[data-fetch]').forEach(btn => {
		btn.addEventListener('click', () => doFetch(btn.dataset.fetch));
	});

	qAll('[data-input]').forEach(input => {
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				doFetch(input.dataset.input);
			}
		});
	});

	q('[data-fetch-all]').addEventListener('click', doFetchAllAndSynthesize);

	q('[data-copy]')?.addEventListener('click', async () => {
		if (!state.seedMarkdown) return;
		await navigator.clipboard.writeText(state.seedMarkdown);
		const btn = q('[data-copy]');
		btn.textContent = 'Copied';
		setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
	});

	q('[data-save]')?.addEventListener('click', async () => {
		if (!state.seedMarkdown || !state.agentId) return;
		const btn = q('[data-save]');
		const notice = q('[data-notice]');
		btn.disabled = true;
		btn.textContent = 'Saving…';
		notice.className = 'msw-notice';
		notice.textContent = '';

		try {
			await saveMemoryToAgent(state.agentId, state.seedMarkdown);
			notice.className = 'msw-notice ok';
			notice.textContent = 'Saved to agent.';
			onSaved?.();
		} catch (err) {
			notice.className = 'msw-notice err';
			notice.textContent = err.message;
		} finally {
			btn.disabled = false;
			btn.textContent = 'Save to agent';
		}
	});

	return {
		setAgentId(id) {
			state.agentId = id;
			const saveBtn = q('[data-save]');
			if (saveBtn) saveBtn.disabled = !state.seedMarkdown || !id;
		},
		getState() { return { ...state }; },
	};
}

// ── Mountable memory browser ─────────────────────────────────────────────────

export function mountMemoryBrowser(host, opts = {}) {
	const { agentId } = opts;

	const state = {
		agentId: agentId || '',
		memories: [],
		filter: { type: '', search: '' },
		showForm: false,
	};

	host.innerHTML = `
		<div class="mmb">
			<div class="mmb-form" hidden data-form>
				<div class="mmb-form-row">
					<select data-form-type>
						<option value="user">User</option>
						<option value="feedback">Feedback</option>
						<option value="project" selected>Project</option>
						<option value="reference">Reference</option>
					</select>
					<input type="text" data-form-tags placeholder="Tags (comma-separated)" style="flex:1" />
				</div>
				<textarea data-form-content placeholder="Memory content…"></textarea>
				<div class="mmb-btn-row">
					<button class="msw-btn msw-btn-sm" data-form-save>Save memory</button>
					<button class="msw-btn msw-btn-sm msw-btn-ghost" data-form-cancel>Cancel</button>
				</div>
			</div>
			<div class="mmb-bar">
				<div class="mmb-pills" data-pills>
					<button class="mmb-pill active" data-type="">All</button>
					<button class="mmb-pill" data-type="user">User</button>
					<button class="mmb-pill" data-type="feedback">Feedback</button>
					<button class="mmb-pill" data-type="project">Project</button>
					<button class="mmb-pill" data-type="reference">Reference</button>
				</div>
				<input class="mmb-search" data-search type="text" placeholder="Search…" />
				<button class="msw-btn msw-btn-sm msw-btn-ghost" data-add-btn>+ Add</button>
			</div>
			<div class="mmb-stats" data-stats></div>
			<div class="mmb-grid" data-grid></div>
		</div>
	`;

	function q(sel) { return host.querySelector(sel); }

	async function load() {
		if (!state.agentId) { render([]); return; }
		state.memories = await loadAgentMemories(state.agentId);
		render(state.memories);
	}

	function render(memories) {
		const filtered = memories.filter(m => {
			if (state.filter.type && m.type !== state.filter.type) return false;
			if (state.filter.search) {
				const q = state.filter.search.toLowerCase();
				return (m.content || '').toLowerCase().includes(q) ||
					(m.tags || []).some(t => t.toLowerCase().includes(q));
			}
			return true;
		});

		const counts = { user: 0, feedback: 0, project: 0, reference: 0, total: memories.length };
		memories.forEach(m => { if (counts[m.type] !== undefined) counts[m.type]++; });
		q('[data-stats]').innerHTML = `<span><b>${counts.total}</b> total</span> <span><b>${counts.user}</b> user</span> <span><b>${counts.feedback}</b> feedback</span> <span><b>${counts.project}</b> project</span> <span><b>${counts.reference}</b> reference</span>`;

		if (!state.agentId) {
			q('[data-grid]').innerHTML = '<div class="mmb-empty"><h4>Select an agent</h4><p>Choose an agent to view its memories.</p></div>';
			return;
		}
		if (!filtered.length) {
			q('[data-grid]').innerHTML = `<div class="mmb-empty"><h4>No memories${state.filter.type || state.filter.search ? ' matching filter' : ''}</h4><p>${memories.length ? 'Try a different filter.' : 'Seed your agent or add memories manually.'}</p></div>`;
			return;
		}

		q('[data-grid]').innerHTML = filtered.map(m => `
			<div class="mmb-card" data-id="${esc(m.id)}">
				<div class="mmb-card-head">
					<span class="mmb-badge" data-t="${esc(m.type)}">${esc(m.type)}</span>
					<div class="mmb-sal"><div class="mmb-sal-bar"><div class="mmb-sal-fill" style="width:${Math.round((m.salience || 0) * 100)}%"></div></div>${(m.salience || 0).toFixed(2)}</div>
				</div>
				<div class="mmb-content">${esc(m.content)}</div>
				<div class="mmb-foot">
					${(m.tags || []).map(t => `<span class="mmb-tag">${esc(t)}</span>`).join('')}
					<span class="mmb-date">${relTime(m.createdAt || m.created_at || Date.now())}</span>
					<button class="mmb-del" data-del="${esc(m.id)}">Del</button>
				</div>
			</div>
		`).join('');
	}

	q('[data-pills]').addEventListener('click', e => {
		const pill = e.target.closest('[data-type]');
		if (!pill) return;
		state.filter.type = pill.dataset.type;
		host.querySelectorAll('.mmb-pill').forEach(p =>
			p.classList.toggle('active', p.dataset.type === state.filter.type));
		render(state.memories);
	});

	q('[data-search]').addEventListener('input', e => {
		state.filter.search = e.target.value;
		render(state.memories);
	});

	q('[data-add-btn]').addEventListener('click', () => {
		const form = q('[data-form]');
		form.hidden = !form.hidden;
	});

	q('[data-form-cancel]').addEventListener('click', () => {
		q('[data-form]').hidden = true;
	});

	q('[data-form-save]').addEventListener('click', async () => {
		if (!state.agentId) return;
		const content = q('[data-form-content]').value.trim();
		if (!content) return;

		q('[data-form-save]').disabled = true;
		try {
			await addAgentMemory(state.agentId, {
				type: q('[data-form-type]').value,
				content,
				tags: q('[data-form-tags]').value.split(',').map(t => t.trim()).filter(Boolean),
			});
			q('[data-form]').hidden = true;
			q('[data-form-content]').value = '';
			q('[data-form-tags]').value = '';
			await load();
		} catch {} finally {
			q('[data-form-save]').disabled = false;
		}
	});

	q('[data-grid]').addEventListener('click', async e => {
		const del = e.target.closest('[data-del]');
		if (del && state.agentId) {
			await deleteAgentMemory(state.agentId, del.dataset.del);
			state.memories = state.memories.filter(m => m.id !== del.dataset.del);
			render(state.memories);
		}
		const content = e.target.closest('.mmb-content');
		if (content) content.classList.toggle('expanded');
	});

	load();

	return {
		setAgentId(id) { state.agentId = id; load(); },
		refresh() { load(); },
	};
}
