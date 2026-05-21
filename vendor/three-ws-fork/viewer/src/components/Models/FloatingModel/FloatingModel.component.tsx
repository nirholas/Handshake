import React, { useRef, FC } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { Model } from 'src/components/Models/Model';
import { useGltfLoader } from 'src/services';
import { BaseModelProps } from 'src/types';

export interface FloatingModelProps extends BaseModelProps {
  modelSrc: string | Blob;
  scale?: number;
}

export const FloatingModel: FC<FloatingModelProps> = ({
  modelSrc,
  scale = 1.0,
  onLoaded,
  bloom,
  onMeshClick,
  onMeshHoverStart,
  onMeshHoverEnd,
  meshCallback
}) => {
  const ref = useRef<Group>(null);
  const { scene } = useGltfLoader(modelSrc);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();

    if (ref?.current) {
      ref.current.rotation.y = Math.sin(t / 2) / 8;
      ref.current.position.y = (1 + Math.sin(t / 1.5)) / -9;
    }
  });

  return (
    <Model
      modelRef={ref}
      scale={scale}
      scene={scene}
      onLoaded={onLoaded}
      bloom={bloom}
      onMeshClick={onMeshClick}
      onMeshHoverStart={onMeshHoverStart}
      onMeshHoverEnd={onMeshHoverEnd}
      meshCallback={meshCallback}
    />
  );
};
