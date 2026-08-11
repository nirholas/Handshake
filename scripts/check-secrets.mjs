#!/usr/bin/env node
// Stop credential material from becoming a tracked file.
//
// A leaked key in git is not a bug you fix by deleting the line: every clone,
// every fork, and every mirror keeps a copy, so the only real remedy is
// rotating the credential at the provider. That asymmetry is why this runs
// before the push rather than after, and why it is deliberately loud.
//
// Two checks, with two different scopes, for two different reasons:
//
//   1. FILENAMES, repo-wide and absolute. A real `.env`, a `.pem`, an
//      `id_ed25519`, a downloaded service-account JSON: these are credential
//      files by construction, and the tree currently contains exactly zero of
//      them. A rule with no legacy to grandfather can be absolute, so this one
//      is: any tracked path matching it fails, no diff scoping, no exceptions
//      beyond the `.env.example` style templates that exist to be committed.
//
//   2. CONTENTS, diff scoped. Added lines only, same reasoning as
//      scripts/check-rules.mjs: the tree holds thousands of hex addresses,
//      transaction signatures, hardhat test keys, and `YOUR_TOKEN` docs
//      placeholders, so a repo-wide content scan drowns in noise and gets
//      switched off. Judging only what you are adding keeps the signal high
//      enough to be worth blocking a push over.
//
// The content rules are narrow on purpose. Each one matches a credential
// format that a provider issues and nothing else looks like (a `sk-ant-` key,
// a PEM private-key block, a database URL carrying a password, a Solana
// keypair byte array). Entropy heuristics were left out: they flag build
// hashes, base64 fixtures, and minified code, and a guard that cries wolf is a
// guard someone disables.
//
// Modes (matching scripts/check-rules.mjs so the pre-push hook can drive both):
//   node scripts/check-secrets.mjs                 working tree + staged, vs HEAD
//   node scripts/check-secrets.mjs --staged        staged only
//   node scripts/check-secrets.mjs --base <ref>    everything since <ref>
//   node scripts/check-secrets.mjs --base <ref> --head <ref>   a pushed ref (hook)
//   node scripts/check-secrets.mjs --paths a.js    only these files
//   node scripts/check-secrets.mjs --all           every tracked file (full sweep)
//
// Exit 1 on any finding, with file:line and the credential class.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const staged = argv.includes('--staged');
const all = argv.includes('--all');
const baseIdx = argv.indexOf('--base');
const base = baseIdx === -1 ? null : argv[baseIdx + 1];
const headIdx = argv.indexOf('--head');
const head = headIdx === -1 ? 'HEAD' : argv[headIdx + 1];
const pathsIdx = argv.indexOf('--paths');
const paths = pathsIdx === -1 ? [] : argv.slice(pathsIdx + 1).filter((a) => !a.startsWith('--'));

const git = (args) =>
	execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

// Filename patterns that ARE credential files, whatever they contain. Kept
// separate from the content rules because the answer here does not depend on
// reading the file: nobody commits a private key deliberately.
const SECRET_FILENAMES = [
	{
		id: 'dotenv-file',
		// `.env`, `.env.local`, `.env.production`, `.env.xspace`. NOT the
		// templates whose whole job is to be committed with placeholder values.
		test: (file) => {
			const name = path.basename(file);
			if (!/^\.env(\.|$)/.test(name)) return false;
			return !/\.(example|sample|template|defaults|schema|d\.ts)$/.test(name);
		},
		why: 'a real dotenv file belongs in .gitignore, never in the tree (commit a .env.example instead)',
	},
	{
		id: 'key-file',
		test: (file) => /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i.test(file) && !/\.(public|pub)\.(pem|key)$/i.test(file),
		why: 'private-key and keystore files are credential material by construction',
	},
	{
		id: 'ssh-key',
		test: (file) => /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/.test(file),
		why: 'an SSH private key must never be tracked',
	},
	{
		id: 'cloud-credentials',
		test: (file) =>
			/(^|\/)(service[-_]account|gcp[-_]key|application_default_credentials|credentials)\.json$/i.test(file) ||
			/(^|\/)\.aws\/credentials$/.test(file),
		why: 'downloaded cloud credential files carry a live private key',
	},
];

