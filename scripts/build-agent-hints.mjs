#!/usr/bin/env node
/**
 * Generate public/agent-hints.json: which skills drive which animation slot.
 *
 * Skills declare `animationHint: '<name>'` next to their own `name:` in
 * src/agent-skills*.js. The /gestures page shows that mapping, and importing the
 * skill registry into a docs page would pull the whole trading stack into the
 * bundle, so the attribution is extracted here instead. Output is sorted and
 * carries no timestamp, so the file is diff-stable and safe to commit.
 *
 *   node scripts/build-agent-hints.mjs           # write public/agent-hints.json
 *   node scripts/build-agent-hints.mjs --check   # exit 1 if the file is stale
 *
 * tests/agent-hints.test.js runs the --check path, so a new skill hint fails the
 * suite until the file is regenerated.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ANIMATION_MAP, resolveHint } from '../src/runtime/animation-slots.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'public/agent-hints.json');
const SELF = resolve(SRC, 'runtime/animation-slots.js');

/** Every .js file under src/, recursively. */
function jsFiles(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) jsFiles(path, out);
		else if (entry.name.endsWith('.js')) out.push(path);
	}
	return out;
}

/**
 * Extract { hint, skill } pairs. A skill literal is written
 * `{ name: 'x', description: …, animationHint: 'y' }`, so the owning skill is the
 * nearest `name:` before the hint. Files with no hint are skipped entirely.
 */
export function collect() {
	const rows = [];
	for (const file of jsFiles(SRC)) {
		if (file === SELF) continue; // documents the field shape, declares no hints
		const src = readFileSync(file, 'utf8');
		if (!src.includes('animationHint:')) continue;
		for (const m of src.matchAll(/animationHint:\s*'([^']+)'/g)) {
			const before = src.slice(0, m.index);
			// Prose mentions the field too (src/agent-avatar.js explains what it
			// routes). A commented line is documentation, not a declaration.
			const line = src.slice(before.lastIndexOf('\n') + 1, m.index).trimStart();
			if (line.startsWith('//') || line.startsWith('*')) continue;
			// The owning skill is the nearest `name:` above, inside the same object
			// literal. Bounded so a stray hint cannot inherit an unrelated name.
			const name = [...before.slice(-800).matchAll(/\bname:\s*'([^']+)'/g)].pop();
			rows.push({ hint: m[1], skill: name ? name[1] : null });
		}
	}
	return rows;
}

/** Group into the shipped shape: one entry per hint, with its slot and skills. */
export function build() {
	const byHint = new Map();
	for (const { hint, skill } of collect()) {
		if (!byHint.has(hint)) byHint.set(hint, new Set());
		if (skill) byHint.get(hint).add(skill);
	}
	const hints = [...byHint.entries()]
		.map(([hint, skills]) => {
			const slot = resolveHint(hint);
			return {
				hint,
				slot,
				clip: slot ? DEFAULT_ANIMATION_MAP[slot] ?? null : null,
				skills: [...skills].sort(),
			};
		})
		.sort((a, b) => b.skills.length - a.skills.length || a.hint.localeCompare(b.hint));
	return { hints, total_skills: hints.reduce((n, h) => n + h.skills.length, 0) };
}

function main() {
	const next = `${JSON.stringify(build(), null, '\t')}\n`;
	let current = null;
	try {
		current = readFileSync(OUT, 'utf8');
	} catch {}
	if (current === next) {
		console.log('[agent-hints] up to date');
		return 0;
	}
	if (process.argv.includes('--check')) {
		console.error('[agent-hints] public/agent-hints.json is stale. Run: npm run build:agent-hints');
		return 1;
	}
	writeFileSync(OUT, next);
	const { hints, total_skills } = build();
	console.log(`[agent-hints] wrote ${hints.length} hints across ${total_skills} skills`);
	return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
