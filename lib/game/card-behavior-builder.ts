// Guided card-behavior form model: a structured representation of the subset of
// V2 card scripts the form editor can build, plus conversions to/from the raw
// script JSON. Scripts using features the form does not model round-trip to
// `null` from `parseScriptToForm`, signalling the editor to stay in JSON mode.

import type { CardScript, ManaColor } from './types'
import {
  EFFECT_RECIPIENTS,
  EFFECT_TOKEN_NAMES,
  effectDefault,
  effectFromJson,
  effectToJson as registryEffectToJson,
  effectsForContext,
  type RegistryEffect,
} from './card-behavior-registry'

// ─── Vocabulary ──────────────────────────────────────────────────────────────

// Keyword continuous effects the runtime registers (register_keyword_continuous_effects).
export const BUILDER_KEYWORDS = [
  'flying',
  'reach',
  'haste',
  'vigilance',
  'trample',
  'indestructible',
  'first_strike',
  'double_strike',
  'deathtouch',
] as const
export type BuilderKeyword = (typeof BUILDER_KEYWORDS)[number]

// Trigger events wired in migrations 076–077.
export const BUILDER_TRIGGER_EVENTS = [
  { value: 'enters_the_battlefield', label: 'When it enters the battlefield' },
  { value: 'leaves_the_battlefield', label: 'When it leaves the battlefield' },
  { value: 'dies', label: 'When it dies' },
  { value: 'attacks', label: 'When it attacks' },
  { value: 'blocks', label: 'When it blocks' },
  { value: 'becomes_targeted', label: 'When it becomes the target of a spell or ability' },
  { value: 'beginning_of_upkeep', label: 'At the beginning of your upkeep' },
  { value: 'beginning_of_draw_step', label: 'At the beginning of your draw step' },
  { value: 'beginning_of_end_step', label: 'At the beginning of your end step' },
  { value: 'creature_entered', label: 'When another/a creature enters (use filter)' },
  { value: 'creature_died', label: 'When a creature dies (use filter)' },
  { value: 'creature_got_counter', label: 'When a creature gets a +1/+1 counter (use filter)' },
] as const
export type BuilderTriggerEvent = (typeof BUILDER_TRIGGER_EVENTS)[number]['value']

// Recipient / token vocab now lives in the effect registry (single source of
// truth); re-exported here so existing form/guide imports keep working.
export const BUILDER_RECIPIENTS = EFFECT_RECIPIENTS
export type BuilderRecipient = (typeof BUILDER_RECIPIENTS)[number]['value']

// Token names available to the create_token effect (matches the seeded catalog).
export const BUILDER_TOKEN_NAMES = EFFECT_TOKEN_NAMES
export type BuilderTokenName = (typeof BUILDER_TOKEN_NAMES)[number]

// Auto-resolved effect types apply_triggered_ability_effects applies for triggers.
export type BuilderEffect =
  | { type: 'gain_life'; amount: number; recipient?: BuilderRecipient }
  | { type: 'lose_life'; amount: number; recipient: BuilderRecipient }
  | { type: 'deal_damage'; amount: number; recipient: BuilderRecipient }
  | { type: 'draw'; amount: number }
  | { type: 'create_token'; token: string; count: number }
  | { type: 'add_counters'; amount: number }
  | { type: 'add_counters_all'; amount: number; target_controller: string }
  | { type: 'tap_all'; target_controller: string }
  | { type: 'untap_all'; target_controller: string }
  | { type: 'scry'; amount: number }
  | { type: 'surveil'; amount: number }
  | { type: 'mill'; amount: number; recipient: BuilderRecipient }
  | { type: 'search_library'; count: number; to: string; filter: { type_line: string } }
  | { type: 'discard'; count: number }
  | { type: 'may'; prompt: string; effects: BuilderEffect[] }
  | { type: 'choose_player'; filter: string; effects: BuilderEffect[] }
  | { type: 'conditional'; condition: { count: string; type_line: string; at_least: number }; effects: BuilderEffect[] }
  | { type: 'destroy'; target: string }
  | { type: 'exile'; target: string }
  | { type: 'bounce'; target: string }
  | { type: 'tap'; target: string }
  | { type: 'untap'; target: string }
  | { type: 'pump'; power: number; toughness: number; target: string }
  | { type: 'grant_keyword'; keyword: string; target: string }
  | { type: 'fight'; target: string }
  | { type: 'gain_control'; duration: string; target: string }

