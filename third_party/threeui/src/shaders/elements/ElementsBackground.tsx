import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import elementalMarksSource from "./sources/elemental-marks.html?raw";

export const ELEMENT_VARIANTS = ["water", "lightning", "fire"] as const;

export type ElementVariant = (typeof ELEMENT_VARIANTS)[number];

export type ElementsBackgroundProps = {
  variant?: ElementVariant;
  speed?: number;
  size?: number;
  particleAmount?: number;
  opacity?: number;
  hue?: number;
  saturation?: number;
  brightness?: number;
  className?: string;
  style?: CSSProperties;
};

export const ELEMENTS_DEFAULTS = {
  variant: "water" as ElementVariant,
  speed: 1,
  size: 1,
  particleAmount: 1,
  opacity: 1,
  hue: 0,
  saturation: 1,
  brightness: 1,
} as const;

const VARIANT_LABELS: Record<ElementVariant, string> = {
  water: "Water",
  lightning: "Lightning",
  fire: "Fire",
};

const BASE_ZOOM: Record<ElementVariant, number> = {
  water: 1.56,
  lightning: 1.66,
  fire: 1.82,
};

const SOURCE_ZOOM: Record<ElementVariant, string> = {
  water: "1.06",
  lightning: "1.10",
  fire: "1.16",
};

const BASE_PARTICLES: Record<ElementVariant, number> = {
  water: 160,
  lightning: 360,
  fire: 560,
};

const SOURCE_PARTICLES: Record<ElementVariant, number> = {
  water: 160,
  lightning: 240,
  fire: 420,
};

