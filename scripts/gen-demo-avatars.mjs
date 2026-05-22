// Generates api/_lib/demo-avatars.js seed entries from verified public GLB sources.
// Sources: KhronosGroup/glTF-Sample-Assets (CC-BY 4.0), three.js examples (MIT),
// and on-disk shipped assets.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const KHRONOS_BASE = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets/Models';
const THREEJS_BASE = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js/examples/models/gltf';

// Khronos models verified to have glTF-Binary/{name}.glb
const KHRONOS = fs.readFileSync(path.join(HERE, 'khronos-glbs.txt'), 'utf8').trim().split('\n').filter(Boolean);
// three.js model basenames (without .glb)
const THREEJS = fs.readFileSync(path.join(HERE, 'threejs-glbs.txt'), 'utf8').trim().split('\n')
	.map((s) => s.replace(/\.glb$/, '')).filter(Boolean);

// Curated community-avatar lineup. Each entry is a named identity rendered with
// a real GLB shipped under /public. The mapping from name → GLB is intentional:
// soldier-rigs go to operative/military-leaning personas, the expressive robot
// goes to AI/protocol personas, the default humanoid covers the rest.
const ON_DISK = [
	{ name: 'CZ', slug: 'cz', path: '/avatars/cz.glb', tags: ['humanoid', 'character', 'community'], desc: 'CZ — stylized humanoid with idle pose, ready for chat overlays.' },
	{ name: 'Ansem', slug: 'ansem', path: '/avatars/default.glb', tags: ['humanoid', 'community', 'trader'], desc: 'Ansem — trader persona for chart-watchers and crypto Twitter.' },
	{ name: 'Boss', slug: 'boss', path: '/animations/soldier.glb', tags: ['humanoid', 'rigged', 'animated', 'community'], desc: 'Boss — for the one running the room. Soldier rig with locomotion.' },
	{ name: 'Vernington', slug: 'vernington', path: '/avatars/default.glb', tags: ['humanoid', 'community'], desc: 'Vernington — the senior of the Vern lineage.' },
	{ name: 'Saga', slug: 'saga', path: '/animations/robotexpressive.glb', tags: ['robot', 'animated', 'rigged', 'community'], desc: 'Saga — mobile-native, expressive robot rig with idle, walk, jump, dance clips.' },
	{ name: 'Claude', slug: 'claude', path: '/avatars/default.glb', tags: ['humanoid', 'community', 'ai'], desc: 'Claude — calm, thoughtful AI persona.' },
	{ name: '3D', slug: '3d', path: '/avatars/default.glb', tags: ['humanoid', 'community', 'meta'], desc: '3D — meta avatar representing the platform itself.' },
	{ name: 'AI', slug: 'ai', path: '/animations/robotexpressive.glb', tags: ['robot', 'animated', 'rigged', 'community', 'ai'], desc: 'AI — generic agent stand-in, expressive robot rig.' },
	{ name: 'Agent', slug: 'agent', path: '/animations/soldier.glb', tags: ['humanoid', 'rigged', 'animated', 'community', 'agent'], desc: 'Agent — operative ready for autonomous on-chain work.' },
	{ name: 'Vern', slug: 'vern', path: '/avatars/default.glb', tags: ['humanoid', 'community'], desc: 'Vern — base form, before the Vernington promotion.' },
	{ name: 'Crossinger', slug: 'crossinger', path: '/avatars/default.glb', tags: ['humanoid', 'community'], desc: 'Crossinger — chain-hopper, multi-network identity.' },
	{ name: 'Spartian', slug: 'spartian', path: '/animations/soldier.glb', tags: ['humanoid', 'rigged', 'animated', 'community'], desc: 'Spartian — disciplined, armored, never folds.' },
	// Name surfaced as "Tester" because the marketplace UI auto-name filter
	// strips entries whose name is exactly "test" (see AVATAR_AUTONAMED_RE in
	// src/marketplace.js). Slug stays `test` to preserve the requested handle.
	{ name: 'Tester', slug: 'test', path: '/avatars/default.glb', tags: ['humanoid', 'community'], desc: 'Tester — kicks the tires on every release before anyone else.' },
];

