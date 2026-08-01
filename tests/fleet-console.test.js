/**
 * Unit tests for the fleet console engine (services/fleet-console).
 *
 * Everything here is pure: URL extraction, probe classification, the scoring
 * model, registry name parsing, badge rendering and the attention ranking. The
 * network-facing parts are covered by running a real scan, which cannot live in
 * a unit test suite.
 */

import { describe, it, expect } from 'vitest';

import { extractReadmeLinks, deploymentCandidates, isIgnoredHost } from '../services/fleet-console/src/extract-urls.js';
import { __testables as probeInternals, isHealthyState, PROBE_STATES } from '../services/fleet-console/src/probe.js';
import { scoreRepo, summarise, gradeFor } from '../services/fleet-console/src/score.js';
import { advertisedPackages, __testables as registryInternals } from '../services/fleet-console/src/registry.js';
import { badgeSvg, repoBadge, deploymentBadge, fleetBadge } from '../services/fleet-console/src/badge.js';
import { esc, ago } from '../services/fleet-console/src/views/html.js';
import { attention, slim } from '../services/fleet-console/src/server.js';
import { mapPool } from '../services/fleet-console/src/pool.js';

const probe = (url, state, extra = {}) => ({ url, state, status: state === 'live' ? 200 : 404, ms: 12, finalUrl: url, redirected: false, detail: '', ...extra });

const baseRepo = {
	name: 'widget',
	description: 'A widget',
	stars: 10,
	topics: ['a', 'b', 'c'],
	license: 'MIT',
	pushedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
	readmeBytes: 4000,
	hasDocsDir: true,
	deployments: [],
	links: [],
	packages: { checked: [], missing: [] }
};

describe('README link extraction', () => {
	it('pulls markdown, reference, HTML and bare links while skipping images', () => {
		const readme = `
# Widget
[Live demo](https://widget.example.dev/) and ![badge](https://img.shields.io/badge/x-y.svg)
<a href="https://docs.widget.dev">Docs site</a>
See https://spec.example.org/v1 for the format.

[ref]: https://ref.example.net/page
`;
		const urls = extractReadmeLinks(readme).map((link) => link.url);
		expect(urls).toContain('https://widget.example.dev/');
		expect(urls).toContain('https://docs.widget.dev/');
		expect(urls).toContain('https://spec.example.org/v1');
		expect(urls).toContain('https://ref.example.net/page');
		expect(urls.some((url) => url.includes('shields.io'))).toBe(false);
	});

	it('ignores URLs inside fenced code blocks', () => {
		const readme = ['```bash', 'curl https://api.internal-only.test/v1/thing', '```', '[real](https://real.example.dev)'].join('\n');
		const urls = extractReadmeLinks(readme).map((link) => link.url);
		expect(urls).toEqual(['https://real.example.dev/']);
	});

	it('strips trailing punctuation from bare URLs', () => {
		const urls = extractReadmeLinks('Visit https://example.dev/page, then leave.').map((link) => link.url);
		expect(urls).toEqual(['https://example.dev/page']);
	});

	it('treats github, npm and badge hosts as not worth checking', () => {
		expect(isIgnoredHost('https://github.com/a/b')).toBe(true);
		expect(isIgnoredHost('https://www.npmjs.com/package/x')).toBe(true);
		expect(isIgnoredHost('https://img.shields.io/badge.svg')).toBe(true);
		expect(isIgnoredHost('https://widget.example.dev')).toBe(false);
	});

	it('rejects non-http schemes and unparseable values', () => {
		const urls = extractReadmeLinks('[mail](mailto:a@b.co) [js](javascript:alert(1)) [ok](https://ok.example.dev)').map((link) => link.url);
		expect(urls).toEqual(['https://ok.example.dev/']);
	});
});

