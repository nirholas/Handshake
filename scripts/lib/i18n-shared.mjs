// Shared helpers for the three.ws i18n pipeline (extract + translate + lint).
//
// The pipeline mirrors LobeHub's lobe-i18n: a single source-of-truth catalog
// (the entryLocale) is translated incrementally into target locales by an LLM,
// with brand/protocol terms masked so they can never be altered, and the output
// committed as static JSON. This module holds the pure, testable plumbing both
// CLIs depend on.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadConfig() {
	const path = resolve(ROOT, '.i18nrc.json');
	if (!existsSync(path)) throw new Error('.i18nrc.json not found at repo root');
	const cfg = JSON.parse(readFileSync(path, 'utf8'));
	cfg.localeNames ||= {};
	cfg.rtlLocales ||= [];
	cfg.doNotTranslate ||= [];
	return cfg;
}

export function readJSON(path, fallback = undefined) {
	if (!existsSync(path)) return fallback;
	return JSON.parse(readFileSync(path, 'utf8'));
}

// --- nested-object key utilities (keyStyle: nested) -----------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Flatten { a: { b: "x" } } → { "a.b": "x" } for diffing and validation.
export function flatten(obj, prefix = '', out = {}) {
	for (const [k, v] of Object.entries(obj || {})) {
		const key = prefix ? `${prefix}.${k}` : k;
		if (isPlainObject(v)) flatten(v, key, out);
		else out[key] = v;
	}
	return out;
}

export function setDeep(obj, dottedKey, value) {
	const parts = dottedKey.split('.');
	let node = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		if (!isPlainObject(node[parts[i]])) node[parts[i]] = {};
		node = node[parts[i]];
	}
	node[parts[parts.length - 1]] = value;
	return obj;
}

export function getDeep(obj, dottedKey) {
	return dottedKey
		.split('.')
		.reduce((n, p) => (isPlainObject(n) || Array.isArray(n) ? n[p] : undefined), obj);
}

// Keys present (and non-empty) in `source` but missing/empty in `target`.
export function missingKeys(source, target) {
	const src = flatten(source);
	const tgt = flatten(target || {});
	return Object.keys(src).filter((k) => {
		const v = tgt[k];
		return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
	});
}

// How many keys in a catalog are present but not actually translated.
//
// A translate run that dies partway (expired credentials, an exhausted provider)
// still writes the full key skeleton with empty-string values for everything it
// never reached, so the catalog looks finished by key count while rendering as a
// half-translated page. Callers use this to tell "complete" from "merely present"
// before shipping a locale. Same empty-string rule as missingKeys, so a catalog
// with count 0 is exactly one that a resumed run would find nothing to do for.
export function untranslatedCount(catalog) {
	let n = 0;
	for (const value of Object.values(flatten(catalog || {}))) {
		if (typeof value !== 'string' || value.trim() === '') n++;
	}
	return n;
}

// Keys present in target but no longer in source — stale translations to prune.
export function staleKeys(source, target) {
	const src = flatten(source);
	const tgt = flatten(target || {});
	return Object.keys(tgt).filter((k) => !(k in src));
}

// Deep-merge translated values into an existing target, preserving key order of
// the source so committed diffs stay readable.
export function mergeOrdered(source, existing = {}, translated = {}) {
	const out = Array.isArray(source) ? [] : {};
	for (const [k, v] of Object.entries(source)) {
		if (isPlainObject(v)) {
			out[k] = mergeOrdered(v, existing?.[k] || {}, translated?.[k] || {});
		} else {
			// Prefer a freshly translated value, then a prior translation, else blank.
			out[k] = translated?.[k] ?? existing?.[k] ?? '';
		}
	}
	return out;
}

// --- glossary masking -----------------------------------------------------
//
// Brand/protocol terms (and {{interpolation}} placeholders and HTML tags) are
// swapped for opaque sentinels BEFORE the text reaches the model and restored
// AFTER. This guarantees `$THREE`, the contract address, etc. are returned
// byte-for-byte — the model literally never sees them, so it can't translate,
// localize, or hallucinate around them.

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g; // {{count}}
const TAG_RE = /<\/?[a-zA-Z][^>]*>/g; // <br/>, <strong>, </strong>

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildMasker(doNotTranslate = []) {
	// Longer terms first so "IBM watsonx.ai" masks before "watsonx.ai".
	const terms = [...doNotTranslate].sort((a, b) => b.length - a.length);
	// An ASCII token ([[T0]], [[T1]], …): vanishingly rare in real copy and
	// reproduced reliably even by small/free models, which tend to normalize
	// exotic Unicode sentinels away.
	const sentinel = (i) => `[[T${i}]]`;

	function mask(text) {
		if (typeof text !== 'string') return { masked: text, tokens: [] };
		const tokens = [];
		let masked = text;
		const stash = (re) => {
			masked = masked.replace(re, (m) => {
				const id = tokens.length;
				tokens.push(m);
				return sentinel(id);
			});
		};
		// Order matters: placeholders and tags first, then literal glossary terms.
		stash(PLACEHOLDER_RE);
		stash(TAG_RE);
		for (const term of terms) {
			if (!term) continue;
			stash(new RegExp(escapeRe(term), 'g'));
		}
		return { masked, tokens };
	}

	function unmask(text, tokens) {
		if (typeof text !== 'string') return text;
		return text.replace(/\[\[T(\d+)\]\]/g, (_, i) => tokens[Number(i)] ?? '');
	}

	return { mask, unmask };
}

// --- validation (lint) ----------------------------------------------------

// Returns an array of human-readable problems; empty array means the locale is
// structurally sound against the source.
export function lintLocale(source, target, { code, doNotTranslate = [] } = {}) {
	const problems = [];
	const src = flatten(source);
	const tgt = flatten(target || {});

	for (const k of Object.keys(src)) {
		const sv = src[k];
		const tv = tgt[k];
		if (tv === undefined) {
			problems.push(`[${code}] missing key: ${k}`);
			continue;
		}
		if (typeof tv === 'string' && tv.trim() === '') {
			problems.push(`[${code}] empty value: ${k}`);
			continue;
		}
		if (typeof sv !== 'string' || typeof tv !== 'string') continue;

		// Every {{placeholder}} in the source must survive in the translation.
		const srcVars = (sv.match(PLACEHOLDER_RE) || []).sort();
		const tgtVars = (tv.match(PLACEHOLDER_RE) || []).sort();
		if (srcVars.join('|') !== tgtVars.join('|')) {
			problems.push(
				`[${code}] placeholder drift in ${k}: ${srcVars.join(',') || '∅'} → ${tgtVars.join(',') || '∅'}`,
			);
		}

		// Any do-not-translate term in the source must appear verbatim.
		for (const term of doNotTranslate) {
			if (sv.includes(term) && !tv.includes(term)) {
				problems.push(`[${code}] glossary term dropped in ${k}: "${term}"`);
			}
		}
	}

	for (const k of Object.keys(tgt)) {
		if (!(k in src)) problems.push(`[${code}] stale key (not in source): ${k}`);
	}
	return problems;
}
