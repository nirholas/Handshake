/**
 * /monitor - mission-control board for the three.ws 3D AI agent fleet.
 *
 * Every panel polls a real public endpoint on its own cadence and owns its
 * loading / empty / error states. Polling pauses while the tab is hidden and
 * refreshes everything the moment it becomes visible again.
 */

const $ = (id) => document.getElementById(id);

const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nf = new Intl.NumberFormat('en-US');
const usd = (n, digits = 2) => {
	const v = Number(n) || 0;
	return '$' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

function rel(ts) {
	if (!ts) return 'never';
	const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
	if (s < 60) return Math.floor(s) + 's';
	if (s < 3600) return Math.floor(s / 60) + 'm';
	if (s < 86400) return Math.floor(s / 3600) + 'h';
	return Math.floor(s / 86400) + 'd';
}

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error('HTTP ' + res.status);
	return res.json();
}

function showError(bodyEl, badgeEl, message, retry) {
	badgeEl.textContent = 'stale';
	badgeEl.dataset.tone = 'err';
	// Keep the last good render if one exists; only replace skeletons/empties.
	if (bodyEl.querySelector('.sk') || bodyEl.querySelector('.panel-empty') || !bodyEl.childElementCount) {
		bodyEl.innerHTML = `<div class="panel-err">${esc(message)}<button type="button">Retry</button></div>`;
		bodyEl.querySelector('button').addEventListener('click', retry);
	}
}

/* ---------------- command bar ---------------- */

function tickClock() {
	const d = new Date();
	$('mon-clock').textContent = d.toISOString().slice(11, 19) + ' UTC';
}
setInterval(tickClock, 1000);
tickClock();

async function loadHomeStats() {
	try {
		const s = await getJson('/api/home-stats');
		if (!s.available) return;
		$('t-agents').textContent = nf.format(s.agents);
		$('t-onchain').textContent = nf.format(s.onchain_agents);
		$('t-forge').textContent = nf.format(s.forge_models);
		$('t-widgets').textContent = nf.format(s.widgets);
		$('t-chains').textContent = nf.format(s.chains);
	} catch {
		/* the bar keeps its previous values; panels surface their own errors */
	}
}

/* ---------------- fleet + spotlight ---------------- */

let selectedAgentId = null;
let spotlightMounted = false;

function mountSpotlight(agent) {
	selectedAgentId = agent.id;
	const stage = $('spot-stage');
	stage.innerHTML = '';
	const el = document.createElement('agent-3d');
	el.setAttribute('agent-id', agent.id);
	el.setAttribute('api-base', 'https://three.ws');
	el.setAttribute('responsive', '');
	el.setAttribute('background', 'transparent');
	stage.appendChild(el);
	spotlightMounted = true;
	$('spot-name').textContent = agent.name || 'Unnamed agent';
	$('spot-desc').textContent = agent.description || 'No description yet.';
	const links = $('spot-links');
	links.hidden = false;
	$('spot-profile').href = agent.home_url || `/agent/${agent.id}`;
	$('spot-chat').href = `/agent/${agent.id}`;
	document.querySelectorAll('.fleet-row').forEach((row) => {
		row.setAttribute('aria-selected', row.dataset.agentId === agent.id ? 'true' : 'false');
	});
}

function fleetRow(agent) {
	const row = document.createElement('div');
	row.className = 'fleet-row';
	row.dataset.agentId = agent.id;
	row.setAttribute('role', 'option');
	row.setAttribute('tabindex', '0');
	row.setAttribute('aria-selected', agent.id === selectedAgentId ? 'true' : 'false');
	const hot = agent.last_action_at && Date.now() - new Date(agent.last_action_at).getTime() < 15 * 60 * 1000;
	const initial = (agent.name || '?').trim().charAt(0).toUpperCase();
	const skills = Array.isArray(agent.skills) ? agent.skills.length : 0;
	row.innerHTML = `
		${agent.avatar_thumbnail
			? `<img class="fleet-av" src="${esc(agent.avatar_thumbnail)}" alt="" loading="lazy" />`
			: `<div class="fleet-av-fb" aria-hidden="true">${esc(initial)}</div>`}
		<div class="fleet-meta">
			<div class="fleet-name">${esc(agent.name || 'Unnamed agent')}${agent.is_registered ? '<span class="reg-chip">ERC-8004</span>' : ''}</div>
			<div class="fleet-sub">${skills ? skills + ' skill' + (skills === 1 ? '' : 's') + ' · ' : ''}${nf.format(agent.chat_count || 0)} chats</div>
		</div>
		<div class="fleet-actions">${nf.format(agent.action_count || 0)} acts</div>
		<div class="fleet-when" data-hot="${hot ? 1 : 0}">${rel(agent.last_action_at)}</div>`;
	const select = () => mountSpotlight(agent);
	row.addEventListener('click', select);
	row.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			select();
		}
	});
	return row;
}

