// The original synergy-tagger heuristics (lib/collection/synergy/tagger.ts),
// ported 1:1 into named, versioned rules. Regexes and weights are UNCHANGED —
// the compat pipeline over these rules must reproduce the old tagCard() output
// exactly (pinned by tests/unit/synergy-tagger.test.ts). New capabilities go in
// extended.ts, never here.

import type { Rule } from '../models'

const re = (pattern: RegExp, id: string, description: string, legacyTag: string, weight: number, extra: Partial<Rule> = {}): Rule => ({
  id,
  description,
  version: 1,
  legacyTag,
  weight,
  test: (ctx) => {
    const m = ctx.text.match(pattern)
    return m ? m[0].slice(0, 80) : null
  },
  ...extra,
})

export const LEGACY_RULES: Rule[] = [
  // ── ramp ──
  re(/\badd\s+(?:\{[wubrgcx0-9/]+\}|one mana|two mana|three mana|that much mana|\w+ mana of any)/,
    'ramp.adds-mana', "Oracle text adds mana (e.g. 'Add {G}')", 'ramp', 2, { roles: ['ramp'] }),
  re(/search your library for .*?\bland\b.*?(?:onto the battlefield|put (?:it|them) onto the battlefield)/,
    'ramp.lands-to-battlefield', 'Searches lands directly onto the battlefield', 'ramp', 2, { roles: ['ramp'] }),
  re(/play (?:an )?additional land|additional land each turn/,
    'ramp.extra-land-drop', 'Grants additional land plays', 'ramp', 1, { roles: ['ramp'] }),

  // ── targeted removal ──
  re(/(?:destroy|exile) target (?:[a-z]+ ){0,3}(?:creature|permanent|artifact|enchantment|planeswalker|nonland|land|token)/,
    'removal.destroy-exile-target', 'Destroys or exiles a target permanent', 'removal', 2, { roles: ['spot_removal'] }),
  re(/deals?\s+\d+\s+damage to (?:target|any target|that creature)/,
    'removal.targeted-damage', 'Deals direct damage to a target', 'removal', 2, { roles: ['spot_removal'] }),
  re(/target creature gets [-−]\d+\/[-−]\d+/,
    'removal.minus-minus', 'Shrinks a target creature (-X/-X)', 'removal', 1, { roles: ['spot_removal'] }),
  re(/return target (?:creature|permanent|nonland permanent) to its owner'?s hand/,
    'removal.bounce', "Bounces a target to its owner's hand", 'removal', 1, { roles: ['spot_removal'] }),
  re(/fight target|target creature fights/,
    'removal.fight', 'Fights a target creature', 'removal', 1, { roles: ['spot_removal'] }),

  // ── board wipes ──
  re(/destroy all|exile all (?:creatures|permanents)/,
    'wipe.hard', 'Destroys or exiles ALL creatures/permanents', 'board_wipe', 3, { roles: ['board_wipe'] }),
  re(/each creature gets [-−]\d+\/[-−]\d+|deals?\s+\d+\s+damage to each (?:creature|opponent)|all creatures get [-−]/,
    'wipe.soft', 'Mass -X/-X or damage to each creature', 'board_wipe', 2, { roles: ['board_wipe'] }),

  // ── counterspells ──
  re(/counter target (?:spell|activated|triggered|ability)/,
    'counter.target-spell', 'Counters a target spell or ability', 'counterspell', 2, { roles: ['counterspell'] }),

  // ── card draw ──
  re(/draws? (?:a card|two cards|three cards|\w+ cards|cards equal|that many cards)/,
    'draw.cards', 'Draws one or more cards', 'card_draw', 2, { roles: ['card_draw'] }),

  // ── tutor ──
  re(/search your library for (?:a|an|up to (?:one|two|three))(?![^.]*\bbasic\b)[^.]*\bcard\b/,
    'tutor.nonbasic-search', 'Searches the library for a (non-basic) card', 'tutor', 2, { roles: ['tutor'] }),

  // ── recursion / reanimation ──
  re(/return target creature card from (?:your|a) graveyard to the battlefield|put target creature card from .*?graveyard onto the battlefield/,
    'reanimate.to-battlefield', 'Reanimates a creature card from a graveyard to the battlefield', 'reanimation', 2, { roles: ['reanimator'] }),
  re(/return (?:target|all|each)?[^.]*card[s]? from (?:your|a) graveyard to (?:your hand|the battlefield)|return [^.]*from your graveyard/,
    'recursion.from-graveyard', 'Returns cards from the graveyard', 'recursion', 1, { roles: ['recursion'] }),

  // ── protection ──
  re(/hexproof|shroud|indestructible|protection from|can't be (?:countered|targeted)|prevent (?:all|the next)/,
    'protection.grants', 'Grants hexproof/indestructible/protection or prevents damage', 'protection', 1, { roles: ['protection'] }),

  // ── tokens ──
  re(/create (?:a|an|x|that many|\w+) [^.]*token/,
    'token.creates', 'Creates one or more tokens', 'token', 2, { roles: ['token_generator'] }),

  // ── life ──
  re(/gains? \d+ life|gain that much life|you gain life/,
    'life.gain', 'Gains life', 'lifegain', 1, { roles: ['lifegain'] }),
  re(/(?:each|target) (?:opponent|player) loses \d+ life|loses? that much life|drain/,
    'life.drain', 'Makes opponents lose life', 'lifeloss', 1, { roles: ['lifedrain'] }),

  // ── sacrifice ──
  re(/sacrifice (?:a|an|another|two|three|x|target|that|this|each)/,
    'sac.sacrifices', 'Sacrifices permanents', 'sacrifice', 1, { roles: ['sacrifice_outlet'] }),

  // ── spellslinger ──
  re(/instant (?:and|or) sorcery|whenever you cast (?:an|your first|a noncreature)[^.]*(?:instant|sorcery|noncreature)|noncreature spell/,
    'spellslinger.matters', 'Cares about instants/sorceries being cast', 'spellslinger', 1, { roles: ['spellslinger'] }),

  // ── blink ──
  re(/exile [^.]*(?:return (?:it|that card|them|those cards))[^.]*battlefield/,
    'blink.flicker', 'Exiles and returns permanents (blink)', 'blink', 1, { roles: ['blink'] }),

  // ── graveyard / mill ──
  re(/\bmill\b|put (?:the top|that many)[^.]*into (?:your|their) graveyard|cards? in (?:your|each) graveyard|from your graveyard/,
    'graveyard.matters', 'Mills or cares about graveyards', 'graveyard', 1, { roles: ['mill'] }),

  // ── win conditions ──
  re(/wins? the game|can't lose the game/,
    'win.states-win', "States 'you win the game' (or can't lose)", 'win_condition', 3, { roles: ['win_condition'] }),

  // ── type-line & "matters" rules (were special-cases in the old tagger) ──
  {
    id: 'type.artifact', description: 'Type line contains Artifact', version: 1,
    legacyTag: 'artifact', weight: 1, tags: ['artifact'],
    test: (ctx) => /\bartifact\b/.test(ctx.type),
  },
  {
    id: 'type.enchantment', description: 'Type line contains Enchantment', version: 1,
    legacyTag: 'enchantment', weight: 1, tags: ['enchantment'],
    test: (ctx) => /\benchantment\b/.test(ctx.type),
  },
  {
    id: 'type.land', description: 'Type line contains Land', version: 1,
    legacyTag: 'land', weight: 1, tags: ['land'],
    test: (ctx) => /\bland\b/.test(ctx.type),
  },
  {
    id: 'matters.artifacts', description: "Cares about artifacts ('artifacts you control', …)", version: 1,
    legacyTag: 'artifact', weight: 2, roles: ['artifacts_matter'],
    test: (ctx) => {
      const m = ctx.text.match(/artifacts you control|whenever an artifact|target artifact/)
      return m ? m[0] : null
    },
  },
  {
    id: 'matters.enchantments', description: "Cares about enchantments ('enchantments you control', …)", version: 1,
    legacyTag: 'enchantment', weight: 2, roles: ['enchantments_matter'],
    test: (ctx) => {
      const m = ctx.text.match(/enchantments you control|whenever an enchantment|target enchantment/)
      return m ? m[0] : null
    },
  },
  {
    id: 'keyword.lifelink', description: 'Has the lifelink keyword', version: 1,
    legacyTag: 'lifegain', weight: 1, roles: ['lifegain'],
    test: (ctx) => ctx.keywords.includes('lifelink'),
  },
]
