// Test runner: discovers *.test.ts itself and hands EXPLICIT file paths to
// `node --test` (Node's --test glob expansion is unreliable on Windows, which is
// why package.json used to carry a hand-maintained 100-file list).
//
//   npm test                       → run everything
//   npm test -- feature/amass      → run files whose path contains the filter(s)
//
// Exit code mirrors the node --test run.

import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const dirs = ['tests/unit', 'tests/feature', 'tests/regression']

function collect(dir) {
  let out = []
  let entries
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out = out.concat(collect(p))
    else if (e.isFile() && e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const filters = process.argv.slice(2).map((f) => f.toLowerCase())
let files = dirs.flatMap(collect).sort()
if (filters.length > 0) {
  files = files.filter((f) => {
    const norm = relative(root, join(root, f)).replaceAll('\\', '/').toLowerCase()
    return filters.some((needle) => norm.includes(needle))
  })
}

if (files.length === 0) {
  console.error('No test files matched.')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit', cwd: root },
)
process.exit(result.status ?? 1)
