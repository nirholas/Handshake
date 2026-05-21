import { useThree } from '@react-three/fiber';
import React, { FC, useEffect, useState } from 'react';
import { LightingProps } from 'src/types';
import { definedProps } from 'src/utils/props';
import { Object3D, Vector3 } from 'three';

export const LIGHT_CONFIG = Object.freeze({
  fillLightAngle: Math.PI / 3,
  backLightAngle: Math.PI / 8,
  keyLightAngle: Math.PI,
  silhouetteLightAngle: Math.PI * 1.5,
  keyLightPosition: new Vector3(0.5, 1.55, 0.5),
  liftLightPosition: new Vector3(0.25, 1.7, 2.0),
  dirLightPosition: new Vector3(-0.75, 2.5, -1.0),
  silhouetteLightPosition: new Vector3(-1.5, 0.1, -1.5),
  defaultProps: {
    keyLightIntensity: 0.8,
    keyLightColor: '#FFFFFF',
    fillLightIntensity: 3.0,
    fillLightColor: '#6794FF',
    fillLightPosition: new Vector3(-0.5, 1.6, -0.5),
    backLightIntensity: 6.0,
    backLightColor: '#FFB878',
    backLightPosition: new Vector3(0.5, 1.6, -1.0),
    lightTarget: new Vector3(0.0, 1.7, 0.0)
  } as Required<LightingProps>
});

const Lights: FC<LightingProps> = (lightingProps) => {
  // use default props as fallback if no custom lighting settings are provided
  const {
    keyLightIntensity,
    keyLightColor,
    fillLightIntensity,
    fillLightColor,
    fillLightPosition,
    backLightIntensity,
    backLightColor,
    backLightPosition,
    lightTarget
  } = Object.assign(LIGHT_CONFIG.defaultProps, definedProps(lightingProps));

  const { scene } = useThree();

  const [targets] = useState<{ head: Object3D; shoe: Object3D }>({
    head: new Object3D(),
    shoe: new Object3D()
  });

  useEffect(() => {
    // apply provided positions for targets
    targets.head.position.copy(lightTarget);
    targets.shoe.position.set(0.0, 0.0, 0.0);

    // add targets to scene (without the spotlights would not aim at them)
    scene.add(targets.head);
    scene.add(targets.shoe);
  }, []);

  return (
    <group>
      {/* Fill light that by default creates strong blue rim on the right face side. */}
      <spotLight
        position={fillLightPosition}
        target={targets.head}
        angle={LIGHT_CONFIG.fillLightAngle}
        color={fillLightColor}
        intensity={fillLightIntensity}
        castShadow
      />
      {/* Back light that by default creates light warm rim on the left face side. */}
      <spotLight
        position={backLightPosition}
        target={targets.head}
        angle={LIGHT_CONFIG.backLightAngle}
        color={backLightColor}
        intensity={backLightIntensity}
        castShadow
      />
      {/* Key light that creates soft face light. */}
      <spotLight
        position={LIGHT_CONFIG.keyLightPosition}
        target={targets.head}
        angle={LIGHT_CONFIG.keyLightAngle}
        color={keyLightColor}
        intensity={keyLightIntensity}
      />
      {/* Lift light that creates soft light on body and shoes. */}
      <spotLight
        position={LIGHT_CONFIG.liftLightPosition}
        target={targets.shoe}
        angle={LIGHT_CONFIG.keyLightAngle}
        color={keyLightColor}
        intensity={keyLightIntensity * 0.25}
      />
      {/* Silhouette light on arms and legs. */}
      <spotLight
        position={LIGHT_CONFIG.silhouetteLightPosition}
        target={targets.head}
        angle={LIGHT_CONFIG.silhouetteLightAngle}
        color={keyLightColor}
        intensity={keyLightIntensity * 0.25}
      />
    </group>
  );
};

export default Lights;
