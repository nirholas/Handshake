import * as THREE from "three128";

export const WARP_FIELD_VARIANTS = ["streaks", "letters", "keycaps", "hyperspace"] as const;
export type WarpFieldVariant = (typeof WARP_FIELD_VARIANTS)[number];

export type WarpFieldOptions = { variant: WarpFieldVariant; speed: number; streakOpacity: number; tileOpacity: number; fov: number; brightness: number; hue: number; saturation: number };
export const WARP_FIELD_DEFAULTS: WarpFieldOptions = { variant: "streaks", speed: 15, streakOpacity: 0.6, tileOpacity: 0.9, fov: 75, brightness: 1, hue: 0, saturation: 1 };

/* every layer streams toward the camera on +z and wraps back once it passes it,
   so the whole family shares the authored warp corridor of the original scene */
const RECYCLE_Z = 200;
const CAP_RECYCLE_Z = 110;
const CAP_RESET_Z = -1200;
/* the glyph and keycap corridors are shorter than the streak corridor: a rigid
   wrap over the full 2000 units arrives in waves at these object counts, and the
   solid ones also have to turn back before they can swallow the lens */
const LETTER_RECYCLE_Z = 140;
const LETTER_RESET_Z = -1300;
const RESET_Z = -1800;
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SPEED_SCALE: Record<WarpFieldVariant, number> = { streaks: 1, letters: 0.5, keycaps: 0.7, hyperspace: 2.4 };
const BACKGROUND: Record<WarpFieldVariant, number> = { streaks: 0x02040a, letters: 0x02040a, keycaps: 0x03070c, hyperspace: 0x01020a };

type Layer = { update?: (step: number, time: number) => void; setOpacity?: (streakOpacity: number, tileOpacity: number) => void; dispose: () => void };
type StreakSettings = { count: number; radiusMin: number; radiusSpread: number; lengthMin: number; lengthSpread: number; palette: number[]; opacityScale: number };

function createStreakLayer(group: THREE.Group, settings: StreakSettings, opacity: number): Layer {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(settings.count * 6);
  const colors = new Float32Array(settings.count * 6);
  const palette = settings.palette.map((hex) => new THREE.Color(hex));
  for (let index = 0; index < settings.count; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * settings.radiusSpread + settings.radiusMin;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const z = (Math.random() - 0.5) * 2000;
    const length = Math.random() * settings.lengthSpread + settings.lengthMin;
    positions[index * 6] = x;
    positions[index * 6 + 1] = y;
    positions[index * 6 + 2] = z;
    positions[index * 6 + 3] = x;
    positions[index * 6 + 4] = y;
    positions[index * 6 + 5] = z + length;
    const color = palette[Math.floor(Math.random() * palette.length)];
    colors[index * 6] = color.r; colors[index * 6 + 1] = color.g; colors[index * 6 + 2] = color.b;
    colors[index * 6 + 3] = color.r; colors[index * 6 + 4] = color.g; colors[index * 6 + 5] = color.b;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: opacity * settings.opacityScale, blending: THREE.AdditiveBlending });
  const streaks = new THREE.LineSegments(geometry, material);
  group.add(streaks);
  const attribute = geometry.attributes.position as unknown as { array: Float32Array; needsUpdate: boolean };
  return {
    update(step) {
      for (let index = 0; index < settings.count; index += 1) {
        positions[index * 6 + 2] += step;
        positions[index * 6 + 5] += step;
        if (positions[index * 6 + 2] > RECYCLE_Z) {
          const length = positions[index * 6 + 5] - positions[index * 6 + 2];
          positions[index * 6 + 2] = RESET_Z;
          positions[index * 6 + 5] = RESET_Z + length;
        }
      }
      attribute.needsUpdate = true;
    },
    setOpacity(streakOpacity) {
      const scaled = streakOpacity * settings.opacityScale;
      if (material.opacity !== scaled) material.opacity = scaled;
    },
    dispose() { geometry.dispose(); material.dispose(); },
  };
}

