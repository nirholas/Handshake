import React, { useCallback, useState } from 'react';
import { StoryFn } from '@storybook/react';
import { Sparkles as SparklesDrei } from '@react-three/drei';
import type { Meta } from '@storybook/react';
import { Avatar as AvatarWrapper, CAMERA } from 'src/components/Avatar';
import { getStoryAssetPath } from 'src/services';
import { ignoreArgTypesOnExamples, emotions, modelPresets, animationPresets } from 'src/services/Stories.service';
import { Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { AvatarProps } from './Avatar.component';
import { Static } from './Avatar.stories';
import { BloomConfiguration } from '../../types';

const Avatar = (args: AvatarProps) => <AvatarWrapper {...args} />;

const Sparkles: StoryFn<typeof SparklesDrei> = (args: any) => <SparklesDrei {...args} />;
const meta: Meta<typeof Avatar> = {
  component: Avatar,
  // @ts-ignore
  subcomponents: { Sparkles }
};

export default meta;

export const Bloom: StoryFn<BloomConfiguration> = (args: BloomConfiguration | undefined) => (
  <Avatar
    modelSrc={modelPresets.one}
    cameraTarget={CAMERA.TARGET.FULL_BODY.FEMALE}
    cameraInitialDistance={CAMERA.CONTROLS.FULL_BODY.MAX_DISTANCE}
    effects={{ bloom: { ...args } }}
    keyLightIntensity={1.2}
    keyLightColor="#e8e3df"
    fillLightIntensity={3.0}
    fillLightColor="#99ccff"
    fillLightPosition={new Vector3(-0.5, 1.6, -0.5)}
    backLightIntensity={6.0}
    backLightColor="#fff0d6"
    backLightPosition={new Vector3(0.5, 1.6, -1.0)}
    lightTarget={new Vector3(0.0, 1.7, 0.0)}
    environment="soft"
    background={{
      color: 'rgb(9,20,26)'
    }}
  />
);

Bloom.args = {
  luminanceThreshold: 1.0,
  luminanceSmoothing: 1.0,
  mipmapBlur: true,
  kernelSize: 1,
  intensity: 1,
  materialIntensity: 1
};

Bloom.argTypes = {
  luminanceThreshold: { control: { type: 'range', step: 0.01, min: 0, max: 1 } },
  luminanceSmoothing: { control: { type: 'range', step: 0.01, min: 0, max: 1 } },
  mipmapBlur: { control: { type: 'boolean' } },
  intensity: { control: { type: 'range', min: 0, max: 100 } },
  materialIntensity: { control: { type: 'range', step: 0.01, min: 0, max: 1 } },
  kernelSize: { control: { type: 'range', min: 0, max: 4 } },
  ...ignoreArgTypesOnExamples
};

export const FloatingSparkles: StoryFn<typeof SparklesDrei> = (args) => (
  <Avatar
    modelSrc={getStoryAssetPath('female.glb')}
    cameraTarget={CAMERA.TARGET.FULL_BODY.FEMALE}
    cameraInitialDistance={CAMERA.CONTROLS.FULL_BODY.MAX_DISTANCE}
    shadows
  >
    <Sparkles {...args} />
  </Avatar>
);

FloatingSparkles.args = {
  count: 70,
  scale: 4,
  size: 5,
  speed: 0.25,
  opacity: 0.6,
  color: '#124cca',
  position: [0, 3, 0]
};

FloatingSparkles.argTypes = {
  count: { control: { type: 'range', min: 0, max: 70 } },
  scale: { control: { type: 'number' } },
  size: { control: { type: 'range', min: 0, max: 10 } },
  speed: { control: { type: 'range', step: 0.01, min: 0, max: 20 } },
  opacity: { control: { type: 'range', step: 0.01, min: 0, max: 1.1 } },
  ...ignoreArgTypesOnExamples
};

export const SpawnEffectAndAnimation: StoryFn<typeof Avatar> = (args) => (
  <Avatar {...args}>
    <Sparkles color="white" count={50} opacity={0.9} scale={5} size={0.5} speed={0.35} position={[0, 3, 0]} />
  </Avatar>
);
SpawnEffectAndAnimation.args = {
  onLoadedEffect: {
    src: getStoryAssetPath('spawn-effect.glb'),
    loop: 12
  },
  onLoadedAnimation: {
    src: getStoryAssetPath('male-spawn-animation.fbx'),
    loop: 1
  },
  cameraTarget: CAMERA.TARGET.FULL_BODY.FEMALE,
  cameraInitialDistance: CAMERA.CONTROLS.FULL_BODY.MAX_DISTANCE,
  modelSrc: getStoryAssetPath('male-emissive.glb'),
  animationSrc: getStoryAssetPath('male-idle.glb'),
  background: { color: 'rgb(9,20,26)' }
};
SpawnEffectAndAnimation.argTypes = {
  ...ignoreArgTypesOnExamples,
  onLoadedEffect: { control: { disable: false } },
  onLoadedAnimation: { control: { disable: false } },
  modelSrc: { control: { disable: false } },
  animationSrc: { control: { disable: false } }
};

export const Posing: StoryFn<typeof Avatar> = (args) => <Avatar {...args} />;
Posing.args = {
  ...Static.args,
  modelSrc: getStoryAssetPath('male.glb'),
  poseSrc: getStoryAssetPath('male-pose-standing.glb'),
  cameraTarget: CAMERA.TARGET.FULL_BODY.MALE,
  cameraInitialDistance: CAMERA.CONTROLS.FULL_BODY.MAX_DISTANCE,
  /* eslint-disable no-console */
  onLoaded: () => console.info('EVENT: posing avatar loaded'),
  onLoading: () => console.info('EVENT: loading posing avatar'),
  /* eslint-enable no-console */
  emotion: emotions.smile
};
Posing.argTypes = {
  headMovement: { control: false }
};

export const IdleBlinking: StoryFn<typeof Avatar> = (args) => <Avatar {...args} />;
IdleBlinking.args = {
  // @ts-ignore
  Comment: "Idle blinking works when avatar includes morph targets for 'ARKit' and 'Eyes Extra'.",
  ...Static.args,
  modelSrc: modelPresets.seven,
  animationSrc: animationPresets.three,
  cameraTarget: CAMERA.TARGET.FULL_BODY.MALE,
  cameraInitialDistance: CAMERA.CONTROLS.FULL_BODY.MAX_DISTANCE,
  headMovement: true,
  emotion: emotions.smile
};
IdleBlinking.argTypes = {
  ...ignoreArgTypesOnExamples,
  modelSrc: { options: Object.values({ seven: modelPresets.seven }), control: { type: 'select' } },
  animationSrc: { options: Object.values(animationPresets), control: { type: 'select' } }
};

const highlightMaterial = new MeshStandardMaterial({ color: '#ff0000', transparent: false });

export const MouseActions: StoryFn<typeof Avatar> = (args) => {
  const [originalMaterials] = useState(new Map());

  const handleModelClick = (mesh: Mesh) => {
    console.log('Clicked mesh:', mesh);
  };

  const dimClothMaterials = (mesh: Mesh) => {
    const meshWhitelist = ['Wolf3D_Outfit_Top', 'Wolf3D_Outfit_Bottom', 'Wolf3D_Hair', 'Wolf3D_Outfit_Footwear'];

    if (!meshWhitelist.includes(mesh.name)) {
      return;
    }

    const material = mesh.material as MeshStandardMaterial;
    material.color.setHex(0x404040);
    material.roughness = 0.8;
    material.metalness = 0.1;
    material.emissive.setHex(0xffffff);
    material.emissiveIntensity = 0.1;
  };

  const onMeshHoverStart = useCallback(
    (mesh: Mesh) => {
      const meshWhiteList = ['Wolf3D_Outfit_Top', 'Wolf3D_Outfit_Bottom', 'Wolf3D_Hair', 'Wolf3D_Outfit_Footwear'];

      if (!meshWhiteList.includes(mesh?.name)) {
        return;
      }

      document.body.style.cursor = 'pointer';

      // Store original material and set hover highlight for the new mesh
      if (!originalMaterials.has(mesh.name)) {
        originalMaterials.set(mesh.name, mesh.material);

        // eslint-disable-next-line no-param-reassign
        mesh.material = highlightMaterial;
      }
    },
    [originalMaterials]
  );

  const onMeshHoverEnd = useCallback(
    (mesh: Mesh) => {
      const originalMaterial = originalMaterials.get(mesh.name);

      if (originalMaterial) {
        document.body.style.cursor = 'default';
        // eslint-disable-next-line no-param-reassign
        mesh.material = originalMaterial;
        originalMaterials.delete(mesh.name);
      }
    },
    [originalMaterials]
  );

  return (
    <Avatar
      {...args}
      onMeshClick={handleModelClick}
      meshCallback={dimClothMaterials}
      onMeshHoverStart={onMeshHoverStart}
      onMeshHoverEnd={onMeshHoverEnd}
    />
  );
};

MouseActions.args = {
  ...Static.args,
  modelSrc: getStoryAssetPath('male.glb'),
  cameraTarget: CAMERA.TARGET.FULL_BODY.MALE,
  cameraInitialDistance: CAMERA.CONTROLS.FULL_BODY.MAX_DISTANCE,
  background: {
    color: 'rgba(134, 157, 169, 1)'
  }
};

MouseActions.argTypes = {};
