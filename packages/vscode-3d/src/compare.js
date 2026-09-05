// Compare a model with the version git has.
//
// A pull request that touches a .glb shows a binary blob changed and nothing
// else. This reads the committed bytes straight out of git and runs the
// three.ws structural differ (@three-ws/glb-diff, the package behind the
// glb-diff CLI) over both, so the review says what actually moved: geometry,
// materials, textures, skeleton, animations, and how badly a consumer breaks.

import { execFile } from 'node:child_process';
import { dirname, basename } from 'node:path';
import { diffModels, formatMarkdown } from '../../glb-diff/src/index.js';

/**
 * The file's bytes at a git ref, read without checking anything out.
 *
 * @param {string} fsPath absolute path of the working-tree file
 * @param {string} [ref] defaults to HEAD
 * @returns {Promise<Uint8Array>}
 */
export function committedBytes(fsPath, ref = 'HEAD') {
	const dir = dirname(fsPath);
	// "./name" resolves relative to -C's directory, whatever the repo root is.
	const spec = `${ref}:./${basename(fsPath)}`;
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			['-C', dir, 'show', spec],
			{ encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					const detail = String(stderr || err.message || '').trim();
					if (/not in|does not exist|exists on disk, but not in/i.test(detail)) {
						return reject(new Error(`${basename(fsPath)} is not committed yet, so there is no version to compare against`));
					}
					if (/not a git repository/i.test(detail)) {
						return reject(new Error('this file is not inside a git repository'));
					}
					return reject(new Error(detail || 'git show failed'));
				}
				resolve(new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength));
			},
		);
	});
}

/**
 * Diff two models and render the review.
 *
 * @param {Uint8Array} before
 * @param {Uint8Array} after
 * @param {{ nameA?: string, nameB?: string }} [names]
 * @returns {Promise<{ changeset: any, markdown: string }>}
 */
export async function compareModels(before, after, { nameA = 'committed', nameB = 'working tree' } = {}) {
	const changeset = await diffModels(before, after, { nameA, nameB });
	return { changeset, markdown: formatMarkdown(changeset) };
}
