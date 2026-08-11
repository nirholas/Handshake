// @three-ws/agent-sniper — public library surface.
//
// A lightweight, embeddable pump.fun sniper engine for 3D AI agents. Bring your
// own (or accept the default) wallet / store / RPC / feed adapters; the same
// trade loop runs anywhere. See README.md for the full guide and src/types.js
// for the adapter contracts.
//
//   import { createSniper, presets } from '@three-ws/agent-sniper';
//   const sniper = await presets.local({ network: 'devnet' });
//   await sniper.start();

import { createSniper } from './engine.js';
import { loadConfig } from './config.js';
import { createMemoryStore } from './adapters/store/memory.js';
import { createSelfCustodyWallet } from './adapters/wallet/self-custody.js';
import { createCustodialWallet } from './adapters/wallet/custodial.js';
import { createPumpClient } from './adapters/solana/pump-client.js';
import { createWeb3Executor } from './adapters/solana/executor-web3.js';

// ── core ──────────────────────────────────────────────────────────────────────
export { createSniper } from './engine.js';
export { loadConfig } from './config.js';
export { scoreMint, scoreIntel, learnedScore } from './scorer.js';
export { decideExit } from './exit-logic.js';
export { createMayhemFilter, retryWhileNull } from './mayhem-filter.js';
export {
	checkConcurrency, checkDailyBudgetLamports, checkSolHeadroom, checkPriceImpact,
	makeThrottle, makeQueue, SOL_FEE_HEADROOM_LAMPORTS,
} from './guards.js';

// ── adapters (defaults; swap any) ──────────────────────────────────────────────
export { createMemoryStore } from './adapters/store/memory.js';
export { createSelfCustodyWallet } from './adapters/wallet/self-custody.js';
export { createCustodialWallet } from './adapters/wallet/custodial.js';
export { createPumpClient } from './adapters/solana/pump-client.js';
export { createWeb3Executor } from './adapters/solana/executor-web3.js';
export { createPumpPortalFeed } from './adapters/feed/pumpportal.js';

// ── 3D agents ──────────────────────────────────────────────────────────────────
export { AGENT_AVATARS, ANIMATION_CLIPS, agentConfig, deskMonitorFrame } from './agents/manifest.js';

/**
 * Ready-made wirings. Each returns an unstarted sniper handle — call `.start()`.
 */
export const presets = {
	/**
	 * Fully local, self-custodial sniper. Memory store + self-custody wallet +
	 * pump.fun client + web3 executor + PumpPortal feed. The zero-to-running path.
	 *
	 * @param {object} [o]
	 * @param {'mainnet'|'devnet'} [o.network]
	 * @param {'simulate'|'live'} [o.mode]
	 * @param {string} [o.rpcUrl]
	 * @param {import('./types.js').Strategy[]} [o.strategies]
	 * @param {Record<string,string>} [o.secrets]   agentId → wallet secret
	 * @param {import('./types.js').Hooks} [o.hooks]
	 */
	async local(o = {}) {
		const { createPumpPortalFeed } = await import('./adapters/feed/pumpportal.js');
		const store = createMemoryStore({ strategies: o.strategies || [] });
		const solana = await createPumpClient({ network: o.network || 'mainnet', rpcUrl: o.rpcUrl });
		return createSniper({
			config: { network: o.network, mode: o.mode, rpcUrl: o.rpcUrl },
			store,
			wallet: createSelfCustodyWallet({ secrets: o.secrets }),
			solana,
			executor: createWeb3Executor(),
			feed: createPumpPortalFeed({ network: o.network || 'mainnet' }),
			hooks: o.hooks,
		});
	},
};

export default { createSniper, loadConfig, presets };
