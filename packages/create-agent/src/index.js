/**
 * @three-ws/create-agent
 *
 * One command from a sentence to a rigged 3D agent:
 *
 *   npm create @three-ws/agent "a friendly cartoon astronaut"
 *
 * The programmatic entry point is `createAgent()`, so the same pipeline can run
 * inside a build script, a bot, or another CLI.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { callForge, downloadModel, ForgeError, FORGE_ORIGIN } from './forge.js';
import { projectFiles, slugify, titleFrom, embedSnippet } from './scaffold.js';

export { ForgeError, FORGE_ORIGIN, embedSnippet, slugify, titleFrom };
export { callForge, downloadModel } from './forge.js';
export { projectFiles, demoPage, agentRecord, readme, LOADER_URL } from './scaffold.js';

/**
 * Generate an agent and write a runnable project.
 *
 * @param {object} opts
 * @param {string} [opts.prompt] what to make ("a friendly cartoon astronaut")
 * @param {string} [opts.imageUrl] an https reference image, instead of a prompt
 * @param {string} [opts.out] target directory (default: a slug of the prompt)
 * @param {string} [opts.name] display name (default: derived from the prompt)
 * @param {boolean} [opts.rig] rig the result as a humanoid (default true)
 * @param {boolean} [opts.download] write agent.glb locally (default true)
 * @param {(e:{phase:string,message:string,elapsedMs:number}) => void} [opts.onProgress]
 * @param {string} [opts.origin]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{dir:string, files:string[], result:object, name:string, bytes:number}>}
 */
export async function createAgent({
	prompt,
	imageUrl,
	out,
	name,
	rig = true,
	download = true,
	onProgress = () => {},
	origin = FORGE_ORIGIN,
	fetchImpl,
	signal,
} = {}) {
	if (!prompt && !imageUrl) {
		throw new ForgeError('describe what to make, or pass a reference image url', {
			code: 'no_input',
		});
	}
	if (prompt && String(prompt).trim().length < 3) {
		throw new ForgeError('the description needs at least 3 characters', { code: 'short_prompt' });
	}
	if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
		throw new ForgeError('a reference image must be a public https url', { code: 'bad_image' });
	}

	const displayName = name || titleFrom(prompt || 'agent');
	const dir = resolve(out || slugify(prompt || 'agent'));

	const result = await callForge({
		tool: rig ? 'forge_avatar' : 'forge_free',
		args: rig
			? imageUrl
				? { image_url: imageUrl }
				: { prompt }
			: { prompt, tier: 'draft' },
		onProgress,
		origin,
		fetchImpl,
		signal,
	});

	await mkdir(dir, { recursive: true });
	const files = projectFiles({ name: displayName, prompt, imageUrl, result, dir });
	for (const [file, contents] of Object.entries(files)) {
		await writeFile(join(dir, file), contents, 'utf8');
	}

	let bytes = 0;
	if (download) {
		onProgress({ phase: 'download', elapsedMs: 0, message: 'downloading the model' });
		const buffer = await downloadModel(result.glbUrl, { fetchImpl });
		await writeFile(join(dir, 'agent.glb'), buffer);
		bytes = buffer.length;
	}

	return {
		dir,
		files: Object.keys(files).concat(download ? ['agent.glb'] : []),
		result,
		name: displayName,
		bytes,
	};
}
