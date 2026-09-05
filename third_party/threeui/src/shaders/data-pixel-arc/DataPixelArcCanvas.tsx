import { useEffect, useRef } from "react";
import { createDataPixelArcRenderer, DATA_PIXEL_ARC_DEFAULTS, type DataPixelArcOptions } from "./dataPixelArcRenderer";

export type DataPixelArcCanvasProps = Partial<DataPixelArcOptions> & { className?: string };

export function DataPixelArcCanvas({ className = "", ...props }: DataPixelArcCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const optionsRef = useRef({ ...DATA_PIXEL_ARC_DEFAULTS, ...props });
  optionsRef.current = { ...DATA_PIXEL_ARC_DEFAULTS, ...props };
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;
    const renderer = createDataPixelArcRenderer(canvas, () => optionsRef.current);
    if (!renderer) return undefined;
    let frame = 0;
    let visible = true;
    const resize = () => { const bounds = host.getBoundingClientRect(); renderer.resize(bounds.width, bounds.height); renderer.render(); };
    const tick = () => { renderer.render(); frame = visible && !document.hidden ? requestAnimationFrame(tick) : 0; };
    const observer = new ResizeObserver(resize);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible && !frame) frame = requestAnimationFrame(tick);
      if (!visible && frame) cancelAnimationFrame(frame), frame = 0;
    });
    const visibility = () => {
      if (document.hidden && frame) cancelAnimationFrame(frame), frame = 0;
      else if (!document.hidden && visible && !frame) frame = requestAnimationFrame(tick);
    };
    observer.observe(host); intersection.observe(host); document.addEventListener("visibilitychange", visibility); resize(); frame = requestAnimationFrame(tick);
    return () => { if (frame) cancelAnimationFrame(frame); observer.disconnect(); intersection.disconnect(); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  return (
    <div
      ref={hostRef}
      className={`threeui-background data-pixel-arc data-pixel-arc--${optionsRef.current.mode}${className ? ` ${className}` : ""}`}
      data-mode={optionsRef.current.mode}
    >
      <canvas ref={canvasRef} style={{ filter: `hue-rotate(${optionsRef.current.hue}deg) saturate(${optionsRef.current.saturation})` }} />
    </div>
  );
}