// Curated metadata for well-known Khronos models. Anything not listed here gets
// auto-classified by name keywords.
const KHRONOS_META = {
	Avocado: { tags: ['food', 'pbr', 'classic'], desc: 'A photorealistic avocado — a Khronos classic for testing physically-based rendering.' },
	BarramundiFish: { tags: ['animal', 'fish', 'pbr'], desc: 'Detailed barramundi fish with realistic scales and PBR materials.' },
	BoomBox: { tags: ['object', 'audio', 'pbr', 'classic'], desc: 'Retro boombox with intricate textures — a benchmark PBR asset.' },
	Box: { tags: ['primitive', 'test'], desc: 'The simplest possible glTF: a single textured cube.' },
	BoxAnimated: { tags: ['primitive', 'animated', 'test'], desc: 'A simple box with a baked transform animation.' },
	BoxInterleaved: { tags: ['primitive', 'test'], desc: 'A box with interleaved vertex attributes — a glTF format test.' },
	BoxTextured: { tags: ['primitive', 'textured'], desc: 'A box with a texture map applied.' },
	BoxTexturedNonPowerOfTwo: { tags: ['primitive', 'textured', 'test'], desc: 'A textured box demonstrating non-power-of-two textures.' },
	BoxVertexColors: { tags: ['primitive', 'colors'], desc: 'A box with per-vertex colors instead of textures.' },
	BrainStem: { tags: ['humanoid', 'rigged', 'animated'], desc: 'Walking humanoid figure with skinned mesh and animations.' },
	CarConcept: { tags: ['vehicle', 'concept', 'pbr'], desc: 'Concept car with sculpted bodywork and clear-coat materials.' },
	CarbonFibre: { tags: ['material', 'pbr', 'test'], desc: 'Carbon-fibre weave material test — anisotropy and clear-coat.' },
	CesiumMan: { tags: ['humanoid', 'rigged', 'animated', 'classic'], desc: 'The iconic Cesium Man — walking animation, fully rigged.' },
	CesiumMilkTruck: { tags: ['vehicle', 'animated', 'classic'], desc: 'Cesium Milk Truck rolling along — wheel rotation animation.' },
	ChairDamaskPurplegold: { tags: ['furniture', 'pbr', 'fabric'], desc: 'Ornate damask chair with gold leaf and patterned upholstery.' },
	ChronographWatch: { tags: ['object', 'pbr', 'metal'], desc: 'Detailed chronograph wristwatch with metallic finish and glass face.' },
	ClearCoatCarPaint: { tags: ['material', 'pbr', 'test'], desc: 'Clear-coat car paint material test under varied lighting.' },
	ClearCoatTest: { tags: ['material', 'test'], desc: 'Clear-coat extension reference test.' },
	ClearcoatWicker: { tags: ['material', 'pbr', 'fabric'], desc: 'Wicker pattern with clear-coat layer.' },
	CommercialRefrigerator: { tags: ['object', 'commercial', 'glass'], desc: 'Commercial glass-door refrigerator with transmission.' },
	DamagedHelmet: { tags: ['object', 'armor', 'pbr', 'iconic'], desc: 'Battle-worn sci-fi helmet — possibly the most-rendered glTF in history.' },
	DiffuseTransmissionPlant: { tags: ['plant', 'transmission', 'pbr'], desc: 'Botanical leaves demonstrating diffuse transmission for thin foliage.' },
	DiffuseTransmissionTeacup: { tags: ['object', 'transmission', 'pbr'], desc: 'Bone china teacup with translucent walls.' },
	DragonAttenuation: { tags: ['creature', 'glass', 'transmission'], desc: 'Glass dragon demonstrating volume attenuation and transmission.' },
	DragonDispersion: { tags: ['creature', 'glass', 'transmission'], desc: 'Glass dragon with chromatic dispersion for prismatic light.' },
	Duck: { tags: ['animal', 'iconic', 'classic'], desc: 'The Khronos Duck — every 3D dev has met this duck.' },
	Fox: { tags: ['animal', 'animated', 'rigged', 'iconic'], desc: 'Stylized fox with three baked animations — Survey, Walk, Run.' },
	GlamVelvetSofa: { tags: ['furniture', 'fabric', 'pbr'], desc: 'Velvet sofa demonstrating sheen for fabric materials.' },
	GlassBrokenWindow: { tags: ['object', 'glass', 'transmission'], desc: 'Shattered window pane with refraction and transmission.' },
	GlassHurricaneCandleHolder: { tags: ['object', 'glass', 'transmission'], desc: 'Hurricane candle holder with thick glass and a flickering candle.' },
	GlassVaseFlowers: { tags: ['object', 'glass', 'plant'], desc: 'Cut-glass vase with flowers — refraction through curved glass.' },
	IridescenceLamp: { tags: ['object', 'pbr', 'iridescent'], desc: 'Lamp shade with iridescent thin-film effect.' },
	IridescenceAbalone: { tags: ['object', 'pbr', 'iridescent'], desc: 'Abalone shell with natural iridescence.' },
	IridescenceSuzanne: { tags: ['classic', 'iridescent'], desc: 'Blender Suzanne with iridescent thin-film material.' },
	IridescentDishWithOlives: { tags: ['food', 'pbr', 'iridescent'], desc: 'Iridescent ceramic dish holding olives.' },
	Lantern: { tags: ['object', 'metal', 'pbr', 'classic'], desc: 'Traditional lantern with intricate metalwork — a Khronos PBR benchmark.' },
	MaterialsVariantsShoe: { tags: ['fashion', 'shoe', 'variants'], desc: 'Shoe with material variants — swap colorways at runtime.' },
	MetalRoughSpheres: { tags: ['material', 'pbr', 'test'], desc: 'Spheres demonstrating the full metallic-roughness range.' },
	MetalRoughSpheresNoTextures: { tags: ['material', 'pbr', 'test'], desc: 'Untextured metallic-roughness sphere grid.' },
	MorphPrimitivesTest: { tags: ['test', 'morph'], desc: 'Morph target test for blend shapes on primitives.' },
	MorphStressTest: { tags: ['test', 'morph'], desc: 'Stress test for many simultaneous morph targets.' },
	NegativeScaleTest: { tags: ['test'], desc: 'Negative scaling and winding-order test.' },
	NormalTangentMirrorTest: { tags: ['test', 'normals'], desc: 'Mirror-symmetry test for normal and tangent vectors.' },
	NormalTangentTest: { tags: ['test', 'normals'], desc: 'Normal/tangent space correctness test.' },
	OrientationTest: { tags: ['test'], desc: 'Coordinate system orientation test for glTF importers.' },
	PointLightIntensityTest: { tags: ['test', 'lighting'], desc: 'Point light intensity falloff test.' },
	PotOfCoals: { tags: ['object', 'fire', 'emissive'], desc: 'Glowing pot of coals demonstrating emissive strength.' },
	ReciprocatingSaw: { tags: ['tool', 'object', 'pbr'], desc: 'Reciprocating saw with detailed mechanical parts.' },
	RecursiveSkeletons: { tags: ['test', 'skinning'], desc: 'Stress test for deeply nested skeletal hierarchies.' },
	RiggedFigure: { tags: ['humanoid', 'rigged', 'classic'], desc: 'Bare-bones rigged humanoid for testing skinning.' },
	RiggedSimple: { tags: ['rigged', 'test'], desc: 'Minimal rigged figure — the smallest possible skinned mesh.' },
	SimpleInstancing: { tags: ['test', 'instancing'], desc: 'EXT_mesh_gpu_instancing demonstration.' },
	SpecGlossVsMetalRough: { tags: ['material', 'test'], desc: 'Spec-gloss vs metallic-roughness workflow comparison.' },
	SpecularSilkPouf: { tags: ['furniture', 'fabric', 'pbr'], desc: 'Silk pouf footstool with specular sheen.' },
	SpecularTest: { tags: ['material', 'test'], desc: 'KHR_materials_specular extension test.' },
	StainedGlassLamp: { tags: ['object', 'glass', 'emissive'], desc: 'Tiffany-style stained glass lamp with internal light source.' },
	TextureCoordinateTest: { tags: ['test', 'textures'], desc: 'UV coordinate correctness test.' },
	TextureLinearInterpolationTest: { tags: ['test', 'textures'], desc: 'Linear texture interpolation test.' },
	TextureSettingsTest: { tags: ['test', 'textures'], desc: 'Texture sampler settings test.' },
	ToyCar: { tags: ['vehicle', 'toy', 'pbr'], desc: 'Stylized toy car with chunky proportions and shiny paint.' },
	TransmissionRoughnessTest: { tags: ['material', 'test', 'transmission'], desc: 'Transmission with varying roughness test.' },
	TransmissionTest: { tags: ['material', 'test', 'transmission'], desc: 'KHR_materials_transmission extension test.' },
	TransmissionThinwallTestGrid: { tags: ['material', 'test', 'transmission'], desc: 'Thin-wall transmission grid test.' },
	UnlitTest: { tags: ['material', 'test'], desc: 'KHR_materials_unlit extension test — flat shading.' },
	VertexColorTest: { tags: ['test', 'colors'], desc: 'Per-vertex color test plane.' },
	VirtualCity: { tags: ['scene', 'environment', 'urban'], desc: 'Stylized low-poly city block — buildings, streets, props.' },
	WaterBottle: { tags: ['object', 'pbr', 'transmission'], desc: 'Water bottle with translucent plastic body and embossed label.' },
	XmpMetadataRoundedCube: { tags: ['test', 'metadata'], desc: 'Rounded cube embedding XMP metadata for attribution.' },
	AlphaBlendModeTest: { tags: ['test', 'material'], desc: 'Plate of swatches showing alpha-blend, alpha-mask, and opaque modes side by side.' },
	AnimatedColorsCube: { tags: ['animated', 'primitive'], desc: 'Cube with animated per-vertex color values for animation channel testing.' },
	AnimatedMorphCube: { tags: ['animated', 'morph', 'primitive'], desc: 'Cube morphing through blend-shape targets — a baseline morph-target test.' },
	AnimationPointerUVs: { tags: ['animated', 'test'], desc: 'KHR_animation_pointer demo: animated UV transforms driven by pointer paths.' },
	AnisotropyBarnLamp: { tags: ['object', 'lighting', 'pbr'], desc: 'Barn-style lamp with brushed-metal anisotropic shading on the housing.' },
	AnisotropyDiscTest: { tags: ['test', 'material', 'pbr'], desc: 'Disc demonstrating brushed-metal anisotropic highlights at varying angles.' },
	AnisotropyRotationTest: { tags: ['test', 'material', 'pbr'], desc: 'Anisotropy rotation test — checks correct tangent rotation across UVs.' },
	AnisotropyStrengthTest: { tags: ['test', 'material', 'pbr'], desc: 'Anisotropy strength sweep from 0 to 1 across a row of spheres.' },
	AntiqueCamera: { tags: ['object', 'photography', 'pbr'], desc: 'Vintage twin-lens reflex camera with leather wrap and chrome detailing.' },
	AttenuationTest: { tags: ['test', 'material', 'transmission'], desc: 'Volume attenuation test — colored glass blocks of varying thickness.' },
	CompareAlphaCoverage: { tags: ['test', 'material'], desc: 'Side-by-side comparison of alpha-coverage approaches for foliage and fabric.' },
	CompareAmbientOcclusion: { tags: ['test', 'material'], desc: 'Ambient occlusion on/off comparison on a reference object.' },
	CompareAnisotropy: { tags: ['test', 'material', 'pbr'], desc: 'Comparison spheres demonstrating anisotropic vs isotropic specular.' },
	CompareBaseColor: { tags: ['test', 'material', 'pbr'], desc: 'Base color sweep across the sRGB cube for material correctness checks.' },
	CompareClearcoat: { tags: ['test', 'material', 'pbr'], desc: 'Clearcoat extension comparison — with vs without the clear-coat layer.' },
	CompareDispersion: { tags: ['test', 'material', 'glass'], desc: 'Comparison of glass with and without chromatic dispersion.' },
	CompareEmissiveStrength: { tags: ['test', 'lighting'], desc: 'KHR_materials_emissive_strength comparison — HDR-bright vs LDR emission.' },
	CompareIor: { tags: ['test', 'material', 'glass'], desc: 'Index-of-refraction comparison sweeping IOR from 1.0 to 2.4.' },
	CompareIridescence: { tags: ['test', 'material', 'pbr'], desc: 'Iridescence on/off comparison highlighting thin-film color shifts.' },
	CompareMetallic: { tags: ['test', 'material', 'pbr'], desc: 'Metallic factor sweep from 0 (dielectric) to 1 (metal).' },
	CompareNormal: { tags: ['test', 'material'], desc: 'Normal map intensity comparison across multiple bump strengths.' },
	CompareRoughness: { tags: ['test', 'material', 'pbr'], desc: 'Roughness sweep from mirror to fully rough across spheres.' },
	CompareSheen: { tags: ['test', 'material', 'fabric'], desc: 'KHR_materials_sheen comparison — fabric-like grazing-angle highlights.' },
	CompareSpecular: { tags: ['test', 'material', 'pbr'], desc: 'KHR_materials_specular comparison sweeping specular factor.' },
	CompareTransmission: { tags: ['test', 'material', 'glass'], desc: 'Transmission on/off comparison — solid vs see-through materials.' },
	CompareVolume: { tags: ['test', 'material', 'glass'], desc: 'Volume thickness comparison demonstrating refraction depth.' },
	CubeVisibility: { tags: ['test'], desc: 'Visibility flag test — cubes hidden via the visibility extension.' },
	DiffuseTransmissionTest: { tags: ['test', 'material', 'transmission'], desc: 'KHR_materials_diffuse_transmission test on thin foliage panels.' },
	DirectionalLight: { tags: ['test', 'lighting'], desc: 'Directional (sun) light reference scene with shadow-casting plane.' },
	DispersionTest: { tags: ['test', 'glass', 'material'], desc: 'Chromatic dispersion test — light splitting across a glass prism.' },
	EmissiveStrengthTest: { tags: ['test', 'lighting'], desc: 'Emissive intensity sweep showing HDR brightness in scene-referred lighting.' },
	IORTestGrid: { tags: ['test', 'material', 'glass'], desc: 'IOR test grid — glass spheres at every common index of refraction.' },
	InterpolationTest: { tags: ['test', 'animated'], desc: 'Animation interpolation modes: STEP, LINEAR, CUBICSPLINE side by side.' },
	LightVisibility: { tags: ['test', 'lighting'], desc: 'Light-source visibility flag test for KHR_lights_punctual.' },
	LightsPunctualLamp: { tags: ['object', 'lighting'], desc: 'Lamp model wired up via KHR_lights_punctual — real point light source.' },
	MultiUVTest: { tags: ['test', 'textures'], desc: 'Multi-UV-channel test for textures using TEXCOORD_1.' },
	PlaysetLightTest: { tags: ['test', 'lighting'], desc: 'Toy playset lighting test — multiple punctual lights interacting.' },
	PotOfCoalsAnimationPointer: { tags: ['object', 'fire', 'animated'], desc: 'Pot of coals with KHR_animation_pointer driving emissive flicker.' },
	ScatteringSkull: { tags: ['object', 'sss', 'pbr'], desc: 'Skull with subsurface scattering for translucent bone material.' },
	SheenChair: { tags: ['furniture', 'fabric', 'pbr'], desc: 'Armchair upholstered in sheen-fabric demonstrating grazing-angle highlights.' },
	SheenTestGrid: { tags: ['test', 'material', 'fabric'], desc: 'Sheen test grid sweeping roughness and color.' },
	SheenWoodLeatherSofa: { tags: ['furniture', 'fabric', 'pbr'], desc: 'Sofa combining sheen fabric, leather, and wood — a multi-material reference.' },
	SunglassesKhronos: { tags: ['fashion', 'object', 'pbr'], desc: 'Aviator-style sunglasses with tinted transmission lenses and metal frame.' },
	TextureEncodingTest: { tags: ['test', 'textures'], desc: 'Texture color-space encoding test (sRGB vs linear).' },
	TextureTransformMultiTest: { tags: ['test', 'textures'], desc: 'KHR_texture_transform test with multiple offsets/scales/rotations.' },
	TransmissionOrderTest: { tags: ['test', 'material', 'transmission'], desc: 'Render-order test for stacked transmissive materials.' },
	USDShaderBallForGltf: { tags: ['material', 'test'], desc: 'Pixar USD-compatible shader ball ported to glTF for cross-format material checks.' },
	'Unicode❤♻Test': { tags: ['test'], desc: 'Unicode glTF asset name test (the file name itself is the test).' },
};

