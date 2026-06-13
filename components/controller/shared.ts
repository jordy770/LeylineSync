import type { ModalMode, MultiCreatureKind, TargetController, TargetedCreatureActionType } from '@/lib/game/actions'
import type { CardBehaviorAction, CardBehaviorCost } from '@/lib/game/card-behavior'
import {
  isAddManaBehaviorAction,
  normalizeCardBehaviorToV2,
} from '@/lib/game/card-behavior'
import { doesCardRequireStackTarget, getCanQuickCast, getPowerToughnessLabel } from '@/lib/game/controller-selectors'
import { parseManaCost } from '@/lib/game/mana'
import type { BoardCard, ControllerCard, ManaColor } from '@/lib/game/types'

export const manaColors: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']

export const manaColorStyles: Record<ManaColor, { dot: string; text: string; bg: string }> = {
  W: { dot: 'bg-[#F5EDD0]', text: 'text-[#F5EDD0]', bg: 'bg-[#F5EDD0]' },
  U: { dot: 'bg-[#4A9FD8]', text: 'text-[#4A9FD8]', bg: 'bg-[#4A9FD8]' },
  B: { dot: 'bg-[#9A7AC8]', text: 'text-[#9A7AC8]', bg: 'bg-[#9A7AC8]' },
  R: { dot: 'bg-[#E85030]', text: 'text-[#E85030]', bg: 'bg-[#E85030]' },
  G: { dot: 'bg-[#3AA850]', text: 'text-[#3AA850]', bg: 'bg-[#3AA850]' },
  C: { dot: 'bg-[#8A8A8A]', text: 'text-[#8A8A8A]', bg: 'bg-[#8A8A8A]' },
}

export function renderAbilityCost(costs: CardBehaviorCost[]): string {
  return costs.map((c) => {
    const cost = c as { type: string; amount?: string | number }
    switch (cost.type) {
      case 'tap_self': return '{T}'
      case 'untap_self': return '{Q}'
      case 'mana': return `{${cost.amount ?? '?'}}`
      case 'pay_life': return `Pay ${cost.amount ?? '?'} life`
      case 'sacrifice_self': return 'Sacrifice'
      case 'discard': return `Discard ${cost.amount ?? '?'}`
      case 'exile_self': return 'Exile'
      case 'exile_from_graveyard': return 'Exile a creature from a graveyard'
      default: return cost.type
    }
  }).join(' ')
}

export function renderAbilityEffect(effects: CardBehaviorAction[]): string {
  return effects.map((e) => {
    if (isAddManaBehaviorAction(e)) return e.color === 'commander' ? 'Add any commander colour' : e.color === 'any' ? 'Add any colour' : `Add {${e.color}}`
    const asAny = e as Record<string, unknown>
    if (e.type === 'deal_damage') return `Deal ${String(asAny.amount ?? '?')} damage`
    if (e.type === 'counter') return 'Counter target spell'
    return String(e.type).replace(/_/g, ' ')
  }).join(', ')
}

// Combat/ability keywords surfaced as badges on cards.
export const KEYWORD_LABELS: Record<string, string> = {
  flying: 'Flying',
  reach: 'Reach',
  haste: 'Haste',
  vigilance: 'Vigilance',
  trample: 'Trample',
  indestructible: 'Indestructible',
  first_strike: 'First Strike',
  double_strike: 'Double Strike',
  deathtouch: 'Deathtouch',
}

// The colours a mana cost contains (mirrors the server's card_color_set): full
// colour words so they line up with a protection effect's `from`.
export function manaCostColors(manaCost?: string | null): string[] {
  const mc = (manaCost ?? '').toUpperCase()
  const out: string[] = []
  if (mc.includes('W')) out.push('white')
  if (mc.includes('U')) out.push('blue')
  if (mc.includes('B')) out.push('black')
  if (mc.includes('R')) out.push('red')
  if (mc.includes('G')) out.push('green')
  return out
}

