// Leyline Intelligence Engine — classifyCard profiles (multi-role, tags,
// explainable rule hits) and commander synergy. Legacy-tag PARITY with the old
// tagger is pinned separately by synergy-tagger.test.ts (same 15 tests, now
// running through this engine).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyCard } from '../../lib/intelligence/card-engine'
import { allCommanderSynergies, commanderSynergy, COMMANDER_PROFILES } from '../../lib/intelligence/commander-profiles'

const card = (over: Partial<Parameters<typeof classifyCard>[0]>) => ({
  name: 'Test Card',
  typeLine: 'Creature — Human',
  oracleText: null,
  keywords: [],
  cmc: 3,
  ...over,
})

test('a mana rock gets mana_rock + ramp roles with rule evidence', () => {
  const p = classifyCard(card({
    name: 'Worn Powerstone', typeLine: 'Artifact', oracleText: '{T}: Add {C}{C}.', cmc: 3,
  }))
  const roles = p.roles.map((r) => r.role)
  assert.ok(roles.includes('mana_rock'))
  assert.ok(roles.includes('ramp'))
  assert.ok(p.hits.some((h) => h.ruleId === 'mana.rock'))
  // The legacy view still carries plain 'ramp' for the score contract.
  assert.ok(p.legacyTags.some((t) => t.tag === 'ramp'))
})

test('a mana dork is mana_dork, not mana_rock', () => {
  const p = classifyCard(card({
    name: 'Llanowar Elves', typeLine: 'Creature — Elf Druid', oracleText: '{T}: Add {G}.', cmc: 1,
  }))
  const roles = p.roles.map((r) => r.role)
  assert.ok(roles.includes('mana_dork'))
  assert.ok(!roles.includes('mana_rock'))
  assert.ok(p.tags.includes('elf'))
})

test('an aristocrats payoff gets the role plus dies_trigger tag with evidence', () => {
  const p = classifyCard(card({
    name: 'Blood Artist', typeLine: 'Creature — Vampire',
    oracleText: 'Whenever this creature or another creature dies, target player loses 1 life and you gain 1 life.',
    cmc: 2,
  }))
  assert.ok(p.roles.some((r) => r.role === 'aristocrats'))
  const hit = p.hits.find((h) => h.ruleId === 'aristocrats.dies-payoff')
  assert.ok(hit?.evidence?.includes('dies'))
  assert.ok(p.tags.includes('vampire'))
})

test('politics: goad and monarch are recognised', () => {
  const goad = classifyCard(card({ typeLine: 'Sorcery', oracleText: 'Goad each creature target player controls.' }))
  assert.ok(goad.roles.some((r) => r.role === 'politics'))
  assert.ok(goad.tags.includes('goad'))
  const monarch = classifyCard(card({ typeLine: 'Enchantment', oracleText: 'When this enters, you become the monarch.' }))
  assert.ok(monarch.tags.includes('monarch'))
})

test('every rule hit carries its id and description (explainability contract)', () => {
  const p = classifyCard(card({
    name: 'Rhystic Study', typeLine: 'Enchantment',
    oracleText: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
    cmc: 3,
  }))
  assert.ok(p.hits.length > 0)
  for (const h of p.hits) {
    assert.match(h.ruleId, /^[a-z]+\.[a-z0-9-]+$/)
    assert.ok(h.description.length > 10)
  }
  // Repeatable draw → draw_engine role.
  assert.ok(p.roles.some((r) => r.role === 'draw_engine'))
})

test('commander synergy scores trace to named contributions', () => {
  const zombieLord = classifyCard(card({
    name: 'Lord of the Accursed', typeLine: 'Creature — Zombie',
    oracleText: 'Other Zombies you control get +1/+1.', cmc: 3,
  }))
  const wilhelt = COMMANDER_PROFILES.find((p) => p.name.startsWith('Wilhelt'))!
  const syn = commanderSynergy(zombieLord, wilhelt)
  assert.ok(syn.score >= 4) // at least the zombie tribe like
  assert.ok(syn.contributions.some((c) => c.key === 'zombie'))

  const ranked = allCommanderSynergies(zombieLord)
  assert.equal(ranked[0].commander, wilhelt.name)
})

test('an instant counterspell ranks Talrand above Kaalia', () => {
  const counter = classifyCard(card({
    name: 'Counterspell', typeLine: 'Instant', oracleText: 'Counter target spell.', cmc: 2,
  }))
  const ranked = allCommanderSynergies(counter)
  const talrand = ranked.findIndex((s) => s.commander.startsWith('Talrand'))
  const kaalia = ranked.findIndex((s) => s.commander.startsWith('Kaalia'))
  assert.ok(talrand !== -1)
  assert.ok(kaalia === -1 || talrand < kaalia)
})
