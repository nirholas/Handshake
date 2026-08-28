# Financial features declaration and blockchain policy position

Play Console > App content > Financial features. This is the form that decides whether the
listing survives review, so it gets a reasoned answer rather than a checkbox.

## What we declare

| Financial feature | Answer |
| --- | --- |
| Cryptocurrency exchange | **No.** three.ws does not match orders, does not quote a book, and never takes custody. Buying and selling agents is a peer-to-peer on-chain transfer signed by the user's own wallet |
| Cryptocurrency wallet | **No.** The app has no key material. Signing runs through Mobile Wallet Adapter, which hands the request to a separate wallet app the user already installed, or to Seed Vault on a Solana Seeker. Uninstalling three.ws destroys no keys and loses no funds |
| Tokenized digital assets | **Yes.** Users can deploy an agent as a Metaplex Core asset on Solana, so the app enables users to obtain a tokenized digital asset. Declare it |
| Personal loans, debt, banking, investments, insurance | No |

## Why the wallet answer is "no", and how to defend it

Since late 2025 Google has required crypto exchange and wallet apps to hold a jurisdictional
license (CASP under MiCA in the EU, FCA registration in the UK, and equivalents elsewhere).
The policy text describes cryptocurrency services broadly and does not spell out a custodial
versus non-custodial line, so the safe posture is not to argue the line, it is to not be a
wallet in the first place.

three.ws is not, and the code shows it:

- No private key, seed phrase or keystore ever exists in the app. `solana-mobile/src/mwa-wallet.js`
  holds an authorization token from a separate wallet app and nothing else.
- Every signature is produced outside the app, by the wallet the user chose, on hardware we do
  not control.
- We do not custody balances, do not offer conversion between assets, do not operate an order
  book, and do not run a fiat on-ramp anywhere in the app.

Keep it that way. **Adding an in-app wallet, an in-app swap, or a fiat on-ramp would move the
app into the licensed category and jeopardize the listing.** That is a product constraint on
this distribution channel, and it is the single most important thing to know before building a
payments feature that ships to Play.

## Play Billing

Play requires Play Billing for purchases of in-app digital content. What three.ws sells is not
that: deploying an agent pays a Solana network fee to validators, and buying an agent or a
skill is a transfer between two users settled on-chain. three.ws is not the seller and takes no
in-app payment. There is no subscription, no coin pack and no consumable sold inside the
Android app.

**Do not add one without re-reading this policy first.** If a paid tier ever ships inside the
Android build, it needs Play Billing, and the on-chain lane cannot be used to route around it.

## Copy review

Play's blockchain policy also forbids promoting or glamorizing potential earnings. Before
submitting, re-read `listing/full-description.txt` for any claim that a user can profit,
earn, or make money. The current copy makes none, describes the wallet as optional, and states
plainly that three.ws is not a wallet and does not hold funds. Keep that paragraph.
