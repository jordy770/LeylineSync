// Extended rule set — the NEW vocabulary on top of the ported legacy rules.
// These rules only feed roles/tags (no legacyTag), so the legacy SynergyTag
// view — and every score derived from it — is untouched until consumers opt in.
//
// Conventions: id 'category.slug', description = one human sentence, matchers
// return the matched excerpt as evidence where possible. Keep each rule small
// and single-purpose; hundreds of small rules beat one big classifier.

import type { Rule, RuleContext } from '../models'

const text = (pattern: RegExp, id: string, description: string, grant: Partial<Rule>): Rule => ({
  id,
  description,
  version: 1,
  test: (ctx) => {
    const m = ctx.text.match(pattern)
    return m ? m[0].slice(0, 80) : null
  },
  ...grant,
})

const type = (pattern: RegExp, id: string, description: string, grant: Partial<Rule>): Rule => ({
  id,
  description,
  version: 1,
  test: (ctx) => pattern.test(ctx.type),
  ...grant,
})

// Creature-type tags: one data-driven rule per tribe the app cares about.
const TRIBES = [
  'zombie', 'goblin', 'elf', 'vampire', 'dragon', 'angel', 'demon', 'wizard',
  'human', 'spirit', 'soldier', 'dinosaur', 'sliver', 'merfolk', 'elemental', 'cat',
] as const
const tribeRules: Rule[] = TRIBES.map((tribe) => ({
  id: `tribe.${tribe}`,
  description: `Type line contains the ${tribe[0].toUpperCase()}${tribe.slice(1)} creature type`,
  version: 1,
  tags: [tribe],
  test: (ctx: RuleContext) => new RegExp(`\\b${tribe}\\b`).test(ctx.type),
}))

