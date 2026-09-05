// AI quality check for the model on screen.
//
// The viewer renders the model, the render goes to /api/forge-quality-check,
// and a vision model scores realism and completeness against the subject and
// names the defects it can see. Because the request carries an image rather
// than a URL, it works for a model that exists only on this disk.

import { normalizeOrigin } from './studio.js';

/**
 * @param {string} origin
 * @param {{ image: string, prompt?: string|null }} args image is a data: URL of the render
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ verdict: Verdict, retry: object|null }>}
 * @typedef {{ pass: boolean, score: number|null, realism: number|null, completeness: number|null,
 *   subject: string, subject_detected: string|null, defects: string[], reason: string,
 *   suggested_retry_hint: string|null, qa_available: boolean, provider: string|null, model: string|null }} Verdict
 */
export async function checkQuality(origin, { image, prompt }, { signal } = {}) {
	if (!/^data:image\/(png|jpeg|webp);base64,/.test(String(image || ''))) {
		throw new Error('the quality check needs a PNG, JPEG, or WebP render');
	}
	const url = new URL('/api/forge-quality-check', normalizeOrigin(origin)).href;
	let res;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ image, ...(prompt ? { prompt } : {}) }),
			signal,
		});
	} catch (err) {
		if (signal?.aborted) throw new Error('cancelled');
		throw new Error(`could not reach the quality check: ${err?.message || err}`);
	}
	const body = await res.json().catch(() => null);
	if (res.status === 429) throw new Error(body?.message || 'the quality check is rate limited right now; try again in a minute');
	if (!res.ok || !body?.verdict) throw new Error(body?.message || `the quality check returned HTTP ${res.status}`);
	return { verdict: body.verdict, retry: body.retry || null };
}

/**
 * The verdict as a Markdown document for the editor.
 * @param {Verdict} verdict
 * @param {{ modelName: string, prompt?: string|null }} ctx
 */
export function qualityMarkdown(verdict, { modelName, prompt }) {
	const lines = [`# Quality check: ${modelName}`, ''];
	if (!verdict.qa_available) {
		lines.push(
			'The scoring model was not reachable, so no verdict was produced. Nothing about the model failed;',
			'the check itself could not run. Try again in a moment.',
			'',
			`Reason: \`${verdict.reason || 'unknown'}\``,
		);
		return lines.join('\n');
	}
	lines.push(
		`**${verdict.pass ? 'Passes' : 'Below'} the realism bar** · score ${fmt(verdict.score)}/100`,
		'',
		'| | |',
		'|---|---|',
		`| Realism | ${fmt(verdict.realism)} |`,
		`| Completeness | ${fmt(verdict.completeness)} |`,
		`| Subject | ${verdict.subject_detected || verdict.subject || 'unknown'}${prompt ? ` (asked for: ${prompt})` : ''} |`,
		`| Photoreal | ${verdict.is_photoreal === null || verdict.is_photoreal === undefined ? 'n/a' : verdict.is_photoreal ? 'yes' : 'no'} |`,
		`| Judge | ${[verdict.provider, verdict.model].filter(Boolean).join(' · ') || 'n/a'} |`,
		'',
		'## Reading',
		'',
		verdict.reason || '',
	);
	if (verdict.defects?.length) {
		lines.push('', '## Defects', '');
		for (const d of verdict.defects) lines.push(`- ${d}`);
	}
	if (verdict.suggested_retry_hint) {
		lines.push('', '## To fix it', '', verdict.suggested_retry_hint, '', 'Run **3D: Refine this Model** with that instruction to generate a corrected version anchored to this one.');
	}
	return lines.join('\n');
}

function fmt(n) {
	return n === null || n === undefined || Number.isNaN(Number(n)) ? 'n/a' : String(Math.round(Number(n)));
}
