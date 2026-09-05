export function catalogLabel(shader) {
  return shader.label.endsWith(" Hero")
    ? shader.label.slice(0, -" Hero".length)
    : shader.label;
}

export function catalogSlug(shader) {
  return shader.id.endsWith("-hero")
    ? shader.id.slice(0, -"-hero".length)
    : shader.id;
}

function popularityCount(value) {
  const count = typeof value === "string" ? Number(value) : value;
  return typeof count === "number" && Number.isFinite(count)
    ? Math.max(0, Math.floor(count))
    : 0;
}

/**
 * @template {{ shader: { id: string } }} T
 * @param {readonly T[]} results
 * @param {Record<string, { views?: number | string, copies?: number | string }>} popularityByShaderId
 * @returns {T[]}
 */
export function sortCatalogResultsByPopularity(results, popularityByShaderId) {
  return results
    .map((result, index) => ({ result, index }))
    .sort((left, right) => {
      const leftPopularity = popularityByShaderId[left.result.shader.id] ?? {};
      const rightPopularity = popularityByShaderId[right.result.shader.id] ?? {};
      return popularityCount(rightPopularity.views) - popularityCount(leftPopularity.views)
        || popularityCount(rightPopularity.copies) - popularityCount(leftPopularity.copies)
        || left.index - right.index;
    })
    .map(({ result }) => result);
}