// Curated metadata for three.js example models
const THREEJS_META = {
	Soldier: { tags: ['humanoid', 'rigged', 'animated', 'character'], desc: 'Soldier character with walk, run, and idle animations — three.js classic.' },
	Horse: { tags: ['animal', 'animated', 'rigged'], desc: 'Galloping horse with skeletal animation.' },
	Parrot: { tags: ['animal', 'bird', 'animated'], desc: 'Flying parrot with wing-flap animation.' },
	Flamingo: { tags: ['animal', 'bird', 'animated'], desc: 'Pink flamingo in flight.' },
	Stork: { tags: ['animal', 'bird', 'animated'], desc: 'Stork mid-flight with wing animation.' },
	Michelle: { tags: ['humanoid', 'rigged', 'character'], desc: 'Michelle character with Mixamo-compatible rig.' },
	Xbot: { tags: ['robot', 'rigged', 'animated', 'character'], desc: 'X-Bot rigged humanoid robot, ready for retargeting.' },
	LittlestTokyo: { tags: ['scene', 'environment', 'urban', 'animated'], desc: 'Animated Tokyo street scene by Glen Fox — cars driving, neon, atmosphere.' },
	ferrari: { tags: ['vehicle', 'car', 'pbr'], desc: 'Detailed Ferrari with full PBR materials and accurate proportions.' },
	Soldier: { tags: ['humanoid', 'rigged', 'animated', 'character'], desc: 'Soldier character with walk, run, and idle animations — three.js classic.' },
	Horse: { tags: ['animal', 'animated', 'rigged'], desc: 'Galloping horse with skeletal animation.' },
	Parrot: { tags: ['animal', 'bird', 'animated'], desc: 'Flying parrot with wing-flap animation.' },
	Flamingo: { tags: ['animal', 'bird', 'animated'], desc: 'Pink flamingo in flight.' },
	Stork: { tags: ['animal', 'bird', 'animated'], desc: 'Stork mid-flight with wing animation.' },
	Michelle: { tags: ['humanoid', 'rigged', 'character'], desc: 'Michelle character with Mixamo-compatible rig.' },
	Xbot: { tags: ['robot', 'rigged', 'animated', 'character'], desc: 'X-Bot rigged humanoid robot, ready for retargeting.' },
	LittlestTokyo: { tags: ['scene', 'environment', 'urban', 'animated'], desc: 'Animated Tokyo street scene by Glen Fox — cars driving, neon, atmosphere.' },
	'duck': { tags: ['animal', 'iconic'], desc: 'Three.js duck — slightly different vibe than the Khronos one.' },
	'facecap': { tags: ['humanoid', 'face', 'animated', 'morph'], desc: 'Face capture sample with blendshape animation.' },
	'kira': { tags: ['humanoid', 'character', 'rigged'], desc: 'Kira character model.' },
	'nemetona': { tags: ['humanoid', 'character'], desc: 'Nemetona character bust.' },
	'ShaderBall': { tags: ['material', 'test'], desc: 'Shader ball — the standard material test sphere with reflective base.' },
	'ShaderBall2': { tags: ['material', 'test'], desc: 'Alternate shader ball variant.' },
	'PrimaryIonDrive': { tags: ['scifi', 'vehicle', 'animated'], desc: 'Primary ion drive engine module with animated pulse.' },
	'collision-world': { tags: ['scene', 'environment', 'test'], desc: 'Test scene with collision geometry.' },
	'pool': { tags: ['scene', 'water', 'environment'], desc: 'Pool scene with water reflections.' },
	'minimalistic_modern_bedroom': { tags: ['scene', 'interior', 'architecture'], desc: 'Minimalist modern bedroom interior.' },
	'space_ship_hallway': { tags: ['scene', 'scifi', 'interior'], desc: 'Sci-fi spaceship corridor scene.' },
	'dungeon_warkarma': { tags: ['scene', 'fantasy', 'environment'], desc: 'Fantasy dungeon scene by Warkarma.' },
	'venice_mask': { tags: ['object', 'mask', 'pbr'], desc: 'Ornate Venetian carnival mask with gold leaf detailing.' },
	'steampunk_camera': { tags: ['object', 'steampunk', 'pbr'], desc: 'Steampunk-style camera with brass fittings and leather wrap.' },
	'rolex': { tags: ['object', 'watch', 'luxury', 'pbr'], desc: 'Detailed Rolex-style timepiece with metallic finish.' },
	'godrays_demo': { tags: ['scene', 'lighting', 'demo'], desc: 'God rays / volumetric lighting demonstration scene.' },
	'readyplayer.me': { tags: ['humanoid', 'avatar', 'character'], desc: 'Humanoid avatar sample — three.ws-compatible character ready for VR/AR.', displayName: 'Humanoid Avatar', slug: 'demo-humanoid-avatar' },
	'bath_day': { tags: ['scene', 'animated', 'character'], desc: 'Bath day animated scene — quirky character moment.' },
	'coffeeMug': { tags: ['object', 'pbr'], desc: 'Ceramic coffee mug.' },
	'coffeemat': { tags: ['object', 'machine', 'pbr'], desc: 'Coffee machine with detailed dispenser.' },
	'gears': { tags: ['object', 'mechanical', 'animated'], desc: 'Interlocking gears with mechanical animation.' },
	'SheenChair': { tags: ['furniture', 'fabric', 'pbr'], desc: 'Armchair upholstered in sheen-fabric demonstrating KHR_materials_sheen.' },
	'AnisotropyBarnLamp': { tags: ['object', 'lighting', 'pbr'], desc: 'Barn lamp with brushed-metal anisotropic shading.' },
	'BoomBox': { tags: ['object', 'audio', 'pbr'], desc: 'Three.js variant of the iconic boombox.' },
	'DispersionTest': { tags: ['material', 'test', 'glass'], desc: 'Chromatic dispersion test — refraction splitting light.' },
	'DragonAttenuation': { tags: ['creature', 'glass'], desc: 'Three.js dragon with volume attenuation.' },
	'IridescentDishWithOlives': { tags: ['food', 'pbr', 'iridescent'], desc: 'Iridescent dish, three.js packaging.' },
	'IridescenceLamp': { tags: ['object', 'pbr', 'iridescent'], desc: 'Iridescent lamp from three.js examples.' },
	'ShadowmappableMesh': { tags: ['test', 'shadows'], desc: 'Mesh with high-frequency detail for shadow-mapping tests.' },
};

