import { StoryFn } from '@storybook/react';
import { StatsGl } from '@react-three/drei';
import type { Meta } from '@storybook/react';
import { Perf } from 'r3f-perf';
import React from 'react';
import { getStoryAssetPath } from 'src/services';
import { LIGHT_CONFIG } from '../Lights/Lights.component';
import { Avatar as AvatarWrapper } from './index';
import { AvatarProps } from './Avatar.component';

const Avatar = (args: AvatarProps) => (
  <AvatarWrapper {...args}>
    <Perf />
    <StatsGl />
  </AvatarWrapper>
);

const meta: Meta<typeof Avatar> = {
  component: Avatar
};

export default meta;

const Template: StoryFn<typeof Avatar> = (args) => <Avatar style={{ background: 'rgb(9,20,26)' }} {...args} />;
/* eslint-disable */
export const Debug: StoryFn<typeof Avatar> = Template.bind({});
Debug.args = {
  modelSrc: getStoryAssetPath('female.glb'),
  animationSrc: undefined,
  poseSrc: undefined,
  environment: 'hub',
  scale: 1,
  shadows: true,
  idleRotation: false,
  headMovement: false,
  /* eslint-disable no-console */
  onLoaded: () => console.info('EVENT: static avatar loaded'),
  onLoading: () => console.info('EVENT: loading static avatar'),
  /* eslint-enable no-console */
  ...LIGHT_CONFIG.defaultProps
};
