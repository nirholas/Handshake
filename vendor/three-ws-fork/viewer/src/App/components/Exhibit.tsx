import React from 'react';
import { Vector3 } from 'three';
import { Exhibit } from 'src/components/Exhibit';

const assets = {
  posed:
    'https://files.three.ws/asset/previewModelUrl/4976bb7b-e468-4652-be7e-479b0a3768d3/f326a138-d664-493c-8a8e-06abe9dd0423-1746692254239.glb',
  default:
    'https://files.three.ws/asset/modelUrl/12a084d2-fabe-4fb2-a2f3-903fdca078f7/a5a1c247-cbf5-4ec4-8b29-ec1646c2b567-1731444612287.glb'
};

export const ExhibitPage = () => (
  <div style={{ width: '100%', height: '100%', background: '#444' }}>
    <Exhibit
      scale={1}
      environment="hub"
      position={new Vector3(0, 1, 5)}
      fit
      float={false}
      shadows={false}
      snap={false}
      lockVertical
      lockHorizontal={false}
      horizontalRotation
      modelSrc={assets.posed}
    />
  </div>
);