describe('deployment claim detection', () => {
	const call = (overrides) =>
		deploymentCandidates({ repoName: 'widget', homepage: '', pagesUrl: '', manifestHomepage: '', links: [], ...overrides }).map((entry) => entry.url);

	it('counts the homepage field, Pages URL and manifest homepage', () => {
		const urls = call({ homepage: 'https://widget.dev', pagesUrl: 'https://owner.github.io/widget/', manifestHomepage: 'https://manifest.example.dev' });
		expect(urls.sort()).toEqual(['https://manifest.example.dev/', 'https://owner.github.io/widget/', 'https://widget.dev/']);
	});

	it('counts known hosting providers found in the README', () => {
		const urls = call({ links: [{ url: 'https://thing-abc.a.run.app/', label: 'API', source: 'markdown' }] });
		expect(urls).toEqual(['https://thing-abc.a.run.app/']);
	});

	it('counts a link labelled as live but not an ordinary reference', () => {
		const urls = call({
			links: [
				{ url: 'https://try.example.dev/', label: 'Live demo', source: 'markdown' },
				{ url: 'https://spec.example.org/', label: 'the specification', source: 'markdown' }
			]
		});
		expect(urls).toEqual(['https://try.example.dev/']);
	});

	it('does not claim a third party site because its link text contains the word live', () => {
		// A README linking "Debian live-build" is not promising to run debian.org.
		const urls = call({
			homepage: 'https://widget.dev',
			links: [{ url: 'https://live-team.pages.debian.net/live-manual/', label: 'Debian live-build', source: 'markdown' }]
		});
		expect(urls).toEqual(['https://widget.dev/']);
	});

	it('collapses many paths on one host into a small sample of that one site', () => {
		const links = Array.from({ length: 40 }, (unused, index) => ({ url: `https://widget.dev/page-${index}`, label: '', source: 'markdown' }));
		const urls = call({ homepage: 'https://widget.dev', links });
		// One site, one deployment claim, plus a couple of deeper paths as a spot check.
		expect(urls.length).toBe(3);
		expect(urls[0]).toBe('https://widget.dev/');
	});

	it('caps the total number of probes even across many hosts', () => {
		const links = Array.from({ length: 30 }, (unused, index) => ({ url: `https://host-${index}.pages.dev/`, label: '', source: 'markdown' }));
		expect(call({ links }).length).toBeLessThanOrEqual(8);
	});

	it('never invents an origin root that was not claimed', () => {
		// On a project Pages site the origin root is a different repository's page.
		const urls = call({ pagesUrl: 'https://owner.github.io/widget/' });
		expect(urls).toEqual(['https://owner.github.io/widget/']);
	});

	it('recovers a real URL from trailing markdown noise instead of probing the noise', () => {
		const urls = call({ links: [{ url: 'https://owner.github.io/widget/**', label: '', source: 'bare' }] });
		expect(urls).toEqual(['https://owner.github.io/widget/']);
	});

	it('drops template placeholders and interior globs rather than probing them', () => {
		const urls = call({
			links: [
				{ url: 'https://api.example.dev/${version}/thing', label: 'Live demo', source: 'markdown' },
				{ url: 'https://cdn.example.dev/*/asset.js', label: 'Live demo', source: 'markdown' },
				{ url: 'https://widget.dev/real', label: 'Live demo', source: 'markdown' }
			]
		});
		expect(urls).toEqual(['https://widget.dev/real']);
	});

	it('counts a host that spells out the repository name', () => {
		const urls = call({ links: [{ url: 'https://widget.example.io/', label: '', source: 'bare' }] });
		expect(urls).toEqual(['https://widget.example.io/']);
	});

	it('does not double count the same URL reached two ways', () => {
		const urls = call({ homepage: 'https://widget.dev', links: [{ url: 'https://widget.dev', label: 'Live', source: 'markdown' }] });
		expect(urls).toEqual(['https://widget.dev/']);
	});
});

