'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import {
  activateAbility,
  addManaFromCard,
  advanceStep,
  castCardFromHand,
  castSpellEffect,
  chooseTriggeredAbilityCreatureTarget,
  chooseTriggeredAbilityTargets,
  castFight,
  declareAttacker as declareAttackerAction,
  declareBlocker as declareBlockerAction,
  getErrorMessage,
  moveCardToZone,
  passPriority as passPriorityAction,
  putAddCountersCreatureOnStack,
  putGrantKeywordCreatureOnStack,
  putGainControlCreatureOnStack,
  putCounterSpellOnStack,
  putDealDamageCreatureOnStack,
  putDealDamagePlayerOnStack,
  putDrawCardsOnStack,
  putPumpCreatureOnStack,
  putTargetedCreatureActionOnStack,
  castMultiCreatureEffect,
  castPermanentEffect,
  castDividedDamage,
  castModalSpell,
  resolveCombatDamage,
  setCombatBlockerOrder,
  submitDecision,
} from '@/lib/game/actions'
import type { TargetController, TargetedCreatureActionType, MultiCreatureKind, DamageAllocation, ModalMode, CombatDamageAssignments } from '@/lib/game/actions'
import type { CardBehaviorAction, CardBehaviorCost } from '@/lib/game/card-behavior'
import {
  isAddManaBehaviorAction,
  normalizeCardBehaviorToV2,
  selectFirstManaAbility,
} from '@/lib/game/card-behavior'
import { doesCardRequireStackTarget, getCanQuickCast, getPowerToughnessLabel } from '@/lib/game/controller-selectors'
import { parseManaCost } from '@/lib/game/mana'
import { getOpponentZoneData } from '@/lib/game/data'
import type { OpponentZoneData } from '@/lib/game/data'
import { useControllerGameState } from '@/lib/game/use-controller-game-state'
import type {
  BoardCard,
  CombatAssignment,
  CombatBlocker,
  ControllerCard,
  GameSessionPlayer,
  GameTurnState,
  ManaColor,
  ManaPool,
  ModalModeOption,
  PendingDecision,
  ScryOption,
  StackItem,
} from '@/lib/game/types'
import MotionCard from './MotionCard'

// ─── Types ──────────────────────────────────────────────────────────────────

type LayoutState = 'main_phase' | 'declare_attackers' | 'declare_blockers' | 'stack_active' | 'default'

// ─── Constants ───────────────────────────────────────────────────────────────

const manaColors: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']

const manaColorStyles: Record<ManaColor, { dot: string; text: string; bg: string }> = {
  W: { dot: 'bg-[#F5EDD0]', text: 'text-[#F5EDD0]', bg: 'bg-[#F5EDD0]' },
  U: { dot: 'bg-[#4A9FD8]', text: 'text-[#4A9FD8]', bg: 'bg-[#4A9FD8]' },
  B: { dot: 'bg-[#9A7AC8]', text: 'text-[#9A7AC8]', bg: 'bg-[#9A7AC8]' },
  R: { dot: 'bg-[#E85030]', text: 'text-[#E85030]', bg: 'bg-[#E85030]' },
  G: { dot: 'bg-[#3AA850]', text: 'text-[#3AA850]', bg: 'bg-[#3AA850]' },
  C: { dot: 'bg-[#8A8A8A]', text: 'text-[#8A8A8A]', bg: 'bg-[#8A8A8A]' },
}

// Grouped step display for the status bar (7 buckets, like MTG Arena)
const stepGroups: { label: string; steps: GameTurnState['step'][] }[] = [
  { label: 'UTK', steps: ['untap'] },
  { label: 'UPK', steps: ['upkeep'] },
  { label: 'DRW', steps: ['draw'] },
  { label: 'M1',  steps: ['precombat_main'] },
  { label: 'COM', steps: ['beginning_of_combat', 'declare_attackers', 'declare_blockers', 'combat_damage', 'end_of_combat'] },
  { label: 'M2',  steps: ['postcombat_main'] },
  { label: 'END', steps: ['end', 'cleanup'] },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the single mana color to auto-produce when a card has exactly one simple tap ability. */
function getAutoTapColor(card: ControllerCard): ManaColor | null {
  if (card.is_tapped) return null
  const script = normalizeCardBehaviorToV2(
    card.copied_script ?? card.cards?.script ?? null,
    card.cards?.type_line,
  )
  const manaAbilities = script.activated_abilities?.filter((a) => a.is_mana_ability) ?? []
  if (manaAbilities.length !== 1) return null
  const ability = manaAbilities[0]
  if (ability.costs.length !== 1 || ability.costs[0].type !== 'tap_self') return null
  const addManaEffects = ability.effects.filter(isAddManaBehaviorAction)
  if (addManaEffects.length !== 1) return null
  return addManaEffects[0].color
}

function renderAbilityCost(costs: CardBehaviorCost[]): string {
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
      default: return cost.type
    }
  }).join(' ')
}

function renderAbilityEffect(effects: CardBehaviorAction[]): string {
  return effects.map((e) => {
    if (isAddManaBehaviorAction(e)) return `Add {${e.color}}`
    const asAny = e as Record<string, unknown>
    if (e.type === 'deal_damage') return `Deal ${String(asAny.amount ?? '?')} damage`
    if (e.type === 'counter') return 'Counter target spell'
    return String(e.type).replace(/_/g, ' ')
  }).join(', ')
}

