import { useMemo, type CSSProperties } from "react";
import firstStudiesSource from "./sources/text-on-a-path.html?raw";
import secondStudiesSource from "./sources/text-on-a-path-ii.html?raw";

type StudyDefinition = {
  source: string;
  index: number;
  title: string;
  layout: "cards" | "figures";
  presentation?: "dark-frameless";
  renderDensity?: {
    minimum: number;
    maximum: number;
  };
};

export type TextPathStudyProps = {
  mode?: "dark" | "light";
  scale?: number;
  opacity?: number;
  hue?: number;
  saturation?: number;
  brightness?: number;
  className?: string;
  style?: CSSProperties;
};

export type TextPathStudiesVariant =
  | "globe-study"
  | "outline-typeflow"
  | "morphing-glyph-cloud"
  | "cloth-study"
  | "ripple-study"
  | "ball-study";

export type TextPathStudiesProps = TextPathStudyProps & {
  variant?: TextPathStudiesVariant;
};

export const TEXT_PATH_STUDY_DEFAULTS = {
  mode: "dark",
  scale: 1,
  opacity: 1,
  hue: 0,
  saturation: 1,
  brightness: 1,
} as const;

const STUDIES = {
  globe: { source: secondStudiesSource, index: 1, title: "Globe", layout: "figures" },
  outlineTypeflow: {
    source: secondStudiesSource,
    index: 2,
    title: "Outline Typeflow",
    layout: "figures",
    renderDensity: { minimum: 2, maximum: 2.5 },
  },
  morphingGlyphCloud: {
    source: secondStudiesSource,
    index: 3,
    title: "Morphing Glyph Cloud",
    layout: "figures",
    renderDensity: { minimum: 2, maximum: 2.5 },
  },
  cloth: { source: secondStudiesSource, index: 6, title: "Cloth", layout: "figures" },
  ripple: {
    source: firstStudiesSource,
    index: 2,
    title: "Ripple",
    layout: "cards",
    presentation: "dark-frameless",
  },
  ball: {
    source: firstStudiesSource,
    index: 3,
    title: "Ball",
    layout: "cards",
    presentation: "dark-frameless",
  },
} as const satisfies Record<string, StudyDefinition>;