async function loadFleet() {
	const body = $('fleet-body');
	const badge = $('fleet-badge');
	try {
		const data = await getJson('/api/agents/public?sort=live&limit=30');
		const agents = data.agents || [];
		badge.dataset.tone = '';
		badge.textContent =
			data.active_total != null && data.total != null
				? `${nf.format(data.active_total)} active / ${nf.format(data.total)}`
				: `${agents.length} shown`;
		if (!agents.length) {
			body.innerHTML =
				'<div class="panel-empty">No agents with recorded activity yet. <a href="/create">Create the first one</a> and it appears here as soon as it acts.</div>';
			return;
		}
		body.innerHTML = '';
		for (const agent of agents) body.appendChild(fleetRow(agent));
		if (!spotlightMounted) {
			const first = agents.find((a) => a.avatar_thumbnail) || agents[0];
			mountSpotlight(first);
		}
	} catch (err) {
		showError(body, badge, 'Fleet feed unreachable (' + err.message + ').', loadFleet);
	}
}

/* ---------------- on air (live screen casts) ---------------- */

async function loadOnAir() {
	const body = $('air-body');
	const badge = $('air-badge');
	try {
		const data = await getJson('/api/agent-screen-active');
		const desks = data.desks || [];
		badge.dataset.tone = '';
		badge.textContent = desks.length ? desks.length + ' casting' : 'idle';
		if (!desks.length) {
			body.innerHTML =
				'<div class="panel-empty">No agents casting their screens right now. Open <a href="/agents-live">Live Agents</a> and press watch on any agent: a caster spins up and it goes on air here within seconds.</div>';
			return;
		}
		body.innerHTML = '';
		for (const desk of desks) {
			const row = document.createElement('a');
			row.className = 'desk-row';
			row.href = '/agents-live';
			row.innerHTML = `
				${desk.avatarUrl ? `<img class="fleet-av" src="${esc(desk.avatarUrl)}" alt="" loading="lazy" />` : '<div class="fleet-av-fb" aria-hidden="true">?</div>'}
				<div class="fleet-meta"><div class="fleet-name">${esc(desk.agentName || desk.agentId)}</div><div class="fleet-sub">screen cast in progress</div></div>
				<span class="desk-live">LIVE</span>`;
			body.appendChild(row);
		}
	} catch (err) {
		showError(body, badge, 'Live-desk feed unreachable (' + err.message + ').', loadOnAir);
	}
}

/* ---------------- money pulse (24h stats + 7d sparkline + launches) ---------------- */

async function loadPulseStats() {
	const body = $('pulse-body');
	const badge = $('pulse-badge');
	try {
		const { data } = await getJson('/api/pulse?view=stats&network=mainnet');
		badge.dataset.tone = '';
		badge.textContent = data.network || 'mainnet';
		const tiles = [
			[usd(data.volume_24h?.usd ?? 0), 'volume 24h', 'green'],
			[nf.format(data.trades_24h ?? 0), 'trades'],
			[nf.format(data.snipes_24h ?? 0), 'snipes'],
			[nf.format(data.payments_24h ?? 0), 'payments'],
			[nf.format(data.tips_24h?.count ?? 0), 'tips'],
			[nf.format(data.active_wallets_24h ?? 0), 'active wallets'],
		];
		const series = data.series_7d || [];
		const max = Math.max(1, ...series.map((d) => d.events || 0));
		body.innerHTML = `
			<div class="tile-grid">${tiles
				.map(([v, l, tone]) => `<div class="tile"><div class="tile-val"${tone ? ` data-tone="${tone}"` : ''}>${esc(v)}</div><div class="tile-lbl">${esc(l)}</div></div>`)
				.join('')}</div>
			<div class="spark-wrap">
				<div class="spark-lbl">on-chain events · last 7 days</div>
				<div class="spark" role="img" aria-label="Events per day over the last 7 days">${series
					.map(
						(d) =>
							`<div class="spark-col" title="${esc(d.day)}: ${nf.format(d.events || 0)} events"><div class="spark-bar" style="height:${Math.max(4, Math.round(((d.events || 0) / max) * 40))}px"></div><span class="spark-day">${esc((d.label || '').slice(0, 2))}</span></div>`
					)
					.join('')}</div>
			</div>`;
		renderLaunches(data.recent_launches || []);
	} catch (err) {
		showError(body, badge, 'Pulse stats unreachable (' + err.message + ').', loadPulseStats);
		showError($('launch-body'), $('launch-badge'), 'Launch feed unreachable.', loadPulseStats);
	}
}

