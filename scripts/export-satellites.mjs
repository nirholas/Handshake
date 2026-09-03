#!/usr/bin/env node
// One-way export: assemble the public `three-ws/examples` satellite repo from the
// monorepo. This script is the ONLY sanctioned way to build that repo's contents.
//
//   npm run export:satellites                       # build + smoke-test into dist/examples-repo/
//   node scripts/export-satellites.mjs --out DIR    # build into a custom directory
//   node scripts/export-satellites.mjs --offline    # structural build + offline checks only
//   node scripts/export-satellites.mjs --no-git     # skip the staging git history
//
// It is idempotent (wipes and rebuilds the output dir on every run) and copies a
// CURATED subset of real monorepo material into the satellite layout, rewriting
// every monorepo-relative reference to a working surface (published @three-ws/*
// npm packages, or hosted https://three.ws URLs) so nothing points back into the
// monorepo.
//
// The smoke gate runs by default and ABORTS the export on any failure, because a
// broken public example is anti-marketing. It has four stages:
//   1. structure  (offline) no monorepo-relative refs survive; every relative
//                 link resolves inside the export; every package.json parses
//   2. registry   (network) every pinned @three-ws/* version exists on npm
//   3. install    (network) npm install per staged package, then that example's
//                 own check command (npm test, else a parse check of its sources)
//   4. links      (network) every distinct https://three.ws URL returns 2xx
//
// Nothing here pushes, commits to this repo, or creates a GitHub repo. The output
// is a staging directory with a single-parent git history; the script prints the
// exact push command for the owner to run (pushing is owner-gated, CLAUDE.md gate 2).
// Satellites are strictly one-way: the monorepo is the source of truth and the
// satellite history is disposable. Never pull, fetch, or merge from one.
//
// Why a local script and not CI: GitHub Actions are unavailable on this account
// (all workflows deleted), so the satellite sync must run from the local push
// routine or it rots. See docs/ops/examples-repo-export.md.