const TEXT_PATH_VARIANTS: Record<TextPathStudiesVariant, StudyDefinition> = {
  "globe-study": STUDIES.globe,
  "outline-typeflow": STUDIES.outlineTypeflow,
  "morphing-glyph-cloud": STUDIES.morphingGlyphCloud,
  "cloth-study": STUDIES.cloth,
  "ripple-study": STUDIES.ripple,
  "ball-study": STUDIES.ball,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function focusStyles(definition: StudyDefinition, mode: "dark" | "light") {
  const selected = definition.index;
  const surface = mode === "light" ? "#f3f5f8" : "#08090a";
  const themeStyles = mode === "light"
    ? `
      :root {
        color-scheme: light;
        --bg: #f3f5f8;
        --line: rgba(20, 24, 32, .055);
        --line-strong: rgba(20, 24, 32, .10);
        --fig: rgba(20, 24, 32, .42);
        --title: #171922;
        --copy: rgba(20, 24, 32, .62);
      }
    `
    : ":root { color-scheme: dark; }";
  const cardPresentationStyles = definition.presentation === "dark-frameless"
    ? `
      .stage, .row {
        background: ${surface} !important;
        overflow: visible !important;
      }
      .card:nth-child(${selected}) {
        width: 100% !important;
        height: 100% !important;
        aspect-ratio: auto !important;
        border-radius: 0 !important;
        overflow: visible !important;
        background: transparent !important;
        isolation: auto !important;
      }
    `
    : `
      .card:nth-child(${selected}) {
        width: min(100cqw, 100cqh) !important;
        height: min(100cqw, 100cqh) !important;
      }
    `;
  const layoutStyles = definition.layout === "figures"
    ? `
      .grid {
        display: block !important;
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
      }
      .fig { display: none !important; }
      .fig:nth-child(${selected}) {
        display: flex !important;
        width: 100% !important;
        height: 100% !important;
        padding: 0 !important;
      }
      .fig::before, .fig::after, .fignum, .fig h3, .fig p { display: none !important; }
      .art {
        display: flex !important;
        width: 100% !important;
        height: 100% !important;
        max-height: none !important;
        margin: 0 !important;
        align-items: center !important;
        justify-content: center !important;
      }
      .plate {
        width: min(100cqw, 100cqh) !important;
        height: min(100cqw, 100cqh) !important;
      }
    `
    : `
      .stage {
        width: 100% !important;
        height: 100% !important;
        padding: 0 !important;
        overflow: hidden !important;
        align-items: center !important;
        justify-content: center !important;
      }
      .row {
        display: flex !important;
        width: 100% !important;
        height: 100% !important;
        padding: 0 !important;
        align-items: center !important;
        justify-content: center !important;
      }
      .card { display: none !important; }
      .card:nth-child(${selected}) {
        display: block !important;
      }
      .card figcaption { display: none !important; }
      ${cardPresentationStyles}
    `;

  return `<style id="threeui-study-focus">
    ${themeStyles}
    html, body, .frame {
      width: 100% !important;
      height: 100% !important;
      overflow: hidden !important;
    }
    body { margin: 0 !important; background: ${surface} !important; }
    .frame { padding: 0 !important; background: ${surface} !important; }
    header { display: none !important; }
    ${layoutStyles}
  </style>`;
}

const AUTHORED_SURFACE_DENSITY = "var dpr = Math.min(1.5, window.devicePixelRatio || 1);";
const AUTHORED_CARD_INK = "var INK  = '20,19,16';";
const AUTHORED_FIGURE_INK = "var INK  = '226,228,233';";

function replaceRequired(source: string, authored: string, focused: string) {
  if (!source.includes(authored)) {
    throw new Error(`Text path source adapter could not find: ${authored}`);
  }
  return source.replace(authored, focused);
}

function framelessCardSource(source: string, mode: "dark" | "light") {
  const replacements = [
    [AUTHORED_CARD_INK, mode === "light" ? AUTHORED_CARD_INK : "var INK  = '238,240,244';"],
    [
      "      var cell = s.w * 0.02860;\n      var fs   = cell * 1.10;",
      "      var size = Math.min(s.w, s.h);\n      var cell = size * 0.02860;\n      var fs   = cell * 1.10;",
    ],
    ["      var speed = s.w * 1.20;", "      var speed = size * 1.20;"],
    [
      "      var fs = s.w*FS;\n      var now = performance.now();\n      var hitR = s.w*0.055, hit = hitR*hitR;",
      "      var size = Math.min(s.w, s.h);\n      var fs = size*FS;\n      var now = performance.now();\n      var hitR = size*0.055, hit = hitR*hitR;",
    ],
    [
      "          vx: (dx/d)*s.w*(0.10 + Math.random()*0.16) + (Math.random()-0.5)*s.w*0.05,\n          vy: (dy/d)*s.w*0.08 - s.w*(0.04 + Math.random()*0.10),",
      "          vx: (dx/d)*size*(0.10 + Math.random()*0.16) + (Math.random()-0.5)*size*0.05,\n          vy: (dy/d)*size*0.08 - size*(0.04 + Math.random()*0.10),",
    ],
    [
      "      var cx = s.w/2, cy = s.h/2 + s.w*CYOFF;\n      var R  = s.w*RR;\n      var fs = s.w*FS;",
      "      var size = Math.min(s.w, s.h);\n      var cx = s.w/2, cy = s.h/2 + size*CYOFF;\n      var R  = size*RR;\n      var fs = size*FS;",
    ],
    ["      var g = s.w*0.80;", "      var g = size*0.80;"],
  ] as const;

  return replacements.reduce(
    (adapted, [authored, focused]) => replaceRequired(adapted, authored, focused),
    source,
  );
}

function focusedDocument(definition: StudyDefinition, mode: "dark" | "light") {
  const presentedSource = definition.presentation === "dark-frameless"
    ? framelessCardSource(definition.source, mode)
    : mode === "light"
      ? replaceRequired(definition.source, AUTHORED_FIGURE_INK, "var INK  = '38,40,48';")
      : definition.source;
  const source = definition.renderDensity
    ? presentedSource.replace(
        AUTHORED_SURFACE_DENSITY,
        `var dpr = Math.min(${definition.renderDensity.maximum}, Math.max(${definition.renderDensity.minimum}, window.devicePixelRatio || 1));`,
      )
    : presentedSource;

  return source
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${definition.title} — ThreeUI</title>`)
    .replace("</head>", `${focusStyles(definition, mode)}\n</head>`);
}

function TextPathStudy({
  definition,
  mode = TEXT_PATH_STUDY_DEFAULTS.mode,
  scale = TEXT_PATH_STUDY_DEFAULTS.scale,
  opacity = TEXT_PATH_STUDY_DEFAULTS.opacity,
  hue = TEXT_PATH_STUDY_DEFAULTS.hue,
  saturation = TEXT_PATH_STUDY_DEFAULTS.saturation,
  brightness = TEXT_PATH_STUDY_DEFAULTS.brightness,
  className,
  style,
}: TextPathStudyProps & { definition: StudyDefinition }) {
  const safeMode = mode === "light" ? "light" : "dark";
  const document = useMemo(() => focusedDocument(definition, safeMode), [definition, safeMode]);
  const boundedScale = clamp(scale, 0.65, 1.5);
  const boundedOpacity = clamp(opacity, 0.1, 1);
  const boundedHue = clamp(hue, -180, 180);
  const boundedSaturation = clamp(saturation, 0, 2);
  const boundedBrightness = clamp(brightness, 0.4, 1.8);
  const filter = boundedHue === 0 && boundedSaturation === 1 && boundedBrightness === 1
    ? undefined
    : `hue-rotate(${boundedHue}deg) saturate(${boundedSaturation}) brightness(${boundedBrightness})`;

  return (
    <div
      className={["text-path-study", `text-path-study--${safeMode}`, className].filter(Boolean).join(" ")}
      data-mode={safeMode}
      style={{ opacity: boundedOpacity, filter, ...style }}
    >
      <iframe
        className="text-path-study-frame"
        data-mode={safeMode}
        title={`${definition.title} interactive canvas study`}
        sandbox="allow-scripts"
        srcDoc={document}
        style={{ transform: boundedScale === 1 ? undefined : `scale(${boundedScale})` }}
      />
    </div>
  );
}

export function TextPathStudies({ variant = "globe-study", ...props }: TextPathStudiesProps = {}) {
  return <TextPathStudy definition={TEXT_PATH_VARIANTS[variant]} {...props} />;
}

export function GlobeStudy(props: TextPathStudyProps = {}) {
  return <TextPathStudy definition={STUDIES.globe} {...props} />;
}

export function OutlineTypeflow(props: TextPathStudyProps = {}) {
  return <TextPathStudy definition={STUDIES.outlineTypeflow} {...props} />;
}

export function MorphingGlyphCloud(props: TextPathStudyProps = {}) {
  return <TextPathStudy definition={STUDIES.morphingGlyphCloud} {...props} />;
}

export function ClothStudy(props: TextPathStudyProps = {}) {
  return <TextPathStudy definition={STUDIES.cloth} {...props} />;
}

export function RippleStudy(props: TextPathStudyProps = {}) {
  return <TextPathStudy definition={STUDIES.ripple} {...props} />;
}

export function BallStudy(props: TextPathStudyProps = {}) {
  return <TextPathStudy definition={STUDIES.ball} {...props} />;
}
