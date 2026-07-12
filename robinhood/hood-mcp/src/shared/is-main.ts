/**
 * Robust "is this module the entry point" check for a dual bin+import package.
 *
 * `import.meta.url === file://${process.argv[1]}` breaks the moment the binary
 * is invoked through a symlink — which is exactly how npm installs `bin`
 * entries (`node_modules/.bin/hood-mcp -> ../hood-mcp/dist/data-server.js`).
 * Node resolves `import.meta.url` to the symlink's REAL path but leaves
 * `process.argv[1]` as the invoked (symlink) path, so the naive string
 * comparison silently fails and main() never runs — verified by actually
 * running the packed tarball through `node_modules/.bin/hood-mcp` during
 * this package's own E2E test, not a hypothetical.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMainModule(moduleUrl: string): boolean {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(moduleUrl)
  } catch {
    return false
  }
}