// Trigger-context effect options, derived from the registry.
export const BUILDER_EFFECT_TYPES = effectsForContext('trigger')
export type BuilderEffectType = BuilderEffect['type']

// The "other-scoped" watcher events that take a filter (which entering/dying/
// counter-getting creature the watcher reacts to). Self events ignore the filter.
export const BUILDER_WATCHER_EVENTS = ['creature_entered', 'creature_died', 'creature_got_counter'] as const

export const BUILDER_TRIGGER_CONTROLLERS = [
  { value: 'you', label: 'you control' },
  { value: 'opponent', label: 'an opponent controls' },
  { value: 'any', label: 'anyone controls' },
] as const
export type BuilderTriggerController = (typeof BUILDER_TRIGGER_CONTROLLERS)[number]['value']

// A watcher trigger's filter: which creature it fires on. typeLine '' = any type;
// controller defaults to 'you' (the engine default — a bare watcher only sees your
// creatures); excludeSelf = the "another …" wording. Cemetery/Champion tribal cards.
export type BuilderTriggerFilter = {
  typeLine: string
  controller: BuilderTriggerController
  excludeSelf: boolean
  // "a NONTOKEN creature …" — ignore token creatures (Midnight Reaper).
  nontoken: boolean
}

export function emptyTriggerFilter(): BuilderTriggerFilter {
  return { typeLine: '', controller: 'you', excludeSelf: false, nontoken: false }
}

export function isWatcherEvent(event: string): boolean {
  return (BUILDER_WATCHER_EVENTS as readonly string[]).includes(event)
}

export type BuilderTrigger = {
  event: BuilderTriggerEvent
  filter: BuilderTriggerFilter
  effects: BuilderEffect[]
}

// ─── Spell effect (instant / sorcery) ───────────────────────────────────────────
//
// The form currently models the untargeted self-library spell effects (scry /
// surveil). A spell using anything else (targeted destroy/exile, damage, …)
// round-trips to null so the editor stays in JSON mode.

export type BuilderSpellEffect =
  | { type: 'gain_life'; amount: number; recipient?: BuilderRecipient }
  | { type: 'lose_life'; amount: number; recipient: BuilderRecipient }
  | { type: 'scry'; amount: number }
  | { type: 'surveil'; amount: number }
  | { type: 'draw'; amount: number }
  | { type: 'mill'; amount: number; recipient: BuilderRecipient }
  | { type: 'add_counters_all'; amount: number; target_controller: string }
  | { type: 'tap_all'; target_controller: string }
  | { type: 'untap_all'; target_controller: string }
  | { type: 'search_library'; count: number; to: string; filter: { type_line: string } }
  | { type: 'discard'; count: number }
  | { type: 'may'; prompt: string; effects: BuilderEffect[] }
  | { type: 'choose_player'; filter: string; effects: BuilderEffect[] }
  | { type: 'conditional'; condition: { count: string; type_line: string; at_least: number }; effects: BuilderEffect[] }
  | { type: 'destroy'; target: string }
  | { type: 'exile'; target: string }
  | { type: 'bounce'; target: string }
  | { type: 'tap'; target: string }
  | { type: 'untap'; target: string }
  | { type: 'pump'; power: number; toughness: number; target: string }
  | { type: 'grant_keyword'; keyword: string; target: string }
  | { type: 'fight'; target: string }
  | { type: 'gain_control'; duration: string; target: string }
export type BuilderSpellEffectType = BuilderSpellEffect['type']

// Spell-context effect options, derived from the registry.
export const BUILDER_SPELL_EFFECT_TYPES = effectsForContext('spell')

// `key` is a form-list value: a bare type or a variant key (e.g. 'deal_damage_target').
export function defaultSpellEffect(key: BuilderSpellEffectType | string): BuilderSpellEffect {
  return effectDefault(key) as BuilderSpellEffect
}

// ─── Activated abilities ───────────────────────────────────────────────────────
//
// Two runtime-supported shapes:
//   * mana    — a mana ability (is_mana_ability) that taps for one color. The V4
//               controller executes it via tap-for-mana, not the stack.
//   * damage  — a {tap}/{mana} cost that deals damage to a chosen target via
//               activate_ability and the stack.

// A mana ability produces a fixed colour, or 'commander' = "one mana of any colour
// in your commander's colour identity" (Command Tower, Arcane Signet). The V4
// controller resolves 'commander' to a chosen identity colour at tap time.
export type ManaProductionColor = ManaColor | 'commander' | 'any'