// Generated, vendored, and binary paths. Same list-shaped reasoning as
// check-rules.mjs: machine-written content produces noise, not signal.
const SKIP_CONTENT = [
	/^dist\//,
	/^dist-lib\//,
	/(^|\/)node_modules\//,
	/^public\/chat\/assets\//,
	/^contracts\/lib\//,
	/package-lock\.json$/,
	/\.min\.(js|css)$/,
	/\.(png|jpg|jpeg|gif|webp|glb|gltf|bin|woff2?|ttf|mp4|wasm|ico|svg|pdf|zip|gz)$/i,
	// This file and its proof fixture must contain the patterns verbatim in
	// order to detect them, so scanning either reports the detector as the
	// offense. A scanner cannot scan its own pattern table.
	/^scripts\/check-secrets\.mjs$/,
	/^data\/guards\.json$/,
	/^public\/guards\.json$/,
	// The runtime scrubber and its tests exist to redact these strings, so they
	// must hold synthetic examples of every shape they redact.
	/^api\/_lib\/scrub-secrets\.js$/,
	/^tests\/scrub-secrets\.test\.js$/,
];
const skippedContent = (file) => SKIP_CONTENT.some((re) => re.test(file));

// A value that announces itself as fake. Tested against the MATCHED CREDENTIAL,
// never the whole line: line-level placeholder matching would exempt a real key
// merely for sitting on a line that contains the word "secret" or "test", which
// is most of the lines a real key ever appears on.
const FAKE_VALUE = /(x{4,}|\.\.\.|your|replace|placeholder|redacted|example|sample|dummy|fake|changeme|insert|abc123|0123456789|1234567890)/i;

