#!/usr/bin/env node
/**
 * ui-review.mjs — the queue that hands a screenshot of every page to an agent,
 * one batch at a time, and remembers what it already looked at.
 *
 * ── Why ───────────────────────────────────────────────────────────────────────
 * The layout bugs that reach a user are the ones no assertion is watching: a
 * floating pill sitting on the chat composer, a card action clipped mid-word, a
 * tab strip sliced in half, a prompt used as a title. `page-audit` finds the
 * mechanical half (console errors, overflow, tap targets). The other half is
 * only visible to something that can LOOK at the page. That is what an agent
 * with vision is for, and this script is the conveyor belt that feeds it.
 *
 * ── The loop ──────────────────────────────────────────────────────────────────
 *   1. `--start`  captures a signed-in screenshot of every page (page-snapshot
 *                 --authed) and runs the DOM audit over the same routes
 *                 (page-audit), then merges both into one queue.
 *   2. `--next N` prints the next N unreviewed pages: shot paths, the audit's
 *                 findings, the page's title and section. The agent READS those
 *                 image files, judges them, and fixes what is really wrong.
 *   3. `--done`   records the verdict for a page and advances the queue.
 *   4. `--report` writes the run's findings as markdown.
 *
 * State lives in the run directory, so the loop survives a context reset, a
 * restarted session, or a machine reboot: `--next` always knows where it got to.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   npm run ui:review -- --start                    # full signed-in sweep, then queue
 *   npm run ui:review -- --start --routes /,/gallery,/dashboard
 *   npm run ui:review -- --start --viewport mobile  # phone only (where most bugs are)
 *   npm run ui:review -- --start --no-audit         # shots only, skip page-audit
 *   npm run ui:review -- --next 6                   # next batch to look at
 *   npm run ui:review -- --done /gallery --clean
 *   npm run ui:review -- --done /app --issue "language pill covers the composer" --fixed "corner-stack now clears page docks"
 *   npm run ui:review -- --status
 *   npm run ui:review -- --report
 *
 * BASE_URL selects the target (default https://three.ws; use
 * http://localhost:3000 to review the working tree before it ships).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestPages } from './lib/audit-routes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = resolve(ROOT, 'reports/ui-review');
const SHOT_DIR = resolve(RUN_DIR, 'shots');
const QUEUE = resolve(RUN_DIR, 'queue.json');
const BASE_URL = (process.env.BASE_URL || 'https://three.ws').replace(/\/$/, '');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const rel = (p) => p.replace(`${ROOT}/`, '');

// ── Queue state ───────────────────────────────────────────────────────────────

function loadQueue() {
	if (!existsSync(QUEUE)) {
		console.error('No review queue yet. Run:  npm run ui:review -- --start');
		process.exit(2);
	}
	return JSON.parse(readFileSync(QUEUE, 'utf8'));
}

function saveQueue(q) {
	writeFileSync(QUEUE, `${JSON.stringify(q, null, 2)}\n`);
}

// ── Step 1: capture ───────────────────────────────────────────────────────────

function run(cmd, args, label) {
	console.log(`\n▸ ${label}\n  ${cmd} ${args.join(' ')}`);
	const res = spawnSync(cmd, args, {
		cwd: ROOT,
		stdio: 'inherit',
		env: { ...process.env, BASE_URL },
	});
	// page-audit exits non-zero only under --strict; a findings-only exit is fine.
	if (res.error) throw res.error;
	return res.status ?? 0;
}

/** Newest reports/page-audit-*.json as { file, data }, or null when skipped. */
function latestAuditReport() {
	const dir = resolve(ROOT, 'reports');
	if (!existsSync(dir)) return null;
	const files = readdirSync(dir)
		.filter((f) => /^page-audit-.*\.json$/.test(f))
		.sort();
	if (!files.length) return null;
	const file = resolve(dir, files[files.length - 1]);
	try {
		return { file: rel(file), data: JSON.parse(readFileSync(file, 'utf8')) };
	} catch {
		return null;
	}
}

function startRun() {
	const explicit = (opt('routes', '') || '')
		.split(',')
		.map((r) => r.trim())
		.filter((r) => r.startsWith('/'));
	const viewport = opt('viewport', 'both');
	const vpFlags =
		viewport === 'mobile' ? ['--mobile-only'] : viewport === 'desktop' ? ['--desktop-only'] : [];

	mkdirSync(RUN_DIR, { recursive: true });

	run(
		'node',
		['scripts/page-snapshot.mjs', '--authed', '--out', rel(SHOT_DIR), ...vpFlags, ...explicit],
		`Screenshotting ${explicit.length || 'every'} page at ${BASE_URL} (signed in)`,
	);

	if (!flag('no-audit')) {
		run(
			'node',
			['scripts/page-audit.mjs', ...vpFlags, ...explicit],
			'Running the DOM audit over the same routes',
		);
	}

	const manifest = JSON.parse(readFileSync(resolve(SHOT_DIR, 'manifest.json'), 'utf8'));
	const audit = flag('no-audit') ? null : latestAuditReport();
	const auditByRoute = new Map();
	for (const p of audit?.data?.pages || []) auditByRoute.set(p.route, p);

	const sectionOf = new Map(manifestPages({ access: 'all' }).map((p) => [p.path, p.section]));

	const pages = manifest.pages
		.filter((p) => Object.keys(p.shots || {}).length)
		.map((p) => ({
			route: p.path,
			title: p.title,
			section: p.section || sectionOf.get(p.path) || '',
			shots: Object.fromEntries(
				Object.keys(p.shots).map((vp) => [vp, rel(resolve(SHOT_DIR, vp, `${p.slug}.jpg`))]),
			),
			audit: (auditByRoute.get(p.path)?.findings || [])
				.filter((f) => f.severity !== 'info')
				.slice(0, 12)
				.map((f) => ({ severity: f.severity, type: f.type, detail: (f.detail || f.message || '').slice(0, 240) })),
			status: 'pending',
			issues: [],
			fixes: [],
		}));

	// Pages the audit flagged hardest come first: an agent that runs out of
	// budget mid-queue should have spent it where the evidence already points.
	const weight = (p) =>
		p.audit.reduce((n, f) => n + (f.severity === 'error' ? 10 : f.severity === 'warn' ? 3 : 1), 0);
	pages.sort((a, b) => weight(b) - weight(a));

	const queue = {
		startedAt: new Date().toISOString(),
		baseUrl: BASE_URL,
		viewport,
		shotDir: rel(SHOT_DIR),
		auditReport: audit?.file || null,
		pages,
	};
	saveQueue(queue);

	console.log(
		`\n■ Queue ready: ${pages.length} page(s) with shots at ${rel(SHOT_DIR)}.\n` +
			`  Next:  npm run ui:review -- --next 6`,
	);
}

