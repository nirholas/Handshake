// Procedural water shader — shared by every water body /play renders (the
// fishing ponds today; any lake/canal a later brief adds can reuse it).
//
// No texture, no extra render pass: the surface geometry stays a flat disc
// (cheap, no tessellation needed) and all of the "water" reads — rippling
// highlights, a fresnel sky-tint at grazing angles, a deep→shallow gradient —
// come from a fake bump normal derived analytically from a layered sine field
// evaluated in world space each fragment. That's the same trick stylised
// water in shipped games uses instead of a real-time planar reflection, which
// would cost a second scene render per pond and a normal-map asset neither of
// which this world has budget for.
//
// uSunDir/uSunColor are meant to be kept live from the world's own
// DirectionalLight (see play-systems.js `_buildPond`/`tick`) so the sparkle
// tracks the day/night cycle instead of a baked-in highlight.

export const WATER_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
	vUv = uv;
	vec4 wp = modelMatrix * vec4(position, 1.0);
	vWorldPos = wp.xyz;
	gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const WATER_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPhase;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform float uOpacity;

varying vec2 vUv;
varying vec3 vWorldPos;

// Layered sine field standing in for a real wave simulation — four waves at
// different frequency/speed/direction so the surface never reads as tiled.
float waveHeight(vec2 p, float t) {
	float w = 0.0;
	w += sin(p.x * 1.35 + t * 1.7) * 0.6;
	w += sin(p.y * 1.9 - t * 1.15) * 0.45;
	w += sin((p.x + p.y) * 0.85 + t * 0.65) * 0.5;
	w += sin((p.x - p.y) * 2.6 + t * 2.4) * 0.2;
	return w;
}

void main() {
	vec2 wp = vWorldPos.xz;
	float t = uTime + uPhase;

	// Finite-difference the height field for a shading normal — never touches
	// the actual vertex position, so the low-poly disc stays perfectly flat.
	float e = 0.35;
	float h0 = waveHeight(wp, t);
	float hx = waveHeight(wp + vec2(e, 0.0), t);
	float hy = waveHeight(wp + vec2(0.0, e), t);
	vec3 bump = normalize(vec3(-(hx - h0), e * 3.2, -(hy - h0)));
	vec3 N = normalize(mix(vec3(0.0, 1.0, 0.0), bump, 0.85));

	vec3 V = normalize(cameraPosition - vWorldPos);
	vec3 L = normalize(uSunDir);
	vec3 H = normalize(L + V);

	float fresnel = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
	float edge = clamp(length(vUv - 0.5) * 2.0, 0.0, 1.0);
	vec3 base = mix(uDeep, uShallow, edge * edge * 0.6);

	float spec = pow(max(dot(N, H), 0.0), 70.0);
	float sparkle = pow(max(dot(N, H), 0.0), 340.0) * 2.2;

	vec3 color = mix(base, uSkyColor, fresnel * 0.5);
	color += uSunColor * (spec * 0.35 + sparkle);

	float alpha = clamp(uOpacity + fresnel * 0.08, 0.0, 1.0);
	gl_FragColor = vec4(color, alpha);
}
`;
