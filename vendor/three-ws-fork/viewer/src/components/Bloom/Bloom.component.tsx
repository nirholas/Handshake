import React, { FC } from 'react';
import { Bloom as BloomPostProcessing } from '@react-three/postprocessing';
import { BloomConfiguration } from 'src/types';

const Bloom: FC<BloomConfiguration> = ({
  luminanceThreshold = 1,
  luminanceSmoothing = 1,
  mipmapBlur = true,
  intensity = 0.1,
  kernelSize = 0
}) => (
  <BloomPostProcessing
    luminanceThreshold={luminanceThreshold}
    luminanceSmoothing={luminanceSmoothing}
    mipmapBlur={mipmapBlur}
    intensity={intensity}
    kernelSize={kernelSize}
  />
);

export default Bloom;