describe('probe classification', () => {
	const { classifyStatus, classifyError } = probeInternals;

	it('separates the ways a request can fail to return a page', () => {
		expect(classifyStatus(200, false)).toBe('live');
		expect(classifyStatus(200, true)).toBe('redirected');
		expect(classifyStatus(402, false)).toBe('payment_required');
		expect(classifyStatus(401, false)).toBe('auth_required');
		expect(classifyStatus(403, false)).toBe('auth_required');
		expect(classifyStatus(429, false)).toBe('rate_limited');
		expect(classifyStatus(404, false)).toBe('not_found');
		expect(classifyStatus(410, false)).toBe('not_found');
		expect(classifyStatus(503, false)).toBe('server_error');
	});

	it('maps transport failures to their cause', () => {
		expect(classifyError({ cause: { code: 'ENOTFOUND' } })).toBe('dns_failure');
		expect(classifyError({ cause: { code: 'ECONNREFUSED' } })).toBe('refused');
		expect(classifyError({ cause: { code: 'CERT_HAS_EXPIRED' } })).toBe('tls_failure');
		expect(classifyError({ name: 'AbortError', message: 'aborted' })).toBe('timeout');
		expect(classifyError(new Error('something else'))).toBe('unreachable');
	});

	it('treats only live and redirected as healthy', () => {
		expect(isHealthyState('live')).toBe(true);
		expect(isHealthyState('redirected')).toBe(true);
		expect(isHealthyState('payment_required')).toBe(false);
	});

	it('has a label and tone for every state the classifiers can produce', () => {
		for (const state of ['live', 'redirected', 'payment_required', 'auth_required', 'rate_limited', 'not_found', 'server_error', 'dns_failure', 'refused', 'tls_failure', 'timeout', 'unreachable']) {
			expect(PROBE_STATES[state], state).toBeTruthy();
		}
	});
});

describe('scoring', () => {
	it('gives a fully healthy repository a top grade', () => {
		const { score, grade } = scoreRepo({
			...baseRepo,
			deployments: [probe('https://widget.dev/', 'live')],
			links: [probe('https://spec.example.org/', 'live')],
			packages: { checked: [{ name: 'widget', published: true, latest: '1.2.0', deprecated: false, role: 'manifest' }], missing: [], ownPackage: { name: 'widget', published: true, latest: '1.2.0' } },
			packageVersion: '1.2.0'
		});
		expect(score).toBe(100);
		expect(grade.grade).toBe('A');
	});

	it('does not punish a library for having nothing deployed', () => {
		const withoutDeployment = scoreRepo(baseRepo);
		const deploymentCheck = withoutDeployment.checks.find((check) => check.id === 'deployment');
		expect(deploymentCheck.status).toBe('skip');
		// A skipped check leaves the denominator entirely, so the rest still scores full marks.
		expect(withoutDeployment.score).toBe(100);
	});

	it('fails a repository whose only advertised deployment is down', () => {
		const { score, checks } = scoreRepo({ ...baseRepo, deployments: [probe('https://gone.example.dev/', 'payment_required')] });
		expect(checks.find((check) => check.id === 'deployment').status).toBe('fail');
		expect(score).toBeLessThan(100);
	});

	it('warns when some but not all deployments respond', () => {
		const { checks } = scoreRepo({ ...baseRepo, deployments: [probe('https://a.example.dev/', 'live'), probe('https://b.example.dev/', 'not_found')] });
		expect(checks.find((check) => check.id === 'deployment').status).toBe('warn');
	});

	it('fails a repository advertising a package that was never published', () => {
		const { checks } = scoreRepo({
			...baseRepo,
			packages: { checked: [{ name: 'ghost-package', published: false, latest: '', deprecated: false, role: 'readme' }], missing: ['ghost-package'] }
		});
		const check = checks.find((entry) => entry.id === 'packages');
		expect(check.status).toBe('fail');
		expect(check.evidence).toContain('ghost-package');
		expect(check.fix).toBeTruthy();
	});

	it('does not count an auth wall or a rate limit as a dead link', () => {
		const { checks } = scoreRepo({ ...baseRepo, links: [probe('https://private.example.dev/', 'auth_required'), probe('https://slow.example.dev/', 'rate_limited')] });
		expect(checks.find((check) => check.id === 'links').status).toBe('pass');
	});

	it('warns when the published version has drifted from the manifest', () => {
		const { checks } = scoreRepo({
			...baseRepo,
			packages: { checked: [{ name: 'widget', published: true, latest: '1.0.0', deprecated: false, role: 'manifest' }], missing: [], ownPackage: { name: 'widget', published: true, latest: '1.0.0' } },
			packageVersion: '2.0.0'
		});
		const check = checks.find((entry) => entry.id === 'release-sync');
		expect(check.status).toBe('warn');
		expect(check.evidence).toContain('2.0.0');
	});

	it('degrades a stale, undocumented, unlicensed repository', () => {
		const { score, grade } = scoreRepo({
			...baseRepo,
			description: '',
			license: '',
			topics: [],
			readmeBytes: 0,
			hasDocsDir: false,
			pushedAt: new Date(Date.now() - 900 * 86400000).toISOString()
		});
		expect(score).toBeLessThan(40);
		expect(grade.grade).toBe('F');
	});

	it('maps scores onto grade bands at the boundaries', () => {
		expect(gradeFor(100).grade).toBe('A');
		expect(gradeFor(90).grade).toBe('A');
		expect(gradeFor(89).grade).toBe('B');
		expect(gradeFor(75).grade).toBe('B');
		expect(gradeFor(60).grade).toBe('C');
		expect(gradeFor(40).grade).toBe('D');
		expect(gradeFor(0).grade).toBe('F');
	});

	it('never returns a score outside 0..100', () => {
		for (const repo of [baseRepo, { ...baseRepo, description: '', license: '', topics: [], readmeBytes: 0, hasDocsDir: false }]) {
			const { score } = scoreRepo(repo);
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(100);
		}
	});
});

