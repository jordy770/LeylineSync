// Pure helpers for the generated dashboards (dev-dashboard.html / test-dashboard.html).
// Kept free of I/O so tests/unit/dashboard-parse.test.ts can exercise them directly.

/** Parse the bucket table of docs/commander-decks/engine-blocked-backlog-*.md. */
export function parseBacklogBuckets(md) {
  const buckets = []
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*$/)
    if (m) buckets.push({ rank: Number(m[1]), name: m[2], count: Number(m[3]) })
  }
  const totalMatch = md.match(/\*\*(\d+)\s+kaarten\*\*/)
  return {
    buckets,
    total: totalMatch ? Number(totalMatch[1]) : buckets.reduce((s, b) => s + b.count, 0),
  }
}

/** Count open vs closed numbered items in the "Genuinely open" section of docs/open-items.md. */
export function countOpenItems(md) {
  const start = md.indexOf('## 🔴')
  if (start === -1) return { open: 0, closed: 0 }
  let section = md.slice(start)
  const next = section.indexOf('\n## ', 3)
  if (next !== -1) section = section.slice(0, next)
  let open = 0
  let closed = 0
  for (const line of section.split(/\r?\n/)) {
    if (!/^\s{0,3}\d+\.\s/.test(line)) continue
    if (line.includes('✅') || line.includes('~~')) closed++
    else open++
  }
  return { open, closed }
}

