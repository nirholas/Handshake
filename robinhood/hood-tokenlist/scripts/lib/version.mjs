/**
 * Tokenlist version semantics, per the Uniswap token-lists standard:
 *   major = any token removed (or an address changed),
 *   minor = tokens added,
 *   patch = any other change (metadata: name, symbol, decimals, logo, tags,
 *           extensions, list-level fields).
 * No change at all keeps the version (and the caller keeps the timestamp),
 * so a refresh that finds nothing new produces a byte-identical file.
 */

/** Canonical identity of an entry inside one list. */
function keyOf(token) {
  return `${token.chainId}:${token.address.toLowerCase()}`
}

/** Stable stringify (sorted object keys, recursively) for comparison. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Compute the next list version.
 * @param {{major:number,minor:number,patch:number}} previousVersion
 * @param {object[]} previousTokens
 * @param {object[]} nextTokens
 * @returns {{version: {major:number,minor:number,patch:number}, changed: boolean,
 *            added: string[], removed: string[], modified: string[]}}
 */
export function nextVersion(previousVersion, previousTokens, nextTokens) {
  const prevByKey = new Map(previousTokens.map((t) => [keyOf(t), t]))
  const nextByKey = new Map(nextTokens.map((t) => [keyOf(t), t]))

  const removed = [...prevByKey.keys()].filter((k) => !nextByKey.has(k))
  const added = [...nextByKey.keys()].filter((k) => !prevByKey.has(k))
  const modified = [...nextByKey.keys()].filter(
    (k) => prevByKey.has(k) && stableStringify(prevByKey.get(k)) !== stableStringify(nextByKey.get(k)),
  )

  if (removed.length > 0) {
    return {
      version: { major: previousVersion.major + 1, minor: 0, patch: 0 },
      changed: true,
      added,
      removed,
      modified,
    }
  }
  if (added.length > 0) {
    return {
      version: { major: previousVersion.major, minor: previousVersion.minor + 1, patch: 0 },
      changed: true,
      added,
      removed,
      modified,
    }
  }
  if (modified.length > 0) {
    return {
      version: { major: previousVersion.major, minor: previousVersion.minor, patch: previousVersion.patch + 1 },
      changed: true,
      added,
      removed,
      modified,
    }
  }
  return { version: { ...previousVersion }, changed: false, added, removed, modified }
}
