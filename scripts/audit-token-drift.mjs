#!/usr/bin/env node
/**
 * Design-token drift ratchet — keeps hardcoded token-equivalent hexes from creeping back.
 *
 * public/tokens.css is the single source of truth for colour primitives, but the
 * platform accumulated hundreds of hardcoded hexes that literally equal a token
 * value (#4ade80 IS --success, #f87171 IS --danger, …). Those were migrated to
 * var(--token) on every token-covered page in B13; this audit is the ratchet that
 * stops regressions without demanding a big-bang cleanup of the long tail:
 *
 *   - It counts hardcoded occurrences of the canonical status/base hexes inside
 *     <style> blocks of pages/ *.html files that load the token vocabulary
 *     (via /style.css, /nav.css, or /tokens.css).
 *   - The count may only go DOWN. If it exceeds the recorded baseline the audit
 *     fails and names each offending file so the author swaps the hex for the var.
 *   - When the count drops, the audit tells you to lower the baseline so the
 *     improvement is locked in.
 *
 * Baseline lives next to this script in audit-token-drift.baseline.json.
 * JS/canvas literals and pages that deliberately re-theme a token (they define
 * their own --success/--danger/--warn) are out of scope — the ratchet only sees
 * CSS on pages where the canonical var is the unambiguous right answer.
 *
 * Usage:
 *   node scripts/audit-token-drift.mjs             # exit 1 if drift increased
 *   node scripts/audit-token-drift.mjs --update    # rewrite baseline to current counts
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'audit-token-drift.baseline.json');

/** Hexes that are literally a canonical token value (see public/tokens.css). */
const TOKEN_HEXES = [
	{ hex: '#4ade80', token: '--success' },
	{ hex: '#f87171', token: '--danger' },
	{ hex: '#fbbf24', token: '--warn' },
	// QB-07: the base palette. Each of these is a light-theme bug, not just a
	// style nit — a hardcoded #0a0a0a panel or #e8e8e8 label keeps its dark
	// value when [data-theme='light'] remaps the token, so the surface renders
	// dark-on-dark (or light-on-light) for anyone using the light theme.
	{ hex: '#0a0a0a', token: '--bg-0' },
	{ hex: '#1a1a1a', token: '--bg-1' },
	{ hex: '#e8e8e8', token: '--ink' },
	{ hex: '#888888', token: '--ink-dim' },
	{ hex: '#888', token: '--ink-dim' },
];

/** A page that redefines a status token is a sanctioned theme layer — skip it
 * for that token: the literal there may intentionally differ from the local var. */
const LOCAL_DEF = (css, token) => new RegExp(`${token}\\s*:`).test(css);

const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/gi;

/** A hex inside a `var(--token, #hex)` fallback is not drift — the var resolves
 * first and flips with the theme; the literal only shows if the sheet is missing.
 * Comments are prose. Strip both before counting so the ratchet measures only
 * literals that actually paint. Loops because fallbacks nest. */
function stripNonAuthoritative(css) {
	let out = css.replace(/\/\*[\s\S]*?\*\//g, '');
	for (let i = 0; i < 8; i++) {
		const next = out.replace(/var\(\s*--[a-z0-9-]+\s*,[^()]*\)/gi, 'var(--token)');
		if (next === out) break;
		out = next;
	}
	return out;
}

function collectPages(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...collectPages(p));
		else if (entry.endsWith('.html')) out.push(p);
	}
	return out;
}

function countDrift() {
	const perFile = {};
	let total = 0;
	for (const page of collectPages(join(ROOT, 'pages'))) {
		const html = readFileSync(page, 'utf8');
		// Only pages that actually load the token vocabulary are in scope.
		if (!/\/(style|nav|tokens)\.css/.test(html)) continue;
		let css = '';
		for (const m of html.matchAll(STYLE_BLOCK)) css += m[1];
		if (!css) continue;
		css = stripNonAuthoritative(css);
		let n = 0;
		for (const { hex, token } of TOKEN_HEXES) {
			if (LOCAL_DEF(css, token)) continue;
			// Negative lookahead: #4ade80 must not match inside #4ade8088.
			n += (css.match(new RegExp(`${hex}(?![0-9a-fA-F])`, 'gi')) || []).length;
		}
		if (n > 0) {
			perFile[relative(ROOT, page)] = n;
			total += n;
		}
	}
	return { total, perFile };
}

const { total, perFile } = countDrift();

if (process.argv.includes('--update')) {
	writeFileSync(BASELINE_PATH, JSON.stringify({ total, perFile }, null, '\t') + '\n');
	console.log(`✓ token-drift baseline updated: ${total} hardcoded token-hex(es).`);
	process.exit(0);
}

let baseline;
try {
	baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch {
	console.error(`✗ missing baseline — run: node scripts/audit-token-drift.mjs --update`);
	process.exit(1);
}

if (total > baseline.total) {
	console.error(`\n✗ design-token drift increased: ${total} hardcoded token-hexes (baseline ${baseline.total}).\n`);
	for (const [file, n] of Object.entries(perFile)) {
		const was = baseline.perFile[file] || 0;
		if (n > was) console.error(`  ${file}: ${n} (was ${was})`);
	}
	console.error(
		'\nThese hexes literally equal a canonical token — use the var instead:\n' +
			TOKEN_HEXES.map(({ hex, token }) => `  ${hex} → var(${token})`).join('\n') +
			'\nSee DESIGN-TOKENS.md. If a page deliberately re-themes a token, define the\n' +
			'token locally (a theme layer) rather than hardcoding the raw hex.\n',
	);
	process.exit(1);
}

if (total < baseline.total) {
	console.log(
		`✓ token drift: ${total} (baseline ${baseline.total}) — improved! Lock it in with:\n` +
			'  node scripts/audit-token-drift.mjs --update',
	);
} else {
	console.log(`✓ token drift unchanged: ${total} hardcoded token-hex(es) (baseline ${baseline.total}).`);
}