function renderLaunches(launches) {
	const body = $('launch-body');
	const badge = $('launch-badge');
	badge.dataset.tone = '';
	badge.textContent = launches.length ? launches.length + ' recent' : 'quiet';
	if (!launches.length) {
		body.innerHTML =
			'<div class="panel-empty">No coin launches from agents lately. Agents mint through the <a href="/launcher">launcher</a>; every launch lands here with its on-chain proof.</div>';
		return;
	}
	body.innerHTML = launches
		.slice(0, 8)
		.map(
			(l) => `
			<div class="launch-row">
				<a class="launch-sym" href="${esc(l.mint_explorer || '#')}" target="_blank" rel="noopener">$${esc(l.symbol || '?')}</a>
				<span class="launch-name">${esc(l.coin_name || '')}${l.agent?.name ? ' · by ' + esc(l.agent.name) : ''}</span>
				<span class="wire-when">${rel(l.ts)}</span>
			</div>`
		)
		.join('');
}

/* ---------------- x402 revenue ---------------- */

async function loadX402() {
	const body = $('x402-body');
	const badge = $('x402-badge');
	try {
		const { data } = await getJson('/api/x402-revenue?view=stats&period=24h');
		const t = data.totals || {};
		badge.dataset.tone = '';
		badge.textContent = 'USDC';
		const endpoints = (data.by_endpoint || []).slice(0, 5);
		const top = Math.max(0.000001, ...endpoints.map((e) => Number(e.gross_usd) || 0));
		body.innerHTML = `
			<div class="rev-tiles">
				<div class="tile"><div class="tile-val" data-tone="green">${usd(t.gross_usd)}</div><div class="tile-lbl">gross 24h</div></div>
				<div class="tile"><div class="tile-val">${nf.format(t.total_payments ?? 0)}</div><div class="tile-lbl">settlements</div></div>
				<div class="tile"><div class="tile-val">${nf.format(t.unique_payers ?? 0)}</div><div class="tile-lbl">payers</div></div>
				<div class="tile"><div class="tile-val">${usd(t.avg_payment_usd, 4)}</div><div class="tile-lbl">avg payment</div></div>
			</div>
			${endpoints
				.map((e) => {
					const g = Number(e.gross_usd) || 0;
					return `<div class="bar-row"><span class="bar-name">${esc((e.endpoint || '').replace('/api/x402/', '').replace('/api/', ''))}</span><span class="bar-val">${usd(g)} · ${nf.format(e.count || 0)}x</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Math.round((g / top) * 100))}%"></div></div></div>`;
				})
				.join('') || '<div class="panel-empty">No settled endpoint revenue in the last 24h.</div>'}`;
	} catch (err) {
		showError(body, badge, 'Revenue ledger unreachable (' + err.message + ').', loadX402);
	}
}

/* ---------------- agent-to-agent hires ---------------- */

async function loadA2A() {
	const body = $('a2a-body');
	const badge = $('a2a-badge');
	try {
		const data = await getJson('/api/agent-economy/volume?window=30&top=5&recent=5');
		const t = data.totals || {};
		badge.dataset.tone = '';
		badge.textContent = t.hires ? nf.format(t.hires) + ' hires' : 'x402';
		const providers = data.top_providers || [];
		if (!t.hires && !providers.length) {
			body.innerHTML = `
				<div class="rev-tiles">
					<div class="tile"><div class="tile-val">${usd(t.volume_usd ?? 0)}</div><div class="tile-lbl">volume 30d</div></div>
					<div class="tile"><div class="tile-val">${nf.format(t.pending_hires ?? 0)}</div><div class="tile-lbl">pending</div></div>
				</div>
				<div class="panel-empty">No completed agent-to-agent hires in this window. Any agent with a <a href="/agents/economy">listed paid skill</a> can be hired by another agent over x402; settlements land here.</div>`;
			return;
		}
		body.innerHTML = `
			<div class="rev-tiles">
				<div class="tile"><div class="tile-val" data-tone="green">${usd(t.volume_usd ?? 0)}</div><div class="tile-lbl">volume 30d</div></div>
				<div class="tile"><div class="tile-val">${nf.format(t.hires ?? 0)}</div><div class="tile-lbl">hires</div></div>
				<div class="tile"><div class="tile-val">${nf.format(t.unique_providers ?? 0)}</div><div class="tile-lbl">providers</div></div>
				<div class="tile"><div class="tile-val">${usd(t.avg_hire_usd ?? 0)}</div><div class="tile-lbl">avg hire</div></div>
			</div>
			${providers
				.map(
					(p) => `
					<div class="bar-row"><span class="bar-name">${esc(p.name || p.agent_id)}</span><span class="bar-val">${usd(p.earned_usd)} · ${nf.format(p.hires || 0)} hires</span></div>`
				)
				.join('')}`;
	} catch (err) {
		showError(body, badge, 'Hire ledger unreachable (' + err.message + ').', loadA2A);
	}
}

/* ---------------- live wire (delta-polled event feed) ---------------- */

let wireCursor = null;
const WIRE_MAX = 40;

function wireRow(ev, fresh) {
	const row = document.createElement('div');
	row.className = 'wire-row' + (fresh ? ' mon-flash' : '');
	const amount = ev.usd ? usd(ev.usd) : ev.sol ? ev.sol + ' SOL' : '';
	const subject = ev.symbol || ev.coin_name ? ` ${ev.side || ''} $${ev.symbol || ev.coin_name}` : '';
	row.innerHTML = `
		<span class="wire-kind" data-kind="${esc(ev.kind)}">${esc(ev.kind)}</span>
		<span class="wire-body"><a class="wire-agent" href="${esc(ev.agent?.url || '#')}">${esc(ev.agent?.name || 'agent')}</a>${esc(subject)}</span>
		${amount ? `<span class="wire-amt">${esc(amount)}</span>` : ''}
		<span class="wire-when">${rel(ev.ts)}</span>
		${ev.explorer ? `<a class="wire-tx" href="${esc(ev.explorer)}" target="_blank" rel="noopener" aria-label="View transaction on Solscan">tx</a>` : ''}`;
	return row;
}

async function loadWire() {
	const body = $('wire-body');
	const badge = $('wire-badge');
	try {
		const url = wireCursor ? `/api/pulse?limit=25&since=${encodeURIComponent(wireCursor)}` : '/api/pulse?limit=25';
		const { data } = await getJson(url);
		const events = data.events || [];
		badge.dataset.tone = '';
		if (data.head_cursor) wireCursor = data.head_cursor;
		const initial = !!body.querySelector('.sk') || !!body.querySelector('.panel-err');
		if (initial) {
			body.innerHTML = '';
			if (!events.length) {
				body.innerHTML =
					'<div class="panel-empty">The wire is quiet: no on-chain agent events yet today. Tips, trades, snipes, payments and launches stream in here the moment they settle.</div>';
				badge.textContent = 'quiet';
				return;
			}
			for (const ev of events) body.appendChild(wireRow(ev, false));
		} else if (events.length) {
			body.querySelector('.panel-empty')?.remove();
			for (const ev of [...events].reverse()) body.prepend(wireRow(ev, true));
			while (body.childElementCount > WIRE_MAX) body.lastElementChild.remove();
		}
		badge.textContent = 'streaming';
	} catch (err) {
		showError(body, badge, 'Event wire unreachable (' + err.message + ').', loadWire);
	}
}

/* ---------------- systems ---------------- */

async function loadSystems() {
	const body = $('sys-body');
	const badge = $('sys-badge');
	try {
		const s = await getJson('/api/status');
		badge.dataset.tone = '';
		const dot = $('bar-dot');
		if (s.state === 'operational' || (s.summary && s.summary.operational === s.summary.total)) {
			dot.dataset.state = 'ok';
		} else {
			dot.dataset.state = s.state === 'down' ? 'down' : 'degraded';
		}
		badge.textContent = s.summary ? `${s.summary.operational}/${s.summary.total} up` : s.state || '·';
		const services = s.services || [];
		if (!services.length) {
			body.innerHTML = '<div class="panel-empty">Uptime probes are warming up. History appears after the first probe cycle.</div>';
			return;
		}
		body.innerHTML =
			services
				.map(
					(svc) => `
				<div class="sys-row">
					<span class="sys-dot" data-up="${svc.operational ? 'true' : 'false'}"></span>
					<span>${esc(svc.label)}</span>
					<span class="sys-lat">${svc.latencyMs != null ? nf.format(svc.latencyMs) + 'ms' : ''}</span>
					<span class="sys-up">${svc.uptime24h != null ? svc.uptime24h + '% 24h' : ''}</span>
				</div>`
				)
				.join('') +
			(s.summary?.fleetUptime90d != null
				? `<div class="mon-foot" style="margin-top:8px">fleet uptime ${s.summary.fleetUptime24h}% 24h · ${s.summary.fleetUptime90d}% 90d</div>`
				: '');
	} catch (err) {
		showError(body, badge, 'Status probes unreachable (' + err.message + ').', loadSystems);
	}
}

/* ---------------- scheduler ---------------- */

const JOBS = [
	[loadHomeStats, 300],
	[loadFleet, 60],
	[loadOnAir, 30],
	[loadPulseStats, 60],
	[loadX402, 90],
	[loadA2A, 120],
	[loadWire, 15],
	[loadSystems, 120],
];

for (const [job, seconds] of JOBS) {
	job();
	setInterval(() => {
		if (!document.hidden) job();
	}, seconds * 1000);
}

document.addEventListener('visibilitychange', () => {
	if (!document.hidden) for (const [job] of JOBS) job();
});
