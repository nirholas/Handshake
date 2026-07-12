#!/usr/bin/env node
/**
 * Compiles the direct-rail contracts (`HoodToken.sol`, `HoodLPLocker.sol`)
 * with solc, resolving `@openzeppelin/*` imports against the locally
 * installed package, and writes ABI + bytecode artifacts next to each
 * source for the direct rail to import.
 *
 * Run: `npm run compile:contract`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import solc from 'solc'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const contracts = [
  { file: 'HoodToken.sol', name: 'HoodToken' },
  { file: 'HoodLPLocker.sol', name: 'HoodLPLocker' },
]

function findImport(importPath) {
  try {
    const resolved = importPath.startsWith('@openzeppelin/')
      ? join(root, 'node_modules', importPath)
      : join(root, 'contracts', importPath)
    return { contents: readFileSync(resolved, 'utf8') }
  } catch {
    return { error: `File not found: ${importPath}` }
  }
}

const sources = Object.fromEntries(
  contracts.map(({ file }) => [file, { content: readFileSync(join(root, 'contracts', file), 'utf8') }]),
)

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
    },
  },
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }))

const errors = (output.errors ?? []).filter((e) => e.severity === 'error')
if (errors.length > 0) {
  for (const e of errors) console.error(e.formattedMessage)
  process.exit(1)
}
for (const w of (output.errors ?? []).filter((e) => e.severity === 'warning')) {
  console.warn(w.formattedMessage)
}

// Resolve every import transitively so the embedded standard-json-input is
// fully self-contained: Blockscout verification must replay the EXACT input
// that produced the deployed bytecode, and a published npm package can't
// assume `node_modules/@openzeppelin` exists at the caller's install.
function resolveAllSources(entryFiles) {
  const collected = { ...sources }
  const seen = new Set(Object.keys(collected))
  const queue = [...Object.keys(collected)]
  while (queue.length > 0) {
    const file = queue.shift()
    const content = collected[file].content
    const importRe = /import\s+(?:\{[^}]*\}\s+from\s+)?["']([^"']+)["']/g
    let m
    while ((m = importRe.exec(content))) {
      const raw = m[1]
      let resolvedPath
      if (raw.startsWith('.')) {
        resolvedPath = join(dirname(file), raw).replace(/\\/g, '/')
      } else {
        resolvedPath = raw // e.g. "@openzeppelin/contracts/token/ERC20/ERC20.sol" — used as-is as the sources key
      }
      if (seen.has(resolvedPath)) continue
      const found = findImport(resolvedPath)
      if (found.error) throw new Error(`Could not resolve import "${raw}" from ${file}: ${found.error}`)
      collected[resolvedPath] = { content: found.contents }
      seen.add(resolvedPath)
      queue.push(resolvedPath)
    }
  }
  return collected
}

const fullSources = resolveAllSources(contracts.map((c) => c.file))
const fullInput = { ...input, sources: fullSources }

for (const { file, name } of contracts) {
  const contract = output.contracts[file][name]
  const artifact = {
    contractName: name,
    sourceFile: file,
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    compiler: { name: 'solc', version: solc.version() },
    // Self-contained standard-json-input (all transitive imports inlined) —
    // replayed byte-for-byte by src/core/verify.ts against Blockscout.
    standardJsonInput: fullInput,
  }
  const outPath = join(root, 'contracts', `${name}.json`)
  writeFileSync(outPath, JSON.stringify(artifact, null, 2))
  console.log(`Compiled ${name} -> ${outPath} (bytecode ${artifact.bytecode.length / 2 - 1} bytes)`)
}