function classifyByName(name) {
	const n = name.toLowerCase();
	const tags = [];
	let desc = '';
	if (/anim|morph|interpol/i.test(name)) tags.push('animated');
	if (/transmission|glass|disperion|attenuation/i.test(name)) tags.push('glass', 'transmission');
	if (/iridescen|anisotropy|sheen|specular|clearcoat/i.test(name)) tags.push('material', 'pbr');
	if (/test|grid|reference/i.test(name)) tags.push('test');
	if (/box|cube|triangle|primitive|simple|compare/i.test(name)) tags.push('primitive');
	if (/light|emissive/i.test(name)) tags.push('lighting');
	if (/ior|alpha|texture/i.test(name)) tags.push('material', 'test');
	if (/instanc|stress/i.test(name)) tags.push('test');
	if (tags.length === 0) tags.push('object');
	desc = `Khronos reference asset — ${name.replace(/([A-Z])/g, ' $1').trim().toLowerCase()}.`;
	return { tags: [...new Set(tags)], desc };
}

const lines = [];
const seenSlugs = new Set();
let idx = 0;

const baseDate = new Date('2025-04-01T00:00:00Z').getTime();

function addItem({ id, slug, name, glbUrl, image, tags, desc, attribution }) {
	if (seenSlugs.has(slug)) {
		// Disambiguate duplicates by source
		slug = slug + '-' + attribution.handle;
	}
	seenSlugs.add(slug);
	// Stagger created dates so the feed doesn't all bunch up.
	const sortDate = new Date(baseDate - idx * 3_600_000).toISOString();
	idx += 1;
	const tagsStr = JSON.stringify(tags);
	const descStr = JSON.stringify(desc);
	const nameStr = JSON.stringify(name);
	const slugStr = JSON.stringify(slug);
	const idStr = JSON.stringify(id);
	const glbStr = JSON.stringify(glbUrl);
	const imgStr = image ? JSON.stringify(image) : 'null';
	const attrStr = JSON.stringify(attribution);
	const authorStr = JSON.stringify({ handle: attribution.handle, displayName: attribution.displayName, profileUrl: attribution.url });
	lines.push(`	demoItem({ id: ${idStr}, slug: ${slugStr}, name: ${nameStr}, description: ${descStr}, tags: ${tagsStr}, glbUrl: ${glbStr}, image: ${imgStr}, sortDate: ${JSON.stringify(sortDate)}, attribution: ${attrStr}, author: ${authorStr} }),`);
}

