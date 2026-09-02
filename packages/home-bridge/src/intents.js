/**
 * "Good night" is not a feature we invent. It is a scene the user already built
 * in Home Assistant, in an editor they already know, and our job is to find it.
 *
 * This module maps a spoken phrase onto an existing `scene.*` or `script.*`
 * entity. Composing individual service calls is the fallback, never the first
 * move: a user's own "Bedtime" scene knows about the plant light and the fish
 * tank, and no amount of LLM reasoning over an entity list will.
 *
 * Matching is uFuzzy (already a three.ws dependency, ~7 kB, MIT) over the
 * candidate names, layered under a synonym table for the handful of macros that
 * every house has under a different name.
 */

import uFuzzy from '@leeoniya/ufuzzy';

import { domainOf } from './rooms.js';

const uf = new uFuzzy({ intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1 });

/**
 * The canonical household macros. `triggers` are what a person says; `targets`
 * are the word stems that show up in what they named the scene.
 */
export const MACROS = {
	good_night: {
		label: 'Good night',
		triggers: ['good night', 'goodnight', 'night night', 'bedtime', 'going to bed', 'off to bed', 'time for bed', 'sleep now'],
		targets: ['night', 'bed', 'sleep', 'nacht', 'noche'],
	},
	leaving: {
		label: 'Leaving',
		triggers: ['im leaving', 'i am leaving', 'leaving now', 'heading out', 'goodbye', 'bye', 'see you later', 'going out', 'away mode', 'set away'],
		targets: ['away', 'leav', 'depart', 'out', 'goodbye', 'vacation'],
	},
	arriving: {
		label: 'Arriving',
		triggers: ['im home', 'i am home', 'im back', 'back home', 'just got in', 'welcome home', 'arriving'],
		targets: ['home', 'arriv', 'welcome', 'return', 'back'],
	},
	morning: {
		label: 'Good morning',
		triggers: ['good morning', 'morning', 'wake up', 'time to get up', 'rise and shine'],
		targets: ['morning', 'wake', 'sunrise', 'daybreak'],
	},
	movie: {
		label: 'Movie time',
		triggers: ['movie time', 'movie night', 'watch a movie', 'lets watch something', 'cinema mode', 'film night'],
		targets: ['movie', 'cinema', 'theater', 'theatre', 'film', 'netflix'],
	},
	focus: {
		label: 'Focus',
		triggers: ['time to work', 'focus mode', 'work mode', 'do not disturb', 'concentrate'],
		targets: ['focus', 'work', 'office', 'study', 'concentrat'],
	},
};

function normalize(text) {
	return String(text || '')
		.toLowerCase()
		.replace(/['’`]/g, '')
		.replace(/[^a-z0-9\s]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Which canonical macro, if any, a phrase is asking for. */
export function matchMacro(phrase) {
	const p = normalize(phrase);
	if (!p) return null;
	let best = null;
	for (const [key, macro] of Object.entries(MACROS)) {
		for (const trigger of macro.triggers) {
			const t = normalize(trigger);
			let score = 0;
			if (p === t) score = 1;
			else if (p.includes(t)) score = 0.9 - Math.min(0.2, (p.length - t.length) / 100);
			else if (t.includes(p) && p.length >= 4) score = 0.7;
			if (score > (best?.score ?? 0)) best = { key, macro, score, trigger };
		}
	}
	return best && best.score >= 0.7 ? best : null;
}

/**
 * @param {string} phrase what the user said
 * @param {Array<{ entityId: string, name: string, aliases?: string[] }>} candidates
 *   every `scene.*` and `script.*` entity in the house
 * @returns {{ entityId: string, name: string, kind: string, macro: string|null, confidence: number, reason: string }|null}
 */
export function resolveIntent(phrase, candidates = []) {
	const usable = candidates.filter((c) => {
		const d = domainOf(c.entityId);
		return d === 'scene' || d === 'script';
	});
	if (!usable.length) return null;

	const macro = matchMacro(phrase);
	const searchText = usable.map((c) => normalize([c.name, c.entityId.replace(/^[a-z_]+\./, '').replace(/_/g, ' '), ...(c.aliases || [])].join(' ')));

	// A macro hit looks for its own vocabulary in the scene names first. This is
	// what turns "good night" into the user's "Bedtime" scene, which no direct
	// string match on the phrase would ever find.
	if (macro) {
		let bestIdx = -1;
		let bestLen = 0;
		for (let i = 0; i < usable.length; i++) {
			for (const target of macro.macro.targets) {
				if (searchText[i].includes(target) && target.length > bestLen) {
					bestIdx = i;
					bestLen = target.length;
				}
			}
		}
		if (bestIdx >= 0) {
			const hit = usable[bestIdx];
			return {
				entityId: hit.entityId,
				name: hit.name,
				kind: domainOf(hit.entityId),
				macro: macro.key,
				confidence: Number(Math.min(0.99, 0.75 + macro.score * 0.2).toFixed(2)),
				reason: `"${phrase}" is the ${macro.macro.label} macro, and ${hit.name} is this home's version of it.`,
			};
		}
	}

	// No macro, or the house has no scene named for it: fall back to matching the
	// literal phrase against the scene names.
	const q = normalize(phrase);
	const idxs = q ? uf.filter(searchText, q) : null;
	if (idxs && idxs.length) {
		const info = uf.info(idxs, searchText, q);
		const order = uf.sort(info, searchText, q);
		const hit = usable[info.idx[order[0]]];
		return {
			entityId: hit.entityId,
			name: hit.name,
			kind: domainOf(hit.entityId),
			macro: macro?.key || null,
			confidence: 0.6,
			reason: `"${phrase}" matches the name of ${hit.name}.`,
		};
	}

	return null;
}
