import React from 'react';
import { ComponentStory, ComponentMeta } from '@storybook/react';
import { getStoryAssetPath } from 'src/services';
import { FileDropper } from 'src/components/FileDropper/FileDropper.component';
import { Vector3 } from 'three';
import { environmentPresets } from 'src/services/Environment.service';
import { Exhibit } from './Exhibit.component';

const Template: ComponentStory<typeof Exhibit> = (args) => <Exhibit {...args} />;
const DropTemplate: ComponentStory<typeof Exhibit> = (args) => (
  <FileDropper placeholder="Drag n' Drop a .glb model here">
    <Exhibit {...args} />
  </FileDropper>
);

export const Default = Template.bind({});
Default.args = {
  modelSrc: getStoryAssetPath('headwear.glb'),
  scale: 3,
  environment: 'hub',
  position: new Vector3(0, 1, 5),
  fit: true,
  float: true,
  shadows: true,
  style: { background: '#ccc' },
  snap: true,
  lockVertical: false,
  /* eslint-disable no-console */
  onLoaded: () => console.info('EVENT: static avatar loaded'),
  onLoading: () => console.info('EVENT: loading static avatar')
  /* eslint-enable no-console */
};
Default.argTypes = {
  environment: { options: Object.keys(environmentPresets), control: { type: 'select' } }
};

/* eslint-disable */
export const _DragNDrop = DropTemplate.bind({});
_DragNDrop.args = {
  ...Default.args,
  /* eslint-disable no-console */
  onLoaded: () => console.info('EVENT: static avatar loaded'),
  onLoading: () => console.info('EVENT: loading static avatar'),
  /* eslint-enable no-console */
  position: new Vector3(0, 0, 5)
};
_DragNDrop.argTypes = {
  modelSrc: { control: false }
};
/* eslint-enable */

export default {
  title: 'Components/Exhibit',
  component: Exhibit,
  argTypes: {
    scale: { control: { type: 'range', min: 0.01, max: 10, step: 0.01 } }
  }
} as ComponentMeta<typeof Exhibit>;
