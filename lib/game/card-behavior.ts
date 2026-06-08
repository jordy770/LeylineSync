import type { CardAction, CardContinuousEffect, CardScript, GameZone, ManaColor } from './types'
import { validateCardScript } from './card-behavior-schema'

export type CardBehaviorSchemaVersion = 1 | 2

export type CardBehaviorStatus = 'unsupported' | 'generated' | 'verified' | 'broken' | 'manual'

export type CardBehaviorZone = GameZone | 'command' | 'any'

export type CardBehaviorTargetType =
  | 'any'
  | 'artifact'
  | 'battle'
  | 'creature'
  | 'enchantment'
  | 'opponent'
  | 'permanent'
  | 'planeswalker'
  | 'player'
  | 'spell'

export type CardBehaviorCost =
  | { type: 'tap_self' }
  | { type: 'untap_self' }
  | { type: 'mana'; amount: string }
  | { type: 'pay_life'; amount: number }
  | { type: 'sacrifice_self' }
  | { type: 'discard'; amount: number }
  | { type: 'exile_self'; from_zone?: CardBehaviorZone }
  | { type: string; [key: string]: unknown }

export type CardBehaviorAction =
  | {
      type: 'add_mana'
      // 'commander' = one mana of any colour in your commander's colour identity;
      // 'any' = one mana of any colour (Chromatic Lantern / rainbow lands).
      color: ManaColor | 'commander' | 'any'
      amount: number
    }
  | {
      type: 'deal_damage'
      amount: number
      target_ref?: string
      target_type?: CardBehaviorTargetType | CardBehaviorTargetType[]
    }
  | {
      type: 'counter'
      target_ref?: string
      target_type?: 'spell'
    }
  | {
      type: string
      [key: string]: unknown
    }

export type CardBehaviorTarget = {
  id: string
  type: CardBehaviorTargetType | CardBehaviorTargetType[]
  controller?: 'any' | 'controller' | 'opponent'
  required_zone?: CardBehaviorZone
  optional?: boolean
}

export type CardBehaviorSpellEffect = {
  targets?: CardBehaviorTarget[]
  actions: CardBehaviorAction[]
}

export type CardBehaviorActivatedAbility = {
  id?: string
  label?: string
  costs: CardBehaviorCost[]
  effects: CardBehaviorAction[]
  is_mana_ability?: boolean
  timing?: 'instant' | 'sorcery' | string
  source_zone_required?: CardBehaviorZone
}

export type CardBehaviorTriggeredAbility = {
  id?: string
  event: string
  source_zone_required?: CardBehaviorZone
  condition?: Record<string, unknown>
  targets?: CardBehaviorTarget[]
  effects: CardBehaviorAction[]
}

export type CardBehaviorLoyaltyAbility = {
  cost: number
  label?: string
  effects: CardBehaviorAction[]
}

export type CardBehaviorScriptV2 = {
  schema_version: 2
  keywords?: string[]
  spell_effect?: CardBehaviorSpellEffect
  activated_abilities?: CardBehaviorActivatedAbility[]
  triggered_abilities?: CardBehaviorTriggeredAbility[]
  continuous_effects?: CardContinuousEffect[]
  // Planeswalker starting loyalty + loyalty abilities (preserved for the UI).
  loyalty?: number
  loyalty_abilities?: CardBehaviorLoyaltyAbility[]
}

export type AnyCardBehaviorScript = CardScript | CardBehaviorScriptV2

export function getCardBehaviorVersion(script: AnyCardBehaviorScript | null | undefined): CardBehaviorSchemaVersion {
  if (!script) {
    return 1
  }

  if ('schema_version' in script && script.schema_version === 2) {
    return 2
  }

  if (
    'spell_effect' in script ||
    'activated_abilities' in script ||
    'triggered_abilities' in script
  ) {
    return 2
  }

  return 1
}

// Ability keywords the engine already handles from the catalog `keywords` array, so
// a card whose only rules text is these needs no script (it's "vanilla").
const HANDLED_KEYWORDS = new Set([
  'flying', 'reach', 'trample', 'vigilance', 'haste', 'first strike', 'double strike',
  'deathtouch', 'indestructible', 'menace', 'defender', 'lifelink', 'hexproof', 'flash',
])