const DETAIL_PATCHES = [
  [
    "const SDF_SIZE = 512;\nconst SDF_SPREAD = 128;",
    "const SDF_SIZE = 768;\nconst SDF_SPREAD = 192;",
  ],
  [
    "const DPR = Math.min(window.devicePixelRatio || 1, 1.75);",
    "const DPR = Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2.25);",
  ],
  [
    "sim: false, zoom: 1.16, shift: [0, -0.04],",
    "sim: false, zoom: 1.16, shift: [0, -0.11],",
  ],
  [
    `  float inside = smoothstep(0.005, -0.005, d);
  vec3 body = vec3(0.055, 0.06, 0.10) + big * vec3(0.55, 0.58, 0.85);
  col = mix(col, body, inside);
  float rim = exp(-abs(d) / 0.012) * 0.5;`,
    `  float inside = smoothstep(0.0025, -0.0025, d);
  vec3 body = vec3(0.055, 0.06, 0.10) + big * vec3(0.55, 0.58, 0.85);
  col = mix(col, body, inside);
  float rim = exp(-abs(d) / 0.0075) * 0.56;`,
  ],
  [
    `  // fBm zigzag arcs crawling the contour
  float fade = edgeFade(vUv);
  for (int i = 0; i < 3; i++){
    float fi = float(i);
    float n  = fbm(pp * mix(3.0, 8.0, fi / 2.0) + vec2(t * (1.2 + fi * 0.9), fi * 19.3)) - 0.5;
    float e  = abs(d + n * 0.11);
    float fl = hash21(vec2(floor(t * (6.0 + fi * 3.0)), fi));
    fl = mix(0.15, 1.0, smoothstep(0.25, 0.95, fl));
    float bolt = pow(0.0042 * pb / (e + 0.0022), 1.35) * fl;
    bolt = min(bolt, 6.0);
    col += bolt * mix(vec3(0.38, 0.42, 1.0), vec3(0.92, 0.9, 1.0), fi / 2.0) * fade;
  }
  // tight white core arc
  float n0 = fbm(pp * 5.0 + vec2(t * 2.4, 7.7)) - 0.5;
  float e0 = abs(d + n0 * 0.10);
  float corefl = mix(0.25, 1.15, hash21(vec2(floor(t * 9.0), 11.0)));
  col += min(pow(0.0026 * pb / (e0 + 0.0016), 1.6), 8.0) * corefl * vec3(1.0) * fade;`,
    `  // Layered contour arcs: broad current, hairline filaments, and short-lived forks.
  float fade = edgeFade(vUv);
  for (int i = 0; i < 5; i++){
    float fi = float(i);
    float layer = fi / 4.0;
    float coarse = fbm(pp * mix(4.0, 13.0, layer) + vec2(t * (1.3 + fi * 0.78), fi * 17.7)) - 0.5;
    float detail = fbm(pp * mix(17.0, 31.0, layer) + vec2(-t * (2.9 + fi * 0.55), fi * 31.7)) - 0.5;
    float n = coarse * mix(0.82, 0.58, layer) + detail * mix(0.18, 0.42, layer);
    float e = abs(d + n * mix(0.09, 0.038, layer));
    float fl = hash21(vec2(floor(t * (7.0 + fi * 3.4)), fi));
    fl = mix(0.12, 1.0, smoothstep(0.22, 0.94, fl));
    float width = mix(0.0034, 0.0012, layer);
    float bolt = pow(width * pb / (e + mix(0.0018, 0.0008, layer)), mix(1.42, 1.78, layer)) * fl;
    bolt = min(bolt, 7.0);
    col += bolt * mix(vec3(0.34, 0.39, 1.0), vec3(0.96, 0.94, 1.0), pow(layer, 0.75)) * fade;
  }

  // A white primary channel with a displaced secondary fork.
  float n0 = fbm(pp * 6.5 + vec2(t * 2.8, 7.7)) - 0.5;
  n0 += (fbm(pp * 23.0 + vec2(-t * 4.1, 18.2)) - 0.5) * 0.22;
  float e0 = abs(d + n0 * 0.075);
  float corefl = mix(0.22, 1.2, hash21(vec2(floor(t * 10.0), 11.0)));
  col += min(pow(0.00175 * pb / (e0 + 0.0009), 1.78), 9.0) * corefl * vec3(1.0) * fade;

  float branchNoise = fbm(pp * 16.0 + vec2(t * 3.7, -13.4)) - 0.5;
  float branchEdge = abs(d + n0 * 0.052 + branchNoise * 0.026);
  float branchLife = smoothstep(0.35, 0.92, hash21(vec2(floor(t * 13.0), 23.0)));
  col += min(pow(0.0011 * pb / (branchEdge + 0.00075), 1.72), 5.0)
       * branchLife * vec3(0.64, 0.70, 1.0) * fade;`,
  ],
  [
    `  // thin tongues: x-squashed scrolling fBm, advected progressively with
  // height so flames stay attached at the edge and lick upward
  float n1 = fbm(vec2(pp.x * 12.0,        pp.y * 3.0  - t * 2.1));
  float n2 = fbm(vec2(pp.x * 6.0 + 41.3,  pp.y * 1.7  - t * 1.25));
  float d0f = d0 + (hash21(vUv * 771.0 + t * 1.3) - 0.5) * 0.004;
  float rise = max(0.0, n1 * 1.15 + n2 * 0.65 - 0.5) * 1.3;  // many columns ~0, few run hot
  float adv  = smoothstep(-0.03, 0.22, d0f);     // 0 at the edge, grows above
  float lick = 0.30 * (1.0 + stoke * 0.8);
  vec2 offs = vec2((n2 - 0.5) * 0.05 + uWind * 0.05, -rise * lick * adv);
  float df = sdf(vUv + offs);
  df += (hash21(vUv * 997.0 + uTime) - 0.5) * 0.004;  // dither the 8-bit field

  float heat = clamp(1.0 - df / 0.07, 0.0, 1.0);
  heat *= mix(0.1, 1.0, upw);
  heat *= 1.0 - 0.45 * smoothstep(0.08, 0.26, d0f);  // gentle thinning with height
  float tongue = smoothstep(0.25, 0.70, heat);   // sharp separated licks
  float body   = pow(heat, 2.2) * 0.45;          // faint haze beneath them
  float f = max(tongue, body) * (0.95 + 0.25 * stoke);`,
    `  // Three frequency bands split the fire into attached tongues, fine wisps, and hot veins.
  float n1 = fbm(vec2(pp.x * 11.0,        pp.y * 3.2 - t * 2.2));
  float n2 = fbm(vec2(pp.x * 6.5 + 41.3,  pp.y * 1.8 - t * 1.3));
  float n3 = fbm(vec2(pp.x * 27.0 - t * 0.7, pp.y * 7.5 - t * 4.0));
  float d0f = d0 + (hash21(vUv * 771.0 + t * 1.3) - 0.5) * 0.0025;
  float rise = max(0.0, n1 * 0.98 + n2 * 0.54 + n3 * 0.38 - 0.58) * 1.48;
  float adv  = smoothstep(-0.025, 0.24, d0f);
  float lick = 0.31 * (1.0 + stoke * 0.82);
  vec2 offs = vec2((n2 - 0.5) * 0.042 + (n3 - 0.5) * 0.018 + uWind * 0.05, -rise * lick * adv);
  float df = sdf(vUv + offs);
  float micro = fbm(pp * vec2(34.0, 9.0) + vec2(t * 1.1, -t * 5.2));
  df += (micro - 0.5) * 0.011 * adv;
  df += (hash21(vUv * 997.0 + uTime) - 0.5) * 0.0025;

  float heat = clamp(1.0 - df / 0.064, 0.0, 1.0);
  heat *= mix(0.08, 1.0, upw);
  heat *= 1.0 - 0.52 * smoothstep(0.07, 0.27, d0f);
  heat *= 0.84 + n3 * 0.24;
  float tongue = smoothstep(0.29, 0.69, heat);
  float filament = smoothstep(0.58, 0.91, heat + (n3 - 0.5) * 0.20);
  float split = smoothstep(0.38, 0.82, n3) * smoothstep(0.015, 0.23, d0f);
  float body = pow(heat, 2.35) * 0.36;
  float f = max(max(tongue * (0.72 + 0.28 * n3), filament * split * 0.88), body)
          * (0.95 + 0.25 * stoke);`,
  ],
  [
    `  col += fireRamp(f * (1.05 - 0.4 * smoothstep(0.02, 0.25, d0)));  // white base, orange tips

  // white-hot mark with a warm halo, like paper mid-combustion
  float inside = smoothstep(0.004, -0.004, d0);
  float core   = smoothstep(0.0, -0.02, d0);`,
    `  col += fireRamp(f * (1.05 - 0.4 * smoothstep(0.02, 0.25, d0)));
  float vein = pow(clamp(1.0 - abs(df) / 0.026, 0.0, 1.0), 3.2)
             * smoothstep(0.55, 0.9, n3) * upw * (0.35 + 0.65 * adv);
  col += fireRamp(0.82) * vein * 0.34;

  // A crisp white-hot mark with a restrained warm halo.
  float inside = smoothstep(0.0025, -0.0025, d0);
  float core   = smoothstep(0.0, -0.016, d0);`,
  ],
  [
    `  col += exp(-max(d0, 0.0) / 0.035) * vec3(1.0, 0.55, 0.22) * 0.35 * (1.0 - inside * 0.9);
  col += exp(-max(d0, 0.0) / 0.12)  * vec3(0.55, 0.14, 0.03) * 0.35 * (0.6 + 0.4 * n2);`,
    `  col += exp(-max(d0, 0.0) / 0.026) * vec3(1.0, 0.55, 0.22) * 0.30 * (1.0 - inside * 0.92);
  col += exp(-max(d0, 0.0) / 0.09)  * vec3(0.55, 0.14, 0.03) * 0.28 * (0.55 + 0.45 * n2);`,
  ],
  [
    `count: 240, travel: 0.055, lifeMin: 0.3, lifeMax: 0.9, alongNormal: 1.0,
      wiggle: 0.015, sizeMin: 1.2, sizeMax: 2.6, sparse: 0.8,`,
    `count: 240, travel: 0.075, lifeMin: 0.28, lifeMax: 0.82, alongNormal: 0.92,
      wiggle: 0.022, sizeMin: 0.8, sizeMax: 2.0, sparse: 0.72,`,
  ],
  [
    `count: 420, travel: 0.30, lifeMin: 1.4, lifeMax: 3.0, alongNormal: 0.35,
      wiggle: 0.035, sizeMin: 1.6, sizeMax: 4.5, sparse: 0.55,`,
    `count: 420, travel: 0.34, lifeMin: 1.1, lifeMax: 2.7, alongNormal: 0.30,
      wiggle: 0.046, sizeMin: 0.9, sizeMax: 3.6, sparse: 0.42,`,
  ],
] as const;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function applyDetailPatches(source: string) {
  return DETAIL_PATCHES.reduce(
    (document, [original, enhanced]) => document.replace(original, enhanced),
    source,
  );
}

