// Dashboard · Watch — /dashboard-next/watch?agentId=<id>
//
// Full-page "remote desktop + webcam" view for a single agent.
// Requires ?agentId= in the URL. Falls back to a graceful error when the
// agent isn't found or the viewer isn't the owner (public watch of live
// agents is allowed — the stream itself is public, but the panel is most
// useful on your own agents dashboard).

import { mountWatchPanel } from '../../shared/agent-watch-panel.js';
import { mountShell as mountDashboardShell } from '../shell.js';

const params  = new URLSearchParams(location.search);
const agentId = params.get('agentId');

async function init() {
	const shell = await mountDashboardShell({ title: 'Watch', activeNav: 'agents' });
	const content = shell?.content || document.body;

	if (!agentId) {
		content.innerHTML = `
<div class="watch-error">
  No agent selected.<br>
  <a href="/dashboard-next/agents.html" style="color:inherit;text-decoration:underline">
    Go to your agents →
  </a>
</div>`;
		return;
	}

	// Fetch agent meta so we can show the header.
	let agent = null;
	try {
		const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { credentials: 'include' });
		if (r.ok) agent = (await r.json())?.agent || null;
	} catch { /* non-critical */ }

	if (!agent) {
		content.innerHTML = `<div class="watch-error">Agent not found or access denied.</div>`;
		return;
	}

	const avatarImg = agent.avatar_image_url || agent.avatar_url || '';
	const backHref  = `/agents/${encodeURIComponent(agentId)}`;

	content.innerHTML = `
<div class="watch-header">
  ${avatarImg
		? `<img loading="lazy" decoding="async" class="watch-header-avatar" src="${avatarImg}" alt="${agent.name || 'Agent'}">`
		: `<div class="watch-header-avatar"></div>`}
  <div>
    <div class="watch-header-name">${agent.name || 'Agent'}</div>
    <div class="watch-header-sub">Live screen · ${agentId.slice(0, 8)}…</div>
  </div>
  <a class="watch-header-back" href="${backHref}">← Agent profile</a>
</div>
<div id="watch-mount"></div>`;

	const mount = document.getElementById('watch-mount');
	const avatarUrl = agent.avatar_glb_url || agent.avatar_model_url || agent.base_model_url || '';

	await mountWatchPanel({
		agentId,
		agentName: agent.name || 'Agent',
		avatarUrl,
		isOwner: !!agent.isOwner,
		container: mount,
	});
}

init().catch((err) => {
	console.error('[watch] init error', err);
	document.body.innerHTML += `<div class="watch-error">Failed to load watch view.</div>`;
});