/* the authored 40 luminous tiles of the original Nexus hero */
function createTileLayer(group: THREE.Group, opacity: number): Layer {
  const geometry = new THREE.PlaneGeometry(8, 20);
  const template = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, side: THREE.DoubleSide });
  const tiles: THREE.Mesh[] = [];
  let lastOpacity = opacity;
  for (let index = 0; index < 40; index += 1) {
    const material = template.clone();
    material.color.setHex(Math.random() > 0.6 ? 0xa7f3d0 : Math.random() > 0.5 ? 0xd1fae5 : 0xffffff);
    const mesh = new THREE.Mesh(geometry, material);
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 400 + 100;
    mesh.position.x = Math.cos(angle) * radius;
    mesh.position.y = Math.sin(angle) * radius;
    mesh.position.z = (Math.random() - 0.5) * 2000;
    mesh.lookAt(0, 0, mesh.position.z + 100);
    const scale = Math.random() * 1.5 + 0.5;
    mesh.scale.set(scale, scale, scale);
    group.add(mesh);
    tiles.push(mesh);
  }
  return {
    update(step) {
      tiles.forEach((tile) => {
        tile.position.z += step;
        if (tile.position.z > RECYCLE_Z) tile.position.z = RESET_Z;
      });
    },
    setOpacity(_streakOpacity, tileOpacity) {
      if (lastOpacity === tileOpacity) return;
      tiles.forEach((tile) => { (tile.material as THREE.MeshBasicMaterial).opacity = tileOpacity; });
      lastOpacity = tileOpacity;
    },
    dispose() {
      geometry.dispose();
      template.dispose();
      tiles.forEach((tile) => (tile.material as THREE.MeshBasicMaterial).dispose());
    },
  };
}

type GlyphAtlas = { texture: THREE.CanvasTexture; columns: number; rows: number };

