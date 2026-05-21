import React, { useState } from 'react';
import { StatsGl } from '@react-three/drei';
import { Vector3 } from 'three';

import { Avatar } from 'src/components/Avatar';
import { SettingsPanel } from './SettingsPanel';

const modelUrl = 'https://avatars.three.ws/6735d9cb1f22bfcc50a037ec.glb';

export const AvatarCapture: React.FC = () => {
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [base64, setBase64] = useState<string | undefined>();

  const capture = async (image?: string) => {
    setBase64(image);
    setIsCapturing(false);
  };

  return (
    <>
      <SettingsPanel>
        <button type="button" onClick={() => setIsCapturing(true)}>
          CAPTURE
        </button>
      </SettingsPanel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: '100%', placeItems: 'center' }}>
        <Avatar
          modelSrc={modelUrl}
          cameraTarget={1.5}
          halfBody={false}
          emotion={{
            mouthSmileLeft: 0.6,
            mouthSmileRight: 0.6
          }}
          environment="https://assets.three.ws/environment/soft.hdr"
          cameraInitialDistance={2.5}
          capture={{
            trigger: isCapturing,
            callBack: capture,
            settings: {
              quality: 0.9,

              type: 'image/jpeg'
            }
          }}
          background={{
            src: 'https://upload.wikimedia.org/wikipedia/commons/d/d0/Color-yellow.JPG',
            position: [0, 0.6, -3.3] as unknown as Vector3,
            scale: 4 as unknown as Vector3,
            rotation: [-0.165, 0, 0] as any
          }}
          style={{ backgroundColor: '#ffdd00' }}
          keyLightIntensity={0.7}
        >
          <StatsGl />
        </Avatar>
        <div style={{ position: 'relative' }}>
          <img
            src={base64}
            style={{ width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'center' }}
            alt="test preview"
          />
        </div>
      </div>
    </>
  );
};
