#!/usr/bin/env node
// Bundles every Markdown file in the repo (docs/ALL.md is skipped: it is a generated copy of docs/) into a handful of large .md volumes
// sized for NotebookLM (500k words per source, 50 sources per notebook) and
// zips them. Output: exports/notebook-corpus/notebook-corpus.zip (gitignored).
//   node scripts/build-notebook-corpus.mjs [--max-words 400000]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const outDir = join(root, "exports", "notebook-corpus");
const argIdx = process.argv.indexOf("--max-words");
const maxWords = argIdx > -1 ? Number(process.argv[argIdx + 1]) : 400_000;

const files = execFileSync("find", [
  ".", "-name", "*.md", "-type", "f",
  "-not", "-path", "*/node_modules/*",
  "-not", "-path", "./.git/*",
  "-not", "-path", "*/dist/*",
  "-not", "-path", "*/build/*",
  "-not", "-path", "./exports/*",
  "-not", "-path", "./docs/ALL.md",
], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, "")).sort();

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const countWords = (s) => (s.match(/\S+/g) || []).length;
const volumes = [];
let current = [];
let currentWords = 0;
let toc = [];

const flush = () => {
  if (!current.length) return;
  const n = volumes.length + 1;
  const name = `three-ws-corpus-vol-${String(n).padStart(2, "0")}.md`;
  const header = `# three.ws documentation corpus, volume ${n}\n\nThis volume concatenates ${current.length} Markdown files from the three.ws repository (${currentWords.toLocaleString()} words). Each file begins with a heading naming its original repo path.\n\n`;
  writeFileSync(join(outDir, name), header + current.join("\n\n"));
  volumes.push({ name, files: toc, words: currentWords });
  current = []; currentWords = 0; toc = [];
};

for (const file of files) {
  let text;
  try { text = readFileSync(join(root, file), "utf8"); } catch { continue; }
  const words = countWords(text);
  if (words > maxWords) {
    // Split an oversized file into parts on line boundaries so no volume exceeds the cap.
    const lines = text.split("\n");
    let part = [], partWords = 0, partNo = 1;
    const emit = () => {
      flush();
      const body = part.join("\n");
      current.push(`\n\n---\n\n# FILE: ${file} (part ${partNo})\n\n${body.trim()}\n`);
      currentWords += partWords;
      toc.push({ file: `${file} (part ${partNo})`, words: partWords });
      part = []; partWords = 0; partNo += 1;
    };
    for (const line of lines) {
      const w = countWords(line);
      if (partWords + w > maxWords && part.length) emit();
      part.push(line); partWords += w;
    }
    if (part.length) emit();
    continue;
  }
  if (currentWords + words > maxWords && current.length) flush();
  current.push(`\n\n---\n\n# FILE: ${file}\n\n${text.trim()}\n`);
  currentWords += words;
  toc.push({ file, words });
}
flush();

const indexLines = [
  "# three.ws documentation corpus: index",
  "",
  `Generated from ${files.length} Markdown files (${volumes.reduce((a, v) => a + v.words, 0).toLocaleString()} words) split into ${volumes.length} volumes.`,
  "",
];
for (const v of volumes) {
  indexLines.push(`## ${v.name} (${v.files.length} files, ${v.words.toLocaleString()} words)`, "");
  for (const f of v.files) indexLines.push(`- ${f.file} (${f.words.toLocaleString()} words)`);
  indexLines.push("");
}
writeFileSync(join(outDir, "00-index.md"), indexLines.join("\n"));

const zip = join(outDir, "notebook-corpus.zip");
execFileSync("zip", ["-q", "-j", zip, "00-index.md", ...volumes.map((v) => v.name)], { cwd: outDir });
console.log(`${files.length} files -> ${volumes.length} volumes -> ${relative(root, zip)} (${(statSync(zip).size / 1024 / 1024).toFixed(1)} MB)`);
for (const v of volumes) console.log(`  ${v.name}: ${v.files.length} files, ${v.words.toLocaleString()} words`);
