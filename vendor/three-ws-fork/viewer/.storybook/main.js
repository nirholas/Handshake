module.exports = {
  staticDirs: ['../public'],
  stories: ['../src/**/*.stories.@(tsx|mdx)'],
  addons: ['@storybook/addon-essentials', '@storybook/preset-create-react-app'],
  typescript: {
    reactDocgen: 'react-docgen',
    check: true
  },
  framework: {
    name: '@storybook/react-webpack5',
    options: {}
  },
  docs: {
    autodocs: true
  },
  core: {
    disableTelemetry: true
  }
};
