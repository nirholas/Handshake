/**
 * @three-ws/render
 * ----------------
 * Render rigged, animated 3D avatars with no GPU, no WebGL and no browser.
 *
 *   import { renderAvatar, encodePng } from '@three-ws/render';
 *
 *   const { frames } = await renderAvatar('https://three.ws/avatars/default.glb', {
 *     width: 512, height: 512, focus: 'head',
 *   });
 *   await fs.writeFile('avatar.png', encodePng(frames[0]));
 *
 * Everything is a pure function of bytes in and pixels out, so the same call
 * works in a serverless handler, a CLI, a cron job or a test.
 */

export { AvatarModel } from './model.js';
export { loadModel } from './load.js';
export { renderFrame, renderFrames, frameCamera, PRESETS, FOCUS } from './render.js';
export { encodePng, encodeApng } from './encode.js';
export { toHalfBlocks, toKitty, toITerm, detectTerminal, to256, CURSOR } from './ansi.js';
export { decodeImage, decodePng, buildMipmaps } from './image.js';
export { parseGlb, packGlb, extractImages, stripImages } from './glb.js';
export { retargetClip, normalizeBoneName } from './retarget.js';
export { parseClipJson, loadClipJson } from './clips.js';

import { AvatarModel } from './model.js';
import { loadModel } from './load.js';
import { renderFrame, renderFrames } from './render.js';

/**
 * Load a model and render it in one call.
 *
 * @param {string|ArrayBuffer|ArrayBufferView} source GLB URL, path or bytes.
 * @param {object} [options]
 * @param {string|ArrayBuffer|ArrayBufferView} [options.animation] A second GLB
 *   whose clips are retargeted onto this skeleton by bone name.
 * @param {string|number|null} [options.clip] Clip to play, by name or index.
 * @param {number} [options.frames=1] Frame count. Above 1 produces animation.
 * @returns {Promise<{model: AvatarModel, frames: Array<{width:number,height:number,data:Uint8ClampedArray}>}>}
 */
export async function renderAvatar(source, options = {}) {
	const { animation, ...rest } = options;
	const model = await AvatarModel.load(source, rest);

	if (animation) {
		const extra = await loadModel(animation, { ...rest, textures: false });
		model.addClips(extra.animations);
	}

	const frames =
		(rest.frames || 1) > 1 || rest.clip !== undefined
			? await renderFrames(model, rest)
			: [renderFrame(model, rest)];

	return { model, frames };
}