function createGlyphAtlas(color: string): GlyphAtlas {
  const columns = 6;
  const rows = 6;
  const cell = 128;
  const canvas = document.createElement("canvas");
  canvas.width = columns * cell;
  canvas.height = rows * cell;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = color;
    context.font = `700 ${Math.round(cell * 0.68)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    GLYPHS.split("").forEach((glyph, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      context.fillText(glyph, column * cell + cell / 2, row * cell + cell * 0.54);
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  return { texture, columns, rows };
}

/* one unit plane per glyph, with its uv window pinned to that atlas cell, so a
   whole alphabet renders from a single texture and a handful of materials */
function createGlyphGeometries(atlas: GlyphAtlas): THREE.PlaneGeometry[] {
  return GLYPHS.split("").map((_, index) => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const column = index % atlas.columns;
    const row = Math.floor(index / atlas.columns);
    const originU = column / atlas.columns;
    const originV = 1 - (row + 1) / atlas.rows;
    const uv = geometry.attributes.uv as THREE.BufferAttribute;
    for (let vertex = 0; vertex < uv.count; vertex += 1) {
      uv.setXY(vertex, originU + uv.getX(vertex) / atlas.columns, originV + uv.getY(vertex) / atlas.rows);
    }
    uv.needsUpdate = true;
    return geometry;
  });
}

type Tumbler = { mesh: THREE.Mesh; spin: number; swayX: number; swayY: number; phase: number; drift: number; radius: number };

function createLetterLayer(group: THREE.Group, opacity: number): Layer {
  const atlas = createGlyphAtlas("#ffffff");
  const geometries = createGlyphGeometries(atlas);
  const tints = [0xffffff, 0xa7f3d0, 0x34d399].map((color) => new THREE.MeshBasicMaterial({
    map: atlas.texture, color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
  }));
  const letters: Tumbler[] = [];
  let lastOpacity = opacity;
  for (let index = 0; index < 260; index += 1) {
    const mesh = new THREE.Mesh(geometries[Math.floor(Math.random() * geometries.length)], tints[Math.floor(Math.random() * tints.length)]);
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 430 + 60;
    mesh.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, LETTER_RESET_Z + Math.random() * (LETTER_RECYCLE_Z - LETTER_RESET_Z));
    const scale = Math.random() * 30 + 24;
    mesh.scale.set(scale, scale, scale);
    group.add(mesh);
    letters.push({ mesh, spin: (Math.random() - 0.5) * 0.02, swayX: Math.random() * 0.5 + 0.2, swayY: Math.random() * 0.6 + 0.2, phase: Math.random() * Math.PI * 2, drift: Math.random() * 0.9 + 0.2, radius });
  }
  return {
    update(step, time) {
      letters.forEach((letter) => {
        const { mesh } = letter;
        mesh.position.z += step;
        /* letters wander across the corridor instead of running the rails, which
           is what separates them from the streaks flying past behind them */
        const wander = time * letter.drift + letter.phase;
        mesh.position.x += Math.cos(wander) * letter.drift * 0.9;
        mesh.position.y += Math.sin(wander * 0.8) * letter.drift * 0.9;
        mesh.rotation.z += letter.spin;
        mesh.rotation.x = Math.sin(wander * 0.6) * letter.swayX;
        mesh.rotation.y = Math.cos(wander * 0.5) * letter.swayY;
        if (mesh.position.z > LETTER_RECYCLE_Z) {
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * 430 + 60;
          mesh.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, LETTER_RESET_Z);
        }
      });
    },
    setOpacity(_streakOpacity, tileOpacity) {
      if (lastOpacity === tileOpacity) return;
      tints.forEach((tint) => { tint.opacity = tileOpacity; });
      lastOpacity = tileOpacity;
    },
    dispose() {
      geometries.forEach((geometry) => geometry.dispose());
      tints.forEach((tint) => tint.dispose());
      atlas.texture.dispose();
    },
  };
}

/* a box with its top face drawn in, the cheapest read of an injection-moulded cap */
function createKeycapGeometry(width: number, height: number, depth: number): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    if (position.getY(vertex) > 0) position.setXYZ(vertex, position.getX(vertex) * 0.78, position.getY(vertex), position.getZ(vertex) * 0.78);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function createSparkTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.4, "rgba(255,255,255,0.5)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

function createSparkLayer(group: THREE.Group, count: number, size: number, color: number, opacity: number, radiusSpread: number) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * radiusSpread + 20;
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = Math.sin(angle) * radius;
    positions[index * 3 + 2] = (Math.random() - 0.5) * 2000;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const texture = createSparkTexture();
  const material = new THREE.PointsMaterial({ map: texture, color, size, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
  const points = new THREE.Points(geometry, material);
  group.add(points);
  const attribute = geometry.attributes.position as unknown as { needsUpdate: boolean };
  return {
    positions, count, material,
    update(step: number) {
      for (let index = 0; index < count; index += 1) {
        positions[index * 3 + 2] += step;
        if (positions[index * 3 + 2] > RECYCLE_Z) positions[index * 3 + 2] = RESET_Z;
      }
      attribute.needsUpdate = true;
    },
    dispose() { geometry.dispose(); material.dispose(); texture.dispose(); },
  };
}

function createKeycapLayer(scene: THREE.Scene, group: THREE.Group, opacity: number): Layer {
  const atlas = createGlyphAtlas("#ffffff");
  const legendGeometries = createGlyphGeometries(atlas);
  const capGeometry = createKeycapGeometry(26, 14, 26);
  const bodies = [0x3d4844, 0x505c57, 0x2b3431].map((color) => new THREE.MeshLambertMaterial({ color, emissive: 0x03110b, transparent: true, opacity }));
  const legends = [0x9df5cf, 0xffffff].map((color) => new THREE.MeshBasicMaterial({
    map: atlas.texture, color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
  }));
  const ambient = new THREE.AmbientLight(0x0f1a17, 1);
  const key = new THREE.DirectionalLight(0xf4fffb, 1.9);
  key.position.set(0.4, 1, 0.7);
  const rim = new THREE.DirectionalLight(0x34d399, 0.45);
  rim.position.set(-0.7, -0.4, 0.5);
  const flash = new THREE.PointLight(0x10b981, 0.8, 900);
  flash.position.set(0, 0, 140);
  scene.add(ambient, key, rim, flash);
  const caps: Tumbler[] = [];
  let lastOpacity = opacity;
  for (let index = 0; index < 95; index += 1) {
    const mesh = new THREE.Mesh(capGeometry, bodies[Math.floor(Math.random() * bodies.length)]);
    const legend = new THREE.Mesh(legendGeometries[Math.floor(Math.random() * legendGeometries.length)], legends[Math.floor(Math.random() * legends.length)]);
    legend.scale.set(15, 15, 15);
    legend.position.y = 7.2;
    legend.rotation.x = -Math.PI / 2;
    mesh.add(legend);
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 430 + 130;
    mesh.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, CAP_RESET_Z + Math.random() * (CAP_RECYCLE_Z - CAP_RESET_Z));
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    const scale = Math.random() * 1.15 + 0.8;
    mesh.scale.set(scale, scale, scale);
    group.add(mesh);
    caps.push({ mesh, spin: (Math.random() - 0.5) * 0.03, swayX: (Math.random() - 0.5) * 0.026, swayY: (Math.random() - 0.5) * 0.03, phase: 0, drift: 0, radius });
  }
  const sparks = createSparkLayer(group, 750, 7, 0x6ee7b7, opacity, 620);
  return {
    update(step) {
      caps.forEach((cap) => {
        cap.mesh.position.z += step;
        cap.mesh.rotation.x += cap.swayX;
        cap.mesh.rotation.y += cap.swayY;
        cap.mesh.rotation.z += cap.spin;
        /* a cap is a solid volume, so it wraps before it can swallow the lens */
        if (cap.mesh.position.z > CAP_RECYCLE_Z) {
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * 430 + 130;
          cap.mesh.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, CAP_RESET_Z);
        }
      });
      sparks.update(step * 1.35);
    },
    setOpacity(streakOpacity, tileOpacity) {
      if (sparks.material.opacity !== streakOpacity) sparks.material.opacity = streakOpacity;
      if (lastOpacity === tileOpacity) return;
      bodies.forEach((body) => { body.opacity = tileOpacity; });
      legends.forEach((legend) => { legend.opacity = tileOpacity; });
      lastOpacity = tileOpacity;
    },
    dispose() {
      capGeometry.dispose();
      legendGeometries.forEach((geometry) => geometry.dispose());
      bodies.forEach((body) => body.dispose());
      legends.forEach((legend) => legend.dispose());
      atlas.texture.dispose();
      sparks.dispose();
      scene.remove(ambient, key, rim, flash);
    },
  };
}

function createTunnelTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, size, size);
    for (let index = 0; index < 240; index += 1) {
      const x = Math.random() * size;
      const width = Math.random() * 3 + 0.6;
      const height = Math.random() * 320 + 90;
      const top = Math.random() * size;
      const alpha = (Math.random() * 0.45 + 0.08).toFixed(3);
      /* drawn once above and once below the seam so the scrolling wrap is invisible */
      for (const offset of [-size, 0, size]) {
        const gradient = context.createLinearGradient(0, top + offset, 0, top + offset + height);
        gradient.addColorStop(0, "rgba(191,219,254,0)");
        gradient.addColorStop(0.5, `rgba(224,238,255,${alpha})`);
        gradient.addColorStop(1, "rgba(147,197,253,0)");
        context.fillStyle = gradient;
        context.fillRect(x, top + offset, width, height);
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 2);
  return texture;
}

function createGlowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.18, "rgba(219,234,254,0.55)");
    gradient.addColorStop(0.45, "rgba(96,165,250,0.16)");
    gradient.addColorStop(1, "rgba(2,6,23,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

function createHyperspaceLayer(group: THREE.Group, opacity: number): Layer {
  const tunnelTexture = createTunnelTexture();
  const tunnelGeometry = new THREE.CylinderGeometry(900, 240, 3000, 64, 1, true);
  tunnelGeometry.rotateX(Math.PI / 2);
  const tunnelMaterial = new THREE.MeshBasicMaterial({ map: tunnelTexture, side: THREE.BackSide, transparent: true, opacity: opacity * 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
  const tunnel = new THREE.Mesh(tunnelGeometry, tunnelMaterial);
  tunnel.position.z = -1400;
  group.add(tunnel);

  const glowTexture = createGlowTexture();
  const glowMaterial = new THREE.SpriteMaterial({ map: glowTexture, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.Sprite(glowMaterial);
  glow.position.z = -900;
  glow.scale.set(760, 760, 1);
  group.add(glow);
  let lastOpacity = opacity;
  return {
    update(step, time) {
      /* the walls run with the streaks, and a slow roll keeps the jump from
         reading as a still image once the streak rails line up */
      tunnelTexture.offset.y -= step * 0.0016;
      tunnel.rotation.z += 0.0016;
      const pulse = 1 + Math.sin(time * 1.6) * 0.06;
      glow.scale.set(760 * pulse, 760 * pulse, 1);
    },
    setOpacity(_streakOpacity, tileOpacity) {
      if (lastOpacity === tileOpacity) return;
      tunnelMaterial.opacity = tileOpacity * 0.6;
      glowMaterial.opacity = tileOpacity;
      lastOpacity = tileOpacity;
    },
    dispose() {
      tunnelGeometry.dispose();
      tunnelMaterial.dispose();
      tunnelTexture.dispose();
      glowMaterial.dispose();
      glowTexture.dispose();
    },
  };
}

const STREAK_SETTINGS: Record<WarpFieldVariant, StreakSettings> = {
  streaks: { count: 400, radiusMin: 20, radiusSpread: 800, lengthMin: 50, lengthSpread: 150, palette: [0x10b981, 0x059669, 0x34d399, 0xffffff], opacityScale: 1 },
  letters: { count: 260, radiusMin: 20, radiusSpread: 800, lengthMin: 40, lengthSpread: 120, palette: [0x10b981, 0x059669, 0x34d399, 0xffffff], opacityScale: 1 },
  keycaps: { count: 220, radiusMin: 20, radiusSpread: 800, lengthMin: 40, lengthSpread: 140, palette: [0x10b981, 0x34d399, 0xa7f3d0, 0xffffff], opacityScale: 1 },
  hyperspace: { count: 1200, radiusMin: 6, radiusSpread: 760, lengthMin: 170, lengthSpread: 420, palette: [0xffffff, 0xdbeafe, 0x93c5fd, 0x60a5fa, 0xc7d2fe], opacityScale: 1.45 },
};

export function createWarpFieldRenderer(canvas: HTMLCanvasElement, getOptions: () => WarpFieldOptions) {
  const startOptions = getOptions();
  const variant: WarpFieldVariant = WARP_FIELD_VARIANTS.includes(startOptions.variant) ? startOptions.variant : WARP_FIELD_DEFAULTS.variant;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND[variant]);
  scene.fog = new THREE.FogExp2(BACKGROUND[variant], 0.001);
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 2000);
  camera.position.z = 0;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const group = new THREE.Group();
  scene.add(group);

  const layers: Layer[] = [createStreakLayer(group, STREAK_SETTINGS[variant], startOptions.streakOpacity)];
  if (variant === "streaks") layers.push(createTileLayer(group, startOptions.tileOpacity));
  if (variant === "letters") layers.push(createLetterLayer(group, startOptions.tileOpacity));
  if (variant === "keycaps") layers.push(createKeycapLayer(scene, group, startOptions.tileOpacity));
  if (variant === "hyperspace") layers.push(createHyperspaceLayer(group, startOptions.tileOpacity));

  let elapsed = 0;
  return {
    resize(width: number, height: number) {
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    },
    render() {
      const options = getOptions();
      if (camera.fov !== options.fov) {
        camera.fov = options.fov;
        camera.updateProjectionMatrix();
      }
      elapsed += 1 / 60;
      const step = options.speed * SPEED_SCALE[variant];
      layers.forEach((layer) => {
        layer.setOpacity?.(options.streakOpacity, options.tileOpacity);
        layer.update?.(step, elapsed);
      });
      renderer.render(scene, camera);
    },
    dispose() {
      layers.forEach((layer) => layer.dispose());
      renderer.dispose();
    },
  };
}
