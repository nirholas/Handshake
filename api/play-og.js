// api/play-og.js — Open Graph / preview image for /play Coin Communities.
// Renders a branded card for a coin's 3D world as a PNG. Coin-aware: pass
// ?coin=<mint> (or ?mint=) for live name / ticker / market cap and the
// deterministic biome palette that coin's world renders in.
//
// Doubles as the guaranteed <img> fallback for content platforms that block
// scripts/iframes (e.g. the AWS Builder Center editor): it is a plain image
// served from our own domain, coin-specific, no embed component required.
import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

// Biome archetypes, matched to the seeded worlds described in /play.
// Each coin's mint deterministically picks one, so the poster's palette
// matches the world the visitor actually lands in.
const BIOMES = [
  { name: 'Verdant Meadow', c1: '#16a34a', c2: '#4ade80' },
  { name: 'Dune Sea', c1: '#d97706', c2: '#fbbf24' },
  { name: 'Frostfields', c1: '#0ea5e9', c2: '#a5f3fc' },
  { name: 'Ashen Caldera', c1: '#b91c1c', c2: '#f97316' },
  { name: 'Neon Expanse', c1: '#7c3aed', c2: '#ec4899' },
  { name: 'Lagoon Shore', c1: '#0d9488', c2: '#5eead4' },
];

function seedHash(seed) {
  let h = 0;
  const s = String(seed || 'three');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function pickBiome(mint) {
  return BIOMES[seedHash(mint) % BIOMES.length];
}

function formatMarketCap(mc) {
  const n = Number(mc);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

async function fetchCoin(origin, mint) {
  if (!mint) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${origin}/api/pump/coin?mint=${encodeURIComponent(mint)}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export default async function handler(req) {
  const url = new URL(req.url);
  const origin = url.origin;
  const mint = url.searchParams.get('coin') || url.searchParams.get('mint') || '';

  const coin = await fetchCoin(origin, mint);
  const biome = pickBiome(mint);

  const ticker = coin?.symbol ? `$${String(coin.symbol).replace(/^\$/, '')}` : null;
  const name = coin?.name || (mint ? 'this coin' : 'any coin');
  const mcap = formatMarketCap(coin?.marketCap);
  const image = coin?.image || null;

  const heading = ticker ? `Walk into ${ticker}` : 'Walk into any coin';

  const metaChips = [
    { label: biome.name },
    mcap ? { label: `MCAP ${mcap}` } : null,
    { label: 'Live 3D world' },
  ].filter(Boolean);

  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 72px',
          background: `radial-gradient(120% 120% at 80% 10%, ${biome.c2} 0%, ${biome.c1} 45%, #0a0a0a 100%)`,
          color: 'white',
          fontFamily: 'sans-serif',
        },
        children: [
          // top row: brand + coin art
          {
            type: 'div',
            props: {
              style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
              children: [
                {
                  type: 'div',
                  props: {
                    style: { fontSize: 30, fontWeight: 800, letterSpacing: -1, opacity: 0.95 },
                    children: 'three.ws · /play',
                  },
                },
                image
                  ? {
                      type: 'img',
                      props: {
                        src: image,
                        width: 96,
                        height: 96,
                        style: { borderRadius: 96, border: '3px solid rgba(255,255,255,0.85)' },
                      },
                    }
                  : { type: 'div', props: { children: '' } },
              ],
            },
          },
          // middle: heading + name
          {
            type: 'div',
            props: {
              style: { display: 'flex', flexDirection: 'column' },
              children: [
                {
                  type: 'div',
                  props: {
                    style: { fontSize: 84, fontWeight: 900, letterSpacing: -3, lineHeight: 1.0 },
                    children: heading,
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: { fontSize: 34, marginTop: 14, opacity: 0.92, fontWeight: 600 },
                    children: ticker ? name : 'Turn any pump.fun coin into a live 3D world',
                  },
                },
              ],
            },
          },
          // bottom: chips
          {
            type: 'div',
            props: {
              style: { display: 'flex', gap: 16 },
              children: metaChips.map((chip) => ({
                type: 'div',
                props: {
                  style: {
                    fontSize: 26,
                    fontWeight: 700,
                    padding: '12px 22px',
                    borderRadius: 999,
                    background: 'rgba(0,0,0,0.35)',
                    border: '1px solid rgba(255,255,255,0.25)',
                  },
                  children: chip.label,
                },
              })),
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      headers: { 'cache-control': 'public, max-age=300, s-maxage=600' },
    },
  );
}
