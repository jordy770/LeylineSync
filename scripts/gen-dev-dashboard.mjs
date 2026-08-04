// Generates dev-dashboard.html — the project-status dashboard. Everything is
// derived from live sources (engine backlog, buglog, open-items, git, cerebrum,
// last test run) except the track percentages, which live in the single
// hand-maintained file .wolf/dashboard-tracks.json.
//
//   npm run dashboard

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { esc, pageShell, progressRing, trackPct, parseBacklogBuckets, countOpenItems, latestDecisionLog, parseAnswers } from './lib/dashboard-parse.mjs'

const root = process.cwd()
const read = (p) => readFileSync(join(root, p), 'utf8')

// --- Tracks (the one hand-maintained source; pct DERIVED from milestones) ----
const tracksData = JSON.parse(read('.wolf/dashboard-tracks.json'))
const { tracks, nowFirst = [] } = tracksData
const weightSum = tracks.reduce((s, t) => s + t.weight, 0)
const weighted = tracks.reduce((s, t) => s + t.weight * trackPct(t), 0) / 100
const arithmetic = tracks.map((t) => `${t.weight}×${trackPct(t)}`).join(' + ') + ` = ${Math.round(weighted * 100)} / 100`

const msItem = (key, text, done) =>
  `<li${done ? ' class="done"' : ''}><label><input type="checkbox" data-key="${esc(key)}" data-baked="${done ? 1 : 0}"${done ? ' checked' : ''}> <span>${esc(text)}</span></label></li>`

const trackCards = tracks
  .map((t) => {
    const pct = trackPct(t)
    return `<div class="track" data-weight="${t.weight}">
<div class="thead"><strong>${esc(t.name)}</strong><span class="dim">gewicht ${t.weight}</span><span class="dim">${esc(t.note ?? '')}</span><span class="pctv">${pct}%</span></div>
<div class="bar"><i style="width:${pct}%"></i></div>
<ul class="ms">
${(t.milestones ?? []).map((m) => msItem(`ms::${t.name}::${m.text}`, m.text, m.done)).join('\n')}
</ul>
</div>`
  })
  .join('\n')

// --- Engine backlog ----------------------------------------------------------
const backlogDir = 'docs/commander-decks'
const backlogFile = readdirSync(join(root, backlogDir))
  .filter((f) => /^engine-blocked-backlog-.*\.md$/.test(f))
  .sort()
  .pop()
let backlogHtml = '<p class="dim">Geen engine-blocked-backlog-*.md gevonden.</p>'
if (backlogFile) {
  const { buckets, total } = parseBacklogBuckets(read(join(backlogDir, backlogFile)))
  const top = buckets.slice(0, 8)
  const rest = buckets.slice(8).reduce((s, b) => s + b.count, 0)
  backlogHtml = `
<p><strong>${total} kaarten</strong> open in ${buckets.length} buckets — bron: <code>${esc(backlogFile)}</code></p>
<table>
<tr><th class="num">#</th><th>Ontbrekende primitive</th><th class="num">Kaarten</th></tr>
${top.map((b) => `<tr><td class="num">${b.rank}</td><td>${esc(b.name)}</td><td class="num">${b.count}</td></tr>`).join('\n')}
${rest ? `<tr><td></td><td class="dim">overige ${buckets.length - top.length} buckets</td><td class="num">${rest}</td></tr>` : ''}
</table>`
}

// --- Laatste testrun ---------------------------------------------------------
let testHtml = '<p class="dim">Nog geen testrun geregistreerd — draai <code>npm test</code>.</p>'
if (existsSync(join(root, '.wolf/test-results.json'))) {
  const t = JSON.parse(read('.wolf/test-results.json'))
  const m = t.meta ?? {}
  const cls = !m.full ? 'warn' : t.fail === 0 && (m.exitCode ?? 1) === 0 ? 'ok' : 'bad'
  const label = !m.full ? 'PARTIAL' : cls === 'ok' ? 'GROEN' : 'ROOD'
  testHtml = `<p><span class="badge ${cls}">${label}</span> &nbsp; ${t.pass}/${t.tests} geslaagd${t.fail ? `, <strong>${t.fail} rood</strong>` : ''}${m.full ? '' : ` <span class="dim">(gefilterde run: <code>${esc((m.filters ?? []).join(' '))}</code>)</span>`} — ${esc(m.when ?? '')}. Detail: <a href="test-dashboard.html" style="color:var(--gold)">test-dashboard.html</a></p>`
}

// --- Open items --------------------------------------------------------------
let openItemsHtml = '<p class="dim">docs/open-items.md niet gevonden.</p>'
if (existsSync(join(root, 'docs/open-items.md'))) {
  const { open, closed } = countOpenItems(read('docs/open-items.md'))
  const mtime = statSync(join(root, 'docs/open-items.md')).mtime.toISOString().slice(0, 10)
  openItemsHtml = `<p><strong>${open} open</strong>, ${closed} afgevinkt in de "genuinely open"-lijst — laatst gewijzigd ${mtime}. <span class="dim">Doc is een momentopname; her-verifieer vóór je ernaar handelt.</span></p>`
}

