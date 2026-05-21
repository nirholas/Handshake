import React, { FC, useEffect } from 'react';
import { useFallback, useGltfLoader, CustomNode, Transform, triggerCallback } from 'src/services';
import { useGraph } from '@react-three/fiber';
import { BaseModelProps } from 'src/types';
import { EnvironmentModels } from 'src/services/Environment.service';

export interface EnvironmentModelProps extends BaseModelProps {
  environment: string | EnvironmentModels;
  scale?: number;
}

export const EnvironmentModel: FC<EnvironmentModelProps> = ({ environment, scale = 1, setModelFallback, onLoaded }) => {
  const transform = new Transform();
  const { scene } = useGltfLoader(environment);
  const { nodes } = useGraph(scene);

  useFallback(nodes, setModelFallback);
  useEffect(() => triggerCallback(onLoaded), [scene, onLoaded]);

  return (
    <group>
      {Object.keys(nodes).map((key) => {
        const node = nodes[key] as CustomNode;
        if (node.type === 'Mesh') {
          return (
            <mesh
              receiveShadow
              key={node.name}
              scale={scale}
              position={transform.position}
              rotation={transform.rotation}
              geometry={node.geometry}
              material={node.material}
              morphTargetInfluences={node.morphTargetInfluences || []}
            />
          );
        }

        return null;
      })}
    </group>
  );
};
