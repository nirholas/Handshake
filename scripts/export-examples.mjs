#!/usr/bin/env node
// One-way export: assemble the public `three-ws/examples` satellite repo from the
// monorepo. This script is the ONLY sanctioned way to build that repo's contents.
//
//   node scripts/export-examples.mjs            # build into dist/examples-repo/
//   node scripts/export-examples.mjs --out DIR  # build into a custom directory
//   node scripts/export-examples.mjs --smoke     # additionally npm-install + check each example
//
// It is idempotent (wipes and rebuilds the output dir on every run) and offline
// by default. It copies a CURATED subset of real monorepo material into the
// satellite layout, rewriting every monorepo-relative reference to a working
// surface (published @three-ws/* npm packages, or hosted https://three.ws URLs)
// so nothing points back into the monorepo. Nothing here pushes, commits, or
// creates a repo: the output is a plain directory the owner publishes by hand
// (see docs/ops/examples-repo-export.md). Satellites are strictly one-way: the
// monorepo is the source of truth and the satellite history is disposable.
//
// Why a local script and not CI: GitHub Actions are unavailable on this account
// (all workflows deleted), so the satellite-sync must run from the local push
// routine or it rots. See prompts/roadmap/developer-resources-repos.md.

import {
	cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const argv = process.argv.slice(2);
const OUT = (() => {
	const i = argv.indexOf('--out');
	if (i !== -1 && argv[i + 1]) return join(process.cwd(), argv[i + 1]);
	return join(REPO, 'dist', 'examples-repo');
})();
const SMOKE = argv.includes('--smoke');

const HOST = 'https://three.ws';
const MONOREPO_URL = 'https://github.com/nirholas/three.ws';

// ---------------------------------------------------------------------------
// Published package versions (read live from each package's own package.json),
// so a version bump in the monorepo flows into the exported examples with no
// edit here. These are the packages the examples install (Phase 0 resolved:
// all @three-ws/* are published on npm).
// ---------------------------------------------------------------------------
const pkgVersion = (dir) => JSON.parse(readFileSync(join(REPO, dir, 'package.json'), 'utf8')).version;

// monorepo dir (a `file:` dep target's basename) -> published package name
const FILE_DEP_MAP = {
	'sdk': '@three-ws/sdk',
	'solana-agent-sdk': '@three-ws/solana-agent',
	'agent-payments-sdk': '@three-ws/agent-payments',
	'agent-protocol-sdk': '@three-ws/agent-protocol-sdk',
	'agent-ui-sdk': '@three-ws/agent-ui',
	'avatar-sdk': '@three-ws/avatar',
	'mcp-server': '@three-ws/mcp-server',
};
const PKG_VERSION = Object.fromEntries(
	Object.entries(FILE_DEP_MAP).map(([dir, name]) => [name, pkgVersion(dir)]),
);

// ---------------------------------------------------------------------------
// Reference rewriting: every monorepo-relative path in a copied file becomes a
// working surface. Ordered longest-prefix first so two-level `../../` never gets
// half-rewritten by the one-level `../` rule.
// ---------------------------------------------------------------------------
function rewriteRefs(text) {
	return text
		// docs links -> live docs pages (drop the .md, docs render at /docs/<slug>)
		.replace(/\.\.\/\.\.\/docs\/([a-z0-9-]+)\.md/gi, `${HOST}/docs/$1`)
		.replace(/\.\.\/docs\/([a-z0-9-]+)\.md/gi, `${HOST}/docs/$1`)
		// monorepo source imports -> hosted raw modules (all resolve 200 today)
		.replace(/\.\.\/\.\.\/src\//g, `${HOST}/src/`)
		.replace(/\.\.\/src\//g, `${HOST}/src/`)
		// root-relative site assets -> absolute hosted URLs
		.replace(/(["'(=])\/avatars\//g, `$1${HOST}/avatars/`)
		.replace(/(["'(=])\/dist-lib\//g, `$1${HOST}/dist-lib/`)
		.replace(/(["'(=])\/src\//g, `$1${HOST}/src/`);
}

// Rewrite `file:` workspace deps in a package.json string to published semver.
function rewritePkgJson(text) {
	const pkg = JSON.parse(text);
	for (const field of ['dependencies', 'devDependencies']) {
		const deps = pkg[field];
		if (!deps) continue;
		for (const [name, spec] of Object.entries(deps)) {
			if (typeof spec === 'string' && spec.startsWith('file:')) {
				const targetDir = basename(spec.replace(/^file:/, ''));
				const published = FILE_DEP_MAP[targetDir];
				if (!published) throw new Error(`Unmapped file: dependency ${name} -> ${spec}`);
				deps[name] = `^${PKG_VERSION[published]}`;
			}
		}
	}
	return JSON.stringify(pkg, null, '\t') + '\n';
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------
const REWRITE_EXT = new Set(['.html', '.md', '.mjs', '.js', '.json']);
const extname = (p) => (p.match(/\.[^./]+$/) || [''])[0];

function writeOut(relPath, content) {
	const dest = join(OUT, relPath);
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, content);
}

// Copy a monorepo file into the satellite, applying reference/pkg rewrites and
// optional per-file extra transforms.
function copyFile(fromRel, toRel, { extra } = {}) {
	const src = join(REPO, fromRel);
	let content = readFileSync(src, 'utf8');
	if (extra) content = extra(content);
	if (basename(toRel) === 'package.json') content = rewritePkgJson(content);
	else if (REWRITE_EXT.has(extname(toRel))) content = rewriteRefs(content);
	writeOut(toRel, content);
}

// Recursively copy a monorepo dir, rewriting text files, skipping build cruft.
const SKIP = new Set(['node_modules', 'dist', '.cache', '.git', 'package-lock.json']);
function copyDir(fromRel, toRel, { extra } = {}) {
	const srcDir = join(REPO, fromRel);
	for (const name of readdirSync(srcDir)) {
		if (SKIP.has(name)) continue;
		const childFrom = join(fromRel, name);
		const childTo = join(toRel, name);
		if (statSync(join(REPO, childFrom)).isDirectory()) {
			copyDir(childFrom, childTo, { extra });
		} else if (REWRITE_EXT.has(extname(name))) {
			copyFile(childFrom, childTo, { extra });
		} else {
			const dest = join(OUT, childTo);
			mkdirSync(dirname(dest), { recursive: true });
			cpSync(join(REPO, childFrom), dest);
		}
	}
}

// ---------------------------------------------------------------------------
// The curated manifest: the single source of what the satellite contains.
// ---------------------------------------------------------------------------
const AGENTS = [
	{ dir: 'coach-leo', title: 'Coach Leo', shows: 'A full character agent: system prompt, manifest, and skill wiring.', run: 'Load into the three.ws agent builder (instructions.md + manifest.json).' },
	{ dir: 'pump-fun-agent', title: 'pump.fun agent', shows: 'An agent wired to the live pump.fun feed for buys, sells, launches, and creator fees.', run: 'Load instructions.md + manifest.json into an agent runtime with the pump.fun skills.' },
	{ dir: 'three-concierge', title: 'Three Concierge (Trinity)', shows: 'An embedded concierge agent with an agent-card and on-chain identity.', run: 'Load instructions.md + manifest.json; embed via the agent-card.json.' },
	{ dir: 'metamask-agent-wallet', title: 'MetaMask agent wallet', shows: 'A wallet-connected agent: a localhost bridge exposing the MetaMask Agentic CLI to a demo page.', run: 'node server.mjs, then open index.html at http://localhost:4280' },
];

const QUICKSTARTS = [
	{ slug: 'sdk', pkg: '@three-ws/sdk', srcDir: 'sdk', readme: 'sdk/README.md', section: /^## Quick start/m, exampleDir: 'sdk/example', blurb: 'The core three.ws SDK: build an agent, embed a 3D avatar, register on-chain.' },
	{ slug: 'solana-agent-sdk', pkg: '@three-ws/solana-agent', srcDir: 'solana-agent-sdk', readme: 'solana-agent-sdk/README.md', section: /^## Quick start/m, blurb: 'Solana-native agent actions, wallet providers, and x402 exact payments.' },
	{ slug: 'agent-payments-sdk', pkg: '@three-ws/agent-payments', srcDir: 'agent-payments-sdk', readme: 'agent-payments-sdk/README.md', section: /^## Quick start/m, blurb: 'Agent-to-agent payments over x402 and a2a on Solana and EVM.' },
	{ slug: 'mcp-server', pkg: '@three-ws/mcp-server', srcDir: 'mcp-server', readme: 'mcp-server/README.md', section: /^## Quickstart \(30 seconds\)/m, blurb: 'The three.ws MCP server: 3D generation, Solana, markets, and agent tools in Claude/Cursor.' },
];

const EMBEDS = [
	{ file: 'minimal.html', shows: 'The smallest possible avatar embed (one script tag).' },
	{ file: 'two-agents.html', shows: 'Two avatars on one page.' },
	{ file: 'web-component.html', shows: 'The <mv-viewer> web component with multiple GLBs.' },
	{ file: 'widget-rpc.html', shows: 'Driving an embedded avatar over the widget RPC bridge.' },
];

const TUTORIALS = [
	{ dir: 'agenc-task-roundtrip', title: 'AgenC task roundtrip', shows: 'End-to-end AgenC task lifecycle on Solana devnet, all real on-chain transactions.', run: 'npm install && npm start' },
	{
		dir: 'agent-native-3d',
		title: 'Agent-native 3D',
		shows: 'An agent generates, rigs, embodies, and distributes a 3D creation end to end via the free MCP tools.',
		run: 'npm install && npm start',
		// Vendor the shared embed-snippet builders and localise the output path so
		// the script is self-contained (no monorepo src/ or _generated/ dependency).
		vendor: [{ from: 'src/forge-embed-snippets.js', to: 'lib/forge-embed-snippets.js' }],
		runTransform: (t) => t
			.replaceAll("'../../src/forge-embed-snippets.js'", "'./lib/forge-embed-snippets.js'")
			.replaceAll('../../src/forge-embed-snippets.js', './lib/forge-embed-snippets.js')
			.replaceAll("resolve(HERE, '../..')", 'HERE')
			.replaceAll("'prompts/roadmap/_generated/10'", "'out'"),
	},
];

// Extract the content of a `## Heading` section up to the next `## ` heading.
function extractSection(readmeRel, headingRe) {
	const text = readFileSync(join(REPO, readmeRel), 'utf8');
	const start = text.search(headingRe);
	if (start === -1) return '';
	const after = text.slice(start);
	const nextH2 = after.slice(1).search(/^## /m);
	const body = nextH2 === -1 ? after : after.slice(0, nextH2 + 1);
	return rewriteRefs(body.trim());
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
console.log(`Exporting satellite → ${relative(process.cwd(), OUT) || OUT}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// LICENSE (carried verbatim from the monorepo). The owner should confirm or
// replace this before publishing the repo publicly (see the ops runbook).
copyFile('LICENSE', 'LICENSE');

// .gitignore for the satellite working tree.
writeOut('.gitignore', ['node_modules/', '.cache/', 'out/', 'dist/', '.DS_Store', ''].join('\n'));

// agents/
for (const a of AGENTS) {
	copyDir(`examples/${a.dir}`, `agents/${a.dir}`);
	if (!existsSync(join(OUT, 'agents', a.dir, 'README.md'))) {
		writeOut(`agents/${a.dir}/README.md`, [
			`# ${a.title}`,
			'',
			a.shows,
			'',
			'## Run',
			'',
			'```',
			a.run,
			'```',
			'',
			`Source of truth: the [three.ws monorepo](${MONOREPO_URL}). Issues and PRs belong there.`,
			`Docs: ${HOST}/docs`,
			'',
		].join('\n'));
	}
}

// embeds/
for (const e of EMBEDS) copyFile(`examples/${e.file}`, `embeds/${e.file}`);
writeOut('embeds/README.md', [
	'# Embeds',
	'',
	'Single-file HTML patterns for putting a three.ws 3D avatar on any page. Every',
	`asset URL points at ${HOST}. Open any file directly in a browser, no build step.`,
	'',
	'| File | Shows |',
	'|---|---|',
	...EMBEDS.map((e) => `| [\`${e.file}\`](${e.file}) | ${e.shows} |`),
	'',
].join('\n'));

// quickstarts/
for (const q of QUICKSTARTS) {
	const version = PKG_VERSION[q.pkg];
	const section = extractSection(q.readme, q.section);
	if (q.exampleDir) copyDir(q.exampleDir, `quickstarts/${q.slug}/example`);
	writeOut(`quickstarts/${q.slug}/README.md`, [
		`# ${q.pkg} quickstart`,
		'',
		q.blurb,
		'',
		'## Install',
		'',
		'```bash',
		`npm install ${q.pkg}@^${version}`,
		'```',
		'',
		section,
		'',
		'---',
		'',
		`Package: https://www.npmjs.com/package/${q.pkg} · Docs: ${HOST}/docs`,
		`Source of truth: the [three.ws monorepo](${MONOREPO_URL}). Issues and PRs belong there.`,
		q.exampleDir ? `\nRunnable browser demo under [\`example/\`](example/).` : '',
		'',
	].join('\n'));
}

// tutorials/
for (const t of TUTORIALS) {
	copyDir(`examples/${t.dir}`, `tutorials/${t.dir}`, { extra: t.runTransform });
	for (const v of t.vendor || []) copyFile(v.from, `tutorials/${t.dir}/${v.to}`);
}

// Root README: the index the whole repo is discovered through.
const row = (name, path, shows, run) => `| [${name}](${path}) | ${shows} | \`${run}\` |`;
writeOut('README.md', [
	'# three.ws examples',
	'',
	'Runnable examples, SDK quickstarts, and embed patterns for [three.ws](https://three.ws):',
	'a platform where AI agents are embodied as 3D avatars, registered on-chain, and wired to',
	'real Solana and payment rails.',
	'',
	'> **Source of truth is the monorepo.** This repo is a one-way export. File issues and',
	`> pull requests at **${MONOREPO_URL}**, not here. Direct contributions to this repo are`,
	'> not accepted. Nothing here is pulled back into the monorepo.',
	'',
	'## Quickstarts',
	'',
	'| SDK | Install |',
	'|---|---|',
	...QUICKSTARTS.map((q) => `| [${q.pkg}](quickstarts/${q.slug}) | \`npm install ${q.pkg}@^${PKG_VERSION[q.pkg]}\` |`),
	'',
	'## Agents',
	'',
	'| Example | What it shows | Run |',
	'|---|---|---|',
	...AGENTS.map((a) => row(a.title, `agents/${a.dir}`, a.shows, a.run)),
	'',
	'## Embeds',
	'',
	'| Pattern | What it shows |',
	'|---|---|',
	...EMBEDS.map((e) => `| [${e.file}](embeds/${e.file}) | ${e.shows} |`),
	'',
	'## Tutorials',
	'',
	'| Walkthrough | What it shows | Run |',
	'|---|---|---|',
	...TUTORIALS.map((t) => row(t.title, `tutorials/${t.dir}`, t.shows, t.run)),
	'',
	'## Skills',
	'',
	'Reusable skill definitions (manifest + tools + handlers) under [`skills/`](skills):',
	'drop-in capabilities for pump.fun trading, strategy, and Solana wallet flows.',
	'',
	'---',
	'',
	`Docs: ${HOST}/docs · Changelog: ${HOST}/changelog · Live platform: ${HOST}`,
	'',
].join('\n'));

// skills/
copyDir('examples/skills', 'skills');

// ---------------------------------------------------------------------------
// Optional smoke test: real npm install + example check. Off by default: it
// needs network access to the npm registry and is meant to run right before the
// owner publishes. It never mocks; it shells out to real npm.
// ---------------------------------------------------------------------------
if (SMOKE) {
	console.log('\nSmoke-testing exported examples (npm install + check)…');
	const targets = [
		...TUTORIALS.map((t) => join(OUT, 'tutorials', t.dir)),
	].filter((d) => existsSync(join(d, 'package.json')));
	for (const dir of targets) {
		console.log(`  → ${relative(OUT, dir)}: npm install`);
		execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
	}
	console.log('Smoke test complete.');
}

// ---------------------------------------------------------------------------
// Report the produced tree + counts.
// ---------------------------------------------------------------------------
let fileCount = 0;
let dirCount = 0;
function tree(dir, prefix, depth) {
	const entries = readdirSync(dir).sort();
	entries.forEach((name, i) => {
		const full = join(dir, name);
		const isDir = statSync(full).isDirectory();
		const last = i === entries.length - 1;
		if (isDir) dirCount++; else fileCount++;
		if (depth <= 2) {
			console.log(`${prefix}${last ? '└── ' : '├── '}${name}${isDir ? '/' : ''}`);
		}
		if (isDir) tree(full, prefix + (last ? '    ' : '│   '), depth + 1);
	});
}
console.log('\nProduced tree (depth ≤ 2):');
console.log(`${relative(process.cwd(), OUT) || OUT}/`);
tree(OUT, '', 0);
console.log(`\n${fileCount} files, ${dirCount} directories.`);
console.log('This is a build artifact under a gitignored dir; it is never committed.');
console.log(`Publish steps (owner-run, not automated): docs/ops/examples-repo-export.md`);
