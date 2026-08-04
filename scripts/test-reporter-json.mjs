// Custom node:test reporter that emits one JSON document with totals, per-file
// stats and the failure list. Wired by scripts/run-tests.mjs via
// --test-reporter=<this file> --test-reporter-destination=.wolf/test-results.json
// run-tests.mjs enriches the JSON with run metadata afterwards.

export default async function* jsonReporter(source) {
  const files = new Map()
  const failures = []
  let tests = 0
  let pass = 0
  let fail = 0
  let skip = 0

  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const d = event.data
    if (d.details?.type === 'suite') continue

    const file = String(d.file ?? '').replaceAll('\\', '/')
    const name = String(d.name ?? '')
    // node --test reports each FILE as a synthetic top-level test whose name is
    // the path it was invoked with — skip those so counts match real tests.
    if (d.nesting === 0 && file && file.endsWith(name.replaceAll('\\', '/'))) continue

    tests++
    if (d.skip) {
      skip++
      continue
    }

    const rel = file.includes('/tests/') ? 'tests/' + file.split('/tests/').pop() : file
    const st = files.get(rel) ?? { pass: 0, fail: 0 }
    if (event.type === 'test:pass') {
      pass++
      st.pass++
    } else {
      fail++
      st.fail++
      const err = d.details?.error
      const message = String(err?.message ?? err ?? 'unknown error').split('\n')[0].slice(0, 300)
      failures.push({ file: rel, name, message })
    }
    files.set(rel, st)
  }

  yield JSON.stringify(
    { tests, pass, fail, skip, files: Object.fromEntries(files), failures },
    null,
    2,
  ) + '\n'
}
