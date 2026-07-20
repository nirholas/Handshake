import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when this module is the process entry point.
 *
 * Compares realpaths so a symlinked bin (how npx and global installs expose
 * it) still matches.
 */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}