// Every rule reports the substring it matched, so the message points at the
// credential rather than at 200 columns of minified line, and so `except` can
// judge the value instead of its surroundings.
const CONTENT_RULES = [
	{
		id: 'provider-api-key',
		what: 'a live API key in a provider-issued format',
		// Each alternative is a format one vendor issues and nothing else
		// produces. Lengths are the vendor minimums, so a truncated docs sample
		// ("sk-ant-...") does not match.
		find: /(sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{40,}|sk-proj-[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{48,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]{20,}|hf_[A-Za-z0-9]{34,}|nvapi-[A-Za-z0-9_-]{40,}|r8_[A-Za-z0-9]{37,}|gsk_[A-Za-z0-9]{50,}|sk-or-v1-[a-f0-9]{60,}|SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{30,}|npm_[A-Za-z0-9]{36}|dckr_pat_[A-Za-z0-9_-]{20,}|ya29\.[0-9A-Za-z_-]{60,})/,
		except: (value) => FAKE_VALUE.test(value),
	},
	{
		id: 'private-key-block',
		what: 'a PEM private-key block',
		find: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
		// This header is the one credential marker that legitimately appears in
		// prose and in code: parsers strip it, docs show the shape with an
		// ellipsis where the key bytes go. Both are line-level judgements, so
		// this rule (alone) reads the whole line.
		exceptLine: (line) => /replace\(|RegExp|match\(|split\(|includes\(|…|\.\.\.|MIGH|YOUR|\$\{/.test(line),
	},
	{
		id: 'connection-string',
		what: 'a database or broker URL carrying a real password',
		find: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[A-Za-z0-9_.-]+:([^@\s"'`/]{6,})@/,
		group: 1,
		except: (pw) => FAKE_VALUE.test(pw) || /^(pass(word)?|hunter2|s3cr3tpw|secret|creds?)$/i.test(pw) || /(secret|password|test)/i.test(pw) || /^\$\{?[A-Z_]/.test(pw),
	},
	{
		id: 'solana-keypair',
		what: 'a Solana keypair serialized as a 64-byte array',
		find: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/,
	},
	{
		id: 'ethereum-private-key',
		what: 'a 32-byte hex private key assigned to a key-shaped name',
		// The bare hex is indistinguishable from a transaction hash or a storage
		// slot, so the name on the left of the assignment is what makes this a
		// finding.
		find: /(?:private[_-]?key|privkey|secret[_-]?key|mnemonic|seed[_-]?phrase)\W{0,4}["'`]?(?:0x)?([a-fA-F0-9]{64})\b/i,
		group: 1,
		except: (hex) => {
			// The two published test keys every EVM tutorial uses (hardhat and
			// ethers account #0). Public by design, funded on nothing.
			if (/^(59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d|ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)$/i.test(hex)) return true;
			// A template's fill-me-in value: all zeroes, all f's, `deadbeef`
			// repeated. A key drawn at random uses nearly every hex digit, so a
			// 64-nibble string spanning fewer than eight distinct ones is a
			// placeholder with a probability no real key ever reaches.
			return new Set(hex.toLowerCase()).size < 8;
		},
	},
];

const findings = [];

// Apply every content rule to one line. A rule fires when its pattern matches
// and the matched value is not a declared placeholder.
function scanLine(file, lineNo, line) {
	for (const rule of CONTENT_RULES) {
		const m = rule.find.exec(line);
		if (!m) continue;
		if (rule.exceptLine && rule.exceptLine(line)) continue;
		const value = rule.group ? m[rule.group] : m[0];
		if (rule.except && rule.except(value)) continue;
		findings.push({ file, line: lineNo, id: rule.id, what: rule.what, content: value.slice(0, 24) + (value.length > 24 ? '...' : '') });
	}
}

// 1. Filenames, repo-wide. Cheap enough to run in every mode: it reads one
// `git ls-files`, and a credential file that is already tracked is a finding no
// matter which commit added it.
let trackedFiles = [];
try {
	trackedFiles = git(['ls-files']).split('\n').filter(Boolean);
} catch (err) {
	console.error(`[check-secrets] could not list tracked files: ${err.message}`);
	process.exit(1);
}
for (const file of trackedFiles) {
	for (const rule of SECRET_FILENAMES) {
		if (rule.test(file)) findings.push({ file, line: 1, id: rule.id, what: rule.why, content: path.basename(file) });
	}
}

// 2. Contents.
let filesScanned = 0;
if (all) {
	for (const file of trackedFiles) {
		if (skippedContent(file)) continue;
		let body;
		try {
			body = readFileSync(path.join(root, file), 'utf8');
		} catch {
			continue;
		}
		if (body.includes('\u0000')) continue;
		filesScanned += 1;
		const lines = body.split('\n');
		for (let i = 0; i < lines.length; i += 1) scanLine(file, i + 1, lines[i]);
	}
} else {
	let diffArgs;
	if (base) diffArgs = ['diff', '--unified=0', `${base}...${head}`];
	else if (staged) diffArgs = ['diff', '--unified=0', '--staged'];
	else diffArgs = ['diff', '--unified=0', 'HEAD'];
	if (paths.length) diffArgs = [...diffArgs, '--', ...paths];

	let diff;
	try {
		diff = git(diffArgs);
	} catch (err) {
		console.error(`[check-secrets] could not read the diff (${diffArgs.join(' ')}): ${err.message}`);
		process.exit(1);
	}

	// A brand-new file is invisible to `git diff HEAD`, and a pasted key file is
	// exactly the shape that arrives untracked. Treat its every line as added.
	if (!base) {
		const untrackedArgs = ['ls-files', '--others', '--exclude-standard'];
		if (paths.length) untrackedArgs.push('--', ...paths);
		let untracked = [];
		try {
			untracked = git(untrackedArgs).split('\n').filter(Boolean);
		} catch {
			untracked = [];
		}
		for (const f of untracked) {
			if (skippedContent(f)) continue;
			let body;
			try {
				body = readFileSync(path.join(root, f), 'utf8');
			} catch {
				continue;
			}
			if (body.includes('\u0000')) continue;
			diff += `\n+++ b/${f}\n@@ -0,0 +1 @@\n${body.split('\n').map((l) => `+${l}`).join('\n')}\n`;
		}
	}

	let file = null;
	let lineNo = 0;
	for (const raw of diff.split('\n')) {
		if (raw.startsWith('+++ ')) {
			const p = raw.slice(4).replace(/^b\//, '');
			file = p === '/dev/null' ? null : p;
			if (file && !skippedContent(file)) filesScanned += 1;
			continue;
		}
		if (raw.startsWith('@@')) {
			const m = raw.match(/\+(\d+)/);
			lineNo = m ? Number(m[1]) : 0;
			continue;
		}
		if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
		const content = raw.slice(1);
		if (file && !skippedContent(file)) scanLine(file, lineNo, content);
		lineNo += 1;
	}
}

if (findings.length) {
	console.error(`[check-secrets] ${findings.length} possible credential(s) in tracked or added content:\n`);
	for (const f of findings) {
		console.error(`[check-secrets]   ${f.file}:${f.line}  [${f.id}]`);
		console.error(`[check-secrets]     ${f.what}`);
		console.error(`[check-secrets]     > ${f.content}`);
	}
	console.error('\n[check-secrets] Remove it from the tree AND rotate the credential at the provider:');
	console.error('[check-secrets] once a key reaches git, every clone and fork keeps a copy forever.');
	console.error('[check-secrets] Real values belong in .env (gitignored), Secret Manager, or the Cloud Run service env.');
	process.exit(1);
}

const scope = all ? `${filesScanned} tracked file(s)` : `${filesScanned} changed file(s)`;
console.log(`[check-secrets] OK: no credential material in ${trackedFiles.length} tracked path(s) or ${scope}`);
