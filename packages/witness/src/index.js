/*
 * @three-ws/witness
 *
 * Turn a real user session into a runnable failing test.
 *
 *   import { witness } from '@three-ws/witness';
 *   witness.start();
 *   // ... the person uses your site and something breaks ...
 *   const trace = witness.trace();
 *
 *   import { compileToPlaywright } from '@three-ws/witness/compile';
 *   const { source } = compileToPlaywright(trace, { title: 'Export does nothing' });
 *   // `source` is a Playwright spec that is RED until the bug is fixed.
 *
 * The recorder is browser-only. Everything under compile/narrate is pure and
 * runs anywhere, which is what lets the same trace produce the maintainer's
 * English steps in a dashboard and the engineer's spec file on disk.
 */

import { Recorder } from './recorder.js';

export { Recorder } from './recorder.js';
export { compileToPlaywright, narrate, failuresIn, entryRoute, replayConfidence } from './compile.js';
export { describeElement, toPlaywrightLocator, describeForHuman, accessibleName, roleOf, structuralPath } from './selector.js';
export { redactText, redactUrl, isSensitiveField, summarizeInput } from './redact.js';

let singleton = null;

/**
 * The default recorder. One per page: a second instance would double every
 * fetch wrapper and record each request twice.
 */
export const witness = {
	/**
	 * Begin recording. Idempotent, so a page that calls it from two modules
	 * still installs one recorder.
	 * @param {object} [options] see Recorder's DEFAULTS
	 */
	start(options = {}) {
		if (!singleton) singleton = new Recorder(options);
		if (!singleton.installed) singleton.install();
		return singleton;
	},
	/** The live recorder, or null when start() has not been called. */
	get current() {
		return singleton;
	},
	/** The trace so far. Empty and valid when nothing has been recorded. */
	trace() {
		return singleton ? singleton.trace() : { version: 1, recordedMs: 0, environment: {}, events: [] };
	},
	/** True when the session hit something the browser itself called a failure. */
	hasFailure(opts) {
		return singleton ? singleton.hasFailure(opts) : false;
	},
	/** Call back when a failure lands. The moment to ask "what were you doing?". */
	onFailure(fn) {
		return singleton ? singleton.onSignal(fn) : () => {};
	},
	/** Stop recording and restore every patched global. */
	stop() {
		singleton?.uninstall();
		singleton = null;
	},
};

export default witness;
