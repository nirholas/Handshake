// GET /api/x402/market-derivatives — paid Market Data API (x402, USDC on Solana/Base).
// Thin route shell: the category registry + shared factory in
// api/_lib/market-data/ define the price, discovery listing, and handler.
import { marketEndpoint } from '../_lib/market-data/endpoint.js';

export default marketEndpoint('market-derivatives');
