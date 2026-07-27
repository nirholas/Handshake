#!/usr/bin/env node
// i18n-backfill: find and re-translate copy that silently stayed in English.
//
// `i18n:translate` only fills keys that are MISSING from a locale. That is the
// right default, but it interacts badly with one failure mode: when the
// translation backend is unreachable (an expired credential, a quota wall), the
// pipeline bakes the English source into the locale so the catalog stays
// lint-clean and the runtime degrades gracefully. Those keys are now PRESENT,
// so every later run skips them. The locale is permanently English and nothing
// reports it: lint is green, the key count is complete, the language picker
// still offers the language.
//
// This tool closes that hole. It compares each locale against the source, finds
// values that are byte-identical to English, removes them, and re-runs the
// translator so they come back as real copy.
//
// Safety: removing a key can never blank the UI. src/i18n.js resolves a missing
// OR empty value against the English catalog, so a locale mid-backfill renders
// exactly what it rendered before. The translator saves after every chunk, so an
// interrupted run keeps everything it finished and re-running resumes.
//
// Only MULTI-WORD phrases are considered. A single word that matches English is
// usually correct ("Avatar", "Solana", "3D", "OK") and re-translating it wastes
// calls and risks damaging a right answer.
//
// Usage:
//   node scripts/i18n-backfill.mjs                      # report only (default)
//   node scripts/i18n-backfill.mjs --apply              # repair every locale
//   node scripts/i18n-backfill.mjs --apply --locale=de  # one locale
//   node scripts/i18n-backfill.mjs --apply --min=200    # skip near-clean locales
//   node scripts/i18n-backfill.mjs --apply --provider=gemini
//
// Flags: --apply (write; default is a dry-run report), --locale=xx (one locale),
//        --min=N (skip locales with fewer than N untranslated phrases, default 20),
//        --provider=/--model= (passed through to i18n-translate.mjs),
//        --all-locales (also repair locales missing from the manifest, which no
//        visitor can select yet; by default only shipped languages are repaired).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, loadConfig } from './lib/i18n-shared.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
	const hit = args.find((a) => a.startsWith(`--${n}=`));
	return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const cfg = loadConfig();
const APPLY = flag('apply');
const MIN = Number(opt('min') ?? 20);
// A locale absent from the manifest cannot be chosen in the language picker, so
// it never gets ahead of one that visitors can actually read.
const SHIPPED_ONLY = !flag('all-locales');
const localeDir = (code) => resolve(ROOT, cfg.output, `${code}.json`);
const readJSON = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

/** Flatten a nested catalog to dot-path → string, ignoring non-strings. */
export function flatten(node, prefix = '', out = {}) {
	for (const [key, value] of Object.entries(node || {})) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
		else if (typeof value === 'string') out[path] = value;
	}
	return out;
}

/**
 * Locale codes another i18n-translate process is writing right now, read from
 * the process table. Matches both `--locale=de` and `--repair --locale=de`.
 * Exported for tests; returns an empty set wherever `ps` is unavailable, which
 * degrades to the old always-proceed behaviour rather than blocking the tool.
 */
export function translatingLocales(psOutput) {
	const out =
		psOutput ?? spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout ?? '';
	const codes = new Set();
	for (const line of out.split('\n')) {
		if (!line.includes('i18n-translate.mjs')) continue;
		const m = /--locale=([A-Za-z-]+)/.exec(line);
		if (m) codes.add(m[1]);
	}
	return codes;
}

/** A value worth re-translating: identical to English, and more than one word. */
export const untranslated = (value, english) =>
	typeof english === 'string' && value === english && /\s/.test(english.trim());

/** Copy of `node` without the untranslated leaves, pruning emptied branches. */
export function prune(node, english) {
	const out = {};
	for (const [key, value] of Object.entries(node || {})) {
		const ref = (english || {})[key];
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const sub = prune(value, ref && typeof ref === 'object' ? ref : {});
			if (Object.keys(sub).length) out[key] = sub;
		} else if (typeof value === 'string') {
			if (!untranslated(value, ref)) out[key] = value;
		} else {
			out[key] = value;
		}
	}
	return out;
}

