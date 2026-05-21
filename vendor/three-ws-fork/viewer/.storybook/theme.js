import { create } from '@storybook/theming';
import { getStoryAssetPath } from '../src/services';

export default create({
  base: 'light',
  brandImage: getStoryAssetPath('logo.png'),
  brandUrl: 'https://three.ws'
});