export const cardIsAura = (typeLine?: string | null) => (typeLine ?? '').toLowerCase().includes('aura')
export const cardIsEquipment = (typeLine?: string | null) => (typeLine ?? '').toLowerCase().includes('equipment')

// Whether a board creature has protection from any of the given source colours
// (matches the server's can't-be-targeted/damaged/blocked gate, so the picker can
// drop creatures the server would reject).
export function creatureProtectedFrom(card: BoardCard, sourceColors: string[]): boolean {
  const prot = card.protection_colors ?? []
  return sourceColors.some((c) => prot.includes(c))
}

/** Collects displayable keywords for a card from Scryfall keywords + scripted continuous effects. */
export function getCardKeywords(card: ControllerCard): string[] {
  const found = new Set<string>()

  for (const kw of card.cards?.keywords ?? []) {
    const norm = kw.toLowerCase().replace(/[\s-]+/g, '_')
    if (KEYWORD_LABELS[norm]) found.add(norm)
  }

  const script = normalizeCardBehaviorToV2(
    card.copied_script ?? card.cards?.script ?? null,
    card.cards?.type_line,
  )
  for (const effect of script.continuous_effects ?? []) {
    const type = (effect as { effect_type?: string; type?: string }).effect_type ?? (effect as { type?: string }).type
    if (type && KEYWORD_LABELS[type]) found.add(type)
  }

  return [...found]
}

/** Effective P/T label for a board card (printed + counters + active pumps). Empty string if no P/T. */
export function effectiveBoardPT(card: BoardCard): string {
  const base = card.power_toughness
  if (!base) return ''
  const bonusP = (card.plus_one_counters ?? 0) + (card.pump_power ?? 0)
  const bonusT = (card.plus_one_counters ?? 0) + (card.pump_toughness ?? 0)
  const match = base.match(/^(\d+)\s*\/\s*(\d+)$/)
  if ((bonusP === 0 && bonusT === 0) || !match) return base
  return `${Number(match[1]) + bonusP}/${Number(match[2]) + bonusT}`
}

/** Printed P/T with +1/+1 counters and active pumps folded in. */
export function getEffectivePT(card: ControllerCard): string | null {
  const base = getPowerToughnessLabel(card)
  if (!base) return null
  const bonusP = (card.plus_one_counters ?? 0) + (card.pump_power ?? 0)
  const bonusT = (card.plus_one_counters ?? 0) + (card.pump_toughness ?? 0)
  const match = base.match(/^(\d+)\s*\/\s*(\d+)$/)
  if ((bonusP === 0 && bonusT === 0) || !match) return base
  return `${Number(match[1]) + bonusP}/${Number(match[2]) + bonusT}`
}

