import type { PageTypographyRecipe } from "./pageTypography";

const n = (value: number) => Number(value.toFixed(3));
const px = (value: number) => `${n(value)}px`;
const unit = (value: number) => `calc(${n(value)} * var(--u))`;
function withAlpha(hex: string, alpha: number) {
  const [red, green, blue] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export const KAGE_TYPOGRAPHY: PageTypographyRecipe = {
  "headingFonts": [
    {
      "value": "onest",
      "label": "Onest",
      "stack": "'Onest', system-ui, -apple-system, 'Helvetica Neue', sans-serif"
    },
    {
      "value": "instrument-serif",
      "label": "Instrument Serif",
      "stack": "\"Instrument Serif\", Georgia, serif",
      "google": "Instrument+Serif"
    },
    {
      "value": "newsreader",
      "label": "Newsreader",
      "stack": "\"Newsreader\", Georgia, serif",
      "google": "Newsreader:wght@200..700"
    },
    {
      "value": "geist",
      "label": "Geist",
      "stack": "\"Geist\", system-ui, -apple-system, \"Segoe UI\", Helvetica, Arial, sans-serif",
      "google": "Geist:wght@100..900"
    }
  ],
  "bodyFonts": [
    {
      "value": "onest",
      "label": "Onest",
      "stack": "'Onest', system-ui, -apple-system, 'Helvetica Neue', sans-serif"
    },
    {
      "value": "geist",
      "label": "Geist",
      "stack": "\"Geist\", system-ui, -apple-system, \"Segoe UI\", Helvetica, Arial, sans-serif",
      "google": "Geist:wght@100..900"
    },
    {
      "value": "newsreader",
      "label": "Newsreader",
      "stack": "\"Newsreader\", Georgia, serif",
      "google": "Newsreader:wght@200..700"
    },
    {
      "value": "instrument-serif",
      "label": "Instrument Serif",
      "stack": "\"Instrument Serif\", Georgia, serif",
      "google": "Instrument+Serif"
    }
  ],
  "headingWeights": [
    "400",
    "500",
    "600",
    "700"
  ],
  "headingWeight": "400",
  "bodyWeights": [
    "300",
    "400",
    "500",
    "600"
  ],
  "bodyWeight": "300",
  "primaryColor": "#e0231c",
  "headingSize": [
    30,
    46,
    72
  ],
  "bodySize": [
    13,
    17,
    24
  ],
  "headingLetterSpacing": [
    -0.06,
    -0.012,
    0.12
  ],
  css: (type) => `
:root {
  --vermilion: ${type.primary};
  --ember: ${type.retone("#ff5a3c")};
}
body { font-family: ${type.body}; }
body, .body, .body-lg, .num { font-weight: ${type.bodyWeight}; }
h1:not(.jp), h2:not(.jp), h3:not(.jp), .display:not(.jp) {
  font-family: ${type.heading};
  font-weight: ${type.headingWeight};
}
.display { letter-spacing: ${type.headingLetterSpacing}em; }
.h-hero { font-size: clamp(26px, 3.05vw, ${px(type.headingSize)}); }
.h-sec { font-size: clamp(30px, 4vw, ${px(type.headingSize * 60 / 46)}); }
.body-lg { font-size: clamp(14px, 1.02vw, ${px(type.bodySize)}); }
.body { font-size: ${px(Math.max(11, type.bodySize - 3))}; }
`
};

export const SYLVA_TYPOGRAPHY: PageTypographyRecipe = {
  "headingFonts": [
    {
      "value": "lexend",
      "label": "Lexend",
      "stack": "'Lexend', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    },
    {
      "value": "instrument-serif",
      "label": "Instrument Serif",
      "stack": "\"Instrument Serif\", Georgia, serif",
      "google": "Instrument+Serif"
    },
    {
      "value": "newsreader",
      "label": "Newsreader",
      "stack": "\"Newsreader\", Georgia, serif",
      "google": "Newsreader:wght@200..700"
    },
    {
      "value": "geist",
      "label": "Geist",
      "stack": "\"Geist\", system-ui, -apple-system, \"Segoe UI\", Helvetica, Arial, sans-serif",
      "google": "Geist:wght@100..900"
    }
  ],
  "bodyFonts": [
    {
      "value": "lexend",
      "label": "Lexend",
      "stack": "'Lexend', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    },
    {
      "value": "geist",
      "label": "Geist",
      "stack": "\"Geist\", system-ui, -apple-system, \"Segoe UI\", Helvetica, Arial, sans-serif",
      "google": "Geist:wght@100..900"
    },
    {
      "value": "newsreader",
      "label": "Newsreader",
      "stack": "\"Newsreader\", Georgia, serif",
      "google": "Newsreader:wght@200..700"
    },
    {
      "value": "instrument-serif",
      "label": "Instrument Serif",
      "stack": "\"Instrument Serif\", Georgia, serif",
      "google": "Instrument+Serif"
    }
  ],
  "headingWeights": [
    "200",
    "300",
    "400",
    "500",
    "600"
  ],
  "headingWeight": "300",
  "bodyWeights": [
    "200",
    "300",
    "400",
    "500"
  ],
  "bodyWeight": "300",
  "primaryColor": "#ffffff",
  "headingSize": [
    40,
    63,
    92
  ],
  "bodySize": [
    12,
    16.5,
    24
  ],
  "headingLetterSpacing": [
    -0.06,
    -0.006,
    0.12
  ],
  css: (type) => `
:root {
  --ink: ${type.primary};
  --ink-soft: ${withAlpha(type.primary, 0.62)};
  --ink-faint: ${withAlpha(type.primary, 0.44)};
}
body { font-family: ${type.body}; font-weight: ${type.bodyWeight}; }
.headline, .ghost {
  font-family: ${type.heading};
}
.headline {
  font-weight: ${type.headingWeight};
  font-size: ${unit(type.headingSize)};
  line-height: ${unit(type.headingSize * 65 / 63)};
  letter-spacing: ${type.headingLetterSpacing}em;
}
.lede {
  font-weight: ${type.bodyWeight};
  font-size: ${unit(type.bodySize)};
  line-height: ${unit(type.bodySize * 22 / 16.5)};
}
@media (max-width: 900px) {
  .headline {
    font-size: ${unit(type.headingSize * 62 / 63)};
    line-height: ${unit(type.headingSize * 66 / 63)};
  }
  .lede {
    font-size: ${unit(type.bodySize * 19 / 16.5)};
    line-height: ${unit(type.bodySize * 27 / 16.5)};
  }
}
`
};

export const COMPLETE_SHELF_TYPOGRAPHY: PageTypographyRecipe = {
  "headingFonts": [
    {
      "value": "iowan-old-style",
      "label": "Iowan Old Style",
      "stack": "\"Iowan Old Style\", Baskerville, \"Times New Roman\", serif"
    },
    {
      "value": "instrument-serif",
      "label": "Instrument Serif",
      "stack": "\"Instrument Serif\", Georgia, serif",
      "google": "Instrument+Serif"
    },
    {
      "value": "newsreader",
      "label": "Newsreader",
      "stack": "\"Newsreader\", Georgia, serif",
      "google": "Newsreader:wght@200..700"
    },
    {
      "value": "geist",
      "label": "Geist",
      "stack": "\"Geist\", system-ui, -apple-system, \"Segoe UI\", Helvetica, Arial, sans-serif",
      "google": "Geist:wght@100..900"
    }
  ],
  "bodyFonts": [
    {
      "value": "inter",
      "label": "Inter",
      "stack": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
    },
    {
      "value": "geist",
      "label": "Geist",
      "stack": "\"Geist\", system-ui, -apple-system, \"Segoe UI\", Helvetica, Arial, sans-serif",
      "google": "Geist:wght@100..900"
    },
    {
      "value": "newsreader",
      "label": "Newsreader",
      "stack": "\"Newsreader\", Georgia, serif",
      "google": "Newsreader:wght@200..700"
    },
    {
      "value": "instrument-serif",
      "label": "Instrument Serif",
      "stack": "\"Instrument Serif\", Georgia, serif",
      "google": "Instrument+Serif"
    }
  ],
  "headingWeights": [
    "400",
    "500",
    "600"
  ],
  "headingWeight": "400",
  "bodyWeights": [
    "400",
    "500",
    "600"
  ],
  "bodyWeight": "400",
  "primaryColor": "#c87046",
  "headingSize": [
    32,
    60,
    88
  ],
  "bodySize": [
    10,
    12,
    18
  ],
  "headingLetterSpacing": [
    -0.1,
    -0.055,
    0.08
  ],
  css: (type) => `
:root { --accent: ${type.primary}; }
body { font-family: ${type.body}; font-weight: ${type.bodyWeight}; }
.selection__title, .detail-title, .editorial-identity strong, .page-status strong {
  font-family: ${type.heading};
  font-weight: ${type.headingWeight};
}
.selection__title {
  font-size: clamp(32px, 3.4vw, ${px(type.headingSize)});
  letter-spacing: ${type.headingLetterSpacing}em;
}
.detail-title {
  font-size: clamp(56px, 6.3vw, ${px(type.headingSize * 107.2 / 60)});
  letter-spacing: ${n(type.headingLetterSpacing - 0.01)}em;
}
.selection__note { font-size: ${px(type.bodySize)}; font-weight: ${type.bodyWeight}; }
.detail-deck { font-family: ${type.body}; font-weight: ${type.bodyWeight}; }
@media (max-width: 880px) {
  .selection__title { font-size: clamp(32px, 9vw, ${px(type.headingSize * 56 / 60)}); }
  .detail-title { font-size: clamp(48px, 14vw, ${px(type.headingSize * 80 / 60)}); }
}
@media (max-width: 560px) {
  .selection__title { font-size: ${px(type.headingSize * 32 / 60)}; }
}
`
};

export const BESTSELLERS_TYPOGRAPHY: PageTypographyRecipe = {
  "headingFonts": [
    {
      "value": "iowan-old-style",
      "label": "Iowan Old Style",
      "stack": "\"Iowan Old Style\", Baskerville, \"Times New Roman\", serif"
    },
    {
      "value": "instrument-serif",
      "label": "Instrument Serif",
      "stack": "\"Instrument Serif\", Georgia, serif",
      "google": "Instrument+Serif"
    },
    {
      "value": "newsreader",
      "label": "Newsreader",
      "stack": "\"Newsreader\", Georgia, serif",
      "google": "Newsreader:wght@200..700"
    },
    {
      "value": "geist",
      "label": "Geist",
      "stack": "\"Geist\", system-ui, -apple-system, \"Segoe UI\", Helvetica, Arial, sans-serif",
      "google": "Geist:wght@100..900"
    }
  ],
  "bodyFonts": [
    {
      "value": "iowan-old-style",
      "label": "Iowan Old Style",
      "stack": "\"Iowan Old Style\", Baskerville, \"Times New Roman\", serif"
    },
    {
      "value": "geist",
      "label": "Geist",
      "stack": "\"Geist\", system-ui, -apple-system, \"Segoe UI\", Helvetica, Arial, sans-serif",
      "google": "Geist:wght@100..900"
    },
    {
      "value": "newsreader",
      "label": "Newsreader",
      "stack": "\"Newsreader\", Georgia, serif",
      "google": "Newsreader:wght@200..700"
    },
    {
      "value": "instrument-serif",
      "label": "Instrument Serif",
      "stack": "\"Instrument Serif\", Georgia, serif",
      "google": "Instrument+Serif"
    }
  ],
  "headingWeights": [
    "400",
    "500",
    "600",
    "700"
  ],
  "headingWeight": "500",
  "bodyWeights": [
    "400",
    "500",
    "600",
    "700"
  ],
  "bodyWeight": "400",
  "primaryColor": "#c3a47b",
  "headingSize": [
    184,
    325,
    420
  ],
  "bodySize": [
    12,
    17,
    24
  ],
  "headingLetterSpacing": [
    -0.12,
    -0.085,
    0.08
  ],
  css: (type) => `
:root {
  --pink: ${type.primary};
  --pink-bright: ${type.retone("#dbc39c")};
  --periwinkle: ${type.retone("#b7976c")};
}
body { font-family: ${type.body}; font-weight: ${type.bodyWeight}; }
.brand, .hero-word, .detail-title, .cover-title {
  font-family: ${type.heading};
  font-weight: ${type.headingWeight};
}
.hero-word {
  font-size: clamp(184px, 22vw, ${px(type.headingSize)});
  letter-spacing: ${type.headingLetterSpacing}em;
}
.detail-title {
  font-size: clamp(52px, 5.7vw, ${px(type.headingSize * 82 / 325)});
  letter-spacing: ${n(type.headingLetterSpacing + 0.03)}em;
}
.detail-description { font-size: clamp(12px, 1.28vw, ${px(type.bodySize)}); font-weight: ${type.bodyWeight}; }
@media (max-width: 900px) {
  .hero-word { font-size: clamp(128px, 28vw, ${px(type.headingSize * 230 / 325)}); }
  .detail-title { font-size: clamp(48px, 10vw, ${px(type.headingSize * 70 / 325)}); }
}
@media (max-width: 560px) {
  .hero-word { font-size: calc(${n(type.headingSize / 325)} * 38vw); }
}
`
};
