import { useFrame, useGraph } from '@react-three/fiber';
import React, { useMemo, useEffect, FC } from 'react';
import { AnimationMixer, Group, LoopRepeat } from 'three';
import { triggerCallback } from '../../../services';
import { loadAnimationClips } from '../../../services/Animation.service';

interface SpawnAnimationProps {
  avatar: Group;
  onLoadedAnimationFinish?: () => void;
  onLoadedAnimation: {
    src: string;
    loop?: number;
  };
}

export const SpawnAnimation: FC<SpawnAnimationProps> = ({ avatar, onLoadedAnimationFinish, onLoadedAnimation }) => {
  const [animationRunning, setAnimationRunning] = React.useState(true);

  useEffect(() => {
    if (!animationRunning) {
      triggerCallback(onLoadedAnimationFinish);
    }
  }, [onLoadedAnimationFinish, animationRunning]);

  const { nodes: avatarNode } = useGraph(avatar);

  const animationClip = useMemo(async () => {
    const clips = await loadAnimationClips(onLoadedAnimation?.src || '');
    return clips[0];
  }, [onLoadedAnimation?.src]);

  const animationMixerAvatar = useMemo(async () => {
    const mixer = new AnimationMixer(avatarNode.Armature);
    if (!avatarNode.Armature) {
      return mixer;
    }

    const animation = mixer.clipAction(await animationClip);

    animation.setLoop(LoopRepeat, onLoadedAnimation?.loop || 1);
    animation.clampWhenFinished = true;

    animation.play();

    mixer.addEventListener('finished', () => {
      animation.fadeOut(0.5);
      setAnimationRunning(false);
    });

    return mixer;
  }, [avatarNode.Armature, onLoadedAnimation?.loop, animationClip]);

  useFrame(async (state, delta) => {
    (await animationMixerAvatar)?.update(delta);
  });

  return <></>;
};