export type SpellPlan =
  // xRequired: the effect amount is "X" — prompt the caster for a number at cast,
  // pay it as {X} mana, and pass it as x_value (the server resolves the amount).
  | { kind: 'damage'; amount: number; timing: 'instant' | 'sorcery'; canTargetPlayer: boolean; canTargetCreature: boolean; targetController: TargetController; xRequired?: boolean }
  // Divided damage: allocate `amount` across multiple creature/player targets.
  | { kind: 'divided_damage'; amount: number; timing: 'instant' | 'sorcery'; canTargetPlayer: boolean; canTargetCreature: boolean; targetController: TargetController }
  | { kind: 'pump'; power: number; toughness: number; timing: 'instant' | 'sorcery'; targetController: TargetController }
  | { kind: 'set_pt'; power: number; toughness: number; timing: 'instant' | 'sorcery'; targetController: TargetController }
  | { kind: 'add_counters'; amount: number; timing: 'instant' | 'sorcery'; targetController: TargetController; xRequired?: boolean; counterType?: string; all?: boolean }
  | { kind: 'creature_effect'; effect: TargetedCreatureActionType; label: string; keyword?: string; duration?: string; untap?: boolean; haste?: boolean; timing: 'instant' | 'sorcery'; targetController: TargetController }
  // Multi-target removal: pick up to `count` creatures, apply `effectKind` to each.
  | { kind: 'multi_creature'; effectKind: MultiCreatureKind; label: string; count: number; timing: 'instant' | 'sorcery'; targetController: TargetController }
  // Non-creature permanent removal: destroy/exile/… a target of `targetType`.
  | { kind: 'permanent_effect'; effectKind: MultiCreatureKind; label: string; targetType: string | string[]; timing: 'instant' | 'sorcery'; targetController: TargetController; then?: unknown[]; controllerSearchesBasicLand?: boolean }
  | { kind: 'fight'; timing: 'instant' | 'sorcery'; foughtController: TargetController }
  | { kind: 'draw'; amount: number; timing: 'instant' | 'sorcery'; xRequired?: boolean }
  | { kind: 'spell_effect'; actions: unknown[]; timing: 'instant' | 'sorcery'; xRequired?: boolean }
  // Modal "choose one —": cast the modes; the choose_mode decision UI picks them.
  | { kind: 'modal'; modes: ModalMode[]; choose: number; timing: 'instant' | 'sorcery' }
  | { kind: 'counterspell' }
  | { kind: 'normal' }

// Normalises an effect's target_controller to the engine's three values.
export function readTargetController(action: { target_controller?: unknown } | undefined): TargetController {
  const raw = typeof action?.target_controller === 'string' ? action.target_controller.toLowerCase() : ''
  if (raw === 'opponent') return 'opponent'
  if (raw === 'you' || raw === 'self' || raw === 'controller') return 'you'
  return 'any'
}

// Does a board creature satisfy the spell/trigger's controller restriction,
// from the perspective of the player who controls the effect?
export function creatureMatchesController(
  card: BoardCard,
  controllerId: string | null,
  targetController: TargetController | string | null | undefined,
): boolean {
  const tc = typeof targetController === 'string' ? targetController.toLowerCase() : 'any'
  if (tc === 'opponent') return card.controller_player_id !== controllerId
  if (tc === 'you' || tc === 'self' || tc === 'controller') return card.controller_player_id === controllerId
  return true
}

// Untargeted spell actions that resolve as a server-side effect program (no
// target picker). A spell mixing only these can run as one multi-action cast.
// A counter bag ({poison:3,charge:1}) → sorted [{kind,n}] for display, skipping zeros.
// `minus_one_one` is the internal key for −1/−1 counters; show the readable label.
export const COUNTER_LABELS: Record<string, string> = { minus_one_one: '−1/−1', loyalty: '◆' }
// Internal bag keys that are bookkeeping, not displayable counters.
export const HIDDEN_COUNTER_KEYS = new Set(['loyalty_turn'])
export function formatCounterBag(bag: Record<string, number> | null | undefined): { kind: string; n: number }[] {
  if (!bag) return []
  return Object.entries(bag)
    .filter(([key, n]) => n > 0 && !HIDDEN_COUNTER_KEYS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => ({ kind: COUNTER_LABELS[kind] ?? kind, n }))
}