export const BUILDER_MANA_COLORS: { value: ManaProductionColor; label: string }[] = [
  { value: 'W', label: 'White {W}' },
  { value: 'U', label: 'Blue {U}' },
  { value: 'B', label: 'Black {B}' },
  { value: 'R', label: 'Red {R}' },
  { value: 'G', label: 'Green {G}' },
  { value: 'C', label: 'Colorless {C}' },
  { value: 'commander', label: 'Any in commander identity' },
  { value: 'any', label: 'Any colour' },
]

export const BUILDER_DAMAGE_TARGETS = [
  { value: 'any', label: 'any target' },
  { value: 'creature', label: 'target creature' },
  { value: 'player', label: 'target player' },
] as const
export type BuilderDamageTarget = (typeof BUILDER_DAMAGE_TARGETS)[number]['value']

export const BUILDER_ABILITY_KINDS = [
  { value: 'mana', label: 'Tap for mana' },
  { value: 'effect', label: 'Effect' },
] as const
export type BuilderAbilityKind = (typeof BUILDER_ABILITY_KINDS)[number]['value']

// `effect` is the generic "{cost}: <effect>" ability — the effect is any registry
// effect (deal_damage / destroy / draw / pump / …), edited via the shared effect
// editor. (Replaces the old bespoke `damage` kind; deal_damage is now just an effect.)
// A mana ability taps (and/or pays an optional mana cost) to add one or more
// fixed-colour mana. A single-colour entry is the common case (Command Tower);
// multiple colours + a `mana` cost is Dimir Signet ("{1},{T}: Add {U}{B}").
export type BuilderManaOutput = { color: ManaProductionColor; amount: number }
export type BuilderActivatedAbility =
  // payLife (0 = none) is an additional "Pay N life" cost (Talisman of Dominance:
  // "{T}, Pay 1 life: Add {U} or {B}", authored as one single-colour ability each).
  | { kind: 'mana'; tapSelf: boolean; mana: string; payLife: number; colors: BuilderManaOutput[] }
  | { kind: 'effect'; tapSelf: boolean; sacSelf: boolean; sacCreature: boolean; exileFromGraveyard: boolean; mana: string; effect: RegistryEffect }

export function defaultActivatedAbility(kind: BuilderAbilityKind): BuilderActivatedAbility {
  if (kind === 'mana') {
    return { kind: 'mana', tapSelf: true, mana: '', payLife: 0, colors: [{ color: 'C', amount: 1 }] }
  }
  return { kind: 'effect', tapSelf: true, sacSelf: false, sacCreature: false, exileFromGraveyard: false, mana: '', effect: effectDefault('deal_damage_target') }
}

// A static anthem / lord: "[Other] [<Type>] creatures [you control | everywhere]
// get +P/+T". Serializes to a `pump` continuous effect — scope 'controller' =
// "creatures you control" (affected:'controller'), scope 'all' = every creature
// regardless of controller (affected:'all', e.g. Slivers). An empty creatureType
// means all creatures; excludeSource = the "Other" wording (the source doesn't
// buff itself). Cemetery Reaper, Zombie Lord, slivers.
export const BUILDER_STATIC_SCOPES = [
  { value: 'controller', label: 'you control' },
  { value: 'all', label: '(anywhere)' },
] as const
export type BuilderStaticScope = (typeof BUILDER_STATIC_SCOPES)[number]['value']

export type BuilderStaticBuff = {
  power: number
  toughness: number
  creatureType: string
  excludeSource: boolean
  scope: BuilderStaticScope
}

export function defaultStaticBuff(): BuilderStaticBuff {
  return { power: 1, toughness: 1, creatureType: '', excludeSource: false, scope: 'controller' }
}

// A typed keyword grant: "[<Type>] creatures [you control | everywhere] have
// <keyword>" (Eternal Skylord: "Zombies you control have flying"; Vizier:
// deathtouch). Serializes to a keyword continuous effect with affected 'controller'
// (your creatures) or 'all' (everyone), and payload.creature_type when a type is
// set (empty = all creatures). The engine reads it in the card_has_<keyword>
// accessors (mig 184). Only the combat keywords with accessors are grantable.
export type BuilderKeywordGrant = {
  keyword: BuilderKeyword
  creatureType: string
  scope: BuilderStaticScope
}

