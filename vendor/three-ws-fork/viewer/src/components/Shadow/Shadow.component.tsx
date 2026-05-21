import React, { FC } from 'react';

const Shadow: FC = () => (
  <group position={[0, 0, 0]}>
    <mesh key="shadow-catcher" receiveShadow position={[0, 0, 0]} rotation-x={-Math.PI / 2}>
      <planeGeometry attach="geometry" args={[3, 2]} />
      <shadowMaterial attach="material" transparent opacity={0.2} />
    </mesh>
  </group>
);

export default Shadow;
