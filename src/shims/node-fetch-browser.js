// Browser alias for `node-fetch` (wired in vite.config.js resolve.alias).
//
// @metaplex-foundation/umi-http-fetch imports node-fetch unconditionally, and
// node-fetch's Node build reaches for `stream.Readable.prototype` at module
// scope, which crashes any browser bundle that pulls umi-bundle-defaults
// (first hit: /deploy-onchain). Every browser we ship to has native fetch, so
// in browser bundles `node-fetch` IS the platform fetch.
export default (...args) => globalThis.fetch(...args);
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
