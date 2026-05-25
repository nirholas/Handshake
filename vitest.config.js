import { defineConfig } from 'vitest/config';
import os from 'node:os';

// Cold dynamic `import()` of API handlers that pull in heavy SDKs (@coinbase/x402,
// neon-serverless, jsdom, the Solana toolchain, etc.) routinely takes 5–30s on
// the first hit in constrained CI/Codespace environments. Individual tests that
// do real I/O still carry their own tighter timeouts; this ceiling only protects
// import-heavy module-load tests like the onchain adapter factory.
//
// Parallelism: on Codespaces / small CI workers the default (cpus - 1) workers
// melt the box — heavy ESM cold-imports across files compete for memory and
// repeatedly miss their hookTimeout. We cap forks at min(4, cpus - 1) so worker
// startup never queues behind a busy peer. Locally on a beefy machine
// (CPUs > 4) this still parallelizes; small hosts get safe serialisation.
// On CI / Codespaces the box is small (typically 2-4 cores, capped memory),
// and heavy ESM cold-imports across files compete for the same V8 instance.
// We cap forks at 2 for hosts with <=4 cores so cold loads aren't blocked by
// peer workers. Beefier machines (>4 cores) parallelise up to (cpus - 1, max 6).
const _cpus = Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1);
const MAX_FORKS = _cpus <= 3 ? 2 : Math.min(6, _cpus);

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.js', 'tests/**/*.test.mjs', 'src/**/*.test.js'],
		testTimeout: 45_000,
		hookTimeout: 45_000,
		// Vitest 4 hoisted poolOptions.forks.* to top-level.
		pool: 'forks',
		maxForks: MAX_FORKS,
		minForks: 1,
	},
});
