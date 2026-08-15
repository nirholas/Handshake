/**
 * The studio's one public contract: it hands a finished avatar to whoever
 * embedded it. This exercises the real producer (getGLBBlobData over a real
 * three.js skinned mesh) and the real postMessage envelope the host SDK
 * listens for (avatar-sdk/src/creator.js).
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { getGLBBlobData } from '../../src/library/download-utils'
import {
  EXPORT_MESSAGE_SOURCE,
  buildExportMessage,
  isEmbedded,
  postAvatarToHost,
} from '../../src/library/embed-export'

/** Minimal but real rigged avatar: one skinned quad bound to a two-bone chain. */
const buildRiggedModel = () => {
  const hips = new THREE.Bone()
  hips.name = 'hips'
  const spine = new THREE.Bone()
  spine.name = 'spine'
  spine.position.y = 1
  hips.add(spine)

  const geometry = new THREE.PlaneGeometry(1, 2, 1, 1)
  const vertexCount = geometry.attributes.position.count
  const skinIndices = []
  const skinWeights = []
  for (let i = 0; i < vertexCount; i++) {
    const y = geometry.attributes.position.getY(i)
    const upper = y > 0 ? 1 : 0
    skinIndices.push(upper, 0, 0, 0)
    skinWeights.push(1, 0, 0, 0)
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4))

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ name: 'skin' }))
  mesh.name = 'body'
  const skeleton = new THREE.Skeleton([hips, spine])
  mesh.add(hips)
  mesh.bind(skeleton)

  const model = new THREE.Group()
  model.add(mesh)
  return model
}

const GLTF_MAGIC = 0x46546c67 // "glTF" little-endian

/** jsdom's Blob has no arrayBuffer(), so read it the way FileReader does. */
const readArrayBuffer = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })

describe('getGLBBlobData', () => {
  it('exports a rigged model as binary glTF', async () => {
    const blob = await getGLBBlobData(buildRiggedModel(), { optimized: false })

    expect(blob.type).toBe('model/gltf-binary')
    expect(blob.size).toBeGreaterThan(0)

    const buffer = await readArrayBuffer(blob)
    const header = new DataView(buffer)
    expect(header.getUint32(0, true)).toBe(GLTF_MAGIC)
    expect(header.getUint32(4, true)).toBe(2) // glTF 2.0 container
    expect(header.getUint32(8, true)).toBe(buffer.byteLength) // declared length matches
  })

  it('keeps the skeleton in the exported file', async () => {
    const blob = await getGLBBlobData(buildRiggedModel(), { optimized: false })
    const buffer = await readArrayBuffer(blob)
    const jsonLength = new DataView(buffer).getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)))

    expect(json.skins).toHaveLength(1)
    expect(json.skins[0].joints).toHaveLength(2)
    expect(json.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(['hips', 'spine']))
  })
})

describe('embedded export envelope', () => {
  it('reports embedding by comparing the window to its top', () => {
    expect(isEmbedded()).toBe(false) // vitest runs the page as top-level
  })

  it('names the source the host SDK filters on', () => {
    expect(EXPORT_MESSAGE_SOURCE).toBe('characterstudio')
    expect(buildExportMessage(new ArrayBuffer(8))).toMatchObject({
      source: 'characterstudio',
      type: 'export',
      format: 'glb',
    })
  })

  it('posts the exported avatar to the host window as a transferable', async () => {
    const blob = await getGLBBlobData(buildRiggedModel(), { optimized: false })
    const arrayBuffer = await readArrayBuffer(blob)
    const glbSize = arrayBuffer.byteLength

    const posted = []
    const hostWindow = {
      postMessage: (...args) => posted.push(args),
    }

    // Exactly what ExportMenu.saveToAccount runs when the studio is embedded.
    postAvatarToHost(arrayBuffer, hostWindow)

    expect(posted).toHaveLength(1)
    const [message, targetOrigin, transfer] = posted[0]
    expect(message.source).toBe('characterstudio')
    expect(message.type).toBe('export')
    expect(message.format).toBe('glb')
    expect(message.glb).toBeInstanceOf(ArrayBuffer)
    expect(new DataView(message.glb).getUint32(0, true)).toBe(GLTF_MAGIC)
    expect(targetOrigin).toBe('*')
    expect(transfer).toEqual([message.glb])

    // The SDK turns the payload straight back into a model/gltf-binary Blob.
    const roundTripped = new Blob([message.glb], { type: 'model/gltf-binary' })
    expect(roundTripped.size).toBe(glbSize)
    expect(roundTripped.type).toBe('model/gltf-binary')
  })
})
