// The fabrication gate: the last thing between a prompt and a physical object.
//
// It runs twice on every order, on purpose:
//
//   stage 'quote'     cheap and synchronous, before a price is signed. No money
//                     has moved, so a refusal here costs the buyer nothing and
//                     costs the platform one mesh analysis. Deterministic
//                     layers only (upstream verdict, denylist, geometry) so a
//                     quote is never gated on a third-party model being up.
//   stage 'screening' thorough, on the paid → screening transition. Adds the
//                     LLM pass over the same lineage. A refusal here moves the
//                     order to `rejected`, which is the refund path, and pages
//                     the operators so a human reviews the edge cases.
//
// Layer order is a precedence order, and the denylist always wins. An LLM that
// says "allow" cannot un-refuse a lower receiver; that is the whole reason the
// denylist exists as code with a test per rule (see rules.js). The LLM only
// ever ADDS refusals, or resolves a soft rule the denylist deliberately left
// undecided.
//
// What this gate does NOT claim to do is in specs/PRINT_PIPELINE.md under
// "Gate limitations". Geometry cannot identify a weapon: blade profiles,
// bores and receiver rails are not reliably detectable from a triangle soup,
// and pretending otherwise would be worse than saying so. The one geometric
// signal used here is scale, which is real: a tabletop miniature and a
// life-size component are the same words and different objects.

import { checkPromptSafety } from '../../_mcp-studio/safety.js';
import { llmComplete } from '../llm.js';
import { sql } from '../db.js';
import { databaseConfigured } from '../env.js';
import { notifyOperators } from './ops-notify.js';
import { evaluateRules, ruleById, POLICY_URL } from './rules.js';

export const GATE_VERSION = 1;
export { POLICY_URL };

// Longest bounding-box dimension, in millimetres, at or above which a
// realistic weapon likeness stops reading as a display miniature. 120 mm is
// generous: the tallest common tabletop scale (75 mm heroic) plus a base, and
// well under the ~150 mm of the shortest real handgun.
export const MINIATURE_MAX_MM = 120;

const SCREENING_SYSTEM = `You review 3D models that a manufacturing service is about to physically print.
Refuse only these categories:
- firearm components or anything that becomes part of a working firearm
- sound suppressors and the solvent-trap parts sold to convert into them
- ammunition, ammunition components, magazines and feeding devices
- working keys, lock picks, shims or other tools that defeat a real lock
- counterfeit goods, other parties' brand marks, authentication tags, currency
- working weapon mechanisms: concealed or spring-loaded blades, knuckles, caltrops
- a realistic firearm likeness printed at or near life size

Allow ordinary creative work: characters, creatures, props, jewellery, tools,
enclosures, ornaments, stylised or fantasy weapons, and miniature figures that
carry weapons at tabletop scale.

Answer with one JSON object and nothing else:
{"verdict":"allow"|"refuse","category":"<one of the ids above or null>","reason":"<one short sentence>"}`;

/**
 * Pull the prompt lineage for a creation: its own prompt plus every refine
 * instruction and parent prompt above it. A buyer can launder an intent by
 * refining ("make it functional") on top of an innocuous root, so the gate
 * reads the whole chain, not the leaf.
 *
 * Bounded to 12 hops: lineage is a chain by construction, and a cycle
 * introduced by a bad write must not spin a request.
 *
 * @returns {Promise<{ text: string, hops: number, creationIds: string[] }>}
 */
export async function loadLineage(creationId) {
	if (!creationId || !databaseConfigured()) return { text: '', hops: 0, creationIds: [] };
	const parts = [];
	const creationIds = [];
	let id = creationId;
	for (let hop = 0; hop < 12 && id; hop += 1) {
		let rows;
		try {
			rows = await sql`
				select id, prompt, refine_instruction, parent_creation_id
				from forge_creations
				where id = ${id}
				limit 1
			`;
		} catch {
			break;
		}
		const row = rows?.[0];
		if (!row || creationIds.includes(row.id)) break;
		creationIds.push(row.id);
		if (row.refine_instruction) parts.push(String(row.refine_instruction));
		if (row.prompt) parts.push(String(row.prompt));
		id = row.parent_creation_id || null;
	}
	return { text: parts.join('\n'), hops: creationIds.length, creationIds };
}

/**
 * Everything the gate reads, concatenated. The order is oldest-intent-last so
 * a truncated log still shows the buyer's own words first.
 */
export function gateSubject({ lineageText = '', modelTitle = '', buyerNote = '' } = {}) {
	return [buyerNote, modelTitle, lineageText]
		.map((s) => String(s || '').trim())
		.filter(Boolean)
		.join('\n');
}

/**
 * Scale signal. Not a weapon detector: it only answers "is this object the
 * size of a display piece or the size of a real part", which is what decides
 * a soft rule.
 */
