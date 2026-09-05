import { useEffect, useRef, type CSSProperties } from "react";

import { LASER_FRAGMENT_SHADER, LASER_VERTEX_SHADER } from "./laserShaders";

export type ThreeUILaserVariant =
  | "atmospheric-blade"
  | "vanishing-array"
  | "prism-aperture"
  | "halftone-relay";

export type LaserVariantsProps = {
  variant?: ThreeUILaserVariant;
  speed?: number;
  size?: number;
  length?: number;
  density?: number;
  opacity?: number;
  hue?: number;
  saturation?: number;
  brightness?: number;
  className?: string;
  style?: CSSProperties;
};

export const LASER_VARIANT_DEFAULTS = {
  variant: "atmospheric-blade" as ThreeUILaserVariant,
  speed: 1,
  size: 1,
  length: 1,
  density: 1,
  opacity: 1,
  hue: 0,
  saturation: 1,
  brightness: 1,
} as const;

const VARIANT_INDEX: Record<ThreeUILaserVariant, number> = {
  "atmospheric-blade": 0,
  "vanishing-array": 1,
  "prism-aperture": 2,
  "halftone-relay": 3,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create Laser shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Laser shader compilation failed";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

export function LaserVariants({ className = "", style, ...props }: LaserVariantsProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const redrawRef = useRef<() => void>(() => undefined);
  const optionsRef = useRef({ ...LASER_VARIANT_DEFAULTS, ...props });
  optionsRef.current = { ...LASER_VARIANT_DEFAULTS, ...props };

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
      premultipliedAlpha: false,
    });
    if (!gl) return undefined;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, LASER_VERTEX_SHADER);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, LASER_FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return undefined;
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) ?? "Laser program link failed";
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw new Error(message);
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
      resolution: gl.getUniformLocation(program, "u_resolution"),
      pointer: gl.getUniformLocation(program, "u_pointer"),
      time: gl.getUniformLocation(program, "u_time"),
      variant: gl.getUniformLocation(program, "u_variant"),
      size: gl.getUniformLocation(program, "u_size"),
      length: gl.getUniformLocation(program, "u_length"),
      density: gl.getUniformLocation(program, "u_density"),
      hue: gl.getUniformLocation(program, "u_hue"),
      saturation: gl.getUniformLocation(program, "u_saturation"),
      brightness: gl.getUniformLocation(program, "u_brightness"),
    };

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionQuery.matches;
    let frame = 0;
    let visible = true;
    let targetX = 0;
    let targetY = 0;
    let pointerX = 0;
    let pointerY = 0;
    const startedAt = performance.now();

    const draw = (now: number) => {
      const options = optionsRef.current;
      const variant = options.variant in VARIANT_INDEX ? options.variant : LASER_VARIANT_DEFAULTS.variant;
      pointerX += (targetX - pointerX) * (reducedMotion ? 1 : 0.055);
      pointerY += (targetY - pointerY) * (reducedMotion ? 1 : 0.055);

      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform2f(uniforms.pointer, pointerX, pointerY);
      gl.uniform1f(uniforms.time, reducedMotion ? 2.75 : (now - startedAt) * 0.001 * clamp(options.speed, 0, 3));
      gl.uniform1f(uniforms.variant, VARIANT_INDEX[variant]);
      gl.uniform1f(uniforms.size, clamp(options.size, 0.35, 2.5));
      gl.uniform1f(uniforms.length, clamp(options.length, 0.35, 2.5));
      gl.uniform1f(uniforms.density, clamp(options.density, 0.25, 2.5));
      gl.uniform1f(uniforms.hue, clamp(options.hue, -180, 180));
      gl.uniform1f(uniforms.saturation, clamp(options.saturation, 0, 2));
      gl.uniform1f(uniforms.brightness, clamp(options.brightness, 0.35, 1.65));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const schedule = () => {
      if (!reducedMotion && visible && !document.hidden && !frame) {
        frame = window.requestAnimationFrame(render);
      }
    };

    function render(now: number) {
      frame = 0;
      draw(now);
      schedule();
    }

    const syncAnimation = () => {
      if (reducedMotion || !visible || document.hidden) {
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
        draw(performance.now());
        return;
      }
      schedule();
    };
    redrawRef.current = () => draw(performance.now());

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
      gl.viewport(0, 0, canvas.width, canvas.height);
      draw(performance.now());
    };

    const handlePointerMove = (event: PointerEvent) => {
      const bounds = host.getBoundingClientRect();
      targetX = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1;
      targetY = -(((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 - 1);
      if (reducedMotion) draw(performance.now());
    };

    const handlePointerLeave = () => {
      targetX = 0;
      targetY = 0;
      if (reducedMotion) draw(performance.now());
    };

    const handleMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      syncAnimation();
    };

    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      syncAnimation();
    });

    resizeObserver.observe(host);
    intersectionObserver.observe(host);
    host.addEventListener("pointermove", handlePointerMove, { passive: true });
    host.addEventListener("pointerleave", handlePointerLeave, { passive: true });
    document.addEventListener("visibilitychange", syncAnimation);
    motionQuery.addEventListener("change", handleMotionChange);
    resize();
    syncAnimation();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      host.removeEventListener("pointermove", handlePointerMove);
      host.removeEventListener("pointerleave", handlePointerLeave);
      document.removeEventListener("visibilitychange", syncAnimation);
      motionQuery.removeEventListener("change", handleMotionChange);
      redrawRef.current = () => undefined;
      gl.deleteBuffer(buffer);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteProgram(program);
    };
  }, []);

  useEffect(() => {
    redrawRef.current();
  }, [props.variant, props.speed, props.size, props.length, props.density, props.hue, props.saturation, props.brightness]);

  const opacity = clamp(optionsRef.current.opacity, 0.05, 1);
  return (
    <div
      ref={hostRef}
      className={`threeui-background laser-variant${className ? ` ${className}` : ""}`}
      style={{ background: "#020305", ...style }}
    >
      <canvas ref={canvasRef} aria-hidden="true" style={{ opacity, pointerEvents: "none" }} />
    </div>
  );
}
