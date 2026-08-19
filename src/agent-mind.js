// Standalone Mind Palace route: /agents/:id/mind.
//
// Resolves the agent from the URL, wires the header, and mounts the same
// mountMindPalace() surface the editor's Mind tab uses. The Palace itself owns
// all loading/empty/error states; this entry only handles route resolution and
// the page chrome.

import { apiFetch } from './api.js';
import { setActiveAgent } from './agents/active-agent.js';
import { mountMindPalace } from './mind-palace.js';

const root = document.getElementById('mind-root');
const boot = document.getElementById('mind-boot');
const titleEl = document.getElementById('mind-title');
const backEl = document.getElementById('mind-back');

function agentIdFromPath() {
	// /agents/:id/mind  (also tolerate a trailing slash or ?id= override)
	const m = location.pathname.match(/^\/agents?\/([^/]+)\/mind\/?$/);
	if (m) return decodeURIComponent(m[1]);
	const q = new URLSearchParams(location.search).get('id') || new URLSearchParams(location.search).get('agentId');
	return q || null;
}

async function resolveAgent(id) {
	try {
		const r = await apiFetch(`/api/agents/${encodeURIComponent(id)}`, { credentials: 'include', allowAnonymous: true });
		if (!r.ok) return null;
		const j = await r.json().catch(() => ({}));
		return j.agent || null;
	} catch {
		return null;
	}
}

function showError(msg) {
	if (boot) {
		boot.innerHTML = `<div style="max-width:420px;text-align:center;line-height:1.5">${msg}</div>`;
		boot.hidden = false;
	}
}

async function init() {
	const id = agentIdFromPath();
	if (!id) {
		showError(`No agent specified. Open this page from your agent's editor, or pick one from <a style="color:#9ad0ff" href="/agents">your agents ↗</a>.`);
		return;
	}
	const agent = await resolveAgent(id);
	if (!agent) {
		showError(`We couldn't find this agent, or it isn't yours to explore. <a style="color:#9ad0ff" href="/agents">See your agents ↗</a>`);
		return;
	}
	const name = agent.name || 'Your agent';
	titleEl.textContent = `${name} · Mind Palace`;
	document.title = `${name}'s Mind — three.ws`;
	if (backEl) backEl.href = `/agents/${agent.id}/edit`;
	// Make this the active agent so the site-wide companion + HUD follow it.
	setActiveAgent(agent.id).catch(() => {});

	if (boot) boot.remove();
	const controller = mountMindPalace(root, { agentId: agent.id, agent, embedded: false });
	// Clean teardown if the SPA ever navigates away without a full reload.
	window.addEventListener('pagehide', () => controller.destroy(), { once: true });
}

init();