export function defaultKeywordGrant(): BuilderKeywordGrant {
  return { keyword: 'flying', creatureType: '', scope: 'controller' }
}

export type BuilderForm = {
  keywords: BuilderKeyword[]
  // Static type-anthems ("Other Zombies you control get +1/+1"). Serialized
  // alongside keywords into continuous_effects.
  staticBuffs: BuilderStaticBuff[]
  // Typed keyword grants ("Zombies you control have flying"). Serialized into
  // continuous_effects as keyword effects with affected:'controller'|'all'.
  keywordGrants: BuilderKeywordGrant[]
  triggers: BuilderTrigger[]
  activatedAbilities: BuilderActivatedAbility[]
  // An ordered list of untargeted spell actions (instant/sorcery resolution),
  // e.g. Opt = [scry 1, draw 1]. Empty = no spell effect.
  spellEffect: BuilderSpellEffect[]
  // Flashback cost ("{7}{B}{B}{B}"); empty = no flashback. Pairs with spellEffect
  // (the spell you re-cast from the graveyard). Army of the Damned.
  flashback: string
  // Additional "Pay N life" flashback cost (0 = none). Deep Analysis = mana + 3 life.
  flashbackLife: number
  // An alternate spell program run instead of `spellEffect` when cast via flashback
  // (the "Increasing …" cards do more/different from the graveyard). Empty = the
  // flashback cast runs the normal spell effect.
  flashbackEffect: BuilderSpellEffect[]
}

export const EMPTY_BUILDER_FORM: BuilderForm = {
  keywords: [],
  staticBuffs: [],
  keywordGrants: [],
  triggers: [],
  activatedAbilities: [],
  spellEffect: [],
  flashback: '',
  flashbackLife: 0,
  flashbackEffect: [],
}

// ─── Defaults / factories ──────────────────────────────────────────────────────

// `key` is a form-list value: a bare type or a variant key (e.g. 'add_counters_target').
export function defaultEffect(key: BuilderEffectType | string): BuilderEffect {
  return effectDefault(key) as BuilderEffect
}

export function defaultTrigger(): BuilderTrigger {
  return { event: 'enters_the_battlefield', filter: emptyTriggerFilter(), effects: [defaultEffect('gain_life')] }
}

// ─── Form → script JSON ────────────────────────────────────────────────────────

export function buildScriptFromForm(form: BuilderForm): CardScript | null {
  const keywordEffects = form.keywords.map((keyword) => ({
    type: keyword,
    affected: 'source',
    source_zone_required: 'battlefield',
  }))

  const staticBuffEffects = form.staticBuffs.map((buff) => {
    const payload: Record<string, unknown> = { power: buff.power, toughness: buff.toughness }
    const type = buff.creatureType.trim()
    if (type !== '') {
      payload.creature_type = type
    }
    if (buff.excludeSource) {
      payload.exclude_source = true
    }
    return { type: 'pump', affected: buff.scope, payload }
  })

  const keywordGrantEffects = form.keywordGrants.map((grant) => {
    const out: Record<string, unknown> = { type: grant.keyword, affected: grant.scope }
    const type = grant.creatureType.trim()
    if (type !== '') {
      out.payload = { creature_type: type }
    }
    return out
  })

  const continuousEffects = [...keywordEffects, ...staticBuffEffects, ...keywordGrantEffects]

  const triggeredAbilities = form.triggers.map((trigger) => {
    const out: Record<string, unknown> = {
      event: trigger.event,
      effects: trigger.effects.map(effectToJson),
    }
    // The filter only applies to watcher events. Emit only the non-default parts:
    // controller 'you' is the engine default, so it's omitted (a bare watcher
    // already sees only your creatures); type/exclude are emitted when set.
    if (isWatcherEvent(trigger.event)) {
      const f = trigger.filter
      const typeLine = f.typeLine.trim()
      const filter: Record<string, unknown> = {}
      if (typeLine !== '') filter.type_line = typeLine
      if (f.controller !== 'you') filter.controller = f.controller
      if (f.excludeSelf) filter.exclude_self = true
      if (f.nontoken) filter.nontoken = true
      if (Object.keys(filter).length > 0) out.filter = filter
    }
    return out
  })

  const activatedAbilities = form.activatedAbilities.map(activatedAbilityToJson)

  // Serialize spell actions through the registry so multi-field effects
  // (e.g. search_library's count/to/filter) keep all their data, not just amount.
  const spellEffectActions = form.spellEffect.map((a) => registryEffectToJson(a))
  const flashback = form.flashback.trim()
  const flashbackLife = Math.max(0, Math.floor(form.flashbackLife))
  const flashbackEffectActions = form.flashbackEffect.map((a) => registryEffectToJson(a))
  // A flashback may carry a mana cost, a "pay N life" cost, an alternate effect, or
  // any mix. Any of them makes the card flashback-castable (the engine needs the
  // `flashback` key present), so emit `flashback` whenever there's any flashback.
  const hasFlashback = flashback !== '' || flashbackLife > 0 || flashbackEffectActions.length > 0

  // Nothing authored → no script (clears behavior).
  if (
    continuousEffects.length === 0 &&
    triggeredAbilities.length === 0 &&
    activatedAbilities.length === 0 &&
    spellEffectActions.length === 0 &&
    !hasFlashback
  ) {
    return null
  }

  const script: Record<string, unknown> = { schema_version: 2 }
  if (continuousEffects.length > 0) {
    script.continuous_effects = continuousEffects
  }
  if (triggeredAbilities.length > 0) {
    script.triggered_abilities = triggeredAbilities
  }
  if (activatedAbilities.length > 0) {
    script.activated_abilities = activatedAbilities
  }
  if (spellEffectActions.length > 0) {
    script.spell_effect = { actions: spellEffectActions }
  }
  if (hasFlashback) {
    script.flashback = flashback // may be '' for a life-only / effect-only flashback
    if (flashbackLife > 0) {
      script.flashback_life = flashbackLife
    }
    if (flashbackEffectActions.length > 0) {
      script.flashback_effect = { actions: flashbackEffectActions }
    }
  }

  return script as CardScript
}

