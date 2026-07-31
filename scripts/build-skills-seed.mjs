#!/usr/bin/env node
// Regenerates data/skills/seed.json from the SKILL.md files themselves, so the
// marketplace seed can never drift from the on-disk skills (fable-audit LEAN
// item 6: every skill fix previously had to be made twice, once in SKILL.md
// and once in the 796KB seed mirror, and the mirrors drifted).
//
// Usage: node scripts/build-skills-seed.mjs [--check] [--list]
//   --check  exit 1 if the generated output differs from what is on disk
//            (ignoring generatedAt); prints which skills drifted. Use in
//            reviews the same way as scripts/build-skills-pack.mjs --check.
//   --list   print every skill (category/identifier/kind) and exit.
//
// Source layout under data/skills/:
//   <category>/<identifier>/SKILL.md   builtin skills: the seed entry is the
//                                      frontmatter (manifest) + body (content),
//                                      exactly: content = body.trim().
//   <identifier>/SKILL.md              vendored partner drops (metamask-*):
//                                      content = vendor body + the marketplace
//                                      pack trailer; manifest/category carry
//                                      over from the existing seed entry
//                                      (hand-curated, richer than the vendor
//                                      frontmatter). Their entries omit the
//                                      top-level name/source fields, as the
//                                      seed always has.
//
// Determinism: existing seed order is preserved (new skills append, sorted),
// generatedAt only advances when something other than generatedAt changed, and
// entry keys are emitted alphabetically to match the historical file. A
// re-run over an unchanged tree writes nothing.
//
// Frontmatter is parsed with the same dependency-free reader approach as
// scripts/build-skills-pack.mjs, extended with flow lists ([a, b]) because the
// data/skills manifests carry tags that way.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKILLS_DIR = path.join(ROOT, 'data', 'skills');
const SEED_PATH = path.join(SKILLS_DIR, 'seed.json');

// Appended to every vendored (partner-drop) entry's content in the seed. The
// SKILL.md itself stays byte-identical to the vendor file; this marketplace
// trailer exists only in the seed copy (verified against the historical seed).
const VENDOR_TRAILER = `

## Get the full skill pack

This skill ships with per-command reference files and step-by-step workflow templates.
Install the complete pack into your own agent (Claude Code, Codex, Cursor, or similar):

\`\`\`
npm install -g @metamask/agentic-cli
npx skills add MetaMask/agent-skills
\`\`\`

Then run \`mm login\` and \`mm init\` to provision your own agent wallet. Each user
authenticates their own MetaMask Agent Wallet \u2014 keys are never shared or custodied
by three.ws.
`;

// ── Frontmatter reader ───────────────────────────────────────────────────────

function stripQuotes(v) {
	if (
		(v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
		(v.startsWith("'") && v.endsWith("'") && v.length > 1)
	) {
		return v.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
	}
	return v;
}

function parseScalar(raw) {
	const v = raw.trim();
	if (/^\[.*\]$/.test(v)) {
		const inner = v.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(',').map((s) => stripQuotes(s.trim()));
	}
	return stripQuotes(v);
}

function readFrontmatter(text, file) {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) throw new Error(`${file}: missing frontmatter`);
	const lines = m[1].split(/\r?\n/);
	const out = {};
	let i = 0;
	while (i < lines.length) {
		const key = lines[i].match(/^([A-Za-z0-9_-]+):(.*)$/);
		if (!key) {
			i += 1;
			continue;
		}
		const name = key[1];
		const value = key[2].trim();
		if (value === '|' || value === '>' || value === '|-' || value === '>-') {
			const block = [];
			i += 1;
			while (i < lines.length && (/^\s+\S/.test(lines[i]) || lines[i].trim() === '')) {
				block.push(lines[i].replace(/^\s+/, ''));
				i += 1;
			}
			out[name] = block.join(value.startsWith('|') ? '\n' : ' ').trim();
			continue;
		}
		if (value === '') {
			const child = {};
			i += 1;
			while (i < lines.length && /^\s+\S/.test(lines[i])) {
				const cm = lines[i].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
				if (cm) child[cm[1]] = parseScalar(cm[2]);
				i += 1;
			}
			out[name] = child;
			continue;
		}
		out[name] = parseScalar(value);
		i += 1;
	}
	return { manifest: out, body: text.slice(m[0].length) };
}

// ── Collection ───────────────────────────────────────────────────────────────

function collectSkills() {
	const builtin = [];
	const vendored = [];
	for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(SKILLS_DIR, entry.name);
		const direct = path.join(dir, 'SKILL.md');
		if (fs.existsSync(direct)) {
			vendored.push({ identifier: entry.name, file: direct });
			continue;
		}
		for (const sub of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (!sub.isDirectory()) continue;
			const file = path.join(dir, sub.name, 'SKILL.md');
			if (!fs.existsSync(file)) {
				throw new Error(`${path.relative(ROOT, path.join(dir, sub.name))}: missing SKILL.md`);
			}
			builtin.push({ category: entry.name, identifier: sub.name, file });
		}
	}
	return { builtin, vendored };
}

