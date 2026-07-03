// Synergy tagger — heuristic role detection from oracle text. Uses real card
// wordings as fixtures so the regex rules are pinned to actual Magic phrasing.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tagCard } from '../../lib/collection/synergy/tagger'
import type { CardTag, SynergyTag, TaggerCard } from '../../lib/collection/synergy/tagger'

function card(overrides: Partial<TaggerCard>): TaggerCard {
  return { name: 'X', typeLine: 'Artifact', oracleText: null, keywords: [], cmc: 0, ...overrides }
}

function tags(c: TaggerCard): SynergyTag[] {
  return tagCard(c).map((t: CardTag) => t.tag)
}

test('Sol Ring → ramp + artifact', () => {
  const t = tags(card({ name: 'Sol Ring', typeLine: 'Artifact', oracleText: '{T}: Add {C}{C}.' }))
  assert.ok(t.includes('ramp'))
  assert.ok(t.includes('artifact'))
})

test('Cultivate (land ramp) → ramp, not tutor', () => {
  const t = tags(
    card({
      name: 'Cultivate',
      typeLine: 'Sorcery',
      oracleText:
        'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
    }),
  )
  assert.ok(t.includes('ramp'))
  assert.ok(!t.includes('tutor')) // "basic" excludes it from the tutor rule
})

test('Demonic Tutor → tutor', () => {
  const t = tags(card({ name: 'Demonic Tutor', typeLine: 'Sorcery', oracleText: 'Search your library for a card, put that card into your hand, then shuffle.' }))
  assert.ok(t.includes('tutor'))
})

test('Swords to Plowshares → removal', () => {
  const t = tags(card({ name: 'Swords to Plowshares', typeLine: 'Instant', oracleText: 'Exile target creature. Its controller gains life equal to its power.' }))
  assert.ok(t.includes('removal'))
})

test('Wrath of God → board_wipe (not plain removal-only)', () => {
  const t = tags(card({ name: 'Wrath of God', typeLine: 'Sorcery', oracleText: 'Destroy all creatures. They can\'t be regenerated.' }))
  assert.ok(t.includes('board_wipe'))
})

test('Counterspell → counterspell', () => {
  const t = tags(card({ name: 'Counterspell', typeLine: 'Instant', oracleText: 'Counter target spell.' }))
  assert.deepEqual(t, ['counterspell'])
})

test('Phyrexian Arena → card_draw (repeatable bump)', () => {
  const t = tagCard(
    card({
      name: 'Phyrexian Arena',
      typeLine: 'Enchantment',
      cmc: 3, // real MV — avoids the cheap-spell efficiency bump
      oracleText: 'At the beginning of your upkeep, you draw a card and you lose 1 life.',
    }),
  )
  const draw = t.find((x) => x.tag === 'card_draw')
  assert.ok(draw)
  assert.equal(draw.weight, 3, 'repeatable draw should be base 2 + 1 bump')
  assert.ok(t.some((x) => x.tag === 'enchantment'))
})

test('efficiency: a 1-mana removal spell outweighs a 7-mana one', () => {
  const cheap = tagCard(card({ typeLine: 'Instant', oracleText: 'Destroy target creature.', cmc: 1 }))
  const clunky = tagCard(card({ typeLine: 'Sorcery', oracleText: 'Destroy target creature.', cmc: 7 }))
  const cw = cheap.find((t) => t.tag === 'removal')!.weight
  const kw = clunky.find((t) => t.tag === 'removal')!.weight
  assert.ok(cw > kw, `expected cheap(${cw}) > clunky(${kw})`)
})

test('board wipes: a true wrath outweighs a minor mass -1/-1', () => {
  const wrath = tagCard(card({ typeLine: 'Sorcery', oracleText: 'Destroy all creatures.', cmc: 4 }))
  const minor = tagCard(card({ typeLine: 'Sorcery', oracleText: 'All creatures get -1/-1 until end of turn.', cmc: 3 }))
  assert.ok(wrath.find((t) => t.tag === 'board_wipe')!.weight > minor.find((t) => t.tag === 'board_wipe')!.weight)
})

test('Reanimate → reanimation', () => {
  const t = tags(card({ name: 'Reanimate', typeLine: 'Sorcery', oracleText: 'Put target creature card from a graveyard onto the battlefield under your control. You lose life equal to its mana value.' }))
  assert.ok(t.includes('reanimation'))
})

test('removal with an adjective before the noun is still removal (Go for the Throat / Doom Blade)', () => {
  assert.ok(tags(card({ name: 'Go for the Throat', typeLine: 'Instant', oracleText: 'Destroy target nonartifact creature.' })).includes('removal'))
  assert.ok(tags(card({ name: 'Doom Blade', typeLine: 'Instant', oracleText: 'Destroy target nonblack creature.' })).includes('removal'))
})

test('a basic land taps for mana but is NOT tagged ramp', () => {
  const t = tags(card({ name: 'Swamp', typeLine: 'Basic Land — Swamp', oracleText: '({T}: Add {B}.)' }))
  assert.ok(t.includes('land'))
  assert.ok(!t.includes('ramp'), 'lands must not count as ramp')
})

test('a vanilla creature earns no synergy tags', () => {
  assert.deepEqual(tags(card({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', oracleText: null, cmc: 2 })), [])
})

test('Lifelink keyword grants lifegain even with no matching text', () => {
  const t = tags(card({ name: 'Vampire', typeLine: 'Creature — Vampire', oracleText: 'Flying', keywords: ['Flying', 'Lifelink'] }))
  assert.ok(t.includes('lifegain'))
})

test('tags are sorted by descending weight', () => {
  const t = tagCard(card({ name: 'X', typeLine: 'Artifact', oracleText: '{T}: Add {C}{C}.' }))
  for (let i = 1; i < t.length; i += 1) assert.ok(t[i - 1].weight >= t[i].weight)
})