export const EXTENDED_RULES: Rule[] = [
  // ── mana base refinement ──
  {
    id: 'mana.rock', description: 'A noncreature artifact that adds mana (mana rock)', version: 1,
    roles: ['mana_rock', 'ramp'], tags: ['mana_rock'],
    test: (ctx) => /\bartifact\b/.test(ctx.type) && !/\bcreature\b/.test(ctx.type) && /\badd\s+(?:\{|one mana|\w+ mana)/.test(ctx.text),
  },
  {
    id: 'mana.dork', description: 'A creature that adds mana (mana dork)', version: 1,
    roles: ['mana_dork', 'ramp'], tags: ['mana_dork'],
    test: (ctx) => /\bcreature\b/.test(ctx.type) && /\{t\}: add/.test(ctx.text),
  },
  text(/add (?:one mana of any color|\w+ mana in any combination|two mana in any combination)/,
    'mana.fixing', 'Fixes colors (any-color mana)', { roles: ['mana_fixing'], tags: ['mana_fixing'] }),

  // ── draw refinement ──
  {
    id: 'draw.engine', description: 'Draws repeatedly (a triggered/upkeep draw engine)', version: 1,
    roles: ['draw_engine', 'value_engine'], tags: ['draw_engine'],
    test: (ctx) => ctx.repeatable && /draws? (?:a card|two cards)/.test(ctx.text),
  },
  text(/each player (?:discards? (?:their|his or her) hand|shuffles? (?:their|his or her) hand)[^.]*draws? (?:seven|that many)/,
    'draw.wheel', 'Wheels: everyone discards and redraws', { roles: ['wheel', 'discard'], tags: ['wheel'] }),

  // ── interaction refinement ──
  text(/(?:target|each) (?:player|opponent) discards?/,
    'discard.targeted', 'Forces opponents to discard', { roles: ['discard'], tags: ['discard'] }),
  text(/exile (?:all cards from )?(?:target player's|each player's|all) graveyards?|exile [^.]*graveyard/,
    'gyhate.exiles-graveyards', 'Exiles cards from graveyards (graveyard hate)', { roles: ['graveyard_hate'], tags: ['graveyard_hate'] }),
  text(/(?:players|spells|opponents) (?:can't|cost \{?\d+\}? more)|doesn't untap|don't untap during|skips? (?:their|that player's)/,
    'stax.restriction', 'Restricts or taxes what opponents can do (stax)', { roles: ['stax'], tags: ['stax'] }),

  // ── counters & proliferate ──
  text(/\bproliferate\b/, 'counters.proliferate', 'Proliferates', { roles: ['proliferate', 'counters_matter'], tags: ['proliferate'] }),
  {
    id: 'counters.matter', description: 'Places or cares about +1/+1 counters', version: 1,
    roles: ['counters_matter'], tags: ['plus_one_counters'],
    test: (ctx) => {
      const m = ctx.text.match(/\+1\/\+1 counter/)
      return m ? m[0] : null
    },
  },

  // ── landfall ──
  text(/landfall|whenever a land (?:enters|you control enters)/,
    'land.landfall', 'Landfall: triggers on lands entering', { roles: ['landfall'], tags: ['landfall'] }),

  // ── artifacts/equipment/vehicles/auras ──
  type(/\bequipment\b/, 'type.equipment', 'Is an Equipment', { roles: ['equipment'], tags: ['equipment'] }),
  type(/\baura\b/, 'type.aura', 'Is an Aura', { roles: ['aura'], tags: ['aura'] }),
  type(/\bvehicle\b/, 'type.vehicle', 'Is a Vehicle', { roles: ['vehicle'], tags: ['vehicle'] }),
  type(/\blegendary\b/, 'type.legendary', 'Is legendary', { tags: ['legendary'] }),
  type(/\bplaneswalker\b/, 'type.planeswalker', 'Is a planeswalker', { tags: ['planeswalker'] }),

  // ── clones / copies ──
  text(/(?:enters|you may have [^.]*enter)[^.]*as a copy of|copy of (?:any|target|that) (?:creature|permanent|spell)/,
    'clone.copies', 'Copies a permanent or spell', { roles: ['clone'], tags: ['clone'] }),

  // ── turns & combat ──
  text(/take[s]? (?:an extra|two extra) turns?|extra turn after this one/,
    'turns.extra', 'Grants extra turns', { roles: ['extra_turns', 'win_condition'], tags: ['extra_turns'] }),
  text(/additional combat phase|untap all creatures [^.]*(?:combat|attack)/,
    'combat.extra', 'Grants extra combat phases', { roles: ['extra_combat'], tags: ['extra_combat'] }),

  // ── politics ──
  text(/\bgoad\b/, 'politics.goad', 'Goads creatures', { roles: ['politics'], tags: ['goad'] }),
  text(/becomes? the monarch/, 'politics.monarch', 'Introduces the monarch', { roles: ['politics'], tags: ['monarch'] }),
  text(/\bcouncil's dilemma\b|\bwill of the council\b|players? vote/,
    'politics.vote', 'Makes players vote', { roles: ['politics'], tags: ['vote'] }),

  // ── treasures & energy ──
  text(/treasure token/, 'treasure.makes', 'Creates Treasure tokens', { roles: ['treasure', 'ramp'], tags: ['treasure'] }),
  text(/\{e\}|energy counter/, 'energy.uses', 'Produces or spends energy', { roles: ['energy'], tags: ['energy'] }),

  // ── aristocrats (dies-triggers payoff) ──
  {
    id: 'aristocrats.dies-payoff', description: 'Pays off creatures dying (aristocrats)', version: 1,
    roles: ['aristocrats', 'value_engine'], tags: ['dies_trigger'],
    test: (ctx) => {
      const m = ctx.text.match(/whenever (?:a|another|this) creature[^.]*dies[^.]*(?:lose[s]? \d+ life|gain[s]? \d+ life|draw|deal|counter)/)
      return m ? m[0].slice(0, 80) : null
    },
  },

  // ── storm & cascade ──
  text(/\bstorm\b(?! ?crow)/, 'mech.storm', 'Has storm', { roles: ['storm', 'combo_piece'], tags: ['storm'] }),
  text(/\bcascade\b/, 'mech.cascade', 'Has cascade', { roles: ['value_engine'], tags: ['cascade'] }),

  // ── evasion & anthems ──
  {
    id: 'evasion.keywords', description: 'Has evasion (flying/menace/trample/unblockable)', version: 1,
    roles: ['evasion'], tags: ['evasion'],
    test: (ctx) => /\bcreature\b/.test(ctx.type)
      && (ctx.keywords.some((k) => ['flying', 'menace', 'trample', 'shadow', 'fear', 'intimidate'].includes(k))
        || /can't be blocked/.test(ctx.text)),
  },
  text(/creatures you control get \+\d+\/\+\d+(?! until end of turn)/,
    'anthem.static', 'Static team-wide pump (anthem)', { roles: ['anthem'], tags: ['anthem'] }),
  {
    id: 'tribal.payoff', description: 'Pays off a creature TYPE you control (tribal lord/payoff)', version: 1,
    roles: ['tribal_payoff', 'anthem'], tags: ['tribal'],
    test: (ctx) => {
      const m = ctx.text.match(/(?:other )?(\w+)s you control get \+|whenever (?:a|another) (\w+) (?:you control )?(?:enters|dies|attacks)/)
      return m ? m[0].slice(0, 80) : null
    },
  },

  // ── mechanic hint-tags (cheap building blocks for commander profiles) ──
  {
    id: 'hint.etb', description: 'Has an enters-the-battlefield trigger', version: 1, tags: ['etb'],
    test: (ctx) => /when (?:this|[^.]{0,40}) enters(?: the battlefield)?\b/.test(ctx.text),
  },
  {
    id: 'hint.dies', description: 'Has a dies trigger', version: 1, tags: ['dies_trigger'],
    test: (ctx) => /when(?:ever)? (?:this creature|this|[^.]{0,40}) dies/.test(ctx.text),
  },
  { id: 'hint.flash', description: 'Has flash', version: 1, tags: ['flash'], test: (ctx) => ctx.keywords.includes('flash') },
  { id: 'hint.instant', description: 'Is an instant', version: 1, tags: ['instant'], test: (ctx) => /\binstant\b/.test(ctx.type) },
  { id: 'hint.sorcery', description: 'Is a sorcery', version: 1, tags: ['sorcery'], test: (ctx) => /\bsorcery\b/.test(ctx.type) },
  { id: 'hint.cheap', description: 'Mana value 2 or less', version: 1, tags: ['cheap'], test: (ctx) => ctx.card.cmc <= 2 },
  { id: 'hint.high-cmc', description: 'Mana value 6 or more', version: 1, tags: ['high_cmc'], test: (ctx) => ctx.card.cmc >= 6 },
  {
    id: 'hint.attack-trigger', description: 'Triggers on attacking', version: 1, tags: ['attack_trigger'],
    test: (ctx) => /whenever (?:this creature|[^.]{0,40}) attacks/.test(ctx.text),
  },
  {
    id: 'hint.cast-from-graveyard', description: 'Casts or plays cards from the graveyard', version: 1, tags: ['graveyard_casting'],
    test: (ctx) => /(?:cast|play)[^.]{0,60}from (?:your|the) graveyard/.test(ctx.text),
  },

  ...tribeRules,
]
