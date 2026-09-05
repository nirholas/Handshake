import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import brandOrbsSource from "./sources/brand-orbs-v2.html?raw";

export const BRAND_ORB_VARIANTS = [
  "claude",
  "openai",
  "codex",
  "cursor",
  "gemini",
  "figma",
  "framer",
  "react",
  "swift",
  "designcode",
  "aura",
  "dreamcut",
  "ui",
  "ux",
  "css",
  "ios",
  "neuform",
  "github",
  "x",
  "instagram",
  "threads",
  "linkedin",
  "email",
] as const;

export const BRAND_ORB_SIZES = ["small", "medium"] as const;

export type BrandOrbVariant = (typeof BRAND_ORB_VARIANTS)[number];
export type BrandOrbSize = (typeof BRAND_ORB_SIZES)[number];
export type BrandOrbMode = "auto" | "dark" | "light";

export type BrandOrbsProps = {
  variant?: BrandOrbVariant;
  size?: BrandOrbSize;
  mode?: BrandOrbMode;
  speed?: number;
  paused?: boolean;
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
};

export const BRAND_ORBS_DEFAULTS = {
  variant: "claude" as BrandOrbVariant,
  size: "medium" as BrandOrbSize,
  mode: "dark" as BrandOrbMode,
  speed: 1,
  paused: false,
} as const;

const SIZE_PIXELS: Record<BrandOrbSize, 20 | 56> = {
  small: 20,
  medium: 56,
};

const VARIANT_LABELS: Record<BrandOrbVariant, string> = {
  claude: "Claude Code",
  openai: "OpenAI",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  figma: "Figma",
  framer: "Framer",
  react: "React",
  swift: "Swift",
  designcode: "DesignCode",
  aura: "Aura",
  dreamcut: "DreamCut",
  ui: "UI",
  ux: "UX",
  css: "CSS",
  ios: "iOS",
  neuform: "Neuform",
  github: "GitHub",
  x: "X",
  instagram: "Instagram",
  threads: "Threads",
  linkedin: "LinkedIn",
  email: "Email",
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function readAutomaticMode(): Exclude<BrandOrbMode, "auto"> {
  if (typeof document === "undefined" || typeof window === "undefined") return "dark";
  const declared = document.documentElement.dataset.theme ?? document.documentElement.dataset.scheme;
  if (declared === "light" || declared === "dark") return declared;
  if (document.documentElement.classList.contains("light")) return "light";
  if (document.documentElement.classList.contains("dark")) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function useAutomaticMode(enabled: boolean) {
  const [mode, setMode] = useState<Exclude<BrandOrbMode, "auto">>(readAutomaticMode);

  useEffect(() => {
    if (!enabled || typeof document === "undefined" || typeof window === "undefined") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setMode(readAutomaticMode());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-scheme", "data-theme"],
    });
    media.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, [enabled]);

  return mode;
}

function extractOrbEngine(source: string) {
  const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  return scripts.at(-1)?.[1] ?? "";
}

const ORB_ENGINE = extractOrbEngine(brandOrbsSource).replace(/<\/script/gi, "<\\/script");

function buildFocusedDocument(variant: BrandOrbVariant, size: BrandOrbSize, mode: Exclude<BrandOrbMode, "auto">) {
  const background = mode === "light" ? "#dad7cc" : "#050608";
  const filter = mode === "light" ? "invert(1) hue-rotate(180deg) contrast(1.04) saturate(.92)" : "none";
  const canvasSize = SIZE_PIXELS[size];
  const variantJson = JSON.stringify(variant).replace(/</g, "\\u003c");
  const controlScript = `<script data-brand-orbs-controls>
(function () {
  var nativeNow = performance.now.bind(performance);
  var last = nativeNow();
  var virtual = last;
  var controls = { speed: 1, paused: false };
  window.__BRAND_ORB_PAUSED = false;
  performance.now = function () {
    var real = nativeNow();
    if (!controls.paused) virtual += (real - last) * controls.speed;
    last = real;
    return virtual;
  };
  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'brand-orbs-controls') return;
    var next = event.data.controls || {};
    if (Number.isFinite(next.speed)) controls.speed = Math.max(.1, Math.min(3, next.speed));
    controls.paused = Boolean(next.paused);
    window.__BRAND_ORB_PAUSED = controls.paused;
  });
})();
</script>`;
  const engine = ORB_ENGINE.replace(
    'if (document.visibilityState !== "hidden")',
    'if (document.visibilityState !== "hidden" && !window.__BRAND_ORB_PAUSED)',
  );

  return `<!doctype html>
<html lang="en" data-theme="${mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${VARIANT_LABELS[variant]} Brand Orb</title>
<style>
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: ${background}; }
body { display: grid; place-items: center; }
canvas { display: block; width: ${canvasSize}px; height: ${canvasSize}px; filter: ${filter}; }
</style>
${controlScript}
</head>
<body>
<canvas data-mode=${variantJson} data-size="${canvasSize}" aria-hidden="true"></canvas>
<script>${engine}</script>
</body>
</html>`;
}

export function BrandOrbs({
  variant = BRAND_ORBS_DEFAULTS.variant,
  size = BRAND_ORBS_DEFAULTS.size,
  mode = BRAND_ORBS_DEFAULTS.mode,
  speed = BRAND_ORBS_DEFAULTS.speed,
  paused = BRAND_ORBS_DEFAULTS.paused,
  "aria-label": ariaLabel,
  className,
  style,
}: BrandOrbsProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [hostVisible, setHostVisible] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const automaticMode = useAutomaticMode(mode === "auto");
  const resolvedMode = mode === "auto" ? automaticMode : mode;
  const safeVariant = BRAND_ORB_VARIANTS.includes(variant) ? variant : BRAND_ORBS_DEFAULTS.variant;
  const safeSize = BRAND_ORB_SIZES.includes(size) ? size : BRAND_ORBS_DEFAULTS.size;
  const safeSpeed = clamp(speed, 0.1, 3);
  const effectivePaused = paused || !hostVisible || !documentVisible;
  const source = useMemo(() => buildFocusedDocument(safeVariant, safeSize, resolvedMode), [resolvedMode, safeSize, safeVariant]);
  const background = resolvedMode === "light" ? "#dad7cc" : "#050608";

  const postControls = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({
      type: "brand-orbs-controls",
      controls: { speed: safeSpeed, paused: effectivePaused },
    }, "*");
  }, [effectivePaused, safeSpeed]);

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
    <iframe
      ref={iframeRef}
      className={className}
      title={ariaLabel ?? `${VARIANT_LABELS[safeVariant]} animated brand orb`}
      srcDoc={source}
      sandbox="allow-scripts"
      loading="eager"
      onLoad={postControls}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        border: 0,
        background,
        ...style,
      }}
    />
  );
}
