# CoinGecko listing update: $THREE market additions (August 2026)

Working notes and post drafts for the CoinGecko "New Listings on Exchanges/New Market Addition"
form for $THREE (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`, CoinGecko id `three-ws`).

## The headline

Of every venue $THREE is live on, **only MEXC can actually go on this form.** CoinGecko's exchange
registry holds 1,488 entries and not one of them is an Alpha venue: no Bybit Alpha, no KuCoin Alpha,
no Binance Alpha. Jupiter and Phantom are not in it either. The form says so itself: "If you can't
find your exchange in the list, it might not be on CoinGecko yet, and we're unable to proceed."

## What CoinGecko already tracks

Pulled live from `api.coingecko.com/api/v3/coins/three-ws/tickers` on 2026-08-16:

| Market | Pair | 24h volume (USD) |
| --- | --- | --- |
| LBank | THREE / USDT | 600,824 |
| PumpSwap | three / SOL | 48,861 |
| Meteora | three / SOL | 18,130 |
| Orca | three / SOL | 13,445 |
| KCEX | THREE / USDT | 4,621 |
| Meteora (second pool) | three / SOL | 39 |

## Venue matrix

| Venue | Real? | On CoinGecko's exchange list? | Submit on this form? |
| --- | --- | --- | --- |
| MEXC spot THREE/USDT | Yes, verified via MEXC API | Yes, `MEXC [mxc]` | **Yes** |
| LBank THREE/USDT | Yes | Yes | Already tracked |
| KCEX THREE/USDT | Yes | Yes | Already tracked |
| Bybit Alpha | Yes, official announcement | No Alpha venue exists | No |
| KuCoin Alpha | Yes, official announcement | No Alpha venue exists | No |
| Binance Web3 (web3.binance.com) | Yes | No, and it is a wallet aggregator | No |
| Jupiter (Verified) | Yes | Not on CoinGecko at all | No |
| Phantom (Verified) | Yes | Not on CoinGecko at all | No |
| derp.trade | Yes, Solana leverage venue | No (CoinGecko's "DerpDEX" is a different project on zkSync/Base/opBnb) | No, and perps go through the derivatives process |

### 1. MEXC, spot THREE/USDT (the one to submit)

Confirmed the same asset from MEXC's own `exchangeInfo`:
`contractAddress: FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`, `fullName: three.ws`,
`isSpotTradingAllowed: true`. Live since 2026-06-02T01:45Z, roughly 56.5k USD of 24h quote volume.

Form values:

- Exchange Name: `MEXC`
- Exchange Trade URL: `https://www.mexc.com/exchange/THREE_USDT`

### 2. The Alpha venues

Both are real and both carry our exact mint in their trade URLs:

- Bybit Alpha: <https://announcements.bybit.com/en/article/three-is-now-live-on-bybit-alpha-bltc04fc471efada919/>
- KuCoin Alpha: <https://www.kucoin.com/announcement/ph-kucoin-alpha-new-listed-token-three-percolator>

CoinGecko carries `Bybit [bybit_spot]`, `Bybit (Futures) [bybit]` and `KuCoin [kucoin]`, but Alpha is
a separate product with separate liquidity and CoinGecko does not carry it as a venue. Submitting
Alpha markets under the parent exchange would misstate where the liquidity sits and is likely to be
rejected.

The route that does work is CoinGecko's **New Exchange Listing** request, asking them to add Bybit
Alpha and KuCoin Alpha as venues. That is a separate form and a slower process, driven by the
exchange more than by us. Worth filing, but do not let it hold up the MEXC submission.

### 3. Jupiter and Phantom "Verified"

These are token-list trust badges, not markets. Jupiter routes through the same PumpSwap, Meteora and
Orca pools CoinGecko already tracks, so there is no separate market to add, and neither is in
CoinGecko's exchange registry. They are still strong credibility signals and belong in the X post
even though they do not belong on the form.

### Ruled out

Swept the full public market lists of Gate.io, Bitget, BitMart, KuCoin spot, CoinEx, BingX, XT.com,
Toobit, Poloniex, Bitrue, LATOKEN, Phemex, CoinW, Biconomy, DigiFinex, Hotcoin, Pionex, BTSE and
Ourbit. No THREE market on any of them.

WEEX claims trace only to `weex.com/wiki/article/...` SEO pages, not to WEEX's official channel at
`weex.com/help/articles/...`. The main article 404s and their API is unreachable. Not submitted.

## Link check

Every link below was resolved on 2026-08-16 before being put in a post:

| Link | HTTP |
| --- | --- |
| jup.ag token page | 200 |
| trade.phantom.com token page | 200 |
| web3.binance.com token page | 202 |
| lbank.com support article | 200 |
| kucoin.com announcement (`en-` locale) | 200 |
| derp.trade market page | 200 |
| bybit.com alpha (tracking params stripped) | 200 |
| kcex.com/exchange/THREE_USDT | 403 |

Two notes. Use the `en-` KuCoin announcement locale, not `ph-`; both resolve but `en-` is the right
one for this audience. The KCEX 403 is their CDN blocking automated requests, not a dead link:
CoinGecko shows trades on that pair minutes old, so the market is live and the URL is fine in a post.

The Bybit trade URL is given with its affiliate and campaign tracking parameters stripped. The bare
`?address=...&chain=SOL` form resolves 200 on its own.

## Post 1: main announcement (all links)

Goes up first, from [@trythreews](https://x.com/trythreews). Its URL fills "Link (1)" in section 2
of the form, so MEXC has to be named in it.

This runs 542 characters by X's counting rules, where every URL costs 23 characters regardless of
length. It needs a Premium long post. The thread version below is the fallback if the account is on
the 280-character limit.

```
$THREE is live everywhere.

CEX
MEXC https://www.mexc.com/exchange/THREE_USDT
LBank https://www.lbank.com/trade/three_usdt
KCEX https://www.kcex.com/exchange/THREE_USDT

Alpha
Bybit https://www.bybit.com/en/alpha/?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&chain=SOL
KuCoin https://www.kucoin.com/trade/alpha/solana/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump

Verified
Jupiter https://jup.ag/tokens/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
Phantom https://trade.phantom.com/token/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
Binance Web3 https://web3.binance.com/en/token/sol/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump

Perps
derp.trade https://derp.trade/market/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump

Announcements
https://announcements.bybit.com/en/article/three-is-now-live-on-bybit-alpha-bltc04fc471efada919/
https://www.kucoin.com/announcement/en-kucoin-alpha-new-listed-token-three-percolator
https://www.lbank.com/support/articles/2062382639494463488

Charts
https://www.coingecko.com/en/coins/three-ws
https://www.geckoterminal.com/solana/pools/5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z

CA FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump

three.ws
```

The KuCoin announcement covers two tokens and its URL slug carries the other one's name. If keeping
the feed purely $THREE matters more than the citation, drop that single line; the KuCoin Alpha trade
link in the Alpha block already proves the listing.

## Post 1b: thread version (fits the 280-character limit)

Six tweets, measured at 231 / 110 / 75 / 125 / 162 / 138 characters.

```
1/  $THREE is live everywhere.

Listed on MEXC, LBank, KCEX.
Live on Bybit Alpha and KuCoin Alpha.
Verified on Jupiter, Phantom and Binance Web3.
Perps on derp.trade.

Every link below.

CA: FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
```

```
2/  Centralized exchanges

MEXC https://www.mexc.com/exchange/THREE_USDT
LBank https://www.lbank.com/trade/three_usdt
KCEX https://www.kcex.com/exchange/THREE_USDT
```

```
3/  Alpha venues

Bybit https://www.bybit.com/en/alpha/?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&chain=SOL

KuCoin https://www.kucoin.com/trade/alpha/solana/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
```

```
4/  Verified token status

Jupiter https://jup.ag/tokens/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump

Phantom https://trade.phantom.com/token/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump

Binance Web3 https://web3.binance.com/en/token/sol/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
```

```
5/  Perps and official announcements

derp.trade https://derp.trade/market/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump

Bybit https://announcements.bybit.com/en/article/three-is-now-live-on-bybit-alpha-bltc04fc471efada919/

KuCoin https://www.kucoin.com/announcement/en-kucoin-alpha-new-listed-token-three-percolator

LBank https://www.lbank.com/support/articles/2062382639494463488
```

```
6/  Charts

CoinGecko https://www.coingecko.com/en/coins/three-ws
GeckoTerminal https://www.geckoterminal.com/solana/pools/5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z

CA FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump

three.ws
```

## Post 2: public verification

Goes up after submitting, once the request ID exists. Both the request ID and the GeckoTerminal URL
have to be in the post body, not in a reply or quote tweet.

Keep this one lean. CoinGecko's reviewer is looking for two things, the request ID and the
GeckoTerminal URL, and a wall of links buries them. Request ID `CU1608260002`, filed 2026-08-16.
275 characters, fits the free tier.

```
Verifying our CoinGecko market addition request for $THREE.

Request ID: CU1608260002
GeckoTerminal: https://www.geckoterminal.com/solana/tokens/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
CA: FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
Telegram: @three_ws

MEXC market: https://www.mexc.com/exchange/THREE_USDT

Posted from the official three.ws account.
```

Three deliberate choices in that text:

- **The GeckoTerminal token URL, not a pool URL.** CoinGecko states the purpose of this step is to
  safeguard against fraudulent contract addresses. The token URL carries the contract address in its
  own path, so it does that job directly; a pool URL does not.
- **Telegram `@three_ws` included.** CoinGecko offers this as optional extra verification and it
  costs nothing. Verified on 2026-08-16 that three.ws links out to `https://t.me/three_ws`.
- **Posted from @trythreews.** Verified the same day that the live three.ws homepage links to
  `https://x.com/trythreews`, which is what satisfies "an account linked to the project's official
  website". Both social links are present on the homepage.

Paste that post's URL into the form's Remarks field. Quote-tweet the main announcement from it so the
full link set is one click away without cluttering the verification post itself.

## Checks before submitting

- three.ws must link out to @trythreews, since that link is how CoinGecko ties the account to the
  project.
- The MEXC pair URL in the announcement post and in section 3 must match exactly.
- Regular Pass (5-day) is enough for a single market addition. Fast Pass is 200 USD.
- In Remarks, note that Bybit Alpha and KuCoin Alpha markets exist but their venues are absent from
  CoinGecko's exchange list. That tells the reviewer the coverage gap is on their side, not ours.
