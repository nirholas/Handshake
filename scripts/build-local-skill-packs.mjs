#!/usr/bin/env node
/**
 * Generate data/_generated/local-skill-packs.json by scanning the four
 * SKILL.md pack directories (.agents/skills, pump-fun-skills, public/skills,
 * examples/skills).
 *
 * Why: api/chat-skills.js previously did the scan at runtime via
 * src/skills/local-packs.js, which derived REPO_ROOT from
 * `new URL('../..', import.meta.url)`. Vercel's @vercel/nft tracer treats
 * that root pointer as a needed asset and ends up bundling the entire repo
 * (~615mb) into the function, blowing past the 300mb limit. Precomputing
 * the pack list at build time keeps the function bundle small.
 */
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const outFile = resolve(REPO_ROOT, 'data/_generated/local-skill-packs.json');

const SKILL_DIRS = [
	{ path: '.agents/skills', source: 'agentic-wallet', category: 'wallet' },
	{ path: 'pump-fun-skills', source: 'pump-fun-skills', category: 'pump-fun' },
	{ path: 'public/skills', source: 'public-skills', category: 'integrations' },
	{ path: 'examples/skills', source: 'examples', category: 'examples' },
];

function unquote(v) {
	const s = v.trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

function foldedJoin(f) {
	let indent = null;
	const out = [];
	for (const l of f.lines) {
		if (l === '') {
			out.push('');
			continue;
		}
		if (indent === null) {
			const m = l.match(/^(\s*)/);
			indent = m[1].length;
		}
		out.push(l.slice(indent));
	}
	const joined = out.join('\n').trim();
	if (f.mode === '>') return joined.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
	return joined;
}

function parseFrontmatter(src) {
	if (!src.startsWith('---\n')) return { data: {}, body: src };
	const end = src.indexOf('\n---', 4);
	if (end === -1) return { data: {}, body: src };
	const raw = src.slice(4, end);
	const body = src.slice(end + 4).replace(/^\s*\n/, '');
	const data = {};
	const lines = raw.split('\n');
	let key = null;
	let folded = null;
	for (const line of lines) {
		if (folded) {
			const m = line.match(/^(\s*)(.*)$/);
			const indent = m[1].length;
			const text = m[2];
			if (text === '' || indent >= 2) {
				folded.lines.push(text);
				continue;
			}
			data[key] = foldedJoin(folded);
			folded = null;
		}
		const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (!m) continue;
		key = m[1];
		const value = m[2];
		if (value === '>' || value === '|') {
			folded = { mode: value, indent: 0, lines: [] };
			continue;
		}
		data[key] = unquote(value);
	}
	if (folded) data[key] = foldedJoin(folded);
	return { data, body };
}

function scanDir({ path, source, category }) {
	const abs = join(REPO_ROOT, path);
	if (!existsSync(abs)) return [];
	let entries;
	try {
		entries = readdirSync(abs);
	} catch {
		return [];
	}
	const packs = [];
	for (const name of entries) {
		const dir = join(abs, name);
		let st;
		try {
			st = statSync(dir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		const skillPath = join(dir, 'SKILL.md');
		if (!existsSync(skillPath)) continue;
		let raw;
		try {
			raw = readFileSync(skillPath, 'utf8');
		} catch {
			continue;
		}
		const { data, body } = parseFrontmatter(raw);
		const slug = String(data.name || basename(dir));
		packs.push({
			id: `local:${source}:${slug}`,
			source,
			category: data.category || category,
			name: slug,
			slug,
			description: data.description || '',
			version: data.version || null,
			trust: data.trust || null,
			kind: 'knowledge',
			has_content: true,
			content: raw,
			body,
			path: relative(REPO_ROOT, skillPath),
		});
	}
	return packs;
}

const all = [];
for (const dir of SKILL_DIRS) all.push(...scanDir(dir));

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(all, null, '\t') + '\n');

console.log(`[build-local-skill-packs] wrote ${all.length} packs → ${outFile}`);
