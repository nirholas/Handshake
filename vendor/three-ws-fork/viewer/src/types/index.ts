import { Vector3, Mesh } from 'three';
import { PresetsType } from '@react-three/drei/helpers/environment-assets';

export type Required<T> = {
  [P in keyof T]-?: T[P];
};

export interface CameraProps {
  /**
   * A Vector3 representing the cameras position, default is (0, 0, 5)
   */
  position?: Vector3;
}

export interface EnvironmentProps {
  /**
   * Brightness, color hue, shadow contrast, reflection details change according to the selected environment.
   * Possible to provide a custom `.hdr` file path (URL) as environment background.
   */
  environment?: PresetsType | string;
}

/**
 * Three point spotlight setup with an additional body lift light.
 */
export interface LightingProps {
  keyLightIntensity?: number;
  keyLightColor?: string; // css-color string

  fillLightIntensity?: number;
  fillLightColor?: string; // css-color string
  fillLightPosition?: Vector3;

  backLightIntensity?: number;
  backLightColor?: string; // css-color string
  backLightPosition?: Vector3;

  /**
   * The position in space which is used by the lights to shine at. (Defaults to approximate head height)
   */
  lightTarget?: Vector3;
}

export interface BaseModelProps {
  /**
   * Detect when model is loaded (doesn't take into account animations and effects) and trigger custom logic.
   */
  onLoaded?: () => void;
  /**
   * Detect when model is being loaded and trigger custom logic.
   */
  onLoading?: () => void;
  setModelFallback?: (fallback: JSX.Element) => void;
  bloom?: BloomConfiguration;
  materialConfig?: MaterialConfiguration;
  /**
   * Callback for when a mesh is clicked.
   */
  onMeshClick?: (mesh: Mesh) => void;
  /**
   * Callback for when a mesh hover starts.
   */
  onMeshHoverStart?: (mesh: Mesh) => void;
  /**
   * Callback for when a mesh hover ends.
   */
  onMeshHoverEnd?: (mesh: Mesh) => void;
  /**
   * Callback for processing meshes on model load.
   */
  meshCallback?: (material: Mesh) => void;
}

export type HeadBlendShapeType =
  | 'browDownLeft'
  | 'browDownRight'
  | 'browInnerUp'
  | 'browOuterUpLeft'
  | 'browOuterUpRight'
  | 'cheekPuff'
  | 'cheekSquintLeft'
  | 'cheekSquintRight'
  | 'eyeBlinkLeft'
  | 'eyeBlinkRight'
  | 'eyeSquintLeft'
  | 'eyeSquintRight'
  | 'eyeWideLeft'
  | 'eyeWideRight'
  | 'eyesClosed'
  | 'eyesLookDown'
  | 'eyesLookUp'
  | 'jawForward'
  | 'jawLeft'
  | 'jawOpen'
  | 'jawRight'
  | 'mouthClose'
  | 'mouthDimpleLeft'
  | 'mouthDimpleRight'
  | 'mouthFrownLeft'
  | 'mouthFrownRight'
  | 'mouthFunnel'
  | 'mouthLeft'
  | 'mouthLowerDownLeft'
  | 'mouthLowerDownRight'
  | 'mouthOpen'
  | 'mouthPressLeft'
  | 'mouthPressRight'
  | 'mouthPucker'
  | 'mouthRight'
  | 'mouthRollLower'
  | 'mouthRollUpper'
  | 'mouthShrugLower'
  | 'mouthShrugUpper'
  | 'mouthSmile'
  | 'mouthSmileLeft'
  | 'mouthSmileRight'
  | 'mouthStretchLeft'
  | 'mouthStretchRight'
  | 'mouthUpperUpLeft'
  | 'mouthUpperUpRight'
  | 'noseSneerLeft'
  | 'noseSneerRight'
  | 'viseme_CH'
  | 'viseme_DD'
  | 'viseme_E'
  | 'viseme_FF'
  | 'viseme_I'
  | 'viseme_O'
  | 'viseme_PP'
  | 'viseme_RR'
  | 'viseme_SS'
  | 'viseme_TH'
  | 'viseme_U'
  | 'viseme_aa'
  | 'viseme_kk'
  | 'viseme_nn'
  | 'viseme_sil';

export type BloomConfiguration = {
  /**
   * The luminance threshold. Raise this value to mask out darker elements in the scene. Range is [0, 1].
   */
  luminanceThreshold?: number;
  /**
   * Controls the smoothness of the luminance threshold. Range is [0, 1].
   */
  luminanceSmoothing?: number;
  /**
   * Enables or disables mipmap blur.
   */
  mipmapBlur?: boolean;
  /**
   * The intensity of global bloom.
   */
  intensity?: number;
  /**
   * The kernel size of the blur. Values are 0, 1, 2, 3, 4.
   */
  kernelSize?: number;
  /**
   * Emissive material intensity.
   */
  materialIntensity?: number;
};

export type EffectConfiguration = {
  /**
   * Enables ambient occlusion for the current scene.
   */
  ambientOcclusion?: boolean;
  /**
   * Bloom post-processing effect.
   */
  bloom?: BloomConfiguration;
  /**
   * Vignette post-processing effect.
   */
  vignette?: boolean;
};

export type AnimationConfiguration = {
  /**
   * Duration of the crossfade between animations.
   */
  crossfadeDuration?: number;
};

export interface SpawnState {
  /**
   * Add a custom loaded effect like particles when avatar is loaded, animate them with a custom animation.
   */
  onLoadedEffect?: {
    src: string | null;
    animationSrc?: string | null;
    loop?: number | null;
  } | null;
  /**
   * Add a custom loaded animation when avatar is loaded.
   * Supports `.fbx` and `.glb` files.
   */
  onLoadedAnimation?: {
    src: string | null;
    loop?: number | null;
  } | null;
}

export type MaterialConfiguration = {
  /**
   * Emissive material intensity.
   */
  emissiveIntensity?: number;
};

export type AnimationsT = Record<
  string,
  {
    key?: string;
    source?: string;
    repeat?: number;
    fadeTime?: number;
  }
>;

export type CanvasConfiguration = {
  alpha?: boolean;
};
