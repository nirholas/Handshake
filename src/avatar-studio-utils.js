/**
 * Pure utility helpers for the Avatar Studio — no DOM, no Three.js, no side
 * effects. Exported so they can be unit-tested in isolation.
 */

import { normalizeProportions } from './avatar-proportions.js';

export const DRAFT_KEY = 'avatar-studio-draft';
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// `garments` (additive catalog wearables, see specs/GARMENT_MANIFEST.md) are
// driven by the Studio's Wardrobe tab; `outfit` (a baked preset id) still has
// no UI anywhere. Both are carried through hydrate/collapse/clone verbatim: a
// PATCH replaces `appearance` wholesale, so dropping either here would silently
// undress an avatar opened in Studio's edit mode and saved.

/** Copy the garment list, isolating each {slot, id} entry from the source. */
function copyGarments(list) {
	return Array.isArray(list)
		? list.filter((g) => g && typeof g === 'object').map((g) => ({ ...g }))
		: [];
}

/** Collapse a working appearance to only non-empty fields. Returns null if nothing set. */
export function collapseAppearance(a) {
	if (!a) return null;
	const out = {};
	if (typeof a.outfit === 'string' && a.outfit) out.outfit = a.outfit;
	if (a.accessories?.length) out.accessories = [...a.accessories];
	if (a.morphs && Object.keys(a.morphs).length) out.morphs = { ...a.morphs };
	if (a.colors && Object.keys(a.colors).length) out.colors = { ...a.colors };
	if (a.hidden?.length) out.hidden = [...a.hidden];
	if (a.garments?.length) out.garments = copyGarments(a.garments);
	// Skeleton-space build (src/avatar-proportions.js). Normalizing here is what
	// makes the record canonical: out-of-range and neutral (1.0) values are
	// dropped, so an untouched body serializes to nothing and the appearance
	// hash stays stable across a slider that was dragged and put back.
	const proportions = normalizeProportions(a.proportions);
	if (Object.keys(proportions).length) out.proportions = proportions;
	return Object.keys(out).length ? out : null;
}

/** Hydrate a saved appearance record into a mutable working object. */
export function hydrateAppearance(raw) {
	if (!raw || typeof raw !== 'object') {
		return { outfit: null, accessories: [], morphs: {}, colors: {}, hidden: [], garments: [], proportions: {} };
	}
	return {
		outfit: typeof raw.outfit === 'string' && raw.outfit ? raw.outfit : null,
		accessories: Array.isArray(raw.accessories) ? [...raw.accessories] : [],
		morphs: raw.morphs && typeof raw.morphs === 'object' ? { ...raw.morphs } : {},
		colors: raw.colors && typeof raw.colors === 'object' ? { ...raw.colors } : {},
		hidden: Array.isArray(raw.hidden) ? [...raw.hidden] : [],
		garments: copyGarments(raw.garments),
		proportions: normalizeProportions(raw.proportions),
	};
}

/** Deep clone a working appearance. */
export function cloneAppearance(a) {
	return {
		outfit: a.outfit ?? null,
		accessories: [...a.accessories],
		morphs: { ...a.morphs },
		colors: { ...a.colors },
		hidden: [...a.hidden],
		garments: copyGarments(a.garments),
		proportions: { ...(a.proportions || {}) },
	};
}

/** True when two appearances are semantically identical. */
export function appearanceEqual(a, b) {
	return JSON.stringify(collapseAppearance(a)) === JSON.stringify(collapseAppearance(b));
}

/** Parse the edit avatar ID from a URLSearchParams (or query string). */
export function parseEditId(searchOrParams) {
	const p = typeof searchOrParams === 'string'
		? new URLSearchParams(searchOrParams)
		: searchOrParams;
	const v = p.get('edit');
	return v && v.trim() ? v.trim() : null;
}

/** Read a persisted draft from a storage-like object (localStorage interface). */
export function readDraft(storage) {
	try {
		const raw = storage.getItem(DRAFT_KEY);
		if (!raw) return null;
		const draft = JSON.parse(raw);
		if (!draft?.ts) return null;
		if (Date.now() - draft.ts > DRAFT_MAX_AGE_MS) {
			storage.removeItem(DRAFT_KEY);
			return null;
		}
		return draft;
	} catch {
		return null;
	}
}

/** Write a draft to storage. */
export function writeDraft(storage, appearance, name) {
	try {
		storage.setItem(DRAFT_KEY, JSON.stringify({ appearance, name, ts: Date.now() }));
	} catch {}
}

/** Remove a draft from storage. */
export function clearDraft(storage) {
	try { storage.removeItem(DRAFT_KEY); } catch {}
}
