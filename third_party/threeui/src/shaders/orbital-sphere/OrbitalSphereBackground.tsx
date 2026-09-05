import { useEffect, useRef } from "react";
import { createOrbitalSphereRenderer, ORBITAL_SPHERE_DEFAULTS, type OrbitalSphereOptions } from "./orbitalSphereRenderer";
export type OrbitalSphereBackgroundProps = Partial<OrbitalSphereOptions> & { className?: string };
export function OrbitalSphereBackground({ className = "", ...props }: OrbitalSphereBackgroundProps) {
  const hostRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), optionsRef = useRef({ ...ORBITAL_SPHERE_DEFAULTS, ...props }); optionsRef.current = { ...ORBITAL_SPHERE_DEFAULTS, ...props };
  useEffect(() => { const host = hostRef.current, canvas = canvasRef.current; if (!host || !canvas) return undefined; const renderer = createOrbitalSphereRenderer(canvas, () => optionsRef.current); let frame = 0, visible = true;
    const resize = () => { const bounds = host.getBoundingClientRect(); renderer.resize(bounds.width, bounds.height); renderer.render(); }; const tick = () => { renderer.render(); frame = visible && !document.hidden ? requestAnimationFrame(tick) : 0; };
    const resizeObserver = new ResizeObserver(resize), intersection = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; if (visible && !frame) frame = requestAnimationFrame(tick); if (!visible && frame) cancelAnimationFrame(frame), frame = 0; }); resizeObserver.observe(host); intersection.observe(host); resize(); frame = requestAnimationFrame(tick);
    return () => { if (frame) cancelAnimationFrame(frame); resizeObserver.disconnect(); intersection.disconnect(); renderer.dispose(); }; }, []);
  return <div ref={hostRef} className={`threeui-background orbital-sphere${className ? ` ${className}` : ""}`}><canvas ref={canvasRef} style={{ filter: `hue-rotate(${optionsRef.current.hue}deg)` }} /></div>;
}
