# `mobile-launch/`: cover art for the mobile-launch articles

The CoinMarketCap cover for [docs/mobile-launch/coinmarketcap-article.md](../../docs/mobile-launch/coinmarketcap-article.md): a single 16:9 composition, which is exactly the 640x360 proportion CMC's uploader asks for (limit 10 MB).

```bash
node marketing/mobile-launch/make-cmc-cover.mjs
```

| File | What it is |
| --- | --- |
| `cmc-cover-1280x720.png` | The one to upload. CMC accepts the proportion, and the larger render survives its resampling better. |
| `cmc-cover-640x360.png` | The exact stated size, if the form ever insists on it. |

Everything is generated, not hand-exported, in the same construction as the Android kit ([marketing/android-launch/](../android-launch/README.md)): the live brand fonts and app mark, and real product captures from the Play listing run (`solana-mobile/publish-play/media/phone/raw/`, rebuilt by `node solana-mobile/scripts/make-screenshots.mjs --target=play --keep-raw`), so the cover cannot show UI the app does not have. The three phones hold the agent profile, the marketplace, and the selfie-to-avatar capture screen. Unlike the X four-image grid there are no collage seams to design around, so this is one clean plane: lockup top left, one headline, three phones standing in a pool of light that falls off to true black.