import {
	cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname, basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const argv = process.argv.slice(2);
const OUT = (() => {
	const i = argv.indexOf('--out');
	if (i !== -1 && argv[i + 1]) return resolve(process.cwd(), argv[i + 1]);
	return join(REPO, 'dist', 'examples-repo');
})();
const OFFLINE = argv.includes('--offline');
const NO_GIT = argv.includes('--no-git');

const HOST = 'https://three.ws';
const MONOREPO_URL = 'https://github.com/nirholas/three.ws';
const SATELLITE_URL = 'https://github.com/three-ws/examples';

// ---------------------------------------------------------------------------
// Published package versions (read live from each package's own package.json),
// so a version bump in the monorepo flows into the exported examples with no
// edit here. These are the packages the examples install; all @three-ws/* are
// published on npm.
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
// Reference rewriting.
//
// A regex sweep over `../src/` is wrong: an example with its own `src/` folder
// (paid-mcp-server, sdk/example) uses exactly that spelling for its OWN files,
// and rewriting those to a hosted URL produces an example that cannot run. So
// every relative reference is RESOLVED against the file's real monorepo location
// and then routed by where it actually lands:
//
//   inside the same exported unit   -> left alone (we shipped the target)
//   another exported unit           -> re-relativised to its satellite location
//   a published package's own src/  -> that package on jsDelivr, version-pinned
//   docs/*.md                       -> the live page on three.ws
//   anything else in the monorepo   -> a permalink into the monorepo on GitHub
//
// Site-absolute paths (/dist-lib/, /avatars/, /src/) are unambiguous and become
// absolute https://three.ws URLs.
// ---------------------------------------------------------------------------

// monorepo path prefix -> satellite path prefix. Filled from the manifest below.
const SATELLITE_MAP = new Map();
// monorepo package dir -> published npm name, for units that live inside a package.
const PACKAGE_OF = new Map();

const posix = (p) => p.split('\\').join('/');
function normalizePath(p) {
	const out = [];
	for (const part of posix(p).split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') out.pop();
		else out.push(part);
	}
	return out.join('/');
}
function relativePath(fromDir, to) {
	const rel = posix(relative(fromDir || '.', to));
	return rel.startsWith('.') ? rel : `./${rel}`;
}
// Longest matching prefix in a map keyed by directory-ish paths.
function longestPrefix(map, target) {
	let best = null;
	for (const key of map.keys()) {
		if (target === key || target.startsWith(key + '/')) {
			if (!best || key.length > best.length) best = key;
		}
	}
	return best;
}

const REF_PATTERNS = [
	/(\]\()([^)\s]+)(\))/g,                                   // markdown link/image
	/((?:src|href)=")([^"]+)(")/g,                            // html attribute (double)
	/((?:src|href)=')([^']+)(')/g,                            // html attribute (single)
	/((?:from|import)\s*\(?\s*['"])([^'"]+)(['"])/g,          // esm import / dynamic import
	/((?:require)\(\s*['"])([^'"]+)(['"])/g,                  // cjs require
	/(:\s*")(\.{1,2}\/[^"]*)(")/g,                            // json value path (agent manifest skill uri)
	/(`)(\.{1,2}\/[^`\s]*)(`)/g,                              // markdown code span naming a path
];

function routeRef(ref, fromRel, toRel) {
	if (/^(https?:|mailto:|data:|#|\/\/)/.test(ref)) return null;
	if (ref.includes('${') || ref.startsWith('$')) return null;
	// Site-absolute paths become hosted URLs.
	if (ref.startsWith('/')) {
		if (/^\/(avatars|dist-lib|src|api)\//.test(ref)) return `${HOST}${ref}`;
		return null;
	}
	// Bare package specifiers are not paths.
	if (!ref.startsWith('.')) return null;

	const fromDir = posix(dirname(fromRel));
	const target = normalizePath(`${fromDir}/${ref}`);
	const unit = longestPrefix(SATELLITE_MAP, fromRel);

	// Inside the same exported unit: the target ships with it, leave it alone.
	if (unit && (target === unit || target.startsWith(unit + '/'))) return null;

	// Another exported unit: re-relativise to where that unit lives in the satellite.
	const destUnit = longestPrefix(SATELLITE_MAP, target);
	if (destUnit) {
		const satTarget = SATELLITE_MAP.get(destUnit) + target.slice(destUnit.length);
		return relativePath(posix(dirname(toRel)), satTarget);
	}

	// The unit's own package (sdk/example importing sdk/src/*): the published package.
	const pkgDir = longestPrefix(PACKAGE_OF, target);
	if (pkgDir) {
		const name = PACKAGE_OF.get(pkgDir);
		const version = PKG_VERSION[name];
		return `https://cdn.jsdelivr.net/npm/${name}@${version}${target.slice(pkgDir.length)}`;
	}

	// Documentation: the live page, not the markdown source.
	const doc = target.match(/^docs\/tutorials\/([a-z0-9-]+)\.md$/i)
		|| target.match(/^docs\/([a-z0-9-]+)\.md$/i);
	if (doc) return `${HOST}/${target.startsWith('docs/tutorials/') ? 'tutorials' : 'docs'}/${doc[1]}`;

	// Everything else in the monorepo: a permalink a reader can actually open.
	// "Can actually open" is the whole point, so the target has to exist. A
	// reference to a file that is not in the monorepo either is dead: minting a
	// permalink for it would launder a broken reference into a plausible GitHub
	// URL that 404s, and the structure stage would then see no relative path left
	// to complain about. Returning null instead leaves the original reference in
	// place so that stage flags it and aborts the export.
	if (!existsSync(join(REPO, target))) return null;
	const isDir = statSync(join(REPO, target)).isDirectory();
	return `${MONOREPO_URL}/${isDir ? 'tree' : 'blob'}/main/${target}`;
}

function rewriteRefs(text, fromRel, toRel) {
	let out = text;
	for (const pattern of REF_PATTERNS) {
		out = out.replace(pattern, (whole, open, ref, close) => {
			const routed = routeRef(ref, fromRel, toRel);
			return routed === null ? whole : `${open}${routed}${close}`;
		});
	}
	return out;
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
	pkg.repository = { type: 'git', url: `git+${SATELLITE_URL}.git` };
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
	else if (REWRITE_EXT.has(extname(toRel))) content = rewriteRefs(content, fromRel, toRel);
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

function listFiles(dir, acc = []) {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === '.git') continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) listFiles(full, acc);
		else acc.push(full);
	}
	return acc;
}

