#!/usr/bin/env node
/**
 * .gcloudignore smoke test: what would `gcloud builds submit` actually upload?
 *
 * Why this exists
 * ---------------
 * `.gcloudignore` is an allowlist: it excludes everything at the repo root
 * (`/*`) and re-includes named paths. That shape has failed in production twice
 * in ways the build itself could not catch, because a MISSING re-include is not
 * a build error. It is a runtime `ERR_MODULE_NOT_FOUND` in every deployed
 * revision:
 *
 *   · `agents/` was never re-included, so `api/x402/fact-check.js` and
 *     `api/x402/tutor.js` 500'd on every request until it was found in live
 *     Cloud Run stderr.
 *   · the sniper image's Dockerfile copies the root manifests + `api/` +
 *     `agent-payments-sdk/`, which the earlier workers-only allowlist omitted,
 *     so `COPY package.json` failed the build.
 *
 * The mirror-image risk is the one that does not announce itself at all: a
 * re-include broad enough to sweep a SECRET into the build context. `.env`,
 * `.env.local`, `.x402-ring-secrets.json`, TLS keys and exported log dumps all
 * live in the working tree, and an upload is a copy we do not control.
 *
 * This script resolves the real `.gcloudignore` against the real tree with the
 * same semantics gcloud uses (gitignore syntax, last match wins, an excluded
 * directory is pruned and its children cannot be re-included), then asserts
 * both directions:
 *
 *   FORBIDDEN: no secret-shaped file may appear in the upload set.
 *   REQUIRED:  the inputs the images copy must appear in the upload set.
 *
 * Dependency-free by design: it runs anywhere gcloud does, including a clean
 * deploy worktree with no node_modules.
 *
 * Usage:
 *   node scripts/check-gcloudignore.mjs                      # assert; exit 1 on failure
 *   node scripts/check-gcloudignore.mjs --list               # + per-top-level-dir summary
 *   node scripts/check-gcloudignore.mjs --ignore-file <path> # dry-run a PROPOSED ruleset
 *   npm run check:gcloudignore
 *
 * `--ignore-file` resolves a candidate ruleset against this same tree, so a
 * change to `.gcloudignore` can be proved safe before it is committed. The
 * upload root is always the repo root. The question is only ever "what would
 * these rules ship?".
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const IGNORE_FILE = path.join(REPO_ROOT, '.gcloudignore');

// Files that must NEVER enter a build context, matched against the basename so
// a copy in any re-included subdirectory is caught too. Kept as globs (not
// regexes) so the list reads like the thing it protects.
//
// `sniff: true` marks the two extensions that are ambiguous by name: `.pem` and
// `.key` hold private keys AND public certificates, and vendored dependencies
// ship CA bundles (pip's certifi, for one). Name alone would make this check
// cry wolf on a public trust store, and a check that cries wolf is a check
// people stop reading. So those two are confirmed against their BYTES: a PEM
// private-key header, or a non-PEM `.key` we cannot prove is public, before
// they fail the run. Everything else fails on the name, because there is no
// benign `.env` or ring-secrets file.
const FORBIDDEN = [
	{ glob: '.env' },
	{ glob: '.env.local' },
	{ glob: '.env.*.local' },
	{ glob: '.x402-ring-secrets.json' },
	{ glob: 'three.ws-log-export-*.json' },
	// Worker signing-key caches. workers/agora-citizens/.cache holds one raw
	// Solana secret key per citizen (a bare JSON byte array, no PEM armour and no
	// telltale extension, so nothing else in this list would catch it). They are
	// gitignored, but .gcloudignore replaces .gitignore rather than extending it,
	// so without an explicit rule every Cloud Build submit shipped the fleet's
	// private keys into the source bucket.
	{ glob: 'workers/*/.cache/*' },
	{ glob: '*.pem', sniff: true },
	{ glob: '*.key', sniff: true },
];

// PEM armour for every private-key flavour we could plausibly ship: PKCS#1
// (RSA/EC/DSA), PKCS#8 (plain + encrypted) and OpenSSH.
const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/;
const PUBLIC_ARMOUR_MARKER = /-----BEGIN (?:CERTIFICATE|PUBLIC KEY|TRUSTED CERTIFICATE|X509 CRL|CERTIFICATE REQUEST)-----/;

/**
 * Decide whether an ambiguous `.pem`/`.key` file is actually secret material.
 * Reads the file rather than guessing from its name. Unreadable or binary
 * content is treated as secret: this check exists to be wrong in the safe
 * direction.
 *
 * @returns {{ secret: boolean, note: string }}
 */