/** Extract the newest "## Decision Log" section (title + bullets) from cerebrum.md. */
export function latestDecisionLog(md, { maxBullets = 8, maxLen = 260 } = {}) {
  const idx = md.lastIndexOf('\n## Decision Log')
  if (idx === -1) return null
  const rest = md.slice(idx + 1)
  const headerEnd = rest.indexOf('\n')
  const title = rest.slice(0, headerEnd).replace(/^##\s*/, '')
  let body = rest.slice(headerEnd + 1)
  const next = body.search(/\n## /)
  if (next !== -1) body = body.slice(0, next)
  const bullets = body
    .split(/\r?\n/)
    .filter((l) => l.startsWith('- '))
    .slice(0, maxBullets)
    .map((l) => (l.length > maxLen ? l.slice(0, maxLen) + '…' : l).replace(/^- /, ''))
  return { title, bullets }
}

/** Track-percentage: afgevinkte milestones / totaal (fallback: expliciete pct, anders 0). */
export function trackPct(track) {
  const ms = track.milestones ?? []
  if (ms.length === 0) return track.pct ?? 0
  return Math.round((100 * ms.filter((m) => m.done).length) / ms.length)
}

/**
 * Parse the ANSWERS fenced block of SESSION-PROMPT.md into grouped Q&A entries.
 * Entry format: `A1 — vraagtekst (mag doorlopen op volgende regels):` gevolgd
 * door het antwoord achter de LAATSTE dubbele punt (leeg = nog open).
 */
export function parseAnswers(md) {
  const start = md.indexOf('## ANSWERS')
  if (start === -1) return []
  const fenceOpen = md.indexOf('```', start)
  if (fenceOpen === -1) return []
  const fenceClose = md.indexOf('```', fenceOpen + 3)
  const block = md.slice(fenceOpen + 3, fenceClose === -1 ? undefined : fenceClose)

  const entries = []
  let group = ''
  let current = null
  const flush = () => {
    if (!current) return
    const text = current.lines.join(' ').replace(/\s+/g, ' ').trim()
    const lastColon = text.lastIndexOf(':')
    const question = lastColon === -1 ? text : text.slice(0, lastColon).trim()
    const answer = lastColon === -1 ? '' : text.slice(lastColon + 1).trim()
    entries.push({ id: current.id, group, question, answer, open: answer === '' })
    current = null
  }

  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const groupMatch = line.match(/^---\s*(.+?)\s*---$/)
    if (groupMatch) {
      flush()
      group = groupMatch[1]
      continue
    }
    const idMatch = line.match(/^([A-Z]{1,3}\d+)\s+[—-]\s*(.*)$/)
    if (idMatch) {
      flush()
      current = { id: idMatch[1], lines: [idMatch[2]] }
      continue
    }
    if (current && line.trim() !== '') current.lines.push(line.trim())
  }
  flush()
  return entries
}

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const NAV_PAGES = [
  ['dev-dashboard.html', 'dev', 'Dev-dashboard'],
  ['test-dashboard.html', 'test', 'Test-dashboard'],
  ['questions.html', 'questions', 'Vragen'],
]

/** SVG progress ring (0-100). */
export function progressRing(pct, label) {
  const r = 54
  const c = 2 * Math.PI * r
  const filled = (c * Math.min(100, Math.max(0, pct))) / 100
  return `<svg class="ring" viewBox="0 0 132 132" role="img" aria-label="${esc(label)}: ${pct}%">
<circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--line)" stroke-width="10"/>
<circle id="ringFg" cx="66" cy="66" r="${r}" fill="none" stroke="var(--gold)" stroke-width="10" stroke-linecap="round"
  stroke-dasharray="${filled.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 66 66)"/>
<text id="ringPct" x="66" y="63" text-anchor="middle" font-size="26">${Math.round(pct)}%</text>
<text x="66" y="82" text-anchor="middle" class="lbl">${esc(label)}</text>
</svg>`
}

/** Shared Leyline-styled page shell for the generated dashboard pages. */
export function pageShell({ title, subtitle, generatedBy, active, chips = [], ring = null, body, script = '' }) {
  const nav = NAV_PAGES.map(([href, key, label]) =>
    key === active
      ? `<a class="cur" aria-current="page">${label}</a>`
      : `<a href="${href}">${label}</a>`,
  ).join('')
  const chipHtml = chips.length
    ? `<div class="meta">${chips.map((c) => `<span class="chip ${c.cls ?? ''}">${esc(c.text)}</span>`).join('')}</div>`
    : ''
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${esc(title)}</title>
<style>
  :root {
    --void: #100d1a; --void-2: #181327; --void-3: #1f1833; --ink: #e8dcc0; --ink-dim: #a99e83;
    --gold: #c9a84c; --gold-dim: #8a7434; --line: #2c2440;
    --ok: #6fbf8f; --bad: #d97a6c; --warn: #d9b96c;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--void); color: var(--ink); font: 15px/1.55 "Spectral", Georgia, serif; }
  main { max-width: 1080px; margin: 0 auto; padding: 8px 24px 64px; }
  header { border-bottom: 1px solid var(--line); background: var(--void-2); padding: 28px 0 22px; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
  .eyebrow { font: 600 11px/1 ui-monospace, Consolas, monospace; letter-spacing: 0.14em; text-transform: uppercase; color: var(--gold-dim); }
  .headgrid { display: flex; gap: 28px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .chip { font: 500 12px/1 ui-monospace, Consolas, monospace; background: var(--void-3); border: 1px solid var(--line); border-radius: 999px; padding: 7px 12px; color: var(--ink-dim); }
  .chip.ok { color: var(--ok); } .chip.bad { color: var(--bad); } .chip.warn { color: var(--warn); }
  nav { position: sticky; top: 0; z-index: 50; background: rgba(16, 13, 26, 0.92); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
  nav .wrap { display: flex; gap: 4px; padding-top: 9px; padding-bottom: 9px; overflow-x: auto; }
  nav a { color: var(--ink-dim); text-decoration: none; font-size: 13px; padding: 6px 12px; border-radius: 6px; white-space: nowrap; }
  nav a:hover { background: var(--void-3); color: var(--ink); }
  nav a.cur { background: var(--void-3); color: var(--gold); border: 1px solid var(--line); }
  .ring { width: 132px; height: 132px; flex: none; }
  .ring text { fill: var(--ink); font-family: "Cinzel", Georgia, serif; }
  .ring .lbl { fill: var(--ink-dim); font-size: 8px; letter-spacing: 0.1em; text-transform: uppercase; }
  h1, h2 { font-family: "Cinzel", Georgia, serif; letter-spacing: 0.04em; color: var(--gold); font-weight: 600; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 36px 0 12px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  .sub { color: var(--ink-dim); margin: 0 0 8px; }
  .gen-note { color: var(--ink-dim); font-size: 12.5px; font-style: italic; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--gold-dim); font-weight: 600; text-transform: uppercase; font-size: 11.5px; letter-spacing: 0.08em; }
  td.num, th.num { text-align: right; padding-right: 0; font-variant-numeric: tabular-nums; }
  .bar { background: var(--void-2); border: 1px solid var(--line); border-radius: 3px; height: 12px; min-width: 140px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: linear-gradient(90deg, var(--gold-dim), var(--gold)); }
  .badge { display: inline-block; padding: 3px 12px; border-radius: 3px; font-family: "Cinzel", Georgia, serif; font-size: 13px; letter-spacing: 0.06em; border: 1px solid; }
  .badge.ok { color: var(--ok); border-color: var(--ok); }
  .badge.bad { color: var(--bad); border-color: var(--bad); }
  .badge.warn { color: var(--warn); border-color: var(--warn); }
  .banner { border: 1px solid; border-radius: 4px; padding: 10px 16px; margin: 16px 0; font-size: 14px; }
  .banner.warn { color: var(--warn); border-color: var(--warn); background: rgba(217, 185, 108, 0.07); }
  .banner.bad { color: var(--bad); border-color: var(--bad); background: rgba(217, 122, 108, 0.07); }
  .banner.ok { color: var(--ok); border-color: var(--ok); background: rgba(111, 191, 143, 0.07); }
  code, .mono { font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  ul { margin: 8px 0; padding-left: 20px; }
  li { margin: 4px 0; }
  .dim { color: var(--ink-dim); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 16px 0; }
  .card { background: var(--void-2); border: 1px solid var(--line); border-radius: 4px; padding: 12px 16px; }
  .card .v { font-size: 24px; font-family: "Cinzel", Georgia, serif; color: var(--gold); font-variant-numeric: tabular-nums; }
  .card .k { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-dim); }
  .q { background: var(--void-2); border: 1px solid var(--line); border-radius: 6px; padding: 14px 18px; margin: 10px 0; }
  .q .qhead { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .q .qid { font: 600 12px/1 ui-monospace, Consolas, monospace; color: var(--gold); }
  .q .qtitle { font-weight: 600; }
  .q .ans { margin: 8px 0 0; padding: 8px 12px; border-left: 2px solid var(--ok); color: var(--ink); background: rgba(111, 191, 143, 0.06); }
  .q.openq .ans { border-left-color: var(--warn); background: rgba(217, 185, 108, 0.06); color: var(--ink-dim); font-style: italic; }
  .track { background: var(--void-2); border: 1px solid var(--line); border-radius: 6px; padding: 14px 18px; margin: 10px 0; }
  .track .thead { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 8px; }
  .track .thead strong { font-family: "Cinzel", Georgia, serif; color: var(--gold); }
  .track .pctv { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
  ul.ms { list-style: none; padding: 0; margin: 10px 0 4px; }
  ul.ms li, ul.now li { margin: 5px 0; }
  ul.now { list-style: none; padding: 0; }
  ul.ms label, ul.now label { display: flex; gap: 9px; align-items: baseline; cursor: pointer; }
  input[type="checkbox"] { accent-color: var(--gold); width: 15px; height: 15px; flex: none; transform: translateY(2px); cursor: pointer; }
  li.done label { color: var(--ink-dim); text-decoration: line-through; text-decoration-color: var(--gold-dim); }
  .btn { font: 600 13px/1 "Spectral", Georgia, serif; color: var(--gold); background: var(--void-3); border: 1px solid var(--gold-dim); border-radius: 6px; padding: 9px 16px; cursor: pointer; }
  .btn:hover { background: var(--void-2); border-color: var(--gold); }
  .btn.ghost { color: var(--ink-dim); border-color: var(--line); }
  #exportOut { display: none; width: 100%; height: 180px; margin-top: 10px; background: var(--void-2); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 10px; font: 12px/1.5 ui-monospace, Consolas, monospace; }
</style>
</head>
<body>
<header><div class="wrap">
<div class="eyebrow">LeylineSync — intern</div>
<div class="headgrid">
<div>
<h1>${esc(title)}</h1>
<p class="sub">${esc(subtitle)}</p>
<p class="gen-note">Gegenereerd — niet handmatig bewerken. Verversen: <code>${esc(generatedBy)}</code>.</p>
${chipHtml}
</div>
${ring ?? ''}
</div>
</div></header>
<nav><div class="wrap">${nav}</div></nav>
<main>
${body}
</main>
${script ? `<script>\n${script}\n</script>` : ''}
</body>
</html>
`
}
