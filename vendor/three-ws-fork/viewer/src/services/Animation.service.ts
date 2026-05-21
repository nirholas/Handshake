import { AnimationClip, AnimationMixer, Group, LoopRepeat, Mesh, Object3D, PropertyBinding } from 'three';

import { FBXLoader, GLTFLoader } from 'three-stdlib';
import { suspend } from 'suspend-react';
import { MeshoptDecoder } from './meshopt_decoder';
import { AnimationsT } from '../types';

interface ClipWithType {
  group: Group;
  isFbx: boolean;
}

const MIXAMO_PREFIX = 'mixamorig';
const POSITION_SUFFIX = '.position';
const MIXAMO_SCALE = 0.01;

const fbxLoader = new FBXLoader();
const gltfLoader = new GLTFLoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

function normaliseFbxAnimations(fbx: Group) {
  for (let a = 0; a < fbx.animations.length; a += 1) {
    const { tracks } = fbx.animations[a];

    for (let i = 0; i < tracks.length; i += 1) {
      const hasMixamoPrefix = tracks[i].name.includes(MIXAMO_PREFIX);
      if (hasMixamoPrefix) {
        tracks[i].name = tracks[i].name.replace(MIXAMO_PREFIX, '');
      }
      if (tracks[i].name.includes(POSITION_SUFFIX)) {
        for (let j = 0; j < tracks[i].values.length; j += 1) {
          // Scale the bound size down to match the size of the model
          // eslint-disable-next-line operator-assignment
          tracks[i].values[j] = tracks[i].values[j] * MIXAMO_SCALE;
        }
      }
    }
  }

  return fbx.animations;
}

const loadBlobFile = async (blob: Blob): Promise<ClipWithType> => {
  try {
    const buffer = await blob.arrayBuffer();
    return {
      group: (await gltfLoader.parseAsync(buffer, '')) as unknown as Group,
      isFbx: false
    };
  } catch (e) {
    return {
      group: (await fbxLoader.loadAsync(URL.createObjectURL(blob))) as unknown as Group,
      isFbx: true
    };
  }
};

const loadPathFile = async (source: string): Promise<ClipWithType> => {
  try {
    return {
      group: (await gltfLoader.loadAsync(source)) as unknown as Group,
      isFbx: false
    };
  } catch (e) {
    return {
      group: (await fbxLoader.loadAsync(source)) as Group,
      isFbx: true
    };
  }
};

export const loadAnimationClips = async (source: Blob | string): Promise<AnimationClip[]> => {
  const animation = source instanceof Blob ? await loadBlobFile(source) : await loadPathFile(source);

  return animation.isFbx ? normaliseFbxAnimations(animation.group) : animation.group.animations;
};

const IDLE_ANIMATION_NAME = 'idle';

const playMorphTargetAnimation = (root: Object3D, animationClip: AnimationClip): AnimationMixer | null => {
  if (!root || !animationClip) {
    return null;
  }

  const assetMixer = new AnimationMixer(root);
  const animationAction = assetMixer.clipAction(animationClip);

  animationAction.setLoop(LoopRepeat, Infinity);
  animationAction.play();

  return assetMixer;
};

const playMapUvOffsetAnimation = (
  root: Object3D,
  animationClip: AnimationClip,
  encodedPropertyPath: string
): AnimationMixer | null => {
  const targetNode = PropertyBinding.findNode(root, encodedPropertyPath);

  if (!targetNode) {
    return null;
  }

  const targetMeshes: Array<Mesh> = [];

  root.traverse((object) => {
    const mesh = object as Mesh;

    if (mesh.isMesh && mesh.material === targetNode) {
      targetMeshes.push(mesh);
    }
  });

  if (!targetMeshes.length) {
    return null;
  }
  const animatedMesh = targetMeshes[0];

  const assetMixer = new AnimationMixer(animatedMesh);
  const defaultIdleAction = assetMixer.clipAction(animationClip);

  // @ts-expect-error property binding exists
  // eslint-disable-next-line no-underscore-dangle
  const propertyMixers = defaultIdleAction._propertyBindings as unknown as Array<PropertyMixer>;
  if (!propertyMixers.length) {
    return null;
  }

  const defaultPropertyMixer = propertyMixers[0];
  defaultPropertyMixer.binding.node = defaultPropertyMixer.binding.rootNode;

  defaultIdleAction.setLoop(LoopRepeat, Infinity);
  defaultIdleAction.play();

  return assetMixer;
};

export const playAssetIdleAnimation = (
  root: Object3D,
  animations: Array<AnimationClip>
): Array<AnimationMixer> | null => {
  if (!root || !animations.length) {
    return null;
  }

  const idleAnimations = animations.filter((animation) => animation.name.toLowerCase().includes(IDLE_ANIMATION_NAME));

  if (!idleAnimations.length) {
    return null;
  }

  const assetMixers: Array<AnimationMixer> = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const idleAnimation of idleAnimations) {
    if (!idleAnimation.tracks.length) {
      return null;
    }

    idleAnimation.tracks?.forEach((defaultIdleAnimationTrack) => {
      const encodedPropertyPath = defaultIdleAnimationTrack.name;

      let assetMixer: AnimationMixer | null = null;

      const MORPH_TARGET_PROPERTY_SUFFIX = 'morphTargetInfluences';
      const isMorphTargetAnimation = encodedPropertyPath.endsWith(MORPH_TARGET_PROPERTY_SUFFIX);
      if (isMorphTargetAnimation) {
        assetMixer = playMorphTargetAnimation(root, idleAnimation);
      }

      const MAP_UV_OFFSET_PROPERTY_SUFFIX = 'map.offset';
      const isMapUvOffsetAnimation = encodedPropertyPath.endsWith(MAP_UV_OFFSET_PROPERTY_SUFFIX);

      if (isMapUvOffsetAnimation) {
        assetMixer = playMapUvOffsetAnimation(root, idleAnimation, encodedPropertyPath);
      }

      if (assetMixer) {
        assetMixers.push(assetMixer);
      }
    });
  }

  return assetMixers;
};

export const updateAssetAnimations = (mixers: Array<AnimationMixer> | null, delta: number): boolean => {
  if (!mixers) {
    return false;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const mixer of mixers) {
    mixer.update(delta);
  }

  return true;
};

export const disposeAssetAnimations = (mixers: Array<AnimationMixer> | null, root: Object3D): boolean => {
  if (!mixers || !root) {
    return false;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const mixer of mixers) {
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
  }

  return true;
};

export const useAnimations = (animations: AnimationsT) =>
  suspend(async (): Promise<Record<string, AnimationClip>> => {
    const clips: Record<string, AnimationClip> = {};

    await Promise.all(
      Object.entries(animations).map(async ([name, { key }]) => {
        const animation = animations[name];

        if (!animation?.source) {
          console.warn(`Could not load animation ${name}`);
          return;
        }

        const newClips = await loadAnimationClips(animation.source);
        const newClip = key ? newClips.find((item) => item?.name === key) || newClips[0] : newClips[0];

        if (newClip) {
          clips[name] = newClip;
        } else {
          console.warn(`Could not load animation ${name}`);
        }
      })
    );

    return clips;
  }, [animations]);

export const getAnimation = (name: string) => `https://assets.three.ws/animations/viewer/${name}`;