function sniffKeyMaterial(absPath) {
	let head;
	try {
		head = readFileSync(absPath).subarray(0, 65536).toString('utf8');
	} catch {
		return { secret: true, note: 'unreadable, treated as secret' };
	}
	if (PRIVATE_KEY_MARKER.test(head)) return { secret: true, note: 'contains a PEM private key' };
	if (PUBLIC_ARMOUR_MARKER.test(head)) {
		return { secret: false, note: 'public certificate material only' };
	}
	return { secret: true, note: 'no public-certificate armour, treated as secret' };
}

// Inputs the Dockerfiles copy / the server reads at runtime. A directory entry
// passes when at least one file under it survives the ignore file. An entry
// that does not exist in this tree is reported and skipped, never failed. The
// check is about the ignore rules, not about which optional packs are present.
const REQUIRED = [
	{ path: 'server', kind: 'dir', why: 'server/index.mjs is the Cloud Run entrypoint' },
	{ path: 'api', kind: 'dir', why: 'every api/** handler the server routes to' },
	{ path: 'package.json', kind: 'file', why: 'npm ci in the image build' },
	{ path: 'vercel.json', kind: 'file', why: 'live route table + cron list read by the server' },
	{ path: 'Dockerfile', kind: 'file', why: 'the root image build' },
	{ path: 'agents', kind: 'dir', why: 'api/x402/fact-check.js + tutor.js import ../../agents/*' },
	{ path: 'agent-payments-sdk', kind: 'dir', why: 'copied by the sniper image build' },
	{
		path: '.agents/skills',
		kind: 'dir',
		why: "workers/okx-chat-bot's image copies it; without it the chat bot's AI subsession boots with no skills",
	},
	{ path: 'data', kind: 'dir', why: 'handlers read data/*.json at runtime' },
	{
		path: 'tests/fixtures/fact-check-benchmark.json',
		kind: 'file',
		why: 'api/fact-check-benchmark.js renders it; api/cron/fact-check-benchmark.js runs it',
	},
	{ path: 'public', kind: 'dir', why: 'static assets served by the container' },
	{
		path: 'services/home-relay/src/token.js',
		kind: 'file',
		why: 'api/_lib/home/relay.js imports it; without it /api/healthz 500s ERR_MODULE_NOT_FOUND',
	},
	{
		path: 'services/home-satellite/src/token.js',
		kind: 'file',
		why: 'api/home/satellite.js imports it; same ERR_MODULE_NOT_FOUND shape',
	},
];

// ── gitignore-syntax matcher ─────────────────────────────────────────────────
// Only the semantics gcloud implements: `#` comments, `!` negation, a trailing
// `/` for directory-only, anchoring when the pattern contains a non-trailing
// `/`, `*` that does not cross a separator, `?`, `[...]` classes, and `**`.

function escapeLiteral(ch) {
	return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Translate one gitignore glob body into a regular expression source. */
function globToRegExpSource(glob) {
	let src = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				// `**` crosses separators. `/**/` collapses to "zero or more dirs".
				i++;
				if (glob[i + 1] === '/') {
					i++;
					src += '(?:.*/)?';
				} else {
					src += '.*';
				}
			} else {
				src += '[^/]*';
			}
			continue;
		}
		if (ch === '?') {
			src += '[^/]';
			continue;
		}
		if (ch === '[') {
			const close = glob.indexOf(']', i + 1);
			if (close === -1) {
				src += '\\[';
				continue;
			}
			let cls = glob.slice(i + 1, close);
			if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
			src += `[${cls}]`;
			i = close;
			continue;
		}
		src += escapeLiteral(ch);
	}
	return src;
}

