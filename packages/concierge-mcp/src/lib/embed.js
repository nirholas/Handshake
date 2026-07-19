// Pure, offline generators for the three.ws Concierge embed snippets. Given a
// site's config, produce the exact copy-paste code for each install flavor the
// widget supports. No network, no side effects, this mirrors the attribute
// surface documented in the @three-ws/concierge README.

import { THREE_WS_BASE } from '../config.js';

const FLAVORS = ['script', 'web-component', 'npm', 'imperative'];

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Normalize the shared config into the attribute/option set both the tag and
// the web component accept. Unknown/empty fields are dropped so a snippet only
// carries what the caller set.
function normalize(config = {}) {
	const out = {};
	const set = (k, v) => {
		if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = String(v).trim();
	};
	set('siteName', config.siteName);
	set('name', config.name);
	set('accent', config.accent);
	set('avatar', config.avatar);
	set('customAvatar', config.customAvatar);
	set('position', config.position);
	set('theme', config.theme);
	set('greeting', config.greeting);
	set('persona', config.persona);
	set('knowledge', config.knowledge);
	set('lang', config.lang);
	if (Array.isArray(config.suggestions) && config.suggestions.length) {
		out.suggestions = config.suggestions.map((s) => String(s).trim()).filter(Boolean).slice(0, 4);
	}
	if (config.endpoint) set('endpoint', config.endpoint);
	if (config.muted) out.muted = true;
	if (config.open) out.open = true;
	if (config.noPicker) out.noPicker = true;
	if (config.noTeaser) out.noTeaser = true;
	return out;
}

const CAMEL_TO_KEBAB = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

function dataAttrs(cfg, { indent = '        ' } = {}) {
	const lines = [];
	for (const [k, v] of Object.entries(cfg)) {
		const attr = 'data-' + CAMEL_TO_KEBAB(k);
		if (v === true) lines.push(`${indent}${attr}`);
		else if (k === 'suggestions') lines.push(`${indent}${attr}="${esc(v.join('|'))}"`);
		else lines.push(`${indent}${attr}="${esc(v)}"`);
	}
	return lines.join('\n');
}

function elementAttrs(cfg, { indent = '    ' } = {}) {
	const lines = [];
	for (const [k, v] of Object.entries(cfg)) {
		const attr = CAMEL_TO_KEBAB(k);
		if (v === true) lines.push(`${indent}${attr}`);
		else if (k === 'suggestions') lines.push(`${indent}${attr}="${esc(v.join('|'))}"`);
		else lines.push(`${indent}${attr}="${esc(v)}"`);
	}
	return lines.join('\n');
}

function scriptTag(cfg) {
	const src = `${THREE_WS_BASE}/concierge/concierge.global.js`;
	const attrs = dataAttrs(cfg);
	return `<script type="module"\n        src="${src}"\n        data-concierge${attrs ? '\n' + attrs : ''}></script>`;
}

function webComponent(cfg) {
	const attrs = elementAttrs(cfg);
	return `<script type="module">import '@three-ws/concierge';</script>\n\n<three-concierge${attrs ? '\n' + attrs : ''}>\n</three-concierge>`;
}

function npmSnippet(cfg) {
	const json = JSON.stringify(cfg, null, '\t').replace(/^/gm, '\t').trim();
	return `// npm install @three-ws/concierge three\nimport { Concierge } from '@three-ws/concierge';\n\nnew Concierge(${json});`;
}

function imperativeSnippet(cfg) {
	return npmSnippet(cfg);
}

/**
 * Build the requested embed snippet(s).
 * @param {object} config  shared concierge config (siteName, accent, knowledge, ...)
 * @param {'script'|'web-component'|'npm'|'imperative'|'all'} [flavor='all']
 * @returns {{ flavor: string, snippets: Record<string,string> }}
 */
export function buildEmbed(config, flavor = 'all') {
	const cfg = normalize(config);
	const want = flavor === 'all' ? FLAVORS : [flavor];
	const snippets = {};
	for (const f of want) {
		if (f === 'script') snippets.script = scriptTag(cfg);
		else if (f === 'web-component') snippets['web-component'] = webComponent(cfg);
		else if (f === 'npm' || f === 'imperative') snippets[f] = npmSnippet(cfg);
	}
	return { flavor, config: cfg, snippets };
}

export { FLAVORS };
