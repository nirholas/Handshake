import { Emotion } from 'src/components/Avatar/Avatar.component';
import { getStoryAssetPath } from './Models.service';

const disableTable = { table: { disable: true } };

const keysToIgnore = [
  'modelSrc',
  'animationSrc',
  'poseSrc',
  'halfBody',
  'shadows',
  'cameraTarget',
  'cameraInitialDistance',
  'style',
  'idleRotation',
  'emotion',
  'background',
  'capture',
  'loader',
  'dpr',
  'className',
  'headMovement',
  'cameraZoomTarget',
  'bloom',
  'onLoadedEffect',
  'onLoadedAnimation',
  'children',
  'environment',
  'ambientLightColor',
  'dirLightColor',
  'spotLightColor',
  'ambientLightIntensity',
  'dirLightIntensity',
  'spotLightIntensity',
  'spotLightAngle',
  'onLoaded',
  'onLoading',
  'fov',
  'spotLightPosition',
  'dirLightPosition',
  'scale'
];
export const ignoreArgTypesOnExamples = keysToIgnore.reduce(
  (acc, key) => {
    acc[key] = disableTable;
    return acc;
  },
  {} as Record<string, typeof disableTable>
);

export const modelPresets = {
  one: 'https://models.three.ws/64d61e9e17883fd73ebe5eb7.glb?morphTargets=ARKit,Eyes Extra&textureAtlas=none&lod=0',
  two: 'https://models.three.ws/64d61f67f0367d07504924be.glb?morphTargets=ARKit,Eyes Extra&textureAtlas=none&lod=0',
  three:
    'https://models.three.ws/64d62255f0367d0750492913.glb?lod=0&morphTargets=ARKit,Eyes Extra&textureAtlas=none',
  five: 'https://models.three.ws/64d6235e2d3bea6e4267b01d.glb?lod=0&morphTargets=ARKit,Eyes Extra&textureAtlas=none',
  six: 'https://models.three.ws/64d5d4eb651a0d350005c672.glb?lod=0&morphTargets=ARKit,Eyes Extra&textureAtlas=none',
  seven: 'https://models.three.ws/64e3055495439dfcf3f0b665.glb?morphTargets=ARKit,Eyes%20Extra&textureAtlas=none'
};

export const animationPresets = {
  one: getStoryAssetPath('male-idle-1.fbx'),
  two: getStoryAssetPath('male-idle-2.fbx'),
  three: getStoryAssetPath('male-idle-3.fbx')
};

type FacialExpressionT = 'idle' | 'angry' | 'smile' | 'sad';

export const emotions: Record<FacialExpressionT, Emotion> = {
  idle: {},
  angry: {
    mouthDimpleLeft: 0.48,
    mouthShrugLower: 0.385,
    eyeSquintLeft: 0.63,
    eyeSquintRight: 0.614,
    browDownLeft: 0.842,
    browDownRight: 0.56,
    noseSneerLeft: 0.3,
    noseSneerRight: 0.3
  },
  smile: {
    eyeSquintLeft: 0.4,
    eyeSquintRight: 0.2,
    mouthSmileLeft: 0.37,
    mouthSmileRight: 0.36,
    mouthShrugUpper: 0.27,
    browInnerUp: 0.3,
    browOuterUpLeft: 0.37,
    browOuterUpRight: 0.49
  },
  sad: {
    eyeWideLeft: 0.5,
    eyeWideRight: 0.4,
    mouthPucker: 0.19,
    mouthFrownLeft: 0.6,
    mouthFrownRight: 0.6,
    mouthRollLower: 0.33,
    mouthRollUpper: 0.02,
    mouthShrugLower: 0.4,
    browInnerUp: 0.78,
    noseSneerLeft: 0.115,
    noseSneerRight: 0.1
  }
};
