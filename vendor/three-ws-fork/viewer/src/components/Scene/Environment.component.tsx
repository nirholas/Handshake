import React, { FC, useMemo } from 'react';
import { Environment as DreiEnvironment } from '@react-three/drei';
import { environmentPresets, getPresetEnvironmentMap, EnvironmentPresets } from 'src/services/Environment.service';

export interface EnvironmentProps {
  environment: string | EnvironmentPresets;
  enablePostProcessing?: boolean | undefined;
}

export const Environment: FC<EnvironmentProps> = ({ environment, enablePostProcessing }) => {
  const config = useMemo<{ files: string }>(() => {
    const isStaticPreset = environment in environmentPresets;
    const files = isStaticPreset ? getPresetEnvironmentMap(environment as EnvironmentPresets) : environment;

    return {
      files
    };
  }, [environment]);

  const environmentIntensity = enablePostProcessing ? 12 : 4;

  return <DreiEnvironment files={config.files} environmentIntensity={environmentIntensity} />;
};
