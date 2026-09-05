import { useEffect, useRef, type CSSProperties } from "react";
import * as THREE from "three";
import "./gallery.css";

const GALLERY_IMAGE_URLS = [
  new URL("./assets/gallery-1.webp", import.meta.url).href,
  new URL("./assets/gallery-2.webp", import.meta.url).href,
  new URL("./assets/gallery-3.webp", import.meta.url).href,
  new URL("./assets/gallery-4.webp", import.meta.url).href,
  new URL("./assets/gallery-5.webp", import.meta.url).href,
] as const;

export type GalleryProps = {
  speed?: number;
  scale?: number;
  opacity?: number;
  hue?: number;
  saturation?: number;
  brightness?: number;
  className?: string;
  style?: CSSProperties;
};

export const GALLERY_DEFAULTS = {
  speed: 1,
  scale: 1,
  opacity: 1,
  hue: 0,
  saturation: 1,
  brightness: 1,
} as const satisfies Required<Pick<GalleryProps, "speed" | "scale" | "opacity" | "hue" | "saturation" | "brightness">>;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function Gallery({
  speed = GALLERY_DEFAULTS.speed,
  scale = GALLERY_DEFAULTS.scale,
  opacity = GALLERY_DEFAULTS.opacity,
  hue = GALLERY_DEFAULTS.hue,
  saturation = GALLERY_DEFAULTS.saturation,
  brightness = GALLERY_DEFAULTS.brightness,
  className = "",
  style,
}: GalleryProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef({ speed, scale });
  settingsRef.current = { speed, scale };

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.z = 18;

    const gallery = new THREE.Group();
    scene.add(gallery);

    const geometry = new THREE.CylinderGeometry(5, 5, 1.8, 64, 1, true, 0, Math.PI * 0.4);
    const loader = new THREE.TextureLoader();
    let disposed = false;
    let frame = 0;
    let elapsed = 0;
    let previousTime = 0;
    let hostVisible = true;
    let documentVisible = !document.hidden;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const textures = GALLERY_IMAGE_URLS.map((url) => {
      const texture = loader.load(url, () => {
        if (disposed) {
          texture.dispose();
          return;
        }
        renderer.render(scene, camera);
      });
      texture.encoding = THREE.sRGBEncoding;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      return texture;
    });

    const materials = Array.from({ length: 16 }, (_, index) => new THREE.MeshBasicMaterial({
      map: textures[index % textures.length],
      opacity: 0.85,
      side: THREE.DoubleSide,
      toneMapped: false,
      transparent: true,
    }));

    materials.forEach((material, index) => {
      const panel = new THREE.Mesh(geometry, material);
      panel.position.y = (index - 8) * 2.4;
      panel.rotation.y = (index / 16) * Math.PI * 4;
      gallery.add(panel);
    });

    const render = (time = performance.now()) => {
      const safeSpeed = clamp(settingsRef.current.speed, 0, 3);
      const safeScale = clamp(settingsRef.current.scale, 0.7, 1.35);
      if (previousTime) elapsed += Math.min((time - previousTime) / 1000, 0.05) * safeSpeed;
      previousTime = time;
      gallery.rotation.y = elapsed * 0.18;
      gallery.position.y = Math.sin(elapsed) * 1.5;
      gallery.scale.setScalar(safeScale);
      renderer.render(scene, camera);
    };

    const tick = (time: number) => {
      if (disposed || !hostVisible || !documentVisible) {
        frame = 0;
        previousTime = 0;
        return;
      }
      render(time);
      frame = window.requestAnimationFrame(tick);
    };

    const start = () => {
      if (reducedMotion) {
        render(0);
        return;
      }
      if (!frame && hostVisible && documentVisible) frame = window.requestAnimationFrame(tick);
    };

    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
    };

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };

    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      hostVisible = entry?.isIntersecting ?? true;
      if (hostVisible) start();
      else stop();
    });
    const handleVisibility = () => {
      documentVisible = !document.hidden;
      if (documentVisible) start();
      else stop();
    };

    resizeObserver.observe(host);
    intersectionObserver.observe(host);
    document.addEventListener("visibilitychange", handleVisibility);
    resize();
    start();

    return () => {
      disposed = true;
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      gallery.clear();
      geometry.dispose();
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={`threeui-background gallery${className ? ` ${className}` : ""}`}
      data-mode="light"
      role="img"
      aria-label="Rotating cylindrical image gallery"
      style={style}
    >
      <canvas
        ref={canvasRef}
        className="gallery__canvas"
        aria-hidden="true"
        style={{
          opacity: clamp(opacity, 0.05, 1),
          filter: `hue-rotate(${clamp(hue, -180, 180)}deg) saturate(${clamp(saturation, 0, 2)}) brightness(${clamp(brightness, 0.35, 1.65)})`,
        }}
      />
    </div>
  );
}