function activatedAbilityToJson(ability: BuilderActivatedAbility): Record<string, unknown> {
  if (ability.kind === 'mana') {
    const manaCosts: Record<string, unknown>[] = []
    if (ability.tapSelf) {
      manaCosts.push({ type: 'tap_self' })
    }
    if (ability.mana.trim()) {
      manaCosts.push({ type: 'mana', amount: ability.mana.trim() })
    }
    if (ability.payLife > 0) {
      manaCosts.push({ type: 'pay_life', amount: ability.payLife })
    }
    return {
      is_mana_ability: true,
      costs: manaCosts,
      effects: ability.colors.map((c) => ({ type: 'add_mana', color: c.color, amount: c.amount })),
    }
  }

  const costs: Record<string, unknown>[] = []
  if (ability.tapSelf) {
    costs.push({ type: 'tap_self' })
  }
  if (ability.sacSelf) {
    costs.push({ type: 'sacrifice_self' })
  }
  if (ability.sacCreature) {
    costs.push({ type: 'sacrifice_creature' })
  }
  if (ability.exileFromGraveyard) {
    costs.push({ type: 'exile_from_graveyard', type_line: 'creature' })
  }
  if (ability.mana.trim()) {
    costs.push({ type: 'mana', amount: ability.mana.trim() })
  }

  return {
    costs,
    effects: [registryEffectToJson(ability.effect)],
  }
}

function effectToJson(effect: BuilderEffect): Record<string, unknown> {
  return registryEffectToJson(effect)
}

// ─── Script JSON → form (best-effort) ──────────────────────────────────────────