function buildFocusedDocument(variant: ElementVariant, size: number, particleAmount: number) {
  const zoom = BASE_ZOOM[variant] / clamp(size, 0.65, 1.5);
  const particleCount = Math.max(0, Math.round(BASE_PARTICLES[variant] * clamp(particleAmount, 0, 2)));
  const focusStyles = `<style data-elements-focus>
html, body, main { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #060708; }
header, .hint, .info, .kanji { display: none !important; }
main { display: block; }
.panel { display: none; }
.panel[data-fx="${variant}"] {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  opacity: 1;
  transform: none;
  animation: none;
}
.panel[data-fx="${variant}"] canvas { width: 100%; height: 100%; }
</style>`;
  const controls = `<script data-elements-controls>
(function () {
  var nativeNow = performance.now.bind(performance);
  var last = nativeNow();
  var virtual = last;
  var state = { speed: 1, paused: false };
  window.__ELEMENTS_PAUSED = false;
  performance.now = function () {
    var real = nativeNow();
    if (!state.paused) virtual += (real - last) * state.speed;
    last = real;
    return virtual;
  };
  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'elements-controls') return;
    var next = event.data.controls || {};
    if (Number.isFinite(next.speed)) state.speed = Math.max(0, Math.min(3, next.speed));
    state.paused = Boolean(next.paused);
    window.__ELEMENTS_PAUSED = state.paused;
  });
})();
</script>`;

  return applyDetailPatches(elementalMarksSource)
    .replace(/<link[^>]+fonts\.googleapis\.com[^>]*>/gi, "")
    .replace(/<link[^>]+fonts\.gstatic\.com[^>]*>/gi, "")
    .replace("</head>", `${focusStyles}${controls}</head>`)
    .replace(new RegExp(`count: ${SOURCE_PARTICLES[variant]}`), `count: ${particleCount}`)
    .replace(`zoom: ${SOURCE_ZOOM[variant]}`, `zoom: ${zoom.toFixed(4)}`)
    .replace(
      "for (const p of panels) p.draw(t);",
      "if (!window.__ELEMENTS_PAUSED) for (const p of panels) p.draw(t);",
    );
}

