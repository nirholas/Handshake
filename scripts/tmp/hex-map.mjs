// Report, per file, which hardcoded colours are exact token equivalents (safe to
// swap mechanically) and which are novel values needing a design decision.
import { readFileSync } from 'node:fs';

const tokens = readFileSync('public/tokens.css', 'utf8');
const map = new Map(); // normalised value -> token name
const scope = tokens.slice(0, tokens.indexOf("[data-theme='light']"));
for (const m of scope.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\s*;/g)) {
	const norm = m[2].toLowerCase().replace(/\s+/g, '');
	if (!map.has(norm)) map.set(norm, m[1]);
	// also index 6-digit form of 3-digit hexes
	if (/^#[0-9a-f]{3}$/.test(norm)) {
		map.set('#' + norm.slice(1).split('').map(c => c + c).join(''), m[1]);
	}
}
// common synonyms
map.set('#fff', map.get('#ffffff') || '--ink-bright');
map.set('#000', '--scrim-opaque');

const files = process.argv.slice(2);
for (const f of files) {
	const src = readFileSync(f, 'utf8');
	const css = f.endsWith('.css') ? src : [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
	if (!css) { console.log(`${f}: no <style> block`); continue; }
	const hits = new Map(), novel = new Map();
	for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
		const norm = m[0].toLowerCase().replace(/\s+/g, '');
		const t = map.get(norm);
		if (t) hits.set(m[0], (hits.get(m[0]) || 0) + 1);
		else novel.set(norm, (novel.get(norm) || 0) + 1);
	}
	const exact = [...hits.entries()].reduce((a, [, n]) => a + n, 0);
	const nov = [...novel.entries()].reduce((a, [, n]) => a + n, 0);
	console.log(`\n${f}  exact-token-equivalents=${exact}  novel=${nov}`);
	if (hits.size) console.log('  swap: ' + [...hits.entries()].map(([h, n]) => `${h}->${map.get(h.toLowerCase().replace(/\s+/g,''))}(${n})`).join(' '));
	const top = [...novel.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 12);
	if (top.length) console.log('  novel: ' + top.map(([h,n])=>`${h}(${n})`).join(' '));
}
