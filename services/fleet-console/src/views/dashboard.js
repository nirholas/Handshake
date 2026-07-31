/**
 * The fleet dashboard: header rollup, filter toolbar, and one card per
 * repository. Filtering and sorting run client side over data already in the
 * document, so there is no round trip and the page keeps working with the
 * network gone.
 */

import { esc, attr, ago, page, ring, sparkline } from './html.js';
import { PROBE_STATES } from '../probe.js';

const tone = (value, good, warn) => (value >= good ? 'good' : value >= warn ? 'warn' : 'bad');

function statTiles(summary, history) {
	const healthPct = summary.deployments.total ? Math.round((summary.deployments.healthy / summary.deployments.total) * 100) : null;
	const tiles = [
		{ k: 'Repositories', v: summary.repos.toLocaleString(), s: `${summary.stars.toLocaleString()} stars total` },
		{ k: 'Median health', v: summary.medianScore, s: `mean ${summary.averageScore}`, cls: tone(summary.medianScore, 75, 55) },
		{
			k: 'Live deployments',
			v: healthPct === null ? 'n/a' : `${healthPct}%`,
			s: `${summary.deployments.healthy} of ${summary.deployments.total} advertised URLs respond`,
			cls: healthPct === null ? '' : tone(healthPct, 90, 65)
		},
		{
			k: 'Dead README links',
			v: summary.links.dead.toLocaleString(),
			s: `${summary.links.total.toLocaleString()} checked`,
			cls: summary.links.dead === 0 ? 'good' : summary.links.dead <= 5 ? 'warn' : 'bad'
		},
		{
			k: 'Unpublished packages',
			v: summary.missingPackages.length.toLocaleString(),
			s: 'advertised in a README but absent from npm',
			cls: summary.missingPackages.length === 0 ? 'good' : 'bad'
		}
	];

	const trend = history.length
		? `<div class="stat"><div class="k">Median trend</div><div style="margin-top:6px">${sparkline(
				history.map((entry) => ({ at: entry.at, score: entry.medianScore })),
				{ width: 150, height: 40 }
			)}</div><div class="s">${history.length} scan${history.length === 1 ? '' : 's'} recorded</div></div>`
		: '';

	return `<section class="stats" aria-label="Fleet summary">
${tiles.map((tile) => `<div class="stat ${tile.cls || ''}"><div class="k">${esc(tile.k)}</div><div class="v">${esc(tile.v)}</div><div class="s">${esc(tile.s)}</div></div>`).join('\n')}
${trend}
</section>`;
}

function repoCard(repo) {
	const chips = [];
	const deployments = repo.deployments || [];
	if (deployments.length) {
		const bad = deployments.filter((entry) => entry.state !== 'live' && entry.state !== 'redirected');
		chips.push(
			bad.length === 0
				? `<span class="chip good">${deployments.length} deployment${deployments.length === 1 ? '' : 's'} live</span>`
				: `<span class="chip bad">${bad.length}/${deployments.length} deployment${deployments.length === 1 ? '' : 's'} down</span>`
		);
	}
	const missing = repo.packages?.missing || [];
	if (missing.length) chips.push(`<span class="chip bad">${missing.length} package${missing.length === 1 ? '' : 's'} unpublished</span>`);
	const dead = (repo.links || []).filter((entry) => entry.state !== 'live' && entry.state !== 'redirected' && entry.state !== 'auth_required' && entry.state !== 'rate_limited');
	if (dead.length) chips.push(`<span class="chip warn">${dead.length} dead link${dead.length === 1 ? '' : 's'}</span>`);
	if (!repo.license) chips.push('<span class="chip warn">No license</span>');
	if (!repo.hasDocsDir) chips.push('<span class="chip mute">No docs/</span>');
	if (repo.scanError) chips.push('<span class="chip bad">Scan error</span>');
	if (!chips.length) chips.push('<span class="chip good">All checks pass</span>');

	const searchBlob = [repo.name, repo.description, repo.language, ...(repo.topics || [])].join(' ').toLowerCase();
	const hasProblem = missing.length || dead.length || deployments.some((entry) => entry.state !== 'live' && entry.state !== 'redirected');

	return `<article class="card" data-name="${attr(repo.name.toLowerCase())}" data-search="${attr(searchBlob)}"
  data-score="${attr(repo.score ?? -1)}" data-stars="${attr(repo.stars)}" data-grade="${attr(repo.grade?.grade || '?')}"
  data-pushed="${attr(repo.pushedAt || '')}" data-problem="${hasProblem ? '1' : '0'}">
  ${ring(repo.score, repo.grade)}
  <div class="body">
    <h3><a href="/r/${encodeURIComponent(repo.name)}">${esc(repo.name)}</a></h3>
    <p>${esc(repo.description || 'No description set.')}</p>
    <div class="meta">
      <span>${repo.stars.toLocaleString()} stars</span>
      ${repo.language ? `<span>${esc(repo.language)}</span>` : ''}
      <span>updated ${esc(ago(repo.pushedAt))}</span>
    </div>
    <div class="chips">${chips.join('')}</div>
  </div>
</article>`;
}

