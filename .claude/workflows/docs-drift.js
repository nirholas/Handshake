export const meta = {
  name: 'docs-drift',
  description: 'Find directories missing required READMEs, then write real docs for the worst offenders in parallel',
  whenToUse: 'Run when closing the feature-docs gap: packages/*, workers/*, SDKs, and top-level surfaces that lack a README.md. Invoke with: run the docs-drift workflow. Optional args: { limit: number } to cap how many docs get written this run (default 8).',
  phases: [
    { title: 'Scan', detail: 'one agent maps dirs required to have a README vs what exists' },
    { title: 'Write', detail: 'one agent per missing doc, real README per CLAUDE.md doc rules' },
    { title: 'Verify', detail: 'each new README checked for runnable examples and live links' },
  ],
}

const SCAN_SCHEMA = {
  type: 'object',
  required: ['missing'],
  properties: {
    missing: {
      type: 'array',
      items: {
        type: 'object',
        required: ['dir', 'kind', 'summary'],
        properties: {
          dir: { type: 'string', description: 'repo-relative directory path' },
          kind: { type: 'string', description: 'package | worker | sdk | surface' },
          summary: { type: 'string', description: 'one line: what this directory is, from reading its code' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['ok', 'problems'],
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
  },
}

phase('Scan')
const scan = await agent(
  `In /workspaces/three.ws, find every directory that the CLAUDE.md documentation rules require to have a README.md but that has none (or an empty/stub one). Check: every directory under packages/, every directory under workers/, the SDK dirs (sdk/, solana-agent-sdk/, agent-payments-sdk/), and every surface listed in STRUCTURE.md whose mapped directory lacks a README. Read enough of each candidate's code to write a one-line summary of what it actually does. Exclude node_modules, dist, build output, and scratch dirs. Return the full list.`,
  { label: 'scan:readme-gaps', schema: SCAN_SCHEMA }
)

const limit = (args && args.limit) || 8
const targets = scan.missing.slice(0, limit)
if (scan.missing.length > targets.length) {
  log(`${scan.missing.length} dirs missing READMEs; writing ${targets.length} this run, ${scan.missing.length - targets.length} deferred (raise args.limit to cover more)`)
}

const results = await pipeline(
  targets,
  t => agent(
    `Write a real README.md at /workspaces/three.ws/${t.dir}/README.md for this ${t.kind}: ${t.summary}. Follow the three.ws CLAUDE.md documentation rules exactly: explain what it does and why it exists, how to install/use it, its public API or exports, and ONE runnable example taken from the actual code (verify the entry points and export names by reading the source; never invent an API). Match the tone and structure of neighboring READMEs in the repo. Every link must resolve to a real path. No TODOs, no placeholders, no em-dash or en-dash characters anywhere. Write the file, then return the repo-relative path you wrote.`,
    { label: `write:${t.dir}`, phase: 'Write' }
  ),
  (written, t) => agent(
    `Adversarially review /workspaces/three.ws/${t.dir}/README.md. Verify against the source code in that directory: (1) every named export/function/endpoint in the doc exists in the code, (2) the example would actually run as written, (3) every relative link resolves to an existing file, (4) no TODO/placeholder text and no em-dash or en-dash characters. Fix small problems directly in the file; report anything you could not fix.`,
    { label: `verify:${t.dir}`, phase: 'Verify', schema: VERDICT_SCHEMA }
  ).then(v => ({ dir: t.dir, ...v }))
)

const done = results.filter(Boolean)
return {
  written: done.filter(r => r.ok).map(r => r.dir),
  needsAttention: done.filter(r => !r.ok),
  deferred: scan.missing.slice(targets.length).map(m => m.dir),
}
