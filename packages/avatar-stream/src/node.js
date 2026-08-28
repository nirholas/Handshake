/**
 * Node-only entry: packing and headless reconstruction.
 *
 * Kept separate from the isomorphic entry so a browser bundle never pulls in
 * sharp, draco, or a glTF writer it will not run.
 */

export { pack, getIO, buildLodChain, computeVertexOrder, verifyNesting, DEFAULT_LEVELS, DEFAULT_BASE_TEXTURE_SIZE } from './pack.js';
export { reconstruct, readBaseGeometry, triangleCount, triangleFingerprint } from './reconstruct.js';
export * from './index.js';
