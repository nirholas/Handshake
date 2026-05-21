import React, { useCallback, useEffect, useRef } from 'react';
import {
  LinearFilter,
  MeshStandardMaterial,
  Material,
  Vector2,
  Object3D,
  SkinnedMesh,
  Euler,
  Vector3,
  BufferGeometry,
  Skeleton,
  Group,
  Texture,
  Mesh,
  Object3DEventMap
} from 'three';
import { useFrame } from '@react-three/fiber';
import type { ObjectMap, SkinnedMeshProps } from '@react-three/fiber';
import { GLTF, GLTFLoader, DRACOLoader, GLTFLoaderPlugin } from 'three-stdlib';
import { suspend } from 'suspend-react';
import { Emotion } from 'src/components/Avatar/Avatar.component';
import { BloomConfiguration, MaterialConfiguration } from 'src/types';
import { MeshoptDecoder } from './meshopt_decoder';
import { GLTFAnimationPointerExtension } from './GLTFLoaderAnimationPointer';
import { getAnimation } from './Animation.service';

export interface CustomNode extends Object3D {
  geometry: BufferGeometry;
  material: Material;
  skeleton: Skeleton;
  isMesh: boolean;
  morphTargetInfluences?: number[];
}

export interface Nodes {
  [node: string]: Object3D;
}

type Source = string | string[] | Blob | undefined | null;

export const getStoryAssetPath = (publicAsset: string) => getAnimation(publicAsset);

const validateSource = (source: Source): boolean => {
  if (Array.isArray(source)) {
    return source.length > 0 && source.every(validateSource);
  }

  if (typeof source === 'string') {
    const fileEndExpression = new RegExp(/(.glb|.fbx|.fbx[?].*|.glb[?].*)$/g);
    const uploadFileExpression = new RegExp(/^data:application\/octet-stream;base64,/g);
    const gltfModelExpression = new RegExp(/^data:model\/gltf-binary;base64,/g);
    return fileEndExpression.test(source) || uploadFileExpression.test(source) || gltfModelExpression.test(source);
  }

  if (source instanceof Blob) {
    return source.type === 'model/gltf-binary';
  }

  return false;
};

export const isValidFormat = (source: Source): source is Blob | string => {
  const isValid = validateSource(source);

  if (source && !isValid) {
    console.warn(
      'Provided GLB/FBX is invalid. Check docs for supported formats: https://github.com/nirholas/three.ws/tree/main/vendor/three-ws-fork/viewer'
    );
  }

  return isValid;
};

export const clamp = (value: number, max: number, min: number): number => Math.min(Math.max(min, value), max);

export const lerp = (start: number, end: number, time = 0.05): number => start * (1 - time) + end * time;

function traverseMaterials(object: Object3D, callback: (material: Material) => void) {
  object.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.geometry) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach(callback);
  });
}

export function traverseMeshes(object: Object3D, callback: (material: Mesh) => void) {
  object.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.geometry || !mesh.isMesh) return;
    callback(mesh);
  });
}

const disposeGltfScene = (scene: Group<Object3DEventMap>) => {
  scene.traverse((node) => {
    if (node instanceof SkinnedMesh && node.skeleton) {
      node.geometry.dispose();
      node.skeleton.dispose();
    }

    if (node instanceof Mesh) {
      node.geometry.dispose();
    }
  });

  traverseMaterials(scene, (material: Material) => {
    Object.values(material).forEach((value) => {
      if (value instanceof Texture) {
        value.dispose();
      }
    });

    material.dispose();
  });

  scene.clear();
};

/**
 * Avoid texture pixelation and add depth effect.
 */
export const normaliseMaterialsConfig = (
  scene: Group<Object3DEventMap>,
  bloomConfig?: BloomConfiguration,
  materialConfig?: MaterialConfiguration
) => {
  traverseMaterials(scene, (material: Material) => {
    const mat = material as MeshStandardMaterial;
    if (mat.map) {
      mat.map.minFilter = LinearFilter;
      mat.depthWrite = true;
    }

    if (mat.name.toLowerCase().includes('hair')) {
      mat.roughness = 0.9;
    }

    if (mat.emissiveMap) {
      mat.emissiveIntensity = bloomConfig?.materialIntensity ?? materialConfig?.emissiveIntensity ?? 3.3;
    }
  });
};

