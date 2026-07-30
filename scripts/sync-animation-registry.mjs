#!/usr/bin/env node
/**
 * Regenerate the `clips` collection in public/animations/registry.json from the
 * things that are actually true at build time.
 *
 * The registry is the developer-facing catalogue of every animation asset in the
 * project, and its own header tells you to read it first. That only holds if it
 * matches reality, and by hand it does not: it drifted to 37 of 112 built clips,
 * every `source_fbx` still pointed at `public/animations/` (which has held no
 * FBX since the sources moved to the gitignored `animation-sources/`), and
 * `agent_slots` still recorded slot assignments that had since moved to other
 * clips.
 *
 * Derived per clip:
 *   label / icon / loop   ← public/animations/manifest.json (the built truth)
 *   clip                  ← public/animations/clips/<name>.json
 *   source_fbx            ← scripts/animations.config.json `source`, or null for
 *                           hand-authored clips (scripts/animations-extra-clips.json)
 *   agent_slots           ← src/runtime/animation-slots.js DEFAULT_ANIMATION_MAP,
 *                           reversed, so a slot can never be recorded on two clips
 *
 * Hand-written `note` / `_note` fields are preserved by clip name; everything
 * else in the registry (the other collections, known_issues, resolved_issues) is
 * untouched. The rows are re-emitted in the file's existing column-aligned
 * style, so the diff is only the rows that actually changed.
 *
 * Run by `npm run build:animations` after the manifest is written, and guarded by
 * tests/animation-registry.test.js. Standalone:
 *   node scripts/sync-animation-registry.mjs [--check]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ANIMATION_MAP } from '../src/runtime/animation-slots.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = resolve(ROOT, 'public/animations/registry.json');
const MANIFEST = resolve(ROOT, 'public/animations/manifest.json');
const CONFIG = resolve(ROOT, 'scripts/animations.config.json');
const CHECK = process.argv.includes('--check');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** clip name → [slot, …] from the runtime slot map, so nothing is recorded twice. */
function slotsByClip() {
	const out = new Map();
	for (const [slot, clip] of Object.entries(DEFAULT_ANIMATION_MAP)) {
		if (!out.has(clip)) out.set(clip, []);
		out.get(clip).push(slot);
	}
	return out;
}

/** Build the row objects, newest-last, one per built clip. */
export function buildRows() {
	const manifest = readJson(MANIFEST);
	const config = readJson(CONFIG);
	const registry = readJson(REGISTRY);
	const sources = new Map((config.clips || config).map((c) => [c.name, c.source]));
	const slots = slotsByClip();
	const previous = new Map((registry.collections.clips.items || []).map((r) => [r.name, r]));

	return manifest.map((clip) => {
		const prior = previous.get(clip.name);
		const source = sources.get(clip.name);
		const row = {
			name: clip.name,
			label: clip.label ?? clip.name,
			icon: clip.icon ?? '',
			loop: !!clip.loop,
			clip: `public/animations/clips/${clip.name}.json`,
			source_fbx: source ? `animation-sources/${source}` : null,
			agent_slots: slots.get(clip.name) ?? [],
		};
		if (prior?.note) row.note = prior.note;
		if (prior?._note) row._note = prior._note;
		return row;
	});
}

/** Render rows in the registry's column-aligned one-line-per-clip style. */
function renderRows(rows, indent) {
	const cell = (v) => JSON.stringify(v);
	// The leading columns are fixed-width so names, labels and paths line up down
	// the file; the trailing ones vary in length and are left ragged.
	const pad = (key, render) => {
		const cells = rows.map(render);
		const w = Math.max(...cells.map((c) => c.length));
		return new Map(rows.map((r, i) => [r.name, cells[i].padEnd(w)]));
	};
	const nameCol = pad('name', (r) => `"name": ${cell(r.name)},`);
	const labelCol = pad('label', (r) => `"label": ${cell(r.label)},`);
	const loopCol = pad('loop', (r) => `"loop": ${r.loop},`);
	const clipCol = pad('clip', (r) => `"clip": ${cell(r.clip)},`);
	const sourceCol = pad('source_fbx', (r) => `"source_fbx": ${cell(r.source_fbx)},`);

	return rows.map((r) => {
		const parts = [
			nameCol.get(r.name),
			labelCol.get(r.name),
			`"icon": ${cell(r.icon)},`,
			loopCol.get(r.name),
			clipCol.get(r.name),
			sourceCol.get(r.name),
			`"agent_slots": [${r.agent_slots.map(cell).join(', ')}]`,
		];
		if (r.note) parts.push(`"note": ${cell(r.note)}`);
		if (r._note) parts.push(`"_note": ${cell(r._note)}`);
		return `${indent}{ ${parts.join(' ').replace(/\] "/, '], "')} }`;
	});
}

