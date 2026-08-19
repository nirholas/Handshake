// Browser alias for `node-fetch` (wired in site/build.mjs).
//
// @metaplex-foundation/umi-http-fetch imports node-fetch unconditionally, and
// node-fetch's Node build reads `stream.Readable.prototype` at module scope,
// which throws the moment a browser bundle loads umi-bundle-defaults. Every
// browser this site targets has native fetch, so here node-fetch IS fetch.
export default (...args) => globalThis.fetch(...args);
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