// Returns null when the script uses anything the form cannot represent, so the
// editor can keep the user in raw-JSON mode rather than silently dropping data.
export function parseScriptToForm(script: unknown): BuilderForm | null {
  if (script == null) {
    return EMPTY_BUILDER_FORM
  }
  if (typeof script !== 'object') {
    return null
  }

  const s = script as Record<string, unknown>
  const knownKeys = new Set([
    'schema_version',
    'continuous_effects',
    'triggered_abilities',
    'activated_abilities',
    'spell_effect',
    'flashback',
    'flashback_life',
    'flashback_effect',
  ])
  if (Object.keys(s).some((key) => !knownKeys.has(key))) {
    return null
  }

  // Flashback must be a string (a mana cost) when present; anything else → JSON mode.
  let flashback = ''
  if (s.flashback !== undefined) {
    if (typeof s.flashback !== 'string') {
      return null
    }
    flashback = s.flashback
  }

  // flashback_life is an optional positive integer ("Pay N life").
  let flashbackLife = 0
  if (s.flashback_life !== undefined) {
    if (typeof s.flashback_life !== 'number' || !Number.isInteger(s.flashback_life) || s.flashback_life <= 0) {
      return null
    }
    flashbackLife = s.flashback_life
  }

  const continuous = parseContinuousEffects(s.continuous_effects)
  if (continuous === null) {
    return null
  }
  const { keywords, staticBuffs, keywordGrants } = continuous

  const triggers = parseTriggers(s.triggered_abilities)
  if (triggers === null) {
    return null
  }

  const activatedAbilities = parseActivatedAbilities(s.activated_abilities)
  if (activatedAbilities === null) {
    return null
  }

  // A spell_effect the form can't represent (any action that isn't a plain
  // scry/surveil/draw) bails to JSON mode.
  let spellEffect: BuilderSpellEffect[] = []
  if (s.spell_effect !== undefined) {
    const parsed = parseSpellEffect(s.spell_effect)
    if (parsed === null) {
      return null
    }
    spellEffect = parsed
  }

  // The alternate flashback effect (same shape as spell_effect).
  let flashbackEffect: BuilderSpellEffect[] = []
  if (s.flashback_effect !== undefined) {
    const parsed = parseSpellEffect(s.flashback_effect)
    if (parsed === null) {
      return null
    }
    flashbackEffect = parsed
  }

  return { keywords, staticBuffs, keywordGrants, triggers, activatedAbilities, spellEffect, flashback, flashbackLife, flashbackEffect }
}

// Returns the form model for a spell_effect built from plain scry/surveil/draw
// actions, or null for anything the form cannot represent (so the editor stays in
// JSON mode — e.g. targeted destroy/exile, recipient draws, unknown fields).
function parseSpellEffect(value: unknown): BuilderSpellEffect[] | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const e = value as Record<string, unknown>
  if (Object.keys(e).some((key) => key !== 'actions')) {
    return null
  }
  if (!Array.isArray(e.actions)) {
    return null
  }

  const result: BuilderSpellEffect[] = []
  for (const entry of e.actions) {
    const parsed = effectFromJson(entry, 'spell')
    if (parsed === null) {
      return null
    }
    result.push(parsed as BuilderSpellEffect)
  }
  return result
}

function parseActivatedAbilities(value: unknown): BuilderActivatedAbility[] | null {
  if (value == null) {
    return []
  }
  if (!Array.isArray(value)) {
    return null
  }

  const abilities: BuilderActivatedAbility[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>

    // Only event-free, default-zone abilities are form-representable. id/label are
    // cosmetic and dropped; anything else (timing, source_zone_required, ...) → JSON.
    if (
      Object.keys(e).some(
        (key) => !['id', 'label', 'costs', 'effects', 'is_mana_ability'].includes(key),
      )
    ) {
      return null
    }

    const costs = Array.isArray(e.costs) ? (e.costs as Record<string, unknown>[]) : []
    const effects = Array.isArray(e.effects) ? (e.effects as Record<string, unknown>[]) : []

    // Costs must only be tap_self, sacrifice_self, exile-a-creature-from-a-graveyard,
    // and/or a mana string. The graveyard-exile cost is form-representable only for
    // the "creature" filter (Cemetery Reaper); other filters round-trip to JSON.
    let tapSelf = false
    let sacSelf = false
    let sacCreature = false
    let exileFromGraveyard = false
    let mana = ''
    let payLife = 0
    for (const cost of costs) {
      if (cost?.type === 'tap_self') {
        tapSelf = true
      } else if (cost?.type === 'sacrifice_self') {
        sacSelf = true
      } else if (cost?.type === 'sacrifice_creature') {
        sacCreature = true
      } else if (cost?.type === 'exile_from_graveyard' && (cost.type_line === undefined || cost.type_line === 'creature')) {
        exileFromGraveyard = true
      } else if (cost?.type === 'mana' && typeof cost.amount === 'string') {
        mana = cost.amount
      } else if (cost?.type === 'pay_life' && typeof cost.amount === 'number') {
        payLife = cost.amount
      } else {
        return null
      }
    }

    if (e.is_mana_ability === true) {
      // Mana abilities: tap and/or an optional mana cost and/or a "pay N life" cost
      // (Talisman); no sacrifice / graveyard exile; one or more add_mana effects,
      // each a fixed/any/commander colour.
      if (sacSelf || sacCreature || exileFromGraveyard || effects.length < 1) {
        return null
      }
      const colors: BuilderManaOutput[] = []
      for (const eff of effects) {
        if (eff?.type !== 'add_mana' || Object.keys(eff).some((k) => !['type', 'color', 'amount'].includes(k))) {
          return null
        }
        const color = eff.color
        if (typeof color !== 'string' || !['W', 'U', 'B', 'R', 'G', 'C', 'commander', 'any'].includes(color)) {
          return null
        }
        colors.push({ color: color as ManaProductionColor, amount: typeof eff.amount === 'number' ? eff.amount : 1 })
      }
      abilities.push({ kind: 'mana', tapSelf, mana, payLife, colors })
    } else {
      // Generic "{cost}: <effect>" — exactly one effect, a registry effect the form
      // can represent (parsed in spell context). pay_life is only modelled on mana
      // abilities, so an effect ability carrying it stays in JSON (no data loss).
      if (effects.length !== 1 || payLife > 0) {
        return null
      }
      const parsed = effectFromJson(effects[0], 'spell')
      if (parsed === null) {
        return null
      }
      abilities.push({ kind: 'effect', tapSelf, sacSelf, sacCreature, exileFromGraveyard, mana, effect: parsed })
    }
  }
  return abilities
}

