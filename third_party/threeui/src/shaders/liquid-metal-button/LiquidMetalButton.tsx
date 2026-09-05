import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import liquidMetalButtonSource from "./liquid-metal-button.html?raw";

export type LiquidMetalButtonVariant = "pill" | "circle" | "play";

export type LiquidMetalButtonProps = {
  variant?: LiquidMetalButtonVariant;
  className?: string;
  rendering?: "colored" | "monotone";
  diameter?: number;
  strokeWidth?: number;
  text?: string;
  embedded?: boolean;
  onClick?: () => void;
};

const LIQUID_METAL_BUTTON_BRIDGE = `
<script id="liquid-metal-button-bridge">
  window.addEventListener('message', event => {
    if(event.source !== parent) return;
    const config = event.data && event.data.liquidMetalButton;
    if(!config) return;
    const text = typeof config.text === 'string' ? config.text.slice(0, 24) : '';
    const label = btn.querySelector('.lbl');
    if(label) label.textContent = text;
    btn.setAttribute('aria-label', text || 'Button');
    if(Number.isFinite(config.pillWidthUnits)) {
      stage.style.setProperty('--bw', 'calc(' + config.pillWidthUnits + ' * var(--u))');
    }
    document.body.style.background = config.embedded ? '#0e0f12' : '';
    stage.style.position = config.embedded ? 'absolute' : '';
    stage.style.top = config.embedded ? '50%' : '';
    stage.style.left = config.embedded ? '50%' : '';
    stage.style.transform = config.embedded ? 'translate(-50%, -50%)' : '';
  });

  btn.addEventListener('click', () => {
    parent.postMessage({ liquidMetalButton: { type: 'activate' } }, '*');
  });
</script>`;

const CIRCLE_RUNTIME_STYLE = `
<style id="liquid-metal-circle-variant">
  body[data-shape="circle"] .stage {
    --h: clamp(56px, 10vmin, 72px);
    --bw: var(--h);
  }

  body[data-shape="circle"] .btn {
    gap: 0;
  }

  body[data-shape="circle"] .btn .ico {
    width: 28%;
    height: 28%;
  }

  body[data-shape="circle"] .btn .lbl {
    display: none;
  }
</style>`;

function sourceForVariant(variant: Exclude<LiquidMetalButtonVariant, "play">) {
  if (variant === "pill") {
    return liquidMetalButtonSource.replace("</body>", `${LIQUID_METAL_BUTTON_BRIDGE}\n</body>`);
  }

  return liquidMetalButtonSource
    .replace("</head>", `${CIRCLE_RUNTIME_STYLE}\n</head>`)
    .replace("<body>", '<body data-shape="circle">')
    .replace(
      '<button class="btn" id="btn" type="button">',
      '<button class="btn" id="btn" type="button" aria-label="Add">',
    )
    .replace("</body>", `${LIQUID_METAL_BUTTON_BRIDGE}\n</body>`);
}

const liquidMetalPlayButtonSource = liquidMetalButtonSource
  .replace(
    "--bw: calc(1407 * var(--u));",
    "--bw: var(--h);",
  )
  .replace(
    "</style>",
    `
  /* Circular play-button adapter. The renderer and interaction graph stay
     source-exact; only geometry, finish, outline, and accessible naming vary. */
  body{position:relative}
  .stage{
    --h:88px;
    position:absolute;top:50%;left:50%;
    transform:translate(-50%,-50%);
  }
  #fx{filter:none}
  .btn{flex-direction:column;gap:0}
  .btn:focus-visible{outline:2px solid rgba(255,255,255,.68);outline-offset:4px}
  .btn .ico{
    width:calc(var(--h) * .25);height:calc(var(--h) * .25);
    transform:translateX(calc(var(--h) * .018));
  }
</style>`,
  )
  .replace(
    `<button class="btn" id="btn" type="button">
    <svg class="ico" viewBox="0 0 115 115" aria-hidden="true">
      <g stroke="currentColor" stroke-width="17" stroke-linecap="round">
        <path d="M57.5 8.5 V106.5"/>
        <path d="M8.5 57.5 H106.5"/>
      </g>
    </svg>
    <span class="lbl">Sign up</span>
  </button>`,
    `<button class="btn" id="btn" type="button" aria-label="Play">
    <svg class="ico" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="currentColor" d="M15.5 10.75a2.2 2.2 0 0 1 3.32-1.9l18.04 13.25a2.35 2.35 0 0 1 0 3.8L18.82 39.15a2.2 2.2 0 0 1-3.32-1.9v-26.5Z"/>
    </svg>
  </button>`,
  )
  .replace(
    "let needResize = true;",
    "let needResize = true;\nlet playStrokeWidth = 3;",
  )
  .replace(
    "const bw = Math.max(1.5, 3.2 * (BH/516));      // stroke half-width, device px",
    "const bw = Math.max(0.5 * DPR, playStrokeWidth * DPR * 0.5); // configurable stroke half-width, device px",
  )
  .replace(
    "window.__seek   = v => { clock = v; drawn = null; };",
    `window.__seek   = v => { clock = v; drawn = null; };

window.addEventListener('message', event => {
  if(event.source !== parent) return;
  const config = event.data && event.data.liquidMetalPlayButton;
  if(!config) return;
  const diameter = Math.min(160, Math.max(72, Number(config.diameter) || 88));
  const strokeWidth = Math.min(8, Math.max(1, Number(config.strokeWidth) || 3));
  const text = typeof config.text === 'string' ? config.text.slice(0, 24) : 'Play';
  stage.style.setProperty('--h', diameter + 'px');
  playStrokeWidth = strokeWidth;
  btn.setAttribute('aria-label', text.trim() || 'Play');
  cv.style.filter = config.rendering === 'monotone' ? 'grayscale(1) contrast(1.04)' : 'none';
  needResize = true;
  drawn = null;
});`,
  )
  .replace("</body>", `${LIQUID_METAL_BUTTON_BRIDGE}\n</body>`);

