/**
 * The public documentation page.
 *
 * A score nobody can audit is a number nobody should trust, so the weights,
 * the probe taxonomy and the API are all published here rather than living
 * only in the source.
 */

import { esc, page } from './html.js';
import { GRADES } from '../score.js';
import { PROBE_STATES } from '../probe.js';

const CHECKS = [
	['Claimed deployments respond', 20, 'Every URL the repository advertises as its running site is requested. Skipped when it advertises none.'],
	['Advertised packages exist on npm', 15, 'Every package name in an install line is resolved against the registry. Skipped when there are none.'],
	['README links resolve', 12, 'External links are probed. Auth walls and rate limits do not count as dead.'],
	['Has a real README', 8, 'A README under 600 bytes counts as a stub.'],
	['Ships documentation beyond the README', 8, 'A docs/, doc/, documentation/, website/ or site/ directory.'],
	['Recently touched', 8, 'Pushed within 120 days passes, within 400 warns.'],
	['Declares a license', 6, 'GitHub must be able to classify it.'],
	['npm matches the committed version', 6, 'The manifest version against the registry latest tag. Skipped when nothing is published.'],
	['Has a description', 4, 'The About field on GitHub.'],
	['Discoverable by topic', 3, 'Three or more topics pass.']
];

export function docsPage({ owner, snapshot }) {
	const example = snapshot?.repos?.[0]?.name || 'your-repo';
	const body = `<section class="hero">
  <h1>How Fleet Console works</h1>
  <p class="lede">Fleet Console takes a GitHub owner, reads what every repository claims about itself, and then checks those
  claims against the live internet. Nothing here is self-reported: a repository cannot mark its own homework.</p>
</section>

<section class="panel"><h2>The measurement loop</h2><div class="pad">
<ol style="margin:0;padding-left:20px;color:var(--muted);line-height:1.75">
  <li><strong style="color:var(--text)">Enumerate.</strong> Every public, non-fork, non-archived repository owned by <code>${esc(owner)}</code>, sorted by stars.</li>
  <li><strong style="color:var(--text)">Read the claims.</strong> The README, the root <code>package.json</code>, the repository homepage field, and the published GitHub Pages URL.</li>
  <li><strong style="color:var(--text)">Separate promises from references.</strong> A link labelled "live demo", a link on a known hosting provider, a host that spells out the repository name, or the homepage field is a deployment claim. Everything else is an ordinary outbound link, checked for rot but never treated as a broken deployment.</li>
  <li><strong style="color:var(--text)">Probe.</strong> Each URL is requested with a real HTTP call and classified by outcome, not by a pass/fail boolean.</li>
  <li><strong style="color:var(--text)">Verify the registry.</strong> Every package name in an install line is resolved against npm. A README telling readers to install something that was never published is a defect no test suite catches, because the failure lives in prose.</li>
  <li><strong style="color:var(--text)">Score.</strong> Weighted checks, with skipped checks removed from the denominator.</li>
</ol>
</div></section>

<section class="panel"><h2>Weights</h2>
<div class="scroll"><table>
<thead><tr><th>Check</th><th>Weight</th><th>What it measures</th></tr></thead>
<tbody>${CHECKS.map(([name, weight, detail]) => `<tr><td>${esc(name)}</td><td class="mono">${weight}</td><td style="color:var(--muted)">${esc(detail)}</td></tr>`).join('')}</tbody>
</table></div>
<div class="pad" style="color:var(--muted);font-size:13px">
A check returns pass, warn, fail or skip. Pass earns its full weight, warn earns half, fail earns nothing, and skip is removed
from both sides of the fraction. That last rule is the important one: a library with nothing deployed and nothing published is
not a broken library, and scoring it as one would make the whole fleet report useless.
</div></section>

<section class="panel"><h2>Grades</h2><div class="pad"><div class="chips">
${GRADES.map((entry) => `<span class="chip ${entry.tone}">${esc(entry.grade)} &middot; ${entry.min}+ &middot; ${esc(entry.label)}</span>`).join('')}
</div></div></section>

<section class="panel"><h2>Probe states</h2><div class="pad"><div class="chips">
${Object.entries(PROBE_STATES).map(([key, value]) => `<span class="chip ${value.tone}">${esc(value.label)}</span>`).join('')}
</div>
<p style="color:var(--muted);font-size:13px;margin-bottom:0">"Is it up?" is not a boolean. A suspended hosting account returns 402,
an expired certificate fails the handshake, and a deleted DNS record never connects at all. Each needs a different fix, so each
gets its own state.</p>
</div></section>

<section class="panel"><h2>Badges</h2><div class="pad">
<p style="margin-top:0">A build badge tells you the tests passed on some commit. These tell you whether the URLs a README
advertises answered a request. Paste either into a README and it stops being possible for that README to claim a deployment
that is gone.</p>
<div class="scroll"><table>
<thead><tr><th>Badge</th><th>Markdown</th></tr></thead>
<tbody>
<tr><td><img src="/badge/fleet.svg" alt="Fleet median health badge"></td><td class="mono">![fleet](/badge/fleet.svg)</td></tr>
<tr><td><img src="/badge/${encodeURIComponent(example)}.svg" alt="Per repository health badge"></td><td class="mono">![health](/badge/${esc(example)}.svg)</td></tr>
<tr><td><img src="/badge/${encodeURIComponent(example)}/deployment.svg" alt="Deployment badge"></td><td class="mono">![deployment](/badge/${esc(example)}/deployment.svg)</td></tr>
</tbody></table></div>
</div></section>

<section class="panel"><h2>API</h2>
<div class="scroll"><table>
<thead><tr><th>Endpoint</th><th>Returns</th></tr></thead>
<tbody>
<tr><td class="mono"><a href="/api/fleet">GET /api/fleet</a></td><td>The whole snapshot, one slim record per repository. Add <code>?full=1</code> for every probe.</td></tr>
<tr><td class="mono"><a href="/api/attention">GET /api/attention</a></td><td>Only what is broken, ranked worst first. Built for automation.</td></tr>
<tr><td class="mono"><a href="/api/repo/${encodeURIComponent(example)}">GET /api/repo/:name</a></td><td>One repository with every check, probe and score point in its history.</td></tr>
<tr><td class="mono"><a href="/api/status">GET /api/status</a></td><td>Scan progress. Safe to poll.</td></tr>
<tr><td class="mono">POST /api/scan</td><td>Trigger a scan. Requires the <code>FLEET_SCAN_TOKEN</code> bearer token.</td></tr>
<tr><td class="mono"><a href="/healthz">GET /healthz</a></td><td>Liveness.</td></tr>
</tbody></table></div>
</section>

<section class="panel"><h2>Run it against your own fleet</h2><div class="pad">
<p style="margin-top:0">Nothing about any particular owner is compiled into this service. Point <code>FLEET_OWNER</code> at any
GitHub user or organisation and it discovers that fleet at runtime.</p>
<pre class="mono" style="background:var(--surface-2);padding:14px;border-radius:10px;overflow-x:auto;margin:0">FLEET_OWNER=your-org GITHUB_TOKEN=ghp_... npm start</pre>
<p style="color:var(--muted);font-size:13px;margin-bottom:0">Without a token GitHub allows 60 requests an hour, which covers a
handful of repositories. The dashboard says so rather than reporting the rest as broken.</p>
</div></section>

<p style="margin-top:26px"><a href="/">&larr; Back to the fleet</a></p>`;

	return page({ title: 'How it works — Fleet Console', description: 'How Fleet Console measures the health of an open-source fleet: the checks, the weights, the probe taxonomy and the API.', owner, body });
}
