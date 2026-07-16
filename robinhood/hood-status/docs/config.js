/**
 * hood-status front-end configuration.
 *
 * workerUrl: origin of the deployed probe worker (Cloud Run), e.g.
 *   'https://hood-status-xxxxxx-uc.a.run.app'. Leave '' to run the page in
 *   direct-probe mode (the browser probes the chain itself; no history).
 *   Can also be overridden per-visit with ?worker=https://... or
 *   localStorage 'hood-status:worker'.
 *
 * Everything else is the public Robinhood Chain surface (chain ID 4663).
 * Chainlink feed addresses are the verified registry entries from
 * robinhood-chain-sdk (resolved on-chain against the Chainlink reference
 * data directory for Robinhood mainnet).
 */
window.HOOD_STATUS_CONFIG = {
  workerUrl: '',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  feedUrl: 'wss://feed.mainnet.chain.robinhood.com',
  blockscoutUrl: 'https://robinhoodchain.blockscout.com',
  l1RpcUrl: 'https://ethereum-rpc.publicnode.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  chainlinkFeeds: [
    { symbol: 'AAPL', address: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0' },
    { symbol: 'TSLA', address: '0x4A1166a659A55625345e9515b32adECea5547C38' },
    { symbol: 'NVDA', address: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' },
    { symbol: 'MSFT', address: '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E' },
    { symbol: 'AMZN', address: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C' },
  ],
};
