import { defineConfig } from 'cypress';
// @ts-ignore
import getCompareSnapshotsPlugin from 'cypress-image-diff-js/plugin';

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      return getCompareSnapshotsPlugin(on, config);
    },
    viewportWidth: 576,
    viewportHeight: 1024,
    chromeWebSecurity: false,
    experimentalModifyObstructiveThirdPartyCode: true,
    responseTimeout: 60000
  },
  retries: {
    /*
    runMode: 3,
    openMode: 2
    */
  }
});
