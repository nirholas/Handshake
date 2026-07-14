// Shared example metadata for the docs gallery build.
export const EXAMPLES = [
  { id: '01-read-stock-price', title: 'Read a stock price', concept: 'viem only, no SDK', difficulty: 'Beginner', proves: 'Robinhood Chain is a normal EVM L2 — viem ships its chain def, Chainlink feeds are a plain readContract.' },
  { id: '02-stock-price-sdk', title: 'Stock price with the SDK', concept: 'hoodchain basics', difficulty: 'Beginner', proves: 'hoodchain collapses example 01 to 3 lines and covers all 95 registry tokens.' },
  { id: '03-portfolio-valuation', title: 'Portfolio valuation', concept: 'ERC-8056 multiplier math', difficulty: 'Intermediate', proves: 'The correct way to value Stock Token holdings without double-counting corporate actions.' },
  { id: '04-swap-memecoin', title: 'Swap a token', concept: 'Uniswap v3 quote + execute', difficulty: 'Intermediate', proves: 'One code path quotes and (with a funded key) executes swaps on testnet and mainnet alike.' },
  { id: '05-watch-launches', title: 'Watch launches', concept: 'NOXA + Odyssey event streams', difficulty: 'Intermediate', proves: 'Two different launchpad contract shapes decode into one Launch type.' },
  { id: '06-firehose', title: 'Sequencer firehose', concept: 'Raw Nitro feed decoding', difficulty: 'Advanced', proves: 'Transactions are visible ~100–300ms before they hit RPC, straight off the public feed socket.' },
  { id: '07-live-price-webpage', title: 'Live price webpage', concept: 'Client-side JSON-RPC', difficulty: 'Beginner', proves: 'Read-only chain calls work from a static page — no backend, no build step, live on this gallery below.' },
  { id: '08-portfolio-dashboard', title: 'Portfolio dashboard', concept: 'React + polling hook', difficulty: 'Intermediate', proves: 'A production-shaped dashboard (loading/empty/error states) is a thin wrapper over example 03.' },
  { id: '09-x402-paid-api-call', title: 'Pay for an API call', concept: 'x402 client', difficulty: 'Advanced', proves: '', blocked: 'hood-api, hood402' },
  { id: '10-x402-sell-your-api', title: 'Sell your API', concept: 'x402 server middleware', difficulty: 'Advanced', proves: '', blocked: 'hood402' },
  { id: '11-mcp-agent-session', title: 'MCP agent session', concept: 'Model Context Protocol', difficulty: 'Advanced', proves: '', blocked: 'hood-mcp' },
  { id: '12-telegram-price-bot', title: 'Telegram price bot', concept: 'grammY + hoodchain', difficulty: 'Intermediate', proves: 'A full user-facing bot is ~70 lines once the SDK does the chain work.' },
  { id: '13-launch-a-coin-testnet', title: 'Launch a coin (testnet)', concept: 'Launchpad direct rail', difficulty: 'Advanced', proves: '', blocked: 'hood-launcher' },
  { id: '14-agent-paper-trader', title: 'Agent paper trader', concept: 'Strategy loop, simulated', difficulty: 'Intermediate', proves: 'A strategy loop is just getQuote on a timer — real execution slots in later without a rewrite.' },
]