export function geometrySignal(analysis) {
	const bbox = analysis?.bbox_mm || null;
	const longest = bbox
		? Math.max(Number(bbox.x) || 0, Number(bbox.y) || 0, Number(bbox.z) || 0)
		: null;
	if (!longest) return { longest_mm: null, miniature: null, note: 'no bounding box available' };
	return {
		longest_mm: longest,
		miniature: longest < MINIATURE_MAX_MM,
		note: `longest dimension ${longest} mm; display-miniature threshold ${MINIATURE_MAX_MM} mm`,
	};
}

function refusal({ category, label, message, allowed, layer, matched = null }) {
	return {
		verdict: 'refuse',
		category,
		label,
		layer,
		matched,
		message,
		allowed,
		policy_url: POLICY_URL,
	};
}

/**
 * The deterministic layers: the upstream generation verdict, the fabrication
 * denylist, and the scale signal. No network, no model, no database. This is
 * what runs at quote time and what runs first at screening time.
 *
 * @param {{ subject: string, analysis?: object }} input
 */
export function screenDeterministic({ subject, analysis = null }) {
	const geometry = geometrySignal(analysis);

	// Layer 1: whatever the generation gate would have refused, fabrication
	// refuses too. A mesh that should never have been generated must never be
	// manufactured, including one generated before that gate covered its terms.
	const upstream = checkPromptSafety(subject);
	if (!upstream.allowed) {
		return {
			decision: refusal({
				category: `generation_${upstream.category}`,
				label: 'generation content policy',
				layer: 'upstream',
				matched: upstream.matched || null,
				message: upstream.message,
				allowed: 'Describe a character, creature, prop or object without that theme and generate it again.',
			}),
			layers: {
				upstream: { verdict: 'refuse', category: upstream.category, matched: upstream.matched || null },
				denylist: { verdict: 'skipped' },
				geometry,
			},
		};
	}

	// Layer 2: the fabrication denylist. Hard rules refuse outright.
	const rules = evaluateRules(subject);
	if (rules.hard) {
		return {
			decision: refusal({
				category: rules.hard.id,
				label: rules.hard.label,
				layer: 'denylist',
				matched: rules.matched,
				message: rules.hard.message,
				allowed: rules.hard.allowed,
			}),
			layers: {
				upstream: { verdict: 'allow' },
				denylist: { verdict: 'refuse', rule: rules.hard.id, matched: rules.matched },
				geometry,
			},
		};
	}

	// A soft rule plus life-size geometry is the one case the deterministic
	// layers decide on their own: the words describe a firearm and the object is
	// the size of one. Below the miniature threshold it stays undecided and the
	// LLM layer resolves it at screening time.
	const soft = rules.soft.map((s) => ({ rule: s.rule.id, matched: s.matched }));
	if (rules.soft.length > 0 && geometry.miniature === false) {
		const first = rules.soft[0].rule;
		return {
			decision: refusal({
				category: first.id,
				label: first.label,
				layer: 'denylist',
				matched: rules.soft[0].matched,
				message: `${first.message} This model is ${geometry.longest_mm} mm at its longest, which is life size rather than display scale.`,
				allowed: `${first.allowed} Printing this design at under ${MINIATURE_MAX_MM} mm is allowed.`,
			}),
			layers: {
				upstream: { verdict: 'allow' },
				denylist: { verdict: 'refuse', rule: first.id, matched: rules.soft[0].matched, soft: true },
				geometry,
			},
		};
	}

	return {
		decision: { verdict: 'allow', category: null, layer: null, message: null },
		layers: {
			upstream: { verdict: 'allow' },
			denylist: { verdict: soft.length ? 'undecided' : 'allow', soft },
			geometry,
		},
	};
}

/** Pull the first JSON object out of a model's answer, tolerating prose and fences. */
function parseVerdict(text) {
	const raw = String(text || '');
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(raw.slice(start, end + 1));
		if (!parsed || typeof parsed !== 'object') return null;
		const verdict = parsed.verdict === 'refuse' ? 'refuse' : parsed.verdict === 'allow' ? 'allow' : null;
		if (!verdict) return null;
		return {
			verdict,
			category: typeof parsed.category === 'string' && parsed.category ? parsed.category : null,
			reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 400) : '',
		};
	} catch {
		return null;
	}
}

/**
 * The LLM layer. Runs only at screening time, only when the deterministic
 * layers did not already refuse, and only ever tightens the verdict.
 *
 * Its failure mode is designed rather than defaulted: when no provider answers,
 * the order does not silently pass and does not auto-reject either. It returns
 * `review`, which parks the order for an operator. Auto-rejecting a paid order
 * because a third-party model was down would refund a legitimate buyer and lose
 * the sale; auto-passing would make the layer decorative.
 */