// Keep in sync with the engine's spell-program vocabulary (apply_trigger_effects
// + apply_triggered_ability_effects). FOURTH drifting copy found (after
// bug-688/693/705-era finds): Lazotep Plating's amass + grant_keyword_all were
// missing here, so its cast button never enabled — likewise Whipflare,
// Culling Ritual, Open the Vaults, Selvala's Stampede and friends.
export const UNTARGETED_SPELL_ACTION_TYPES = [
  'scry', 'surveil', 'draw', 'gain_life', 'lose_life', 'mill', 'create_token', 'add_counters_all', 'tap_all', 'untap_all',
  'search_library', 'discard', 'may', 'choose_player', 'sacrifice', 'return_from_graveyard', 'proliferate',
  'amass', 'grant_keyword_all', 'deal_damage_all', 'destroy_all', 'destroy_all_mv', 'destroy_all_creatures_token',
  'return_all_from_graveyard', 'bounce_all', 'exile_all', 'pump_all', 'prevent_damage', 'add_poison', 'add_player_counters',
  'look_top', 'impulse', 'put_from_hand', 'destroy_up_to', 'bounce_up_to', 'vote_wild_free',
  'graveyard_to_library_top', 'exile_from_any_graveyard', 'mass_destroy_reanimate_one',
  'damage_each_opponent_by_hand', 'gain_control_all', 'exile_tops_cast', 'conditional', 'choose_creature_type', 'choose_color',
]
// Effects that open a resolution-time choice — a spell containing one must run as a
// program (single dedicated cast kinds can't surface the prompt).
export const DECISION_SPELL_ACTION_TYPES = [
  'scry', 'surveil', 'search_library', 'discard', 'may', 'choose_player', 'sacrifice', 'return_from_graveyard', 'proliferate',
  'look_top', 'put_from_hand', 'destroy_up_to', 'bounce_up_to', 'vote_wild_free', 'graveyard_to_library_top',
  'exile_from_any_graveyard', 'mass_destroy_reanimate_one', 'exile_tops_cast', 'choose_creature_type', 'choose_color',
]

// Maps a spell_effect action type to a targeted-creature stack action + a picker label.
export const CREATURE_EFFECT_MAP: Record<string, { effect: TargetedCreatureActionType; label: string }> = {
  destroy: { effect: 'destroy_creature', label: 'Destroy' },
  exile: { effect: 'exile_creature', label: 'Exile' },
  bounce: { effect: 'bounce_creature', label: 'Return to hand' },
  tap: { effect: 'tap_creature', label: 'Tap' },
  untap: { effect: 'untap_creature', label: 'Untap' },
}

export function targetTypeMatches(tt: unknown, want: string): boolean {
  if (!tt) return false
  if (tt === want || tt === 'any') return true
  return Array.isArray(tt) && (tt.includes(want) || tt.includes('any'))
}

// True when a removal effect's target_type is creature-only (the default). A
// non-creature permanent type (artifact/enchantment/land/planeswalker/permanent)
// routes to the permanent_effect cast path instead of the creature picker.
export function isCreatureOnlyTargetType(tt: unknown): boolean {
  if (tt == null) return true
  if (typeof tt === 'string') return tt.toLowerCase() === 'creature'
  if (Array.isArray(tt)) return tt.length > 0 && tt.every((t) => String(t).toLowerCase() === 'creature')
  return false
}

// Whether a board card's type line satisfies an effect's target_type filter
// ('permanent'/'any' match anything on the battlefield). Mirrors the engine's
// card_type_line_matches_target.
export function cardMatchesTargetType(typeLine: string | null | undefined, tt: string | string[]): boolean {
  const tl = (typeLine ?? '').toLowerCase()
  const types = Array.isArray(tt) ? tt : [tt]
  return types.some((t) => {
    const lt = String(t).toLowerCase()
    if (lt === 'any' || lt === 'permanent') return true
    if (lt === 'nonland_permanent' || lt === 'nonland') return !tl.includes('land')
    return tl.includes(lt)
  })
}

