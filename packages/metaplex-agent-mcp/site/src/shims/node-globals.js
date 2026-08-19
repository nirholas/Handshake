// Node globals the Solana stack expects, injected into the bundle by
// site/build.mjs (esbuild `inject`). @solana/web3.js and the Metaplex
// serializers reach for `Buffer` and `process.env` even on the browser path.
import { Buffer } from 'buffer';

const process = { env: {}, browser: true, version: '', nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)) };
const global = globalThis;

export { Buffer, process, global };