export async function screenWithLlm({ subject, geometry, softRules = [], timeoutMs = 20_000 }) {
	const context = [
		`Request text:\n${subject.slice(0, 4000)}`,
		geometry.longest_mm
			? `Printed size: ${geometry.longest_mm} mm at its longest dimension.`
			: 'Printed size: unknown.',
		softRules.length
			? `Automated pre-screen flagged, without deciding: ${softRules.map((s) => s.rule).join(', ')}.`
			: '',
	]
		.filter(Boolean)
		.join('\n\n');

	let completion;
	try {
		completion = await llmComplete({
			system: SCREENING_SYSTEM,
			user: context,
			maxTokens: 200,
			timeoutMs,
			track: { tool: 'print-fabrication-screening' },
		});
	} catch (err) {
		return { verdict: 'review', reason: `screening model unavailable: ${err?.message || err}`, provider: null, model: null };
	}

	const parsed = parseVerdict(completion?.text);
	if (!parsed) {
		return {
			verdict: 'review',
			reason: 'screening model returned an unreadable verdict',
			provider: completion?.provider ?? null,
			model: completion?.model ?? null,
		};
	}
	return { ...parsed, provider: completion?.provider ?? null, model: completion?.model ?? null };
}

/**
 * Run the gate.
 *
 * @param {object} input
 * @param {'quote'|'screening'} input.stage
 * @param {string} [input.lineageText] prompt lineage, from loadLineage()
 * @param {string} [input.modelTitle]
 * @param {string} [input.buyerNote]
 * @param {object} [input.analysis] the printability report
 * @param {boolean} [input.useLlm] override; defaults to true at screening stage
 * @returns {Promise<object>} the verdict, stored verbatim on the order's
 *   `analysis.screening` and rendered by the refusal UI.
 */
export async function runFabricationGate({
	stage = 'quote',
	lineageText = '',
	modelTitle = '',
	buyerNote = '',
	analysis = null,
	useLlm,
}) {
	const subject = gateSubject({ lineageText, modelTitle, buyerNote });
	const deterministic = screenDeterministic({ subject, analysis });
	const base = {
		version: GATE_VERSION,
		stage,
		policy_url: POLICY_URL,
		checked_at: new Date().toISOString(),
	};

	if (deterministic.decision.verdict === 'refuse') {
		return {
			...base,
			verdict: 'refuse',
			category: deterministic.decision.category,
			label: deterministic.decision.label,
			layer: deterministic.decision.layer,
			matched: deterministic.decision.matched,
			message: deterministic.decision.message,
			allowed: deterministic.decision.allowed,
			layers: { ...deterministic.layers, llm: { verdict: 'skipped', reason: 'refused before the model layer' } },
		};
	}

	const runLlm = useLlm ?? stage === 'screening';
	if (!runLlm) {
		return {
			...base,
			verdict: 'allow',
			category: null,
			message: null,
			layers: { ...deterministic.layers, llm: { verdict: 'skipped', reason: 'deterministic layers only at quote time' } },
		};
	}

	const llm = await screenWithLlm({
		subject,
		geometry: deterministic.layers.geometry,
		softRules: deterministic.layers.denylist.soft || [],
	});

	if (llm.verdict === 'refuse') {
		// The model may name a category the denylist knows; when it does, the
		// buyer gets that rule's written message and its "what is allowed"
		// sentence rather than raw model prose.
		const known = ruleById(llm.category);
		return {
			...base,
			verdict: 'refuse',
			category: llm.category || 'fabrication_policy',
			label: known?.label || 'fabrication content policy',
			layer: 'llm',
			matched: null,
			message: known?.message || 'This model cannot be manufactured under the three.ws fabrication policy.',
			allowed: known?.allowed || 'Ordinary characters, creatures, props, ornaments and functional parts are all welcome.',
			reason: llm.reason,
			layers: { ...deterministic.layers, llm },
		};
	}

	if (llm.verdict === 'review') {
		return {
			...base,
			verdict: 'review',
			category: null,
			label: 'awaiting operator review',
			layer: 'llm',
			message: 'This order is held for a quick human review before it goes to the printer. Nothing further is needed from you.',
			allowed: null,
			layers: { ...deterministic.layers, llm },
		};
	}

	return {
		...base,
		verdict: 'allow',
		category: null,
		message: null,
		layers: { ...deterministic.layers, llm },
	};
}

/**
 * The ops-channel side effect. Every refusal and every held order is announced
 * on the same channel a stalled job uses, because both need the same thing: a
 * human looking at an edge case within the hour.
 *
 * Fire-and-forget by contract, exactly like the fulfillment notifications: a
 * refusal must still be recorded on the order when the chat is unreachable.
 */
export async function notifyGateOutcome({ orderId = '', verdict, stage }) {
	if (!verdict || (verdict.verdict !== 'refuse' && verdict.verdict !== 'review')) return;
	const held = verdict.verdict === 'review';
	await notifyOperators({
		title: held
			? `Print order held for review (${stage})`
			: `Print order refused by the fabrication gate (${stage})`,
		lines: [
			`Category: ${verdict.label || verdict.category || 'unclassified'}`,
			verdict.layer ? `Decided by: ${verdict.layer} layer` : '',
			verdict.matched ? `Matched: ${verdict.matched}` : '',
			verdict.reason ? `Model reason: ${verdict.reason}` : '',
		].filter(Boolean),
		orderId,
		alert: held,
	}).catch(() => {});
}