// Combat/ability keywords surfaced as badges on cards.
const KEYWORD_LABELS: Record<string, string> = {
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

/** Collects displayable keywords for a card from Scryfall keywords + scripted continuous effects. */
function getCardKeywords(card: ControllerCard): string[] {
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
function effectiveBoardPT(card: BoardCard): string {
  const base = card.power_toughness
  if (!base) return ''
  const bonusP = (card.plus_one_counters ?? 0) + (card.pump_power ?? 0)
  const bonusT = (card.plus_one_counters ?? 0) + (card.pump_toughness ?? 0)
  const match = base.match(/^(\d+)\s*\/\s*(\d+)$/)
  if ((bonusP === 0 && bonusT === 0) || !match) return base
  return `${Number(match[1]) + bonusP}/${Number(match[2]) + bonusT}`
}

/** Printed P/T with +1/+1 counters and active pumps folded in. */
function getEffectivePT(card: ControllerCard): string | null {
  const base = getPowerToughnessLabel(card)
  if (!base) return null
  const bonusP = (card.plus_one_counters ?? 0) + (card.pump_power ?? 0)
  const bonusT = (card.plus_one_counters ?? 0) + (card.pump_toughness ?? 0)
  const match = base.match(/^(\d+)\s*\/\s*(\d+)$/)
  if ((bonusP === 0 && bonusT === 0) || !match) return base
  return `${Number(match[1]) + bonusP}/${Number(match[2]) + bonusT}`
}

type SpellPlan =
  // xRequired: the effect amount is "X" — prompt the caster for a number at cast,
  // pay it as {X} mana, and pass it as x_value (the server resolves the amount).
  | { kind: 'damage'; amount: number; timing: 'instant' | 'sorcery'; canTargetPlayer: boolean; canTargetCreature: boolean; targetController: TargetController; xRequired?: boolean }
  // Divided damage: allocate `amount` across multiple creature/player targets.
  | { kind: 'divided_damage'; amount: number; timing: 'instant' | 'sorcery'; canTargetPlayer: boolean; canTargetCreature: boolean; targetController: TargetController }
  | { kind: 'pump'; power: number; toughness: number; timing: 'instant' | 'sorcery'; targetController: TargetController }
  | { kind: 'add_counters'; amount: number; timing: 'instant' | 'sorcery'; targetController: TargetController; xRequired?: boolean }
  | { kind: 'creature_effect'; effect: TargetedCreatureActionType; label: string; keyword?: string; duration?: string; untap?: boolean; haste?: boolean; timing: 'instant' | 'sorcery'; targetController: TargetController }
  // Multi-target removal: pick up to `count` creatures, apply `effectKind` to each.
  | { kind: 'multi_creature'; effectKind: MultiCreatureKind; label: string; count: number; timing: 'instant' | 'sorcery'; targetController: TargetController }
  // Non-creature permanent removal: destroy/exile/… a target of `targetType`.
  | { kind: 'permanent_effect'; effectKind: MultiCreatureKind; label: string; targetType: string | string[]; timing: 'instant' | 'sorcery'; targetController: TargetController }
  | { kind: 'fight'; timing: 'instant' | 'sorcery'; foughtController: TargetController }
  | { kind: 'draw'; amount: number; timing: 'instant' | 'sorcery'; xRequired?: boolean }
  | { kind: 'spell_effect'; actions: unknown[]; timing: 'instant' | 'sorcery'; xRequired?: boolean }
  // Modal "choose one —": cast the modes; the choose_mode decision UI picks them.
  | { kind: 'modal'; modes: ModalMode[]; choose: number; timing: 'instant' | 'sorcery' }
  | { kind: 'counterspell' }
  | { kind: 'normal' }

// Normalises an effect's target_controller to the engine's three values.
function readTargetController(action: { target_controller?: unknown } | undefined): TargetController {
  const raw = typeof action?.target_controller === 'string' ? action.target_controller.toLowerCase() : ''
  if (raw === 'opponent') return 'opponent'
  if (raw === 'you' || raw === 'self' || raw === 'controller') return 'you'
  return 'any'
}

// Does a board creature satisfy the spell/trigger's controller restriction,
// from the perspective of the player who controls the effect?
function creatureMatchesController(
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
const UNTARGETED_SPELL_ACTION_TYPES = ['scry', 'surveil', 'draw', 'gain_life', 'lose_life', 'mill', 'create_token', 'add_counters_all', 'tap_all', 'untap_all', 'search_library', 'discard', 'may', 'choose_player', 'sacrifice', 'return_from_graveyard']
// Effects that open a resolution-time choice — a spell containing one must run as a
// program (single dedicated cast kinds can't surface the prompt).
const DECISION_SPELL_ACTION_TYPES = ['scry', 'surveil', 'search_library', 'discard', 'may', 'choose_player', 'sacrifice', 'return_from_graveyard']

// Maps a spell_effect action type to a targeted-creature stack action + a picker label.
const CREATURE_EFFECT_MAP: Record<string, { effect: TargetedCreatureActionType; label: string }> = {
  destroy: { effect: 'destroy_creature', label: 'Destroy' },
  exile: { effect: 'exile_creature', label: 'Exile' },
  bounce: { effect: 'bounce_creature', label: 'Return to hand' },
  tap: { effect: 'tap_creature', label: 'Tap' },
  untap: { effect: 'untap_creature', label: 'Untap' },
}

function targetTypeMatches(tt: unknown, want: string): boolean {
  if (!tt) return false
  if (tt === want || tt === 'any') return true
  return Array.isArray(tt) && (tt.includes(want) || tt.includes('any'))
}

// True when a removal effect's target_type is creature-only (the default). A
// non-creature permanent type (artifact/enchantment/land/planeswalker/permanent)
// routes to the permanent_effect cast path instead of the creature picker.
function isCreatureOnlyTargetType(tt: unknown): boolean {
  if (tt == null) return true
  if (typeof tt === 'string') return tt.toLowerCase() === 'creature'
  if (Array.isArray(tt)) return tt.length > 0 && tt.every((t) => String(t).toLowerCase() === 'creature')
  return false
}

// Whether a board card's type line satisfies an effect's target_type filter
// ('permanent'/'any' match anything on the battlefield). Mirrors the engine's
// card_type_line_matches_target.
function cardMatchesTargetType(typeLine: string | null | undefined, tt: string | string[]): boolean {
  const tl = (typeLine ?? '').toLowerCase()
  const types = Array.isArray(tt) ? tt : [tt]
  return types.some((t) => {
    const lt = String(t).toLowerCase()
    return lt === 'any' || lt === 'permanent' || tl.includes(lt)
  })
}

// Activated-ability effects the client can invoke (the engine's activate_ability
// vocabulary). draw is untargeted; the rest target a creature (deal_damage also a
// player). Returns null for anything else → the ability renders "Soon".
const ABILITY_EFFECT_TYPES = [
  'deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap', 'add_counters', 'pump', 'grant_keyword', 'gain_control', 'draw',
]
function getAbilityEffect(
  effects: CardBehaviorAction[],
): { type: string; amount: number; canTargetPlayer: boolean; canTargetCreature: boolean; needsTarget: boolean } | null {
  const e = effects.find((x) => ABILITY_EFFECT_TYPES.includes(x.type ?? '')) as
    | (CardBehaviorAction & { amount?: number; target_type?: unknown })
    | undefined
  if (!e || !e.type) return null
  if (e.type === 'draw') {
    return { type: 'draw', amount: typeof e.amount === 'number' ? e.amount : 1, canTargetPlayer: false, canTargetCreature: false, needsTarget: false }
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
const ABILITY_VERB: Record<string, string> = {
  destroy: 'Destroy', exile: 'Exile', bounce: 'Return to hand', tap: 'Tap', untap: 'Untap',
  add_counters: 'Add counters to', pump: 'Pump', grant_keyword: 'Grant keyword to', gain_control: 'Gain control of',
}

/**
 * Prompts the caster for the X value of an {X} spell. Returns a positive integer,
 * or null if cancelled / invalid (the caller aborts the cast). No mana-colour
 * picker is needed — the engine auto-distributes the {X} generic from the pool.
 */
function promptForXValue(): number | null {
  if (typeof window === 'undefined') return null
  const raw = window.prompt('Choose X (you must have X generic mana to pay for it):', '1')
  if (raw == null) return null
  const n = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(n) || n < 1) {
    window.alert('X must be a whole number of at least 1.')
    return null
  }
  return n
}

/** Classifies what a hand spell does so the cast flow can pick targets correctly. */
function getSpellPlan(card: ControllerCard): SpellPlan {
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

  const addCounters = actions.find((a) => a.type === 'add_counters') as
    | (CardBehaviorAction & { amount?: number | 'X'; target_type?: unknown; target?: unknown; target_controller?: unknown })
    | undefined
  if (
    addCounters &&
    (typeof addCounters.amount === 'number' || addCounters.amount === 'X') &&
    targetTypeMatches(addCounters.target_type ?? addCounters.target ?? 'creature', 'creature')
  ) {
    const xRequired = addCounters.amount === 'X'
    return { kind: 'add_counters', amount: xRequired ? 0 : addCounters.amount as number, timing, targetController: readTargetController(addCounters), xRequired }
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
    | (CardBehaviorAction & { target_controller?: unknown; targets?: number; target_type?: unknown })
    | undefined
  if (creatureEffect) {
    const mapped = CREATURE_EFFECT_MAP[creatureEffect.type]
    // A non-creature permanent target (artifact/enchantment/…) → the permanent
    // picker + cast path. Checked first: it changes both the picker and the action.
    if (!isCreatureOnlyTargetType(creatureEffect.target_type)) {
      return {
        kind: 'permanent_effect',
        effectKind: creatureEffect.type as MultiCreatureKind,
        label: mapped.label,
        targetType: (creatureEffect.target_type as string | string[]) ?? 'permanent',
        timing,
        targetController: readTargetController(creatureEffect),
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
  if (actions.length > 0 && allUntargeted && (hasDecisionEffect || actions.length > 1)) {
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
function canCastHandSpell(
  card: ControllerCard,
  canCastSorceries: boolean,
  canCastInstants: boolean,
  pendingStackCount: number,
): boolean {
  const plan = getSpellPlan(card)
  if (
    plan.kind === 'damage' ||
    plan.kind === 'pump' ||
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

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function ControllerListV4({ sessionId }: { sessionId: string }) {
  const [selectedCard, setSelectedCard] = useState<ControllerCard | null>(null)
  // Tracks the last resolved combat damage pass ('first_strike' | 'regular') so the
  // resolve button knows whether a second (regular) pass is still pending.
  const [combatDamageStage, setCombatDamageStage] = useState<string | null>(null)
  // Player-chosen combat damage over-assignment, keyed by attacker game_card id.
  // Empty => the server auto-assigns (minimum lethal). Populated only for attackers
  // the player explicitly configures via the damage-assignment sheet.
  const [damageAssignments, setDamageAssignments] = useState<CombatDamageAssignments>({})

  const {
    supabase,
    cards,
    boardCards,
    players,
    turnState,
    combatAssignments,
    stackItems,
    pendingDecisions,
    manaPool,
    playerId,
    isSessionFinished,
    isLoading,
    errorMessage,
    setErrorMessage,
    refresh,
  } = useControllerGameState(sessionId)

  // The oldest pending decision this player must act on (one at a time).
  const myPendingDecision = pendingDecisions.find((d) => d.deciding_player_id === playerId) ?? null

  const currentPlayer = players.find((p) => p.player_id === playerId) ?? null
  const opponentPlayers = players.filter((p) => p.player_id !== playerId)
  const pendingStackItems = stackItems.filter((i) => i.status === 'pending')

  const hasPriority = Boolean(
    playerId && turnState && (turnState.priority_player_id ?? turnState.active_player_id) === playerId,
  )
  const isActivePlayer = Boolean(playerId && turnState?.active_player_id === playerId)
  const isMainPhaseStep = turnState?.step === 'precombat_main' || turnState?.step === 'postcombat_main'
  const canCastSorceries = hasPriority && isActivePlayer && isMainPhaseStep && pendingStackItems.length === 0 && !isSessionFinished
  const canCastInstants = hasPriority && !isSessionFinished

  const battlefieldCards = cards.filter((c) => c.zone === 'battlefield')
  const handCards = cards.filter((c) => c.zone === 'hand').sort((a, b) => a.zone_position - b.zone_position)
  const ownGraveyard = cards.filter((c) => c.zone === 'graveyard')
  const ownExile = cards.filter((c) => c.zone === 'exile')
  const ownLibraryCount = cards.filter((c) => c.zone === 'library').length
  const ownCreatures = battlefieldCards.filter((c) => c.cards?.type_line?.toLowerCase().includes('creature'))
  const incomingAttackers = combatAssignments.filter((a) => a.defending_player_id === playerId)
  // Attackers this player has already declared this combat. Once non-empty, we
  // must not re-show the attacker picker (e.g. after an attack trigger resolves
  // and priority returns to the active player) — that would soft-lock combat.
  const myDeclaredAttackers = combatAssignments.filter((a) => a.attacking_player_id === playerId)

  // Mana availability — untapped lands + any floating mana already in pool
  const untappedLandCount = battlefieldCards.filter(
    (c) => c.cards?.type_line?.toLowerCase().includes('land') && !c.is_tapped,
  ).length
  const floatingManaTotal = manaColors.reduce((sum, c) => sum + (manaPool[c] ?? 0), 0)
  const availableMana = untappedLandCount + floatingManaTotal
  const topStackItem = pendingStackItems.slice().sort((a, b) => b.position - a.position)[0] ?? null
  const mustChooseTriggerTarget = Boolean(
    playerId &&
    topStackItem?.action_type === 'triggered_ability' &&
    topStackItem.controller_player_id === playerId &&
    topStackItem.payload?.target_required === true &&
    !topStackItem.payload?.target_card_id &&
    boardCards.some(
      (c) =>
        c.type_line?.toLowerCase().includes('creature') &&
        creatureMatchesController(c, playerId, topStackItem.payload?.target_controller as string | undefined),
    ),
  )

  // A pending decision suspends the game (server blocks pass_priority too). The
  // decider must submit; everyone else waits.
  const passBlockReason = myPendingDecision
    ? 'Resolve your decision'
    : pendingDecisions.length > 0
      ? 'Waiting for a decision'
      : mustChooseTriggerTarget
        ? 'Choose trigger target'
        : null

  // Land play limit — normally 1 per turn
  const canPlayLand =
    canCastSorceries &&
    (turnState?.lands_played_this_turn ?? 0) < (turnState?.land_play_limit ?? 1)

  // Keep selected card live — re-derives from cards array so sheet reflects latest game state
  const selectedCardLive = selectedCard ? (cards.find((c) => c.id === selectedCard.id) ?? null) : null

  const layoutState = useMemo<LayoutState>(() => {
    if (pendingStackItems.length > 0) return 'stack_active'
    const step = turnState?.step
    if (
      step === 'declare_attackers' &&
      hasPriority &&
      playerId &&
      turnState?.active_player_id === playerId &&
      myDeclaredAttackers.length === 0
    )
      return 'declare_attackers'
    // Only show the blockers layout while the defender still holds priority.
    // Once they confirm and pass, priority leaves them and they drop to the
    // board (showing "Wait") so the step can advance when all players pass.
    if (step === 'declare_blockers' && incomingAttackers.length > 0 && hasPriority)
      return 'declare_blockers'
    if (step === 'precombat_main' || step === 'postcombat_main')
      return 'main_phase'
    return 'default'
  }, [pendingStackItems, turnState, hasPriority, playerId, incomingAttackers, myDeclaredAttackers])

  const maxHandSize = 7
  const mustDiscard = isActivePlayer && turnState?.step === 'cleanup' && handCards.length > maxHandSize
  const discardCount = mustDiscard ? handCards.length - maxHandSize : 0

  // Reset combat-damage resolution tracking whenever we leave the combat damage step
  useEffect(() => {
    if (turnState?.step !== 'combat_damage') {
      setCombatDamageStage(null)
      setDamageAssignments({})
    }
  }, [turnState?.step])

  // Combat damage is fully resolved once the 'regular' pass has run
  const combatDamageResolved = combatDamageStage === 'regular'
  const canResolveCombatDamage =
    isActivePlayer &&
    turnState?.step === 'combat_damage' &&
    combatAssignments.length > 0 &&
    !combatDamageResolved &&
    !isSessionFinished

  // Attacking player can reorder multi-blocker damage before resolving
  const canOrderBlockers =
    isActivePlayer &&
    turnState?.step === 'combat_damage' &&
    !combatDamageResolved &&
    !isSessionFinished

  const tapForMana = async (cardId: string, color?: ManaColor) => {
    if (!playerId) return
    const card = battlefieldCards.find((c) => c.id === cardId)
    const script = card?.copied_script ?? card?.cards?.script ?? null
    const ability = selectFirstManaAbility(script, card?.cards?.type_line, color)
    const manaEffect = ability?.effects.find(
      (e) => isAddManaBehaviorAction(e) && (!color || e.color === color),
    )
    if (!card || !ability || !manaEffect || !isAddManaBehaviorAction(manaEffect)) {
      setErrorMessage('No mana ability found.')
      return
    }
    await addManaFromCard({
      supabase,
      cardId,
      sessionId,
      playerId,
      color: manaEffect.color,
      amount: manaEffect.amount,
      shouldTapCard: ability.costs.some((c) => c.type === 'tap_self'),
    })
    await refresh()
  }

  const actions = {
    passPriority: async () => { await passPriorityAction(supabase, sessionId); await refresh() },
    advanceStep: async () => { await advanceStep(supabase, sessionId); await refresh() },
    // Plain cast — permanents and untargeted spells
    castSpell: async (cardId: string) => {
      await castCardFromHand(supabase, sessionId, cardId)
      await refresh()
    },
    // Targeted player-damage spell (Lightning Bolt etc.)
    dealDamageToPlayer: async (cardId: string, targetPlayerId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'damage') return
      let x: number | null = null
      if (plan.xRequired) { x = promptForXValue(); if (x == null) return }
      await putDealDamagePlayerOnStack(supabase, sessionId, targetPlayerId, plan.amount, plan.timing, cardId, undefined, x)
      await refresh()
    },
    dealDamageToCreature: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'damage') return
      let x: number | null = null
      if (plan.xRequired) { x = promptForXValue(); if (x == null) return }
      await putDealDamageCreatureOnStack(supabase, sessionId, targetCardId, plan.amount, plan.timing, cardId, undefined, plan.targetController, x)
      await refresh()
    },
    pumpCreature: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'pump') return
      await putPumpCreatureOnStack(supabase, sessionId, targetCardId, plan.power, plan.toughness, plan.timing, cardId, undefined, plan.targetController)
      await refresh()
    },
    addCountersCreature: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'add_counters') return
      let x: number | null = null
      if (plan.xRequired) { x = promptForXValue(); if (x == null) return }
      await putAddCountersCreatureOnStack(supabase, sessionId, targetCardId, plan.amount, plan.timing, cardId, undefined, plan.targetController, x)
      await refresh()
    },
    // Targeted creature effect — destroy / bounce / tap / untap
    creatureEffect: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'creature_effect') return
      if (plan.effect === 'gain_control_creature') {
        await putGainControlCreatureOnStack(supabase, sessionId, targetCardId, plan.duration ?? 'permanent', plan.untap ?? false, plan.haste ?? false, plan.timing, cardId, undefined, plan.targetController)
      } else if (plan.keyword) {
        await putGrantKeywordCreatureOnStack(supabase, sessionId, targetCardId, plan.keyword, plan.timing, cardId, undefined, plan.targetController)
      } else {
        await putTargetedCreatureActionOnStack(supabase, sessionId, plan.effect, targetCardId, plan.timing, cardId, undefined, plan.targetController)
      }
      await refresh()
    },
    // Multi-target removal — destroy/exile/bounce/tap/untap of up to N creatures.
    multiCreatureEffect: async (cardId: string, targetCardIds: string[]) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'multi_creature' || targetCardIds.length === 0) return
      await castMultiCreatureEffect(supabase, sessionId, plan.effectKind, targetCardIds, plan.timing, cardId, undefined, plan.targetController)
      await refresh()
    },
    // Non-creature permanent removal — destroy/exile/… a target artifact/enchantment/…
    permanentEffect: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'permanent_effect') return
      await castPermanentEffect(supabase, sessionId, plan.effectKind, targetCardId, plan.targetType, plan.timing, cardId, undefined, plan.targetController)
      await refresh()
    },
    // Divided damage — allocate the total across the chosen creature/player targets.
    dividedDamage: async (cardId: string, allocations: DamageAllocation[]) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'divided_damage' || allocations.length === 0) return
      await castDividedDamage(supabase, sessionId, plan.amount, allocations, plan.timing, cardId, undefined, plan.targetController)
      await refresh()
    },
    // Fight spell — a creature you control (fighter) fights another creature (fought).
    fight: async (cardId: string, fighterCardId: string, foughtCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'fight') return
      await castFight(supabase, sessionId, fighterCardId, foughtCardId, cardId, plan.foughtController)
      await refresh()
    },
    // Untargeted card-draw spell (Divination etc.)
    drawCards: async (cardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'draw') return
      let x: number | null = null
      if (plan.xRequired) { x = promptForXValue(); if (x == null) return }
      await putDrawCardsOnStack(supabase, sessionId, plan.amount, plan.timing, cardId, undefined, x)
      await refresh()
    },
    // Untargeted multi-action spell (scry/surveil/draw program, e.g. Opt) — runs
    // the effects in order server-side, parking on a scry/surveil decision.
    spellEffect: async (cardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'spell_effect') return
      let x: number | null = null
      if (plan.xRequired) { x = promptForXValue(); if (x == null) return }
      await castSpellEffect(supabase, sessionId, plan.actions, cardId, x)
      await refresh()
    },
    // Modal spell — cast the card's modes; the choose_mode decision UI does the rest.
    modalSpell: async (cardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'modal') return
      await castModalSpell(supabase, sessionId, plan.modes, plan.choose, cardId)
      await refresh()
    },
    // Counterspell targeting a specific pending stack item
    counterSpell: async (cardId: string, stackItemId: string) => {
      await putCounterSpellOnStack(supabase, sessionId, stackItemId, cardId)
      await refresh()
    },
    activateAbility: async (
      sourceCardId: string,
      abilityIndex: number,
      target?: { targetCardId?: string | null; targetPlayerId?: string | null },
    ) => {
      await activateAbility(supabase, sessionId, sourceCardId, abilityIndex, target)
      await refresh()
    },
    tapForMana,
    declareAttacker: async (cardId: string, targetPlayerId: string) => {
      await declareAttackerAction(supabase, sessionId, cardId, targetPlayerId)
      await refresh()
    },
    declareBlocker: async (blockerCardId: string, attackingCardId: string) => {
      await declareBlockerAction(supabase, sessionId, blockerCardId, attackingCardId)
      await refresh()
    },
    discardCard: async (cardId: string) => {
      await moveCardToZone(supabase, cardId, 'graveyard')
      await refresh()
    },
    resolveCombatDamage: async () => {
      try {
        const result = await resolveCombatDamage(
          supabase,
          sessionId,
          Object.keys(damageAssignments).length ? damageAssignments : undefined,
        )
        const stage = result.damage_stage ?? 'regular'
        setCombatDamageStage(stage)
        // Keep the chosen distribution for the regular pass after first strike;
        // clear it only once combat damage is fully resolved.
        if (stage === 'regular') setDamageAssignments({})
      } catch (error) {
        setErrorMessage(getErrorMessage(error))
      }
      await refresh()
    },
    setBlockerOrder: async (assignmentId: string, orderedBlockerIds: string[]) => {
      await setCombatBlockerOrder(supabase, sessionId, assignmentId, orderedBlockerIds)
      await refresh()
    },
    chooseTriggerTarget: async (stackItemId: string, targetCardId: string) => {
      await chooseTriggeredAbilityCreatureTarget(supabase, sessionId, stackItemId, targetCardId)
      await refresh()
    },
    chooseTriggerTargets: async (stackItemId: string, targetCardIds: string[]) => {
      await chooseTriggeredAbilityTargets(supabase, sessionId, stackItemId, targetCardIds)
      await refresh()
    },
    // Submit a pending decision (modal mode + target / scry / surveil).
    submitDecision: async (decisionId: string, result: Record<string, unknown>) => {
      await submitDecision(supabase, decisionId, result)
      await refresh()
    },
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[100svh] items-center justify-center text-sm text-slate-400">
        Loading...
      </div>
    )
  }

  return (
    <div className="relative h-[100svh] overflow-hidden bg-[#0F1117] text-white">
      <AnimatePresence mode="wait">
        {layoutState === 'declare_attackers' ? (
          <motion.div key="attackers" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <DeclareAttackersLayout
              ownCreatures={ownCreatures}
              opponentPlayers={opponentPlayers}
              turnState={turnState}
              errorMessage={errorMessage}
              onDeclareAttacker={actions.declareAttacker}
              onPassPriority={actions.passPriority}
            />
          </motion.div>
        ) : layoutState === 'declare_blockers' ? (
          <motion.div key="blockers" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <DeclareBlockersLayout
              ownCreatures={ownCreatures}
              incomingAttackers={incomingAttackers}
              boardCards={boardCards}
              manaPool={manaPool}
              turnState={turnState}
              errorMessage={errorMessage}
              onDeclareBlocker={actions.declareBlocker}
              onPassPriority={actions.passPriority}
            />
          </motion.div>
        ) : (
          <motion.div
            key="main"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex h-full flex-col"
          >
            <StatusBar
              currentPlayer={currentPlayer}
              turnState={turnState}
              manaPool={manaPool}
              isActivePlayer={isActivePlayer}
              libraryCount={ownLibraryCount}
            />
            <div className="flex min-h-0 flex-1">
              <MainArea
                supabase={supabase}
                sessionId={sessionId}
                opponentPlayers={opponentPlayers}
                playerId={playerId}
                boardCards={boardCards}
                battlefieldCards={battlefieldCards}
                handCards={handCards}
                pendingStackItems={pendingStackItems}
                ownGraveyard={ownGraveyard}
                ownExile={ownExile}
                canCastSorceries={canCastSorceries}
                canCastInstants={canCastInstants}
                availableMana={availableMana}
                canPlayLand={canPlayLand}
                mustDiscard={mustDiscard}
                discardCount={discardCount}
                combatAssignments={combatAssignments}
                turnState={turnState}
                canOrderBlockers={canOrderBlockers}
                onCardTap={setSelectedCard}
                onTapForMana={actions.tapForMana}
                onDiscardCard={actions.discardCard}
                onSetBlockerOrder={actions.setBlockerOrder}
                onSetDamageAssignment={(attackerCardId, distribution) =>
                  setDamageAssignments((prev) => ({ ...prev, [attackerCardId]: distribution }))
                }
                onChooseTriggerTarget={actions.chooseTriggerTarget}
                onChooseTriggerTargets={actions.chooseTriggerTargets}
                pendingDecision={myPendingDecision}
                onSubmitDecision={actions.submitDecision}
              />
              <PriorityPanel
                hasPriority={hasPriority}
                isSessionFinished={isSessionFinished}
                canResolveCombatDamage={canResolveCombatDamage}
                combatDamageStage={combatDamageStage}
                blockPassReason={passBlockReason}
                onResolveCombatDamage={actions.resolveCombatDamage}
                onPassPriority={actions.passPriority}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Card action sheet */}
      <AnimatePresence>
        {selectedCardLive && (
          <CardActionSheet
            card={selectedCardLive}
            canCastSorceries={canCastSorceries}
            canCastInstants={canCastInstants}
            pendingStackCount={pendingStackItems.length}
            players={players}
            playerId={playerId}
            pendingStackItems={pendingStackItems}
            boardCards={boardCards}
            onTapForMana={async (cardId, color) => { await actions.tapForMana(cardId, color) }}
            onCastCard={async (cardId) => { await actions.castSpell(cardId) }}
            onDealDamageToPlayer={async (cardId, targetPlayerId) => { await actions.dealDamageToPlayer(cardId, targetPlayerId) }}
            onDealDamageToCreature={async (cardId, targetCardId) => { await actions.dealDamageToCreature(cardId, targetCardId) }}
            onPumpCreature={async (cardId, targetCardId) => { await actions.pumpCreature(cardId, targetCardId) }}
            onAddCountersCreature={async (cardId, targetCardId) => { await actions.addCountersCreature(cardId, targetCardId) }}
            onCreatureEffect={async (cardId, targetCardId) => { await actions.creatureEffect(cardId, targetCardId) }}
            onMultiCreatureEffect={async (cardId, targetCardIds) => { await actions.multiCreatureEffect(cardId, targetCardIds) }}
            onPermanentEffect={async (cardId, targetCardId) => { await actions.permanentEffect(cardId, targetCardId) }}
            onDividedDamage={async (cardId, allocations) => { await actions.dividedDamage(cardId, allocations) }}
            onFight={async (cardId, fighterCardId, foughtCardId) => { await actions.fight(cardId, fighterCardId, foughtCardId) }}
            onDrawCards={async (cardId) => { await actions.drawCards(cardId) }}
            onSpellEffect={async (cardId) => { await actions.spellEffect(cardId) }}
            onModalSpell={async (cardId) => { await actions.modalSpell(cardId) }}
            onCounterSpell={async (cardId, stackItemId) => { await actions.counterSpell(cardId, stackItemId) }}
            onActivateAbility={async (sourceId, abilityIndex, target) => { await actions.activateAbility(sourceId, abilityIndex, target) }}
            onClose={() => setSelectedCard(null)}
          />
        )}
      </AnimatePresence>

      {errorMessage && (
        <div className="absolute inset-x-3 bottom-4 z-[60] rounded-lg border border-red-400/20 bg-red-950/90 p-3 text-xs text-red-100">
          {errorMessage}
        </div>
      )}
    </div>
  )
}

