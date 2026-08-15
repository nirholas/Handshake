import '@testing-library/jest-dom'
import { beforeAll, afterAll, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Mock Three.js for tests
global.THREE = {
  Object3D: class MockObject3D {
    constructor() {
      this.children = []
      this.position = { x: 0, y: 0, z: 0 }
      this.rotation = { x: 0, y: 0, z: 0 }
      this.scale = { x: 1, y: 1, z: 1 }
    }
    add(child) {
      this.children.push(child)
    }
    remove(child) {
      const index = this.children.indexOf(child)
      if (index > -1) {
        this.children.splice(index, 1)
      }
    }
  },
  Vector3: class MockVector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x
      this.y = y
      this.z = z
    }
  },
  Vector2: class MockVector2 {
    constructor(x = 0, y = 0) {
      this.x = x
      this.y = y
    }
  },
  Raycaster: class MockRaycaster {
    constructor() {
      this.ray = { origin: new global.THREE.Vector3(), direction: new global.THREE.Vector3() }
    }
    setFromCamera() {}
    intersectObjects() { return [] }
  },
}

// Mock WebGL context
global.HTMLCanvasElement.prototype.getContext = function(contextId) {
  if (contextId === 'webgl' || contextId === 'webgl2') {
    return {
      getParameter: () => 'WebGL',
      getExtension: () => null,
      createShader: () => {},
      shaderSource: () => {},
      compileShader: () => {},
      createProgram: () => {},
      attachShader: () => {},
      linkProgram: () => {},
      useProgram: () => {},
      getShaderParameter: () => true,
      getProgramParameter: () => true,
    }
  }
  return null
}

// Mock URL.createObjectURL
global.URL.createObjectURL = (blob) => `blob:${blob.type}`
global.URL.revokeObjectURL = () => {}

// Mock OffscreenCanvas for ktx2-encoder
global.OffscreenCanvas = class OffscreenCanvas {
  constructor(width, height) {
    this.width = width
    this.height = height
  }
  getContext() {
    return {
      getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
      putImageData: () => {},
      drawImage: () => {},
    }
  }
}

// File, Blob and FileReader are deliberately NOT stubbed: jsdom ships real
// implementations, and a partial FileReader stub (no onloadend, no .result)
// silently hangs three.js GLTFExporter, which reads its binary output through
// one. KTX2 compression is likewise left unstubbed; the encoder reports itself
// unavailable without a WebGL context (see src/library/ktxtools.js).

// Cleanup after each test
afterEach(() => {
  cleanup()
})

// Mock console methods to reduce noise in tests
beforeAll(() => {
  global.console = {
    ...console,
    log: () => {},
    warn: () => {},
    error: () => {},
  }
})

afterAll(() => {
  // Restore console
  global.console = console
})