// ---------------------------------------------------------------------------
// The curated manifest: the single source of what the satellite contains.
//
// Exclusion policy: an example whose code, fixtures, or docs reference a crypto
// project other than $THREE stays OUT of this manifest until the owner approves
// that specific content (CLAUDE.md commit gate). Three examples are held out on
// exactly that basis, and each is one line away from being re-included:
//   examples/agenc-task-roundtrip  depends on a third-party agent-commerce SDK
//                                  and pins that project's on-chain program id
//   examples/pump-fun-agent        installs pump-fun-skills/, whose SKILL.md and
//   examples/three-concierge       lib carry third-party program ids, a sample
//                                  third-party mint, and a bundler integration
// An agent may only ship here if every skill its manifest installs ships too: a
// public agent with a dangling skill uri is broken for the reader who tries it.
// ---------------------------------------------------------------------------
const AGENTS = [
	{ dir: 'coach-leo', title: 'Coach Leo', shows: 'A full character agent: system prompt, manifest, and skill wiring.', run: 'Load into the three.ws agent builder (instructions.md + manifest.json).', docs: `${HOST}/docs/create-agent` },
	{ dir: 'metamask-agent-wallet', title: 'MetaMask agent wallet', shows: 'A wallet-connected agent: a localhost bridge exposing the MetaMask Agentic CLI to a demo page.', run: 'node server.mjs, then open index.html at http://localhost:4280', docs: `${HOST}/docs/agent-wallets` },
];

