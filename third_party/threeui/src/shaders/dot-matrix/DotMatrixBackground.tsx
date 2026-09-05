import { useEffect, useRef } from "react";
import * as THREE from "three128";
import { CORE_UPLINK_FRAGMENT_SHADER, CORE_UPLINK_VERTEX_SHADER } from "./dotMatrixShaders";
export type DotMatrixBackgroundProps = { speed?: number; gridScale?: number; mouseAmount?: number; pulseSpeed?: number; radius?: number; opacity?: number; hue?: number; className?: string };
export const DOT_MATRIX_DEFAULTS = { speed: 1, gridScale: 60, mouseAmount: 0.04, pulseSpeed: 0.4, radius: 0.15, opacity: 0.35, hue: 0 } as const;
export function DotMatrixBackground({ className = "", ...props }: DotMatrixBackgroundProps) {
  const hostRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), optionsRef = useRef({ ...DOT_MATRIX_DEFAULTS, ...props }); optionsRef.current = { ...DOT_MATRIX_DEFAULTS, ...props };
  useEffect(() => { const host = hostRef.current, canvas = canvasRef.current; if (!host || !canvas) return undefined;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); camera.position.z = 1;
    const uniforms = { uTime: { value: 0 }, uResolution: { value: new THREE.Vector2() }, uMouse: { value: new THREE.Vector2() }, uGridScale: { value: 60 }, uMouseAmount: { value: 0.04 }, uPulseSpeed: { value: 0.4 }, uRadius: { value: 0.15 }, uOpacity: { value: 0.35 } };
    const geometry = new THREE.PlaneGeometry(2, 2), material = new THREE.ShaderMaterial({ uniforms, vertexShader: CORE_UPLINK_VERTEX_SHADER, fragmentShader: CORE_UPLINK_FRAGMENT_SHADER, transparent: true, depthWrite: false }); scene.add(new THREE.Mesh(geometry, material));
    let mouse = new THREE.Vector2(), target = new THREE.Vector2(), frame = 0, visible = true, startedAt = performance.now();
    const pointer = (event: PointerEvent) => { const bounds = canvas.getBoundingClientRect(); target.x = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1; target.y = -(((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 - 1); };
    const resize = () => { const bounds = host.getBoundingClientRect(); renderer.setSize(bounds.width, bounds.height, false); uniforms.uResolution.value.set(bounds.width, bounds.height); };
    const render = (now: number) => { const options = optionsRef.current; mouse.lerp(target, 0.05); uniforms.uTime.value = (now - startedAt) * 0.001 * options.speed; uniforms.uMouse.value = mouse; uniforms.uGridScale.value = options.gridScale; uniforms.uMouseAmount.value = options.mouseAmount; uniforms.uPulseSpeed.value = options.pulseSpeed; uniforms.uRadius.value = options.radius; uniforms.uOpacity.value = options.opacity; renderer.render(scene, camera); frame = visible && !document.hidden ? requestAnimationFrame(render) : 0; };
    const resizeObserver = new ResizeObserver(resize), intersection = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; if (visible && !frame) frame = requestAnimationFrame(render); if (!visible && frame) cancelAnimationFrame(frame), frame = 0; }); resizeObserver.observe(host); intersection.observe(host); canvas.addEventListener("pointermove", pointer, { passive: true }); resize(); frame = requestAnimationFrame(render);
    return () => { if (frame) cancelAnimationFrame(frame); resizeObserver.disconnect(); intersection.disconnect(); canvas.removeEventListener("pointermove", pointer); geometry.dispose(); material.dispose(); renderer.dispose(); }; }, []);
  return <div ref={hostRef} className={`threeui-background dot-matrix${className ? ` ${className}` : ""}`}><canvas ref={canvasRef} style={{ filter: `hue-rotate(${optionsRef.current.hue}deg)` }} /></div>;
}