// Activated-ability effects the client can invoke (the engine's activate_ability
// vocabulary). Untargeted kinds resolve server-side (parks land in the now-
// complete decision renderer); the rest target a creature (deal_damage also a
// player). Returns null for anything else → the ability renders "Soon".
// Keep in sync with activate_ability.sql's dispatch — Wayfarer's Bauble sat
// disabled for months because search_library was missing here (third copy of
// an engine vocabulary drifting, after bug-688/693).
const UNTARGETED_ABILITY_TYPES = [
  'draw', 'create_token', 'search_library', 'return_from_graveyard',
  'return_all_from_graveyard', 'deal_damage_all', 'grant_keyword_all',
  'monstrosity', 'gain_life', 'proliferate', 'destroy_all', 'choose_one',
  'play_hideaway', 'exile_graveyard', 'sacrifice',
]
export const ABILITY_EFFECT_TYPES = [
  'deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap', 'add_counters', 'pump', 'grant_keyword', 'gain_control',
  ...UNTARGETED_ABILITY_TYPES,
]
export function getAbilityEffect(
  effects: CardBehaviorAction[],
): { type: string; amount: number; canTargetPlayer: boolean; canTargetCreature: boolean; needsTarget: boolean } | null {
  const e = effects.find((x) => ABILITY_EFFECT_TYPES.includes(x.type ?? '')) as
    | (CardBehaviorAction & { amount?: number; target_type?: unknown })
    | undefined
  if (!e || !e.type) return null
  if (e.type === 'draw') {
    return { type: 'draw', amount: typeof e.amount === 'number' ? e.amount : 1, canTargetPlayer: false, canTargetCreature: false, needsTarget: false }
  }
  if (UNTARGETED_ABILITY_TYPES.includes(e.type)) {
    return { type: e.type, amount: typeof e.amount === 'number' ? e.amount : 0, canTargetPlayer: false, canTargetCreature: false, needsTarget: false }
  }
  if (e.type === 'create_token') {
    // Untargeted effect; any target the ability needs comes from its COST (e.g.
    // Cemetery Reaper's "exile a creature card from a graveyard").
    return { type: 'create_token', amount: 0, canTargetPlayer: false, canTargetCreature: false, needsTarget: false }
  }
  if (e.type === 'deal_damage') {
    if (typeof e.amount !== 'number') return null
    const tt = e.target_type
    return { type: 'deal_damage', amount: e.amount, canTargetPlayer: !tt || targetTypeMatches(tt, 'player'), canTargetCreature: targetTypeMatches(tt, 'creature'), needsTarget: true }
  }
  // The creature-target effects: destroy/exile/bounce/tap/untap/add_counters/pump/grant_keyword/gain_control.
  return { type: e.type, amount: typeof e.amount === 'number' ? e.amount : 0, canTargetPlayer: false, canTargetCreature: true, needsTarget: true }
}

// Verb shown in the activated-ability target picker prompt.
export const ABILITY_VERB: Record<string, string> = {
  destroy: 'Destroy', exile: 'Exile', bounce: 'Return to hand', tap: 'Tap', untap: 'Untap',
  add_counters: 'Add counters to', pump: 'Pump', grant_keyword: 'Grant keyword to', gain_control: 'Gain control of',
}