export function ElementsBackground({
  variant = ELEMENTS_DEFAULTS.variant,
  speed = ELEMENTS_DEFAULTS.speed,
  size = ELEMENTS_DEFAULTS.size,
  particleAmount = ELEMENTS_DEFAULTS.particleAmount,
  opacity = ELEMENTS_DEFAULTS.opacity,
  hue = ELEMENTS_DEFAULTS.hue,
  saturation = ELEMENTS_DEFAULTS.saturation,
  brightness = ELEMENTS_DEFAULTS.brightness,
  className = "",
  style,
}: ElementsBackgroundProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [hostVisible, setHostVisible] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const safeVariant = ELEMENT_VARIANTS.includes(variant) ? variant : ELEMENTS_DEFAULTS.variant;
  const safeSpeed = clamp(speed, 0, 3);
  const paused = !hostVisible || !documentVisible;
  const source = useMemo(
    () => buildFocusedDocument(safeVariant, size, particleAmount),
    [particleAmount, safeVariant, size],
  );

  const postControls = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({
      type: "elements-controls",
      controls: { speed: safeSpeed, paused },
    }, "*");
  }, [paused, safeSpeed]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(([entry]) => setHostVisible(entry?.isIntersecting ?? true));
    observer.observe(iframe);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const update = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    postControls();
  }, [postControls, source]);

  return (
    <div
      className={`threeui-background elements${className ? ` ${className}` : ""}`}
      data-element={safeVariant}
      style={{ background: "#060708", pointerEvents: "auto", ...style }}
    >
      <iframe
        ref={iframeRef}
        title={`${VARIANT_LABELS[safeVariant]} element background`}
        srcDoc={source}
        sandbox="allow-scripts"
        onLoad={postControls}
        aria-hidden="true"
        tabIndex={-1}
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          border: 0,
          background: "#060708",
          opacity: clamp(opacity, 0.05, 1),
          filter: `hue-rotate(${clamp(hue, -180, 180)}deg) saturate(${clamp(saturation, 0, 2)}) brightness(${clamp(brightness, 0.35, 1.8)})`,
        }}
      />
    </div>
  );
}