interface UseHeadMovement {
  nodes: Nodes;
  isHalfBody?: boolean;
  distance?: number;
  activeRotation?: number;
  rotationMargin?: Vector2;
  enabled?: boolean;
}

/**
 * Avatar head movement relative to cursor.
 * When the model isn't a standard three.ws avatar, the head movement won't take effect.
 */
export const useHeadMovement = ({
  nodes,
  isHalfBody = false,
  distance = 2,
  activeRotation = 0.2,
  rotationMargin = new Vector2(5, 10),
  enabled = false
}: UseHeadMovement) => {
  const rad = Math.PI / 180;
  const currentPos = new Vector2(0, 0);
  const targetPos = new Vector2(0, 0);
  const activeDistance = distance - (isHalfBody ? 1 : 0);
  const eyeRotationOffsetX = isHalfBody ? 90 * rad : 0;
  const neckBoneRotationOffsetX = (isHalfBody ? -5 : 10) * rad;
  const mapRange = (value: number, inMin: number, inMax: number, outMin: number, outMax: number) =>
    ((clamp(value, inMax, inMin) - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;

  useFrame((state) => {
    if (!enabled || !nodes.Neck || !nodes.Head || !nodes.RightEye || !nodes.LeftEye) {
      return;
    }

    const cameraToHeadDistance = state.camera.position.distanceTo(nodes.Head.position);
    const cameraRotation = Math.abs(state.camera.rotation.z);

    if (cameraToHeadDistance < activeDistance && cameraRotation < activeRotation) {
      targetPos.x = mapRange(state.mouse.y, -0.5, 1, rotationMargin.x * rad, -rotationMargin.x * rad);
      targetPos.y = mapRange(state.mouse.x, -0.5, 0.5, -rotationMargin.y * rad, rotationMargin.y * rad);
    } else {
      targetPos.set(0, 0);
    }

    currentPos.x = lerp(currentPos.x, targetPos.x);
    currentPos.y = lerp(currentPos.y, targetPos.y);
    /* eslint-disable no-param-reassign */
    nodes.Neck.rotation.x = currentPos.x + neckBoneRotationOffsetX;
    nodes.Neck.rotation.y = currentPos.y;

    nodes.Head.rotation.x = currentPos.x;
    nodes.Head.rotation.y = currentPos.y;

    nodes.RightEye.rotation.x = currentPos.x - eyeRotationOffsetX;
    nodes.LeftEye.rotation.x = currentPos.x - eyeRotationOffsetX;

    if (isHalfBody) {
      nodes.RightEye.rotation.z = currentPos.y * 2 + Math.PI;
      nodes.LeftEye.rotation.z = currentPos.y * 2 + Math.PI;
    } else {
      nodes.RightEye.rotation.y = currentPos.y * 2;
      nodes.LeftEye.rotation.y = currentPos.y * 2;
    }
  });
};

/**
 * Transfers Bone positions from source to target.
 * @param targetNodes {object} - object that will be mutated
 * @param sourceNodes {object} - object that will be used as reference
 */
export const mutatePose = (targetNodes?: ObjectMap['nodes'], sourceNodes?: ObjectMap['nodes']) => {
  if (targetNodes && sourceNodes) {
    Object.keys(targetNodes).forEach((key) => {
      if (targetNodes[key].type === 'Bone' && sourceNodes[key]) {
        /* eslint-disable no-param-reassign */
        const pos = sourceNodes[key].position;
        targetNodes[key].position.set(pos.x, pos.y, pos.z);

        const rot = sourceNodes[key].rotation;
        targetNodes[key].rotation.set(rot.x, rot.y, rot.z);
      }
    });
  }
};

export const useEmotion = (nodes: ObjectMap['nodes'] | Group, emotion?: Emotion) => {
  useEffect(() => {
    let meshes: SkinnedMesh[] = [];

    if (nodes instanceof Group) {
      nodes.traverse((object) => {
        if (object instanceof SkinnedMesh && object.morphTargetInfluences) {
          meshes.push(object);
        }
      });
    } else {
      // @ts-ignore
      meshes = Object.values(nodes).filter((item: SkinnedMesh) => item?.morphTargetInfluences) as SkinnedMesh[];
    }

    const resetEmotions = () => {
      meshes.forEach((mesh) => {
        if (mesh.morphTargetInfluences) {
          mesh.morphTargetInfluences.fill(0);
        }
      });
    };

    if (emotion) {
      resetEmotions();

      meshes.forEach((mesh) => {
        Object.entries(emotion).forEach(([shape, value]) => {
          const shapeId = mesh?.morphTargetDictionary?.[shape];

          if (shapeId) {
            mesh!.morphTargetInfluences![shapeId] = value;
          }
        });
      });
    } else {
      resetEmotions();
    }
  }, [emotion, nodes]);
};

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

loader.register((parser) => new GLTFAnimationPointerExtension(parser) as unknown as GLTFLoaderPlugin);

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.5/');
loader.setDRACOLoader(dracoLoader);

async function loadGltf(source: Blob | string): Promise<GLTF> {
  let gltf: GLTF;

  if (source instanceof Blob) {
    const url = URL.createObjectURL(source);
    try {
      gltf = await loader.loadAsync(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    gltf = await loader.loadAsync(source);
  }

  return gltf;
}

export const useGltfLoader = (source: Blob | string): GLTF =>
  suspend(async () => loadGltf(source), [source], { lifespan: 100 });

export const useGltfCachedLoader = (source: Blob | string): GLTF => {
  const cachedGltf = useRef<GLTF | null>(null);
  const prevSource = useRef<Blob | string | null>(null);

  const scene = suspend(
    async (): Promise<GLTF> => {
      if (source === prevSource.current && cachedGltf.current) {
        return cachedGltf.current;
      }

      const gltf = await loadGltf(source);

      cachedGltf.current = gltf;
      prevSource.current = source;

      return gltf;
    },
    [source],
    { lifespan: 100 }
  );

  useEffect(
    () => () => {
      if (scene) {
        disposeGltfScene(scene.scene);
      }
    },
    [scene]
  );

  return scene;
};

export function usePersistantRotation(scene: Group) {
  const refToPreviousScene = useRef(scene);

  useEffect(() => {
    if (refToPreviousScene.current !== scene) {
      // eslint-disable-next-line no-param-reassign
      scene.rotation.y = refToPreviousScene.current.rotation.y;
      refToPreviousScene.current = scene;
    }
  }, [scene]);
}

export class Transform {
  constructor() {
    this.scale = new Vector3(1, 1, 1);
    this.rotation = new Euler(0, 0, 0);
    this.position = new Vector3(0, 0, 0);
  }

  scale: Vector3;

  rotation: Euler;

  position: Vector3;
}

/**
 * Builds a fallback model for given scene.
 * Useful for displaying as the suspense fallback object.
 */
function buildFallbackScene(scene: Group, transform: Transform = new Transform()) {
  return (
    <primitive object={scene} scale={transform.scale} rotation={transform.rotation} position={transform.position} />
  );
}

export const useFallbackScene = (scene: Group, setter?: (fallback: JSX.Element) => void) => {
  const previousSceneRef = useRef<Group>();

  useEffect(() => {
    const newScene = scene.clone();

    if (typeof setter === 'function') {
      setter(buildFallbackScene(newScene));
    }

    if (previousSceneRef.current) {
      disposeGltfScene(previousSceneRef.current);
    }

    previousSceneRef.current = newScene;

    return () => {
      if (previousSceneRef.current) {
        disposeGltfScene(previousSceneRef.current);
      }
    };
  }, [scene, setter]);
};

/**
 * Builds a fallback model for given nodes.
 * Useful for displaying as the suspense fallback object.
 */
function buildFallback(nodes: Nodes, transform: Transform = new Transform()): JSX.Element {
  return (
    <group>
      {Object.keys(nodes).map((key) => {
        const node = nodes[key] as CustomNode;
        if (node.type === 'SkinnedMesh') {
          return (
            <skinnedMesh
              castShadow
              receiveShadow
              key={node.name}
              scale={transform.scale}
              position={transform.position}
              rotation={transform.rotation}
              geometry={node.geometry}
              material={node.material}
              skeleton={node.skeleton}
              morphTargetInfluences={node.morphTargetInfluences || []}
            />
          );
        }

        if (node.type === 'Mesh') {
          return (
            <mesh
              attach={(parent, self) => {
                parent.add(self);
                self.parent = node.parent;
                return () => parent.remove(self);
              }}
              castShadow
              receiveShadow
              key={node.name}
              scale={node.scale}
              position={node.position}
              rotation={node.rotation}
              geometry={node.geometry}
              material={node.material}
              morphTargetInfluences={node.morphTargetInfluences || []}
            />
          );
        }

        return null;
      })}
    </group>
  );
}

export const useFallback = (nodes: Nodes, setter?: (fallback: JSX.Element) => void) =>
  useEffect(() => {
    if (typeof setter === 'function') {
      setter(buildFallback(nodes));
    }
  }, [setter, nodes]);

export const triggerCallback = (callback?: () => void) => {
  if (typeof callback === 'function') {
    callback();
  }
};

export const expressions = {
  blink: [
    {
      morphTarget: 'eyesClosed',
      morphTargetIndex: -1,
      offset: 0,
      duration: 0.2
    },
    {
      morphTarget: 'eyeSquintLeft',
      morphTargetIndex: -1,
      offset: 0,
      duration: 0.2
    },
    {
      morphTarget: 'eyeSquintRight',
      morphTargetIndex: -1,
      offset: 0,
      duration: 0.2
    }
  ]
};

/**
 * Animates avatars facial expressions when morphTargets=ARKit,Eyes Extra is provided with the avatar.
 */
export const useIdleExpression = (expression: keyof typeof expressions, nodes: Nodes | Group) => {
  let headMesh: SkinnedMeshProps;

  if (nodes instanceof Group) {
    headMesh = (nodes.getObjectByName('Wolf3D_Head') ||
      nodes.getObjectByName('Wolf3D_Avatar') ||
      nodes.getObjectByName('head')) as unknown as SkinnedMeshProps;
  } else {
    headMesh = (nodes.Wolf3D_Head || nodes.Wolf3D_Avatar || nodes.head) as unknown as SkinnedMeshProps;
  }

  const selectedExpression = expression in expressions ? expressions[expression] : undefined;
  const timeout = useRef<NodeJS.Timeout>();
  const duration = useRef<number>(Number.POSITIVE_INFINITY);

  useEffect(() => {
    if (headMesh?.morphTargetDictionary && selectedExpression) {
      for (let i = 0; i < selectedExpression.length; i++) {
        selectedExpression[i].morphTargetIndex = headMesh.morphTargetDictionary[selectedExpression[i].morphTarget];
      }
    }
  }, [selectedExpression, headMesh?.morphTargetDictionary]);

  const animateExpression = useCallback(
    (delta: number) => {
      if (headMesh?.morphTargetInfluences && selectedExpression) {
        duration.current += delta;

        for (let i = 0; i < selectedExpression.length; i++) {
          const section = selectedExpression[i];

          if (duration.current < section.duration + section.offset) {
            if (duration.current > section.offset) {
              const pivot = ((duration.current - section.offset) / section.duration) * Math.PI;
              const morphInfluence = Math.sin(pivot);
              headMesh.morphTargetInfluences[section.morphTargetIndex] = morphInfluence;
            }
          } else {
            headMesh.morphTargetInfluences[section.morphTargetIndex] = 0;
          }
        }
      }
    },
    [headMesh?.morphTargetInfluences, selectedExpression, duration.current, timeout.current]
  );

  const setNextInterval = () => {
    duration.current = 0;
    const delay = Math.random() * 3000 + 3000;

    clearTimeout(timeout.current);
    timeout.current = setTimeout(setNextInterval, delay);
  };

  useEffect(() => {
    if (selectedExpression) {
      timeout.current = setTimeout(setNextInterval, 3000);
    }

    return () => {
      clearTimeout(timeout.current);
    };
  }, [selectedExpression]);

  useFrame((_, delta) => {
    if (headMesh && selectedExpression) {
      animateExpression(delta);
    }
  });
};
