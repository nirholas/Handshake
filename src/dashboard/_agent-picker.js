// Shared agent picker for /dashboard sub-pages.
// Reads ?agent=<id> from the URL or, if absent, fetches the user's agents
// and renders a dropdown. Calls onPick(agentId, agent) when ready.

export async function mountAgentPicker({ host, onPick, paramKey = 'agent' }) {
	const params = new URLSearchParams(location.search);
	let selected = params.get(paramKey);

	let agents = [];
	try {
		const r = await fetch('/api/agents', { credentials: 'include' });
		if (r.status === 401) {
			location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
			return;
		}
		if (r.ok) {
			const data = await r.json();
			agents = data.agents || [];
		}
	} catch {
		/* fall through with empty list */
	}

	if (!agents.length) {
		host.innerHTML =
			'<div style="padding:14px 16px;background:#1a1a24;border:1px solid #22222e;border-radius:10px;color:#aaa">' +
			'You have no agents yet. <a href="/dashboard/agents" style="color:#9a8cff">Create your first agent</a> to use this page.' +
			'</div>';
		return;
	}

	const pre = agents.find((a) => a.id === selected) || null;
	if (!pre && selected) selected = null;

	const select = document.createElement('select');
	select.style.cssText =
		'background:#14141c;color:#eee;border:1px solid #22222e;border-radius:8px;padding:8px 10px;font-size:14px;min-width:240px';

	if (!selected) {
		const opt = document.createElement('option');
		opt.value = '';
		opt.textContent = 'Pick an agent…';
		select.appendChild(opt);
	}
	for (const a of agents) {
		const opt = document.createElement('option');
		opt.value = a.id;
		opt.textContent = `${a.name || 'Agent'}  ·  ${a.id.slice(0, 8)}…`;
		if (a.id === selected) opt.selected = true;
		select.appendChild(opt);
	}

	const label = document.createElement('span');
	label.style.cssText = 'color:#888;font-size:13px;margin-right:8px';
	label.textContent = 'Agent:';

	host.innerHTML = '';
	host.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:18px;flex-wrap:wrap';
	host.appendChild(label);
	host.appendChild(select);

	select.addEventListener('change', () => {
		if (!select.value) return;
		const url = new URL(location.href);
		url.searchParams.set(paramKey, select.value);
		history.replaceState({}, '', url);
		onPick(select.value, agents.find((a) => a.id === select.value));
	});

	if (selected) onPick(selected, pre);
}
