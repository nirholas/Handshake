import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

let ioPromise;

async function getIO() {
  ioPromise ??= (async () => {
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    await MeshoptDecoder.ready;
    const deps = { 'meshopt.decoder': MeshoptDecoder };
    try {
      const draco3d = (await import('draco3dgltf')).default;
      deps['draco3d.decoder'] = await draco3d.createDecoderModule();
    } catch {
      // draco3dgltf is only needed for Draco-compressed inputs; loading a
      // Draco file without it will fail with gltf-transform's own error.
    }
    return io.registerDependencies(deps);
  })();
  return ioPromise;
}

/**
 * Load a GLB/glTF and return its triangles in world space (still Y-up).
 * Every TRIANGLES primitive of every mesh in every scene is included, with
 * node transforms baked in.
 */
export async function loadGltfTriangles(bytes) {
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(bytes));
  const triangles = [];
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const m = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue; // TRIANGLES only
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const idx = prim.getIndices();
        const count = idx ? idx.getCount() : pos.getCount();
        for (let i = 0; i + 2 < count; i += 3) {
          const tri = [];
          for (let j = 0; j < 3; j++) {
            const vi = idx ? idx.getScalar(i + j) : i + j;
            const [x, y, z] = pos.getElement(vi, []);
            tri.push([
              m[0] * x + m[4] * y + m[8] * z + m[12],
              m[1] * x + m[5] * y + m[9] * z + m[13],
              m[2] * x + m[6] * y + m[10] * z + m[14],
            ]);
          }
          triangles.push(tri);
        }
      }
    });
  }
  return triangles;
}
