import * as THREE from "three128";

export type OrbitalSphereOptions = { speed: number; particleSize: number; particleOpacity: number; orbitOpacity: number; scale: number; haloOpacity: number; hue: number };
export const ORBITAL_SPHERE_DEFAULTS: OrbitalSphereOptions = { speed: 1, particleSize: 0.015, particleOpacity: 0.8, orbitOpacity: 0.25, scale: 1, haloOpacity: 0.2, hue: 0 };

export function createOrbitalSphereRenderer(canvas: HTMLCanvasElement, getOptions: () => OrbitalSphereOptions) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const networkGroup = new THREE.Group(); scene.add(networkGroup);
  const radius = 2.2, particleCount = 15000;
  const positions = new Float32Array(particleCount * 3), colors = new Float32Array(particleCount * 3);
  const colorBright = new THREE.Color(0xa78bfa), colorDim = new THREE.Color(0x701a75);
  let validIndex = 0;
  for (let index = 0; index < particleCount; index += 1) {
    const phi = Math.acos(-1 + (2 * index) / particleCount), theta = Math.sqrt(particleCount * Math.PI) * phi;
    const x = radius * Math.cos(theta) * Math.sin(phi), y = radius * Math.sin(theta) * Math.sin(phi), z = radius * Math.cos(phi);
    const noise = Math.sin(x * 3.5) * Math.cos(y * 3.5) * Math.sin(z * 3.5) + Math.cos(x * 6) * 0.4;
    if (noise <= -0.1) continue;
    const distortion = 1 + noise * 0.1;
    positions[validIndex * 3] = x * distortion; positions[validIndex * 3 + 1] = y * distortion; positions[validIndex * 3 + 2] = z * distortion;
    const mixedColor = colorDim.clone().lerp(colorBright, noise > 0.5 ? 1 : 0.3);
    colors[validIndex * 3] = mixedColor.r; colors[validIndex * 3 + 1] = mixedColor.g; colors[validIndex * 3 + 2] = mixedColor.b; validIndex += 1;
  }
  const particleGeometry = new THREE.BufferGeometry(); particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions.slice(0, validIndex * 3), 3)); particleGeometry.setAttribute("color", new THREE.BufferAttribute(colors.slice(0, validIndex * 3), 3));
  const particleMaterial = new THREE.PointsMaterial({ size: 0.015, vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }); networkGroup.add(new THREE.Points(particleGeometry, particleMaterial));
  const orbitMaterial = new THREE.LineBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending });
  const orbitGeometries: THREE.BufferGeometry[] = [], nodeGeometries: THREE.BufferGeometry[] = [], nodeMaterials: THREE.Material[] = [], haloMaterials: THREE.MeshBasicMaterial[] = [];
  let responsiveScale = 1;
  for (let index = 0; index < 6; index += 1) {
    const geometry = new THREE.BufferGeometry(), points: number[] = [], orbitRadius = radius * (1.08 + Math.random() * 0.2);
    for (let point = 0; point <= 90; point += 1) { const angle = (point / 90) * Math.PI * 2; points.push(Math.cos(angle) * orbitRadius, Math.sin(angle) * orbitRadius, Math.sin(angle * 4) * 0.1); }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3)); orbitGeometries.push(geometry);
    const line = new THREE.Line(geometry, orbitMaterial); line.rotation.x = Math.random() * Math.PI * 2; line.rotation.y = Math.random() * Math.PI * 2; networkGroup.add(line);
    if (index % 2 !== 0) {
      const nodeGeometry = new THREE.SphereGeometry(0.025, 16, 16), nodeMaterial = new THREE.MeshBasicMaterial({ color: 0xd946ef }), node = new THREE.Mesh(nodeGeometry, nodeMaterial); const angle = Math.random() * Math.PI * 2; node.position.set(Math.cos(angle) * orbitRadius, Math.sin(angle) * orbitRadius, 0); line.add(node);
      const haloGeometry = new THREE.SphereGeometry(0.08, 16, 16), haloMaterial = new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending }), halo = new THREE.Mesh(haloGeometry, haloMaterial); node.add(halo);
      nodeGeometries.push(nodeGeometry, haloGeometry); nodeMaterials.push(nodeMaterial, haloMaterial); haloMaterials.push(haloMaterial);
    }
  }
  return {
    resize(width: number, height: number) {
      camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix(); renderer.setSize(width, height, false);
      const options = getOptions();
      if (width >= 1024) { networkGroup.position.set(2.5, 0, -2); responsiveScale = 1.15; camera.position.z = 5.5; }
      else { networkGroup.position.set(0, -1, -3); responsiveScale = 1; camera.position.z = 6.5; }
      networkGroup.scale.setScalar(responsiveScale * options.scale);
    },
    render() {
      const options = getOptions(); particleMaterial.size = options.particleSize; particleMaterial.opacity = options.particleOpacity; orbitMaterial.opacity = options.orbitOpacity; haloMaterials.forEach((material) => material.opacity = options.haloOpacity); networkGroup.scale.setScalar(responsiveScale * options.scale);
      networkGroup.rotation.y += 0.0008 * options.speed; networkGroup.rotation.x += 0.0003 * options.speed;
      networkGroup.children.forEach((child: THREE.Object3D, index: number) => { if (child.type === "Line") child.rotation.z += 0.0004 * options.speed * (index % 2 === 0 ? 1 : -1); }); renderer.render(scene, camera);
    },
    dispose() { particleGeometry.dispose(); particleMaterial.dispose(); orbitMaterial.dispose(); orbitGeometries.forEach((item) => item.dispose()); nodeGeometries.forEach((item) => item.dispose()); nodeMaterials.forEach((item) => item.dispose()); renderer.dispose(); },
  };
}