const QUICKSTARTS = [
	{ slug: 'sdk', pkg: '@three-ws/sdk', readme: 'sdk/README.md', section: /^## Quick start/m, exampleDir: 'sdk/example', blurb: 'The core three.ws SDK: build an agent, embed a 3D avatar, register on-chain.', docs: `${HOST}/docs/sdk` },
	{ slug: 'solana-agent-sdk', pkg: '@three-ws/solana-agent', readme: 'solana-agent-sdk/README.md', section: /^## Quick start/m, blurb: 'Solana-native agent actions, wallet providers, and x402 exact payments.', docs: `${HOST}/docs/solana` },
	{ slug: 'agent-payments-sdk', pkg: '@three-ws/agent-payments', readme: 'agent-payments-sdk/README.md', section: /^## Quick start/m, blurb: 'Agent-to-agent payments over x402 and a2a on Solana and EVM.', docs: `${HOST}/docs/a2a-payments` },
	{ slug: 'mcp-server', pkg: '@three-ws/mcp-server', readme: 'mcp-server/README.md', section: /^## Quickstart \(30 seconds\)/m, blurb: 'The three.ws MCP server: 3D generation, Solana, markets, and agent tools in Claude/Cursor.', docs: `${HOST}/docs/mcp` },
];

const EMBEDS = [
	{ file: 'minimal.html', shows: 'The smallest possible avatar embed (one script tag).' },
	{ file: 'one-line-demo.html', shows: 'A one-line embed with the model and mood set inline.' },
	{ file: 'bare-avatar.html', shows: 'A bare avatar with no chrome, sized to its container.' },
	{ file: 'two-agents.html', shows: 'Two avatars on one page, each with its own model and mood.' },
	{ file: 'web-component.html', shows: 'The viewer web component driven by multiple GLBs.' },
	{ file: 'widget-rpc.html', shows: 'Driving an embedded avatar over the widget RPC bridge.' },
	{ file: 'agent-presence.html', shows: 'An always-on agent presence widget with idle and speaking states.' },
	{ file: 'agent-wallet-embed.html', shows: 'An embedded avatar wired to a connected wallet session.' },
	{ file: 'sign-language.html', shows: 'Fingerspelling and ASL playback driven by the sign-language package.' },
];

const TUTORIALS = [
	{
		dir: 'agent-native-3d',
		title: 'Agent-native 3D',
		shows: 'An agent generates, rigs, embodies, and distributes a 3D creation end to end via the free MCP tools.',
		run: 'npm install && npm start',
		docs: `${HOST}/docs/mcp`,
		// Vendor the shared embed-snippet builders and localise the output path so
		// the script is self-contained (no monorepo src/ or _generated/ dependency).
		vendor: [{ from: 'src/forge-embed-snippets.js', to: 'lib/forge-embed-snippets.js' }],
		runTransform: (t) => t
			.replaceAll("'../../src/forge-embed-snippets.js'", "'./lib/forge-embed-snippets.js'")
			.replaceAll('../../src/forge-embed-snippets.js', './lib/forge-embed-snippets.js')
			.replaceAll("resolve(HERE, '../..')", 'HERE')
			.replaceAll("'prompts/roadmap/_generated/10'", "'out'")
			// The transcript is written next to the example here, not into the
			// monorepo's generated-artifacts tree, so name the real output path.
			.replaceAll(
				'[`prompts/roadmap/_generated/10/agent-native-3d-transcript.json`](../../prompts/roadmap/_generated/10/agent-native-3d-transcript.json)',
				'`out/agent-native-3d-transcript.json`')
			.replaceAll('prompts/roadmap/_generated/10/agent-native-3d-transcript.json', 'out/agent-native-3d-transcript.json'),
	},
	{
		dir: 'paid-mcp-server',
		title: 'Paid MCP server',
		shows: 'An MCP server whose tools charge per call in USDC on Solana over x402, with a free tool alongside a paid one.',
		run: 'npm install && X402_PAY_TO_SOLANA=<your-address> npm start',
		docs: `${HOST}/tutorials/monetize-mcp-server`,
	},
	{
		dir: 'wallet-sign-in',
		title: 'Wallet sign-in',
		shows: 'The complete Sign-In with Solana and Sign-In with Ethereum round trips against the live auth API.',
		run: 'Open index.html in a browser (it talks to the live three.ws auth API)',
		docs: `${HOST}/docs/authentication`,
		// In the monorepo the page is served same-origin behind the dev proxy. The
		// satellite copy is opened standalone, so it must default to the live API.
		runTransform: (t) => t.replaceAll(
			"const API = new URLSearchParams(location.search).get('api') || '';",
			`const API = new URLSearchParams(location.search).get('api') || '${HOST}';`),
	},
];

// Per-example check commands for the install smoke stage. An example with its
// own `test` script is checked with it; everything else gets a real parse check
// of every source file it ships, which catches a rewrite that produced invalid
// JS just as reliably and needs no credentials.
function checkCommand(dir) {
	const pkgPath = join(dir, 'package.json');
	if (existsSync(pkgPath)) {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		if (pkg.scripts?.test) return { cmd: 'npm', args: ['test'], label: 'npm test' };
	}
	const sources = listFiles(dir).filter((f) => /\.(mjs|js)$/.test(f));
	if (!sources.length) return null;
	return { cmd: process.execPath, args: ['--check', ...sources], label: `node --check (${sources.length} files)` };
}

// Extract the content of a `## Heading` section up to the next `## ` heading.
function extractSection(readmeRel, headingRe, toRel) {
	const text = readFileSync(join(REPO, readmeRel), 'utf8');
	const start = text.search(headingRe);
	if (start === -1) throw new Error(`No section matching ${headingRe} in ${readmeRel}`);
	const after = text.slice(start);
	const nextH2 = after.slice(1).search(/^## /m);
	const body = nextH2 === -1 ? after : after.slice(0, nextH2 + 1);
	return rewriteRefs(body.trim(), readmeRel, toRel);
}

// ---------------------------------------------------------------------------
// Wire the manifest into the path router: every exported unit registers where it
// came from and where it lands, so a cross-reference between two examples stays
// a working relative link instead of a 404.
// ---------------------------------------------------------------------------
for (const a of AGENTS) SATELLITE_MAP.set(`examples/${a.dir}`, `agents/${a.dir}`);
for (const t of TUTORIALS) SATELLITE_MAP.set(`examples/${t.dir}`, `tutorials/${t.dir}`);
for (const e of EMBEDS) SATELLITE_MAP.set(`examples/${e.file}`, `embeds/${e.file}`);
for (const q of QUICKSTARTS) {
	if (q.exampleDir) SATELLITE_MAP.set(q.exampleDir, `quickstarts/${q.slug}/example`);
	const pkgDir = q.exampleDir ? q.exampleDir.split('/')[0] : null;
	if (pkgDir) PACKAGE_OF.set(pkgDir, q.pkg);
}
SATELLITE_MAP.set('examples/skills', 'skills');

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
console.log(`Exporting satellite -> ${relative(process.cwd(), OUT) || OUT}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// LICENSE (carried verbatim from the monorepo).
copyFile('LICENSE', 'LICENSE');

// .gitignore for the satellite working tree.
writeOut('.gitignore', ['node_modules/', '.cache/', 'out/', 'dist/', '.DS_Store', ''].join('\n'));

const provenance = [
	'',
	'---',
	'',
	`Source of truth: the [three.ws monorepo](${MONOREPO_URL}). Issues and pull requests belong there.`,
	'This repository is a one-way export and accepts no direct contributions.',
	'',
].join('\n');

// agents/
for (const a of AGENTS) {
	copyDir(`examples/${a.dir}`, `agents/${a.dir}`);
	const readme = join(OUT, 'agents', a.dir, 'README.md');
	if (existsSync(readme)) {
		writeFileSync(readme, readFileSync(readme, 'utf8').trimEnd() + '\n' + provenance);
	} else {
		writeOut(`agents/${a.dir}/README.md`, [
			`# ${a.title}`, '', a.shows, '',
			'## Run', '', '```', a.run, '```', '',
			`Docs: ${a.docs}`, provenance,
		].join('\n'));
	}
}
writeOut('agents/README.md', [
	'# Agents', '',
	'Complete agent builds: system prompt, manifest, skills, and (where the agent',
	'transacts) its on-chain identity. Each one runs on three.ws as written.', '',
	'| Example | What it shows | Run |', '|---|---|---|',
	...AGENTS.map((a) => `| [${a.title}](${a.dir}) | ${a.shows} | \`${a.run}\` |`),
	provenance,
].join('\n'));

// embeds/
for (const e of EMBEDS) copyFile(`examples/${e.file}`, `embeds/${e.file}`);
writeOut('embeds/README.md', [
	'# Embeds', '',
	'Single-file HTML patterns for putting a three.ws 3D avatar on any page. Every',
	`asset URL points at ${HOST}. Open any file directly in a browser: no build step,`,
	'no install, no account.', '',
	'| File | Shows |', '|---|---|',
	...EMBEDS.map((e) => `| [\`${e.file}\`](${e.file}) | ${e.shows} |`),
	'',
	`Full embedding guide: ${HOST}/docs/embedding`,
	provenance,
].join('\n'));

// quickstarts/
for (const q of QUICKSTARTS) {
	const version = PKG_VERSION[q.pkg];
	const section = extractSection(q.readme, q.section, `quickstarts/${q.slug}/README.md`);
	if (q.exampleDir) copyDir(q.exampleDir, `quickstarts/${q.slug}/example`);
	writeOut(`quickstarts/${q.slug}/README.md`, [
		`# ${q.pkg} quickstart`, '', q.blurb, '',
		'## Install', '', '```bash', `npm install ${q.pkg}@^${version}`, '```', '',
		section, '',
		`Package: https://www.npmjs.com/package/${q.pkg} · Docs: ${q.docs}`,
		q.exampleDir ? '\nRunnable browser demo under [`example/`](example/).' : '',
		provenance,
	].join('\n'));
}
writeOut('quickstarts/README.md', [
	'# Quickstarts', '',
	'One folder per published SDK: install line, minimal working code, and a link to',
	'the full reference. Every version below is the version live on npm right now.', '',
	'| SDK | Install | Docs |', '|---|---|---|',
	...QUICKSTARTS.map((q) => `| [${q.pkg}](${q.slug}) | \`npm install ${q.pkg}@^${PKG_VERSION[q.pkg]}\` | [reference](${q.docs}) |`),
	provenance,
].join('\n'));

// tutorials/
for (const t of TUTORIALS) {
	copyDir(`examples/${t.dir}`, `tutorials/${t.dir}`, { extra: t.runTransform });
	for (const v of t.vendor || []) copyFile(v.from, `tutorials/${t.dir}/${v.to}`);
	const readme = join(OUT, 'tutorials', t.dir, 'README.md');
	if (existsSync(readme)) {
		writeFileSync(readme, readFileSync(readme, 'utf8').trimEnd() + '\n' + provenance);
	} else {
		writeOut(`tutorials/${t.dir}/README.md`, [
			`# ${t.title}`, '', t.shows, '',
			'## Run', '', '```bash', t.run, '```', '',
			`Walkthrough: ${t.docs}`, provenance,
		].join('\n'));
	}
}
writeOut('tutorials/README.md', [
	'# Tutorials', '',
	'Long-form, runnable walkthroughs. Each folder is a working project; the linked',
	'page on three.ws is the narrative version of the same code.', '',
	'| Walkthrough | What it shows | Run |', '|---|---|---|',
	...TUTORIALS.map((t) => `| [${t.title}](${t.dir}) | ${t.shows} | \`${t.run}\` |`),
	provenance,
].join('\n'));

// skills/
copyDir('examples/skills', 'skills');
if (!existsSync(join(OUT, 'skills', 'README.md'))) {
	writeOut('skills/README.md', [
		'# Skills', '',
		'Drop-in agent skills: a manifest, its tool definitions, and real handlers. Point',
		'an agent at one of these folders to give it that capability.',
		provenance,
	].join('\n'));
}

// Root README: the index the whole repo is discovered through.
const row = (name, path, shows, run) => `| [${name}](${path}) | ${shows} | \`${run}\` |`;
writeOut('README.md', [
	'# three.ws examples', '',
	'Runnable examples, SDK quickstarts, and embed patterns for [three.ws](https://three.ws):',
	'a platform where AI agents are embodied as 3D avatars, registered on-chain, and wired to',
	'real Solana and payment rails.', '',
	'> **Source of truth is the monorepo.** This repo is a one-way export. File issues and',
	`> pull requests at **${MONOREPO_URL}**, not here. Direct contributions to this repo are`,
	'> not accepted. Nothing here is pulled back into the monorepo.', '',
	'Every example is smoke-tested before export: the packages install, the sources parse,',
	'the tests pass, and every link resolves. Nothing here is a sketch.', '',
	'## Quickstarts', '',
	'| SDK | Install | Docs |', '|---|---|---|',
	...QUICKSTARTS.map((q) => `| [${q.pkg}](quickstarts/${q.slug}) | \`npm install ${q.pkg}@^${PKG_VERSION[q.pkg]}\` | [reference](${q.docs}) |`),
	'',
	'## Agents', '',
	'| Example | What it shows | Run |', '|---|---|---|',
	...AGENTS.map((a) => row(a.title, `agents/${a.dir}`, a.shows, a.run)),
	'',
	'## Embeds', '',
	'| Pattern | What it shows |', '|---|---|',
	...EMBEDS.map((e) => `| [${e.file}](embeds/${e.file}) | ${e.shows} |`),
	'',
	'## Tutorials', '',
	'| Walkthrough | What it shows | Run |', '|---|---|---|',
	...TUTORIALS.map((t) => row(t.title, `tutorials/${t.dir}`, t.shows, t.run)),
	'',
	'## Skills', '',
	'Reusable skill definitions (manifest + tools + handlers) under [`skills/`](skills):',
	'drop-in capabilities for pump.fun trading, strategy, and Solana wallet flows.', '',
	'---', '',
	`Docs: ${HOST}/docs · Changelog: ${HOST}/changelog · Live platform: ${HOST}`,
	'',
].join('\n'));

// ---------------------------------------------------------------------------
// Smoke gate. Any failure aborts the export: the staging tree is left in place
// for inspection but the process exits non-zero so nothing downstream publishes it.
// ---------------------------------------------------------------------------
const failures = [];
const fail = (stage, detail) => failures.push(`[${stage}] ${detail}`);

// Stage 1: structure (offline).
console.log('\nSmoke 1/4 structure: dangling references, escaped paths, package manifests');
const staged = listFiles(OUT);
// Every `../`-prefixed path, whether it sits in a link, an import, or prose. The
// test is the same for all of them: does it resolve to something we shipped? A
// reference that escapes the export is a monorepo leak; one that resolves is an
// example referring to its own files, which is correct and must not be rewritten.
const ESCAPING_REF = /(?:\.\.\/)+[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\/?/g;
const IN_LINK = /(?:\]\(|(?:src|href)=["']|(?:from|import|require)\s*\(?\s*['"])(?!https?:|mailto:|data:|#|\/)([^"')#\s]+)/g;
for (const file of staged) {
	if (!REWRITE_EXT.has(extname(file))) continue;
	const rel = relative(OUT, file);
	const text = readFileSync(file, 'utf8');
	if (/["']file:/.test(text)) fail('structure', `${rel} still declares a file: dependency`);
	if (basename(file) === 'package.json') {
		try { JSON.parse(text); } catch (e) { fail('structure', `${rel} is not valid JSON: ${e.message}`); }
		continue;
	}
	for (const m of text.matchAll(ESCAPING_REF)) {
		const target = resolve(dirname(file), m[0]);
		if (!target.startsWith(OUT + '/')) {
			fail('structure', `${rel} escapes the export: ${m[0]}`);
		} else if (!existsSync(target)) {
			fail('structure', `${rel} references missing ${m[0]}`);
		}
	}
	for (const m of text.matchAll(IN_LINK)) {
		const target = m[1];
		if (!target || target.startsWith('$') || target.includes('${')) continue;
		if (!target.startsWith('.')) continue;
		if (!existsSync(resolve(dirname(file), target))) {
			fail('structure', `${rel} links to missing ${target}`);
		}
	}
}
console.log(`  ${staged.length} files checked`);

// Collect the staged packages and the hosted URLs once; used by later stages.
const stagedPackages = staged
	.filter((f) => basename(f) === 'package.json')
	.map((f) => dirname(f));
const hostedUrls = [...new Set(
	staged.filter((f) => REWRITE_EXT.has(extname(f)))
		.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/https:\/\/three\.ws\/[^\s"'`)\]}>,;]+/g)].map((m) => m[0].replace(/[.]+$/, '')))
)];

if (OFFLINE) {
	console.log('\nSmoke 2-4 skipped (--offline): registry, install, and link stages need network.');
} else {
	// Stage 2: registry.
	console.log('\nSmoke 2/4 registry: pinned @three-ws/* versions exist on npm');
	for (const [name, version] of Object.entries(PKG_VERSION)) {
		try {
			const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: 'pipe' }).trim();
			if (!out) throw new Error('no matching version published');
			console.log(`  ${name}@${version} ok`);
		} catch (e) {
			fail('registry', `${name}@${version} does not resolve on npm (${String(e.message).split('\n')[0]})`);
		}
	}

	// Stage 3: install + per-example check.
	console.log("\nSmoke 3/4 install: npm install + each example's own check command");
	for (const dir of stagedPackages) {
		const rel = relative(OUT, dir);
		try {
			execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'pipe' });
			console.log(`  ${rel}: npm install ok`);
		} catch (e) {
			fail('install', `${rel}: npm install failed\n${String(e.stderr || e.stdout || '').slice(-800)}`);
			continue;
		}
		const check = checkCommand(dir);
		if (!check) { console.log(`  ${rel}: no sources to check`); continue; }
		try {
			execFileSync(check.cmd, check.args, { cwd: dir, stdio: 'pipe' });
			console.log(`  ${rel}: ${check.label} ok`);
		} catch (e) {
			fail('install', `${rel}: ${check.label} failed\n${String(e.stderr || e.stdout || '').slice(-800)}`);
		}
	}
	// Packages are not the only runnable material: parse-check every staged
	// script that lives outside a package too.
	const looseScripts = staged.filter((f) => /\.(mjs|js)$/.test(f)
		&& !stagedPackages.some((p) => f.startsWith(p + '/')));
	if (looseScripts.length) {
		try {
			execFileSync(process.execPath, ['--check', ...looseScripts], { stdio: 'pipe' });
			console.log(`  loose scripts: node --check ok (${looseScripts.length} files)`);
		} catch (e) {
			fail('install', `loose scripts failed to parse\n${String(e.stderr || '').slice(-800)}`);
		}
	}

	// Stage 4: hosted link liveness.
	console.log(`\nSmoke 4/4 links: ${hostedUrls.length} distinct ${HOST} URLs`);
	const results = await Promise.all(hostedUrls.map(async (url) => {
		try {
			let res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
			if (res.status === 405 || res.status === 501) res = await fetch(url, { redirect: 'follow' });
			return { url, status: res.status };
		} catch (e) {
			return { url, status: 0, error: e.message };
		}
	}));
	// A POST-only API endpoint answers 405 to a GET. That proves the route exists,
	// which is exactly what this stage is checking; a missing route answers 404.
	const live = (r) => (r.status >= 200 && r.status < 300) || r.status === 405;
	for (const r of results) {
		if (live(r)) continue;
		fail('links', `${r.url} -> ${r.error ? r.error : r.status}`);
	}
	console.log(`  ${results.filter(live).length}/${results.length} reachable`);
}

if (failures.length) {
	console.error(`\nEXPORT ABORTED: ${failures.length} smoke failure(s). Nothing is publishable.\n`);
	for (const f of failures) console.error(`  ${f}`);
	console.error(`\nStaging tree left at ${OUT} for inspection. Fix the example in the monorepo`);
	console.error('(it is broken for real users too), then re-run the export.');
	process.exit(1);
}
console.log('\nSmoke gate passed.');

// ---------------------------------------------------------------------------
// Single-parent git history in staging, and the push command for the owner.
// ---------------------------------------------------------------------------
if (!NO_GIT) {
	const git = (...args) => execFileSync('git', args, { cwd: OUT, stdio: 'pipe', encoding: 'utf8' });
	const sourceSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
	git('init', '--quiet', '--initial-branch=main');
	git('add', '-A');
	git('-c', 'user.name=three.ws export', '-c', 'user.email=export@three.ws',
		'commit', '--quiet', '-m', `Export examples from the three.ws monorepo at ${sourceSha}`);
	const count = git('rev-list', '--count', 'HEAD').trim();
	console.log(`\nStaging history: ${count} commit on main, source ${sourceSha}.`);
}

// ---------------------------------------------------------------------------
// Report the produced tree + counts.
// ---------------------------------------------------------------------------
let fileCount = 0;
let dirCount = 0;
function tree(dir, prefix, depth) {
	const entries = readdirSync(dir).filter((n) => n !== '.git' && n !== 'node_modules').sort();
	entries.forEach((name, i) => {
		const full = join(dir, name);
		const isDir = statSync(full).isDirectory();
		const last = i === entries.length - 1;
		if (isDir) dirCount++; else fileCount++;
		if (depth <= 1) console.log(`${prefix}${last ? '`-- ' : '|-- '}${name}${isDir ? '/' : ''}`);
		if (isDir) tree(full, prefix + (last ? '    ' : '|   '), depth + 1);
	});
}
console.log('\nProduced tree (depth <= 2):');
console.log(`${relative(process.cwd(), OUT) || OUT}/`);
tree(OUT, '', 0);
console.log(`\n${fileCount} files, ${dirCount} directories (node_modules excluded).`);
console.log('This is a build artifact under a gitignored dir; it is never committed here.');

console.log('\nOwner actions to publish (nothing above touched a remote):');
console.log('  1. Create the org (GitHub UI: https://github.com/organizations/plan) and the repo:');
console.log('       gh repo create three-ws/examples --public \\');
console.log('         --description "Runnable examples, SDK quickstarts, and embed patterns for three.ws"');
console.log('  2. Push this staging tree:');
console.log(`       git -C ${OUT} remote add satellite ${SATELLITE_URL}.git`);
console.log(`       git -C ${OUT} push --force satellite main`);
console.log('\nNever pull, fetch, or merge from the satellite. It is one-way.');
console.log('Runbook: docs/ops/examples-repo-export.md');
