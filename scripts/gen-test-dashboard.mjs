// Renders test-dashboard.html from .wolf/test-results.json (written by the
// custom reporter during `npm test`). Full runs regenerate the dashboard
// automatically via run-tests.mjs; a standalone invocation renders whatever the
// last run left behind, with a loud banner when that run was filtered.
//
//   node scripts/gen-test-dashboard.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { esc, pageShell } from './lib/dashboard-parse.mjs'

export function generateTestDashboard(root = process.cwd()) {
  const data = JSON.parse(readFileSync(join(root, '.wolf/test-results.json'), 'utf8'))
  const meta = data.meta ?? {}
  const full = meta.full === true
  const green = (meta.exitCode ?? 1) === 0 && data.fail === 0 && data.tests > 0

  // The verdict gate: DONE needs a FULL run, exit 0, zero failures and >0 tests.
  const verdict = !full
    ? { cls: 'warn', label: 'PARTIAL' }
    : green
      ? { cls: 'ok', label: 'DONE' }
      : { cls: 'bad', label: 'FAILED' }

  const suiteOf = (file) => file.split('/')[1] ?? '(overig)'
  const suites = new Map()
  for (const [file, st] of Object.entries(data.files ?? {})) {
    const s = suites.get(suiteOf(file)) ?? { files: 0, pass: 0, fail: 0 }
    s.files++
    s.pass += st.pass
    s.fail += st.fail
    suites.set(suiteOf(file), s)
  }

  const banner = !full
    ? `<div class="banner warn"><strong>PARTIAL RUN</strong> — filter: <code>${esc((meta.filters ?? []).join(' '))}</code>. Totalen zijn NIET representatief voor de hele suite; draai <code>npm test</code> zonder filter.</div>`
    : green
      ? ''
      : `<div class="banner bad"><strong>${data.fail} test(s) rood</strong> — zie de faallijst hieronder.</div>`

  const suiteRows = [...suites.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, s]) =>
        `<tr><td>${esc(name)}</td><td class="num">${s.files}</td><td class="num">${s.pass + s.fail}</td><td class="num">${s.pass}</td><td class="num">${s.fail === 0 ? '<span class="dim">0</span>' : `<strong>${s.fail}</strong>`}</td></tr>`,
    )
    .join('\n')

  const failureRows = (data.failures ?? [])
    .map(
      (f) =>
        `<tr><td class="mono">${esc(f.file)}</td><td>${esc(f.name)}</td><td class="dim">${esc(f.message)}</td></tr>`,
    )
    .join('\n')

  const body = `
<p><span class="badge ${verdict.cls}">${verdict.label}</span></p>
${banner}
<div class="cards">
  <div class="card"><div class="v">${data.tests}</div><div class="k">tests</div></div>
  <div class="card"><div class="v">${data.pass}</div><div class="k">geslaagd</div></div>
  <div class="card"><div class="v">${data.fail}</div><div class="k">gefaald</div></div>
  <div class="card"><div class="v">${data.skip}</div><div class="k">geskipt</div></div>
  <div class="card"><div class="v">${meta.fileCount ?? Object.keys(data.files ?? {}).length}</div><div class="k">testfiles</div></div>
  <div class="card"><div class="v">${meta.duration_ms ? (meta.duration_ms / 1000).toFixed(1) + 's' : '—'}</div><div class="k">duur</div></div>
</div>
<h2>Per suite</h2>
<table>
<tr><th>Suite</th><th class="num">Files</th><th class="num">Tests</th><th class="num">Pass</th><th class="num">Fail</th></tr>
${suiteRows}
</table>
${
  failureRows
    ? `<h2>Failures</h2>\n<table>\n<tr><th>File</th><th>Test</th><th>Fout</th></tr>\n${failureRows}\n</table>`
    : ''
}
`

  const html = pageShell({
    title: 'LeylineSync — Test Dashboard',
    subtitle: `Laatste run: ${meta.when ?? 'onbekend'}${full ? '' : ' (gefilterd)'}`,
    generatedBy: 'npm test (volledige run) of node scripts/gen-test-dashboard.mjs',
    active: 'test',
    chips: [
      { text: verdict.label, cls: verdict.cls },
      { text: `${data.tests} tests` },
      { text: `${meta.fileCount ?? Object.keys(data.files ?? {}).length} files` },
      { text: meta.duration_ms ? `${(meta.duration_ms / 1000).toFixed(0)}s` : '—' },
    ],
    body,
  })

  const out = join(root, 'test-dashboard.html')
  writeFileSync(out, html)
  return `test-dashboard.html geschreven — ${verdict.label}: ${data.pass}/${data.tests} geslaagd${data.fail ? `, ${data.fail} rood` : ''}.`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(generateTestDashboard())
}