// ─── Status Bar ───────────────────────────────────────────────────────────────

function StatusBar({
  currentPlayer,
  turnState,
  manaPool,
  isActivePlayer,
  libraryCount,
}: {
  currentPlayer: GameSessionPlayer | null
  turnState: GameTurnState | null
  manaPool: ManaPool
  isActivePlayer: boolean
  libraryCount: number
}) {
  const currentGroupIdx = stepGroups.findIndex((g) =>
    g.steps.includes(turnState?.step as GameTurnState['step']),
  )

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[#1E2230] bg-[#0C0E14] px-4">
      {/* Left: active-player dot + username + turn */}
      <div className="flex shrink-0 items-center gap-1.5">
        <div
          className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
            isActivePlayer ? 'bg-amber-400 shadow-[0_0_5px_rgba(251,191,36,0.7)]' : 'bg-slate-700'
          }`}
        />
        <span className={`truncate text-sm font-black transition-colors ${isActivePlayer ? 'text-white' : 'text-slate-500'}`}>
          {currentPlayer?.username ?? '—'}
        </span>
        <span className="shrink-0 text-[10px] text-slate-600">T{turnState?.turn_number ?? '—'}</span>
      </div>

      {/* Center: grouped step labels — sliding gold pill + opacity fade */}
      <div className="flex flex-1 items-center justify-center gap-1">
        {stepGroups.map((group, i) => {
          const isActive = i === currentGroupIdx
          const dist = currentGroupIdx < 0 ? 3 : Math.abs(i - currentGroupIdx)
          const opacity = isActive ? 1 : dist === 1 ? 0.75 : dist === 2 ? 0.5 : 0.3
          return (
            <motion.span
              key={group.label}
              animate={{ opacity }}
              transition={{ duration: 0.25 }}
              className={`relative rounded px-2.5 py-1 text-[9px] font-black uppercase tracking-wider ${
                isActive ? 'text-[#0F1117]' : 'text-[#9B9589]'
              }`}
            >
              {isActive && (
                <motion.span
                  layoutId="step-pill"
                  className="absolute inset-0 rounded bg-[#D4AF37]"
                  transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                />
              )}
              <span className="relative z-10">{group.label}</span>
            </motion.span>
          )
        })}
      </div>

      {/* Right: mana pool + library count + priority indicator + life */}
      <div className="flex shrink-0 items-center justify-end gap-2">
        <ManaPoolDisplay manaPool={manaPool} />
        <div className="flex flex-col items-center">
          <span className="text-sm font-black leading-none text-slate-400">{libraryCount}</span>
          <span className="text-[7px] uppercase tracking-wider text-slate-700">lib</span>
        </div>
        <span className="text-xl font-black leading-none text-white">{currentPlayer?.life_total ?? '—'}</span>
      </div>
    </header>
  )
}

// ─── Main Area ────────────────────────────────────────────────────────────────

type MyZoneTab = 'graveyard' | 'exile'

function MainArea({
  supabase,
  sessionId,
  opponentPlayers,
  playerId,
  boardCards,
  battlefieldCards,
  handCards,
  pendingStackItems,
  ownGraveyard,
  ownExile,
  canCastSorceries,
  canCastInstants,
  availableMana,
  canPlayLand,
  mustDiscard,
  discardCount,
  combatAssignments,
  turnState,
  canOrderBlockers,
  onCardTap,
  onTapForMana,
  onDiscardCard,
  onSetBlockerOrder,
  onSetDamageAssignment,
  onChooseTriggerTarget,
  onChooseTriggerTargets,
  pendingDecision,
  onSubmitDecision,
}: {
  supabase: ReturnType<typeof import('@/lib/supabase/client').createClient>
  sessionId: string
  opponentPlayers: GameSessionPlayer[]
  playerId: string | null
  boardCards: BoardCard[]
  battlefieldCards: ControllerCard[]
  handCards: ControllerCard[]
  pendingStackItems: StackItem[]
  ownGraveyard: ControllerCard[]
  ownExile: ControllerCard[]
  canCastSorceries: boolean
  canCastInstants: boolean
  availableMana: number
  canPlayLand: boolean
  mustDiscard: boolean
  discardCount: number
  combatAssignments: CombatAssignment[]
  turnState: GameTurnState | null
  canOrderBlockers: boolean
  onCardTap: (card: ControllerCard) => void
  onTapForMana: (cardId: string, color?: ManaColor) => Promise<void>
  onDiscardCard: (cardId: string) => Promise<void>
  onSetBlockerOrder: (assignmentId: string, orderedBlockerIds: string[]) => Promise<void>
  onSetDamageAssignment: (
    attackerCardId: string,
    distribution: { blockers: { blocker_card_id: string; amount: number }[]; trample?: number },
  ) => void
  onChooseTriggerTarget: (stackItemId: string, targetCardId: string) => Promise<void>
  onChooseTriggerTargets: (stackItemId: string, targetCardIds: string[]) => Promise<void>
  pendingDecision: PendingDecision | null
  onSubmitDecision: (decisionId: string, result: Record<string, unknown>) => Promise<void>
}) {
  const [focusedOpponentId, setFocusedOpponentId] = useState<string | null>(null)
  const [myZoneTab, setMyZoneTab] = useState<MyZoneTab>('graveyard')
  const [myZoneOpen, setMyZoneOpen] = useState(false)
  const [orderingAssignment, setOrderingAssignment] = useState<CombatAssignment | null>(null)

  // Keep the ordering sheet's assignment fresh as combat data refreshes
  const orderingAssignmentLive = orderingAssignment
    ? (combatAssignments.find((a) => a.id === orderingAssignment.id) ?? null)
    : null

  const focusedOpponent = opponentPlayers.find((p) => p.player_id === focusedOpponentId) ?? null
  const focusedOpponentCards = focusedOpponentId
    ? boardCards.filter((c) => c.controller_player_id === focusedOpponentId)
    : []

  // Live GY/exile/hand counts for each opponent, shown on the pills
  const [opponentCounts, setOpponentCounts] = useState<Record<string, OpponentZoneData>>({})
  const boardSignature = boardCards.length
  useEffect(() => {
    let cancelled = false
    Promise.all(
      opponentPlayers.map(async (p) => {
        try {
          const data = await getOpponentZoneData(supabase, sessionId, p.player_id)
          return [p.player_id, data] as const
        } catch {
          return [p.player_id, { graveyard: [], exile: [], handCount: 0, libraryCount: 0 }] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) setOpponentCounts(Object.fromEntries(entries))
    })
    return () => { cancelled = true }
  // Re-fetch when the board changes (cards moving in/out of zones)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, opponentPlayers.length, boardSignature])

  const lands = battlefieldCards.filter((c) => c.cards?.type_line?.toLowerCase().includes('land'))
  const creatures = battlefieldCards.filter((c) => c.cards?.type_line?.toLowerCase().includes('creature'))
  const other = battlefieldCards.filter(
    (c) =>
      !c.cards?.type_line?.toLowerCase().includes('land') &&
      !c.cards?.type_line?.toLowerCase().includes('creature'),
  )

  const handleCardTap = (card: ControllerCard) => {
    const autoColor = getAutoTapColor(card)
    if (autoColor !== null) void onTapForMana(card.id, autoColor)
    else onCardTap(card)
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {/* ── Opponent pills ────────────────────────────────────────────── */}
      <div className="flex h-8 shrink-0 items-center gap-2 overflow-x-auto border-b border-[#1E2230] bg-[#09090D] px-3">
        {opponentPlayers.map((p) => {
          const permanents = boardCards.filter((c) => c.controller_player_id === p.player_id).length
          const counts = opponentCounts[p.player_id]
          return (
            <button
              key={p.player_id}
              type="button"
              onClick={() => setFocusedOpponentId(p.player_id)}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 transition-colors active:scale-95 hover:bg-white/10"
            >
              <span className="text-[9px] font-bold text-slate-300">
                {p.username ?? `P${p.seat_number}`}
              </span>
              <span className="text-[9px] font-black text-white">♥{p.life_total}</span>
              <span className="flex items-center gap-1 border-l border-white/10 pl-1.5 text-[8px] text-slate-500">
                <span title="Cards in hand">✋{counts?.handCount ?? '·'}</span>
                <span title="Permanents on battlefield">⬡{permanents}</span>
                <span title="Cards in graveyard">⚰{counts?.graveyard.length ?? '·'}</span>
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Stack strip ──────────────────────────────────────────────── */}
      {pendingStackItems.length > 0 && (
        <StackStrip items={pendingStackItems} />
      )}

      <TargetedTriggerPrompt
        pendingStackItems={pendingStackItems}
        boardCards={boardCards}
        playerId={playerId}
        onChooseTarget={onChooseTriggerTarget}
        onChooseTargets={onChooseTriggerTargets}
      />

      {pendingDecision && (
        <PendingDecisionPrompt
          decision={pendingDecision}
          boardCards={boardCards}
          onSubmit={onSubmitDecision}
        />
      )}

      {/* ── Combat damage strip ──────────────────────────────────────── */}
      {(turnState?.step === 'combat_damage' || turnState?.step === 'end_of_combat') &&
        combatAssignments.length > 0 && (
        <CombatDamageStrip
          assignments={combatAssignments}
          boardCards={boardCards}
          canOrderBlockers={canOrderBlockers}
          onOrderBlockers={setOrderingAssignment}
        />
      )}

      {/* ── My board + opponent overlay ───────────────────────────────── */}
      <div className="relative flex min-h-0 flex-1 flex-col">

      {/* My battlefield — creatures & other permanents */}
      <div className="flex min-h-0 flex-1 items-center gap-2 overflow-x-auto bg-[#0C0F16] px-3 py-2">
        {[...creatures, ...other].map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => handleCardTap(card)}
            className="relative w-14 shrink-0 transition-transform active:scale-95"
          >
            <MotionCard
              card={{ id: card.id, name: card.name, image_url: card.cards?.image_url, is_tapped: card.is_tapped, damage_marked: card.damage_marked, zone: card.zone }}
              size="board"
              useLayoutId={false}
            />
            {getEffectivePT(card) && getEffectivePT(card) !== getPowerToughnessLabel(card) && (
              <span className="absolute -bottom-1 -right-1 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[9px] font-black text-white shadow ring-1 ring-black/40">
                {getEffectivePT(card)}
              </span>
            )}
          </button>
        ))}
        {creatures.length === 0 && other.length === 0 && (
          <p className="text-[10px] text-slate-800">Empty battlefield</p>
        )}
      </div>

      {/* Lands strip */}
      {lands.length > 0 && (
        <div className="flex h-14 shrink-0 items-center gap-2 border-t border-[#1E2230] bg-[#090B10] px-3">
          {lands.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => handleCardTap(card)}
              className="w-10 shrink-0 transition-transform active:scale-95"
            >
              <MotionCard
                card={{ id: card.id, name: card.name, image_url: card.cards?.image_url, is_tapped: card.is_tapped, damage_marked: card.damage_marked, zone: card.zone }}
                size="board"
                useLayoutId={false}
              />
            </button>
          ))}
        </div>
      )}

      {/* Cleanup discard banner */}
      {mustDiscard && (
        <div className="flex shrink-0 items-center gap-2 border-t border-red-900/40 bg-red-950/30 px-3 py-1.5">
          <span className="text-[9px] font-black uppercase tracking-widest text-red-400">Cleanup</span>
          <span className="text-[10px] text-red-300">
            Discard {discardCount} card{discardCount > 1 ? 's' : ''} — tap to discard
          </span>
        </div>
      )}

      {/* Hand + zone access */}
      <div className="flex h-[76px] shrink-0 items-center border-t border-[#1E2230] bg-[#0C0E14]">
        {/* Scrollable hand */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-3">
          {handCards.map((card) => {
            if (mustDiscard) {
              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => void onDiscardCard(card.id)}
                  className="w-12 shrink-0 rounded-lg ring-1 ring-red-500/60 ring-offset-1 ring-offset-[#0C0E14] transition-all active:scale-95"
                >
                  <MotionCard
                    card={{ id: card.id, name: card.name, image_url: card.cards?.image_url, is_tapped: false, damage_marked: 0, zone: card.zone }}
                    size="board"
                    useLayoutId={false}
                  />
                </button>
              )
            }

            const isLand = card.cards?.type_line?.toLowerCase().includes('land') ?? false
            const manaCost = parseManaCost(card.cards?.mana_cost)
            const totalCost = manaCost.generic + manaColors.reduce((sum, c) => sum + manaCost.colored[c], 0)
            const canAfford = totalCost === 0 || availableMana >= totalCost
            const playable = isLand
              ? canPlayLand
              : canCastHandSpell(card, canCastSorceries, canCastInstants, pendingStackItems.length) && canAfford
            const hasPriorityWindow = canCastInstants || (canCastSorceries && isLand)

            return (
              <button
                key={card.id}
                type="button"
                onClick={() => onCardTap(card)}
                className={`w-12 shrink-0 rounded-lg transition-all active:scale-95 ${
                  hasPriorityWindow
                    ? playable
                      ? 'ring-1 ring-amber-400/80 ring-offset-1 ring-offset-[#0C0E14]'
                      : 'opacity-40'
                    : ''
                }`}
              >
                <MotionCard
                  card={{ id: card.id, name: card.name, image_url: card.cards?.image_url, is_tapped: false, damage_marked: 0, zone: card.zone }}
                  size="board"
                  useLayoutId={false}
                />
              </button>
            )
          })}
          {handCards.length === 0 && (
            <p className="self-center text-[10px] text-slate-800">Hand empty</p>
          )}
        </div>

        {/* Fixed zone buttons */}
        <div className="flex shrink-0 flex-col items-center gap-1.5 border-l border-[#1E2230] px-2.5">
          {([
            { tab: 'graveyard' as MyZoneTab, label: 'GY', count: ownGraveyard.length, countCls: 'text-slate-400' },
            { tab: 'exile' as MyZoneTab,     label: 'EX', count: ownExile.length,     countCls: 'text-amber-500' },
          ]).map(({ tab, label, count, countCls }) => (
            <button
              key={tab}
              type="button"
              onClick={() => { setMyZoneTab(tab); setMyZoneOpen(true) }}
              className="flex w-full items-center justify-between gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 active:scale-95"
            >
              <span className="text-[9px] font-black text-slate-500">{label}</span>
              <span className={`text-[10px] font-black ${countCls}`}>{count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* My zones sheet */}
      <AnimatePresence>
        {myZoneOpen && (
          <MyZonesSheet
            graveyard={ownGraveyard}
            exile={ownExile}
            initialTab={myZoneTab}
            onClose={() => setMyZoneOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Opponent board overlay */}
      <AnimatePresence>
        {focusedOpponent && (
          <OpponentBoardOverlay
            supabase={supabase}
            sessionId={sessionId}
            opponent={focusedOpponent}
            cards={focusedOpponentCards}
            onClose={() => setFocusedOpponentId(null)}
          />
        )}
      </AnimatePresence>

      {/* Blocker damage-order sheet */}
      <AnimatePresence>
        {orderingAssignmentLive && (
          <BlockerOrderSheet
            assignment={orderingAssignmentLive}
            boardCards={boardCards}
            onConfirm={async (orderedIds, distribution) => {
              await onSetBlockerOrder(orderingAssignmentLive.id, orderedIds)
              onSetDamageAssignment(orderingAssignmentLive.attacker_card_id, distribution)
              setOrderingAssignment(null)
            }}
            onClose={() => setOrderingAssignment(null)}
          />
        )}
      </AnimatePresence>
      </div>
    </main>
  )
}

// ─── Priority Panel ───────────────────────────────────────────────────────────

function TargetedTriggerPrompt({
  pendingStackItems,
  boardCards,
  playerId,
  onChooseTarget,
  onChooseTargets,
}: {
  pendingStackItems: StackItem[]
  boardCards: BoardCard[]
  playerId: string | null
  onChooseTarget: (stackItemId: string, targetCardId: string) => Promise<void>
  onChooseTargets: (stackItemId: string, targetCardIds: string[]) => Promise<void>
}) {
  const [isPending, setIsPending] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const topItem = pendingStackItems.slice().sort((a, b) => b.position - a.position)[0] ?? null
  const targetCount = Math.max(1, Number(topItem?.payload?.target_count ?? 1))
  const alreadyChosen =
    Boolean(topItem?.payload?.target_card_id) ||
    (Array.isArray(topItem?.payload?.target_card_ids) && (topItem!.payload!.target_card_ids as unknown[]).length > 0)
  const needsMyTarget = Boolean(
    playerId &&
    topItem?.action_type === 'triggered_ability' &&
    topItem.controller_player_id === playerId &&
    topItem.payload?.target_required === true &&
    !alreadyChosen,
  )

  if (!topItem || !needsMyTarget) return null

  // The trigger's target_type (creature by default, or a permanent type like
  // artifact/enchantment) decides which board cards are offered.
  const triggerTargetType = topItem.payload?.target_type as string | string[] | undefined
  const targetableCreatures = boardCards.filter((c) => {
    if (!creatureMatchesController(c, playerId, topItem.payload?.target_controller as string | undefined)) {
      return false
    }
    return isCreatureOnlyTargetType(triggerTargetType)
      ? (c.type_line?.toLowerCase().includes('creature') ?? false)
      : cardMatchesTargetType(c.type_line, (triggerTargetType ?? 'permanent') as string | string[])
  })
  const multi = targetCount > 1
  const choose = async (targetCardId: string) => {
    setIsPending(true)
    try {
      await onChooseTarget(topItem.id, targetCardId)
    } finally {
      setIsPending(false)
    }
  }
  const toggle = (id: string) =>
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= targetCount) return prev
      return [...prev, id]
    })
  const confirmMulti = async () => {
    if (picked.length === 0) return
    setIsPending(true)
    try {
      await onChooseTargets(topItem.id, picked)
      setPicked([])
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="border-b border-emerald-500/20 bg-emerald-950/30 px-3 py-2">
      <div className="mb-2 min-w-0">
        <p className="truncate text-[11px] font-black uppercase tracking-widest text-emerald-300">
          {multi ? `Choose up to ${targetCount} targets (${picked.length})` : 'Choose trigger target'}
        </p>
        <p className="truncate text-[10px] text-slate-400">
          {topItem.source_card_name ?? 'Triggered ability'}
        </p>
      </div>
      {targetableCreatures.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto">
          {targetableCreatures.map((card) => {
            const chosen = picked.includes(card.id)
            return (
              <button
                key={card.id}
                type="button"
                disabled={isPending || (multi && !chosen && picked.length >= targetCount)}
                onClick={() => (multi ? toggle(card.id) : void choose(card.id))}
                className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-left transition active:scale-95 disabled:opacity-50 ${
                  chosen ? 'border-emerald-400 bg-emerald-400/30' : 'border-emerald-400/30 bg-emerald-400/10'
                }`}
              >
                <span className="max-w-28 truncate text-xs font-bold text-white">{chosen ? '✓ ' : ''}{card.name}</span>
                <span className="text-[10px] font-black text-emerald-300">{effectiveBoardPT(card)}</span>
              </button>
            )
          })}
          {multi && (
            <button
              type="button"
              disabled={isPending || picked.length === 0}
              onClick={() => { void confirmMulti() }}
              className="shrink-0 rounded-xl border border-emerald-400 bg-emerald-400/20 px-3 py-2 text-xs font-black text-white transition active:scale-95 disabled:opacity-40"
            >
              Confirm
            </button>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-slate-500">No legal targets remain. Passing priority will let it fizzle.</p>
      )}
    </div>
  )
}

