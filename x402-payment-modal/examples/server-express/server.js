// Runnable Express server for @three-ws/x402-payment-modal.
//
// What it does:
//   1. Mounts the Solana checkout router at /api/x402-checkout. The browser
//      modal posts here to build and settle Solana USDC transfers. (EVM
//      payments sign in-browser and never hit this server.)
//   2. Serves a trivial static page from ./public so you can click through the
//      flow in a real browser.
//   3. Exposes ONE demo paid endpoint, GET /api/paid/hello, that returns a
//      correct x402 v2 challenge so you can see the 402 → pay loop end to end.
//
// Run:
//   npm install
//   SOLANA_RPC_URL="https://your-rpc" npm start
//   open http://localhost:3000

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { x402CheckoutRouter } from '@three-ws/x402-payment-modal/server/express';
import { solanaAccept } from '@three-ws/x402-payment-modal/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// A public Solana mainnet RPC works for a quick try, but it is rate-limited.
// Use a dedicated RPC (Helius, Triton, Quicknode, …) for anything real.
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const app = express();

// Required by the checkout router — it reads JSON request bodies.
app.use(express.json());

// The checkout endpoint the browser modal talks to for Solana payments.
app.use('/api/x402-checkout', x402CheckoutRouter({ rpcUrl: SOLANA_RPC_URL }));

// ── Demo paid endpoint ─────────────────────────────────────────────────────
//
// A real x402 resource answers with HTTP 402 + a challenge until it receives a
// valid X-PAYMENT header, then serves the content. Here we only implement the
// challenge half so you can watch the modal react to a 402.
//
// IMPORTANT: verifying and settling the X-PAYMENT payload against an x402
// facilitator is OUT OF SCOPE for this demo. In production you would verify the
// payment proof (and idempotency) before returning 200. See the docs:
// https://github.com/nirholas/three.ws/tree/main/x402-payment-modal/docs
//
// Synthetic placeholders below — replace payTo / feePayer with YOUR addresses.
const DEMO_PAY_TO = 'So11111111111111111111111111111111111111112'; // replace me
const DEMO_FEE_PAYER = 'So11111111111111111111111111111111111111112'; // replace me

app.get('/api/paid/hello', (req, res) => {
  const hasPayment = Boolean(req.get('X-PAYMENT'));

  if (!hasPayment) {
    // No payment yet → answer with the x402 v2 challenge. We offer TWO Solana
    // tokens — USDC and THREE — so the modal shows a token picker and the buyer
    // chooses which to pay in. `solanaAccept` builds each spec-shaped entry.
    const common = { payTo: DEMO_PAY_TO, feePayer: DEMO_FEE_PAYER, maxTimeoutSeconds: 60 };
    return res.status(402).json({
      x402Version: 2,
      error: 'Payment required',
      resource: {
        url: `${req.protocol}://${req.get('host')}/api/paid/hello`,
        description: 'A friendly hello — pay in USDC or THREE.',
        mimeType: 'application/json',
      },
      accepts: [
        solanaAccept({ token: 'usdc', uiAmount: 0.01, ...common }),  // $0.01 in USDC
        solanaAccept({ token: 'three', uiAmount: 1000, ...common }), // or 1,000 THREE
      ],
    });
  }

  // A real implementation verifies the X-PAYMENT proof here before responding.
  return res.json({ message: 'Hello — thanks for paying on Solana!' });
});

// Static demo page (examples/server-express/public/index.html).
app.use(express.static(join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`x402 checkout example running at http://localhost:${PORT}`);
  console.log(`  checkout router  → /api/x402-checkout`);
  console.log(`  demo paid route  → /api/paid/hello`);
  console.log(`  Solana RPC       → ${SOLANA_RPC_URL}`);
});
