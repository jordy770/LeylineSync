// AI deck-doctor — the pure grounding helpers. The model call itself is not tested
// here (it needs an API key); what matters is that candidates are assembled from the
// deterministic scan and that hallucinated picks are dropped.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildCandidateList, validatePicks } from '../../lib/collection/ai-recommend'
import type { RecommendCandidate } from '../../lib/collection/ai-recommend'
import type { UpgradeScanResult } from '../../lib/collection/upgrade-scanner'

function scan(): UpgradeScanResult {
  return {
    deckId: 'd1',
    power: { power: 4, buckets: {}, curve: {}, avgMv: 3, landCount: 34, nonlandCount: 60, needs: [], health: [], explanation: '' },
    free: [
      { in: { oracleId: 'o-arena', name: 'Phyrexian Arena', priceEur: 4.5 }, out: null, tag: 'card_draw', inWeight: 3, delta: 3, confidence: 80, themeImpact: 'Neutral', commanderSynergy: 50, reason: '' },
      { in: { oracleId: 'o-gftt', name: 'Go for the Throat', priceEur: 1.2 }, out: null, tag: 'removal', inWeight: 2, delta: 2, confidence: 70, themeImpact: 'Neutral', commanderSynergy: 0, reason: '' },
    ],
    occupied: [
      { in: { oracleId: 'o-esper', name: 'Esper Sentinel', priceEur: 30 }, tag: 'card_draw', weight: 3, confidence: 60, themeImpact: 'Neutral', commanderSynergy: 0, usedBy: [{ id: 'd2', name: 'Urza' }], action: 'move', reason: '' },
    ],
    deckList: [],
  }
}

test('buildCandidateList flattens free + occupied and dedupes by oracle', () => {
  const cands = buildCandidateList(scan())
  assert.equal(cands.length, 3)
  assert.ok(cands.find((c) => c.name === 'Phyrexian Arena' && c.source === 'free'))
  assert.ok(cands.find((c) => c.name === 'Esper Sentinel' && c.source === 'occupied'))
})

test('validatePicks keeps on-list cards and re-attaches truthful data', () => {
  const cands = buildCandidateList(scan())
  const picks = validatePicks(
    [
      { name: 'Phyrexian Arena', verdict: 'include', reason: 'consistent draw' },
      { name: 'go for the throat', verdict: 'consider', reason: 'cheap removal' }, // case-insensitive
    ],
    cands,
  )
  assert.equal(picks.length, 2)
  assert.equal(picks[0].oracleId, 'o-arena')
  assert.equal(picks[0].priceEur, 4.5)
  assert.equal(picks[1].name, 'Go for the Throat') // canonical name, not the model's casing
})

test('validatePicks DROPS hallucinated cards not in the candidate list', () => {
  const cands: RecommendCandidate[] = buildCandidateList(scan())
  const picks = validatePicks(
    [
      { name: 'Sol Ring', verdict: 'include', reason: 'invented — not owned/offered' },
      { name: 'Phyrexian Arena', verdict: 'include', reason: 'real' },
    ],
    cands,
  )
  assert.deepEqual(
    picks.map((p) => p.name),
    ['Phyrexian Arena'],
  )
})
