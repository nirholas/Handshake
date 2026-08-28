// /brownout: the degradation registry, its proof receipts, and the reader's
// own request.
//
// The live panel is the part worth having: it reads the provenance headers off
// this page's OWN call to /api/brownout and tells the visitor how their request,
// a moment ago, was actually served. A claim about resilience is cheap; the
// same claim measured on the request you just made is not.

const TIER_COPY = {
	live: 'came off the wire during your request',
	cache: 'a cache hit inside its intended lifetime',
	stale: 'older than intended, because an upstream could not answer',
	fallback: 'a different provider or method answered',
};

const VERDICT_LABEL = {
	pass: 'proven',
	fail: 'failed',
	not_exercised: 'not exercised',
	unrun: 'not yet run',
};

/**
 * Parse the `x-brownout` summary and `x-brownout-trace` breakdown.
 * A missing header is a real state (nothing was recorded), not an error.
 */
function parseProvenance(headers) {
	const summary = headers.get('x-brownout') || '';
	const trace = headers.get('x-brownout-trace') || '';
	if (!summary) return null;
	const fields = {};
	for (const pair of summary.split(';')) {
		const [k, v] = pair.split('=');
		if (k) fields[k.trim()] = (v ?? '').trim();
	}
	const sources = trace
		? trace.split(',').map((entry) => {
				const parts = entry.split(';').map((p) => p.trim());
				return {
					name: parts[0] || '',
					outcome: (parts.find((p) => p.startsWith('o=')) || 'o=').slice(2),
					ms: Number((parts.find((p) => p.startsWith('t=')) || 't=0').slice(2)) || 0,
				};
			})
		: [];
	return {
		tier: fields.tier || null,
		degraded: fields.degraded === '1',
		ok: Number(fields.ok || 0),
		failed: Number(fields.failed || 0),
		ms: Number(fields.ms || 0),
		sources,
	};
}

const el = (tag, className, text) => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text != null) node.textContent = text;
	return node;
};

