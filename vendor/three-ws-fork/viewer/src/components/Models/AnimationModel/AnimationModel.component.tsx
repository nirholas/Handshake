import React, { useRef, FC, useMemo, useState, useEffect } from 'react';
import { useFrame, useGraph } from '@react-three/fiber';
import { AnimationMixer, Group } from 'three';

import { Model } from 'src/components/Models/Model';
import { useHeadMovement, useGltfLoader, useFallback, useIdleExpression, useEmotion } from 'src/services';
import { BaseModelProps } from 'src/types';
import {
  disposeAssetAnimations,
  loadAnimationClips,
  playAssetIdleAnimation,
  updateAssetAnimations
} from 'src/services/Animation.service';
import { Emotion } from 'src/components/Avatar/Avatar.component';

export interface AnimationModelProps extends BaseModelProps {
  modelSrc: string | Blob;
  animationSrc: string | Blob;
  rotation?: number;
  scale?: number;
  idleRotation?: boolean;
  headMovement?: boolean;
  emotion?: Emotion;
}

let currentRotation = 0;

export const AnimationModel: FC<AnimationModelProps> = ({
  modelSrc,
  animationSrc,
  rotation = 20 * (Math.PI / 180),
  scale = 1,
  idleRotation = false,
  setModelFallback,
  onLoaded,
  headMovement = false,
  emotion,
  bloom,
  materialConfig,
  onMeshClick,
  onMeshHoverStart,
  onMeshHoverEnd,
  meshCallback
}) => {
  const ref = useRef<Group>(null);
  const [animationRunning, setAnimationRunning] = useState(true);
  const onSpawnAnimationFinish = () => {
    setAnimationRunning(false);
  };

  const { scene, animations: embeddedAnimations } = useGltfLoader(modelSrc);
  const { nodes } = useGraph(scene);

  const assetMixerRef = useRef<Array<AnimationMixer> | null>(null);

  useEffect(() => {
    assetMixerRef.current = playAssetIdleAnimation(scene, embeddedAnimations);

    return () => {
      disposeAssetAnimations(assetMixerRef.current, scene);

      assetMixerRef.current = null;
    };
  }, [scene, embeddedAnimations]);

  const animationClip = useMemo(async () => {
    const clip = await loadAnimationClips(animationSrc);
    return clip[0];
  }, [animationSrc]);

  const animationMixer = useMemo(async () => {
    const mixer = new AnimationMixer(nodes.Armature);
    if (animationRunning) {
      return mixer;
    }

    const animation = mixer.clipAction(await animationClip);
    animation.fadeIn(0);
    animation.play();

    mixer.update(0);

    return mixer;
  }, [animationRunning, animationClip, nodes.Armature]);

  useFrame(async (state, delta) => {
    updateAssetAnimations(assetMixerRef.current, delta);

    (await animationMixer)?.update(delta);

    if (!idleRotation) {
      return;
    }

    if (ref?.current) {
      currentRotation += delta * 0.2;
      ref.current.rotation.y = rotation + Math.sin(currentRotation) / 3;
    }
  });

  useHeadMovement({ nodes, enabled: headMovement });
  useEmotion(nodes, emotion);
  useIdleExpression('blink', nodes);
  useFallback(nodes, setModelFallback);

  return (
    <Model
      modelRef={ref}
      scene={scene}
      scale={scale}
      onLoaded={onLoaded}
      onSpawnAnimationFinish={onSpawnAnimationFinish}
      bloom={bloom}
      materialConfig={materialConfig}
      onMeshClick={onMeshClick}
      onMeshHoverStart={onMeshHoverStart}
      onMeshHoverEnd={onMeshHoverEnd}
      meshCallback={meshCallback}
    />
  );
};