// --- Buglog ------------------------------------------------------------------
let buglogHtml = '<p class="dim">.wolf/buglog.json niet gevonden.</p>'
if (existsSync(join(root, '.wolf/buglog.json'))) {
  const bl = JSON.parse(read('.wolf/buglog.json'))
  const bugs = Array.isArray(bl) ? bl : bl.bugs ?? []
  const last = bugs.slice(-5).reverse()
  buglogHtml = `
<p><strong>${bugs.length} entries</strong> — raadpleeg de buglog vóór elke fix.</p>
<table>
<tr><th>Id</th><th>Wanneer</th><th>Melding</th></tr>
${last.map((b) => `<tr><td class="mono">${esc(b.id ?? '?')}</td><td class="dim">${esc(String(b.timestamp ?? '').slice(0, 10))}</td><td>${esc(String(b.error_message ?? '').slice(0, 120))}</td></tr>`).join('\n')}
</table>`
}

// --- Recente commits ---------------------------------------------------------
const gitLog = spawnSync('git', ['log', '--oneline', '-10'], { cwd: root, encoding: 'utf8' })
const commitsHtml =
  gitLog.status === 0
    ? `<ul class="mono">${gitLog.stdout.trim().split('\n').map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '<p class="dim">git log niet beschikbaar.</p>'

// --- Laatste beslissingen (cerebrum) ----------------------------------------
let decisionsHtml = '<p class="dim">Geen Decision Log gevonden in cerebrum.</p>'
const dl = latestDecisionLog(read('.wolf/cerebrum.md'))
if (dl) {
  decisionsHtml = `<p class="dim">${esc(dl.title)}</p><ul>${dl.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
}

// --- Compose -----------------------------------------------------------------
const nowFirstHtml = nowFirst.length
  ? `<h2>Nu eerst</h2>\n<ul class="now">${nowFirst.map((n) => msItem(`now::${n}`, n, false)).join('\n')}</ul>`
  : ''

const body = `
${nowFirstHtml}
<h2>Sporen — gewogen voortgang</h2>
${weightSum !== 100 ? `<div class="banner warn">Weights in .wolf/dashboard-tracks.json sommeren tot ${weightSum}, niet 100 — herstel dat eerst.</div>` : ''}
${trackCards}
<p><strong>Gewogen totaal: <span id="weightedTotal">${Math.round(weighted)}%</span></strong> <span id="arith" class="dim mono">(${esc(arithmetic)})</span></p>
<p>
<button class="btn" id="exportBtn" type="button">Kopieer bijgewerkte tracks-JSON</button>
<button class="btn ghost" id="resetBtn" type="button">Reset lokale vinkjes</button>
<span id="flash" class="dim" style="margin-left:10px"></span>
</p>
<textarea id="exportOut" readonly spellcheck="false"></textarea>
<p class="dim">Vinkjes rekenen live door in percentages, ring en totaal en worden in je browser bewaard (localStorage).
Definitief maken: "Kopieer bijgewerkte tracks-JSON" → plak in <code>.wolf/dashboard-tracks.json</code> → <code>npm run dashboard</code>. Afgevinkte "Nu eerst"-punten vallen bij export uit de lijst.</p>

<h2>Laatste testrun</h2>
${testHtml}

<h2>Engine-backlog</h2>
${backlogHtml}

<h2>Open items (docs/open-items.md)</h2>
${openItemsHtml}

<h2>Buglog</h2>
${buglogHtml}

<h2>Recente commits</h2>
${commitsHtml}

<h2>Laatste beslissingen</h2>
${decisionsHtml}
`

// --- Vragen-pagina uit het ANSWERS-blok van SESSION-PROMPT.md ---------------
let questionsMsg = 'questions.html overgeslagen (geen SESSION-PROMPT.md).'
if (existsSync(join(root, 'SESSION-PROMPT.md'))) {
  const answers = parseAnswers(read('SESSION-PROMPT.md'))
  const openCount = answers.filter((a) => a.open).length
  const groups = [...new Set(answers.map((a) => a.group))]
  const qBody = groups
    .map(
      (g) => `
<h2>${esc(g || 'Vragen')}</h2>
${answers
  .filter((a) => a.group === g)
  .map(
    (a) => `<div class="q${a.open ? ' openq' : ''}">
<div class="qhead"><span class="qid">${esc(a.id)}</span><span class="badge ${a.open ? 'warn' : 'ok'}">${a.open ? 'OPEN' : 'BEANTWOORD'}</span></div>
<p>${esc(a.question)}</p>
<p class="ans">${a.open ? 'Nog geen antwoord — vul het ANSWERS-blok in SESSION-PROMPT.md in.' : esc(a.answer)}</p>
</div>`,
  )
  .join('\n')}`,
    )
    .join('\n')
  writeFileSync(
    join(root, 'questions.html'),
    pageShell({
      title: 'LeylineSync — Vragen aan Jordy',
      subtitle: 'Beslissingen die alleen jij kunt nemen — bron: het ANSWERS-blok in SESSION-PROMPT.md.',
      generatedBy: 'npm run dashboard',
      active: 'questions',
      chips: [
        { text: `${openCount} open`, cls: openCount ? 'warn' : 'ok' },
        { text: `${answers.length - openCount} beantwoord`, cls: 'ok' },
      ],
      body: qBody || '<p class="dim">Geen ANSWERS-blok gevonden.</p>',
    }),
  )
  questionsMsg = `questions.html geschreven — ${openCount} open, ${answers.length - openCount} beantwoord.`
}

