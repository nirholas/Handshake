import React, { FC } from 'react';
import { MeshReflectorMaterial } from '@react-three/drei';

export interface FloorReflectionProps {
  resolution?: number;
  mixBlur?: number;
  mixStrength?: number;
  metalness?: number;
  blur?: [number, number] | number;
  mirror?: number;
  minDepthThreshold?: number;
  maxDepthThreshold?: number;
  depthScale?: number;
  depthToBlurRatioBias?: number;
  distortion?: number;
  mixContrast?: number;
  reflectorOffset?: number;
  roughness?: number;
  /**
   * The color should match the canvas background color to provide a seamless transition from background to the reflective plane.
   */
  color: string;
}
export const FloorReflection: FC<FloorReflectionProps> = ({
  resolution = 512,
  mixBlur = 0.8,
  mixStrength = 80,
  metalness = 0.5,
  blur = [300, 200],
  mirror = 1,
  minDepthThreshold = 0.4,
  maxDepthThreshold = 1.4,
  depthScale = 1.2,
  depthToBlurRatioBias = 1,
  distortion = 0,
  mixContrast = 1,
  reflectorOffset = 0,
  roughness = 1,
  color,
  ...props
}) => (
  <>
    <fog attach="fog" args={[color, 2, 6]} />
    <group position={[0, 0, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[20, 10]} />
        <MeshReflectorMaterial
          resolution={resolution}
          mixBlur={mixBlur}
          mixStrength={mixStrength}
          metalness={metalness}
          blur={blur}
          mirror={mirror}
          minDepthThreshold={minDepthThreshold}
          maxDepthThreshold={maxDepthThreshold}
          depthScale={depthScale}
          depthToBlurRatioBias={depthToBlurRatioBias}
          distortion={distortion}
          mixContrast={mixContrast}
          reflectorOffset={reflectorOffset}
          roughness={roughness}
          color={color}
          envMapIntensity={0}
          {...props}
        />
      </mesh>
    </group>
  </>
);
