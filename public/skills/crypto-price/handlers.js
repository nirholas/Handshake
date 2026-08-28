export default {
  async getPrice(args, ctx) {
    const { coin_id, vs_currency } = args;
    if (!coin_id || !vs_currency) {
      return { ok: false, error: 'coin_id and vs_currency are required' };
    }

    // Two independent feeds, each bounded and each with its OWN parser. A
    // second URL whose response shape the first parser cannot read is not a
    // fallback, it is a silent miss, so the source and its reader travel
    // together. DefiLlama only quotes USD, so it stands in for the USD case and
    // steps aside for any other vs_currency rather than answering the wrong
    // question.
    const feeds = [
      {
        url: `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin_id)}&vs_currencies=${encodeURIComponent(vs_currency)}`,
        parse: (d) => d?.[coin_id]?.[vs_currency],
      },
      ...(String(vs_currency).toLowerCase() === 'usd'
        ? [{
            url: `https://coins.llama.fi/prices/current/coingecko:${encodeURIComponent(coin_id)}`,
            parse: (d) => d?.coins?.[`coingecko:${coin_id}`]?.price,
          }]
        : []),
    ];

    for (const feed of feeds) {
      try {
        const r = await fetch(feed.url, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) continue;
        const price = feed.parse(await r.json());
        if (typeof price === 'number' && Number.isFinite(price)) {
          return { ok: true, output: `The current price of ${coin_id} is ${price} ${vs_currency.toUpperCase()}.` };
        }
      } catch (error) {
        console.error('Error fetching crypto price:', error);
      }
    }

    return { ok: false, error: `Could not retrieve price for ${coin_id} in ${vs_currency}` };
  }
};
