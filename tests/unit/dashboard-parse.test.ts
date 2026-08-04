import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error — plain .mjs helper module without type declarations
import { parseBacklogBuckets, countOpenItems, latestDecisionLog, parseAnswers, trackPct } from '../../scripts/lib/dashboard-parse.mjs'

const backlogMd = `# Engine-blocked backlog

Ververst 2026-07-18. **280 kaarten** die de audit flagde.

| # | Ontbrekende primitive | Kaarten |
|---|---|---|
| 1 | Other / misc (no clean bucket) | 136 |
| 2 | Alternative / additional casting cost | 31 |
| 3 | Per-opponent / dynamic target count | 12 |
`

test('parseBacklogBuckets reads the bucket table and the bold total', () => {
  const { buckets, total } = parseBacklogBuckets(backlogMd)
  assert.equal(total, 280)
  assert.equal(buckets.length, 3)
  assert.deepEqual(buckets[1], { rank: 2, name: 'Alternative / additional casting cost', count: 31 })
})

test('parseBacklogBuckets falls back to summing buckets without a bold total', () => {
  const md = '| 1 | A | 4 |\n| 2 | B | 6 |\n'
  assert.equal(parseBacklogBuckets(md).total, 10)
})

const openItemsMd = `# Open items

## ✅ Closed since the roadmap froze

- something done

## 🔴 Genuinely open

### Bug
1. ~~**Draw-floor bug**~~ — ✅ **FIXED (mig 334)**. Details
   over two lines.

### Engine deferred-by-choice
2. **Castable prevent-damage spell** — OPEN.
3. **Opponent damage shields** — PARTIAL.

## 🔵 Architecture frontier

- not a numbered item
`

test('countOpenItems counts numbered items, treating ✅/~~ as closed, within the 🔴 section only', () => {
  assert.deepEqual(countOpenItems(openItemsMd), { open: 2, closed: 1 })
})

test('countOpenItems returns zeros when the section is missing', () => {
  assert.deepEqual(countOpenItems('# nothing here'), { open: 0, closed: 0 })
})

const cerebrumMd = `# Cerebrum

## Decision Log

- old decision

## Key Learnings — 2026-07-01

- a learning

## Decision Log — 2026-08-04 (ANSWERS)

- **Sessieprioriteit: engine-backlog-rounds**, bucket 2 eerst.
- **Commit-beleid bevestigd.**

## Key Learnings — later

- irrelevant
`

test('latestDecisionLog returns the LAST Decision Log section, bullets only', () => {
  const dl = latestDecisionLog(cerebrumMd)
  assert.ok(dl)
  assert.match(dl.title, /2026-08-04/)
  assert.equal(dl.bullets.length, 2)
  assert.match(dl.bullets[0], /bucket 2/)
})

const sessionPromptMd = `# Prompt

wat proza met een dubbelepunt: die niet meetelt.

## ANSWERS

\`\`\`
--- Richting van de sessie ---
A1 — Welk spoor krijgt prioriteit: engine, collection,
     of iets anders: engine-backlog-rounds

--- Beslissingen die openstaan ---
A2 — Wat wordt de paywall-grens en wat blijft gratis:
A3 — Redesign nu bouwen, of eerst het andere spoor
     afmaken: Collection-spoor afmaken
\`\`\`
`

test('parseAnswers splits question and answer on the LAST colon, spanning wrapped lines', () => {
  const answers = parseAnswers(sessionPromptMd)
  assert.equal(answers.length, 3)
  assert.deepEqual(
    answers.map((a: { id: string; open: boolean }) => [a.id, a.open]),
    [['A1', false], ['A2', true], ['A3', false]],
  )
  assert.equal(answers[0].answer, 'engine-backlog-rounds')
  assert.match(answers[0].question, /engine, collection, of iets anders$/)
  assert.equal(answers[0].group, 'Richting van de sessie')
  assert.equal(answers[2].group, 'Beslissingen die openstaan')
  assert.equal(answers[2].answer, 'Collection-spoor afmaken')
})

test('parseAnswers returns empty without an ANSWERS block', () => {
  assert.deepEqual(parseAnswers('# niets'), [])
})

test('trackPct derives the percentage from milestones, with pct as fallback', () => {
  assert.equal(trackPct({ milestones: [{ done: true }, { done: true }, { done: false }] }), 67)
  assert.equal(trackPct({ milestones: [] , pct: 40 }), 40)
  assert.equal(trackPct({}), 0)
  assert.equal(trackPct({ milestones: [{ done: true }] }), 100)
})
