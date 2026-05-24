/**
 * TokenAdapter — the contract every token-launch backend implements.
 *
 * Parallel to WalletAdapter. The deploy orchestrator and UI talk only to this
 * interface; new launchpads (Zora, Bonfida, Streamflow…) plug in as new
 * adapters without forking the calling code.
 *
 * A "token" here is a fungible asset bound to an agent identity (memecoin on a
 * bonding curve, social token, etc.). Distinct from the agent's *identity* NFT
 * minted via the deploy flow.
 *
 * Interface-by-convention: subclasses historically override every method and
 * never call super. The shape lives in JSDoc so authors get static-analysis
 * feedback without a runtime base class that exists only to throw.
 */

/**
 * @typedef {object} LaunchPrep
 * @property {string} prepId
 * @property {string} mint              Mint pubkey (Solana base58, EVM addr, etc.)
 * @property {string} txBase64          Partially-signed unsigned-by-user tx
 * @property {string} metadataUri       Token metadata pointer (ipfs://...)
 * @property {string} family            'solana' | 'evm' | ...
 * @property {string} provider          'pumpfun' | 'zora' | ...
 * @property {string} [cluster]         For Solana
 */

/**
 * @typedef {object} LaunchResult
 * @property {string} mint
 * @property {string} txHash            Tx hash / signature
 * @property {string} provider
 * @property {string} [curve]           Provider-specific curve / pool ID
 */

/**
 * @typedef {object} TokenAdapter
 * @property {string} provider          'pumpfun' | 'zora' | etc.
 * @property {'solana'|'evm'} family
 * @property {(ctx: { agent: object }) => { ok: boolean, reason?: string }} validatePreconditions
 *   Validate that a launch is permitted for the given agent state. Adapters
 *   use this to enforce constraints (Pump.fun is Solana-only, requires the
 *   agent to already have a Solana identity, etc.).
 */