/** Parse one .gcloudignore line into a matcher, or null for blank/comment. */
function parsePattern(rawLine) {
	let line = rawLine.replace(/\r$/, '');
	if (!line.trim() || line.trimStart().startsWith('#')) return null;
	// Trailing whitespace is insignificant unless escaped.
	line = line.replace(/(?<!\\)\s+$/, '');
	if (!line) return null;

	let negated = false;
	if (line.startsWith('!')) {
		negated = true;
		line = line.slice(1);
	} else if (line.startsWith('\\!')) {
		line = line.slice(1);
	}

	let dirOnly = false;
	if (line.endsWith('/')) {
		dirOnly = true;
		line = line.slice(0, -1);
	}
	if (!line) return null;

	// A `/` anywhere but the (already stripped) trailing position anchors the
	// pattern to the ignore file's directory. Otherwise it matches at any depth.
	const anchored = line.includes('/');
	if (line.startsWith('/')) line = line.slice(1);

	const body = globToRegExpSource(line);
	const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
	return { negated, dirOnly, regexp: new RegExp(source), raw: rawLine.trim() };
}

function loadPatterns(text) {
	return text.split('\n').map(parsePattern).filter(Boolean);
}

/**
 * Is `relPath` (POSIX, relative to the upload root) included in the upload?
 * Last matching pattern wins; default is included.
 */
function decide(patterns, relPath, isDir) {
	let included = true;
	let by = null;
	for (const pattern of patterns) {
		if (pattern.dirOnly && !isDir) continue;
		if (!pattern.regexp.test(relPath)) continue;
		included = pattern.negated;
		by = pattern;
	}
	return { included, by };
}

// ── Walk the tree exactly as gcloud does ─────────────────────────────────────
// An excluded directory is pruned: gcloud never descends into it, so a `!` rule
// underneath it can never re-include anything. Reproducing the pruning (rather
// than testing paths in isolation) is what makes this a faithful simulation.
function collectUpload(patterns) {
	const files = [];
	const dirs = [];
	const walk = (absDir, relDir) => {
		let entries;
		try {
			entries = readdirSync(absDir, { withFileTypes: true });
		} catch {
			return; // unreadable directory: nothing to upload from it
		}
		for (const entry of entries) {
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			const abs = path.join(absDir, entry.name);
			// Symlinks are uploaded by value; treat them as the file they name.
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = statSync(abs).isDirectory();
				} catch {
					continue; // broken symlink: gcloud skips it
				}
			}
			const verdict = decide(patterns, rel, isDir);
			if (!verdict.included) continue;
			if (isDir) {
				dirs.push(rel);
				walk(abs, rel);
			} else {
				files.push(rel);
			}
		}
	};
	walk(REPO_ROOT, '');
	return { files, dirs };
}

// ── Assertions ───────────────────────────────────────────────────────────────

function globMatcher(glob) {
	return new RegExp(`^${globToRegExpSource(glob)}$`);
}

function findForbidden(files) {
	const matchers = FORBIDDEN.map((entry) => ({ ...entry, regexp: globMatcher(entry.glob) }));
	const secrets = [];
	const cleared = [];
	for (const file of files) {
		const base = file.slice(file.lastIndexOf('/') + 1);
		for (const matcher of matchers) {
			if (!matcher.regexp.test(base) && !matcher.regexp.test(file)) continue;
			if (matcher.sniff) {
				const verdict = sniffKeyMaterial(path.join(REPO_ROOT, file));
				(verdict.secret ? secrets : cleared).push({
					file,
					glob: matcher.glob,
					note: verdict.note,
				});
			} else {
				secrets.push({ file, glob: matcher.glob, note: 'secret by name' });
			}
			break;
		}
	}
	return { secrets, cleared };
}

