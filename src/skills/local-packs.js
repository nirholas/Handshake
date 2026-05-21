// Reads SKILL.md packs from every local skill directory in the repo and
// returns them as normalized records the chat marketplace can render and
// install. Packs are the Claude-style format: YAML frontmatter + markdown
// body. The body becomes a "knowledge skill" the chat injects into the
// system prompt; the agent reads it and follows the embedded instructions.

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, basename, relative } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

let _cached = null;
export function loadLocalSkillPacks() {
	if (_cached) return _cached;
	const all = [];
	for (const dir of SKILL_DIRS) {
		all.push(...scanDir(dir));
	}
	_cached = all;
	return all;
}
