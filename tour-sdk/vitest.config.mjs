import { defineConfig } from 'vitest/config';

// Without a local config, `npm test` in this package walks up to the repo
// root's vitest.config.js, whose include globs (`tour-sdk/test/**`) resolve
// against THIS directory as cwd and match nothing ("No test files found",
// exit 1). The repo-root run stays covered by the root config; this one makes
// the package's own `npm test` resolve the same suite from here.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.mjs'],
	},
});
