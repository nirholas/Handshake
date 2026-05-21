import React, { FC, useEffect, useMemo, useRef } from 'react';
import { AnimationMixer, Group, LoopRepeat } from 'three';
import { useFrame, useGraph } from '@react-three/fiber';
import { triggerCallback, useGltfLoader } from '../../../services';
import { loadAnimationClips } from '../../../services/Animation.service';

interface SpawnEffectProps {
  onLoadedEffectFinish: () => void;
  onLoadedEffect: { src: string; animationSrc?: string; loop?: number };
}

export const SpawnEffect: FC<SpawnEffectProps> = ({ onLoadedEffect, onLoadedEffectFinish }) => {
  const ref = useRef<Group>(null);

  const [effectRunning, setEffectRunning] = React.useState(true);

  const { scene: mountEffectScene } = useGltfLoader(onLoadedEffect.src);
  const { nodes: mountEffectNode } = useGraph(mountEffectScene);

  useEffect(() => {
    if (!effectRunning) {
      triggerCallback(onLoadedEffectFinish);
    }
  }, [onLoadedEffectFinish, effectRunning]);

  const animationLoadedEffect = useMemo(async () => {
    const effect = await loadAnimationClips(onLoadedEffect?.animationSrc || onLoadedEffect.src);

    return effect[0];
  }, [onLoadedEffect?.animationSrc, onLoadedEffect.src]);

  const spawnEffectMixer = useMemo(async () => {
    const mixer = new AnimationMixer(mountEffectNode.Scene);
    const loadedEffect = await animationLoadedEffect;

    if (!loadedEffect) {
      setEffectRunning(false);
      return mixer;
    }

    const animation = mixer.clipAction(loadedEffect);

    animation.setLoop(LoopRepeat, onLoadedEffect?.loop || 1);
    animation.clampWhenFinished = true;

    animation.play();

    mixer.addEventListener('finished', () => {
      animation.fadeOut(0.5);
      setEffectRunning(false);
    });

    return mixer;
  }, [mountEffectNode.Scene, animationLoadedEffect, onLoadedEffect?.loop]);

  useFrame(async (state, delta) => {
    (await spawnEffectMixer)?.update(delta);
  });

  return <>{effectRunning && <primitive modelRef={ref} object={mountEffectScene} />}</>;
};
