// @three-ws/glb-diff
//
// Structural diff for glTF/GLB. Answers the question a byte comparison cannot:
// not "are these files different" (a re-export always is) but "what changed,
// and will it break anything downstream".
//
// The pipeline is three steps and every one of them is a public export, because
// the interesting uses are not always the whole thing end to end:
//
//   describeModel(bytes)      bytes  ->  a plain, JSON-safe description
//   diffDescriptions(a, b)    two descriptions  ->  a change set
//   formatText(changeset)     a change set  ->  something you can read
//
// Splitting them means a browser can describe a file once, keep the (small)
// description, and diff it against many candidates without re-parsing; and a
// build can store descriptions as artifacts and diff yesterday against today
// without keeping the models themselves.

export { describeDocument, describeModel, DESCRIPTION_VERSION } from './describe.js';
export { diffDescriptions, formatBytes, CHANGESET_VERSION } from './diff.js';
export { formatText, formatMarkdown } from './format.js';
export { readDocument, isGLB } from './document.js';
export { SEVERITIES, SEVERITY_MEANING, atLeast, maxSeverity, severityRank } from './severity.js';
export { matchEntries, jaccard, ratio } from './match.js';

import { describeModel } from './describe.js';
import { diffDescriptions } from './diff.js';

/**
 * Diff two models given their raw bytes.
 *
 * @param {Uint8Array} bytesA the baseline
 * @param {Uint8Array} bytesB the candidate
 * @param {{ nameA?: string, nameB?: string }} [opts] labels carried into the report
 * @returns {Promise<object>} the change set
 *
 * @example
 * import { readFile } from 'node:fs/promises';
 * import { diffModels, formatText } from '@three-ws/glb-diff';
 *
 * const before = await readFile('avatar.v1.glb');
 * const after = await readFile('avatar.v2.glb');
 * const changes = await diffModels(before, after, { nameA: 'v1', nameB: 'v2' });
 * console.log(formatText(changes));
 * if (changes.severity === 'breaking') process.exit(1);
 */
export async function diffModels(bytesA, bytesB, opts = {}) {
	const [a, b] = await Promise.all([
		describeModel(bytesA, { name: opts.nameA || 'A' }),
		describeModel(bytesB, { name: opts.nameB || 'B' }),
	]);
	return diffDescriptions(a, b);
}
