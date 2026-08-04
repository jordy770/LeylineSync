// Test runner: discovers *.test.ts itself and hands EXPLICIT file paths to
// `node --test` (Node's --test glob expansion is unreliable on Windows, which is
// why package.json used to carry a hand-maintained 100-file list).
//
//   npm test                       → run everything
//   npm test -- feature/amass      → run files whose path contains the filter(s)
//
// Exit code mirrors the node --test run.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
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

// Two reporters: human-readable spec to the terminal, plus a JSON reporter
// whose output feeds test-dashboard.html. Filtered runs write to a SEPARATE
// file so partial totals can never reach the dashboard, not even via a later
// standalone gen-test-dashboard invocation.
const fullRun = filters.length === 0
const resultsPath = join(root, '.wolf', fullRun ? 'test-results.json' : 'test-results-partial.json')
const t0 = Date.now()
const result = spawnSync(
  process.execPath,
  [
    '--import', 'tsx', '--test',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${pathToFileURL(join(root, 'scripts', 'test-reporter-json.mjs')).href}`,
    `--test-reporter-destination=${resultsPath}`,
    ...files,
  ],
  { stdio: 'inherit', cwd: root },
)

try {
  const data = JSON.parse(readFileSync(resultsPath, 'utf8'))
  data.meta = {
    when: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    filters,
    fileCount: files.length,
    full: fullRun,
    exitCode: result.status ?? 1,
  }
  writeFileSync(resultsPath, JSON.stringify(data, null, 2) + '\n')
  if (data.meta.full) {
    const { generateTestDashboard } = await import('./gen-test-dashboard.mjs')
    console.log(generateTestDashboard(root))
  } else {
    console.log('Gefilterde run — test-dashboard.html NIET bijgewerkt (alleen volledige `npm test`-runs schrijven hem).')
  }
} catch (e) {
  console.error('test-dashboard niet bijgewerkt:', e.message)
}

process.exit(result.status ?? 1)