/**
 * Re-render the `agent_slots.slots` block from the live slot vocabulary.
 * A hand-written `status` survives as long as the slot still resolves to the
 * same clip; a slot that was re-pointed gets a plain "active" so a stale note
 * ("maps to 'reaction', not 'wave'") cannot outlive the mapping it described.
 */
function renderSlots(indent) {
	const registry = readJson(REGISTRY);
	const prior = registry.agent_slots?.slots || {};
	const names = Object.keys(DEFAULT_ANIMATION_MAP);
	const nameW = Math.max(...names.map((n) => n.length + 3));
	const clipW = Math.max(...names.map((n) => JSON.stringify(DEFAULT_ANIMATION_MAP[n]).length + 1));
	return names.map((slot, i) => {
		const clip = DEFAULT_ANIMATION_MAP[slot];
		const kept = prior[slot]?.default_clip === clip ? prior[slot].status : 'active';
		const key = `${JSON.stringify(slot)}:`.padEnd(nameW);
		const value = `${JSON.stringify(clip)},`.padEnd(clipW);
		const comma = i === names.length - 1 ? '' : ',';
		return `${indent}${key} { "default_clip": ${value} "status": ${JSON.stringify(kept)} }${comma}`;
	});
}

/** Replace the lines of a `"key": { … }` / `"key": [ … ]` block in place. */
function replaceBlock(lines, openRe, render, closeRe = /^\s*[}\]],?\s*$/) {
	const start = lines.findIndex((l) => openRe.test(l));
	if (start === -1) throw new Error(`could not find ${openRe} in registry.json`);
	const end = lines.findIndex((l, i) => i > start && closeRe.test(l));
	if (end === -1) throw new Error(`unterminated ${openRe} in registry.json`);
	const indent = (lines[start + 1] ?? '').match(/^\s*/)[0] || '      ';
	return [...lines.slice(0, start + 1), ...render(indent), ...lines.slice(end)];
}

function main() {
	const raw = readFileSync(REGISTRY, 'utf8');
	const lines = raw.split('\n');

	// Locate the clips collection's `items` array in the raw text so every other
	// byte of the hand-formatted file survives untouched.
	const start = lines.findIndex((l, i) => /^\s*"items": \[\s*$/.test(l) && lines.slice(0, i).some((p) => /"clips": \{/.test(p)));
	if (start === -1) throw new Error('could not find the clips "items" array in registry.json');
	const end = lines.findIndex((l, i) => i > start && /^\s*\],?\s*$/.test(l));
	if (end === -1) throw new Error('unterminated clips "items" array in registry.json');
	const indent = (lines[start + 1] ?? '        {').match(/^\s*/)[0] || '        ';

	const rows = buildRows();
	const rendered = renderRows(rows, indent);
	const withClips = [
		...lines.slice(0, start + 1),
		...rendered.map((l, i) => (i === rendered.length - 1 ? l : `${l},`)),
		...lines.slice(end),
	];
	const next = replaceBlock(withClips, /^\s*"slots": \{\s*$/, renderSlots).join('\n');

	// Parse before writing: a malformed registry breaks every reader downstream.
	JSON.parse(next);

	if (next === raw) {
		console.log(`[registry] clips already in sync (${rows.length} clips)`);
		return 0;
	}
	if (CHECK) {
		console.error(`[registry] out of sync, run: node scripts/sync-animation-registry.mjs`);
		return 1;
	}
	writeFileSync(REGISTRY, next);
	console.log(`[registry] synced ${rows.length} clips from the manifest`);
	return 0;
}

// Only act when run as a command. tests/animation-registry.test.js imports
// buildRows() to compare against the committed file and must not rewrite it.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	if (!existsSync(REGISTRY)) throw new Error(`registry not found: ${REGISTRY}`);
	process.exitCode = main();
}
