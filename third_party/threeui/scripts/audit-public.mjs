import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set([".git", "dist", "node_modules"]);
const textExtensions = new Set(["", ".css", ".html", ".js", ".jsx", ".json", ".md", ".mjs", ".txt", ".yml", ".yaml"]);
const findings = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const rel = relative(root, path);
    const info = await lstat(path);
    if (info.isSymbolicLink()) findings.push(`${rel}: symbolic links are not allowed`);
    else if (info.isDirectory()) await walk(path);
    else {
      if (entry.name === ".env" || entry.name.startsWith(".env.")) findings.push(`${rel}: environment file is not allowed`);
      if (!textExtensions.has(extname(entry.name)) && extname(entry.name) !== ".lock") continue;
      const text = await readFile(path, "utf8").catch(() => "");
      if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) findings.push(`${rel}: absolute user path`);
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push(`${rel}: private key material`);
      if (/(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i.test(text)) findings.push(`${rel}: sensitive-looking assignment`);
    }
  }
}

await walk(root);
if (findings.length) throw new Error(`Public audit failed:\n- ${findings.join("\n- ")}`);
console.log("Public audit passed: fresh tree has no environment files, symlinks, absolute user paths, private keys, or sensitive-looking assignments.");
