import React, { FC, Ref, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Group, Mesh, Box3, Vector3 } from 'three';
import { useThree } from '@react-three/fiber';
import { normaliseMaterialsConfig, triggerCallback, usePersistantRotation } from 'src/services';
import { hasWindow } from 'src/services/Client.service';
import { BaseModelProps } from 'src/types';
import { Spawn } from 'src/components/Spawn/Spawn';

interface ModelProps extends BaseModelProps {
  scene: Group;
  modelRef?: Ref<Group>;
  scale?: number;
  onSpawnAnimationFinish?: () => void;
  lockHorizontal?: boolean;
  lockVertical?: boolean;
  horizontalRotationStep?: number;
  verticalRotationStep?: number;
}

const HORIZONTAL_ROTATION_STEP = 0.005;
const VERTICAL_ROTATION_STEP = 0.0005;

export const CenteredModel: FC<ModelProps> = ({
  scene,
  scale = 1,
  modelRef,
  onLoaded,
  onSpawnAnimationFinish,
  bloom,
  materialConfig,
  lockHorizontal,
  lockVertical,
  horizontalRotationStep = HORIZONTAL_ROTATION_STEP,
  verticalRotationStep = VERTICAL_ROTATION_STEP
}) => {
  const { gl } = useThree();
  const [isTouching, setIsTouching] = useState(false);
  const [touchEvent, setTouchEvent] = useState<TouchEvent | null>(null);
  const centerWrapperRef = useRef<Group>(null);

  const setTouchingOn = (e: MouseEvent | TouchEvent) => {
    if (hasWindow && window.TouchEvent && e instanceof TouchEvent) {
      setTouchEvent(e);
    }
    setIsTouching(true);
  };

  const setTouchingOff = () => {
    setTouchEvent(null);
    setIsTouching(false);
  };

  usePersistantRotation(scene);

  const onTouchMove = useCallback(
    (event: MouseEvent | TouchEvent) => {
      if (!isTouching) return;

      let deltaX = 0;
      let deltaY = 0;

      if (event instanceof MouseEvent) {
        deltaX = event.movementX;
        deltaY = event.movementY;
      }

      if (hasWindow && window.TouchEvent && event instanceof TouchEvent && touchEvent) {
        deltaX = event.touches[0].pageX - touchEvent.touches[0].pageX;
        deltaY = event.touches[0].pageY - touchEvent.touches[0].pageY;
        setTouchEvent(event);
      }

      if (!lockHorizontal && centerWrapperRef.current) {
        centerWrapperRef.current.rotation.y += deltaX * horizontalRotationStep;
      }

      if (!lockVertical && centerWrapperRef.current) {
        centerWrapperRef.current.rotation.x += deltaY * verticalRotationStep;
      }
    },
    [isTouching, touchEvent, lockHorizontal, lockVertical, verticalRotationStep, horizontalRotationStep]
  );

  normaliseMaterialsConfig(scene, bloom, materialConfig);

  scene.traverse((object) => {
    const node = object;

    if ((node as Mesh).isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });

  useEffect(() => {
    const boundingBox = new Box3().setFromObject(scene);
    const center = new Vector3();
    boundingBox.getCenter(center);
    scene.position.sub(center);
  }, [scene]);

  useEffect(() => triggerCallback(onLoaded), [scene, onLoaded]);

  useEffect(() => {
    gl.domElement.addEventListener('mousedown', setTouchingOn);
    gl.domElement.addEventListener('touchstart', setTouchingOn, { passive: true });
    window.addEventListener('mouseup', setTouchingOff);
    gl.domElement.addEventListener('touchend', setTouchingOff);
    gl.domElement.addEventListener('touchcancel', setTouchingOff);

    window.addEventListener('mousemove', onTouchMove);
    gl.domElement.addEventListener('touchmove', onTouchMove, { passive: true });

    return () => {
      gl.domElement.removeEventListener('mousedown', setTouchingOn);
      gl.domElement.removeEventListener('touchstart', setTouchingOn);
      window.removeEventListener('mouseup', setTouchingOff);
      gl.domElement.removeEventListener('touchend', setTouchingOff);
      gl.domElement.removeEventListener('touchcancel', setTouchingOff);

      window.removeEventListener('mousemove', onTouchMove);
      gl.domElement.removeEventListener('touchmove', onTouchMove);
    };
  }, [onTouchMove]);

  const spawnComponent = useMemo(
    () => <Spawn avatar={scene} onSpawnFinish={onSpawnAnimationFinish} />,
    [onSpawnAnimationFinish]
  );

  return (
    <group ref={modelRef} dispose={null}>
      <group ref={centerWrapperRef} rotation={[0, 0, 0]}>
        <primitive object={scene} scale={scale} />
        {spawnComponent}
      </group>
    </group>
  );
};
