import React, { useMemo, useState, FC } from 'react';
import { StatsGl } from '@react-three/drei';

import { Avatar, CAMERA } from 'src/components/Avatar';
import { AnimationsT } from 'src/types';
import { getAnimation } from 'src/services/Animation.service';
import { SettingsPanel } from './SettingsPanel';

const modelSrc = 'https://avatars.three.ws/675aa4ded65bc4b9fbc4808a.glb';

type AnimationKeys = 'idle' | 'land';

export const AvatarNova: FC = () => {
  const animations: AnimationsT = useMemo(
    () => ({
      idle: {
        source: getAnimation('take2-idle.glb'),
        key: 'Armature'
      },
      land: {
        source: getAnimation('take2.glb'),
        key: 'Armature',
        repeat: 1
      }
    }),
    []
  );

  const [activeAnimation, setActiveAnimation] = useState<AnimationKeys>('land');

  return (
    <div style={{ width: '100%', height: '100%', background: '#444' }}>
      <SettingsPanel>
        {Object.keys(animations).map((name) => (
          <button key={name} type="button" onClick={() => setActiveAnimation(name as AnimationKeys)}>
            Set {name} animation
          </button>
        ))}
      </SettingsPanel>
      <Avatar
        controlsMinDistance={CAMERA.CONTROLS.FULL_BODY.MAX_DISTANCE}
        controlsMaxDistance={CAMERA.CONTROLS.FULL_BODY.MAX_DISTANCE}
        modelSrc={modelSrc}
        animations={animations}
        activeAnimation={activeAnimation}
        shadows
        animatedCameraSrc={activeAnimation === 'land' ? animations[activeAnimation].source : undefined}
        onAnimationEnd={() => setActiveAnimation('idle')}
        fov={45}
        cameraInitialDistance={CAMERA.CONTROLS.FULL_BODY.MAX_DISTANCE}
        effects={{
          ambientOcclusion: false
        }}
      >
        <StatsGl />
      </Avatar>
    </div>
  );
};