/** Whole seconds up to a minute, then minutes, then hours. Ages here span both. */
function humanAge(ms) {
	if (!Number.isFinite(ms) || ms < 0) return null;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.round(m / 60)}h`;
}

function renderLivePanel(prov) {
	const panel = document.getElementById('bo-live-panel');
	const tierEl = document.getElementById('bo-live-tier');
	const body = document.getElementById('bo-live-body');
	if (!panel || !prov) return;

	const tier = prov.tier || 'none';
	tierEl.dataset.tier = tier;
	tierEl.textContent = tier;

	const parts = [];
	parts.push(
		`The request that loaded this list touched ${prov.ok + prov.failed} source${prov.ok + prov.failed === 1 ? '' : 's'} ` +
			`in ${prov.ms}ms, and what you are reading ${TIER_COPY[tier] || 'was served from an unknown tier'}.`,
	);
	if (prov.failed > 0) {
		parts.push(
			`${prov.failed} of them did not answer, and you still got a page: that is the whole point, and it is why the header exists.`,
		);
	}
	body.textContent = parts.join(' ');

	if (prov.sources.length) {
		const trace = el('div', 'bo-trace');
		for (const s of prov.sources) trace.appendChild(traceRow(s));
		panel.appendChild(trace);
	}
	panel.hidden = false;
}

function traceRow(source) {
	const ok = source.outcome === 'ok' ? '1' : source.outcome === 'stale' ? 'stale' : '0';
	const row = el('div', 'bo-trace-row');
	row.dataset.ok = ok;
	row.appendChild(el('span', 'bo-trace-name', source.name));
	row.appendChild(el('span', 'bo-trace-out', source.outcome));
	row.appendChild(el('span', 'bo-trace-ms', `${source.ms}ms`));
	return row;
}

function renderStats(data) {
	const host = document.getElementById('bo-stats');
	if (!host) return;
	const stat = (value, label) => {
		const node = el('div', 'bo-stat');
		node.appendChild(el('b', null, String(value)));
		node.appendChild(el('span', null, label));
		return node;
	};
	host.replaceChildren();
	host.appendChild(stat(`${data.proven}/${data.total}`, 'fallbacks proven'));
	const failed = data.contracts.filter((c) => c.proof && c.proof.verdict !== 'pass').length;
	host.appendChild(stat(failed, failed === 1 ? 'contract not proven' : 'contracts not proven'));
	const refusals = data.contracts.reduce((n, c) => n + (c.proof?.failed_sources || 0), 0);
	host.appendChild(stat(refusals, 'upstream refusals survived'));
	if (data.last_proof_at) {
		const age = humanAge(Date.now() - Date.parse(data.last_proof_at));
		host.appendChild(stat(age ? `${age} ago` : 'unknown', 'last proof run'));
	}
}

function renderContract(contract) {
	const proof = contract.proof;
	const verdict = proof?.verdict || 'unrun';
	const card = el('article', 'bo-card');
	card.dataset.verdict = verdict;

	const head = el('div', 'bo-card-head');
	const titles = el('div');
	titles.appendChild(el('h3', null, contract.title));
	titles.appendChild(el('div', 'bo-endpoint', `${contract.endpoint}${contract.surface ? `  ·  ${contract.surface}` : ''}`));
	head.appendChild(titles);
	const badge = el('span', 'bo-verdict', VERDICT_LABEL[verdict] || verdict);
	badge.dataset.verdict = verdict;
	head.appendChild(badge);
	card.appendChild(head);

	const breaks = Object.entries(contract.breaks || {});
	if (breaks.length) {
		const line = el('p', 'bo-break');
		line.appendChild(document.createTextNode('We break '));
		breaks.forEach(([name, spec], i) => {
			if (i) line.appendChild(document.createTextNode(', '));
			line.appendChild(el('code', null, `${name} → ${spec}`));
		});
		if (proof) {
			line.appendChild(
				document.createTextNode(
					`, and the endpoint answered ${proof.status}${proof.tier ? ` from the ${proof.tier} tier` : ''}.`,
				),
			);
		} else {
			line.appendChild(document.createTextNode('. This image has not run the prover yet.'));
		}
		card.appendChild(line);
	}

	if (proof?.trace?.length) {
		const trace = el('div', 'bo-trace');
		for (const s of proof.trace) trace.appendChild(traceRow(s));
		card.appendChild(trace);
	}

	if (proof?.problems?.length) {
		const list = el('ul', 'bo-problems');
		for (const p of proof.problems) list.appendChild(el('li', null, p));
		card.appendChild(list);
	}

	if (contract.why) card.appendChild(el('p', 'bo-why', contract.why));
	return card;
}

function renderError(message) {
	const host = document.getElementById('bo-results');
	if (!host) return;
	host.replaceChildren();
	const card = el('article', 'bo-card');
	card.dataset.verdict = 'fail';
	card.appendChild(el('h3', null, 'The registry could not be loaded'));
	card.appendChild(el('p', 'bo-why', message));
	const links = el('div', 'bo-links');
	const retry = el('a', null, 'Try again');
	retry.href = '/brownout';
	links.appendChild(retry);
	const raw = el('a', null, 'Open the JSON directly');
	raw.href = '/api/brownout';
	links.appendChild(raw);
	card.appendChild(links);
	host.appendChild(card);
}

async function main() {
	const status = document.getElementById('bo-status');
	let res;
	try {
		res = await fetch('/api/brownout', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
	} catch (err) {
		if (status) status.textContent = 'The registry could not be reached.';
		renderError(`The request did not complete: ${err?.message || err}. The registry is static, so this is almost certainly a network problem at your end.`);
		return;
	}

	// Read the provenance of THIS request before anything else: it is the most
	// honest demonstration on the page, and it costs nothing.
	renderLivePanel(parseProvenance(res.headers));

	if (!res.ok) {
		if (status) status.textContent = 'The registry answered with an error.';
		renderError(`The registry endpoint answered ${res.status}.`);
		return;
	}

	const data = await res.json();
	renderStats(data);

	const host = document.getElementById('bo-results');
	host.replaceChildren();
	if (!data.contracts?.length) {
		host.appendChild(el('p', 'bo-why', 'No degradation contracts are declared yet.'));
		if (status) status.textContent = 'No contracts declared.';
		return;
	}
	const grid = el('div', 'bo-grid');
	for (const contract of data.contracts) grid.appendChild(renderContract(contract));
	host.appendChild(grid);
	if (status) status.textContent = `${data.contracts.length} degradation contracts listed.`;
}

main();
