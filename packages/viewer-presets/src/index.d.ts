export interface LightConfig {
	fillLightAngle: number;
	backLightAngle: number;
	keyLightAngle: number;
	silhouetteLightAngle: number;
	keyLightPosition: readonly [number, number, number];
	liftLightPosition: readonly [number, number, number];
	dirLightPosition: readonly [number, number, number];
	silhouetteLightPosition: readonly [number, number, number];
	defaults: Readonly<LightingOverrides>;
}

export interface LightingOverrides {
	keyLightIntensity: number;
	keyLightColor: string;
	fillLightIntensity: number;
	fillLightColor: string;
	fillLightPosition: readonly [number, number, number];
	backLightIntensity: number;
	backLightColor: string;
	backLightPosition: readonly [number, number, number];
	lightTarget: readonly [number, number, number];
}

export interface FloorReflectionProps {
	resolution: number;
	mixBlur: number;
	mixStrength: number;
	metalness: number;
	blur: readonly [number, number];
	mirror: number;
	minDepthThreshold: number;
	maxDepthThreshold: number;
	depthScale: number;
	depthToBlurRatioBias: number;
	distortion: number;
	mixContrast: number;
	reflectorOffset: number;
	roughness: number;
	envMapIntensity: number;
	planeSize: readonly [number, number];
	fogNear: number;
	fogFar: number;
	color: string;
}

export interface BloomProps {
	luminanceThreshold: number;
	luminanceSmoothing: number;
	mipmapBlur: boolean;
	intensity: number;
	kernelSize: number;
}

export interface LightRig {
	group: unknown;
	headTarget: unknown;
	shoeTarget: unknown;
}

export interface MaterialPreset {
	label?: string;
	color?: string;
	metalness?: number;
	roughness?: number;
	emissive?: string;
	emissiveIntensity?: number;
	envMapIntensity?: number;
	transparent?: boolean;
	opacity?: number;
	/** 0..1, MeshPhysicalMaterial only (KHR_materials_clearcoat) */
	clearcoat?: number;
	clearcoatRoughness?: number;
	/** 0..1, MeshPhysicalMaterial only (KHR_materials_transmission) */
	transmission?: number;
	thickness?: number;
	/** index of refraction, 1..2.333 */
	ior?: number;
	attenuationColor?: string;
	attenuationDistance?: number;
	/** 0..1, MeshPhysicalMaterial only */
	sheen?: number;
	sheenColor?: string;
	sheenRoughness?: number;
	specularIntensity?: number;
	specularColor?: string;
	/** 0..1, MeshPhysicalMaterial only (KHR_materials_anisotropy) */
	anisotropy?: number;
	anisotropyRotation?: number;
}

export interface MaterialVariant {
	label: string;
	seed: number;
	config: MaterialPreset;
}

export declare const LIGHT_CONFIG: LightConfig;
export declare const FLOOR_REFLECTION_DEFAULTS: Readonly<Omit<FloorReflectionProps, 'color'>>;
export declare const BLOOM_DEFAULTS: BloomProps;
export declare const MATERIAL_PRESETS: Readonly<Record<string, Readonly<MaterialPreset>>>;
export declare const MATERIAL_PRESET_NAMES: readonly string[];

export declare function buildLightRig(
	THREE: unknown,
	overrides?: Partial<LightingOverrides>,
): LightRig;
export declare function floorReflectionConfig(
	props: Partial<Omit<FloorReflectionProps, 'color'>> & { color: string },
): FloorReflectionProps;
export declare function bloomConfig(overrides?: Partial<BloomProps>): BloomProps;

export declare function materialPreset(
	presetOrConfig: string | Partial<MaterialPreset>,
	overrides?: Partial<MaterialPreset>,
): MaterialPreset;
export declare function applyMaterialPreset(
	THREE: unknown,
	root: unknown,
	presetOrConfig: string | Partial<MaterialPreset>,
	opts?: { overrides?: Partial<MaterialPreset> },
): { restore: () => void; count: number };
export declare function materialVariants(
	base: string | Partial<MaterialPreset>,
	opts?: { seed?: number; count?: number; hueSpread?: number; jitter?: number },
): MaterialVariant[];
