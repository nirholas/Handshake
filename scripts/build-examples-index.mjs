// Build data/examples.json: the machine-readable index of every runnable
// example in the repo, derived from what is actually on disk.
//
// The /examples gallery page renders from this file, so the page can never
// advertise an example that was deleted or miss one that was added. Run it
// after adding or removing an examples directory:
//
//   npm run build:examples
//
// Discovery rules, in order:
//   1. Single-file HTML demos at the root of examples/.
//   2. Project directories under examples/ (each has its own README).
//   3. Per-package examples/ directories anywhere in the repo, excluding
//      node_modules and the robinhood/ suite (a separate vendored set).
//
// Every entry carries a title, a description, its runnable files, and the
// command or URL that runs it. Descriptions come from the example's own README
// or an HTML <title>/comment, never from a hand-kept list here.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'data/examples.json');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-lib', 'build', 'robinhood']);

function read(path) {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
}

// First real prose line of a markdown file, stripped of markup.
function firstProse(md) {
	const lines = md.split('\n');
	let seenHeading = false;
	const para = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (line.startsWith('# ')) {
			seenHeading = true;
			continue;
		}
		if (!seenHeading) continue;
		const structural = !line || /^([#>|]|```|---|!\[)/.test(line);
		if (!para.length && structural) continue;
		if (para.length && structural) break;
		para.push(line);
	}
	return para
		.join(' ')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/[*_]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function firstHeading(md) {
	const m = md.match(/^#\s+(.+)$/m);
	return m ? m[1].replace(/`/g, '').trim() : null;
}

function clamp(text, max = 260) {
	if (!text || text.length <= max) return text;
	const window = text.slice(0, max);
	const ends = [...window.matchAll(/[.!?](?=\s|$)/g)].map((m) => m.index + 1);
	const cut = ends.length ? ends[ends.length - 1] : window.lastIndexOf(' ');
	return window.slice(0, cut > 0 ? cut : max).trim();
}

function decodeEntities(s) {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ');
}

// An HTML demo describes itself, in priority order, with a meta description,
// its own visible intro paragraph, or the leading source comment. Anything
// else would be copy invented here, so the field is left empty instead.
function describeHtml(path) {
	const html = read(path);
	const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
	const meta = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)/i)?.[1];
	const bodyText = html
		.split(/<body[^>]*>/i)[1]
		?.match(/<p[^>]*>([\s\S]{25,400}?)<\/p>/i)?.[1]
		?.replace(/<[^>]+>/g, ' ');
	const lead = html.match(/^\s*<!--\s*([\s\S]{20,400}?)-->/m)?.[1];
	const raw = meta || bodyText || lead || '';
	const h1 = html.match(/<h1[^>]*>([\s\S]{2,90}?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '');
	return {
		title: decodeEntities(title || h1 || basename(path, '.html')).trim(),
		description: clamp(decodeEntities(raw).replace(/\s+/g, ' ').trim()),
	};
}

function listFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => !f.startsWith('.'))
		.filter((f) => statSync(join(dir, f)).isFile())
		.sort();
}

function runnableFiles(dir) {
	return listFiles(dir).filter((f) => /\.(mjs|js|ts|html|sh|json)$/.test(f) && f !== 'package.json');
}

// How a reader actually runs this example, stated concretely.
// The concrete way a reader runs this, or null when the directory is reference
// material (schema samples, agent-as-files definitions) with nothing to execute.
function runHint(dirRel, files) {
	const script = files.find((f) => /\.(mjs|js)$/.test(f));
	const shell = files.find((f) => f.endsWith('.sh'));
	const html = files.find((f) => f.endsWith('.html'));
	if (script) return `node ${dirRel}/${script}`;
	if (shell) return `bash ${dirRel}/${shell}`;
	if (html) return `npm run dev, then open /${dirRel}/${html}`;
	// A project with its own package.json runs through its declared script.
	const pkgPath = join(root, dirRel, 'package.json');
	if (existsSync(pkgPath)) {
		try {
			const scripts = JSON.parse(read(pkgPath)).scripts || {};
			for (const name of ['start', 'dev', 'demo', 'run']) {
				if (scripts[name]) return `cd ${dirRel} && npm install && npm run ${name}`;
			}
		} catch {
			/* a malformed package.json just means no hint */
		}
	}
	return null;
}

const entries = [];

// 1. Single-file HTML demos at the root of examples/.
const examplesDir = join(root, 'examples');
for (const file of listFiles(examplesDir)) {
	if (!file.endsWith('.html')) continue;
	const abs = join(examplesDir, file);
	const { title, description } = describeHtml(abs);
	entries.push({
		id: `demo:${file}`,
		kind: 'html-demo',
		group: 'Web component demos',
		title,
		description,
		path: `examples/${file}`,
		files: [file],
		run: `http://localhost:3000/examples/${file}`,
		runKind: 'url',
	});
}

// 2. Project directories under examples/.
for (const name of readdirSync(examplesDir)) {
	const abs = join(examplesDir, name);
	if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
	if (SKIP_DIRS.has(name)) continue;
	const readme = read(join(abs, 'README.md'));
	const files = runnableFiles(abs);
	let projectPkgDescription = '';
	try {
		projectPkgDescription = JSON.parse(read(join(abs, 'package.json'))).description || '';
	} catch {
		/* not every example project is a package */
	}
	entries.push({
		id: `project:${name}`,
		kind: 'project',
		group: 'Example projects',
		title: firstHeading(readme) || name,
		description: clamp(firstProse(readme)) || clamp(projectPkgDescription),
		path: `examples/${name}`,
		files,
		run: runHint(`examples/${name}`, files),
		runKind: 'command',
		readme: existsSync(join(abs, 'README.md')) ? `examples/${name}/README.md` : null,
	});
}

// 3. Per-package examples/ directories.
function findExampleDirs(dir, depth = 0) {
	if (depth > 3) return [];
	const found = [];
	let items;
	try {
		items = readdirSync(dir);
	} catch {
		return found;
	}
	for (const name of items) {
		if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
		const abs = join(dir, name);
		let st;
		try {
			st = statSync(abs);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		if (name === 'examples' && dir !== root) {
			found.push(abs);
			continue;
		}
		if (name === 'examples' || name === 'example') found.push(abs);
		found.push(...findExampleDirs(abs, depth + 1));
	}
	return found;
}

const seen = new Set(entries.map((e) => e.path));
for (const abs of findExampleDirs(root)) {
	const rel = relative(root, abs);
	if (rel.startsWith('examples/') || seen.has(rel)) continue;
	const owner = dirname(rel);
	const files = runnableFiles(abs);
	if (!files.length) continue;
	const readme = read(join(abs, 'README.md'));
	const ownerReadme = read(join(root, owner, 'README.md'));
	let pkgName = owner;
	let pkgDescription = '';
	try {
		const pkg = JSON.parse(read(join(root, owner, 'package.json')));
		pkgName = pkg.name || owner;
		pkgDescription = pkg.description || '';
	} catch {
		/* not every examples owner is an npm package */
	}
	entries.push({
		id: `package:${owner}`,
		kind: 'package',
		group: 'Package examples',
		title: pkgName,
		description: clamp(firstProse(readme) || firstProse(ownerReadme) || pkgDescription),
		path: rel,
		files,
		run: runHint(rel, files),
		runKind: 'command',
		readme: existsSync(join(abs, 'README.md')) ? `${rel}/README.md` : null,
		owner,
	});
}

// Source titles and descriptions may carry em/en dashes; the repo bans both
// glyphs in committed files, so normalize them to a plain hyphen on the way out.
const plainDashes = (s) => (typeof s === 'string' ? s.replace(/[–—]/g, '-') : s);
for (const e of entries) {
	e.title = plainDashes(e.title);
	e.description = plainDashes(e.description);
}

entries.sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));

const payload = {
	$comment:
		'Generated by scripts/build-examples-index.mjs from what is on disk. Do not edit by hand; run npm run build:examples.',
	generated_by: 'scripts/build-examples-index.mjs',
	counts: {
		total: entries.length,
		html_demos: entries.filter((e) => e.kind === 'html-demo').length,
		projects: entries.filter((e) => e.kind === 'project').length,
		packages: entries.filter((e) => e.kind === 'package').length,
	},
	examples: entries,
};

writeFileSync(OUT, `${JSON.stringify(payload, null, '\t')}\n`);
console.log(
	`wrote data/examples.json: ${payload.counts.total} examples ` +
		`(${payload.counts.html_demos} demos, ${payload.counts.projects} projects, ${payload.counts.packages} packages)`,
);
