import React, { FC, useRef } from 'react';
import { Mesh, TextureLoader } from 'three';
import { useLoader } from '@react-three/fiber';
import { MeshProps } from '@react-three/fiber/dist/declarations/src/three-types';

export type Background = { src?: string; color?: string } & MeshProps;

export const Box: FC<Background> = ({ src = '', ...baseProps }) => {
  const ref = useRef<Mesh>(null);
  const texture = useLoader(TextureLoader, src);

  return (
    <mesh ref={ref} castShadow receiveShadow {...baseProps}>
      <boxGeometry />
      <meshPhysicalMaterial map={texture} />
    </mesh>
  );
};