// ── Step 2: hand out a batch ──────────────────────────────────────────────────

function printBatch(n) {
	const q = loadQueue();
	const batch = q.pages.filter((p) => p.status === 'pending').slice(0, n);
	if (!batch.length) {
		console.log('■ Queue empty: every page has been reviewed. Run --report for the summary.');
		return;
	}
	const total = q.pages.length;
	const done = q.pages.filter((p) => p.status !== 'pending').length;
	console.log(`■ UI review batch — ${batch.length} page(s), ${done}/${total} reviewed, target ${q.baseUrl}\n`);
	console.log('Read each screenshot below with the Read tool, judge it as a user would,');
	console.log('confirm anything suspicious against the live DOM, then fix it and record');
	console.log('the verdict with --done. Screenshots are full-page.\n');
	for (const p of batch) {
		console.log(`── ${p.route}  ${p.title ? `(${p.title})` : ''}`);
		if (p.section) console.log(`   section: ${p.section}`);
		for (const [vp, file] of Object.entries(p.shots)) console.log(`   ${vp}: ${file}`);
		if (p.audit.length) {
			console.log('   audit already found:');
			for (const f of p.audit) console.log(`     [${f.severity}] ${f.type}: ${f.detail}`);
		}
		console.log('');
	}
	console.log('Record each one:');
	console.log('  npm run ui:review -- --done <route> --clean');
	console.log('  npm run ui:review -- --done <route> --issue "what is wrong" --fixed "what you changed"');
}

// ── Step 3: record a verdict ──────────────────────────────────────────────────

function recordDone() {
	const route = opt('done', '');
	if (!route.startsWith('/')) {
		console.error('--done needs a route, e.g. --done /gallery');
		process.exit(2);
	}
	const q = loadQueue();
	const page = q.pages.find((p) => p.route === route);
	if (!page) {
		console.error(`${route} is not in this queue.`);
		process.exit(2);
	}
	const issue = opt('issue', '');
	const fixed = opt('fixed', '');
	if (issue) page.issues.push(issue);
	if (fixed) page.fixes.push(fixed);
	page.status = issue || fixed ? 'issues' : 'clean';
	page.reviewedAt = new Date().toISOString();
	saveQueue(q);
	const left = q.pages.filter((p) => p.status === 'pending').length;
	console.log(`✓ ${route} → ${page.status}${issue ? `: ${issue}` : ''}. ${left} page(s) left.`);
}

// ── Status + report ───────────────────────────────────────────────────────────

function printStatus() {
	const q = loadQueue();
	const by = (s) => q.pages.filter((p) => p.status === s);
	console.log(`■ UI review — ${q.baseUrl} — started ${q.startedAt}`);
	console.log(`  pending ${by('pending').length}  ·  clean ${by('clean').length}  ·  with issues ${by('issues').length}`);
	for (const p of by('issues')) {
		console.log(`\n  ${p.route}`);
		for (const i of p.issues) console.log(`    issue: ${i}`);
		for (const f of p.fixes) console.log(`    fix:   ${f}`);
	}
}

function writeReport() {
	const q = loadQueue();
	const withIssues = q.pages.filter((p) => p.issues.length || p.fixes.length);
	const lines = [
		'# UI review',
		'',
		`- target: ${q.baseUrl}`,
		`- started: ${q.startedAt}`,
		`- pages reviewed: ${q.pages.filter((p) => p.status !== 'pending').length} of ${q.pages.length}`,
		`- pages with issues: ${withIssues.length}`,
		'',
	];
	if (!withIssues.length) {
		lines.push('No visual defects recorded in this run.');
	}
	for (const p of withIssues) {
		lines.push(`## ${p.route}${p.title ? ` — ${p.title}` : ''}`, '');
		for (const i of p.issues) lines.push(`- **found:** ${i}`);
		for (const f of p.fixes) lines.push(`- **fixed:** ${f}`);
		for (const [vp, file] of Object.entries(p.shots)) lines.push(`- ${vp} shot: \`${file}\``);
		lines.push('');
	}
	const out = resolve(RUN_DIR, 'findings.md');
	writeFileSync(out, `${lines.join('\n')}\n`);
	console.log(`■ Wrote ${rel(out)}`);
}

// ── Entry ─────────────────────────────────────────────────────────────────────

if (flag('start')) startRun();
else if (argv.includes('--done')) recordDone();
else if (flag('status')) printStatus();
else if (flag('report')) writeReport();
else if (flag('next') || !argv.length) printBatch(Math.max(1, Number(opt('next', 5)) || 5));
else {
	console.error('Unknown arguments. See the header of scripts/ui-review.mjs for usage.');
	process.exit(2);
}
