#!/usr/bin/env node
/**
 * Compiles `contracts/HoodToken.sol` with solc, resolving `@openzeppelin/*`
 * imports against the locally installed package, and writes the ABI +
 * bytecode to `contracts/HoodToken.json` for the direct rail to import.
 *
 * Run: `npm run compile:contract`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import solc from 'solc'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const contractPath = join(root, 'contracts', 'HoodToken.sol')
const source = readFileSync(contractPath, 'utf8')

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

const input = {
  language: 'Solidity',
  sources: { 'HoodToken.sol': { content: source } },
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

const contract = output.contracts['HoodToken.sol']['HoodToken']
const artifact = {
  contractName: 'HoodToken',
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  compiler: { name: 'solc', version: solc.version() },
}

const outPath = join(root, 'contracts', 'HoodToken.json')
writeFileSync(outPath, JSON.stringify(artifact, null, 2))
console.log(`Compiled HoodToken -> ${outPath} (bytecode ${artifact.bytecode.length / 2 - 1} bytes)`)