/** Classifies what a hand spell does so the cast flow can pick targets correctly. */
export function getSpellPlan(card: ControllerCard): SpellPlan {
  const script = normalizeCardBehaviorToV2(
    card.copied_script ?? card.cards?.script ?? null,
    card.cards?.type_line,
  )
  const actions = script.spell_effect?.actions ?? []
  const timing: 'instant' | 'sorcery' = card.cards?.type_line?.toLowerCase().includes('sorcery')
    ? 'sorcery'
    : 'instant'

  // A modal spell ("choose one —") carries `modes` instead of `actions`. Casting
  // it creates a choose_mode decision the existing ChooseModeBody resolves.
  const modal = (script.spell_effect as { modes?: ModalMode[]; choose?: number } | undefined)?.modes
  if (Array.isArray(modal) && modal.length > 0) {
    const choose = Math.max(1, Number((script.spell_effect as { choose?: number }).choose ?? 1))
    return { kind: 'modal', modes: modal, choose, timing }
  }

  const pump = actions.find((a) => a.type === 'pump') as
    | (CardBehaviorAction & { power?: number; toughness?: number; target_controller?: unknown })
    | undefined
  if (pump && (typeof pump.power === 'number' || typeof pump.toughness === 'number')) {
    return { kind: 'pump', power: pump.power ?? 0, toughness: pump.toughness ?? 0, timing, targetController: readTargetController(pump) }
  }

  // "Target creature becomes X/Y until end of turn" (Frogify) — sets P/T (layer 7b)
  // rather than adding to it. Only a creature target is chosen; the values are fixed
  // by the card and ride in the plan, like pump.
  const setPt = actions.find((a) => a.type === 'set_pt') as
    | (CardBehaviorAction & { power?: number; toughness?: number; target_controller?: unknown })
    | undefined
  if (setPt && (typeof setPt.power === 'number' || typeof setPt.toughness === 'number')) {
    return { kind: 'set_pt', power: setPt.power ?? 0, toughness: setPt.toughness ?? 0, timing, targetController: readTargetController(setPt) }
  }

  const addCounters = actions.find((a) => a.type === 'add_counters') as
    | (CardBehaviorAction & { amount?: number | 'X'; target_type?: unknown; target?: unknown; target_controller?: unknown; counter_type?: string; all?: boolean })
    | undefined
  if (
    addCounters &&
    (typeof addCounters.amount === 'number' || addCounters.amount === 'X') &&
    targetTypeMatches(addCounters.target_type ?? addCounters.target ?? 'creature', 'creature')
  ) {
    const xRequired = addCounters.amount === 'X'
    return { kind: 'add_counters', amount: xRequired ? 0 : addCounters.amount as number, timing, targetController: readTargetController(addCounters), xRequired, counterType: addCounters.counter_type, all: addCounters.all }
  }

  // Grant-keyword combat trick (e.g. "target creature gains flying until EOT").
  // The keyword is fixed by the card; only a creature target is chosen, so it rides
  // the same picker as the other creature effects — carrying `keyword` in the plan.
  const grantKeyword = actions.find((a) => a.type === 'grant_keyword') as
    | (CardBehaviorAction & { keyword?: string; target_controller?: unknown })
    | undefined
  if (grantKeyword && typeof grantKeyword.keyword === 'string') {
    return {
      kind: 'creature_effect',
      effect: 'grant_keyword_creature',
      label: `Grant ${grantKeyword.keyword.replace(/_/g, ' ')}`,
      keyword: grantKeyword.keyword,
      timing,
      targetController: readTargetController(grantKeyword),
    }
  }

  // Gain control (Threaten / Act of Treason / Mind Control). Only a creature
  // target is chosen; duration + the threaten extras are fixed by the card and
  // ride along in the plan, like grant_keyword's keyword.
  const gainControl = actions.find((a) => a.type === 'gain_control') as
    | (CardBehaviorAction & { duration?: string; untap?: boolean; haste?: boolean; target_controller?: unknown })
    | undefined
  if (gainControl) {
    return {
      kind: 'creature_effect',
      effect: 'gain_control_creature',
      label: 'Gain control',
      duration: gainControl.duration ?? 'permanent',
      untap: gainControl.untap ?? false,
      haste: gainControl.haste ?? false,
      timing,
      targetController: readTargetController(gainControl),
    }
  }

  // Fight: a creature you control fights a target creature. The action's
  // target_type/target_controller describe the FOUGHT creature; the fighter is
  // implicitly one you control (chosen first in the picker).
  const fight = actions.find((a) => a.type === 'fight') as
    | (CardBehaviorAction & { target_controller?: unknown })
    | undefined
  if (fight) {
    return { kind: 'fight', timing, foughtController: readTargetController(fight) }
  }

  const creatureEffect = actions.find((a) => a.type in CREATURE_EFFECT_MAP) as
    | (CardBehaviorAction & { target_controller?: unknown; targets?: number; target_type?: unknown; then?: unknown[]; controller_searches_basic_land?: boolean })
    | undefined
  if (creatureEffect) {
    const mapped = CREATURE_EFFECT_MAP[creatureEffect.type]
    // A non-creature permanent target (artifact/enchantment/nonland…) → the permanent
    // picker + cast path. Checked first: it changes both the picker and the action.
    if (!isCreatureOnlyTargetType(creatureEffect.target_type)) {
      return {
        kind: 'permanent_effect',
        effectKind: creatureEffect.type as MultiCreatureKind,
        label: mapped.label,
        targetType: (creatureEffect.target_type as string | string[]) ?? 'permanent',
        timing,
        targetController: readTargetController(creatureEffect),
        then: Array.isArray(creatureEffect.then) ? creatureEffect.then : undefined,
        controllerSearchesBasicLand: creatureEffect.controller_searches_basic_land === true,
      }
    }
    // `targets` > 1 → a multi-target removal ("destroy up to N target creatures").
    if (typeof creatureEffect.targets === 'number' && creatureEffect.targets > 1) {
      return {
        kind: 'multi_creature',
        effectKind: creatureEffect.type as MultiCreatureKind,
        label: mapped.label,
        count: creatureEffect.targets,
        timing,
        targetController: readTargetController(creatureEffect),
      }
    }
    return { kind: 'creature_effect', effect: mapped.effect, label: mapped.label, timing, targetController: readTargetController(creatureEffect) }
  }

  // A spell whose effects include a scry/surveil (a resolution-time decision) or
  // is a multi-action untargeted combo runs as an effect program (e.g. Opt: scry,
  // then draw). This MUST be checked before the single-action `draw` case below,
  // otherwise Opt matches `draw` first and the scry is dropped.
  const hasDecisionEffect = actions.some((a) => DECISION_SPELL_ACTION_TYPES.includes(a.type ?? ''))
  const allUntargeted = actions.every((a) => UNTARGETED_SPELL_ACTION_TYPES.includes(a.type ?? ''))
  // Legacy single-action kinds keep their dedicated cast UIs below; anything
  // newer runs as a program even alone (Noxious Assault's lone pump_all).
  const LEGACY_SINGLE = ['scry', 'surveil', 'draw', 'gain_life', 'lose_life', 'mill', 'create_token', 'add_counters_all', 'tap_all', 'untap_all', 'search_library', 'discard', 'may', 'choose_player', 'sacrifice', 'return_from_graveyard', 'proliferate']
  if (actions.length > 0 && allUntargeted
      && (hasDecisionEffect || actions.length > 1 || !LEGACY_SINGLE.includes(actions[0]?.type ?? ''))) {
    const xRequired = actions.some(
      (a) => (a as { amount?: unknown }).amount === 'X' || (a as { count?: unknown }).count === 'X',
    )
    return { kind: 'spell_effect', actions, timing, xRequired }
  }

  const draw = actions.find((a) => a.type === 'draw') as
    | (CardBehaviorAction & { amount?: number | 'X' })
    | undefined
  if (draw) {
    const xRequired = draw.amount === 'X'
    return { kind: 'draw', amount: xRequired ? 0 : (typeof draw.amount === 'number' ? draw.amount : 1), timing, xRequired }
  }

  const damage = actions.find((a) => a.type === 'deal_damage' || a.type === 'deal_damage_player') as
    | (CardBehaviorAction & { amount?: number | 'X'; target_type?: unknown; target?: unknown; target_controller?: unknown; divided?: boolean })
    | undefined
  if (damage && (typeof damage.amount === 'number' || damage.amount === 'X')) {
    const xRequired = damage.amount === 'X'
    const tt = damage.target_type ?? damage.target
    // No target type defaults to player (legacy player-burn behavior).
    const canTargetPlayer = !tt || targetTypeMatches(tt, 'player')
    const canTargetCreature = targetTypeMatches(tt, 'creature')
    // Divided damage (Forked Bolt) — a fixed amount allocated across targets.
    if (damage.divided === true && typeof damage.amount === 'number') {
      return { kind: 'divided_damage', amount: damage.amount, timing, canTargetPlayer, canTargetCreature, targetController: readTargetController(damage) }
    }
    if (canTargetPlayer || canTargetCreature) {
      return { kind: 'damage', amount: xRequired ? 0 : damage.amount as number, timing, canTargetPlayer, canTargetCreature, targetController: readTargetController(damage), xRequired }
    }
  }

  if (doesCardRequireStackTarget(card)) {
    return { kind: 'counterspell' }
  }

  return { kind: 'normal' }
}