function buildEntries() {
	const { builtin, vendored } = collectSkills();
	const entries = [];
	for (const s of builtin) {
		const raw = fs.readFileSync(s.file, 'utf8');
		const { manifest, body } = readFrontmatter(raw, path.relative(ROOT, s.file));
		if (!manifest.name || !manifest.description) {
			throw new Error(`${path.relative(ROOT, s.file)}: frontmatter missing name/description`);
		}
		if (manifest.name !== s.identifier) {
			throw new Error(`${path.relative(ROOT, s.file)}: frontmatter name "${manifest.name}" != directory name`);
		}
		entries.push({
			category: s.category,
			content: body.trim(),
			description: manifest.description,
			identifier: s.identifier,
			manifest,
			name: s.identifier,
			source: 'builtin',
		});
	}
	return { entries, vendored };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

function loadExisting() {
	try {
		return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
	} catch {
		return { generatedAt: null, skills: [], total: 0 };
	}
}

function assemble() {
	const existing = loadExisting();
	const existingOrder = new Map((existing.skills || []).map((s, i) => [s.identifier, i]));
	const byId = new Map((existing.skills || []).map((s) => [s.identifier, s]));
	const { entries, vendored } = buildEntries();

	// Vendored partner drops (SKILL.md directly under data/skills/<name>/):
	// their seed manifests are hand-curated for the marketplace (category,
	// difficulty, tags the vendor file does not carry), so the manifest and
	// category carry over from the existing seed entry while the CONTENT is
	// regenerated from the vendor body plus the standard pack trailer. That
	// keeps the body drift-proof without flattening the curation.
	for (const s of vendored) {
		const cur = byId.get(s.identifier);
		if (!cur) {
			throw new Error(
				`${path.relative(ROOT, s.file)}: vendored skill has no existing seed entry to carry curated metadata from; add one to data/skills/seed.json by hand first`,
			);
		}
		const raw = fs.readFileSync(s.file, 'utf8');
		const { body } = readFrontmatter(raw, path.relative(ROOT, s.file));
		entries.push({
			category: cur.category,
			content: body.trim() + VENDOR_TRAILER,
			description: cur.description,
			identifier: s.identifier,
			manifest: cur.manifest,
		});
	}
	// Preserve the historical seed order for known skills so a regeneration
	// diff shows real content changes, not a wholesale reorder; new skills
	// append in (category, identifier) order.
	entries.sort((a, b) => {
		const ia = existingOrder.has(a.identifier) ? existingOrder.get(a.identifier) : Infinity;
		const ib = existingOrder.has(b.identifier) ? existingOrder.get(b.identifier) : Infinity;
		if (ia !== ib) return ia - ib;
		return (a.category + '/' + a.identifier).localeCompare(b.category + '/' + b.identifier);
	});
	return { existing, entries };
}

function render(entries, generatedAt) {
	// Alphabetical entry keys (the historical file's convention); manifest
	// keys keep frontmatter order.
	const skills = entries.map((e) => {
		const out = {};
		for (const k of Object.keys(e).sort()) out[k] = e[k];
		return out;
	});
	return JSON.stringify({ generatedAt, skills, total: skills.length }, null, 2) + '\n';
}

// ── Main ─────────────────────────────────────────────────────────────────────

const flag = (name) => process.argv.includes(name);
const { existing, entries } = assemble();

if (flag('--list')) {
	for (const e of entries) {
		console.log(`${e.category}/${e.identifier}${e.source === 'builtin' ? '' : '  (vendored)'}`);
	}
	console.log(`${entries.length} skill(s)`);
	process.exit(0);
}

const keepStamp = existing.generatedAt || new Date().toISOString();
const unchanged = render(entries, keepStamp) === fs.readFileSync(SEED_PATH, 'utf8');

if (flag('--check')) {
	if (unchanged) {
		console.log(`OK: data/skills/seed.json matches its ${entries.length} SKILL.md sources.`);
		process.exit(0);
	}
	const byId = new Map((existing.skills || []).map((s) => [s.identifier, s]));
	const drifted = [];
	for (const e of entries) {
		const cur = byId.get(e.identifier);
		if (!cur) {
			drifted.push(`${e.identifier}: missing from seed.json`);
			continue;
		}
		for (const k of Object.keys(e)) {
			if (JSON.stringify(cur[k]) !== JSON.stringify(e[k])) {
				drifted.push(`${e.identifier}: ${k} drifted`);
			}
		}
	}
	for (const s of existing.skills || []) {
		if (!entries.some((e) => e.identifier === s.identifier)) {
			drifted.push(`${s.identifier}: in seed.json but has no SKILL.md`);
		}
	}
	if ((existing.total ?? null) !== entries.length) {
		drifted.push(`total: seed says ${existing.total}, sources say ${entries.length}`);
	}
	console.error(`DRIFT: data/skills/seed.json does not match its sources (${drifted.length} difference(s)):`);
	for (const d of drifted) console.error(`  ${d}`);
	console.error('Regenerate with: node scripts/build-skills-seed.mjs');
	process.exit(1);
}

if (unchanged) {
	console.log(`data/skills/seed.json unchanged (${entries.length} skills).`);
	process.exit(0);
}
const out = render(entries, new Date().toISOString());
const tmp = SEED_PATH + '.tmp';
fs.writeFileSync(tmp, out);
fs.renameSync(tmp, SEED_PATH);
console.log(`Wrote data/skills/seed.json: ${entries.length} skills, ${(out.length / 1024).toFixed(0)}KB.`);
console.log('Reminder: skill bodies may reference non-$THREE projects; the CLAUDE.md commit gate applies to the regenerated diff.');
