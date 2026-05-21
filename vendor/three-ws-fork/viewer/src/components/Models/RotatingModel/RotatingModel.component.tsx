import React, { useRef, FC, useEffect, useMemo, useState } from 'react';
import { useFrame, useGraph } from '@react-three/fiber';
import { AnimationMixer, Group } from 'three';
import { CenteredModel } from 'src/components/Models/CenteredModel';
import { useGltfLoader } from 'src/services';
import { BaseModelProps } from 'src/types';
import {
  disposeAssetAnimations,
  loadAnimationClips,
  playAssetIdleAnimation,
  updateAssetAnimations
} from 'src/services/Animation.service';

export interface RotatingModelProps extends BaseModelProps {
  modelSrc: string | Blob;
  scale?: number;
  lockHorizontal?: boolean;
  lockVertical?: boolean;
  horizontalRotationStep?: number;
  verticalRotationStep?: number;
}

export const RotatingModel: FC<RotatingModelProps> = ({
  modelSrc,
  scale = 1.0,
  onLoaded,
  bloom,
  lockVertical,
  lockHorizontal,
  horizontalRotationStep,
  verticalRotationStep
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
  }, [scene]);

  const animationClip = useMemo(async () => {
    const clip = await loadAnimationClips(modelSrc);
    return clip[0];
  }, [modelSrc]);

  const animationMixer = useMemo(async () => {
    const mixer = new AnimationMixer(nodes.Armature);
    if (animationRunning) {
      return mixer;
    }

    const mixerAnimationClip = await animationClip;

    if (mixerAnimationClip) {
      const animation = mixer.clipAction(mixerAnimationClip);

      animation.fadeIn(0);
      animation.play();

      mixer.update(0);
    }

    return mixer;
  }, [animationRunning, animationClip, nodes.Armature]);

  useFrame(async (state, delta) => {
    updateAssetAnimations(assetMixerRef.current, delta);

    (await animationMixer)?.update(delta);

    if (ref?.current) {
      ref.current.rotation.y = state.clock.getElapsedTime() * 0.5;
    }
  });

  return (
    <CenteredModel
      verticalRotationStep={verticalRotationStep}
      horizontalRotationStep={horizontalRotationStep}
      lockHorizontal={lockHorizontal}
      lockVertical={lockVertical}
      onSpawnAnimationFinish={onSpawnAnimationFinish}
      modelRef={ref}
      scale={scale}
      scene={scene}
      onLoaded={onLoaded}
      bloom={bloom}
    />
  );
};