// Action types whose creature-target variant routes through apply_creature_effect.
const CREATURE_TARGET_ACTION_TYPES = [
  'deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap', 'add_counters', 'pump',
]

function modalModeIsTargeted(mode: ModalModeOption): boolean {
  return (mode.actions ?? []).some(
    (a) => CREATURE_TARGET_ACTION_TYPES.includes(a.type ?? '') && targetTypeMatches(a.target_type, 'creature'),
  )
}

// The in-game prompt for a pending decision the current player must make:
// modal mode (+ creature target), scry, or surveil. Mirrors the engine's
// submit_decision result shapes.
function PendingDecisionPrompt({
  decision,
  boardCards,
  onSubmit,
}: {
  decision: PendingDecision
  boardCards: BoardCard[]
  onSubmit: (decisionId: string, result: Record<string, unknown>) => Promise<void>
}) {
  const [isPending, setIsPending] = useState(false)

  const submit = async (result: Record<string, unknown>) => {
    setIsPending(true)
    try {
      await onSubmit(decision.id, result)
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="border-b border-indigo-500/20 bg-indigo-950/30 px-3 py-2">
      <p className="mb-2 truncate text-[11px] font-black uppercase tracking-widest text-indigo-300">
        {decision.prompt ?? 'Make a choice'}
      </p>
      {decision.decision_type === 'choose_mode' ? (
        <ChooseModeBody decision={decision} boardCards={boardCards} isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'scry' || decision.decision_type === 'surveil' ? (
        <ScrySurveilBody decision={decision} surveil={decision.decision_type === 'surveil'} isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'search_library' || decision.decision_type === 'choose_cards' || decision.decision_type === 'sacrifice' || decision.decision_type === 'return_from_graveyard' ? (
        <CardPickBody decision={decision} isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'confirm' ? (
        <ConfirmBody isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'choose_player' ? (
        <ChoosePlayerBody decision={decision} isPending={isPending} onSubmit={submit} />
      ) : (
        <p className="text-[10px] text-slate-500">Unsupported decision: {decision.decision_type}</p>
      )}
    </div>
  )
}

function ChooseModeBody({
  decision,
  boardCards,
  isPending,
  onSubmit,
}: {
  decision: PendingDecision
  boardCards: BoardCard[]
  isPending: boolean
  onSubmit: (result: Record<string, unknown>) => Promise<void>
}) {
  const modes = (Array.isArray(decision.options) ? decision.options : []) as ModalModeOption[]
  const [selected, setSelected] = useState<number[]>([])
  const [target, setTarget] = useState<string | null>(null)

  const toggle = (idx: number) => {
    setSelected((prev) => {
      if (prev.includes(idx)) return prev.filter((i) => i !== idx)
      if (prev.length >= decision.max_choices) {
        return decision.max_choices === 1 ? [idx] : prev
      }
      return [...prev, idx]
    })
  }

  const needsTarget = selected.some((i) => modes[i] && modalModeIsTargeted(modes[i]))
  const creatures = boardCards.filter((c) => c.type_line?.toLowerCase().includes('creature'))
  const canConfirm =
    !isPending &&
    selected.length >= decision.min_choices &&
    selected.length <= decision.max_choices &&
    (!needsTarget || Boolean(target && creatures.some((c) => c.id === target)))

  const confirm = () => {
    const result: Record<string, unknown> = { chosen: selected }
    if (needsTarget && target) result.target_card_id = target
    void onSubmit(result)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        {modes.map((mode, idx) => {
          const on = selected.includes(idx)
          return (
            <button
              key={idx}
              type="button"
              disabled={isPending}
              onClick={() => toggle(idx)}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-bold transition active:scale-95 disabled:opacity-50 ${
                on
                  ? 'border-indigo-400 bg-indigo-400/20 text-white'
                  : 'border-indigo-400/30 bg-indigo-400/5 text-slate-200'
              }`}
            >
              <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${on ? 'border-indigo-300 bg-indigo-300 text-indigo-950' : 'border-slate-500'}`}>
                {on ? '✓' : ''}
              </span>
              <span className="truncate">{mode.label ?? `Mode ${idx + 1}`}</span>
            </button>
          )
        })}
      </div>

      {needsTarget && (
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-indigo-300">Choose a creature</p>
          {creatures.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto">
              {creatures.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={isPending}
                  onClick={() => setTarget(c.id)}
                  className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 transition active:scale-95 disabled:opacity-50 ${
                    target === c.id ? 'border-indigo-400 bg-indigo-400/20' : 'border-indigo-400/30 bg-indigo-400/5'
                  }`}
                >
                  <span className="max-w-28 truncate text-xs font-bold text-white">{c.name}</span>
                  <span className="text-[10px] font-black text-indigo-300">{effectiveBoardPT(c)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-slate-500">No creatures on the battlefield to target.</p>
          )}
        </div>
      )}

      <button
        type="button"
        disabled={!canConfirm}
        onClick={confirm}
        className="self-start rounded-xl bg-indigo-400 px-4 py-2 text-xs font-black uppercase tracking-wide text-indigo-950 transition active:scale-95 disabled:opacity-40"
      >
        Confirm
      </button>
    </div>
  )
}

function ScrySurveilBody({
  decision,
  surveil,
  isPending,
  onSubmit,
}: {
  decision: PendingDecision
  surveil: boolean
  isPending: boolean
  onSubmit: (result: Record<string, unknown>) => Promise<void>
}) {
  const cards = (Array.isArray(decision.options) ? decision.options : []) as ScryOption[]
  // 'top' = keep on top; 'away' = bottom of library (scry) / graveyard (surveil).
  const [placement, setPlacement] = useState<Record<string, 'top' | 'away'>>(() =>
    Object.fromEntries(cards.map((c) => [c.game_card_id, 'top'])),
  )
  const awayLabel = surveil ? 'Graveyard' : 'Bottom'

  const confirm = () => {
    const top = cards.filter((c) => placement[c.game_card_id] === 'top').map((c) => c.game_card_id)
    const away = cards.filter((c) => placement[c.game_card_id] === 'away').map((c) => c.game_card_id)
    void onSubmit(surveil ? { graveyard: away, top } : { top, bottom: away })
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-slate-400">Top of library is first. Choose where each card goes.</p>
      <div className="flex flex-col gap-1.5">
        {cards.map((c) => {
          const where = placement[c.game_card_id] ?? 'top'
          return (
            <div key={c.game_card_id} className="flex items-center gap-2 rounded-xl border border-indigo-400/20 bg-indigo-400/5 px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-bold text-white">{c.name}</span>
              <div className="flex shrink-0 overflow-hidden rounded-lg border border-indigo-400/30">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => setPlacement((p) => ({ ...p, [c.game_card_id]: 'top' }))}
                  className={`px-2.5 py-1 text-[10px] font-black uppercase ${where === 'top' ? 'bg-indigo-400 text-indigo-950' : 'text-slate-300'}`}
                >
                  Top
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => setPlacement((p) => ({ ...p, [c.game_card_id]: 'away' }))}
                  className={`px-2.5 py-1 text-[10px] font-black uppercase ${where === 'away' ? 'bg-indigo-400 text-indigo-950' : 'text-slate-300'}`}
                >
                  {awayLabel}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        disabled={isPending}
        onClick={confirm}
        className="self-start rounded-xl bg-indigo-400 px-4 py-2 text-xs font-black uppercase tracking-wide text-indigo-950 transition active:scale-95 disabled:opacity-40"
      >
        Confirm
      </button>
    </div>
  )
}

// Pick N cards from an offered list (tutor search_library / discard choose_cards).
function CardPickBody({
  decision,
  isPending,
  onSubmit,
}: {
  decision: PendingDecision
  isPending: boolean
  onSubmit: (result: Record<string, unknown>) => Promise<void>
}) {
  const cards = (Array.isArray(decision.options) ? decision.options : []) as { game_card_id: string; name: string }[]
  const [selected, setSelected] = useState<string[]>([])

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= decision.max_choices) {
        return decision.max_choices === 1 ? [id] : prev
      }
      return [...prev, id]
    })
  }

  const canConfirm = !isPending && selected.length >= decision.min_choices && selected.length <= decision.max_choices

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-slate-400">
        Choose {decision.min_choices === decision.max_choices ? decision.max_choices : `${decision.min_choices}–${decision.max_choices}`}.
      </p>
      <div className="flex flex-wrap gap-2">
        {cards.map((c) => {
          const on = selected.includes(c.game_card_id)
          return (
            <button
              key={c.game_card_id}
              type="button"
              disabled={isPending}
              onClick={() => toggle(c.game_card_id)}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold transition active:scale-95 disabled:opacity-50 ${
                on ? 'border-indigo-400 bg-indigo-400/20 text-white' : 'border-indigo-400/30 bg-indigo-400/5 text-slate-200'
              }`}
            >
              <span className="max-w-32 truncate">{c.name}</span>
            </button>
          )
        })}
      </div>
      <button
        type="button"
        disabled={!canConfirm}
        onClick={() => void onSubmit({ chosen: selected })}
        className="self-start rounded-xl bg-indigo-400 px-4 py-2 text-xs font-black uppercase tracking-wide text-indigo-950 transition active:scale-95 disabled:opacity-40"
      >
        Confirm{decision.min_choices === 0 ? ` (${selected.length})` : ''}
      </button>
    </div>
  )
}

// Optional "you may" — a yes/no gate.
function ConfirmBody({
  isPending,
  onSubmit,
}: {
  isPending: boolean
  onSubmit: (result: Record<string, unknown>) => Promise<void>
}) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() => void onSubmit({ confirmed: true })}
        className="rounded-xl bg-indigo-400 px-4 py-2 text-xs font-black uppercase tracking-wide text-indigo-950 transition active:scale-95 disabled:opacity-40"
      >
        Yes
      </button>
      <button
        type="button"
        disabled={isPending}
        onClick={() => void onSubmit({ confirmed: false })}
        className="rounded-xl border border-slate-600 px-4 py-2 text-xs font-black uppercase tracking-wide text-slate-300 transition active:scale-95 disabled:opacity-40"
      >
        No
      </button>
    </div>
  )
}

// Choose one player from the offered list.
function ChoosePlayerBody({
  decision,
  isPending,
  onSubmit,
}: {
  decision: PendingDecision
  isPending: boolean
  onSubmit: (result: Record<string, unknown>) => Promise<void>
}) {
  const players = (Array.isArray(decision.options) ? decision.options : []) as { player_id: string; username: string | null }[]
  return (
    <div className="flex flex-wrap gap-2">
      {players.map((p) => (
        <button
          key={p.player_id}
          type="button"
          disabled={isPending}
          onClick={() => void onSubmit({ player_id: p.player_id })}
          className="rounded-xl border border-indigo-400/30 bg-indigo-400/10 px-4 py-2 text-xs font-bold text-white transition active:scale-95 disabled:opacity-50"
        >
          {p.username ?? 'Player'}
        </button>
      ))}
    </div>
  )
}

function PriorityPanel({
  hasPriority,
  isSessionFinished,
  canResolveCombatDamage,
  combatDamageStage,
  blockPassReason,
  onResolveCombatDamage,
  onPassPriority,
}: {
  hasPriority: boolean
  isSessionFinished: boolean
  canResolveCombatDamage: boolean
  combatDamageStage: string | null
  blockPassReason?: string | null
  onResolveCombatDamage: () => Promise<void>
  onPassPriority: () => Promise<void>
}) {
  const [isPending, setIsPending] = useState(false)
  const canPass = hasPriority && !isSessionFinished && !blockPassReason

  const run = async (fn: () => Promise<void>) => {
    setIsPending(true)
    try { await fn() } finally { setIsPending(false) }
  }

  // After a first-strike pass has resolved, the next click resolves the regular pass
  const resolveLabel = combatDamageStage === 'first_strike' ? 'Regular' : 'Damage'

  return (
    <aside className="flex w-20 shrink-0 flex-col items-center gap-3 border-l border-[#1E2230] bg-[#0C0E14] px-2 py-4">
      {canResolveCombatDamage ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(onResolveCombatDamage)}
          className="flex h-[72px] w-full flex-col items-center justify-center gap-0.5 rounded-2xl bg-[#D4591A] text-white transition active:scale-95 disabled:opacity-50"
        >
          <span className="text-xs font-black uppercase leading-tight tracking-wide">Resolve</span>
          <span className="text-[9px] font-semibold opacity-80">{resolveLabel}</span>
        </button>
      ) : canPass ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(onPassPriority)}
          className="flex h-[72px] w-full flex-col items-center justify-center gap-0.5 rounded-2xl bg-amber-400 text-amber-950 transition active:scale-95 disabled:opacity-50"
        >
          <span className="text-sm font-black uppercase tracking-wide">Pass</span>
          <span className="text-[9px] font-semibold opacity-70">Priority</span>
        </button>
      ) : (
        <div className="flex h-[72px] w-full flex-col items-center justify-center gap-1 rounded-2xl border border-[#1E2230]">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-700">
            {blockPassReason && blockPassReason !== 'Waiting for a decision' ? 'Act' : 'Wait'}
          </span>
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-800" />
        </div>
      )}

      <div className="mt-auto flex flex-col items-center gap-1">
        <div
          className={`h-2 w-2 rounded-full transition-colors ${
            hasPriority ? 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.7)]' : 'bg-slate-800'
          }`}
        />
        <span className="text-[7px] text-slate-700">{hasPriority ? '→ YOU' : '...'}</span>
      </div>
    </aside>
  )
}

