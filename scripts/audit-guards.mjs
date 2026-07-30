#!/usr/bin/env node
// Prove data/guards.json describes the guards this repo actually runs.
//
// Why this exists. The guard set is the only automated checkpoint here: there is
// no CI, so a check that is not wired into an unavoidable path (prebuild, the
// gate, the deploy chain, the pre-push hook) protects nothing. Two failure modes
// followed from that, and both had already happened when this was written:
//
//   1. Guards nobody could find. Eight working audit scripts sat in scripts/
//      with no npm script, discoverable only by reading the directory. One of
//      them said in its own header that it was "wired as npm run audit:console"
//      when no such script existed.
//   2. Documentation that claims a guard runs somewhere it does not. That is
//      worse than silence: a reader stops looking for the coverage they think
//      they already have.
//
// So this checks BOTH directions, and treats the stage column as a claim to be
// verified rather than prose:
//
//   a. Every registry entry names a script that exists and an npm script that
//      exists, so nothing in the registry is aspirational.
//   b. Every check-*/audit-* script on disk is registered, or matches an exempt
//      pattern that states WHY it is not a guard. New guards cannot land
//      undocumented.
//   c. Every `stages` claim is true against the real npm scripts: a guard
//      claiming "gate" must appear in the gate chain, "prebuild" in prebuild,
//      "build:gcp" in that chain, and "pre-push" in the installed hook template.
//      This is the check that keeps docs/guards.md and /guards honest, because
//      both render this file.
//
// Deliberately conservative: it never guesses that a script "looks like" a
// guard beyond the check-/audit- naming convention, because a checker that
// reports false positives gets switched off, which is worse than no check.
//
// Run: node scripts/audit-guards.mjs   (wired as `npm run audit:guards`)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const registry = JSON.parse(read('data/guards.json'));
const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts || {};

const failures = [];
const note = (msg) => failures.push(msg);

// The stage a guard claims maps to a concrete place its name must appear.
// `prebuild` runs raw `node scripts/x.mjs` calls rather than npm scripts, so it
// is matched on the script path; the rest are npm chains.
const STAGE_SOURCES = {
	prebuild: { kind: 'path', chain: scripts.prebuild || '', label: 'the prebuild chain' },
	gate: { kind: 'npm', chain: scripts.gate || '', label: 'the gate chain' },
	'build:gcp': { kind: 'npm', chain: scripts['build:gcp'] || '', label: 'the build:gcp chain' },
	'pre-push': { kind: 'hook', label: 'the pre-push hook template' },
	manual: { kind: 'none', label: 'nothing (on demand)' },
};

const hookTemplate = existsSync(path.join(root, 'scripts/setup-git-hooks.mjs'))
	? read('scripts/setup-git-hooks.mjs')
	: '';

const declaredStageIds = new Set((registry.stages || []).map((s) => s.id));
for (const id of Object.keys(STAGE_SOURCES)) {
	if (!declaredStageIds.has(id)) note(`stage \`${id}\` is verifiable but data/guards.json never describes it for readers`);
}

const registered = new Set();

for (const g of registry.guards || []) {
	const where = `guard \`${g.id}\``;

	if (!g.script || !existsSync(path.join(root, g.script))) {
		note(`${where} names script \`${g.script}\`, which does not exist`);
		continue;
	}
	registered.add(g.script);

	const npmNames = [g.npm, ...(g.npmAliases || [])].filter(Boolean);
	if (!npmNames.length) {
		note(`${where} has no npm script, so nobody can discover or run it without reading scripts/`);
	}
	for (const name of npmNames) {
		if (!scripts[name]) {
			note(`${where} claims \`npm run ${name}\`, which is missing from package.json`);
			continue;
		}
		if (!scripts[name].includes(g.script)) {
			note(`${where}: \`npm run ${name}\` does not actually run ${g.script}`);
		}
	}

	for (const field of ['title', 'protects', 'why']) {
		if (!g[field] || !String(g[field]).trim()) {
			note(`${where} is missing \`${field}\`, which /guards and docs/guards.md both render`);
		}
	}

	const stages = g.stages || [];
	if (!stages.length) note(`${where} declares no stages, so a reader cannot tell when it runs`);
	for (const stage of stages) {
		const src = STAGE_SOURCES[stage];
		if (!src) {
			note(`${where} claims unknown stage \`${stage}\` (known: ${Object.keys(STAGE_SOURCES).join(', ')})`);
			continue;
		}
		if (src.kind === 'none') continue;
		let wired = false;
		if (src.kind === 'path') wired = src.chain.includes(g.script);
		else if (src.kind === 'npm') wired = npmNames.some((n) => new RegExp(`npm run ${n}(\\s|$|&)`).test(src.chain));
		else if (src.kind === 'hook') wired = hookTemplate.includes(path.basename(g.script));
		if (!wired) {
			note(
				`${where} claims it runs in \`${stage}\` but it is not in ${src.label}. ` +
					`Wire it there, or correct the stage in data/guards.json.`,
			);
		}
	}
}

// Reverse direction: a guard on disk that nobody registered.
const exemptPatterns = (registry.exempt || []).map((e) => ({
	re: new RegExp(`^${String(e.pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`),
	reason: e.reason,
}));
for (const e of registry.exempt || []) {
	if (!e.reason || !String(e.reason).trim()) note(`exempt pattern \`${e.pattern}\` gives no reason, so nobody can judge whether it still holds`);
}

const onDisk = readdirSync(path.join(root, 'scripts'))
	.filter((f) => /^(check|audit)-.*\.(mjs|js)$/.test(f))
	.map((f) => `scripts/${f}`);

for (const rel of onDisk) {
	if (registered.has(rel)) continue;
	if (exemptPatterns.some((p) => p.re.test(rel))) continue;
	note(
		`${rel} looks like a guard but is not in data/guards.json. ` +
			`Add it (with the stage it runs in), or add an exempt pattern saying why it is not one.`,
	);
}

// The published copy the /guards page fetches. data/ is never served, so the
// page reads public/guards.json; if the two drift, the page and docs/guards.md
// show different answers and neither looks wrong on its own.
{
	const publicPath = 'public/guards.json';
	if (!existsSync(path.join(root, publicPath))) {
		note(`${publicPath} is missing, so /guards has nothing to render. Run \`npm run build:guards\`.`);
	} else {
		const expected = `${JSON.stringify(registry, null, '\t')}\n`;
		if (read(publicPath) !== expected) {
			note(`${publicPath} is out of date with data/guards.json, so /guards would render stale content. Run \`npm run build:guards\`.`);
		}
	}
}

if (failures.length) {
	console.error(`[audit-guards] ${failures.length} problem(s) between data/guards.json and the repo:`);
	for (const f of failures) console.error(`[audit-guards]   ${f}`);
	console.error('[audit-guards] The registry is what docs/guards.md and /guards render, so drift here misleads every reader.');
	process.exit(1);
}

const counts = (registry.guards || []).reduce((acc, g) => {
	for (const s of g.stages || []) acc[s] = (acc[s] || 0) + 1;
	return acc;
}, {});
const summary = Object.entries(counts)
	.map(([k, v]) => `${k}:${v}`)
	.join(' ');
console.log(`[audit-guards] OK: ${registry.guards.length} guards registered, every stage claim verified (${summary})`);
