// api/page-og.js — generic Open Graph / social-share image for every static
// page in data/pages.json. One endpoint renders a branded, per-page,
// per-section 1200×630 PNG card so each shared link previews with its own
// title, description, and section identity instead of a single shared image.
//
// Driven entirely by query params (no DB / filesystem read at request time):
//   ?t=<title>  ?d=<description>  ?s=<section id>  ?p=<route path>
// The SEO injector (scripts/inject-seo-meta.mjs) stamps these straight from the
// page catalog, so the card a crawler sees always matches the sitemap copy.
//
// Rendered as a real PNG via @vercel/og's ImageResponse on the NODE runtime
// (not Edge — Edge returns FUNCTION_INVOCATION_FAILED in this deployment), the
// same pattern proven in api/play-og.js. PNG (not SVG) so X, Facebook,
// LinkedIn, and iMessage — none of which render image/svg+xml OG cards — all
// show the preview.
import { ImageResponse } from '@vercel/og';
import { readFileSync } from 'node:fs';

const WIDTH = 1200;
const HEIGHT = 630;

// IBM Plex faces for the light "carbon" variant (?v=carbon). Vendored TTFs
// (OFL-licensed) under api/_lib/fonts/ — loaded once per process, and only
// when a carbon card is actually requested, so the default dark card pays
// nothing. Satori can't consume woff2, hence TTF here rather than reusing
// the woff2 set under pages/ibm/fonts/.
let plexFonts = null;
function loadPlexFonts() {
  if (plexFonts) return plexFonts;
  const font = (file) => readFileSync(new URL(`./_lib/fonts/${file}`, import.meta.url));
  plexFonts = [
    { name: 'IBM Plex Sans', data: font('IBMPlexSans-Regular.ttf'), weight: 400, style: 'normal' },
    { name: 'IBM Plex Sans', data: font('IBMPlexSans-SemiBold.ttf'), weight: 600, style: 'normal' },
    { name: 'IBM Plex Mono', data: font('IBMPlexMono-Regular.ttf'), weight: 400, style: 'normal' },
  ];
  return plexFonts;
}

// Per-section identity. Each catalog section gets a distinct accent so a page's
// share card reads as part of its family at a glance. Falls back to the brand
// violet for anything unmapped.
const SECTIONS = {
  main: { label: 'Platform', accent: '#8b5cf6' },
  build: { label: 'Build', accent: '#06b6d4' },
  labs: { label: 'Labs', accent: '#ec4899' },
  crypto: { label: 'Crypto', accent: '#4ade80' },
  'agent-tools': { label: 'Agent Tools', accent: '#14b8a6' },
  account: { label: 'Account', accent: '#60a5fa' },
  learn: { label: 'Learn', accent: '#fb923c' },
  blog: { label: 'Blog', accent: '#a78bfa' },
  legal: { label: 'Legal', accent: '#94a3b8' },
  machine: { label: 'Reference', accent: '#9ca3af' },
};
const DEFAULT_SECTION = { label: 'three.ws', accent: '#8b5cf6' };

function sectionFor(id) {
  return SECTIONS[String(id || '').toLowerCase()] || DEFAULT_SECTION;
}

function clamp(s, n) {
  s = String(s || '').trim();
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function card({ title, desc, section, route, accent }) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '70px 76px',
        background: `radial-gradient(115% 115% at 82% 8%, ${accent}26 0%, #0a0a0f 46%, #050507 100%)`,
        color: 'white',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      },
      children: [
        // faint engineering grid overlay
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              backgroundImage:
                'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
              backgroundSize: '52px 52px',
            },
          },
        },
        // top row: brand wordmark + section pill
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', alignItems: 'baseline' },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: 30, fontWeight: 800, letterSpacing: -1, color: '#f5f5f7' },
                        children: 'three.ws',
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: 30, fontWeight: 800, letterSpacing: -1, color: accent, marginLeft: 4 },
                        children: '.',
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    fontSize: 22,
                    fontWeight: 700,
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                    color: accent,
                    padding: '10px 22px',
                    borderRadius: 999,
                    background: `${accent}1f`,
                    border: `1px solid ${accent}59`,
                  },
                  children: section.label,
                },
              },
            ],
          },
        },
        // middle: title + description
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column' },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: title.length > 22 ? 76 : 92,
                    fontWeight: 900,
                    letterSpacing: -3,
                    lineHeight: 1.02,
                    color: '#ffffff',
                  },
                  children: title,
                },
              },
              desc
                ? {
                    type: 'div',
                    props: {
                      style: {
                        fontSize: 32,
                        fontWeight: 400,
                        lineHeight: 1.3,
                        marginTop: 26,
                        maxWidth: 980,
                        color: 'rgba(235,235,245,0.62)',
                      },
                      children: desc,
                    },
                  }
                : { type: 'div', props: { children: '' } },
            ],
          },
        },
        // bottom: route + tagline
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    fontSize: 24,
                    fontWeight: 600,
                    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                    color: 'rgba(235,235,245,0.5)',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { width: 10, height: 10, borderRadius: 10, background: accent, marginRight: 14 },
                      },
                    },
                    { type: 'div', props: { children: `three.ws${route}` } },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 24, fontWeight: 500, color: 'rgba(235,235,245,0.4)' },
                  children: 'Give your AI a body.',
                },
              },
            ],
          },
        },
      ],
    },
  };
}