// Whether a script actually defines engine behavior (vs. an empty/absent script).
function scriptHasBehavior(script: AnyCardBehaviorScript | null | undefined): boolean {
  if (!script || typeof script !== 'object') return false
  const s = script as Record<string, unknown>
  const nonEmptyArray = (key: string) => Array.isArray(s[key]) && (s[key] as unknown[]).length > 0
  return (
    nonEmptyArray('actions') ||
    nonEmptyArray('continuous_effects') ||
    nonEmptyArray('triggered_abilities') ||
    nonEmptyArray('activated_abilities') ||
    s['spell_effect'] != null
  )
}

export type CardConfigStatus = 'scripted' | 'vanilla' | 'needs'

/**
 * Classify a catalog card's rules readiness for the deck editor:
 *  - 'scripted' — has a behavior script.
 *  - 'vanilla'  — no ability text (or only engine-handled keywords / a basic land):
 *                 plays fine as-is, nothing to configure.
 *  - 'needs'    — has ability text but no script (likely won't work until scripted).
 * The vanilla/needs split is a heuristic on oracle_text and is approximate.
 */
export function getCardConfigStatus(card: {
  script?: AnyCardBehaviorScript | null
  oracle_text?: string | null
  type_line?: string | null
}): CardConfigStatus {
  if (scriptHasBehavior(card.script)) return 'scripted'

  const typeLine = (card.type_line ?? '').toLowerCase()
  if (typeLine.includes('basic') && typeLine.includes('land')) return 'vanilla'

  // Strip parenthetical reminder text, then split into clauses and drop the
  // engine-handled keywords; anything left is unscripted ability text.
  const text = (card.oracle_text ?? '').replace(/\([^)]*\)/g, '').trim()
  if (!text) return 'vanilla'

  const residual = text
    .toLowerCase()
    .split(/[\n,;.]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !HANDLED_KEYWORDS.has(part) && !part.startsWith('protection from'))

  return residual.length === 0 ? 'vanilla' : 'needs'
}

export function normalizeCardBehaviorToV2(
  script: AnyCardBehaviorScript | null | undefined,
  typeLine?: string | null,
): CardBehaviorScriptV2 {
  if (!script) {
    return emptyCardBehaviorV2()
  }

  if (process.env.NODE_ENV === 'development') {
    const validation = validateCardScript(script)
    if (!validation.success) {
      console.warn('[card-behavior] Invalid card script (v%d):\n%s', validation.version, validation.errors.map(e => `  • ${e}`).join('\n'), script)
    }
  }

  if (getCardBehaviorVersion(script) === 2) {
    return normalizeV2Script(script as Partial<CardBehaviorScriptV2>)
  }

  return migrateV1ScriptToV2(script as CardScript, typeLine)
}

export function selectManaAbilities(
  script: AnyCardBehaviorScript | null | undefined,
  typeLine?: string | null,
) {
  return normalizeCardBehaviorToV2(script, typeLine).activated_abilities?.filter(
    (ability) => ability.is_mana_ability,
  ) ?? []
}

export function selectFirstManaAbility(
  script: AnyCardBehaviorScript | null | undefined,
  typeLine?: string | null,
  preferredColor?: ManaColor,
) {
  const abilities = selectManaAbilities(script, typeLine)

  if (!preferredColor) {
    return abilities[0] ?? null
  }

  return (
    abilities.find((ability) =>
      ability.effects.some((effect) => effect.type === 'add_mana' && effect.color === preferredColor),
    ) ??
    abilities[0] ??
    null
  )
}

export function selectContinuousEffects(script: AnyCardBehaviorScript | null | undefined) {
  return normalizeCardBehaviorToV2(script).continuous_effects ?? []
}

export function isAddManaBehaviorAction(
  action: CardBehaviorAction,
): action is Extract<CardBehaviorAction, { type: 'add_mana' }> {
  return (
    action.type === 'add_mana' &&
    'color' in action &&
    typeof action.color === 'string' &&
    ['W', 'U', 'B', 'R', 'G', 'C', 'commander', 'any'].includes(action.color) &&
    'amount' in action &&
    typeof action.amount === 'number'
  )
}