function clamp(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function LiquidMetalButton({
  className = "",
  variant = "pill",
  rendering = "colored",
  diameter = 88,
  strokeWidth = 3,
  text,
  embedded = false,
  onClick,
}: LiquidMetalButtonProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const intersectsRef = useRef(true);
  const [mounted, setMounted] = useState(true);
  const [ready, setReady] = useState(false);
  const safeVariant: LiquidMetalButtonVariant =
    variant === "circle" || variant === "play" ? variant : "pill";
  const isPlayButton = safeVariant === "play";
  const safeText = String(text ?? (safeVariant === "pill" ? "Sign up" : safeVariant === "circle" ? "Add" : "Play"))
    .slice(0, 24);
  const pillWidthUnits = safeVariant === "pill"
    ? Math.min(3000, Math.max(1407, 820 + safeText.length * 94))
    : undefined;
  const source = useMemo(
    () => isPlayButton ? liquidMetalPlayButtonSource : sourceForVariant(safeVariant),
    [isPlayButton, safeVariant],
  );
  const playConfig = {
    diameter: clamp(diameter, 72, 160, 88),
    strokeWidth: clamp(strokeWidth, 1, 8, 3),
    rendering,
    text: safeText,
  } as const;

  const syncButtonConfig = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({
      liquidMetalButton: { text: safeText, pillWidthUnits, embedded },
    }, "*");
  }, [embedded, pillWidthUnits, safeText]);

  const syncPlayConfig = useCallback(() => {
    if (!isPlayButton) return;
    frameRef.current?.contentWindow?.postMessage({ liquidMetalPlayButton: playConfig }, "*");
  }, [isPlayButton, playConfig.diameter, playConfig.rendering, playConfig.strokeWidth, playConfig.text]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const sync = () => setMounted(intersectsRef.current && document.visibilityState !== "hidden");
    const observer = new IntersectionObserver(([entry]) => {
      intersectsRef.current = entry.isIntersecting;
      sync();
    }, { rootMargin: "80px" });

    observer.observe(host);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  useEffect(() => {
    if (!mounted) setReady(false);
  }, [mounted]);

  useEffect(() => {
    if (!ready) return;
    syncButtonConfig();
    syncPlayConfig();
  }, [ready, syncButtonConfig, syncPlayConfig]);

  useEffect(() => {
    if (!onClick) return undefined;
    const receiveMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.liquidMetalButton?.type !== "activate") return;
      onClick();
    };
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [onClick]);

  return (
    <div
      ref={hostRef}
      className={`liquid-metal-button${className ? ` ${className}` : ""}`}
      data-state={!mounted ? "paused" : ready ? "ready" : "loading"}
      data-variant={safeVariant}
    >
      {mounted ? (
        <iframe
          key={safeVariant}
          ref={frameRef}
          className={`liquid-metal-button__frame${ready ? " is-ready" : ""}`}
          title={safeVariant === "circle"
            ? "Interactive liquid metal circle button"
            : isPlayButton
              ? "Interactive liquid metal play button"
              : "Interactive liquid metal button"}
          srcDoc={source}
          sandbox="allow-scripts"
          loading="eager"
          onLoad={() => {
            setReady(true);
            syncButtonConfig();
            syncPlayConfig();
          }}
        />
      ) : null}
    </div>
  );
}