function checkRequired(files) {
	const failures = [];
	const skipped = [];
	const fileSet = new Set(files);
	for (const req of REQUIRED) {
		if (!existsSync(path.join(REPO_ROOT, req.path))) {
			skipped.push(req);
			continue;
		}
		const ok =
			req.kind === 'file'
				? fileSet.has(req.path)
				: files.some((f) => f.startsWith(`${req.path}/`));
		if (!ok) failures.push(req);
	}
	return { failures, skipped };
}

function summarise(files) {
	const byTop = new Map();
	for (const file of files) {
		const top = file.includes('/') ? file.slice(0, file.indexOf('/')) : '(root files)';
		byTop.set(top, (byTop.get(top) || 0) + 1);
	}
	return [...byTop].sort((a, b) => b[1] - a[1]);
}

function main() {
	const argv = process.argv.slice(2);
	const listMode = argv.includes('--list');
	const ignoreArg = argv.indexOf('--ignore-file');
	const ignoreFile =
		ignoreArg >= 0 && argv[ignoreArg + 1]
			? path.resolve(process.cwd(), argv[ignoreArg + 1])
			: IGNORE_FILE;

	if (!existsSync(ignoreFile)) {
		console.error(`FAIL: ignore file not found: ${ignoreFile}`);
		console.error('  Without it, gcloud falls back to .gitignore and the upload set is unverified.');
		process.exitCode = 1;
		return;
	}

	const patterns = loadPatterns(readFileSync(ignoreFile, 'utf8'));
	const { files, dirs } = collectUpload(patterns);

	console.log('.gcloudignore upload simulation');
	console.log(`  rules:      ${path.relative(REPO_ROOT, ignoreFile) || '.gcloudignore'}`);
	console.log(`  patterns:   ${patterns.length}`);
	console.log(`  uploaded:   ${files.length} file(s) across ${dirs.length} director(ies)`);

	if (listMode) {
		console.log('  by top level:');
		for (const [top, count] of summarise(files)) {
			console.log(`    ${String(count).padStart(6)}  ${top}`);
		}
	}

	const { secrets, cleared } = findForbidden(files);
	const { failures, skipped } = checkRequired(files);

	if (skipped.length) {
		console.log(
			`  not in this tree (skipped): ${skipped.map((s) => s.path).join(', ')}`,
		);
	}

	let failed = false;

	if (secrets.length) {
		failed = true;
		console.error(`\nFAIL: ${secrets.length} secret-shaped file(s) would be uploaded:`);
		for (const hit of secrets) console.error(`  ${hit.file}  (${hit.glob}: ${hit.note})`);
		console.error(
			'\n  Fix: exclude the path in .gcloudignore (a later pattern wins), or move the\n' +
				'  file out of the re-included directory. Never rely on the Dockerfile to skip\n' +
				'  it. The upload happens before any build step runs.',
		);
	} else {
		console.log('  secrets:    none of the forbidden patterns would be uploaded');
	}

	if (cleared.length && listMode) {
		console.log(`  key-shaped but public (${cleared.length}):`);
		for (const hit of cleared) console.log(`    ${hit.file}: ${hit.note}`);
	} else if (cleared.length) {
		console.log(
			`  cleared:    ${cleared.length} key-shaped file(s) verified public (--list to see them)`,
		);
	}

	if (failures.length) {
		failed = true;
		console.error(`\nFAIL: ${failures.length} required input(s) would be EXCLUDED:`);
		for (const req of failures) console.error(`  ${req.path}:  ${req.why}`);
		console.error(
			'\n  Fix: add a `!/<path>/` re-include to .gcloudignore. A missing re-include is\n' +
				'  not a build error. It surfaces as ERR_MODULE_NOT_FOUND in production.',
		);
	} else {
		console.log('  required:   every required build input survives the ignore rules');
	}

	if (failed) {
		process.exitCode = 1;
		return;
	}
	console.log('\nOK: the build context is complete and carries no secrets.');
}

main();
