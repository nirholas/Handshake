import React, { FC, Ref } from 'react';
import { Model } from 'src/components/Models/Model';
import { useEmotion, useFallback, useGltfLoader } from 'src/services';
import { Group } from 'three';
import { useGraph } from '@react-three/fiber';
import { BaseModelProps } from 'src/types';
import { Emotion } from '../../Avatar/Avatar.component';

export interface StaticModelProps extends BaseModelProps {
  modelSrc: string | Blob;
  modelRef?: Ref<Group>;
  scale?: number;
  emotion?: Emotion;
}

export const StaticModel: FC<StaticModelProps> = ({
  modelSrc,
  modelRef,
  scale = 1,
  setModelFallback,
  onLoaded,
  emotion,
  bloom,
  materialConfig,
  onMeshClick,
  onMeshHoverStart,
  onMeshHoverEnd,
  meshCallback
}) => {
  const { scene } = useGltfLoader(modelSrc);
  const { nodes } = useGraph(scene);

  useEmotion(nodes, emotion);
  useFallback(nodes, setModelFallback);

  return (
    <Model
      modelRef={modelRef}
      scene={scene}
      scale={scale}
      onLoaded={onLoaded}
      bloom={bloom}
      materialConfig={materialConfig}
      onMeshClick={onMeshClick}
      onMeshHoverStart={onMeshHoverStart}
      onMeshHoverEnd={onMeshHoverEnd}
      meshCallback={meshCallback}
    />
  );
};
