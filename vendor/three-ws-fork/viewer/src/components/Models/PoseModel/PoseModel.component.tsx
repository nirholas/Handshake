import React, { FC, Ref } from 'react';
import { useGraph } from '@react-three/fiber';
import { Model } from 'src/components/Models/Model';
import { Group } from 'three';
import { mutatePose, useEmotion, useFallback, useGltfLoader } from 'src/services';
import { BaseModelProps } from 'src/types';
import { Emotion } from '../../Avatar/Avatar.component';

export interface PoseModelProps extends BaseModelProps {
  modelSrc: string | Blob;
  poseSrc: string | Blob;
  modelRef?: Ref<Group>;
  scale?: number;
  emotion?: Emotion;
}

export const PoseModel: FC<PoseModelProps> = ({
  modelSrc,
  poseSrc,
  modelRef,
  scale = 1,
  emotion,
  setModelFallback,
  onLoaded,
  bloom,
  materialConfig,
  onMeshClick,
  onMeshHoverStart,
  onMeshHoverEnd,
  meshCallback
}) => {
  const { scene } = useGltfLoader(modelSrc);
  const { nodes } = useGraph(scene);
  const pose = useGltfLoader(poseSrc);
  const { nodes: sourceNodes } = useGraph(pose.scene);

  mutatePose(nodes, sourceNodes);
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
