/**
 * Real coverage for src/library/utils.js.
 *
 * These import the shipped functions instead of re-implementing them, so a
 * regression in the library fails the suite.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  getAsArray,
  addChildAtFirst,
  getFileNameWithoutExtension,
  getAtlasSize,
  getUniqueId,
  findChildByName,
  findChildByType,
  findChildrenByType,
  getRandomArrayValue,
} from '../../src/library/utils'

describe('getAsArray', () => {
  it('returns an array unchanged, by reference', () => {
    const input = [1, 2, 3]
    expect(getAsArray(input)).toBe(input)
  })

  it('wraps single values', () => {
    expect(getAsArray(42)).toEqual([42])
    expect(getAsArray('hello')).toEqual(['hello'])
    const obj = { key: 'value' }
    expect(getAsArray(obj)).toEqual([obj])
  })

  it('returns an empty array for null and undefined', () => {
    expect(getAsArray(null)).toEqual([])
    expect(getAsArray(undefined)).toEqual([])
  })
})

describe('addChildAtFirst', () => {
  it('puts the new child in front of the existing ones and keeps their order', () => {
    const parent = new THREE.Object3D()
    const first = new THREE.Object3D()
    const second = new THREE.Object3D()
    parent.add(first)
    parent.add(second)

    const newChild = new THREE.Object3D()
    addChildAtFirst(parent, newChild)

    expect(parent.children).toEqual([newChild, first, second])
    expect(newChild.parent).toBe(parent)
  })
})

describe('getFileNameWithoutExtension', () => {
  it('strips the directory and the extension', () => {
    expect(getFileNameWithoutExtension('/assets/models/avatar.vrm')).toBe('avatar')
    expect(getFileNameWithoutExtension('avatar.glb')).toBe('avatar')
  })
})

describe('getAtlasSize', () => {
  it('maps the merge-option index to the texture-atlas resolution', () => {
    expect(getAtlasSize(1)).toBe(128)
    expect(getAtlasSize(4)).toBe(1024)
    expect(getAtlasSize(6)).toBe(4096)
  })

  it('falls back to 4096 for an out-of-range index', () => {
    expect(getAtlasSize(0)).toBe(4096)
    expect(getAtlasSize(99)).toBe(4096)
  })
})

describe('getUniqueId', () => {
  it('never repeats across a burst of calls', () => {
    const ids = new Set()
    for (let i = 0; i < 500; i++) ids.add(getUniqueId())
    expect(ids.size).toBe(500)
  })
})

describe('scene-graph search helpers', () => {
  const buildScene = () => {
    const root = new THREE.Object3D()
    root.name = 'root'
    const hips = new THREE.Bone()
    hips.name = 'hips'
    const spine = new THREE.Bone()
    spine.name = 'spine'
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    mesh.name = 'body'
    hips.add(spine)
    root.add(hips)
    root.add(mesh)
    return { root, hips, spine, mesh }
  }

  it('finds a descendant by name at any depth', () => {
    const { root, spine } = buildScene()
    expect(findChildByName(root, 'spine')).toBe(spine)
    expect(findChildByName(root, 'missing')).toBe(null)
  })

  it('finds the first descendant of a type', () => {
    const { root, hips, mesh } = buildScene()
    expect(findChildByType(root, 'Bone')).toBe(hips)
    expect(findChildByType(root, 'Mesh')).toBe(mesh)
  })

  it('collects every descendant matching one of several types', () => {
    const { root, hips, spine, mesh } = buildScene()
    const found = findChildrenByType(root, ['Bone', 'Mesh'])
    expect(found).toHaveLength(3)
    expect(found).toEqual(expect.arrayContaining([hips, spine, mesh]))
  })
})

describe('getRandomArrayValue', () => {
  it('always picks a member of the source array', () => {
    const arr = ['a', 'b', 'c']
    for (let i = 0; i < 50; i++) expect(arr).toContain(getRandomArrayValue(arr))
  })
})