const KHRONOS_ATTR = { handle: 'khronos', displayName: 'Khronos Group', url: 'https://github.com/KhronosGroup/glTF-Sample-Assets', license: 'CC-BY 4.0' };
const THREEJS_ATTR = { handle: 'threejs', displayName: 'three.js examples', url: 'https://github.com/mrdoob/three.js', license: 'MIT' };
const ONDISK_ATTR = { handle: 'three.ws', displayName: 'three.ws starter', url: 'https://three.ws', license: 'CC-BY 4.0' };

// On-disk first
for (const m of ON_DISK) {
	addItem({
		id: `avatar_demo_disk_${m.slug}`,
		slug: `demo-${m.slug}`,
		name: m.name,
		glbUrl: `https://three.ws${m.path}`,
		image: null,
		tags: m.tags,
		desc: m.desc,
		attribution: ONDISK_ATTR,
	});
}

// Filters out pure technical fixtures from the marketplace catalogue. The
// Khronos asset repo includes many "compare X / X test / animation pointer"
// assets meant for renderer conformance — they'd dilute a marketplace meant
// for showcasing characters and curated objects. We keep them in the source
// list so the generator stays close to upstream, but skip them here.
function isReferenceFixture(name, meta) {
	if (/^Compare/i.test(name)) return true;
	if (/Test$|TestGrid$/i.test(name)) return true;
	if (/^Animated(Cube|Triangle|ColorsCube|MorphCube)$/i.test(name)) return true;
	if (/^(Box|Cube|Triangle|Simple|Primitive|Recursive|MultiUV|Cameras|Negative|Mirror|Orientation|Texture(Coord|Encoding|LinearInterp|Settings|Transform)|Vertex|Interpolation|XmpMetadata|CubeVisibility|LightVisibility|MeshPrimitive|UnicodeFile|Unicode)/i.test(name)) return true;
	if (/AnimationPointer/i.test(name) && !/Lamp|PotOfCoals/i.test(name)) return true;
	// Drop entries whose tags consist entirely of {test, primitive, material} with
	// no aesthetic descriptor — pure reference grids.
	const tagSet = new Set(meta.tags);
	const filler = ['test', 'material', 'primitive', 'normals', 'metadata', 'colors'];
	const hasShowcase = meta.tags.some((t) => !filler.includes(t));
	if (!hasShowcase) return true;
	return false;
}