// ─── Card Action Sheet ────────────────────────────────────────────────────────

function CardActionSheet({
  card,
  canCastSorceries,
  canCastInstants,
  pendingStackCount,
  players,
  playerId,
  pendingStackItems,
  boardCards,
  onTapForMana,
  onCastCard,
  onDealDamageToPlayer,
  onDealDamageToCreature,
  onPumpCreature,
  onAddCountersCreature,
  onCreatureEffect,
  onMultiCreatureEffect,
  onPermanentEffect,
  onDividedDamage,
  onFight,
  onDrawCards,
  onSpellEffect,
  onModalSpell,
  onCounterSpell,
  onActivateAbility,
  onClose,
}: {
  card: ControllerCard
  canCastSorceries: boolean
  canCastInstants: boolean
  pendingStackCount: number
  players: GameSessionPlayer[]
  playerId: string | null
  pendingStackItems: StackItem[]
  boardCards: BoardCard[]
  onTapForMana: (cardId: string, color?: ManaColor) => Promise<void>
  onCastCard: (cardId: string) => Promise<void>
  onDealDamageToPlayer: (cardId: string, targetPlayerId: string) => Promise<void>
  onDealDamageToCreature: (cardId: string, targetCardId: string) => Promise<void>
  onPumpCreature: (cardId: string, targetCardId: string) => Promise<void>
  onAddCountersCreature: (cardId: string, targetCardId: string) => Promise<void>
  onCreatureEffect: (cardId: string, targetCardId: string) => Promise<void>
  onMultiCreatureEffect: (cardId: string, targetCardIds: string[]) => Promise<void>
  onPermanentEffect: (cardId: string, targetCardId: string) => Promise<void>
  onDividedDamage: (cardId: string, allocations: DamageAllocation[]) => Promise<void>
  onFight: (cardId: string, fighterCardId: string, foughtCardId: string) => Promise<void>
  onDrawCards: (cardId: string) => Promise<void>
  onSpellEffect: (cardId: string) => Promise<void>
  onModalSpell: (cardId: string) => Promise<void>
  onCounterSpell: (cardId: string, stackItemId: string) => Promise<void>
  onActivateAbility: (
    sourceId: string,
    abilityIndex: number,
    target?: { targetCardId?: string | null; targetPlayerId?: string | null },
  ) => Promise<void>
  onClose: () => void
}) {
  const script = normalizeCardBehaviorToV2(
    card.copied_script ?? card.cards?.script ?? null,
    card.cards?.type_line,
  )
  const zone = card.zone
  const abilityAvailableInZone = (req?: string | null) =>
    !req || req === 'any' || req === zone

  const manaAbilities =
    script.activated_abilities?.filter(
      (a) => a.is_mana_ability && abilityAvailableInZone(a.source_zone_required),
    ) ?? []
  // Keep the original index so activate_ability can address the ability server-side.
  const otherAbilities = (script.activated_abilities ?? [])
    .map((ability, index) => ({ ability, index }))
    .filter(({ ability }) => !ability.is_mana_ability && abilityAvailableInZone(ability.source_zone_required))
  const pt = getPowerToughnessLabel(card)
  const imageUrl = card.cards?.image_url
  const [zoomed, setZoomed] = useState(false)
  // 'target' = showing the target picker for a targeted spell
  const [picking, setPicking] = useState(false)
  // Fight is a two-step pick: the chosen fighter (a creature you control), then
  // the fought creature. null = still choosing the fighter.
  const [fightFighterId, setFightFighterId] = useState<string | null>(null)
  // Multi-target removal: the set of creatures chosen so far (toggle to add/remove,
  // capped at the plan's count, then confirm).
  const [multiTargets, setMultiTargets] = useState<string[]>([])
  // Divided damage: how much is allocated to each target so far, keyed by 'card:<id>'
  // / 'player:<id>'. Cast is enabled once the allocations sum to the spell's amount.
  const [dmgAlloc, setDmgAlloc] = useState<Record<string, number>>({})
  // When set, showing the target picker for an activated ability.
  const [abilityPick, setAbilityPick] = useState<
    { index: number; type: string; amount: number; canTargetPlayer: boolean; canTargetCreature: boolean } | null
  >(null)

  const spellPlan = getSpellPlan(card)
  // Controller restriction for the chosen creature target ("an opponent controls"
  // / "you control"), relative to the caster. Defaults to any for untargeted plans.
  const spellTargetController: TargetController =
    spellPlan.kind === 'damage' ||
    spellPlan.kind === 'pump' ||
    spellPlan.kind === 'add_counters' ||
    spellPlan.kind === 'creature_effect' ||
    spellPlan.kind === 'multi_creature' ||
    spellPlan.kind === 'divided_damage'
      ? spellPlan.targetController
      : 'any'
  const targetableCreatures = boardCards.filter(
    (c) =>
      c.type_line?.toLowerCase().includes('creature') &&
      creatureMatchesController(c, playerId, spellTargetController),
  )
  // Permanent targets for a permanent_effect spell: any board card whose type line
  // matches the effect's target_type, under the same controller restriction.
  const targetablePermanents =
    spellPlan.kind === 'permanent_effect'
      ? boardCards.filter(
          (c) =>
            cardMatchesTargetType(c.type_line, spellPlan.targetType) &&
            creatureMatchesController(c, playerId, spellPlan.targetController),
        )
      : []
  const hasPermanentTargets = targetablePermanents.length > 0
  // Fight target lists: the fighter is a creature you control; the fought creature
  // matches the action's controller restriction and can't be the fighter itself.
  const isCreature = (c: BoardCard) => c.type_line?.toLowerCase().includes('creature') ?? false
  const fightFighters = boardCards.filter((c) => isCreature(c) && c.controller_player_id === playerId)
  const fightFoughtFor = (fighterId: string | null) =>
    boardCards.filter(
      (c) =>
        isCreature(c) &&
        c.id !== fighterId &&
        creatureMatchesController(c, playerId, spellPlan.kind === 'fight' ? spellPlan.foughtController : 'any'),
    )
  const hasFightTargets = fightFighters.some((f) => fightFoughtFor(f.id).length > 0)
  const canCast = canCastHandSpell(card, canCastSorceries, canCastInstants, pendingStackCount)
  const hasCreatureTargets = targetableCreatures.length > 0
  const requiresCreatureTarget =
    spellPlan.kind === 'pump' ||
    spellPlan.kind === 'add_counters' ||
    spellPlan.kind === 'creature_effect' ||
    spellPlan.kind === 'multi_creature' ||
    spellPlan.kind === 'fight' ||
    (spellPlan.kind === 'damage' && spellPlan.canTargetCreature && !spellPlan.canTargetPlayer)
  const requiresStackTarget = spellPlan.kind === 'counterspell'
  const requiresPermanentTarget = spellPlan.kind === 'permanent_effect'
  const hasRequiredTargets =
    (!requiresCreatureTarget ||
      (spellPlan.kind === 'fight' ? hasFightTargets : hasCreatureTargets)) &&
    (!requiresPermanentTarget || hasPermanentTargets) &&
    (!requiresStackTarget || pendingStackItems.length > 0)
  const needsTarget =
    hasRequiredTargets &&
    canCast &&
    ((spellPlan.kind === 'damage' && (spellPlan.canTargetPlayer || (spellPlan.canTargetCreature && hasCreatureTargets))) ||
      (spellPlan.kind === 'pump' && hasCreatureTargets) ||
      (spellPlan.kind === 'add_counters' && hasCreatureTargets) ||
      (spellPlan.kind === 'creature_effect' && hasCreatureTargets) ||
      (spellPlan.kind === 'multi_creature' && hasCreatureTargets) ||
      (spellPlan.kind === 'permanent_effect' && hasPermanentTargets) ||
      (spellPlan.kind === 'divided_damage' && (spellPlan.canTargetPlayer || hasCreatureTargets)) ||
      (spellPlan.kind === 'fight' && hasFightTargets) ||
      (spellPlan.kind === 'counterspell' && pendingStackItems.length > 0))
  const castLabel = !hasRequiredTargets
    ? requiresCreatureTarget
      ? 'No creature targets'
      : requiresPermanentTarget
        ? 'No permanent targets'
        : 'No stack targets'
    : needsTarget
      ? 'Cast - choose target'
      : 'Cast'

  const handleCast = () => {
    if (!hasRequiredTargets) return

    if (needsTarget) {
      setPicking(true)
    } else if (spellPlan.kind === 'draw') {
      void onDrawCards(card.id)
      onClose()
    } else if (spellPlan.kind === 'spell_effect') {
      void onSpellEffect(card.id)
      onClose()
    } else if (spellPlan.kind === 'modal') {
      void onModalSpell(card.id)
      onClose()
    } else {
      void onCastCard(card.id)
      onClose()
    }
  }

  const hasActions = canCast || manaAbilities.length > 0 || otherAbilities.length > 0

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-40 bg-black/60"
        onClick={onClose}
      />

      {/* Sheet */}
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        className="absolute inset-x-0 bottom-0 z-50 rounded-t-3xl border-t border-white/10 bg-[#181C28] px-4 pb-6 pt-4"
      >
        {/* Drag handle */}
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/15" />

        {/* Card header */}
        <div className="mb-5 flex items-center gap-3">
          {imageUrl && (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              className="h-[68px] w-[49px] shrink-0 overflow-hidden rounded-lg shadow-lg active:scale-95 transition-transform"
            >
              <img src={imageUrl} alt={card.name} className="h-full w-full object-cover object-top" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-black text-white">{card.name}</p>
            <p className="truncate text-[11px] text-slate-400">{card.cards?.type_line ?? card.zone}</p>
            {card.cards?.mana_cost && (
              <div className="mt-1">
                <ManaCostDisplay manaCost={card.cards.mana_cost} />
              </div>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {card.cards?.is_token && (
                <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-purple-300">
                  Token
                </span>
              )}
              <KeywordBadges keywords={getCardKeywords(card)} />
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {pt && (
              <span
                className={`rounded-lg px-2.5 py-1 text-sm font-black ${
                  (card.plus_one_counters ?? 0) > 0 ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-white'
                }`}
              >
                {getEffectivePT(card)}
              </span>
            )}
            {(card.plus_one_counters ?? 0) > 0 && (
              <span className="text-[9px] font-bold text-emerald-400">
                +{card.plus_one_counters} counter{card.plus_one_counters! > 1 ? 's' : ''}
              </span>
            )}
            {((card.pump_power ?? 0) !== 0 || (card.pump_toughness ?? 0) !== 0) && (
              <span className="text-[9px] font-bold text-sky-400">
                +{card.pump_power ?? 0}/+{card.pump_toughness ?? 0} until EOT
              </span>
            )}
            {card.damage_marked > 0 && (
              <span className="text-[10px] font-bold text-red-400">{card.damage_marked} dmg</span>
            )}
            {card.is_tapped && (
              <span className="text-[10px] font-bold text-amber-500/70">Tapped</span>
            )}
          </div>
        </div>

        {/* Cast button (hand cards) */}
        {canCast && !picking && (
          <button
            type="button"
            aria-label={castLabel}
            disabled={!hasRequiredTargets}
            onClick={handleCast}
            className={`mb-3 flex w-full items-center justify-between rounded-2xl px-4 py-3.5 transition active:scale-95 ${
              hasRequiredTargets ? 'bg-amber-400' : 'cursor-not-allowed bg-slate-700 opacity-70'
            }`}
          >
            <span className={`font-black ${hasRequiredTargets ? 'text-amber-950' : 'text-slate-300'}`}>
              {castLabel}
            </span>
            <ManaCostDisplay manaCost={card.cards?.mana_cost} dark={hasRequiredTargets} />
          </button>
        )}

        {/* Target picker */}
        {picking && spellPlan.kind === 'damage' && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              Deal {spellPlan.amount} damage to
            </p>
            {spellPlan.canTargetPlayer && players.map((p) => (
              <button
                key={p.player_id}
                type="button"
                onClick={() => { void onDealDamageToPlayer(card.id, p.player_id); onClose() }}
                className="flex w-full items-center justify-between rounded-2xl border border-[#D4591A]/40 bg-[#D4591A]/10 px-4 py-3 transition active:scale-95"
              >
                <span className="font-bold text-white">
                  {p.username ?? `Player ${p.seat_number}`}
                  {p.player_id === playerId && <span className="ml-1 text-[10px] text-slate-500">(you)</span>}
                </span>
                <span className="text-sm font-black text-[#D4591A]">♥{p.life_total} → {Math.max(0, p.life_total - spellPlan.amount)}</span>
              </button>
            ))}
            {spellPlan.canTargetCreature && targetableCreatures.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { void onDealDamageToCreature(card.id, c.id); onClose() }}
                className="flex w-full items-center justify-between rounded-2xl border border-[#D4591A]/40 bg-[#D4591A]/10 px-4 py-2.5 transition active:scale-95"
              >
                <span className="truncate font-bold text-white">{c.name}</span>
                <span className="ml-2 shrink-0 text-xs font-black text-slate-300">
                  {effectiveBoardPT(c)}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
            >
              Back
            </button>
          </div>
        )}

        {picking && spellPlan.kind === 'divided_damage' && (() => {
          const allocated = Object.values(dmgAlloc).reduce((sum, n) => sum + n, 0)
          const remaining = spellPlan.amount - allocated
          const bump = (key: string, delta: number) =>
            setDmgAlloc((prev) => {
              const next = Math.max(0, (prev[key] ?? 0) + delta)
              if (delta > 0 && remaining <= 0) return prev
              return { ...prev, [key]: next }
            })
          const row = (key: string, name: string, sub: string) => (
            <div key={key} className="flex items-center justify-between rounded-2xl border border-[#D4591A]/40 bg-[#D4591A]/10 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-bold text-white">{name}<span className="ml-1 text-[10px] text-slate-400">{sub}</span></span>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={() => bump(key, -1)} disabled={(dmgAlloc[key] ?? 0) === 0} className="h-7 w-7 rounded-lg border border-white/10 text-sm font-black text-white disabled:opacity-30 active:scale-90">−</button>
                <span className="w-5 text-center text-sm font-black text-[#D4591A]">{dmgAlloc[key] ?? 0}</span>
                <button type="button" onClick={() => bump(key, 1)} disabled={remaining <= 0} className="h-7 w-7 rounded-lg border border-white/10 text-sm font-black text-white disabled:opacity-30 active:scale-90">+</button>
              </div>
            </div>
          )
          const cast = () => {
            const allocations: DamageAllocation[] = Object.entries(dmgAlloc)
              .filter(([, n]) => n > 0)
              .map(([key, n]) =>
                key.startsWith('player:')
                  ? { target_player_id: key.slice('player:'.length), amount: n }
                  : { target_card_id: key.slice('card:'.length), amount: n },
              )
            void onDividedDamage(card.id, allocations)
            setDmgAlloc({})
            onClose()
          }
          return (
            <div className="mb-3 space-y-2">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                Divide {spellPlan.amount} damage — {remaining} left
              </p>
              {spellPlan.canTargetPlayer && players.map((p) => row(`player:${p.player_id}`, p.username ?? `Player ${p.seat_number}`, p.player_id === playerId ? '(you)' : `♥${p.life_total}`))}
              {spellPlan.canTargetCreature && targetableCreatures.map((c) => row(`card:${c.id}`, c.name, effectiveBoardPT(c)))}
              <button
                type="button"
                disabled={remaining !== 0}
                onClick={cast}
                className="w-full rounded-2xl border border-[#D4591A] bg-[#D4591A]/20 py-2.5 text-sm font-black text-white transition active:scale-95 disabled:opacity-40"
              >
                Deal damage
              </button>
              <button
                type="button"
                onClick={() => { setDmgAlloc({}); setPicking(false) }}
                className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
              >
                Back
              </button>
            </div>
          )
        })()}

        {picking && spellPlan.kind === 'pump' && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              Give +{spellPlan.power}/+{spellPlan.toughness} to
            </p>
            {targetableCreatures.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { void onPumpCreature(card.id, c.id); onClose() }}
                className="flex w-full items-center justify-between rounded-2xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-2.5 transition active:scale-95"
              >
                <span className="truncate font-bold text-white">{c.name}</span>
                <span className="ml-2 shrink-0 text-xs font-black text-emerald-300">{effectiveBoardPT(c)}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
            >
              Back
            </button>
          </div>
        )}

        {picking && spellPlan.kind === 'creature_effect' && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              {spellPlan.label} which creature?
            </p>
            {targetableCreatures.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { void onCreatureEffect(card.id, c.id); onClose() }}
                className="flex w-full items-center justify-between rounded-2xl border border-violet-400/40 bg-violet-400/10 px-4 py-2.5 transition active:scale-95"
              >
                <span className="truncate font-bold text-white">{c.name}</span>
                <span className="ml-2 shrink-0 text-xs font-black text-violet-300">{effectiveBoardPT(c)}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
            >
              Back
            </button>
          </div>
        )}

        {picking && spellPlan.kind === 'permanent_effect' && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              {spellPlan.label} which permanent?
            </p>
            {targetablePermanents.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { void onPermanentEffect(card.id, c.id); onClose() }}
                className="flex w-full items-center justify-between rounded-2xl border border-amber-400/40 bg-amber-400/10 px-4 py-2.5 transition active:scale-95"
              >
                <span className="truncate font-bold text-white">{c.name}</span>
                <span className="ml-2 shrink-0 text-[10px] font-bold uppercase text-amber-300/80">{c.type_line}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
            >
              Back
            </button>
          </div>
        )}

        {picking && spellPlan.kind === 'multi_creature' && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              {spellPlan.label} up to {spellPlan.count} — {multiTargets.length}/{spellPlan.count} chosen
            </p>
            {targetableCreatures.map((c) => {
              const chosen = multiTargets.includes(c.id)
              const atCap = multiTargets.length >= spellPlan.count
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={!chosen && atCap}
                  onClick={() =>
                    setMultiTargets((prev) =>
                      prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id],
                    )
                  }
                  className={`flex w-full items-center justify-between rounded-2xl border px-4 py-2.5 transition active:scale-95 ${
                    chosen
                      ? 'border-violet-400 bg-violet-400/30'
                      : atCap
                        ? 'border-white/5 bg-white/5 opacity-40'
                        : 'border-violet-400/40 bg-violet-400/10'
                  }`}
                >
                  <span className="truncate font-bold text-white">
                    {chosen ? '✓ ' : ''}
                    {c.name}
                  </span>
                  <span className="ml-2 shrink-0 text-xs font-black text-violet-300">{effectiveBoardPT(c)}</span>
                </button>
              )
            })}
            <button
              type="button"
              disabled={multiTargets.length === 0}
              onClick={() => { void onMultiCreatureEffect(card.id, multiTargets); setMultiTargets([]); onClose() }}
              className="w-full rounded-2xl border border-violet-400 bg-violet-400/20 py-2.5 text-sm font-black text-white transition active:scale-95 disabled:opacity-40"
            >
              {spellPlan.label} {multiTargets.length || ''}
            </button>
            <button
              type="button"
              onClick={() => { setMultiTargets([]); setPicking(false) }}
              className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
            >
              Back
            </button>
          </div>
        )}

        {picking && spellPlan.kind === 'fight' && (
          <div className="mb-3 space-y-2">
            {fightFighterId === null ? (
              <>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                  Your creature that fights
                </p>
                {fightFighters.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setFightFighterId(c.id)}
                    className="flex w-full items-center justify-between rounded-2xl border border-rose-400/40 bg-rose-400/10 px-4 py-2.5 transition active:scale-95"
                  >
                    <span className="truncate font-bold text-white">{c.name}</span>
                    <span className="ml-2 shrink-0 text-xs font-black text-rose-300">{effectiveBoardPT(c)}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPicking(false)}
                  className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
                >
                  Back
                </button>
              </>
            ) : (
              <>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                  Fights which creature?
                </p>
                {fightFoughtFor(fightFighterId).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { void onFight(card.id, fightFighterId, c.id); onClose() }}
                    className="flex w-full items-center justify-between rounded-2xl border border-rose-400/40 bg-rose-400/10 px-4 py-2.5 transition active:scale-95"
                  >
                    <span className="truncate font-bold text-white">{c.name}</span>
                    <span className="ml-2 shrink-0 text-xs font-black text-rose-300">{effectiveBoardPT(c)}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setFightFighterId(null)}
                  className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
                >
                  Back
                </button>
              </>
            )}
          </div>
        )}

        {picking && spellPlan.kind === 'add_counters' && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              Put {spellPlan.amount} +1/+1 counter{spellPlan.amount === 1 ? '' : 's'} on
            </p>
            {targetableCreatures.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { void onAddCountersCreature(card.id, c.id); onClose() }}
                className="flex w-full items-center justify-between rounded-2xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-2.5 transition active:scale-95"
              >
                <span className="truncate font-bold text-white">{c.name}</span>
                <span className="ml-2 shrink-0 text-xs font-black text-emerald-300">{effectiveBoardPT(c)}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
            >
              Back
            </button>
          </div>
        )}

        {picking && spellPlan.kind === 'counterspell' && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Counter which spell?</p>
            {pendingStackItems
              .slice()
              .sort((a, b) => b.position - a.position)
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { void onCounterSpell(card.id, item.id); onClose() }}
                  className="flex w-full items-center justify-between rounded-2xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-3 transition active:scale-95"
                >
                  <span className="font-bold text-white">{item.source_card_name ?? item.action_type}</span>
                  <span className="text-[10px] text-slate-400">{item.controller_username ?? ''}</span>
                </button>
              ))}
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
            >
              Back
            </button>
          </div>
        )}

        {/* Mana abilities (battlefield) */}
        {manaAbilities.length > 0 && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            {manaAbilities.flatMap((ability, i) => {
              const addManaEffects = ability.effects.filter(isAddManaBehaviorAction)
              const hasTapCost = ability.costs.some((c) => c.type === 'tap_self')
              const isUnavailable = hasTapCost && card.is_tapped
              return addManaEffects.map((effect) => (
                <button
                  key={`${i}-${effect.color}`}
                  type="button"
                  disabled={isUnavailable}
                  onClick={() => { void onTapForMana(card.id, effect.color); onClose() }}
                  className={`flex items-center gap-2.5 rounded-2xl border px-3 py-3 transition active:scale-95 ${
                    isUnavailable
                      ? 'border-white/5 bg-[#0F1117] opacity-30'
                      : 'border-white/10 bg-[#0F1117] hover:border-white/20'
                  }`}
                >
                  {hasTapCost && (
                    <span className="shrink-0 text-[9px] font-black text-slate-600">{'{T}'}</span>
                  )}
                  <ManaSymbol color={effect.color} size="md" />
                  <span className="text-sm font-bold text-white">Add {effect.color}</span>
                </button>
              ))
            })}
          </div>
        )}

        {/* Non-mana activated abilities */}
        {otherAbilities.length > 0 && !picking && !abilityPick && (
          <div className="space-y-1.5">
            <p className="mb-1 text-[9px] uppercase tracking-widest text-slate-700">Abilities</p>
            {otherAbilities.map(({ ability, index }) => {
              const eff = getAbilityEffect(ability.effects)
              const hasTap = ability.costs.some((c) => c.type === 'tap_self')
              const supported = Boolean(eff)
              const targetAvailable = Boolean(
                eff && (!eff.needsTarget || eff.canTargetPlayer || (eff.canTargetCreature && targetableCreatures.length > 0)),
              )
              const available = supported && canCastInstants && (!hasTap || !card.is_tapped) && targetAvailable
              return (
                <button
                  key={index}
                  type="button"
                  disabled={!available}
                  onClick={() => {
                    if (!eff) return
                    if (eff.needsTarget) {
                      setAbilityPick({ index, type: eff.type, amount: eff.amount, canTargetPlayer: eff.canTargetPlayer, canTargetCreature: eff.canTargetCreature })
                    } else {
                      void onActivateAbility(card.id, index)
                      onClose()
                    }
                  }}
                  className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 transition active:scale-95 ${
                    available ? 'border-white/15 bg-[#0F1117]' : 'border-white/5 bg-[#0F1117]/60 opacity-50'
                  }`}
                >
                  <span className="shrink-0 text-[11px] font-bold text-white">{renderAbilityCost(ability.costs)}</span>
                  <span className="text-[10px] text-slate-400">{renderAbilityEffect(ability.effects)}</span>
                  {!supported && <span className="ml-auto shrink-0 text-[9px] text-slate-700">Soon</span>}
                  {supported && hasTap && card.is_tapped && (
                    <span className="ml-auto shrink-0 text-[9px] text-amber-500/70">Tapped</span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* Activated ability target picker */}
        {abilityPick && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              {abilityPick.type === 'deal_damage'
                ? `Deal ${abilityPick.amount} damage to`
                : `${ABILITY_VERB[abilityPick.type] ?? 'Affect'} which target?`}
            </p>
            {abilityPick.canTargetPlayer && players.map((p) => (
              <button
                key={p.player_id}
                type="button"
                onClick={() => { void onActivateAbility(card.id, abilityPick.index, { targetPlayerId: p.player_id }); onClose() }}
                className="flex w-full items-center justify-between rounded-2xl border border-[#D4591A]/40 bg-[#D4591A]/10 px-4 py-3 transition active:scale-95"
              >
                <span className="font-bold text-white">
                  {p.username ?? `Player ${p.seat_number}`}
                  {p.player_id === playerId && <span className="ml-1 text-[10px] text-slate-500">(you)</span>}
                </span>
                <span className="text-sm font-black text-[#D4591A]">♥{p.life_total} → {Math.max(0, p.life_total - abilityPick.amount)}</span>
              </button>
            ))}
            {abilityPick.canTargetCreature && targetableCreatures.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { void onActivateAbility(card.id, abilityPick.index, { targetCardId: c.id }); onClose() }}
                className="flex w-full items-center justify-between rounded-2xl border border-[#D4591A]/40 bg-[#D4591A]/10 px-4 py-2.5 transition active:scale-95"
              >
                <span className="truncate font-bold text-white">{c.name}</span>
                <span className="ml-2 shrink-0 text-xs font-black text-slate-300">{effectiveBoardPT(c)}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setAbilityPick(null)}
              className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
            >
              Back
            </button>
          </div>
        )}

        {!hasActions && (
          <p className="py-2 text-center text-sm text-slate-700">No actions available</p>
        )}
      </motion.div>

      {/* Card zoom overlay */}
      <AnimatePresence>
        {zoomed && imageUrl && (
          <CardZoomOverlay
            card={card}
            onClose={() => setZoomed(false)}
          />
        )}
      </AnimatePresence>
    </>
  )
}

// ─── Card Zoom Overlay ────────────────────────────────────────────────────────

function CardZoomOverlay({ card, onClose }: { card: ControllerCard; onClose: () => void }) {
  const imageUrl = card.cards?.image_url
  const oracleText = card.cards?.oracle_text
  const pt = getPowerToughnessLabel(card)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[55] flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        className="relative flex max-h-[92svh] w-[min(94vw,640px)] items-stretch gap-3 rounded-2xl border border-white/10 bg-[#0D1018] p-3 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Card image — bounded by viewport height, keeps MTG aspect */}
        {imageUrl && (
          <img
            src={imageUrl}
            alt={card.name}
            className="max-h-[84svh] w-auto shrink-0 self-center rounded-lg object-contain"
          />
        )}

        {/* Text column — scrolls if long */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto py-1 pr-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-black text-white">{card.name}</p>
              <p className="text-[11px] text-slate-400">{card.cards?.type_line}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {pt && (
                <span
                  className={`rounded-lg px-2 py-1 text-sm font-black text-white ${
                    (card.plus_one_counters ?? 0) > 0 ? 'bg-emerald-600' : 'bg-slate-700'
                  }`}
                >
                  {getEffectivePT(card)}
                </span>
              )}
              {card.cards?.mana_cost && (
                <ManaCostDisplay manaCost={card.cards.mana_cost} />
              )}
            </div>
          </div>

          <KeywordBadges keywords={getCardKeywords(card)} />

          {oracleText && (
            <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-line">{oracleText}</p>
          )}

          {card.damage_marked > 0 && (
            <p className="text-xs font-bold text-red-400">{card.damage_marked} damage marked</p>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white/70 active:scale-95"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>
      </motion.div>
    </motion.div>
  )
}

// ─── Mana Display Components ──────────────────────────────────────────────────

function ManaSymbol({ color, size = 'sm' }: { color: string; size?: 'sm' | 'md' }) {
  const style = manaColorStyles[color as ManaColor] ?? { bg: 'bg-slate-600', text: 'text-slate-400', dot: 'bg-slate-600' }
  const sizeClass = size === 'md' ? 'h-7 w-7 text-[11px]' : 'h-5 w-5 text-[9px]'
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-black text-black ${style.bg} ${sizeClass}`}
    >
      {color}
    </span>
  )
}

function KeywordBadges({ keywords }: { keywords: string[] }) {
  if (keywords.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {keywords.map((k) => (
        <span
          key={k}
          className="rounded bg-white/10 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-slate-300"
        >
          {KEYWORD_LABELS[k] ?? k}
        </span>
      ))}
    </div>
  )
}

function ManaCostDisplay({ manaCost, dark }: { manaCost?: string | null; dark?: boolean }) {
  if (!manaCost) return null
  const parsed = parseManaCost(manaCost)
  const pips: React.ReactNode[] = []

  if (parsed.generic > 0) {
    pips.push(
      <span
        key="generic"
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-black ${
          dark ? 'bg-amber-800 text-amber-100' : 'bg-slate-700 text-white'
        }`}
      >
        {parsed.generic}
      </span>,
    )
  }

  for (const [color, count] of Object.entries(parsed.colored)) {
    for (let i = 0; i < count; i++) {
      pips.push(<ManaSymbol key={`${color}-${i}`} color={color} />)
    }
  }

  return <div className="flex items-center gap-1">{pips}</div>
}

function ManaPoolDisplay({ manaPool }: { manaPool: ManaPool }) {
  return (
    <div className="flex items-center gap-1">
      {manaColors.map((c) => {
        const amount = manaPool[c] ?? 0
        return (
          <span key={c} className="flex items-center gap-0.5">
            <span
              className={`h-1.5 w-1.5 rounded-full transition-opacity ${manaColorStyles[c].dot} ${
                amount > 0 ? 'opacity-100' : 'opacity-20'
              }`}
            />
            {amount > 0 && (
              <span className={`text-[9px] font-black leading-none ${manaColorStyles[c].text}`}>
                {amount}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}

// ─── Combat Damage Strip ─────────────────────────────────────────────────────

function CombatDamageStrip({
  assignments,
  boardCards,
  canOrderBlockers,
  onOrderBlockers,
}: {
  assignments: CombatAssignment[]
  boardCards: BoardCard[]
  canOrderBlockers: boolean
  onOrderBlockers: (assignment: CombatAssignment) => void
}) {
  return (
    <div className="shrink-0 border-b border-[#D4591A]/30 bg-[#120905]/60">
      <div className="flex items-center gap-1 px-3 py-1">
        <span className="shrink-0 text-[8px] font-black uppercase tracking-widest text-[#D4591A]">
          Combat
        </span>
        {canOrderBlockers && assignments.some((a) => (a.blockers?.length ?? 0) >= 2) && (
          <span className="text-[8px] text-slate-500">· tap ⇅ to order blockers</span>
        )}
      </div>
      <div className="flex items-center gap-3 overflow-x-auto px-3 pb-2">
        {assignments.map((a) => {
          const attackerCard = boardCards.find((c) => c.id === a.attacker_card_id)
          const blockers =
            a.blockers && a.blockers.length > 0
              ? a.blockers
              : a.blocker_card_id
                ? [{ id: a.blocker_card_id, blocker_card_id: a.blocker_card_id, blocker_name: a.blocker_name ?? 'Blocker' }]
                : []
          const canOrderThis = canOrderBlockers && blockers.length >= 2
          return (
            <div key={a.id} className="flex shrink-0 items-center gap-1.5">
              <div className="w-7">
                <MotionCard
                  card={{ id: a.attacker_card_id, name: a.attacker_name ?? 'Attacker', image_url: attackerCard?.image_url, is_tapped: true, damage_marked: 0, zone: 'battlefield' }}
                  size="board" useLayoutId={false} className="w-full"
                />
              </div>
              <span className="text-[10px] text-[#D4591A]">→</span>
              {blockers.length > 0 ? (
                <button
                  type="button"
                  disabled={!canOrderThis}
                  onClick={() => canOrderThis && onOrderBlockers(a)}
                  className={`flex items-center gap-1 rounded-lg ${
                    canOrderThis ? 'border border-[#D4591A]/40 bg-[#D4591A]/10 px-1.5 py-1 active:scale-95' : ''
                  }`}
                >
                  {blockers.map((b) => {
                    const blockerCard = boardCards.find((c) => c.id === b.blocker_card_id)
                    return (
                      <div key={b.id} className="w-7">
                        <MotionCard
                          card={{ id: b.blocker_card_id, name: b.blocker_name ?? 'Blocker', image_url: blockerCard?.image_url, is_tapped: false, damage_marked: 0, zone: 'battlefield' }}
                          size="board" useLayoutId={false} className="w-full"
                        />
                      </div>
                    )
                  })}
                  {canOrderThis && <span className="text-[10px] font-black text-[#D4591A]">⇅</span>}
                </button>
              ) : (
                <span className="text-[9px] font-bold text-slate-300">{a.defending_username ?? 'opponent'}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Parse the numbers out of a "P/T" label; falls back to 0 power / 1 toughness.
function parsePT(pt?: string | null): { power: number; toughness: number } {
  const m = (pt ?? '').match(/^(\d+)\s*\/\s*(\d+)$/)
  return m ? { power: Number(m[1]), toughness: Number(m[2]) } : { power: 0, toughness: 1 }
}

function BlockerOrderSheet({
  assignment,
  boardCards,
  onConfirm,
  onClose,
}: {
  assignment: CombatAssignment
  boardCards: BoardCard[]
  onConfirm: (
    orderedBlockerIds: string[],
    distribution: { blockers: { blocker_card_id: string; amount: number }[]; trample?: number },
  ) => Promise<void>
  onClose: () => void
}) {
  const [order, setOrder] = useState<CombatBlocker[]>(assignment.blockers ?? [])
  const [isPending, setIsPending] = useState(false)
  const attackerCard = boardCards.find((c) => c.id === assignment.attacker_card_id)

  // Attacker's combat damage to spread. Prefer the server-computed effective power;
  // fall back to the printed/effective P/T from the board card.
  const attackerPower =
    assignment.attacker_power ?? parsePT(attackerCard ? effectiveBoardPT(attackerCard) : '').power

  const lethalOf = (blockerCardId: string) => {
    const bc = boardCards.find((c) => c.id === blockerCardId)
    return Math.max(1, parsePT(bc ? effectiveBoardPT(bc) : '').toughness)
  }

  // Default each blocker to its lethal (matches the engine's auto-assignment).
  const [amounts, setAmounts] = useState<Record<string, number>>(() =>
    Object.fromEntries((assignment.blockers ?? []).map((b) => [b.blocker_card_id, lethalOf(b.blocker_card_id)])),
  )
  const [trample, setTrample] = useState(0)

  const sum = order.reduce((acc, b) => acc + (amounts[b.blocker_card_id] ?? 0), 0)
  const remaining = attackerPower - sum - trample

  const move = (index: number, dir: -1 | 1) => {
    setOrder((prev) => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const bump = (id: string, delta: number) =>
    setAmounts((prev) => ({
      ...prev,
      [id]: Math.max(0, Math.min(attackerPower, (prev[id] ?? 0) + delta)),
    }))

  const bumpTrample = (delta: number) =>
    setTrample((prev) => Math.max(0, Math.min(prev + delta, prev + Math.max(0, remaining))))

  const confirm = async () => {
    setIsPending(true)
    try {
      await onConfirm(
        order.map((b) => b.blocker_card_id),
        {
          blockers: order.map((b) => ({ blocker_card_id: b.blocker_card_id, amount: amounts[b.blocker_card_id] ?? 0 })),
          trample: trample > 0 ? trample : undefined,
        },
      )
    } finally {
      setIsPending(false)
    }
  }

  const stepper = (value: number, onMinus: () => void, onPlus: () => void) => (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onMinus}
        className="h-6 w-6 rounded-md bg-white/10 text-xs font-black text-white active:scale-90"
      >
        −
      </button>
      <span className="w-5 text-center text-sm font-black text-white">{value}</span>
      <button
        type="button"
        onClick={onPlus}
        className="h-6 w-6 rounded-md bg-white/10 text-xs font-black text-white active:scale-90"
      >
        +
      </button>
    </div>
  )

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-40 bg-black/60"
        onClick={onClose}
      />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        className="absolute inset-x-0 bottom-0 z-50 rounded-t-3xl border-t border-white/10 bg-[#181C28] px-4 pb-6 pt-4"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/15" />

        {/* Attacker header */}
        <div className="mb-1 flex items-center gap-3">
          <div className="h-[56px] w-[40px] shrink-0 overflow-hidden rounded-lg shadow-lg">
            <MotionCard
              card={{ id: assignment.attacker_card_id, name: assignment.attacker_name ?? 'Attacker', image_url: attackerCard?.image_url, is_tapped: true, damage_marked: 0, zone: 'battlefield' }}
              size="board" useLayoutId={false} className="w-full"
            />
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-black text-white">{assignment.attacker_name}</p>
            <p className="text-[11px] text-[#D4591A]">Assign {attackerPower} combat damage</p>
          </div>
        </div>
        <p className="mb-3 text-[10px] text-slate-500">
          Assign lethal to a blocker before any later blocker (or the player). Over-assigning is allowed.
          {' '}Unassigned: <span className={remaining < 0 ? 'text-red-400' : 'text-slate-300'}>{remaining}</span>
        </p>

        {/* Ordered blocker list with per-blocker damage steppers */}
        <div className="space-y-2">
          {order.map((b, i) => {
            const blockerCard = boardCards.find((c) => c.id === b.blocker_card_id)
            return (
              <div key={b.id} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-[#0F1117] p-2">
                <span className="w-5 text-center text-sm font-black text-[#D4591A]">{i + 1}</span>
                <div className="h-[48px] w-[34px] shrink-0 overflow-hidden rounded-md">
                  <MotionCard
                    card={{ id: b.blocker_card_id, name: b.blocker_name ?? 'Blocker', image_url: blockerCard?.image_url, is_tapped: false, damage_marked: 0, zone: 'battlefield' }}
                    size="board" useLayoutId={false} className="w-full"
                  />
                </div>
                <span className="min-w-0 flex-1 truncate text-xs font-bold text-white">{b.blocker_name}</span>
                {stepper(amounts[b.blocker_card_id] ?? 0, () => bump(b.blocker_card_id, -1), () => bump(b.blocker_card_id, 1))}
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-black text-white disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    disabled={i === order.length - 1}
                    onClick={() => move(i, 1)}
                    className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-black text-white disabled:opacity-30"
                  >
                    ▼
                  </button>
                </div>
              </div>
            )
          })}

          {/* Trample to the defending player (only legal if the attacker has trample;
              the server rejects it otherwise). */}
          <div className="flex items-center gap-2 rounded-2xl border border-[#D4591A]/30 bg-[#120905]/60 p-2">
            <span className="min-w-0 flex-1 truncate text-xs font-bold text-[#D4591A]">
              Trample → {assignment.defending_username ?? 'player'}
            </span>
            {stepper(trample, () => bumpTrample(-1), () => bumpTrample(1))}
          </div>
        </div>

        <button
          type="button"
          disabled={isPending || remaining < 0}
          onClick={confirm}
          className="mt-4 w-full rounded-2xl bg-[#D4591A] py-3.5 text-sm font-black text-white transition active:scale-95 disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Confirm Assignment'}
        </button>
      </motion.div>
    </>
  )
}

// ─── Stack Strip ──────────────────────────────────────────────────────────────

function StackStrip({ items }: { items: StackItem[] }) {
  // Highest position = most recently added = top of stack
  const sorted = [...items].sort((a, b) => b.position - a.position)

  return (
    <div className="shrink-0 border-b border-orange-900/40 bg-orange-950/20">
      <div className="flex items-center gap-2 overflow-x-auto px-3 py-1.5">
        <span className="shrink-0 text-[8px] font-black uppercase tracking-widest text-orange-500">
          Stack
        </span>
        {sorted.map((item, i) => (
          <div
            key={item.id}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 ${
              i === 0
                ? 'border-orange-500/40 bg-orange-500/10 text-orange-200'
                : 'border-white/5 bg-white/5 text-slate-400'
            }`}
          >
            {i === 0 && (
              <span className="text-[7px] font-black uppercase tracking-wider text-orange-500">Top</span>
            )}
            <span className="text-[10px] font-bold">
              {item.source_card_name ?? item.action_type}
            </span>
            <span className="text-[9px] text-slate-600">
              {item.controller_username ?? ''}
            </span>
            {item.target_username && (
              <span className="text-[9px] text-slate-600">→ {item.target_username}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── My Zones Sheet ───────────────────────────────────────────────────────────

function MyZonesSheet({
  graveyard,
  exile,
  initialTab,
  onClose,
}: {
  graveyard: ControllerCard[]
  exile: ControllerCard[]
  initialTab: MyZoneTab
  onClose: () => void
}) {
  const [tab, setTab] = useState<MyZoneTab>(initialTab)

  const tabs: { key: MyZoneTab; label: string; count: number }[] = [
    { key: 'graveyard', label: 'Graveyard', count: graveyard.length },
    { key: 'exile',     label: 'Exile',     count: exile.length },
  ]

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-30 bg-black/60"
        onClick={onClose}
      />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 32, stiffness: 320 }}
        className="absolute inset-x-0 bottom-0 z-40 flex max-h-full flex-col rounded-t-2xl border-t border-white/10 bg-[#0D1018]"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[#1E2230] px-4 py-3">
          <p className="text-sm font-black text-white">Your zones</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-300 active:scale-95"
          >
            Close
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 border-b border-[#1E2230] px-3 pt-2">
          {tabs.map(({ key, label, count }) => {
            const isActive = tab === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`relative flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-bold transition-colors ${
                  isActive ? 'bg-[#131720] text-white' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {label}
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-black ${
                  isActive ? 'bg-white/10 text-white' : 'bg-white/5 text-slate-600'
                }`}>
                  {count}
                </span>
                {isActive && (
                  <motion.div
                    layoutId="my-zones-tab-indicator"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-amber-400"
                    transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                  />
                )}
              </button>
            )
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          <AnimatePresence mode="wait" initial={false}>
            {tab === 'graveyard' && (
              <motion.div
                key="gy"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.15 }}
              >
                {graveyard.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-700">Graveyard is empty</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {graveyard.map((card) => (
                      <div key={card.id} className="w-[60px]">
                        <MotionCard
                          card={{ id: card.id, name: card.name, image_url: card.cards?.image_url, is_tapped: false, damage_marked: 0, zone: card.zone }}
                          size="board" useLayoutId={false} className="w-full"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
            {tab === 'exile' && (
              <motion.div
                key="exile"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.15 }}
              >
                {exile.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-700">Nothing in exile</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {exile.map((card) => (
                      <div key={card.id} className="w-[60px]">
                        <MotionCard
                          card={{ id: card.id, name: card.name, image_url: card.cards?.image_url, is_tapped: false, damage_marked: 0, zone: card.zone }}
                          size="board" useLayoutId={false} className="w-full"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </>
  )
}

// ─── Opponent Board Overlay ───────────────────────────────────────────────────

type OverlayTab = 'board' | 'graveyard' | 'exile'

function OpponentBoardOverlay({
  supabase,
  sessionId,
  opponent,
  cards,
  onClose,
}: {
  supabase: ReturnType<typeof import('@/lib/supabase/client').createClient>
  sessionId: string
  opponent: GameSessionPlayer
  cards: BoardCard[]
  onClose: () => void
}) {
  const [tab, setTab] = useState<OverlayTab>('board')
  const [zoneData, setZoneData] = useState<OpponentZoneData | null>(null)

  useMemo(() => {
    getOpponentZoneData(supabase, sessionId, opponent.player_id)
      .then(setZoneData)
      .catch(() => setZoneData({ graveyard: [], exile: [], handCount: 0, libraryCount: 0 }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opponent.player_id])

  const creatures = cards.filter((c) => c.type_line?.toLowerCase().includes('creature'))
  const lands = cards.filter((c) => c.type_line?.toLowerCase().includes('land'))
  const other = cards.filter(
    (c) =>
      !c.type_line?.toLowerCase().includes('creature') &&
      !c.type_line?.toLowerCase().includes('land'),
  )

  const tabs: { key: OverlayTab; label: string; count: number }[] = [
    { key: 'board',     label: 'Board',     count: cards.length },
    { key: 'graveyard', label: 'Graveyard', count: zoneData?.graveyard.length ?? 0 },
    { key: 'exile',     label: 'Exile',     count: zoneData?.exile.length ?? 0 },
  ]

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-30 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 32, stiffness: 320 }}
        className="absolute inset-x-0 bottom-0 z-40 flex max-h-full flex-col rounded-t-2xl border-t border-white/10 bg-[#0D1018]"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[#1E2230] px-4 py-3">
          <div>
            <p className="text-sm font-black text-white">
              {opponent.username ?? `Player ${opponent.seat_number}`}
            </p>
            <p className="text-[10px] text-slate-500">Life {opponent.life_total}</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Hand + library counters (always visible) */}
            <div className="flex gap-3">
              {[
                { label: 'Hand',    value: zoneData?.handCount ?? '—',    color: 'text-slate-300' },
                { label: 'Library', value: zoneData?.libraryCount ?? '—', color: 'text-blue-300' },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex flex-col items-center">
                  <span className={`text-sm font-black leading-none ${color}`}>{value}</span>
                  <span className="text-[8px] uppercase tracking-wider text-slate-700">{label}</span>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-300 active:scale-95"
            >
              Close
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex shrink-0 gap-1 border-b border-[#1E2230] px-3 pt-2">
          {tabs.map(({ key, label, count }) => {
            const isActive = tab === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`relative flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-bold transition-colors ${
                  isActive
                    ? 'bg-[#131720] text-white'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {label}
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[9px] font-black ${
                    isActive ? 'bg-white/10 text-white' : 'bg-white/5 text-slate-600'
                  }`}
                >
                  {count}
                </span>
                {isActive && (
                  <motion.div
                    layoutId="overlay-tab-indicator"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-amber-400"
                    transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                  />
                )}
              </button>
            )
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-3">
          <AnimatePresence mode="wait" initial={false}>
            {tab === 'board' && (
              <motion.div
                key="board"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.15 }}
                className="space-y-4"
              >
                {creatures.length > 0 && (
                  <ZoneSection label={`Creatures (${creatures.length})`}>
                    {creatures.map((card) => (
                      <div key={card.id} className="flex w-[60px] flex-col items-center gap-1">
                        <MotionCard
                          card={{ id: card.id, name: card.name, image_url: card.image_url, is_tapped: card.is_tapped, damage_marked: card.damage_marked, zone: card.zone }}
                          size="board" useLayoutId={false} className="w-full"
                        />
                        {card.damage_marked > 0 && (
                          <span className="text-[8px] font-bold text-red-400">{card.damage_marked} dmg</span>
                        )}
                      </div>
                    ))}
                  </ZoneSection>
                )}
                {other.length > 0 && (
                  <ZoneSection label={`Other permanents (${other.length})`}>
                    {other.map((card) => (
                      <div key={card.id} className="w-[60px]">
                        <MotionCard
                          card={{ id: card.id, name: card.name, image_url: card.image_url, is_tapped: card.is_tapped, damage_marked: card.damage_marked, zone: card.zone }}
                          size="board" useLayoutId={false} className="w-full"
                        />
                      </div>
                    ))}
                  </ZoneSection>
                )}
                {lands.length > 0 && (
                  <ZoneSection label={`Lands (${lands.length})`}>
                    {lands.map((card) => (
                      <div key={card.id} className="w-[44px]">
                        <MotionCard
                          card={{ id: card.id, name: card.name, image_url: card.image_url, is_tapped: card.is_tapped, damage_marked: card.damage_marked, zone: card.zone }}
                          size="board" useLayoutId={false} className="w-full"
                        />
                      </div>
                    ))}
                  </ZoneSection>
                )}
                {cards.length === 0 && (
                  <p className="py-8 text-center text-sm text-slate-700">Empty battlefield</p>
                )}
              </motion.div>
            )}

            {tab === 'graveyard' && (
              <motion.div
                key="graveyard"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.15 }}
              >
                {(zoneData?.graveyard.length ?? 0) === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-700">Graveyard is empty</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {zoneData!.graveyard.map((card) => (
                      <div key={card.id} className="w-[60px]">
                        <MotionCard
                          card={{ id: card.id, name: card.name, image_url: card.image_url, is_tapped: false, damage_marked: 0, zone: card.zone }}
                          size="board" useLayoutId={false} className="w-full"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}

            {tab === 'exile' && (
              <motion.div
                key="exile"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.15 }}
              >
                {(zoneData?.exile.length ?? 0) === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-700">Nothing in exile</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {zoneData!.exile.map((card) =>
                      card.is_face_down ? (
                        <div key={card.id} className="flex w-[60px] flex-col items-center gap-1" title="Face-down exile — hidden">
                          <div className="aspect-[5/7] w-full rounded-md border border-white/10 bg-slate-900 flex items-center justify-center">
                            <span className="text-[9px] font-bold text-slate-600">?</span>
                          </div>
                          <span className="text-[8px] text-slate-700">Hidden</span>
                        </div>
                      ) : (
                        <div key={card.id} className="w-[60px] opacity-80">
                          <MotionCard
                            card={{ id: card.id, name: card.name, image_url: card.image_url, is_tapped: false, damage_marked: 0, zone: card.zone }}
                            size="board" useLayoutId={false} className="w-full"
                          />
                        </div>
                      ),
                    )}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </>
  )
}

function ZoneSection({
  label,
  accent = 'border-[#1E2230]',
  children,
}: {
  label: string
  accent?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <p className={`mb-2 border-b pb-1 text-[9px] font-black uppercase tracking-widest text-slate-500 ${accent}`}>
        {label}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  )
}

// ─── Declare Attackers ────────────────────────────────────────────────────────

function DeclareAttackersLayout({
  ownCreatures,
  opponentPlayers,
  turnState,
  errorMessage,
  onDeclareAttacker,
  onPassPriority,
}: {
  ownCreatures: ControllerCard[]
  opponentPlayers: GameSessionPlayer[]
  turnState: GameTurnState | null
  errorMessage: string | null
  onDeclareAttacker: (cardId: string, targetPlayerId: string) => Promise<void>
  onPassPriority: () => Promise<void>
}) {
  const untappedCreatures = ownCreatures.filter((c) => !c.is_tapped)
  const defaultTarget = opponentPlayers[0]?.player_id ?? ''
  const [assignments, setAssignments] = useState<Record<string, string>>({})
  const [isPending, setIsPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const attackingCount = Object.keys(assignments).length
  const defender = opponentPlayers[0]

  const isAttackable = (card: ControllerCard) => {
    const turnNumber = turnState?.turn_number ?? 0
    const entered = card.entered_battlefield_turn_number
    if (entered !== null && entered !== undefined && entered >= turnNumber) {
      const script = normalizeCardBehaviorToV2(
        card.copied_script ?? card.cards?.script ?? null,
        card.cards?.type_line,
      )
      return script.keywords?.includes('haste') ?? false
    }
    return true
  }

  const toggleAttacker = (cardId: string) => {
    const card = untappedCreatures.find((c) => c.id === cardId)
    if (!card || !isAttackable(card)) return
    setAssignments((prev) => {
      const next = { ...prev }
      if (next[cardId]) delete next[cardId]
      else next[cardId] = defaultTarget
      return next
    })
  }

  const submit = async () => {
    setIsPending(true)
    setLocalError(null)
    try {
      for (const [cardId, targetId] of Object.entries(assignments)) {
        if (targetId) await onDeclareAttacker(cardId, targetId)
      }
      // Pass priority — the step advances automatically when both players pass
      await onPassPriority()
    } catch (error) {
      setLocalError(getErrorMessage(error))
    } finally {
      setIsPending(false)
    }
  }

  const cancel = async () => {
    setIsPending(true)
    // No attackers — pass priority without declaring
    try { await onPassPriority() } finally { setIsPending(false) }
  }

  return (
    <div className="flex h-[100svh] flex-col bg-[#0F1117]">
      {/* Banner */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b-2 border-[#D4591A] bg-[#120905] px-4">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black uppercase tracking-widest text-[#D4591A]">⚔ Declare Attackers</span>
          {turnState && (
            <span className="text-[10px] text-slate-500">Combat Phase · Turn {turnState.turn_number}</span>
          )}
        </div>
        {attackingCount > 0 && (
          <span className="rounded-full bg-[#D4591A]/20 px-2 py-0.5 text-[10px] font-black text-[#D4591A]">
            {attackingCount} attacking
          </span>
        )}
      </div>

      {/* Defender */}
      {defender && (
        <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-[#2A2D38] bg-[#0A0B14] px-5">
          <div>
            <p className="text-[9px] uppercase tracking-widest text-slate-500">Defending</p>
            <p className="text-sm font-black text-white">{defender.username ?? `Player ${defender.seat_number}`}</p>
          </div>
          <p className="text-2xl font-black text-white">{defender.life_total}</p>
        </div>
      )}

      {/* Creature grid */}
      <div className="flex min-h-0 flex-1 items-center gap-3 overflow-x-auto bg-[#0C0F14] px-5 py-3">
        {untappedCreatures.length === 0 ? (
          <p className="text-sm text-slate-600">No untapped creatures available.</p>
        ) : (
          untappedCreatures.map((card) => {
            const attackable = isAttackable(card)
            const isAttacking = Boolean(assignments[card.id])
            return (
              <motion.button
                key={card.id}
                type="button"
                onClick={() => toggleAttacker(card.id)}
                whileTap={attackable ? { scale: 0.94 } : {}}
                className={`relative flex w-[72px] shrink-0 flex-col items-center gap-1 rounded-xl border-2 p-1.5 transition-colors ${
                  !attackable
                    ? 'border-[#1C2030] bg-[#0C0F14] opacity-45'
                    : isAttacking
                      ? 'border-[#D4591A] bg-[#D4591A]/10'
                      : 'border-[#2A2D38] bg-[#131720] hover:border-slate-500'
                }`}
              >
                {isAttacking && (
                  <div className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-[#D4591A] px-1.5 py-0.5">
                    <span className="text-[7px] font-black uppercase text-white">Atk</span>
                  </div>
                )}
                {!attackable && (
                  <div className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-slate-700 px-1.5 py-0.5">
                    <span className="text-[7px] font-black uppercase text-slate-400">Sick</span>
                  </div>
                )}
                <div className={isAttacking ? 'rotate-90 transition-transform duration-200' : 'transition-transform duration-200'}>
                  <MotionCard
                    card={{ id: card.id, name: card.name, image_url: card.cards?.image_url, is_tapped: false, damage_marked: card.damage_marked, zone: card.zone }}
                    size="board"
                    useLayoutId={false}
                    className="w-full"
                  />
                </div>
                {getEffectivePT(card) && (
                  <span
                    className={`text-[9px] font-black ${
                      (card.plus_one_counters ?? 0) > 0 ? 'text-emerald-400' : 'text-slate-300'
                    }`}
                  >
                    {getEffectivePT(card)}
                  </span>
                )}
                {attackable && !isAttacking && (
                  <span className="text-[8px] text-slate-600">Tap to attack</span>
                )}
              </motion.button>
            )
          })
        )}
      </div>

      {/* Error toast — above action bar so it's always visible */}
      {(localError ?? errorMessage) && (
        <div className="shrink-0 border-t border-red-900/40 bg-red-950/80 px-4 py-2 text-xs text-red-200">
          {localError ?? errorMessage}
        </div>
      )}

      {/* Action bar */}
      <div className="flex shrink-0 items-center gap-3 border-t border-[#2A2D38] bg-[#09090D] px-4 py-3">
        {/* Skip attack — pass priority with no attackers */}
        <button
          type="button"
          disabled={isPending}
          onClick={cancel}
          className="flex h-12 flex-1 items-center justify-center rounded-2xl border border-[#2A2D38] text-sm font-bold text-slate-400 transition active:scale-95 disabled:opacity-50"
        >
          No Attack
        </button>

        {/* Confirm — declare selected attackers and pass priority */}
        <button
          type="button"
          disabled={isPending || attackingCount === 0}
          onClick={submit}
          className="flex h-12 flex-[2] items-center justify-center gap-2 rounded-2xl bg-[#D4591A] text-sm font-black text-white transition active:scale-95 disabled:opacity-40"
        >
          {isPending ? (
            <span className="text-[11px] opacity-70">Confirming…</span>
          ) : attackingCount > 0 ? (
            <span>Attack with {attackingCount}</span>
          ) : (
            <span className="text-sm opacity-60">Select attackers</span>
          )}
        </button>
      </div>
    </div>
  )
}

// ─── Declare Blockers ─────────────────────────────────────────────────────────

function DeclareBlockersLayout({
  ownCreatures,
  incomingAttackers,
  boardCards,
  manaPool,
  turnState,
  errorMessage,
  onDeclareBlocker,
  onPassPriority,
}: {
  ownCreatures: ControllerCard[]
  incomingAttackers: CombatAssignment[]
  boardCards: BoardCard[]
  manaPool: ManaPool
  turnState: GameTurnState | null
  errorMessage: string | null
  onDeclareBlocker: (blockerCardId: string, attackingCardId: string) => Promise<void>
  onPassPriority: () => Promise<void>
}) {
  const blockableCreatures = ownCreatures.filter((c) => !c.is_tapped)
  const [selectedAttackerId, setSelectedAttackerId] = useState<string | null>(
    incomingAttackers[0]?.attacker_card_id ?? null,
  )
  const [blockAssignments, setBlockAssignments] = useState<Record<string, string>>({})
  const [isPending, setIsPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const assignBlocker = (blockerCardId: string) => {
    if (!selectedAttackerId) return
    setBlockAssignments((prev) => {
      const next = { ...prev }
      if (next[blockerCardId] === selectedAttackerId) delete next[blockerCardId]
      else next[blockerCardId] = selectedAttackerId
      return next
    })
  }

  const submit = async () => {
    setIsPending(true)
    setLocalError(null)
    try {
      for (const [blockerCardId, attackingCardId] of Object.entries(blockAssignments)) {
        if (attackingCardId) await onDeclareBlocker(blockerCardId, attackingCardId)
      }
      await onPassPriority()
    } catch (error) {
      setLocalError(getErrorMessage(error))
    } finally {
      setIsPending(false)
    }
  }

  const cancel = async () => {
    setIsPending(true)
    try { await onPassPriority() } finally { setIsPending(false) }
  }

  const totalMana = manaColors.reduce((sum, c) => sum + (manaPool[c] ?? 0), 0)

  return (
    <div className="flex h-[100svh] flex-col bg-[#0F1117]">
      {/* Banner */}
      <div className="flex h-9 shrink-0 items-center border-b border-[#2A2D38] bg-[#131720] px-4">
        <span className="text-[10px] font-black uppercase tracking-widest text-cyan-300">
          ◈ Blockers — Combat Phase{turnState ? ` · T${turnState.turn_number}` : ''}
        </span>
      </div>

      {/* Attacker scroll */}
      <div className="flex h-[200px] shrink-0 items-center gap-3 overflow-x-auto bg-[#0F1117] px-4 py-3">
        {incomingAttackers.map((assignment) => {
          const attackerCard = boardCards.find((c) => c.id === assignment.attacker_card_id)
          const isSelected = selectedAttackerId === assignment.attacker_card_id
          const assignedBlockers = Object.entries(blockAssignments)
            .filter(([, aId]) => aId === assignment.attacker_card_id)
            .map(([bId]) => ownCreatures.find((c) => c.id === bId))
            .filter(Boolean) as ControllerCard[]

          return (
            <motion.button
              key={assignment.id}
              type="button"
              onClick={() => setSelectedAttackerId(assignment.attacker_card_id)}
              whileTap={{ scale: 0.95 }}
              className={`relative flex w-[110px] shrink-0 flex-col items-center gap-2 rounded-2xl border-2 p-2 transition-colors ${
                isSelected ? 'border-cyan-400 bg-cyan-400/10' : 'border-[#1C2030] bg-[#0A0C14]'
              }`}
            >
              <div className="w-full">
                <MotionCard
                  card={{ id: assignment.attacker_card_id, name: assignment.attacker_name ?? 'Attacker', image_url: attackerCard?.image_url, is_tapped: true, damage_marked: 0, zone: 'battlefield' }}
                  size="board"
                  useLayoutId={false}
                  className="w-full"
                />
              </div>
              <p className="w-full truncate text-center text-[10px] font-bold text-white">
                {assignment.attacker_name}
              </p>
              {assignment.attacker_power != null && assignment.attacker_toughness != null && (
                <span className="rounded bg-[#D4591A]/20 px-1.5 py-0.5 text-[10px] font-black text-[#D4591A]">
                  {assignment.attacker_power}/{assignment.attacker_toughness}
                </span>
              )}
              {assignedBlockers.length > 0 ? (
                <div className="flex flex-wrap justify-center gap-1">
                  {assignedBlockers.map((b) => (
                    <span key={b.id} className="rounded bg-cyan-500/20 px-1 py-0.5 text-[8px] font-bold text-cyan-200">
                      {b.name}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-[9px] text-red-400">Unblocked</span>
              )}
            </motion.button>
          )
        })}
      </div>

      <div className="h-px shrink-0 bg-[#1C2030]" />

      {/* Blocker bench */}
      <div className="flex min-h-0 flex-1 items-center gap-3 overflow-x-auto bg-[#131720] px-4 py-2">
        {totalMana > 0 && (
          <div className="flex shrink-0 flex-col gap-0.5 border-r border-[#2A2D38] pr-3">
            <p className="text-[8px] uppercase tracking-widest text-slate-600">Mana</p>
            <p className="text-base font-black text-white">{totalMana}</p>
            <div className="flex gap-0.5">
              {manaColors
                .filter((c) => (manaPool[c] ?? 0) > 0)
                .map((c) => (
                  <span key={c} className={`text-[9px] font-black ${manaColorStyles[c].text}`}>
                    {manaPool[c]}
                  </span>
                ))}
            </div>
          </div>
        )}
        {blockableCreatures.length === 0 ? (
          <p className="text-[10px] text-slate-600">No creatures available to block.</p>
        ) : (
          blockableCreatures.map((card) => {
            const isBlocking = Boolean(blockAssignments[card.id])
            const blockingTarget = isBlocking
              ? incomingAttackers.find((a) => a.attacker_card_id === blockAssignments[card.id])
              : null

            return (
              <motion.button
                key={card.id}
                type="button"
                onClick={() => assignBlocker(card.id)}
                whileTap={{ scale: 0.94 }}
                className={`flex w-16 shrink-0 flex-col items-center gap-1 rounded-xl border-2 p-1.5 transition-colors ${
                  isBlocking
                    ? 'border-cyan-400 bg-cyan-400/10'
                    : selectedAttackerId
                      ? 'border-[#2A2D38] bg-[#0A0C14] hover:border-slate-500'
                      : 'border-[#2A2D38] bg-[#0A0C14] opacity-50'
                }`}
              >
                <MotionCard
                  card={{ id: card.id, name: card.name, image_url: card.cards?.image_url, is_tapped: false, damage_marked: card.damage_marked, zone: card.zone }}
                  size="board"
                  useLayoutId={false}
                  className="w-full"
                />
                {getEffectivePT(card) && (
                  <span
                    className={`text-[9px] font-black ${
                      (card.plus_one_counters ?? 0) > 0 ? 'text-emerald-400' : 'text-slate-300'
                    }`}
                  >
                    {getEffectivePT(card)}
                  </span>
                )}
                {isBlocking && blockingTarget && (
                  <span className="w-full truncate text-center text-[8px] text-cyan-300">
                    ↑ {blockingTarget.attacker_name}
                  </span>
                )}
              </motion.button>
            )
          })
        )}
      </div>

      {/* Action bar */}
      <div className="flex shrink-0 items-center gap-3 border-t border-[#2A2D38] bg-[#131720] px-4 py-3">
        {/* No blocks — pass priority */}
        <button
          type="button"
          disabled={isPending}
          onClick={cancel}
          className="flex h-12 flex-1 items-center justify-center rounded-2xl border border-[#2A2D38] text-sm font-bold text-slate-400 transition active:scale-95 disabled:opacity-50"
        >
          No Blocks
        </button>

        {/* Confirm — declare selected blockers and pass priority */}
        <button
          type="button"
          disabled={isPending}
          onClick={submit}
          className="flex h-12 flex-[2] items-center justify-center rounded-2xl bg-cyan-400 text-sm font-black text-cyan-950 transition active:scale-95 disabled:opacity-50"
        >
          {isPending ? (
            <span className="text-[11px] opacity-70">Confirming…</span>
          ) : Object.keys(blockAssignments).length > 0 ? (
            `Block with ${Object.keys(blockAssignments).length}`
          ) : (
            'Confirm Blockers'
          )}
        </button>
      </div>

      {(errorMessage ?? localError) && (
        <div className="border-t border-red-900/40 bg-red-950/80 px-4 py-2 text-xs text-red-200">
          {localError ?? errorMessage}
        </div>
      )}
    </div>
  )
}
