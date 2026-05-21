import { useAtomValue } from 'jotai/index';
import React, { FC, useEffect } from 'react';
import { Group } from 'three';
import { SpawnEffect } from './SpawnEffect/SpawnEffect.component';
import { SpawnAnimation } from './SpawnAnimation/SpawnAnimation.component';
import { isValidFormat, triggerCallback } from '../../services';
import { spawnState } from '../../state/spawnAtom';

interface SpawnProps {
  avatar: Group;
  onSpawnFinish?: () => void;
}
export const Spawn: FC<SpawnProps> = ({ avatar, onSpawnFinish }) => {
  const animationProps = useAtomValue(spawnState);

  const usesMountEffect = isValidFormat(animationProps?.onLoadedEffect?.src);
  const usesMountAnimation = isValidFormat(animationProps?.onLoadedAnimation?.src);

  const [effectRunning, setEffectRunning] = React.useState(usesMountEffect);
  const [animationRunning, setAnimationRunning] = React.useState(usesMountAnimation);

  useEffect(() => {
    if (!animationRunning && !effectRunning) {
      triggerCallback(onSpawnFinish);
    }
  }, [onSpawnFinish, effectRunning, animationRunning]);

  const onLoadedAnimationFinish = () => {
    setAnimationRunning(false);
  };

  const onLoadedEffectFinish = () => {
    setEffectRunning(false);
  };

  return (
    <>
      {usesMountEffect && (
        <SpawnEffect
          onLoadedEffect={animationProps.onLoadedEffect as { src: string; animationSrc?: string; loop?: number }}
          onLoadedEffectFinish={onLoadedEffectFinish}
        />
      )}
      {usesMountAnimation && (
        <SpawnAnimation
          onLoadedAnimation={animationProps.onLoadedAnimation as { src: string; loop?: number }}
          avatar={avatar}
          onLoadedAnimationFinish={onLoadedAnimationFinish}
        />
      )}
    </>
  );
};