const interactivity = `const DATA = ${JSON.stringify({ comment: tracksData.comment, nowFirst, tracks })};
const KEY = 'leyline-dash-ticks';
let ticks = {}; try { ticks = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
const save = function () { localStorage.setItem(KEY, JSON.stringify(ticks)); };
const syncLi = function (cb) { const li = cb.closest('li'); if (li) li.classList.toggle('done', cb.checked); };

function recompute() {
  let sum = 0; const parts = [];
  document.querySelectorAll('.track').forEach(function (tr) {
    const boxes = tr.querySelectorAll('input[data-key]');
    let done = 0; boxes.forEach(function (b) { if (b.checked) done++; });
    const pct = boxes.length ? Math.round((100 * done) / boxes.length) : 0;
    tr.querySelector('.bar i').style.width = pct + '%';
    tr.querySelector('.pctv').textContent = pct + '%';
    const w = Number(tr.getAttribute('data-weight'));
    sum += w * pct; parts.push(w + '\\u00d7' + pct);
  });
  const total = Math.round(sum / 100);
  const tot = document.getElementById('weightedTotal'); if (tot) tot.textContent = total + '%';
  const ar = document.getElementById('arith'); if (ar) ar.textContent = '(' + parts.join(' + ') + ' = ' + sum + ' / 100)';
  const C = 2 * Math.PI * 54; const f = (C * Math.min(100, total)) / 100;
  const fg = document.getElementById('ringFg'); if (fg) fg.setAttribute('stroke-dasharray', f.toFixed(1) + ' ' + C.toFixed(1));
  const rp = document.getElementById('ringPct'); if (rp) rp.textContent = total + '%';
  const chip = document.querySelector('.meta .chip'); if (chip) chip.textContent = 'gewogen ' + total + '%';
}

document.querySelectorAll('input[data-key]').forEach(function (cb) {
  const k = cb.getAttribute('data-key');
  if (Object.prototype.hasOwnProperty.call(ticks, k)) cb.checked = ticks[k];
  syncLi(cb);
  cb.addEventListener('change', function () { ticks[k] = cb.checked; save(); syncLi(cb); recompute(); });
});
recompute();

function currentJson() {
  const tracksOut = DATA.tracks.map(function (t) {
    return { name: t.name, weight: t.weight, note: t.note, milestones: (t.milestones || []).map(function (m) {
      const k = 'ms::' + t.name + '::' + m.text;
      return { text: m.text, done: Object.prototype.hasOwnProperty.call(ticks, k) ? ticks[k] : m.done };
    }) };
  });
  const nowOut = DATA.nowFirst.filter(function (n) {
    const k = 'now::' + n;
    return !(Object.prototype.hasOwnProperty.call(ticks, k) ? ticks[k] : false);
  });
  return JSON.stringify({ comment: DATA.comment, nowFirst: nowOut, tracks: tracksOut }, null, 2);
}

function flash(msg) { const el = document.getElementById('flash'); el.textContent = msg; }

document.getElementById('exportBtn').addEventListener('click', function () {
  const json = currentJson();
  const out = document.getElementById('exportOut');
  out.style.display = 'block'; out.value = json; out.focus(); out.select();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(json).then(
      function () { flash('Gekopieerd — plak in .wolf/dashboard-tracks.json en draai npm run dashboard.'); },
      function () { flash('Klembord geblokkeerd — kopieer handmatig uit het tekstvak (staat al geselecteerd).'); }
    );
  } else { flash('Kopieer handmatig uit het tekstvak (staat al geselecteerd).'); }
});

document.getElementById('resetBtn').addEventListener('click', function () {
  ticks = {}; localStorage.removeItem(KEY);
  document.querySelectorAll('input[data-key]').forEach(function (cb) {
    cb.checked = cb.getAttribute('data-baked') === '1'; syncLi(cb);
  });
  recompute(); flash('Lokale vinkjes gewist — terug naar de vastgelegde stand.');
});`

writeFileSync(
  join(root, 'dev-dashboard.html'),
  pageShell({
    title: 'LeylineSync — Dev Dashboard',
    subtitle: `Stand van alle sporen · gegenereerd ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    generatedBy: 'npm run dashboard',
    active: 'dev',
    chips: [
      { text: `gewogen ${Math.round(weighted)}%` },
      { text: `backlog ${backlogFile ? parseBacklogBuckets(read(join(backlogDir, backlogFile))).total : '?'} kaarten` },
      { text: 'live: leylinesync.com', cls: 'ok' },
    ],
    ring: progressRing(weighted, 'totaal'),
    body,
    script: interactivity,
  }),
)
console.log(`dev-dashboard.html geschreven — gewogen totaal ${Math.round(weighted)}%. ${questionsMsg}`)
