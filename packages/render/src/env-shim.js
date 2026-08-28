/**
 * three.js' loader stack probes a handful of browser globals at module scope.
 * We removed every texture before parsing, so nothing here is ever used for
 * real work: these shims exist purely so the module graph evaluates in Node.
 * Imported for side effects, ahead of any three.js example module.
 */
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.createImageBitmap === 'undefined') {
	globalThis.createImageBitmap = () => Promise.reject(new Error('createImageBitmap is not available in Node'));
}
