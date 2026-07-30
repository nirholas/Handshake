# @three-ws/x402-fetch examples

Two runnable scripts against the live three.ws x402 Market Data API. Node 20+ is the only requirement; the package has zero production dependencies.

## discover.mjs (free)

Probes a paid endpoint without paying and prints the parsed 402 challenge: price, network, asset, and pay-to address for every payment rail the server accepts.

```bash
node examples/discover.mjs
```

No wallet or key needed; nothing is spent. Override the target with `X402_ENDPOINT=<url>`.

## paid-call.mjs (spends $0.001 USDC)

Wraps a private-key wallet in `withX402()` and makes a real paid call. The wrapper answers the 402 with a signed USDC-on-Base EIP-3009 authorization and returns the unlocked data.

```bash
PRIVATE_KEY=0x... node examples/paid-call.mjs
```

Requirements:

- `PRIVATE_KEY`: a Base-mainnet private key (0x-hex) holding USDC. The script exits with instructions when it is unset.
- The call costs $0.001 USDC, guarded by `maxPaymentUsd: 0.01` in the script.

Both scripts default to `https://three.ws/api/x402/market-global`; the full endpoint catalog is free at [three.ws/api/x402/market](https://three.ws/api/x402/market).