// Light Carbon-styled card (?v=carbon) for surfaces shared into the IBM
// ecosystem (IBM Community posts, watsonx content). IBM Plex type, IBM blue
// (#0f62fe), Carbon gray text ramp, sharp geometry — deliberately NO IBM logo
// or trademark: the only IBM reference is the factual "Built on IBM
// watsonx.ai" line, the framing docs/ibm.md permits.
function carbonCard({ title, desc, section, route }) {
  const blue = '#0f62fe';
  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 76px 58px',
        background: '#ffffff',
        color: '#161616',
        fontFamily: '"IBM Plex Sans"',
      },
      children: [
        // top rule — Carbon's signature blue bar
        {
          type: 'div',
          props: {
            style: { position: 'absolute', top: 0, left: 0, right: 0, height: 10, display: 'flex', background: blue },
          },
        },
        // geometric accent, top-right: quarter-circle + solid/outlined squares
        {
          type: 'div',
          props: {
            style: { position: 'absolute', top: 74, right: 76, display: 'flex', alignItems: 'flex-start' },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    width: 72,
                    height: 72,
                    background: '#d0e2ff',
                    borderRadius: '0 0 0 72px',
                    marginRight: 16,
                  },
                },
              },
              { type: 'div', props: { style: { width: 72, height: 72, background: blue, marginRight: 16 } } },
              { type: 'div', props: { style: { width: 72, height: 72, border: `3px solid ${blue}` } } },
            ],
          },
        },
        // top row: wordmark + section tag
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center' },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', alignItems: 'baseline' },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: 30, fontWeight: 600, letterSpacing: -0.5, color: '#161616' },
                        children: 'three.ws',
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: 30, fontWeight: 600, color: blue, marginLeft: 3 },
                        children: '.',
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    fontSize: 20,
                    fontWeight: 600,
                    color: '#0043ce',
                    padding: '6px 14px',
                    marginLeft: 26,
                    borderRadius: 4,
                    background: '#d0e2ff',
                  },
                  children: section.label,
                },
              },
            ],
          },
        },
        // middle: title + description, Plex gray ramp
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', maxWidth: 980 },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: title.length > 22 ? 68 : 84,
                    fontWeight: 600,
                    letterSpacing: -1.5,
                    lineHeight: 1.06,
                    color: '#161616',
                  },
                  children: title,
                },
              },
              desc
                ? {
                    type: 'div',
                    props: {
                      style: {
                        fontSize: 30,
                        fontWeight: 400,
                        lineHeight: 1.35,
                        marginTop: 24,
                        color: '#525252',
                      },
                      children: desc,
                    },
                  }
                : { type: 'div', props: { children: '' } },
            ],
          },
        },
        // bottom: route + factual watsonx line
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    fontSize: 23,
                    fontFamily: '"IBM Plex Mono"',
                    color: '#525252',
                  },
                  children: [
                    { type: 'div', props: { style: { width: 12, height: 12, background: blue, marginRight: 14 } } },
                    { type: 'div', props: { children: `three.ws${route}` } },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 23, fontWeight: 600, color: blue },
                  children: 'Built on IBM watsonx.ai',
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function imageResponse(node, fonts) {
  return new ImageResponse(node, {
    width: WIDTH,
    height: HEIGHT,
    ...(fonts ? { fonts } : {}),
    headers: {
      'cache-control': 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400',
    },
  });
}

// Web Response (from @vercel/og) → Node ServerResponse. Headers first, then body.
async function sendImage(res, response) {
  for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
  const ab = await response.arrayBuffer();
  res.statusCode = response.status;
  res.end(Buffer.from(ab));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://x');
  const section = sectionFor(url.searchParams.get('s'));
  const accent = section.accent;
  const title = clamp(url.searchParams.get('t') || 'three.ws', 60);
  const desc = clamp(url.searchParams.get('d') || '', 140);
  const variant = String(url.searchParams.get('v') || '').toLowerCase();
  let route = (url.searchParams.get('p') || '/').trim();
  if (!route.startsWith('/')) route = `/${route}`;
  route = clamp(route, 42);

  try {
    if (variant === 'carbon') {
      await sendImage(res, imageResponse(carbonCard({ title, desc, section, route }), loadPlexFonts()));
    } else {
      await sendImage(res, imageResponse(card({ title, desc, section, route, accent })));
    }
  } catch (err) {
    // Never fail open to a broken-image box — render the coin-agnostic brand
    // card so the preview still looks intentional.
    console.error('[page-og] render failed:', err?.message || err);
    res.statusCode = 200;
    await sendImage(
      res,
      imageResponse(
        card({
          title: 'three.ws',
          desc: 'Give your AI a body. Build, embed, monetize, and trade autonomous 3D agents.',
          section: DEFAULT_SECTION,
          route: '/',
          accent: DEFAULT_SECTION.accent,
        }),
      ),
    );
  }
}
