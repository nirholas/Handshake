import React from 'react';
import { StatsGl } from '@react-three/drei';

import { Avatar } from 'src/components/Avatar';
import { EnvironmentModel } from 'src/components/Models';
import { getAnimation } from 'src/services/Animation.service';

import { SettingsPanel } from './SettingsPanel';

export const AvatarDevelop: React.FC = () => (
  <>
    <SettingsPanel />
    <Avatar
      modelSrc="https://models.three.ws/64d61e9e17883fd73ebe5eb7.glb?morphTargets=ARKit,Eyes Extra&textureAtlas=none&lod=0"
      shadows
      animationSrc={getAnimation('male-idle-2.fbx')}
      style={{ background: 'rgb(9,20,26)' }}
      fov={45}
      effects={{
        ambientOcclusion: true
      }}
    >
      <StatsGl />
      <EnvironmentModel environment="spaceStation" scale={1} />
    </Avatar>
  </>
);