// Partitions continuous_effects into the two form-representable shapes — plain
// source keywords and static controller anthems (pump lords). Any other shape
// (auras, opponent debuffs, non-canonical payloads) → null, so the editor stays
// in JSON mode rather than silently dropping data.
function parseContinuousEffects(
  value: unknown,
): { keywords: BuilderKeyword[]; staticBuffs: BuilderStaticBuff[]; keywordGrants: BuilderKeywordGrant[] } | null {
  if (value == null) {
    return { keywords: [], staticBuffs: [], keywordGrants: [] }
  }
  if (!Array.isArray(value)) {
    return null
  }

  const keywords: BuilderKeyword[] = []
  const staticBuffs: BuilderStaticBuff[] = []
  const keywordGrants: BuilderKeywordGrant[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>
    const type = (e.type ?? e.effect_type) as string | undefined
    if (!type) {
      return null
    }

    // A keyword effect. affected 'source'/absent → the source has the keyword;
    // affected 'controller'/'all' → a TYPED grant to other creatures (Skylord).
    if ((BUILDER_KEYWORDS as readonly string[]).includes(type)) {
      if (e.affected === 'controller' || e.affected === 'all') {
        const grant = parseKeywordGrant(e, type as BuilderKeyword)
        if (grant === null) {
          return null
        }
        keywordGrants.push(grant)
        continue
      }
      if (
        (e.affected !== undefined && e.affected !== 'source') ||
        (e.source_zone_required !== undefined && e.source_zone_required !== 'battlefield') ||
        Object.keys(e).some((key) => !['type', 'effect_type', 'affected', 'source_zone_required'].includes(key))
      ) {
        return null
      }
      keywords.push(type as BuilderKeyword)
      continue
    }

    // Static anthem: a controller-scoped pump with a canonical payload.
    if (type === 'pump') {
      const buff = parseStaticBuff(e)
      if (buff === null) {
        return null
      }
      staticBuffs.push(buff)
      continue
    }

    return null
  }
  return { keywords, staticBuffs, keywordGrants }
}

// A form-representable typed keyword grant is `{ type:<keyword>, affected:
// 'controller'|'all', [payload:{ creature_type }] }` — exactly what
// buildScriptFromForm emits. Extra keys, a non-string creature_type, or an empty
// creature_type string (should be omitted, not '') round-trip to JSON mode.
function parseKeywordGrant(e: Record<string, unknown>, keyword: BuilderKeyword): BuilderKeywordGrant | null {
  if (
    (e.affected !== 'controller' && e.affected !== 'all') ||
    Object.keys(e).some((key) => !['type', 'effect_type', 'affected', 'payload'].includes(key))
  ) {
    return null
  }
  let creatureType = ''
  if (e.payload !== undefined) {
    if (typeof e.payload !== 'object' || e.payload === null) {
      return null
    }
    const p = e.payload as Record<string, unknown>
    if (Object.keys(p).some((key) => key !== 'creature_type')) {
      return null
    }
    if (p.creature_type !== undefined) {
      if (typeof p.creature_type !== 'string' || p.creature_type.trim() === '') {
        return null
      }
      creatureType = p.creature_type
    }
  }
  return { keyword, creatureType, scope: e.affected as BuilderStaticScope }
}