/**
 * Whether a hand card can be cast now. Damage/pump spells target a creature or
 * player (not a stack item), so they cast at their natural speed regardless of
 * the stack — unlike getCanQuickCast, which gates anything with "target" text on
 * a non-empty stack (correct only for counterspells).
 */
export function canCastHandSpell(
  card: ControllerCard,
  canCastSorceries: boolean,
  canCastInstants: boolean,
  pendingStackCount: number,
): boolean {
  const plan = getSpellPlan(card)
  if (
    plan.kind === 'damage' ||
    plan.kind === 'pump' ||
    plan.kind === 'set_pt' ||
    plan.kind === 'add_counters' ||
    plan.kind === 'creature_effect' ||
    plan.kind === 'draw' ||
    plan.kind === 'spell_effect' ||
    plan.kind === 'modal'
  ) {
    const isSorcerySpeed = card.cards?.type_line?.toLowerCase().includes('sorcery') ?? false
    return card.zone === 'hand' && (isSorcerySpeed ? canCastSorceries : canCastInstants)
  }
  return getCanQuickCast(card, canCastSorceries, canCastInstants, pendingStackCount)
}

// Total mana pips in a cost string ({2}{R} → 3). Generic + one per coloured pip.
function manaCostTotal(manaCost?: string | null): number {
  const cost = parseManaCost(manaCost)
  return cost.generic + manaColors.reduce((sum, c) => sum + cost.colored[c], 0)
}