describe('fleet summary', () => {
	it('rolls up scores, deployments, links and missing packages', () => {
		const repos = [
			{ ...baseRepo, name: 'a', score: 100, grade: gradeFor(100), stars: 5, deployments: [probe('https://a.dev/', 'live')], links: [], packages: { checked: [], missing: [] } },
			{ ...baseRepo, name: 'b', score: 50, grade: gradeFor(50), stars: 3, deployments: [probe('https://b.dev/', 'not_found')], links: [probe('https://x.dev/', 'dns_failure')], packages: { checked: [], missing: ['ghost'] } }
		];
		const summary = summarise(repos);
		expect(summary.repos).toBe(2);
		expect(summary.stars).toBe(8);
		expect(summary.medianScore).toBe(75);
		expect(summary.deployments).toMatchObject({ total: 2, healthy: 1 });
		expect(summary.links).toMatchObject({ total: 1, dead: 1 });
		expect(summary.missingPackages).toEqual([{ repo: 'b', name: 'ghost' }]);
		expect(summary.byGrade.A).toBe(1);
	});

	it('handles an empty fleet without dividing by zero', () => {
		const summary = summarise([]);
		expect(summary.medianScore).toBe(0);
		expect(summary.averageScore).toBe(0);
		expect(summary.repos).toBe(0);
	});
});

describe('npm registry parsing', () => {
	it('finds package names across npm, yarn, pnpm and bun install lines', () => {
		const readme = `
\`npm install @scope/thing\`
yarn add other-thing@^2.0.0
pnpm add -D dev-thing
bun add third-thing
`;
		expect(advertisedPackages(readme).sort()).toEqual(['@scope/thing', 'dev-thing', 'other-thing', 'third-thing']);
	});

	it('skips flags, local paths, tarballs and git specifiers', () => {
		const names = advertisedPackages('npm install -g ./local-dir ../other https://x.test/a.tgz github:owner/repo real-package');
		expect(names).toEqual(['real-package']);
	});

	it('does not mistake a port number on an install line for a package', () => {
		expect(advertisedPackages('npm install serve 3001')).toEqual(['serve']);
	});

	it('strips a version range without eating a scope', () => {
		expect(registryInternals.stripVersionRange('@scope/thing@1.2.3')).toBe('@scope/thing');
		expect(registryInternals.stripVersionRange('thing@^1.0.0')).toBe('thing');
		expect(registryInternals.stripVersionRange('@scope/thing')).toBe('@scope/thing');
	});

	it('rejects names the registry could never hold', () => {
		expect(registryInternals.PACKAGE_NAME.test('Valid-Name')).toBe(false);
		expect(registryInternals.PACKAGE_NAME.test('valid-name')).toBe(true);
		expect(registryInternals.PACKAGE_NAME.test('@scope/valid')).toBe(true);
	});
});