function attentionPanel(snapshot) {
	const rows = [];
	for (const repo of snapshot.repos) {
		for (const deployment of repo.deployments || []) {
			if (deployment.state === 'live' || deployment.state === 'redirected') continue;
			rows.push({ repo: repo.name, kind: 'Deployment', state: deployment.state, detail: deployment.url, extra: deployment.detail || deployment.why });
		}
		for (const name of repo.packages?.missing || []) {
			rows.push({ repo: repo.name, kind: 'Package', state: 'not_found', detail: name, extra: 'advertised for install but never published' });
		}
	}
	if (!rows.length) {
		return `<section class="panel"><h2>Needs attention</h2><div class="pad" style="color:var(--muted)">
Nothing is broken. Every advertised deployment responds and every advertised package exists.</div></section>`;
	}
	rows.sort((a, b) => a.repo.localeCompare(b.repo));
	return `<section class="panel"><h2>Needs attention (${rows.length})</h2>
<div class="scroll"><table>
<thead><tr><th>Repository</th><th>What</th><th>State</th><th>Target</th><th>Detail</th></tr></thead>
<tbody>
${rows
	.map(
		(row) => `<tr>
  <td><a href="/r/${encodeURIComponent(row.repo)}">${esc(row.repo)}</a></td>
  <td>${esc(row.kind)}</td>
  <td><span class="chip ${PROBE_STATES[row.state]?.tone || 'bad'}">${esc(PROBE_STATES[row.state]?.label || row.state)}</span></td>
  <td class="mono">${esc(row.detail)}</td>
  <td style="color:var(--muted)">${esc(row.extra || '')}</td>
</tr>`
	)
	.join('\n')}
</tbody></table></div></section>`;
}

/** The scanning / never-scanned state. It polls for progress rather than spinning. */
export function scanningPage({ owner, progress, authenticated }) {
	const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
	const body = `<section class="hero">
  <h1>${progress.running ? 'Scanning the fleet' : 'No scan has run yet'}</h1>
  <p class="lede">Fleet Console enumerates every public repository owned by <strong>${esc(owner)}</strong>, extracts the URLs and
  packages each one advertises, and checks them against the live internet. The first pass takes a few minutes.</p>
</section>
${authenticated ? '' : '<div class="note"><strong>Running unauthenticated.</strong> GitHub allows 60 requests an hour without a token, which covers only a handful of repositories. Set <code>GITHUB_TOKEN</code> for a full scan.</div>'}
<section class="panel"><div class="pad">
  <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Scan progress"><span style="width:${pct}%"></span></div>
  <p class="mono" id="status" style="margin:12px 0 0; color:var(--muted)">
    ${progress.running ? `${progress.done} / ${progress.total || '?'} repositories${progress.current ? ` — currently ${esc(progress.current)}` : ''}` : progress.error ? `Last scan failed: ${esc(progress.error)}` : 'Idle. The scheduled scan will start shortly.'}
  </p>
</div></section>`;

	return page({
		title: `Fleet Console — ${owner}`,
		description: `Live health console for the open-source fleet owned by ${owner}.`,
		owner,
		body,
		script: `
(function(){
  var status=document.getElementById('status'), bar=document.querySelector('.bar span'), meter=document.querySelector('.bar');
  function tick(){
    fetch('/api/status',{headers:{accept:'application/json'}}).then(function(r){return r.json()}).then(function(d){
      if(d.hasSnapshot){ location.reload(); return; }
      var pct = d.progress.total ? Math.round(d.progress.done/d.progress.total*100) : 0;
      if(bar) bar.style.width = pct+'%';
      if(meter) meter.setAttribute('aria-valuenow', String(pct));
      if(status) status.textContent = d.progress.running
        ? d.progress.done+' / '+(d.progress.total||'?')+' repositories'+(d.progress.current?' — currently '+d.progress.current:'')
        : (d.progress.error ? 'Last scan failed: '+d.progress.error : 'Idle. The scheduled scan will start shortly.');
      setTimeout(tick, 3000);
    }).catch(function(){ setTimeout(tick, 8000); });
  }
  setTimeout(tick, 2000);
})();`
	});
}

