import type { ReadyShader, ShaderVariant } from "./shaders";
import { VISIBLE_READY_SHADERS } from "./publicShaders";

export type CatalogResult = {
  shader: ReadyShader;
  variant?: ShaderVariant;
};

export function createCatalogResults(shaders: readonly ReadyShader[]): CatalogResult[] {
  return shaders.flatMap((shader) => (
    shader.variants?.length
      ? shader.variants.map((variant) => ({ shader, variant }))
      : [{ shader }]
  ));
}

export function catalogResultId({ shader, variant }: CatalogResult) {
  return variant ? `${shader.id}--${variant.id}` : shader.id;
}

export function catalogResultLabel({ shader, variant }: CatalogResult) {
  return variant ? `${shader.label} — ${variant.label}` : shader.label;
}

function normalizedSearchTerm(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function searchableText(fields: readonly (string | undefined)[]) {
  const text = fields.join(" ").toLowerCase();
  return { text, compact: normalizedSearchTerm(text) };
}

function textMatchesTerm(searchable: ReturnType<typeof searchableText>, term: string) {
  return searchable.text.includes(term) || searchable.compact.includes(normalizedSearchTerm(term));
}

export function catalogResultMatchesQuery({ shader, variant }: CatalogResult, query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;

  const sharedFields = [
    shader.id,
    shader.category,
    shader.label,
    shader.description,
    shader.runtime,
    shader.origin,
    shader.passes,
    shader.interaction,
    shader.asset,
    shader.importName,
    ...shader.tags,
  ];
  const variantSearchable = searchableText([variant?.id, variant?.label, variant?.description]);
  const resultSearchable = searchableText([...sharedFields, variant?.id, variant?.label, variant?.description]);
  const siblingVariantSearchables = shader.variants?.map((item) => searchableText([item.id, item.label, item.description])) ?? [];

  return terms.every((term) => {
    const isVariantSpecificTerm = variant && siblingVariantSearchables.some((item) => textMatchesTerm(item, term));
    return textMatchesTerm(isVariantSpecificTerm ? variantSearchable : resultSearchable, term);
  });
}

export const CATALOG_RESULTS: readonly CatalogResult[] = createCatalogResults(VISIBLE_READY_SHADERS);
