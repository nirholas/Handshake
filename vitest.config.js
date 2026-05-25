import { defineConfig } from 'vitest/config';

// Cold dynamic `import()` of API handlers that pull in heavy SDKs (@coinbase/x402,
// neon-serverless, jsdom, the Solana toolchain, etc.) routinely takes 5–30s on
// the first hit in constrained CI/Codespace environments. Individual tests that
// do real I/O still carry their own tighter timeouts; this ceiling only protects
// import-heavy module-load tests like the onchain adapter factory.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.js', 'tests/**/*.test.mjs', 'src/**/*.test.js'],
		testTimeout: 45_000,
		hookTimeout: 45_000,
	},
});
