// $THREE on-chain token layer — public surface consumed by Task 19 (paid
// spins) and Task 20 (token-priced listings) and the /api/token endpoint.
//
// Typical consumer flow:
//   import { issueQuote, verifyAndSettlePayment } from '../_lib/token/index.js';
//   const { token, quote } = await issueQuote({ purpose:'spin', usd: 0.50,
//       splitPolicy:'spin', refType:'spin', refId });
//   // ...client signs+sends one tx, returns { quoteToken: token, txSignature }
//   await verifyAndSettlePayment({ quoteToken: token, txSignature, userId });

export * from './config.js';
export * from './price.js';
export { issueQuote, verifyQuote } from './quote.js';
export { verifyOnChain, settlePayment, verifyAndSettlePayment, listPayments } from './payments.js';
