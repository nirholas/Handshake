/**
 * Per-repository detail: the score with every check that produced it, the raw
 * probe table, the npm verification table, and the score trend.
 *
 * A score with no evidence is an opinion. Every row here carries the
 * measurement it came from, including latency and the final URL after
 * redirects, so a disputed result can be re-run by hand.
 */

import { esc, attr, ago, page, ring, sparkline } from './html.js';
import { PROBE_STATES } from '../probe.js';

const MARK = { pass: '&#10003;', warn: '!', fail: '&#10005;', skip: '&#8211;' };

const stateChip = (state) => `<span class="chip ${PROBE_STATES[state]?.tone || 'bad'}">${esc(PROBE_STATES[state]?.label || state)}</span>`;

function probeTable(rows, { emptyText, showWhy = false }) {
	if (!rows.length) return `<div class="pad" style="color:var(--muted)">${esc(emptyText)}</div>`;
	return `<div class="scroll"><table>
<thead><tr><th>URL</th><th>State</th><th>Status</th><th>Latency</th>${showWhy ? '<th>Why it is treated as a deployment</th>' : '<th>Detail</th>'}</tr></thead>
<tbody>
${rows
	.map(
		(row) => `<tr>
  <td class="mono"><a href="${attr(row.url)}" rel="noopener nofollow" target="_blank">${esc(row.url)}</a></td>
  <td>${stateChip(row.state)}</td>
  <td class="mono">${row.status === null ? 'n/a' : esc(row.status)}</td>
  <td class="mono">${esc(row.ms)} ms</td>
  <td style="color:var(--muted)">${esc(showWhy ? row.why || '' : row.detail || '')}</td>
</tr>`
	)
	.join('\n')}
</tbody></table></div>`;
}

function packageTable(packages) {
	const rows = packages?.checked || [];
	if (!rows.length) return '<div class="pad" style="color:var(--muted)">This repository advertises no npm package.</div>';
	return `<div class="scroll"><table>
<thead><tr><th>Package</th><th>Registry</th><th>Latest</th><th>Advertised in</th></tr></thead>
<tbody>
${rows
	.map(
		(row) => `<tr>
  <td class="mono">${esc(row.name)}</td>
  <td>${row.error ? `<span class="chip warn">Lookup failed</span>` : row.published ? (row.deprecated ? '<span class="chip warn">Deprecated</span>' : '<span class="chip good">Published</span>') : '<span class="chip bad">Never published</span>'}</td>
  <td class="mono">${esc(row.latest || '-')}</td>
  <td style="color:var(--muted)">${row.role === 'manifest' ? 'package.json' : 'README install line'}</td>
</tr>`
	)
	.join('\n')}
</tbody></table></div>`;
}

export function repoPage({ repo, owner, history }) {
	const checks = repo.checks || [];
	const passed = checks.filter((entry) => entry.status === 'pass').length;
	const graded = checks.filter((entry) => entry.status !== 'skip').length;

	const body = `<p style="margin:22px 0 0;font-size:13px"><a href="/">&larr; Back to the fleet</a></p>
<section class="hero" style="padding-top:14px">
  <div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">
    ${ring(repo.score, repo.grade)}
    <div style="min-width:260px;flex:1">
      <h1 style="margin-bottom:6px">${esc(repo.name)}</h1>
      <p class="lede">${esc(repo.description || 'No description set.')}</p>
      <div class="meta" style="margin-top:10px">
        <span>${repo.stars.toLocaleString()} stars</span>
        ${repo.language ? `<span>${esc(repo.language)}</span>` : ''}
        <span>${repo.license ? esc(repo.license) : 'no license'}</span>
        <span>updated ${esc(ago(repo.pushedAt))}</span>
        <span>${passed}/${graded} checks pass</span>
      </div>
      <div class="chips" style="margin-top:12px">
        <a class="btn" href="${attr(repo.htmlUrl)}" rel="noopener" target="_blank">Source on GitHub</a>
        ${(repo.deployments || []).filter((entry) => entry.state === 'live' || entry.state === 'redirected').slice(0, 2).map((entry) => `<a class="btn" href="${attr(entry.url)}" rel="noopener" target="_blank">Open live site</a>`).join('')}
        <a class="btn" href="/api/repo/${encodeURIComponent(repo.name)}">JSON</a>
        <a class="btn" href="/badge/${encodeURIComponent(repo.name)}.svg">Badge</a>
      </div>
    </div>
  </div>
</section>

${repo.scanError ? `<div class="note"><strong>This repository failed to scan.</strong> ${esc(repo.scanError)}</div>` : ''}

<section class="panel">
  <h2>Health checks</h2>
  ${checks
		.map(
			(check) => `<div class="check">
    <span class="mark ${esc(check.status)}" aria-hidden="true">${MARK[check.status] || '?'}</span>
    <div>
      <strong>${esc(check.title)} <span style="font-weight:450;color:var(--muted)">(weight ${esc(check.weight)}${check.status === 'skip' ? ', not counted' : ''})</span></strong>
      <div class="ev">${esc(check.evidence)}</div>
      ${check.fix && check.status !== 'pass' && check.status !== 'skip' ? `<div class="fix"><strong>Fix:</strong> ${esc(check.fix)}</div>` : ''}
    </div>
  </div>`
		)
		.join('\n')}
</section>

<section class="panel">
  <h2>Advertised deployments</h2>
  ${probeTable(repo.deployments || [], { emptyText: 'This repository advertises no deployment, so it is not graded on one.', showWhy: true })}
</section>

<section class="panel">
  <h2>npm registry verification</h2>
  ${packageTable(repo.packages)}
</section>

<section class="panel">
  <h2>README links</h2>
  ${probeTable(repo.links || [], { emptyText: 'The README carries no external links to check.' })}
</section>

<section class="panel">
  <h2>Score history</h2>
  <div class="pad">${sparkline(history)}</div>
</section>`;

	return page({
		title: `${repo.name} — Fleet Console`,
		description: `Measured health of ${owner}/${repo.name}: ${passed} of ${graded} checks pass, score ${repo.score}.`,
		owner,
		body
	});
}

export function notFoundPage({ owner, name }) {
	return page({
		title: 'Not found — Fleet Console',
		description: 'No such repository in the current snapshot.',
		owner,
		body: `<div class="empty" style="margin-top:60px">
  <h2>No repository called "${esc(name)}" in the current snapshot</h2>
  <p>It may be private, archived, a fork, or beyond this scan's repository limit.</p>
  <a class="btn" href="/">Back to the fleet</a>
</div>`
	});
}