// The CLI. Importing this module (tests) defines the helpers and runs nothing.
function main() {
	const source = readJSON(resolve(ROOT, cfg.entry));
	if (!source) {
		console.error(`Source catalog not found: ${cfg.entry}. Run \`npm run i18n:extract\` first.`);
		process.exit(1);
	}
	const englishFlat = flatten(source);

	const manifestPath = resolve(ROOT, cfg.output, 'manifest.json');
	const shipped = new Set((readJSON(manifestPath)?.locales || []).map((l) => l.code));

	const only = opt('locale');
	const codes = (only ? [only] : cfg.outputLocales).filter(
		(code) => code && code !== cfg.entryLocale && existsSync(localeDir(code)),
	);

	// Worst first, so an interrupted run has already fixed the biggest gaps.
	const survey = codes
		.map((code) => {
			const flat = flatten(readJSON(localeDir(code)));
			const stale = Object.keys(flat).filter((k) => untranslated(flat[k], englishFlat[k]));
			return { code, stale: stale.length, total: Object.keys(flat).length };
		})
		.sort((a, b) => b.stale - a.stale);

	const total = survey.reduce((sum, r) => sum + r.stale, 0);
	console.log(`${total.toLocaleString()} untranslated phrase(s) across ${survey.length} locale(s)\n`);
	for (const row of survey.filter((r) => r.stale)) {
		const mark = shipped.has(row.code) ? ' ' : '·'; // · = not in the language picker
		const pct = ((row.stale / Math.max(row.total, 1)) * 100).toFixed(1);
		console.log(`  ${mark} ${row.code.padEnd(7)} ${String(row.stale).padStart(6)}  (${pct}% of catalog)`);
	}

	if (!APPLY) {
		console.log(`\nDry run. Re-translate them with:\n  node scripts/i18n-backfill.mjs --apply`);
		return;
	}

	// Two translators rewriting the SAME catalog drop each other's keys. Two
	// working on different locales cannot: one file, one writer. Concurrent
	// agents share this worktree and there is nearly always some locale being
	// translated, so this check is per-locale rather than global -- a global
	// check makes the backfill unrunnable instead of safe.
	const busy = translatingLocales();
	const collides = survey
		.filter((r) => r.stale >= MIN && (!SHIPPED_ONLY || shipped.has(r.code) || only))
		.map((r) => r.code)
		.filter((code) => busy.has(code));
	if (collides.length) {
		console.error(
			`\nAlready being translated by another process: ${collides.join(', ')}. ` +
				'Wait for those to finish, or pass --locale= for one that is free.',
		);
		process.exit(1);
	}

	const passthrough = ['provider', 'model'].flatMap((n) => (opt(n) ? [`--${n}=${opt(n)}`] : []));
	let repaired = 0;

	for (const { code, stale } of survey) {
		if (stale < MIN) continue;
		if (SHIPPED_ONLY && !shipped.has(code) && !only) continue;

		const path = localeDir(code);
		const before = readJSON(path);
		writeFileSync(path, `${JSON.stringify(prune(before, source), null, '\t')}\n`);
		console.log(`\n→ ${code}: cleared ${stale} English-baked phrase(s), re-translating`);

		const run = spawnSync(
			process.execPath,
			[resolve(ROOT, 'scripts/i18n-translate.mjs'), `--locale=${code}`, ...passthrough],
			{ cwd: ROOT, stdio: 'inherit' },
		);
		if (run.status !== 0) {
			console.error(`  ${code}: translator exited ${run.status}; stopping (progress is saved)`);
			break;
		}
		repaired += stale;
	}

	console.log(`\ni18n-backfill: ${repaired.toLocaleString()} phrase(s) re-translated.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
