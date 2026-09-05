export type DataPixelArcMode = "dark" | "light";

export type DataPixelArcOptions = {
  mode: DataPixelArcMode;
  speed: number;
  pixelSize: number;
  arcCenter: number;
  arcDrop: number;
  thickness: number;
  brightness: number;
  hue: number;
  saturation: number;
};

export const DATA_PIXEL_ARC_DEFAULTS: DataPixelArcOptions = {
  mode: "dark",
  speed: 1,
  pixelSize: 8,
  arcCenter: 0.4,
  arcDrop: 0.9,
  thickness: 0.35,
  brightness: 1,
  hue: 0,
  saturation: 1,
};

function resolveMode(mode: DataPixelArcOptions["mode"] | number | string | undefined): DataPixelArcMode {
  if (mode === "light" || mode === 1 || mode === "1") return "light";
  return "dark";
}

export function createDataPixelArcRenderer(canvas: HTMLCanvasElement, getOptions: () => DataPixelArcOptions) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  let width = 1;
  let height = 1;
  let time = 0;
  let lightBackground: CanvasGradient | null = null;
  const resize = (nextWidth: number, nextHeight: number) => {
    width = Math.max(1, nextWidth);
    height = Math.max(1, nextHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    lightBackground = context.createLinearGradient(0, 0, 0, height);
    lightBackground.addColorStop(0, "#f8faf6");
    lightBackground.addColorStop(0.58, "#f3f6f1");
    lightBackground.addColorStop(1, "#edf1ec");
  };
  const render = () => {
    const options = getOptions();
    const isLight = resolveMode(options.mode) === "light";
    context.fillStyle = isLight && lightBackground ? lightBackground : "#030308";
    context.fillRect(0, 0, width, height);
    const cols = Math.ceil(width / options.pixelSize);
    const rows = Math.ceil(height / options.pixelSize);
    const arcCenterY = height * options.arcCenter;
    const arcDrop = height * options.arcDrop;
    const thickness = height * options.thickness;
    for (let x = 0; x < cols; x += 1) {
      for (let y = 0; y < rows; y += 1) {
        const px = x * options.pixelSize;
        const py = y * options.pixelSize;
        const nx = (px / width) * 2 - 1;
        const curveY = arcCenterY + Math.pow(Math.abs(nx), 1.8) * arcDrop;
        let intensity = Math.max(0, 1 - Math.abs(py - curveY) / thickness);
        if (intensity <= 0.01) continue;
        const wave1 = Math.sin(nx * 4 - time * 1.5) * 0.1;
        const wave2 = Math.cos(py * 0.01 + time) * 0.1;
        intensity = Math.max(0, Math.min(1, intensity + wave1 + wave2));
        intensity *= Math.max(0, 1 - Math.pow(Math.abs(nx), 2.5));
        if (intensity <= 0.02) continue;
        const coreStrength = Math.pow(intensity, 3);
        const middleStrength = Math.pow(intensity, 1.5);
        let r: number;
        let g: number;
        let b: number;
        if (isLight) {
          // Sage edge pixels hold their shape on paper while the emerald core stays vivid.
          const pigment = Math.pow(intensity, 0.78);
          const inkStrength = Math.max(0.45, Math.min(1.35, options.brightness));
          const paper = [238, 242, 237];
          const ink = [
            192 - 172 * pigment - 10 * coreStrength,
            204 - 88 * pigment + 18 * coreStrength,
            193 - 132 * pigment + 4 * coreStrength,
          ];
          r = Math.max(0, Math.min(255, Math.round(paper[0] + (ink[0] - paper[0]) * inkStrength)));
          g = Math.max(0, Math.min(255, Math.round(paper[1] + (ink[1] - paper[1]) * inkStrength)));
          b = Math.max(0, Math.min(255, Math.round(paper[2] + (ink[2] - paper[2]) * inkStrength)));
        } else {
          r = Math.floor((30 * intensity + 100 * coreStrength) * options.brightness);
          g = Math.floor((220 * middleStrength + 40 * coreStrength) * options.brightness);
          b = Math.floor((80 * intensity + 50 * coreStrength) * options.brightness);
        }
        context.fillStyle = `rgb(${r}, ${g}, ${b})`;
        context.globalAlpha = isLight ? Math.min(1, 0.22 + Math.pow(intensity, 0.68) * 0.78) : intensity;
        context.fillRect(px, py, options.pixelSize - 1, options.pixelSize - 1);
      }
    }
    context.globalAlpha = 1;
    time += 0.02 * options.speed;
  };
  return { resize, render };
}
