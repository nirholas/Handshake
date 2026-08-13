import { defineConfig } from 'vitest/config';
import os from 'node:os';

// @three-ws/solana-agent (the symlinked `file:solana-agent-sdk` workspace SDK)
// is only ever loaded LAZILY — every importer (api/_lib/agora-human.js,
// api/agora/[action].js) reaches it via `await import()` so the module loads
// even where the SDK's dist/ isn't built yet. Vite's import-analysis still
// resolves that dynamic specifier's package entry at transform time, so when
// dist/ is transiently absent (fresh checkout before postinstall, or a
// concurrent `tsup --clean` rebuild) an import-only test like
// tests/agora-humans.test.js dies with "Failed to resolve entry for package"
// before any test runs. Marking the package external short-circuits that
// transform-time entry resolution: the lazy import resolves natively at runtime
// instead, and only when a test actually exercises an on-chain path (the
// pure-logic suites never do). server.deps.external alone doesn't cover this —
// import-analysis resolves the importing source regardless — so we intercept at
// the resolver.
function externalizeSolanaAgentSdk() {
	const PKG = '@three-ws/solana-agent';
	return {
		name: 'externalize-solana-agent-sdk',
		enforce: 'pre',
		resolveId(source) {
			if (source === PKG || source.startsWith(`${PKG}/`)) {
				return { id: source, external: true };
			}
			return null;
		},
	};
}

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
	plugins: [externalizeSolanaAgentSdk()],
	// packages/avatar-agent-mcp ships its own nested @grpc/* copies (it is a
	// standalone publishable package). Without deduping, the package's lazy
	// `import('@grpc/grpc-js')` resolves to that nested copy while a test's
	// `vi.mock('@grpc/grpc-js')` only patches the root copy — so the MCP-twin
	// TTS test fell through the mock and hit live NVCF. Forcing a single
	// instance across the graph makes the transport mock cover both libs.
	resolve: {
		dedupe: ['@grpc/grpc-js', '@grpc/proto-loader'],
	},
	test: {
		environment: 'node',
		include: [
			'tests/**/*.test.js',
			'tests/**/*.test.mjs',
			'src/**/*.test.js',
			'api/_lib/coin/**/*.test.js',
			'tour-sdk/test/**/*.test.mjs',
			'packages/*/tests/**/*.test.js',
		],
		// 45s proved too tight for this environment: with every fork cold-importing
		// multi-thousand-module graphs concurrently, single imports have been
		// measured at 51s (x402-paid-endpoint replay beforeAll) and 77s
		// (api/_mcp/dispatch.js in all-modules-load). Which test pays the cold
		// import varies run to run with scheduling, so per-test overrides are
		// whack-a-mole — the ceiling itself must clear the measured worst case.
		// Timeouts only bite hung tests; assertion failures still fail instantly.
		testTimeout: 120_000,
		hookTimeout: 120_000,
		// Vitest 4 hoisted poolOptions.forks.* to top-level.
		pool: 'forks',
		maxForks: MAX_FORKS,
		minForks: 1,
		// The suite is ~22k tests across ~1570 files and runs in 88-182s here
		// (warm vs cold), so no single test has any business taking five seconds.
		// The default 300ms threshold flags most of the file list and therefore
		// flags nothing; at 5s the reporter prints a short, honest list of the
		// files worth looking at, which is what stops the total creeping back up.
		slowTestThreshold: 5_000,
	},
});
