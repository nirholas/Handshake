/** Environment-driven configuration for the probe worker. */

const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  dbPath: env.DB_PATH || './data/hood-status.sqlite',
  probeIntervalMs: Number(env.PROBE_INTERVAL_MS || 30_000),
  chainlinkIntervalMs: Number(env.CHAINLINK_INTERVAL_MS || 300_000),
  retentionDays: Number(env.RETENTION_DAYS || 90),
  incidentRetentionDays: Number(env.INCIDENT_RETENTION_DAYS || 180),

  chainId: 4663,
  rpcUrl: env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  // Optional paid RPC lane: set ALCHEMY_API_KEY to also monitor Alchemy.
  alchemyUrl: env.ALCHEMY_API_KEY
    ? `https://robinhood-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`
    : null,
  feedUrl: env.FEED_URL || 'wss://feed.mainnet.chain.robinhood.com',
  blockscoutUrl: env.BLOCKSCOUT_URL || 'https://robinhoodchain.blockscout.com',
  // Any public Ethereum mainnet RPC works; only eth_blockNumber is called.
  l1RpcUrl: env.L1_RPC_URL || 'https://ethereum-rpc.publicnode.com',
};

/**
 * Chainlink Stock Token price feeds sampled for freshness. Addresses come
 * from the verified registry in robinhood-chain-sdk
 * (src/registry/stock-tokens.json, resolved on-chain against the Chainlink
 * reference-data directory for Robinhood mainnet).
 */
export const CHAINLINK_FEEDS = [
  { symbol: 'AAPL', address: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0' },
  { symbol: 'TSLA', address: '0x4A1166a659A55625345e9515b32adECea5547C38' },
  { symbol: 'NVDA', address: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' },
  { symbol: 'MSFT', address: '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E' },
  { symbol: 'AMZN', address: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C' },
];
