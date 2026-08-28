// @three-ws/tty-avatar: a live 3D avatar in the terminal.
//
// The typical path is resolveSource (id, URL or file to bytes), parseGlb
// (bytes to a render-ready mesh), then either a TtyAvatar viewer that owns the
// terminal or snapshot() for one frame as a string. The README shows both.
// Lower-level pieces are exported too, so a custom encoder or a headless
// render in a test never needs the viewer.

export { parseGlb, loadGlbFile, finishMesh } from './load.js';
export { createFrame, render } from './raster.js';
export { encode, encodeBlocks, encodeBraille, encodeAscii, stripAnsi, MODES } from './encode.js';
export { MOODS, MOOD_NAMES, isMood, poseAt } from './moods.js';
export { TtyAvatar } from './terminal.js';
export { resolveSource } from './resolve.js';
export {
	defaultStateDir,
	statePaths,
	writeState,
	writeEvent,
	moodForHookEvent,
	pollState,
} from './state.js';
export { claudeHooksConfig, installClaudeHooks, hookCommand } from './hooks.js';
export { snapshot } from './snapshot.js';