/** The populated dashboard. */
export function dashboardPage({ snapshot, history }) {
	const { owner, summary } = snapshot;
	const body = `<section class="hero">
  <h1>${esc(owner)}: ${summary.repos} repositories, measured</h1>
  <p class="lede">Every URL below was requested from this server within the last scan. Every package name was resolved against the
  npm registry. A repository scores on the promises it makes, so a library with nothing deployed is never marked down for it.</p>
</section>
${statTiles(summary, history)}
${snapshot.partial ? `<div class="note"><strong>Partial scan.</strong> ${esc(snapshot.summary.repos)} of ${esc(snapshot.totalOwned)} repositories were reachable within the GitHub rate-limit budget${snapshot.rateLimit.resetAt ? `, which resets at ${esc(snapshot.rateLimit.resetAt)}` : ''}.</div>` : ''}
${attentionPanel(snapshot)}

<div class="toolbar" role="search">
  <div class="search">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input id="q" type="search" placeholder="Filter by name, description, language or topic  (press /)" aria-label="Filter repositories">
  </div>
  <select class="btn" id="sort" aria-label="Sort repositories">
    <option value="score">Sort: lowest score first</option>
    <option value="score-desc">Sort: highest score first</option>
    <option value="stars">Sort: most stars</option>
    <option value="pushed">Sort: recently updated</option>
    <option value="name">Sort: name</option>
  </select>
  <button class="btn" id="problems" type="button" aria-pressed="false">Only problems</button>
  <span class="mono" id="count" style="color:var(--muted)"></span>
</div>

<section class="grid" id="grid" aria-label="Repositories">
${snapshot.repos.map(repoCard).join('\n')}
</section>
<div class="empty hidden" id="none"><h2>No repository matches that filter</h2><p>Try a shorter query, or clear the "only problems" filter.</p></div>

<p style="margin-top:26px;color:var(--muted);font-size:12.5px">
Scanned ${esc(ago(snapshot.generatedAt))} in ${(snapshot.durationMs / 1000).toFixed(1)}s.
${snapshot.authenticated ? '' : 'Running unauthenticated against the GitHub API. '}
<a href="/api/fleet">Download the full JSON</a>.</p>`;

	return page({
		title: `Fleet Console — ${owner}`,
		description: `Live health of ${summary.repos} open-source repositories owned by ${owner}: deployment probes, link rot, and npm publish verification.`,
		owner,
		body,
		script: `
(function(){
  var grid=document.getElementById('grid'), q=document.getElementById('q'),
      sort=document.getElementById('sort'), only=document.getElementById('problems'),
      none=document.getElementById('none'), count=document.getElementById('count');
  var cards=[].slice.call(grid.children);
  var onlyProblems=false;

  function apply(){
    var term=(q.value||'').trim().toLowerCase(), shown=0;
    cards.forEach(function(card){
      var ok = (!term || card.dataset.search.indexOf(term)>-1) && (!onlyProblems || card.dataset.problem==='1');
      card.classList.toggle('hidden', !ok);
      if(ok) shown++;
    });
    none.classList.toggle('hidden', shown>0);
    count.textContent = shown+' of '+cards.length+' shown';
  }

  function order(){
    var mode=sort.value;
    var sorted=cards.slice().sort(function(a,b){
      if(mode==='stars') return (+b.dataset.stars)-(+a.dataset.stars);
      if(mode==='name') return a.dataset.name.localeCompare(b.dataset.name);
      if(mode==='pushed') return (b.dataset.pushed||'').localeCompare(a.dataset.pushed||'');
      var av=+a.dataset.score, bv=+b.dataset.score;
      if(mode==='score-desc') return bv-av || (+b.dataset.stars)-(+a.dataset.stars);
      return av-bv || (+b.dataset.stars)-(+a.dataset.stars);
    });
    sorted.forEach(function(card){ grid.appendChild(card); });
  }

  q.addEventListener('input', apply);
  sort.addEventListener('change', function(){ order(); apply(); });
  only.addEventListener('click', function(){
    onlyProblems=!onlyProblems;
    only.setAttribute('aria-pressed', String(onlyProblems));
    apply();
  });
  document.addEventListener('keydown', function(event){
    if(event.key==='/' && document.activeElement!==q){ event.preventDefault(); q.focus(); q.select(); }
    if(event.key==='Escape' && document.activeElement===q){ q.value=''; apply(); q.blur(); }
  });
  order(); apply();
})();`
	});
}
