// /feedback - the maintainer side of what visitors told the corner companion.
//
// The queue is grouped, not chronological, on purpose: twenty people hitting
// one broken button is one problem, and a flat list of twenty strings hides
// that. Each row is a cluster (api/_lib/feedback/store.js#listClusters) showing
// how many people hit it, how many distinct reporters, and the newest example.
//
// Everything on this page is a human decision. Accepting, fixing, or dismissing
// a cluster writes a status; nothing on this page or behind it edits the
// product. That boundary is the whole design (see docs/feedback.md).

const list = document.getElementById('list');
const statsEl = document.getElementById('stats');
const filters = document.querySelectorAll('.filters button');

let status = 'open';

function escape(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function band(severity) {
	if (severity >= 70) return 'high';
	if (severity >= 40) return 'mid';
	return 'low';
}

function ago(iso) {
	const ms = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(ms)) return '';
	const mins = Math.round(ms / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function renderStats(stats) {
	statsEl.hidden = false;
	statsEl.innerHTML = [
		['Open', stats.open],
		['Untriaged', stats.untriaged],
		['Last 24h', stats.today],
		['All time', stats.total],
	]
		.map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`)
		.join('');
}

function renderEmpty() {
	const copy =
		status === 'open'
			? {
					title: 'Nothing open',
					body: 'No unresolved reports. When a visitor tells the corner companion something is wrong, it lands here within a minute.',
				}
			: { title: 'Nothing here yet', body: `No reports with the status "${escape(status)}".` };
	list.innerHTML = `<div class="state"><h2>${copy.title}</h2><p>${copy.body}</p></div>`;
}

function clusterRow(c) {
	const severity = Number.isFinite(c.severity) ? c.severity : 0;
	const meta = [
		c.kind ? `<span class="tag">${escape(c.kind)}</span>` : '',
		c.subsystem ? `<span class="tag">${escape(c.subsystem)}</span>` : '',
		c.route ? `<code>${escape(c.route)}</code>` : '',
		c.build_sha ? `<code>${escape(c.build_sha)}</code>` : '',
		`<span>${ago(c.last_seen)}</span>`,
		// A cluster with a recorded session can be reproduced in one command, so
		// it is worth spotting from the collapsed row.
		c.traced ? `<span class="replay">replayable</span>` : '',
	]
		.filter(Boolean)
		.join('');
	const people = c.reporters === 1 ? '1 person' : `${c.reporters} people`;
	return `
		<details class="cluster" data-cluster="${escape(c.cluster_key)}">
			<summary>
				<span class="sev" data-band="${band(severity)}" title="Severity ${severity} of 100">${severity}</span>
				<span>
					<p class="sum">${escape(c.summary || 'No summary yet')}</p>
					<span class="meta">${meta}</span>
				</span>
				<span class="count"><b>${c.reports}</b>${people}</span>
			</summary>
			<div class="detail"><p class="repro">Loading reports...</p></div>
		</details>
	`;
}

function reportBlock(r) {
	const signals = [...(r.console_errors || []), ...(r.failed_requests || [])];
	const meta = [
		r.signed_in ? 'signed in' : 'anonymous',
		r.transport === 'voice' ? 'dictated' : 'typed',
		r.viewport ? escape(r.viewport) : '',
		r.locale ? escape(r.locale) : '',
		ago(r.created_at),
	]
		.filter(Boolean)
		.join(' &middot; ');
	return `
		<div class="report">
			<q>${escape(r.body)}</q>
			<span class="meta">${meta}</span>
			${signals.length ? `<ul class="signals">${signals.map((s) => `<li>${escape(s)}</li>`).join('')}</ul>` : ''}
		</div>
	`;
}

function confidenceBand(score) {
	if (score >= 80) return 'high';
	if (score >= 40) return 'mid';
	return 'low';
}

// The reproduction panel. This is the part of the queue a maintainer actually
// acts on: the session compiles into a Playwright spec that is red until the
// bug is fixed, so "reproduce it" stops being the expensive first hour of the
// work and "is it fixed" stops being a judgement call.
function reproBlock(report) {
	const score = report.replay_confidence ?? 0;
	const steps = report.trace_steps ?? 0;
	return `
		<div class="repro-card" data-report="${escape(report.id)}">
			<div class="repro-head">
				<span class="repro-badge" data-band="${confidenceBand(score)}">${score}</span>
				<div>
					<strong>Recorded session</strong>
					<span class="meta">${steps} step${steps === 1 ? '' : 's'} captured &middot; replay confidence ${score}/100</span>
				</div>
				<div class="repro-actions">
					<button type="button" class="repro-view">Show test</button>
					<button type="button" class="repro-copy">Copy test</button>
					<a class="repro-download" href="/api/feedback/repro?id=${encodeURIComponent(report.id)}" download>Download</a>
				</div>
			</div>
			<ol class="repro-steps"></ol>
			<pre class="repro-source" hidden><code></code></pre>
		</div>
	`;
}

async function wireRepro(holder, reportId) {
	const card = holder.querySelector('.repro-card');
	if (!card) return;
	const stepsEl = card.querySelector('.repro-steps');
	const sourceEl = card.querySelector('.repro-source');
	const codeEl = sourceEl.querySelector('code');
	const viewBtn = card.querySelector('.repro-view');
	const copyBtn = card.querySelector('.repro-copy');

	let compiled = null;
	async function load() {
		if (compiled) return compiled;
		const res = await fetch(`/api/feedback/repro?id=${encodeURIComponent(reportId)}&format=json`, {
			credentials: 'same-origin',
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data?.message || 'Could not compile a reproduction.');
		compiled = data;
		return compiled;
	}

	try {
		const data = await load();
		stepsEl.innerHTML = data.steps.map((line) => `<li>${escape(line)}</li>`).join('');
		codeEl.textContent = data.source;
	} catch (err) {
		stepsEl.innerHTML = `<li class="repro-error">${escape(err.message)}</li>`;
		viewBtn.disabled = true;
		copyBtn.disabled = true;
	}

	viewBtn.addEventListener('click', () => {
		const open = !sourceEl.hidden;
		sourceEl.hidden = open;
		viewBtn.textContent = open ? 'Show test' : 'Hide test';
	});

	copyBtn.addEventListener('click', async () => {
		try {
			const data = await load();
			await navigator.clipboard.writeText(data.source);
			copyBtn.textContent = 'Copied';
		} catch {
			// Clipboard access can be denied outright. Reveal the source instead so
			// the maintainer can still select it by hand.
			sourceEl.hidden = false;
			viewBtn.textContent = 'Hide test';
			copyBtn.textContent = 'Select it above';
		}
		setTimeout(() => {
			copyBtn.textContent = 'Copy test';
		}, 2200);
	});
}

async function loadDetail(details) {
	const clusterKey = details.dataset.cluster;
	const holder = details.querySelector('.detail');
	if (details.dataset.loaded === '1') return;
	details.dataset.loaded = '1';
	try {
		const res = await fetch(`/api/feedback?cluster=${encodeURIComponent(clusterKey)}`, { credentials: 'same-origin' });
		const data = await res.json();
		if (!res.ok) throw new Error(data?.message || 'Could not load the reports.');
		const repro = data.reports.find((r) => r.repro)?.repro;
		// The most replayable report in the cluster is the one worth compiling:
		// a spec is only as good as the selectors in the session it came from.
		const replayable = data.reports
			.filter((r) => r.trace)
			.sort((a, b) => (b.replay_confidence ?? 0) - (a.replay_confidence ?? 0))[0];
		holder.innerHTML = `
			${repro ? `<p class="repro"><strong>Repro guess:</strong> ${escape(repro)}</p>` : ''}
			${replayable ? reproBlock(replayable) : ''}
			${data.reports.map(reportBlock).join('')}
			<div class="actions">
				<button type="button" data-status="accepted">Accept as real</button>
				<button type="button" data-status="fixed">Mark fixed</button>
				<button type="button" data-status="dismissed">Dismiss</button>
			</div>
		`;
		for (const btn of holder.querySelectorAll('.actions button')) {
			btn.addEventListener('click', () => updateStatus(clusterKey, btn.dataset.status, holder));
		}
		if (replayable) wireRepro(holder, replayable.id);
	} catch (err) {
		details.dataset.loaded = '';
		holder.innerHTML = `<p class="repro">${escape(err.message)} <button type="button" class="retry">Retry</button></p>`;
		holder.querySelector('.retry').addEventListener('click', () => loadDetail(details));
	}
}

async function updateStatus(clusterKey, next, holder) {
	const actions = holder.querySelector('.actions');
	const previous = actions.innerHTML;
	actions.innerHTML = '<button type="button" disabled>Saving...</button>';
	try {
		const res = await fetch('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ cluster: clusterKey, status: next }),
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || 'Could not save that.');
		load();
	} catch (err) {
		actions.innerHTML = previous;
		for (const btn of actions.querySelectorAll('button')) {
			btn.addEventListener('click', () => updateStatus(clusterKey, btn.dataset.status, holder));
		}
		const warn = document.createElement('p');
		warn.className = 'repro';
		warn.textContent = err.message;
		actions.after(warn);
	}
}

async function load() {
	try {
		const res = await fetch(`/api/feedback?status=${encodeURIComponent(status)}`, { credentials: 'same-origin' });
		if (res.status === 401 || res.status === 403) {
			statsEl.hidden = true;
			list.innerHTML = `
				<div class="state">
					<h2>Admins only</h2>
					<p>This queue shows raw visitor reports, so it is limited to platform admins.
					<a href="/login?next=/feedback">Sign in</a> with an admin account to read it.</p>
				</div>`;
			return;
		}
		const data = await res.json();
		if (!res.ok) throw new Error(data?.message || 'Could not load the queue.');
		renderStats(data.stats);
		if (!data.clusters.length) return renderEmpty();
		list.innerHTML = data.clusters.map(clusterRow).join('');
		for (const details of list.querySelectorAll('.cluster')) {
			details.addEventListener('toggle', () => {
				if (details.open) loadDetail(details);
			});
		}
	} catch (err) {
		list.innerHTML = `
			<div class="state">
				<h2>Could not load the queue</h2>
				<p>${escape(err.message)}</p>
				<p><button type="button" class="retry">Try again</button></p>
			</div>`;
		list.querySelector('.retry').addEventListener('click', load);
	}
}

for (const btn of filters) {
	btn.addEventListener('click', () => {
		status = btn.dataset.status;
		for (const other of filters) other.setAttribute('aria-pressed', String(other === btn));
		list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
		load();
	});
}

load();
