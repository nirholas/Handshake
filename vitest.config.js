import { defineConfig } from 'vitest/config';

// Cold dynamic `import()` of API handlers that pull in heavy SDKs (@coinbase/x402,
// neon-serverless, jsdom, the Solana toolchain, etc.) routinely takes 5–15s on
// the first hit. The default 5s test timeout flaked those tests on every fresh
// node_modules — bumping the global ceiling to 20s removes the flake without
// hiding real hangs (long-running tests still get individual timeouts).
export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.js', 'tests/**/*.test.mjs', 'src/**/*.test.js'],
		testTimeout: 20_000,
		hookTimeout: 20_000,
	},
});