describe('badges', () => {
	it('renders valid, self-describing SVG', () => {
		const svg = badgeSvg({ label: 'fleet health', message: '92/100 A', tone: 'good' });
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('role="img"');
		expect(svg).toContain('aria-label="fleet health: 92/100 A"');
		expect(svg.trim().endsWith('</svg>')).toBe(true);
	});

	it('escapes text so a repository name can never break the markup', () => {
		expect(badgeSvg({ label: 'a<b>', message: '"x"&y', tone: 'bad' })).toContain('a&lt;b&gt;');
	});

	it('reports an unknown repository rather than inventing a score', () => {
		expect(repoBadge(null)).toContain('unknown');
		expect(fleetBadge(null)).toContain('not scanned');
	});

	it('summarises deployment health', () => {
		expect(deploymentBadge({ deployments: [probe('https://a.dev/', 'live'), probe('https://b.dev/', 'not_found')] })).toContain('1/2 live');
		expect(deploymentBadge({ deployments: [] })).toContain('none advertised');
	});

	it('scales the badge width with its text', () => {
		const narrow = badgeSvg({ label: 'a', message: 'b', tone: 'good' });
		const wide = badgeSvg({ label: 'a much longer label', message: 'and a longer message', tone: 'good' });
		const width = (svg) => Number(svg.match(/width="(\d+)"/)[1]);
		expect(width(wide)).toBeGreaterThan(width(narrow));
	});
});

describe('attention feed', () => {
	const snapshot = {
		owner: 'someone',
		generatedAt: '2026-01-01T00:00:00.000Z',
		repos: [
			{
				...baseRepo,
				name: 'alpha',
				htmlUrl: 'https://github.com/someone/alpha',
				deployments: [probe('https://alpha.dev/', 'payment_required')],
				links: [probe('https://dead.example.dev/', 'dns_failure')],
				packages: { checked: [], missing: ['ghost-pkg'] },
				checks: [{ id: 'license', title: 'Declares a license', weight: 6, status: 'fail', evidence: 'none', fix: 'Add a LICENSE file.' }]
			}
		]
	};

	it('ranks broken deployments and unpublished packages above dead links', () => {
		const report = attention(snapshot);
		expect(report.count).toBe(4);
		expect(report.items[0].severity).toBe('high');
		expect(report.items.at(-1).kind).toBe('dead_link');
		expect(report.items.map((item) => item.kind)).toContain('package_unpublished');
		expect(report.items.map((item) => item.kind)).toContain('check_failed:license');
	});

	it('slims a repository down to what a list view needs', () => {
		const record = slim(snapshot.repos[0]);
		expect(record).toMatchObject({ name: 'alpha', unpublishedPackages: ['ghost-pkg'] });
		expect(record.broken).toEqual([{ url: 'https://alpha.dev/', state: 'payment_required' }]);
		expect(record.live).toEqual([]);
	});
});

describe('view helpers', () => {
	it('escapes every character that could close a tag or an attribute', () => {
		expect(esc('<script>"x"&\'y\'</script>')).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
	});

	it('renders relative times in plain language', () => {
		expect(ago(new Date(Date.now() - 30 * 1000).toISOString())).toMatch(/second/);
		expect(ago(new Date(Date.now() - 3 * 86400000).toISOString())).toBe('3 days ago');
		expect(ago('')).toBe('never');
		expect(ago('not a date')).toBe('never');
	});
});

describe('bounded concurrency', () => {
	it('preserves input order and never exceeds the limit', async () => {
		let active = 0;
		let peak = 0;
		const result = await mapPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (value) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			return value * 2;
		});
		expect(result).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
		expect(peak).toBeLessThanOrEqual(3);
	});

	it('handles an empty list', async () => {
		expect(await mapPool([], 4, async () => 1)).toEqual([]);
	});
});