function migrateV1ScriptToV2(script: CardScript, typeLine?: string | null): CardBehaviorScriptV2 {
  const actions = script.actions ?? []
  const triggers = script.triggers ?? []
  const manualTapActions = triggers.includes('manual_tap')
    ? actions.filter(isValidManaAction)
    : []
  const manualTapActionSet = new Set<CardAction>(manualTapActions)
  const spellActions = actions.filter((action) => !manualTapActionSet.has(action))
  const spellEffect = getV1SpellEffect(spellActions, triggers, typeLine)

  return {
    schema_version: 2,
    spell_effect: spellEffect,
    activated_abilities: manualTapActions.map((action) => ({
      costs: [{ type: 'tap_self' }],
      effects: [normalizeAction(action)],
      is_mana_ability: true,
      source_zone_required: 'battlefield',
    })),
    triggered_abilities: getV1TriggeredAbilities(spellActions, triggers, spellEffect),
    continuous_effects: script.continuous_effects ?? [],
  }
}

function getV1SpellEffect(
  actions: CardAction[],
  triggers: string[],
  typeLine?: string | null,
): CardBehaviorSpellEffect | undefined {
  const isSpellType = isInstantOrSorcery(typeLine)
  const shouldTreatCastAsSpellEffect = triggers.includes('cast') && actions.length > 0

  if (!isSpellType && !shouldTreatCastAsSpellEffect) {
    return undefined
  }

  return {
    targets: inferTargets(actions),
    actions: actions.map(normalizeAction),
  }
}

function getV1TriggeredAbilities(
  actions: CardAction[],
  triggers: string[],
  spellEffect: CardBehaviorSpellEffect | undefined,
) {
  if (spellEffect) {
    return []
  }

  return triggers
    .filter((trigger) => trigger !== 'manual_tap')
    .map<CardBehaviorTriggeredAbility>((trigger) => ({
      event: trigger,
      effects: actions.map(normalizeAction),
    }))
}

function inferTargets(actions: CardAction[]): CardBehaviorTarget[] | undefined {
  const targetTypes = actions
    .map((action) => action.target_type ?? action.target)
    .filter((targetType): targetType is string => Boolean(targetType))

  if (targetTypes.length === 0) {
    return undefined
  }

  const firstTargetType = targetTypes[0]

  return [
    {
      id: 't1',
      type: normalizeTargetType(firstTargetType),
    },
  ]
}

function normalizeAction(action: CardAction): CardBehaviorAction {
  if (isValidManaAction(action)) {
    return {
      type: 'add_mana',
      color: action.color.toUpperCase() as ManaColor,
      amount: action.amount,
    }
  }

  return { ...action } as CardBehaviorAction
}

function normalizeTargetType(targetType: string): CardBehaviorTargetType | CardBehaviorTargetType[] {
  if (targetType === 'any') {
    return ['creature', 'player', 'planeswalker', 'battle']
  }

  return targetType as CardBehaviorTargetType
}

function normalizeV2Script(script: Partial<CardBehaviorScriptV2>): CardBehaviorScriptV2 {
  return {
    schema_version: 2,
    keywords: script.keywords ?? [],
    spell_effect: script.spell_effect,
    activated_abilities: script.activated_abilities ?? [],
    triggered_abilities: script.triggered_abilities ?? [],
    continuous_effects: script.continuous_effects ?? [],
    loyalty: script.loyalty,
    loyalty_abilities: script.loyalty_abilities ?? [],
  }
}

function emptyCardBehaviorV2(): CardBehaviorScriptV2 {
  return {
    schema_version: 2,
    keywords: [],
    activated_abilities: [],
    triggered_abilities: [],
    continuous_effects: [],
  }
}

function isValidManaAction(action: CardAction): action is CardAction & { color: string; amount: number } {
  return (
    action.type === 'add_mana' &&
    typeof action.color === 'string' &&
    ['W', 'U', 'B', 'R', 'G', 'C'].includes(action.color.toUpperCase()) &&
    typeof action.amount === 'number'
  )
}

function isInstantOrSorcery(typeLine?: string | null) {
  const normalizedTypeLine = typeLine?.toLowerCase() ?? ''
  return normalizedTypeLine.includes('instant') || normalizedTypeLine.includes('sorcery')
}
