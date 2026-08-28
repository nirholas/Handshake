export type Severity = 'none' | 'cosmetic' | 'minor' | 'major' | 'breaking';

export interface FieldChange {
	field: string;
	a: unknown;
	b: unknown;
	severity: Severity;
	note?: string;
}

export interface SectionItem {
	name: string;
	severity: Severity;
	detail?: string;
}

export interface ModifiedItem {
	name: string;
	from?: string;
	changes: FieldChange[];
	severity: Severity;
}

export interface RenameItem {
	from: string;
	to: string;
	name: string;
}

export interface DiffSection {
	added: SectionItem[];
	removed: SectionItem[];
	renamed: RenameItem[];
	moved?: RenameItem[];
	modified: ModifiedItem[];
	unchanged: number;
	changed: number;
	severity: Severity;
	similarityLimited: boolean;
}

export interface TotalDelta {
	a: number;
	b: number;
	delta: number;
	pct: number | null;
}

export interface ChangeSet {
	version: number;
	identical: boolean;
	severity: Severity;
	a: { name: string | null; sizeBytes: number; container: string | null; generator: string | null };
	b: { name: string | null; sizeBytes: number; container: string | null; generator: string | null };
	summary: { changed: number; added: number; removed: number; modified: number; renamed: number; moved: number };
	totals: Record<string, TotalDelta>;
	sections: {
		nodes: DiffSection;
		meshes: DiffSection;
		materials: DiffSection;
		textures: DiffSection;
		animations: DiffSection;
		skins: DiffSection;
	};
	extensions: { used: { added: string[]; removed: string[] }; required: { added: string[]; removed: string[] } };
	asset: FieldChange[];
	highlights: { severity: Severity; text: string }[];
}

export interface ModelDescription {
	version: number;
	name: string | null;
	container: string | null;
	asset: { generator: string | null; version: string | null; copyright: string | null };
	extensionsUsed: string[];
	extensionsRequired: string[];
	totals: Record<string, number>;
	nodes: Record<string, unknown>[];
	meshes: Record<string, unknown>[];
	materials: Record<string, unknown>[];
	textures: Record<string, unknown>[];
	animations: Record<string, unknown>[];
	skins: Record<string, unknown>[];
}

export declare function diffModels(
	bytesA: Uint8Array,
	bytesB: Uint8Array,
	opts?: { nameA?: string; nameB?: string },
): Promise<ChangeSet>;

export declare function describeModel(bytes: Uint8Array, meta?: { name?: string }): Promise<ModelDescription>;
export declare function describeDocument(document: unknown, meta?: Record<string, unknown>): ModelDescription;
export declare function diffDescriptions(a: ModelDescription, b: ModelDescription): ChangeSet;
export declare function formatText(changeset: ChangeSet, opts?: { color?: boolean; verbose?: boolean }): string;
export declare function formatMarkdown(changeset: ChangeSet): string;
export declare function readDocument(bytes: Uint8Array): Promise<unknown>;
export declare function isGLB(bytes: Uint8Array): boolean;
export declare function atLeast(severity: Severity, threshold: Severity): boolean;
export declare function maxSeverity(values: (Severity | null | undefined)[]): Severity;
export declare function severityRank(severity: Severity): number;
export declare function formatBytes(n: number): string;
export declare const SEVERITIES: Severity[];
export declare const SEVERITY_MEANING: Record<Severity, string>;
export declare const CHANGESET_VERSION: number;
export declare const DESCRIPTION_VERSION: number;