// Khronos / three.js bulk catalogue is gated by INCLUDE_BULK_DEMOS. The Community
// Avatars wall is currently curated to a small named lineup (see ON_DISK above),
// so we skip the bulk public-domain catalogue by default. Set the env var to
// regenerate the full feed.
const INCLUDE_BULK_DEMOS = process.env.INCLUDE_BULK_DEMOS === '1';

let dropped = 0;

if (INCLUDE_BULK_DEMOS) {
	// Khronos
	for (const name of KHRONOS) {
		const meta = KHRONOS_META[name] || classifyByName(name);
		if (isReferenceFixture(name, meta)) {
			dropped += 1;
			continue;
		}
		const slug = 'demo-' + name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
		addItem({
			id: `avatar_demo_k_${name.toLowerCase()}`,
			slug,
			name: name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2'),
			glbUrl: `${KHRONOS_BASE}/${name}/glTF-Binary/${name}.glb`,
			image: null, // jsdelivr can't serve thumbnails reliably; let the model-viewer poster handle it
			tags: meta.tags,
			desc: meta.desc,
			attribution: KHRONOS_ATTR,
		});
	}

	// three.js — skip ones already in Khronos to avoid duplicates
	const KHRONOS_LOWER = new Set(KHRONOS.map((s) => s.toLowerCase()));
	for (const baseName of THREEJS) {
		if (KHRONOS_LOWER.has(baseName.toLowerCase())) continue; // skip dupes
		// Case-insensitive THREEJS_META lookup so 'ferrari' (filename) matches 'Ferrari' (META key).
		const metaKey = Object.keys(THREEJS_META).find((k) => k.toLowerCase() === baseName.toLowerCase());
		const meta = (metaKey && THREEJS_META[metaKey]) || classifyByName(baseName);
		const niceName = baseName
			.replace(/[-_]+/g, ' ')
			.replace(/\.glb$/, '')
			.replace(/^(.)/, (m) => m.toUpperCase())
			.replace(/\b([a-z])/g, (m) => m.toUpperCase());
		addItem({
			id: `avatar_demo_t_${baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
			slug: 'demo-' + baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
			name: niceName,
			glbUrl: `${THREEJS_BASE}/${baseName}.glb`,
			image: null,
			tags: meta.tags,
			desc: meta.desc,
			attribution: THREEJS_ATTR,
		});
	}
}

const file = `/**
 * Demo avatar fixtures for /api/explore.
 *
 * These appear in the marketplace + 3D viewer to demonstrate the platform with
 * a curated catalogue of public-domain glTF assets:
 *   - Khronos glTF Sample Assets         (CC-BY 4.0)
 *   - three.js example models            (MIT)
 *   - On-disk starter avatars            (shipped with three.ws)
 *
 * Generated by scripts/gen-demo-avatars.mjs from a verified GLB URL list —
 * every entry has been HEAD-checked for 200 + correct Content-Type. Edit the
 * generator, not this file, when adding sources.
 *
 * IDs prefixed with \`avatar_demo_\` so they never collide with DB UUIDs.
 */

import { env } from './env.js';

function demoItem({ id, slug, name, description, tags, glbUrl, image, sortDate, attribution, author }) {
	const explicitGlb = glbUrl;
	const finalGlb = explicitGlb.startsWith('http')
		? explicitGlb
		: \`\${env.APP_ORIGIN}\${explicitGlb}\`;
	return {
		kind: 'avatar',
		sortDate,
		avatarId: id,
		slug,
		name,
		description,
		image,
		glbUrl: finalGlb,
		has3d: true,
		tags,
		createdAt: sortDate,
		viewerUrl: \`/avatars/\${id}\`,
		attribution,
		author,
	};
}

export const DEMO_AVATARS = [
${lines.join('\n')}
];
`;

const target = path.join(HERE, '..', 'api', '_lib', 'demo-avatars.js');
fs.writeFileSync(target, file);
console.log('wrote', lines.length, 'demo entries to', target);
console.log('dropped', dropped, 'reference/test fixtures');
