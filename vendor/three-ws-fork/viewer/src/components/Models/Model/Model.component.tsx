import React, { FC, Ref, useEffect, useState, useCallback, useMemo } from 'react';
import { Group, Mesh } from 'three';
import { normaliseMaterialsConfig, traverseMeshes, triggerCallback, usePersistantRotation } from 'src/services';
import { ThreeEvent, useThree } from '@react-three/fiber';
import { hasWindow } from 'src/services/Client.service';
import { BaseModelProps } from 'src/types';
import { Spawn } from '../../Spawn/Spawn';

interface ModelProps extends BaseModelProps {
  scene: Group;
  modelRef?: Ref<Group>;
  scale?: number;
  onSpawnAnimationFinish?: () => void;
}

const ROTATION_STEP = 0.005;

export const Model: FC<ModelProps> = ({
  scene,
  scale = 1,
  modelRef,
  onLoaded,
  onSpawnAnimationFinish,
  bloom,
  materialConfig,
  onMeshClick,
  onMeshHoverStart,
  onMeshHoverEnd,
  meshCallback
}) => {
  const { gl } = useThree();
  const [isTouching, setIsTouching] = useState(false);
  const [touchEvent, setTouchEvent] = useState<TouchEvent | null>(null);
  const setTouchingOn = (e: MouseEvent | TouchEvent) => {
    if (hasWindow && window.TouchEvent && e instanceof TouchEvent) {
      setTouchEvent(e as TouchEvent);
    }
    setIsTouching(true);
  };
  const setTouchingOff = (e: MouseEvent | TouchEvent) => {
    if (hasWindow && window.TouchEvent && e instanceof TouchEvent) {
      setTouchEvent(null);
    }
    setIsTouching(false);
  };

  usePersistantRotation(scene);

  const onTouchMove = useCallback(
    (event: MouseEvent | TouchEvent) => {
      if (isTouching && event instanceof MouseEvent) {
        /* eslint-disable-next-line no-param-reassign */
        scene.rotation.y += event.movementX * ROTATION_STEP;
      }

      if (hasWindow && isTouching && window.TouchEvent && event instanceof TouchEvent) {
        /* eslint-disable-next-line no-param-reassign */
        const movementX = Math.round(event.touches[0].pageX - touchEvent!.touches[0].pageX);
        /* eslint-disable-next-line no-param-reassign */
        scene.rotation.y += movementX * ROTATION_STEP;
        setTouchEvent(event);
      }
    },
    [isTouching, touchEvent, scene]
  );

  normaliseMaterialsConfig(scene, bloom, materialConfig);

  scene.traverse((object) => {
    const node = object;

    if ((node as Mesh).isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });

  if (meshCallback) {
    traverseMeshes(scene, meshCallback);
  }

  const onClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      if (!onMeshClick) {
        return;
      }

      const mesh = event.object as Mesh;

      if (mesh && mesh.isMesh) {
        onMeshClick(mesh);
      }
    },
    [onMeshClick]
  );

  const handlePointerEnter = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (!onMeshHoverStart) {
        return;
      }
      const mesh = event.object as Mesh;

      if (mesh && mesh.isMesh) {
        event.stopPropagation();
        onMeshHoverStart(mesh);
      }
    },
    [onMeshHoverStart]
  );

  const handlePointerLeave = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (!onMeshHoverEnd) {
        return;
      }
      const mesh = event.object as Mesh;

      if (mesh && mesh.isMesh) {
        event.stopPropagation();
        onMeshHoverEnd(mesh);
      }
    },
    [onMeshHoverEnd]
  );

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
  });

  const spawnComponent = useMemo(
    () => <Spawn avatar={scene} onSpawnFinish={onSpawnAnimationFinish} />,
    [onSpawnAnimationFinish]
  );

  return (
    <group
      ref={modelRef}
      dispose={null}
      rotation={[0, 0, 0]}
      onClick={onClick}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <primitive object={scene} scale={scale} />
      {spawnComponent}
    </group>
  );
};
