// Bundled entry for the resilient CDN loader. The implementation lives in
// public/load-module.js so plain public/ scripts can import the same file by
// URL (/load-module.js); this re-export keeps one copy of the mirror logic.
export * from '../../public/load-module.js';