// Does this player have a response they could make right now — a castable,
// affordable instant/flash in hand, or an affordable instant-speed activated
// ability on the battlefield? Used by the controller's auto-pass to STOP
// instead of passing through opponents' priority windows. Affordability is
// approximate (mana pips vs available mana + tap-source availability), matching
// the spirit of the cast-button enable checks elsewhere; the engine still
// rejects anything genuinely illegal.
export function playerHasInstantResponse(
  cards: ControllerCard[],
  canCastInstants: boolean,
  pendingStackCount: number,
  availableMana: number,
): boolean {
  if (!canCastInstants) return false
  // Hand: castable at instant speed (canCastSorceries=false isolates instants/
  // flash) and affordable.
  const handResponse = cards.some((card) => {
    if (card.zone !== 'hand') return false
    if (!canCastHandSpell(card, false, true, pendingStackCount)) return false
    const total = manaCostTotal(card.cards?.mana_cost)
    return total === 0 || availableMana >= total
  })
  if (handResponse) return true
  // Battlefield: any non-mana, instant-speed activated ability that's affordable.
  return cards.some((card) => {
    if (card.zone !== 'battlefield') return false
    const script = normalizeCardBehaviorToV2(card.copied_script ?? card.cards?.script ?? null, card.cards?.type_line)
    return (script.activated_abilities ?? []).some((ability) => {
      if (ability.is_mana_ability) return false
      if (ability.timing === 'sorcery') return false
      // Mirrors activate_ability's zone gate (mig 289): missing means battlefield.
      if ((ability.source_zone_required ?? 'battlefield') !== 'battlefield') return false
      const costs = ability.costs ?? []
      if (costs.some((c) => c.type === 'tap_self') && card.is_tapped) return false
      const manaCost = costs.find((c) => c.type === 'mana') as { amount?: string } | undefined
      if (!manaCost?.amount) return true
      const total = manaCostTotal(manaCost.amount)
      return total === 0 || availableMana >= total
    })
  })
}
