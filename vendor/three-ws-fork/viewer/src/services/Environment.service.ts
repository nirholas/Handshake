export const environmentPresets = {
  hub: 'hub',
  sunset: 'sunset',
  dawn: 'dawn',
  night: 'night',
  warehouse: 'warehouse',
  forest: 'forest',
  apartment: 'apartment',
  studio: 'studio',
  city: 'city',
  park: 'park',
  lobby: 'lobby',
  soft: 'soft'
};
export type EnvironmentPresets = keyof typeof environmentPresets;

export const getPresetEnvironmentMap = (preset: EnvironmentPresets) =>
  `https://files.three.ws/viewer/environment/${preset}.hdr`;

export const environmentModels = {
  spaceStation: 'https://files.three.ws/viewer/props/environment-space-station.glb',
  platformDark: 'https://files.three.ws/viewer/props/simple-platform-dark.glb',
  platformGreen: 'https://files.three.ws/viewer/props/simple-platform-green.glb',
  platformBlue: 'https://files.three.ws/viewer/props/simple-platform-blue.glb'
};

export type EnvironmentModels = keyof typeof environmentModels;