// A form-representable anthem is `{ type:'pump', affected:'controller'|'all',
// payload:{ power, toughness, [creature_type], [exclude_source:true] } }` —
// exactly what buildScriptFromForm emits. Non-canonical payloads (empty
// creature_type, exclude_source:false, extra keys) round-trip to JSON mode.
function parseStaticBuff(e: Record<string, unknown>): BuilderStaticBuff | null {
  if (
    (e.affected !== 'controller' && e.affected !== 'all') ||
    (e.source_zone_required !== undefined && e.source_zone_required !== 'battlefield') ||
    Object.keys(e).some((key) => !['type', 'effect_type', 'affected', 'source_zone_required', 'payload'].includes(key))
  ) {
    return null
  }
  const payload = e.payload
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const p = payload as Record<string, unknown>
  if (
    typeof p.power !== 'number' ||
    typeof p.toughness !== 'number' ||
    Object.keys(p).some((key) => !['power', 'toughness', 'creature_type', 'exclude_source'].includes(key))
  ) {
    return null
  }
  let creatureType = ''
  if (p.creature_type !== undefined) {
    if (typeof p.creature_type !== 'string' || p.creature_type.trim() === '') {
      return null
    }
    creatureType = p.creature_type
  }
  if (p.exclude_source !== undefined && p.exclude_source !== true) {
    return null
  }
  return {
    power: p.power,
    toughness: p.toughness,
    creatureType,
    excludeSource: p.exclude_source === true,
    scope: e.affected as BuilderStaticScope,
  }
}

function parseTriggers(value: unknown): BuilderTrigger[] | null {
  if (value == null) {
    return []
  }
  if (!Array.isArray(value)) {
    return null
  }

  const triggers: BuilderTrigger[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>
    const event = e.event as string | undefined
    if (!event || !(BUILDER_TRIGGER_EVENTS.map((t) => t.value) as string[]).includes(event)) {
      return null
    }
    // Reject anything beyond event + effects + filter (e.g. targets, conditions).
    if (Object.keys(e).some((key) => key !== 'event' && key !== 'effects' && key !== 'id' && key !== 'filter')) {
      return null
    }

    const filter = parseTriggerFilter(e.filter)
    if (filter === null) {
      return null
    }

    const effects = parseEffects(e.effects)
    if (effects === null) {
      return null
    }

    triggers.push({ event: event as BuilderTriggerEvent, filter, effects })
  }
  return triggers
}

// A watcher filter `{ type_line?, controller?, exclude_self? }` → the form model
// (absent controller = 'you', the engine default). Any other key / wrong type →
// null, so the script stays in JSON mode.
function parseTriggerFilter(value: unknown): BuilderTriggerFilter | null {
  if (value === undefined) {
    return emptyTriggerFilter()
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const f = value as Record<string, unknown>
  if (Object.keys(f).some((key) => !['type_line', 'controller', 'exclude_self', 'nontoken'].includes(key))) {
    return null
  }
  if (f.type_line !== undefined && typeof f.type_line !== 'string') {
    return null
  }
  if (f.controller !== undefined && !['you', 'opponent', 'any'].includes(f.controller as string)) {
    return null
  }
  if (f.exclude_self !== undefined && typeof f.exclude_self !== 'boolean') {
    return null
  }
  if (f.nontoken !== undefined && typeof f.nontoken !== 'boolean') {
    return null
  }
  return {
    typeLine: typeof f.type_line === 'string' ? f.type_line : '',
    controller: (f.controller as BuilderTriggerController) ?? 'you',
    excludeSelf: f.exclude_self === true,
    nontoken: f.nontoken === true,
  }
}

function parseEffects(value: unknown): BuilderEffect[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const effects: BuilderEffect[] = []
  for (const entry of value) {
    const parsed = effectFromJson(entry, 'trigger')
    if (parsed === null) {
      return null
    }
    effects.push(parsed as BuilderEffect)
  }
  return effects
}

export const KEYWORD_LABELS: Record<BuilderKeyword, string> = {
  flying: 'Flying',
  reach: 'Reach',
  haste: 'Haste',
  vigilance: 'Vigilance',
  trample: 'Trample',
  indestructible: 'Indestructible',
  first_strike: 'First strike',
  double_strike: 'Double strike',
  deathtouch: 'Deathtouch',
}
