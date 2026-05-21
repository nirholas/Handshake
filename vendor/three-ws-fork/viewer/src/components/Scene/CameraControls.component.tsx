import React, { FC, useEffect, useRef } from 'react';
import { OrbitControls as OrbitControlsComponent } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { Camera, Vector3 } from 'three';
import { OrbitControls } from 'three-stdlib';
import { clamp, lerp } from 'src/services';

type CameraControlsProps = {
  // eslint-disable-next-line react/no-unused-prop-types
  fullBody?: boolean;
  headScale?: number;
  cameraTarget?: number;
  cameraInitialDistance?: number;
  /**
   * Handles camera movement on the Z-axis.
   */
  cameraZoomTarget?: Vector3;
  controlsMinDistance?: number;
  controlsMaxDistance?: number;
  /**
   * Enables camera moving on Y-axis while zooming in-out.
   */
  updateCameraTargetOnZoom?: boolean;
};

const updateCameraTarget = (
  controls: OrbitControls,
  camera: Camera,
  target: number,
  minDistance: number,
  maxDistance: number
) => {
  if (controls) {
    let distance = controls.target.distanceTo(camera.position);
    distance = clamp(distance, maxDistance, minDistance);
    const pivot = (distance - minDistance) / (maxDistance - minDistance);

    controls.target.set(0, target - 0.6 * pivot, 0);
  }
};

export const CameraControls: FC<CameraControlsProps> = ({
  cameraTarget,
  cameraInitialDistance,
  cameraZoomTarget,
  headScale = 1,
  controlsMinDistance = 0.4,
  controlsMaxDistance = 2.5,
  updateCameraTargetOnZoom = false
}) => {
  const cameraZoomTargetRef = useRef(cameraZoomTarget);
  const { camera, gl } = useThree();
  const controlsRef = useRef<OrbitControls>(null);
  const progressRef = useRef(Number.POSITIVE_INFINITY);
  const fallbackCameraTarget = cameraTarget || 1.475 + headScale / 10;
  const headScaleAdjustedMinDistance = controlsMinDistance + headScale / 10;

  const updateCameraFocus = (delta: number, target?: Vector3) => {
    if (target && progressRef.current <= 1) {
      camera.position.setX(lerp(camera.position.x, target.x, progressRef.current));
      camera.position.setZ(lerp(camera.position.z, target.z, progressRef.current));
      progressRef.current += delta;
    }
  };

  useEffect(() => {
    if (
      cameraZoomTargetRef.current?.x !== cameraZoomTarget?.x ||
      cameraZoomTargetRef.current?.y !== cameraZoomTarget?.y ||
      cameraZoomTargetRef.current?.z !== cameraZoomTarget?.z
    ) {
      cameraZoomTargetRef.current = cameraZoomTarget;
      progressRef.current = 0;
    }

    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(0, fallbackCameraTarget, 0);
      controls.update();

      // TODO: Look for a better distance initialiser, without progress value check it conflicts with cameraZoomTarget which also can update camera position.z
      if (cameraInitialDistance && progressRef.current === Number.POSITIVE_INFINITY) {
        camera.position.z = cameraInitialDistance;
        controls.update();
      }
    }
  }, [cameraInitialDistance, camera, gl.domElement, cameraZoomTarget, fallbackCameraTarget]);

  useFrame((_, delta) => {
    if (updateCameraTargetOnZoom && controlsRef.current) {
      updateCameraTarget(
        controlsRef.current,
        camera,
        fallbackCameraTarget,
        headScaleAdjustedMinDistance,
        controlsMaxDistance
      );
    }
    updateCameraFocus(delta, cameraZoomTarget);
    controlsRef.current?.update();
  });

  return (
    <OrbitControlsComponent
      ref={controlsRef}
      enableRotate={false}
      enablePan={false}
      target={[0, fallbackCameraTarget, 0]}
      minDistance={headScaleAdjustedMinDistance}
      maxDistance={controlsMaxDistance}
      minPolarAngle={1.4}
      maxPolarAngle={1.4}
    />
  );
};
