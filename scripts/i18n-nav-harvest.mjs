#!/usr/bin/env node
// i18n-nav-harvest — bake the runtime-built shell strings into the source
// catalog (public/locales/en.json).
//
// The global nav (public/nav.js from public/nav-data.js) and the getting-started
// widget (public/getting-started.js) render their text with JavaScript, so the
// HTML-scanning i18n:extract never sees them. nav.js/getting-started.js emit
// `data-i18n="<navKey(text)>"` at render time; this script computes the SAME
// keys (via nav-data.js's navKey) for every English string they render and
// writes them into en.json, so i18n:translate then localizes them and the
// runtime swaps them in the injected DOM.
//
// Run before i18n:extract + i18n:translate:
//   node scripts/i18n-nav-harvest.mjs
//
// Keep the EXTRA_STRINGS lists in sync with the inline literals in nav.js and
// getting-started.js (the ones not sourced from nav-data.js).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EN_PATH = resolve(ROOT, 'public/locales/en.json');

const { NAV_GROUPS, NAV_LINKS, DRAWER_LEGAL, CHAT_SITE_LINKS, navKey } = await import(
	pathToFileURL(resolve(ROOT, 'public/nav-data.js')).href
);

// Every user-visible string the nav data model carries.
function navDataStrings() {
	const out = [];
	const push = (s) => {
		if (typeof s === 'string' && s.trim()) out.push(s);
	};
	for (const g of NAV_GROUPS || []) {
		push(g.label);
		push(g.badge);
		push(g.note);
		for (const col of g.columns || []) {
			push(col.label);
			for (const it of col.items || []) {
				push(it.title);
				push(it.desc);
				push(it.badge);
			}
		}
		for (const it of g.items || []) {
			push(it.title);
			push(it.desc);
			push(it.badge);
		}
	}
	for (const l of NAV_LINKS || []) {
		push(l.label);
		push(l.badge);
	}
	for (const l of CHAT_SITE_LINKS || []) push(l.label);
	for (const l of DRAWER_LEGAL || []) push(l.title);
	return out;
}

// Inline literals rendered by nav.js (renderDrawer + shell) that are not in
// nav-data.js. Mirror of the strings nav.js wraps with data-i18n.
const NAV_JS_STRINGS = [
	'Walk with me',
	'Off',
	'On',
	'Legal',
	'More',
	'Sign in',
	'Console →',
	'Guardian console',
	'Dashboard',
];

// Inline literals rendered by getting-started.js.
const GETTING_STARTED_STRINGS = [
	'Getting started',
	'Give your AI a body — in about five minutes',
	'Create your first avatar',
	'Selfie, text prompt, or upload — your 3D agent in a couple of minutes.',
	'Give it a brain',
	'Add a name, personality, and voice so it can talk back.',
	'Embed it anywhere',
	'Drop one line of HTML onto any site — it loads and animates itself.',
	'Own it on-chain',
	'Register your agent on-chain so its identity is verifiable.',
	'Monetize it',
	'Charge for skills and collect creator fees from the agent economy.',
	'Free · the core path',
	'Optional add-ons',
	'Optional',
];

function flatten(obj, prefix = '', out = {}) {
	for (const [k, v] of Object.entries(obj || {})) {
		const key = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
		else out[key] = v;
	}
	return out;
}
function setDeep(obj, dotted, value) {
	const parts = dotted.split('.');
	let node = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
		node = node[parts[i]];
	}
	node[parts[parts.length - 1]] = value;
}

const en = JSON.parse(readFileSync(EN_PATH, 'utf8'));
const existing = flatten(en);
const all = [...new Set([...navDataStrings(), ...NAV_JS_STRINGS, ...GETTING_STARTED_STRINGS])];

let added = 0;
for (const text of all) {
	const key = navKey(text);
	if (existing[key] === undefined) added++;
	setDeep(en, key, text);
}
writeFileSync(EN_PATH, JSON.stringify(en, null, '\t') + '\n');
console.log(`i18n-nav-harvest: ${all.length} shell string(s) → ${added} new key(s) in en.json`);
