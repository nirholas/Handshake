import React from 'react';

import { Avatar, CAMERA } from 'src/components/Avatar';

export const AvatarTest: React.FC = () => {
  const urlParams = new URLSearchParams(window.location.search);
  const modelUrl = urlParams.get('modelUrl')
    ? decodeURIComponent(urlParams.get('modelUrl') || '')
    : 'https://models.three.ws/64d61e9e17883fd73ebe5eb7.glb?morphTargets=ARKit,Eyes Extra&textureAtlas=none&lod=0';
  const zoomLevel = urlParams.get('zoomLevel')
    ? parseFloat(urlParams.get('zoomLevel') || '1')
    : CAMERA.CONTROLS.FULL_BODY.MAX_DISTANCE;

  return (
    <Avatar
      modelSrc={modelUrl}
      shadows
      style={{ background: 'rgb(9,20,26)' }}
      fov={45}
      cameraInitialDistance={zoomLevel}
      effects={{
        ambientOcclusion: true
      }}
    />
  );
};
