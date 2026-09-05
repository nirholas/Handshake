import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import semanticExplorerSource from "./sources/design-f0ebbe02-7d8a-41fd-9041-a1124185c27b.html?raw";

export type SemanticBloomProps = {
  text?: string;
  mode?: "dark" | "light";
  size?: number;
  opacity?: number;
  className?: string;
  style?: CSSProperties;
};

export const SEMANTIC_BLOOM_DEFAULTS = {
  text: "Codex",
  mode: "dark" as const,
  size: 1,
  opacity: 1,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function buildFocusedDocument(mode: "dark" | "light") {
  const light = mode === "light";
  const surface = light ? "#f4f4f2" : "#030303";
  const restingText = light ? "#989894" : "#555555";
  const activeText = light ? "#151515" : "#e0e0e0";
  const particle = light ? "rgba(28, 28, 28, 0.78)" : "rgba(200, 200, 200, 0.8)";
  const connection = light ? "rgba(48, 48, 46, 0.14)" : "rgba(120, 120, 120, 0.15)";
  const focusStyles = `<style data-semantic-bloom-focus>
:root {
  --bg-color: ${surface};
  --text-color: ${restingText};
  --highlight-color: ${activeText};
  --sf-semantic-size: 1;
}
html, body { background: ${surface}; }
.query-container, .status-hud { display: none !important; }
.interface-layer {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(2rem, 8vw, 8rem);
}
.journal-area {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: auto;
  overflow: visible;
  color: ${restingText};
  font-size: clamp(4rem, calc(12vw * var(--sf-semantic-size)), 11rem);
  font-weight: 300;
  line-height: 1;
  letter-spacing: -0.065em;
  text-align: center;
  white-space: pre-wrap;
  caret-color: transparent;
}
.journal-area .word { display: inline-block; color: ${restingText}; }
#cursor-follower { display: none; border-color: ${light ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.3)"}; }
@media (max-width: 640px) {
  .interface-layer { padding: 1.5rem; }
  .journal-area { font-size: clamp(3rem, calc(19vw * var(--sf-semantic-size)), 7rem); }
}
</style>`;
  const controls = `<script data-semantic-bloom-controls>
(function () {
  window.__SEMANTIC_BLOOM_PAUSED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.__SEMANTIC_BLOOM_FRAME_PENDING = false;

  function setText(value) {
    var next = typeof value === 'string' && value.trim() ? value.slice(0, 72) : 'Codex';
    editor.textContent = next;
    editor.dataset.processed = 'false';
    editor.setAttribute('contenteditable', 'false');
    scanText();
  }

  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'semantic-bloom-controls') return;
    var next = event.data.controls || {};
    if (typeof next.text === 'string') setText(next.text);
    if (Number.isFinite(next.size)) {
      document.documentElement.style.setProperty('--sf-semantic-size', String(Math.max(0.55, Math.min(1.6, next.size))));
      updateWordCoords();
    }
    var wasPaused = window.__SEMANTIC_BLOOM_PAUSED;
    window.__SEMANTIC_BLOOM_PAUSED = Boolean(next.paused);
    if (wasPaused && !window.__SEMANTIC_BLOOM_PAUSED && !window.__SEMANTIC_BLOOM_FRAME_PENDING && typeof animate === 'function') animate();
  });
})();
</script>`;

  return semanticExplorerSource
    .replace("<title vid=\"4\">Organic Semantic Explorer</title>", "<title vid=\"4\">Semantic Bloom</title>")
    .replace("</head>", `${focusStyles}</head>`)
    .replace("ctx.fillStyle = 'rgba(200, 200, 200, 0.8)';", `ctx.fillStyle = '${particle}';`)
    .replace("ctx.strokeStyle = 'rgba(120, 120, 120, 0.15)';", `ctx.strokeStyle = '${connection}';`)
    .replace(
      "function animate() {\n            \n            ctx.clearRect(0, 0, width, height);",
      "function animate() {\n            window.__SEMANTIC_BLOOM_FRAME_PENDING = false;\n            ctx.clearRect(0, 0, width, height);",
    )
    .replace(
      "requestAnimationFrame(animate);",
      "if (!window.__SEMANTIC_BLOOM_PAUSED) { window.__SEMANTIC_BLOOM_FRAME_PENDING = true; requestAnimationFrame(animate); }",
    )
    .replace("</body>", `${controls}</body>`);
}

export function SemanticBloom({
  text = SEMANTIC_BLOOM_DEFAULTS.text,
  mode = SEMANTIC_BLOOM_DEFAULTS.mode,
  size = SEMANTIC_BLOOM_DEFAULTS.size,
  opacity = SEMANTIC_BLOOM_DEFAULTS.opacity,
  className = "",
  style,
}: SemanticBloomProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [hostVisible, setHostVisible] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const safeMode = mode === "light" ? "light" : "dark";
  const source = useMemo(() => buildFocusedDocument(safeMode), [safeMode]);
  const paused = !hostVisible || !documentVisible;

  const postControls = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({
      type: "semantic-bloom-controls",
      controls: {
        text: text.trim() || SEMANTIC_BLOOM_DEFAULTS.text,
        size: clamp(size, 0.55, 1.6),
        paused,
      },
    }, "*");
  }, [paused, size, text]);

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
      className={`threeui-background semantic-bloom semantic-bloom--${safeMode}${className ? ` ${className}` : ""}`}
      data-mode={safeMode}
      style={{ background: safeMode === "light" ? "#f4f4f2" : "#030303", pointerEvents: "auto", ...style }}
    >
      <iframe
        ref={iframeRef}
        title={`Semantic Bloom: ${text.trim() || SEMANTIC_BLOOM_DEFAULTS.text}`}
        srcDoc={source}
        sandbox="allow-scripts"
        onLoad={postControls}
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          border: 0,
          background: "transparent",
          opacity: clamp(opacity, 0.1, 1),
        }}
      />
    </div>
  );
}
