'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  activateAbility,
  activateLoyaltyAbility,
  activateManaAbility,
  addManaFromCard,
  advanceStep,
  castCardFromHand,
  cycleCard,
  castSpellEffect,
  chooseTriggeredAbilityCreatureTarget,
  chooseTriggeredAbilityTargets,
  castFight,
  castCommander as castCommanderAction,
  declareAttacker as declareAttackerAction,
  declareBlocker as declareBlockerAction,
  equip as equipAction,
  getErrorMessage,
  keepOpeningHand,
  moveCardToZone,
  mulliganHand,
  passPriority as passPriorityAction,
  putAddCountersCreatureOnStack,
  putGrantKeywordCreatureOnStack,
  putGainControlCreatureOnStack,
  putCounterSpellOnStack,
  putDealDamageCreatureOnStack,
  putDealDamagePlayerOnStack,
  putDrawCardsOnStack,
  putPumpCreatureOnStack,
  putSetPtCreatureOnStack,
  putTargetedCreatureActionOnStack,
  castMultiCreatureEffect,
  castPermanentEffect,
  castDividedDamage,
  castModalSpell,
  resolveCombatDamage,
  setCombatBlockerOrder,
  submitDecision,
  syncAutoPassSettings,
} from '@/lib/game/actions'
import type { DamageAllocation, CombatDamageAssignments } from '@/lib/game/actions'
import {
  isAddManaBehaviorAction,
  normalizeCardBehaviorToV2,
  selectFirstManaAbility,
} from '@/lib/game/card-behavior'
import { getPowerToughnessLabel } from '@/lib/game/controller-selectors'
import { parseManaCost, type ParsedManaCost } from '@/lib/game/mana'
import { planAutoTap, type ManaSource } from '@/lib/game/auto-tap'
import { getOpponentZoneData } from '@/lib/game/data'
import type { CommanderDamageEntry, OpponentZoneData } from '@/lib/game/data'
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
import { CardActionSheet } from './controller/CardActionSheet'
import { OpeningHandOverlay } from './controller/OpeningHandOverlay'
import { ControllerCoachOverlay } from './controller/ControllerCoachOverlay'
import { ManaCostDisplay, ManaPoolDisplay } from './controller/CardDisplay'
import {
  canCastHandSpell,
  cardMatchesTargetType,
  creatureMatchesController,
  effectiveBoardPT,
  formatCounterBag,
  getEffectivePT,
  getSpellPlan,
  isCreatureOnlyTargetType,
  manaColors,
  manaColorStyles,
  manaCostColors,
  playerHasInstantResponse,
  targetTypeMatches,
} from './controller/shared'

// ─── Types ──────────────────────────────────────────────────────────────────

type LayoutState = 'main_phase' | 'declare_attackers' | 'declare_blockers' | 'stack_active' | 'default'

// ─── Constants ───────────────────────────────────────────────────────────────

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

// ─── Auto-pass ───────────────────────────────────────────────────────────────

// Per-session auto-pass controls (persisted to localStorage). Each switch is
// independent; see the auto-pass effect for how they combine.
type AutoPassSettings = {
  op: boolean   // auto-pass priority on opponents' turns
  own: boolean  // auto-pass your own turn's empty phases (untap/upkeep/draw/begin+end combat/end)
  stk: boolean  // on opponents' turns, STOP when a new object hits the stack
  rsp: boolean  // on opponents' turns, STOP when you have a castable response
}
const AUTOPASS_OFF: AutoPassSettings = { op: false, own: false, stk: false, rsp: false }
// Fresh sessions start fast: skip opponents' turns AND your own empty phases,
// but always stop when a new object hits the stack (and for every decision /
// trigger target / block — those are hard exemptions in the effect). Players
// who opened the popover and stored explicit prefs keep them.
const AUTOPASS_DEFAULT: AutoPassSettings = { op: true, own: true, stk: true, rsp: false }
const autoPassStorageKey = (sessionId: string) => 'leyline-autopass-' + sessionId
// First-run controller coach (onboarding) — shown once per device, re-openable
// via the ? in the status bar. Bump the version to re-show after a redesign.
const COACH_SEEN_KEY = 'leyline-coach-seen-v1'
function loadAutoPassSettings(sessionId: string): AutoPassSettings {
  if (typeof window === 'undefined') return AUTOPASS_DEFAULT
  const raw = localStorage.getItem(autoPassStorageKey(sessionId))
  if (!raw) return AUTOPASS_DEFAULT
  if (raw === '1') return { ...AUTOPASS_OFF, op: true } // migrate the v1 boolean toggle
  try {
    return { ...AUTOPASS_OFF, ...(JSON.parse(raw) as Partial<AutoPassSettings>) }
  } catch {
    return AUTOPASS_OFF
  }
}
// Your own steps with nothing to decide — auto-passed when `own` is on. Main
// phases and combat decision steps (declare_attackers/combat_damage) stay manual.
const OWN_SKIP_STEPS: GameTurnState['step'][] = ['untap', 'upkeep', 'draw', 'beginning_of_combat', 'end_of_combat', 'end']
// Adaptive auto-pass beat: snappy through genuinely dead windows (empty stack),
// but a longer, visible beat when an object is on the stack so the table can see
// it before it's passed. Sequential pod passes make the empty-window beat the
// dominant cost of early-game dead time, so it's kept short.
const AUTOPASS_BEAT_EMPTY_MS = 250
const AUTOPASS_BEAT_STACK_MS = 700

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The mana an untapped card auto-produces when it has exactly one simple
 * tap-for-one-colour ability (tap is the only cost, one fixed colour). Returns
 * null for tapped sources, multi-ability sources, sources with extra costs
 * (life/sacrifice), and 'commander'/'any' sources that need a colour choice.
 */
function getAutoTapMana(card: ControllerCard): { color: ManaColor; amount: number } | null {
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
  // A 'commander'/'any' source needs a colour choice — don't auto-tap; open the picker.
  const { color, amount } = addManaEffects[0]
  if (color === 'commander' || color === 'any') return null
  return { color, amount: Math.max(1, amount ?? 1) }
}

/** Returns the single mana color to auto-produce when a card has exactly one simple tap ability. */
function getAutoTapColor(card: ControllerCard): ManaColor | null {
  return getAutoTapMana(card)?.color ?? null
}

const BASIC_LAND_COLOR: Record<string, ManaColor> = {
  plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G', wastes: 'C',
}

/**
 * What mana colours an untapped land can make, for the hand "playable" hint:
 *   ManaColor[]  — the fixed colour(s) it taps for (one entry = a single colour)
 *   'flexible'   — any-colour / commander / multi-colour: a wildcard pip
 *   null         — not a recognizable mana source (counted as a wildcard too)
 * Scripted mana abilities take precedence; basics (no script) map from their
 * type-line subtype. This drives colour-correct affordability, not the payment
 * (the server + planAutoTap remain authoritative).
 */
function getProducibleColors(card: ControllerCard): ManaColor[] | 'flexible' | null {
  const script = normalizeCardBehaviorToV2(
    card.copied_script ?? card.cards?.script ?? null,
    card.cards?.type_line,
  )
  const manaAbilities = script.activated_abilities?.filter((a) => a.is_mana_ability) ?? []
  if (manaAbilities.length > 0) {
    const colors = new Set<ManaColor>()
    for (const ability of manaAbilities) {
      for (const effect of ability.effects) {
        if (!isAddManaBehaviorAction(effect)) continue
        if (effect.color === 'any' || effect.color === 'commander') return 'flexible'
        colors.add(effect.color as ManaColor)
      }
    }
    if (colors.size > 1) return 'flexible'
    if (colors.size === 1) return [...colors]
  }
  const tl = (card.cards?.type_line ?? '').toLowerCase()
  const basics = Object.entries(BASIC_LAND_COLOR).filter(([sub]) => tl.includes(sub)).map(([, c]) => c)
  if (basics.length > 1) return 'flexible'
  if (basics.length === 1) return basics
  return null
}

/**
 * Colour-aware affordability: can `byColor` mana + `flexible` wildcard pips cover
 * `cost`? Coloured pips are paid by matching colour first, then wildcards; the
 * generic remainder from leftover colour mana + remaining wildcards. Mirrors the
 * planner's `affordable()` with a wildcard pool for any/multi/unknown sources.
 */
function canAffordCost(cost: ParsedManaCost, byColor: Record<ManaColor, number>, flexible: number): boolean {
  let wild = flexible
  let leftover = 0
  for (const c of manaColors) {
    const need = cost.colored[c]
    const have = byColor[c] ?? 0
    if (have >= need) {
      leftover += have - need
    } else {
      const short = need - have
      if (wild < short) return false
      wild -= short
    }
  }
  return leftover + wild >= cost.generic
}

// The player's commander colour identity (W/U/B/R/G letters) from the mana symbols in
// their commander's mana cost + rules text — drives `color:'commander'` mana sources
// (Command Tower, Arcane Signet). Empty (colourless / no commander) → falls back to C.
function commanderIdentityColors(cards: ControllerCard[]): ManaColor[] {
  const commander = cards.find((c) => c.is_commander)
  if (!commander) return []
  const identity = new Set<ManaColor>()
  const scan = (text?: string | null) => {
    for (const m of (text ?? '').toUpperCase().matchAll(/\{([^}]+)\}/g)) {
      for (const ch of m[1] ?? '') {
        if ('WUBRG'.includes(ch)) identity.add(ch as ManaColor)
      }
    }
  }
  scan(commander.cards?.mana_cost)
  scan(commander.cards?.oracle_text)
  return [...identity]
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
    attackTaxes,
    commanderDamage,
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

  // First-run onboarding coach: auto-open once per device, re-openable via the ?.
  const [coachOpen, setCoachOpen] = useState(false)
  useEffect(() => {
    if (typeof window !== 'undefined' && !localStorage.getItem(COACH_SEEN_KEY)) setCoachOpen(true)
  }, [])
  const closeCoach = () => {
    if (typeof window !== 'undefined') localStorage.setItem(COACH_SEEN_KEY, '1')
    setCoachOpen(false)
  }
  // Opening-hand phase — players who still have to keep. Legacy sessions (and
  // sessions not started via start_game_session) have opening_hand_kept
  // true/undefined for everyone, so the overlay never shows there.
  const playersNotKept = players.filter((p) => p.opening_hand_kept === false)
  const openingHandWaitingFor = playersNotKept
    .filter((p) => p.player_id !== playerId)
    .map((p) => p.username || `Player ${p.seat_number}`)
  // Opponents' planeswalkers — attackable targets in the declare-attackers UI.
  const opponentPlaneswalkers = boardCards
    .filter((c) => c.controller_player_id !== playerId && (c.type_line?.toLowerCase().includes('planeswalker') ?? false))
    .map((c) => ({ id: c.id, name: c.name, loyalty: Number(c.counters?.loyalty ?? 0) }))
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
  const commandZone = cards.filter((c) => c.zone === 'command')
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
  // Colour-aware availability for the hand "playable" hint: floating pool + each
  // untapped land's producible colour (any/multi/unknown lands = wildcard pips).
  const availableByColor = manaColors.reduce((acc, c) => {
    acc[c] = manaPool[c] ?? 0
    return acc
  }, {} as Record<ManaColor, number>)
  let flexibleMana = 0
  for (const c of battlefieldCards) {
    if (c.is_tapped || !c.cards?.type_line?.toLowerCase().includes('land')) continue
    const colors = getProducibleColors(c)
    if (colors === 'flexible' || colors === null) flexibleMana += 1
    else availableByColor[colors[0]] += 1
  }
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

  // Auto-pass controls, persisted per session.
  const [autoPass, setAutoPass] = useState<AutoPassSettings>(AUTOPASS_OFF)
  useEffect(() => {
    setAutoPass(loadAutoPassSettings(sessionId))
  }, [sessionId])
  const updateAutoPass = (patch: Partial<AutoPassSettings>) => {
    setAutoPass((prev) => {
      const next = { ...prev, ...patch }
      localStorage.setItem(autoPassStorageKey(sessionId), JSON.stringify(next))
      return next
    })
  }
  // Mirror this player's auto-pass intent to the server so pass_priority can
  // chain skips for them (pod auto-skip). Runs on load and whenever it changes.
  useEffect(() => {
    if (!playerId) return
    syncAutoPassSettings(supabase, sessionId, autoPass).catch(() => {
      /* non-fatal: server just won't auto-skip this player */
    })
  }, [autoPass, sessionId, playerId, supabase])

  // "Yield rest of turn": one-shot — pass every priority until your next turn.
  // Holds the turn_number it was armed on; cleared once it's your turn again or
  // the turn number has advanced past it.
  const yieldUntilTurnRef = useRef<number | null>(null)
  const [isYielding, setIsYielding] = useState(false)
  useEffect(() => {
    if (yieldUntilTurnRef.current === null || !turnState) return
    if (isActivePlayer || turnState.turn_number > yieldUntilTurnRef.current) {
      yieldUntilTurnRef.current = null
      setIsYielding(false)
    }
  }, [turnState, isActivePlayer])
  const yieldRestOfTurn = () => {
    if (!turnState) return
    yieldUntilTurnRef.current = turnState.turn_number
    setIsYielding(true)
  }

  // Stack signature the player has already acknowledged (looked at + passed).
  // While `stk` is on, a new (unacknowledged) object on an opponent's stack
  // stops auto-pass; once the player passes manually we record it so the same
  // stack doesn't re-stop forever.
  const currentStackKey = pendingStackItems.map((i) => i.id).sort().join(',')
  const ackStackKeyRef = useRef<string>('')

  // Whether you currently hold a castable response (instant/flash in hand or an
  // instant-speed activated ability) — used by the `rsp` stop condition.
  const iHaveResponse = useMemo(
    () => playerHasInstantResponse(cards, canCastInstants, pendingStackItems.length, availableMana),
    [cards, canCastInstants, pendingStackItems.length, availableMana],
  )

  // Single decision: when priority lands on you, should it auto-pass? Hard
  // exemptions always win — your pending decision / trigger target
  // (passBlockReason), the declare-blockers step (never skip your blocks), and a
  // finished session. Your own turn only auto-passes its empty phases.
  useEffect(() => {
    if (!playerId || !turnState || isSessionFinished) return
    if (turnState.priority_player_id !== playerId) return
    if (passBlockReason) return
    if (turnState.step === 'declare_blockers') return

    let willPass: boolean
    if (yieldUntilTurnRef.current !== null) {
      willPass = true // yielding: pass through everything until your next turn
    } else if (turnState.active_player_id === playerId) {
      willPass = autoPass.own && OWN_SKIP_STEPS.includes(turnState.step)
    } else {
      willPass = autoPass.op
      if (willPass && autoPass.stk && currentStackKey && currentStackKey !== ackStackKeyRef.current) willPass = false
      if (willPass && autoPass.rsp && iHaveResponse) willPass = false
    }
    if (!willPass) return

    const beatMs = currentStackKey ? AUTOPASS_BEAT_STACK_MS : AUTOPASS_BEAT_EMPTY_MS
    const timer = setTimeout(() => {
      passPriorityAction(supabase, sessionId)
        .then(() => { ackStackKeyRef.current = currentStackKey; return refresh() })
        .catch(() => { /* lost a race to a state change; the next tick re-evaluates */ })
    }, beatMs)
    return () => clearTimeout(timer)
  }, [autoPass, isYielding, playerId, isSessionFinished, passBlockReason, supabase, sessionId, refresh, turnState, currentStackKey, iHaveResponse])

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
    if (!card || !ability) {
      setErrorMessage('No mana ability found.')
      return
    }
    // A mana ability with a SACRIFICE cost (Treasure) can't use the client-side
    // tap-and-add path (it must sacrifice the source); route it through the
    // engine's activate_mana_ability, passing the chosen colour for "any".
    if (ability.costs.some((c) => c.type === 'sacrifice_self')) {
      const normalized = normalizeCardBehaviorToV2(script, card?.cards?.type_line)
      const index = (normalized.activated_abilities ?? []).findIndex((a) => a === ability)
      await activateManaAbility(supabase, sessionId, cardId, Math.max(0, index), undefined, color)
      await refresh()
      return
    }
    // A `color:'commander'` source produces a CHOSEN identity colour; the picker
    // passes the real colour (validated against the commander's identity server-side).
    const commanderEffect = ability.effects.find((e) => isAddManaBehaviorAction(e) && e.color === 'commander')
    if (commanderEffect && isAddManaBehaviorAction(commanderEffect) && color) {
      await addManaFromCard({
        supabase,
        cardId,
        sessionId,
        playerId,
        color,
        amount: commanderEffect.amount,
        shouldTapCard: ability.costs.some((c) => c.type === 'tap_self'),
        commanderIdentity: true,
      })
      await refresh()
      return
    }
    // A `color:'any'` source produces a CHOSEN colour with no identity restriction.
    const anyColorEffect = ability.effects.find((e) => isAddManaBehaviorAction(e) && e.color === 'any')
    if (anyColorEffect && isAddManaBehaviorAction(anyColorEffect) && color) {
      await addManaFromCard({
        supabase,
        cardId,
        sessionId,
        playerId,
        color,
        amount: anyColorEffect.amount,
        shouldTapCard: ability.costs.some((c) => c.type === 'tap_self'),
        commanderIdentity: false,
      })
      await refresh()
      return
    }
    const manaEffect = ability.effects.find(
      (e) => isAddManaBehaviorAction(e) && (!color || e.color === color),
    )
    if (!manaEffect || !isAddManaBehaviorAction(manaEffect)) {
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

  // Auto-pay: when the floating pool can't cover a spell's printed cost, tap
  // enough untapped single-colour, cost-free sources to make up the difference
  // before casting — so you can cast straight from hand without hand-tapping
  // lands first. Skipped for {X} costs (the amount depends on the chosen X) and
  // for anything the safe-greedy planner can't cover unambiguously, leaving
  // those to manual tapping. Already-affordable casts tap nothing.
  const autoPay = async (card: ControllerCard | null) => {
    if (!card || !playerId) return
    const manaCost = card.cards?.mana_cost ?? ''
    if (/x/i.test(manaCost)) return
    const sources: ManaSource[] = battlefieldCards.flatMap((c) => {
      const m = getAutoTapMana(c)
      return m ? [{ id: c.id, color: m.color, amount: m.amount }] : []
    })
    const plan = planAutoTap(parseManaCost(manaCost), manaPool, sources)
    if (!plan || plan.length === 0) return
    for (const tap of plan) {
      await addManaFromCard({
        supabase, cardId: tap.id, sessionId, playerId,
        color: tap.color, amount: tap.amount, shouldTapCard: true,
      })
    }
    await refresh()
  }

  const actions = {
    passPriority: async () => { ackStackKeyRef.current = currentStackKey; await passPriorityAction(supabase, sessionId); await refresh() },
    advanceStep: async () => { await advanceStep(supabase, sessionId); await refresh() },
    // Plain cast — permanents and untargeted spells
    castSpell: async (cardId: string) => {
      await autoPay(cards.find((c) => c.id === cardId) ?? null)
      await castCardFromHand(supabase, sessionId, cardId)
      await refresh()
    },
    // Cycling: discard a hand card with a cycling cost, draw one.
    cycleCard: async (cardId: string) => {
      await cycleCard(supabase, sessionId, cardId)
      await refresh()
    },
    // Aura cast — a permanent that enters attached to the chosen creature.
    castAura: async (cardId: string, targetCardId: string) => {
      await autoPay(cards.find((c) => c.id === cardId) ?? null)
      await castCardFromHand(supabase, sessionId, cardId, undefined, targetCardId)
      await refresh()
    },
    // Equip — attach an Equipment you control onto a creature you control.
    equip: async (equipmentCardId: string, targetCardId: string) => {
      await equipAction(supabase, sessionId, equipmentCardId, targetCardId)
      await refresh()
    },
    // Cast the commander from the command zone (cost + commander tax).
    castCommander: async (cardId: string) => {
      await castCommanderAction(supabase, sessionId, cardId)
      await refresh()
    },
    // Targeted player-damage spell (Lightning Bolt etc.)
    dealDamageToPlayer: async (cardId: string, targetPlayerId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'damage') return
      let x: number | null = null
      if (plan.xRequired) { x = promptForXValue(); if (x == null) return }
      await autoPay(card)
      await putDealDamagePlayerOnStack(supabase, sessionId, targetPlayerId, plan.amount, plan.timing, cardId, undefined, x)
      await refresh()
    },
    dealDamageToCreature: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'damage') return
      let x: number | null = null
      if (plan.xRequired) { x = promptForXValue(); if (x == null) return }
      await autoPay(card)
      await putDealDamageCreatureOnStack(supabase, sessionId, targetCardId, plan.amount, plan.timing, cardId, undefined, plan.targetController, x)
      await refresh()
    },
    pumpCreature: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'pump') return
      await autoPay(card)
      await putPumpCreatureOnStack(supabase, sessionId, targetCardId, plan.power, plan.toughness, plan.timing, cardId, undefined, plan.targetController)
      await refresh()
    },
    setPtCreature: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'set_pt') return
      await autoPay(card)
      await putSetPtCreatureOnStack(supabase, sessionId, targetCardId, plan.power, plan.toughness, plan.timing, cardId, undefined, plan.targetController)
      await refresh()
    },
    addCountersCreature: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'add_counters') return
      let x: number | null = null
      if (plan.xRequired) { x = promptForXValue(); if (x == null) return }
      await autoPay(card)
      await putAddCountersCreatureOnStack(supabase, sessionId, targetCardId, plan.amount, plan.timing, cardId, undefined, plan.targetController, x, plan.counterType, plan.all)
      await refresh()
    },
    // Targeted creature effect — destroy / bounce / tap / untap
    creatureEffect: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'creature_effect') return
      await autoPay(card)
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
      await autoPay(card)
      await castMultiCreatureEffect(supabase, sessionId, plan.effectKind, targetCardIds, plan.timing, cardId, undefined, plan.targetController)
      await refresh()
    },
    // Non-creature permanent removal — destroy/exile/… a target artifact/enchantment/…
    permanentEffect: async (cardId: string, targetCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'permanent_effect') return
      await autoPay(card)
      await castPermanentEffect(supabase, sessionId, plan.effectKind, targetCardId, plan.targetType, plan.timing, cardId, undefined, plan.targetController, plan.then, plan.controllerSearchesBasicLand)
      await refresh()
    },
    // Divided damage — allocate the total across the chosen creature/player targets.
    dividedDamage: async (cardId: string, allocations: DamageAllocation[]) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'divided_damage' || allocations.length === 0) return
      await autoPay(card)
      await castDividedDamage(supabase, sessionId, plan.amount, allocations, plan.timing, cardId, undefined, plan.targetController)
      await refresh()
    },
    // Fight spell — a creature you control (fighter) fights another creature (fought).
    fight: async (cardId: string, fighterCardId: string, foughtCardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'fight') return
      await autoPay(card)
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
      await autoPay(card)
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
      await autoPay(card)
      await castSpellEffect(supabase, sessionId, plan.actions, cardId, x)
      await refresh()
    },
    // Modal spell — cast the card's modes; the choose_mode decision UI does the rest.
    modalSpell: async (cardId: string) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const plan = card ? getSpellPlan(card) : null
      if (!card || plan?.kind !== 'modal') return
      await autoPay(card)
      await castModalSpell(supabase, sessionId, plan.modes, plan.choose, cardId)
      await refresh()
    },
    // Counterspell targeting a specific pending stack item
    counterSpell: async (cardId: string, stackItemId: string) => {
      await autoPay(cards.find((c) => c.id === cardId) ?? null)
      await putCounterSpellOnStack(supabase, sessionId, stackItemId, cardId)
      await refresh()
    },
    // Adventure (mig 295/296): cast a card's adventure half. The card is exiled
    // with a permanent play_from_exile permission so the creature face can be
    // cast from exile later. A counter adventure routes through the counter path
    // (stack target); everything else through cast_spell_effect (optional
    // permanent target), both with the adventure flag set.
    castAdventure: async (
      cardId: string,
      opts: { targetCardId?: string | null; stackItemId?: string | null } = {},
    ) => {
      const card = cards.find((c) => c.id === cardId) ?? null
      const script = card ? normalizeCardBehaviorToV2(card.copied_script ?? card.cards?.script ?? null, card.cards?.type_line) : null
      const actions = script?.adventure?.spell_effect?.actions
      if (!actions || actions.length === 0) return
      const isCounter = actions.some((a) => (a as { type?: string }).type === 'counter')
      if (isCounter && opts.stackItemId) {
        await putCounterSpellOnStack(supabase, sessionId, opts.stackItemId, cardId, undefined, true)
      } else {
        await castSpellEffect(supabase, sessionId, actions, cardId, null, opts.targetCardId ?? null, true)
      }
      await refresh()
    },
    activateAbility: async (
      sourceCardId: string,
      abilityIndex: number,
      target?: { targetCardId?: string | null; targetPlayerId?: string | null; costCardIds?: string[] | null },
    ) => {
      await activateAbility(supabase, sessionId, sourceCardId, abilityIndex, target)
      await refresh()
    },
    activateLoyalty: async (sourceCardId: string, abilityIndex: number) => {
      await activateLoyaltyAbility(supabase, sessionId, sourceCardId, abilityIndex)
      await refresh()
    },
    activateManaAbility: async (sourceCardId: string, abilityIndex: number) => {
      await activateManaAbility(supabase, sessionId, sourceCardId, abilityIndex)
      await refresh()
    },
    tapForMana,
    declareAttacker: async (cardId: string, target: { playerId?: string; planeswalkerId?: string }) => {
      await declareAttackerAction(supabase, sessionId, cardId, target.playerId ?? null, target.planeswalkerId ?? null)
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
              opponentPlaneswalkers={opponentPlaneswalkers}
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
              commanderDamage={playerId ? commanderDamage[playerId] : undefined}
              onOpenHelp={() => setCoachOpen(true)}
            />
            {/* Command zone — cast your commander (sorcery speed) with live tax. */}
            {commandZone.length > 0 && (
              <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-amber-500/20 bg-amber-500/[0.06] px-3 py-2">
                <span className="shrink-0 text-[10px] font-black uppercase tracking-widest text-amber-400">
                  Command
                </span>
                {commandZone.map((c) => {
                  const tax = 2 * (c.command_zone_casts ?? 0)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!canCastSorceries}
                      onClick={() => { void actions.castCommander(c.id) }}
                      title={canCastSorceries ? 'Cast your commander' : 'Sorcery speed: your main phase, empty stack'}
                      className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-bold transition active:scale-95 ${
                        canCastSorceries ? 'bg-amber-400 text-amber-950' : 'cursor-not-allowed bg-slate-700 text-slate-300 opacity-70'
                      }`}
                    >
                      <span className="max-w-[120px] truncate">{c.name}</span>
                      <ManaCostDisplay manaCost={c.cards?.mana_cost} dark={canCastSorceries} />
                      {tax > 0 && <span className="rounded bg-black/20 px-1">+{tax} tax</span>}
                    </button>
                  )
                })}
              </div>
            )}
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
                availableByColor={availableByColor}
                flexibleMana={flexibleMana}
                canPlayLand={canPlayLand}
                mustDiscard={mustDiscard}
                discardCount={discardCount}
                combatAssignments={combatAssignments}
                attackTaxes={attackTaxes}
                commanderDamage={commanderDamage}
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
                autoPass={autoPass}
                onChangeAutoPass={updateAutoPass}
                isYielding={isYielding}
                onYieldTurn={yieldRestOfTurn}
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
            commanderIdentity={commanderIdentityColors(cards)}
            onTapForMana={async (cardId, color) => { await actions.tapForMana(cardId, color) }}
            onCastCard={async (cardId) => { await actions.castSpell(cardId) }}
            onCycleCard={async (cardId) => { await actions.cycleCard(cardId) }}
            onDealDamageToPlayer={async (cardId, targetPlayerId) => { await actions.dealDamageToPlayer(cardId, targetPlayerId) }}
            onDealDamageToCreature={async (cardId, targetCardId) => { await actions.dealDamageToCreature(cardId, targetCardId) }}
            onPumpCreature={async (cardId, targetCardId) => { await actions.pumpCreature(cardId, targetCardId) }}
            onSetPtCreature={async (cardId, targetCardId) => { await actions.setPtCreature(cardId, targetCardId) }}
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
            onCastAdventure={async (cardId, opts) => { await actions.castAdventure(cardId, opts) }}
            onActivateAbility={async (sourceId, abilityIndex, target) => { await actions.activateAbility(sourceId, abilityIndex, target) }}
            onActivateManaAbility={async (sourceId, abilityIndex) => { await actions.activateManaAbility(sourceId, abilityIndex) }}
            onActivateLoyalty={async (sourceId, abilityIndex) => { await actions.activateLoyalty(sourceId, abilityIndex) }}
            onCastAura={async (cardId, targetCardId) => { await actions.castAura(cardId, targetCardId) }}
            onEquip={async (cardId, targetCardId) => { await actions.equip(cardId, targetCardId) }}
            onClose={() => setSelectedCard(null)}
          />
        )}
      </AnimatePresence>

      {/* Opening-hand overlay — keep/mulligan until every player has kept */}
      {currentPlayer && playersNotKept.length > 0 && (
        <OpeningHandOverlay
          handCards={handCards.map((c) => ({ id: c.id, name: c.name }))}
          mulligans={currentPlayer.mulligans ?? 0}
          waitingFor={openingHandWaitingFor}
          kept={currentPlayer.opening_hand_kept !== false}
          onKeep={async (bottomIds) => {
            await keepOpeningHand(supabase, sessionId, bottomIds)
            await refresh()
          }}
          onMulligan={async () => {
            await mulliganHand(supabase, sessionId)
            await refresh()
          }}
        />
      )}

      {coachOpen && <ControllerCoachOverlay onClose={closeCoach} />}

      {errorMessage && (
        <div className="absolute inset-x-3 bottom-4 z-[60] rounded-lg border border-red-400/20 bg-red-950/90 p-3 text-xs text-red-100">
          {errorMessage}
        </div>
      )}
    </div>
  )
}

// Commander damage taken (Commander: 21 from one commander is lethal). Shows the
// worst single-commander total, coloured by danger; tooltip lists every source.
function CommanderDamageBadge({ entries }: { entries: CommanderDamageEntry[] | undefined }) {
  if (!entries || entries.length === 0) return null
  const worst = Math.max(...entries.map((e) => e.damage))
  const tone = worst >= 21 ? 'bg-red-500/30 text-red-200' : worst >= 15 ? 'bg-amber-500/20 text-amber-300' : 'text-orange-300'
  return (
    <span
      className={`rounded px-1 text-[10px] font-black ${tone}`}
      title={`Commander damage taken:\n${entries
        .map((e) => `${e.name}: ${e.damage}/21${e.damage >= 21 ? ' — LETHAL' : ''}`)
        .join('\n')}`}
    >
      ⚔{worst}
    </span>
  )
}

// ─── Status Bar ───────────────────────────────────────────────────────────────

function StatusBar({
  currentPlayer,
  turnState,
  manaPool,
  isActivePlayer,
  libraryCount,
  commanderDamage,
  onOpenHelp,
}: {
  currentPlayer: GameSessionPlayer | null
  turnState: GameTurnState | null
  manaPool: ManaPool
  isActivePlayer: boolean
  libraryCount: number
  commanderDamage: CommanderDamageEntry[] | undefined
  onOpenHelp: () => void
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
        <CommanderDamageBadge entries={commanderDamage} />
        {formatCounterBag(currentPlayer?.counters).map(({ kind, n }) => (
          <span
            key={kind}
            className={`text-[9px] font-black leading-none ${kind === 'poison' ? 'text-lime-400' : 'text-amber-400'}`}
            title={`${n} ${kind} counter${n > 1 ? 's' : ''}`}
          >
            {kind === 'poison' ? `☠${n}` : `${n} ${kind}`}
          </span>
        ))}
        <button
          type="button"
          onClick={onOpenHelp}
          aria-label="How to play"
          title="How to use your controller"
          className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/15 text-[10px] font-black text-slate-400 transition active:scale-95 hover:text-slate-200"
        >
          ?
        </button>
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
  canPlayLand,
  mustDiscard,
  discardCount,
  combatAssignments,
  turnState,
  attackTaxes,
  commanderDamage,
  availableByColor,
  flexibleMana,
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
  availableByColor: Record<ManaColor, number>
  flexibleMana: number
  canPlayLand: boolean
  mustDiscard: boolean
  discardCount: number
  combatAssignments: CombatAssignment[]
  turnState: GameTurnState | null
  attackTaxes: { playerId: string; mana: number; life: number }[]
  commanderDamage: Record<string, CommanderDamageEntry[]>
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

  // Equipment/Auras attached to a permanent (game_cards.attached_to), grouped by
  // host id, plus a name lookup so each tile can show what it's wearing / what
  // it's attached to. Host may be an opponent's card (not in this set) → unnamed.
  const attachmentsByHost = new Map<string, ControllerCard[]>()
  for (const c of battlefieldCards) {
    if (!c.attached_to) continue
    const list = attachmentsByHost.get(c.attached_to) ?? []
    list.push(c)
    attachmentsByHost.set(c.attached_to, list)
  }
  const cardNameById = new Map(battlefieldCards.map((c) => [c.id, c.name]))

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
              <CommanderDamageBadge entries={commanderDamage[p.player_id]} />
              {turnState?.monarch_player_id === p.player_id && (
                <span className="text-[9px]" title="The monarch (draws at their end step; combat damage steals the crown)">👑</span>
              )}
              {(p.counters?.poison ?? 0) > 0 && (
                <span
                  className={`text-[9px] font-black ${(p.counters!.poison ?? 0) >= 3 ? 'rounded bg-lime-400/20 px-1 text-lime-300' : 'text-lime-400'}`}
                  title={`${p.counters!.poison} poison${(p.counters!.poison ?? 0) >= 3 ? ' — CORRUPTED' : ''}`}
                >☠{p.counters!.poison}</span>
              )}
              {attackTaxes.some((t) => t.playerId === p.player_id) && (
                <span
                  className="text-[9px] font-black text-amber-400"
                  title={attackTaxes.filter((t) => t.playerId === p.player_id)
                    .map((t) => (t.mana > 0 ? `pay {${t.mana}} per attacker` : `pay ${t.life} life per attacker`)).join(', ')}
                >⛔</span>
              )}
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
            {/* Host: this permanent has Equipment/Auras attached to it. */}
            {attachmentsByHost.has(card.id) && (
              <span
                className="absolute -top-1 -left-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[9px] font-black text-amber-950 shadow ring-1 ring-black/40"
                title={`Attached: ${attachmentsByHost.get(card.id)!.map((a) => a.name).join(', ')}`}
              >
                📎{attachmentsByHost.get(card.id)!.length}
              </span>
            )}
            {/* Attachment: this Equipment/Aura is attached to a host. */}
            {card.attached_to && (
              <span
                className="absolute -top-1 -left-1 rounded-full bg-sky-500 px-1.5 py-0.5 text-[9px] font-black text-sky-950 shadow ring-1 ring-black/40"
                title={`Attached to ${cardNameById.get(card.attached_to) ?? 'a permanent'}`}
              >
                🔗
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
            const canAfford = totalCost === 0 || canAffordCost(manaCost, availableByColor, flexibleMana)
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
            onCardTap={onCardTap}
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
      ) : CARD_PICK_DECISIONS.has(decision.decision_type) ? (
        <CardPickBody decision={decision} isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'confirm' ? (
        <ConfirmBody isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'choose_player' ? (
        <ChoosePlayerBody decision={decision} isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'choose_creature_type' ? (
        <ChooseWordBody decision={decision} field="type" optionKey="type" isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'vote' ? (
        <ChooseWordBody decision={decision} field="value" optionKey="value" isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'choose_color' ? (
        <ChooseColorBody isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'divide_damage' ? (
        <DivideDamageBody decision={decision} isPending={isPending} onSubmit={submit} />
      ) : decision.decision_type === 'pay_x_mana_damage' ? (
        <PayXDamageBody decision={decision} isPending={isPending} onSubmit={submit} />
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
// Every server decision in the "choose cards" family shares one contract:
// options = [{game_card_id, name}], result = {chosen: [ids]}, bounded by
// min/max_choices (see submit_decision's shared validation branch). Any new
// pick-style decision type the engine grows lands here automatically once
// added — keep this in sync with submit_decision.sql's family list.
const CARD_PICK_DECISIONS = new Set([
  'search_library', 'choose_cards', 'sacrifice', 'return_from_graveyard', 'proliferate',
  'reanimate_destroyed', 'look_top', 'copy_permanent', 'become_copy', 'bounce_pick',
  'cast_exiled_free', 'put_from_hand_pick', 'destroy_pick', 'command_zone_pick',
  'graveyard_exile_pick', 'fight_pick', 'etali_cast_pick', 'graveyard_to_top_pick',
])

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

// One-word picks sharing a shape: choose_creature_type (options [{type}],
// submit {type}) and vote (options [{value}], submit {value}).
function ChooseWordBody({
  decision,
  field,
  optionKey,
  isPending,
  onSubmit,
}: {
  decision: PendingDecision
  field: string
  optionKey: string
  isPending: boolean
  onSubmit: (result: Record<string, unknown>) => Promise<void>
}) {
  const words = (Array.isArray(decision.options) ? decision.options : []) as Record<string, string>[]
  return (
    <div className="flex flex-wrap gap-2">
      {words.map((w) => (
        <button
          key={w[optionKey]}
          type="button"
          disabled={isPending}
          onClick={() => void onSubmit({ [field]: w[optionKey] })}
          className="rounded-xl border border-indigo-400/30 bg-indigo-400/10 px-4 py-2 text-xs font-bold text-white transition active:scale-95 disabled:opacity-50"
        >
          {w[optionKey]}
        </button>
      ))}
    </div>
  )
}

// Heraldic Banner: pick one of the five colors.
function ChooseColorBody({
  isPending,
  onSubmit,
}: {
  isPending: boolean
  onSubmit: (result: Record<string, unknown>) => Promise<void>
}) {
  const COLORS: { value: string; label: string; cls: string }[] = [
    { value: 'white', label: 'White', cls: 'bg-amber-100 text-amber-900' },
    { value: 'blue', label: 'Blue', cls: 'bg-sky-400 text-sky-950' },
    { value: 'black', label: 'Black', cls: 'bg-slate-700 text-slate-100' },
    { value: 'red', label: 'Red', cls: 'bg-red-400 text-red-950' },
    { value: 'green', label: 'Green', cls: 'bg-emerald-400 text-emerald-950' },
  ]
  return (
    <div className="flex flex-wrap gap-2">
      {COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          disabled={isPending}
          onClick={() => void onSubmit({ color: c.value })}
          className={`rounded-xl px-4 py-2 text-xs font-black uppercase tracking-wide transition active:scale-95 disabled:opacity-50 ${c.cls}`}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}

// Dragonlord Atarka / Naya Charm: allocate params.amount damage across up to
// params.max_targets of the offered creatures/players. Submit shape:
// {allocations: [{game_card_id|player_id, amount}]} summing exactly to amount.
function DivideDamageBody({
  decision,
  isPending,
  onSubmit,
}: {
  decision: PendingDecision
  isPending: boolean
  onSubmit: (result: Record<string, unknown>) => Promise<void>
}) {
  const opts = (Array.isArray(decision.options) ? decision.options : []) as {
    game_card_id?: string; player_id?: string; name?: string; username?: string | null
  }[]
  const total = Number(decision.params?.amount ?? 0)
  const maxTargets = Number(decision.params?.max_targets ?? opts.length)
  const [alloc, setAlloc] = useState<Record<number, number>>({})

  const spent = Object.values(alloc).reduce((a, b) => a + b, 0)
  const targets = Object.values(alloc).filter((n) => n > 0).length
  const canConfirm = !isPending && spent === total && targets >= 1 && targets <= maxTargets

  const bump = (i: number, delta: number) =>
    setAlloc((prev) => {
      const next = Math.max(0, (prev[i] ?? 0) + delta)
      if (delta > 0 && spent >= total) return prev
      return { ...prev, [i]: next }
    })

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-slate-400">
        Divide {total} damage among up to {maxTargets} target{maxTargets === 1 ? '' : 's'} ({total - spent} left).
      </p>
      <div className="flex flex-col gap-1">
        {opts.map((o, i) => (
          <div key={o.game_card_id ?? o.player_id ?? i} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-white">{o.name ?? o.username ?? 'Player'}</span>
            <button type="button" disabled={isPending} onClick={() => bump(i, -1)}
              className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 active:scale-95">−</button>
            <span className="w-5 text-center text-xs font-bold text-indigo-300">{alloc[i] ?? 0}</span>
            <button type="button" disabled={isPending} onClick={() => bump(i, 1)}
              className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 active:scale-95">+</button>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={!canConfirm}
        onClick={() => void onSubmit({
          allocations: opts
            .map((o, i) => ({ o, n: alloc[i] ?? 0 }))
            .filter(({ n }) => n > 0)
            .map(({ o, n }) => (o.game_card_id ? { game_card_id: o.game_card_id, amount: n } : { player_id: o.player_id, amount: n })),
        })}
        className="self-start rounded-xl bg-indigo-400 px-4 py-2 text-xs font-black uppercase tracking-wide text-indigo-950 transition active:scale-95 disabled:opacity-40"
      >
        Deal damage
      </button>
    </div>
  )
}

// Leyline Tyrant: pay any amount of the parked color, deal that much damage
// to one offered target. Amount 0 declines.
function PayXDamageBody({
  decision,
  isPending,
  onSubmit,
}: {
  decision: PendingDecision
  isPending: boolean
  onSubmit: (result: Record<string, unknown>) => Promise<void>
}) {
  const opts = (Array.isArray(decision.options) ? decision.options : []) as {
    game_card_id?: string; player_id?: string; name?: string; username?: string | null
  }[]
  const color = String(decision.params?.color ?? 'R')
  const [amount, setAmount] = useState(0)
  const [picked, setPicked] = useState(0)

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-slate-400">Pay any amount of {'{'}{color}{'}'} — that much damage. 0 declines.</p>
      <div className="flex items-center gap-2">
        <button type="button" disabled={isPending} onClick={() => setAmount((n) => Math.max(0, n - 1))}
          className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 active:scale-95">−</button>
        <span className="w-5 text-center text-xs font-bold text-indigo-300">{amount}</span>
        <button type="button" disabled={isPending} onClick={() => setAmount((n) => n + 1)}
          className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 active:scale-95">+</button>
      </div>
      {amount > 0 && (
        <div className="flex flex-wrap gap-2">
          {opts.map((o, i) => (
            <button key={o.game_card_id ?? o.player_id ?? i} type="button" disabled={isPending}
              onClick={() => setPicked(i)}
              className={`rounded-xl border px-3 py-1.5 text-[11px] font-bold transition active:scale-95 ${i === picked ? 'border-indigo-300 bg-indigo-400/30 text-white' : 'border-slate-600 text-slate-300'}`}>
              {o.name ?? o.username ?? 'Player'}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={isPending || (amount > 0 && !opts[picked])}
        onClick={() => void onSubmit(
          amount === 0
            ? { amount: 0 }
            : { amount, ...(opts[picked]?.game_card_id ? { game_card_id: opts[picked]!.game_card_id } : { player_id: opts[picked]?.player_id }) },
        )}
        className="self-start rounded-xl bg-indigo-400 px-4 py-2 text-xs font-black uppercase tracking-wide text-indigo-950 transition active:scale-95 disabled:opacity-40"
      >
        {amount === 0 ? 'Decline' : `Pay ${amount} and deal ${amount}`}
      </button>
    </div>
  )
}

const AUTOPASS_ROWS: { key: keyof AutoPassSettings; label: string; hint: string }[] = [
  { key: 'op', label: "Opp. turns", hint: "Auto-pass priority during opponents' turns" },
  { key: 'own', label: 'My empty phases', hint: 'Auto-pass your untap/upkeep/draw/combat-begin/end steps' },
  { key: 'stk', label: 'Stop on stack', hint: "Stop when a new object hits an opponent's stack" },
  { key: 'rsp', label: 'Stop if I can act', hint: 'Stop when you hold a castable instant or ability' },
]

function PriorityPanel({
  hasPriority,
  isSessionFinished,
  canResolveCombatDamage,
  combatDamageStage,
  blockPassReason,
  autoPass,
  onChangeAutoPass,
  isYielding,
  onYieldTurn,
  onResolveCombatDamage,
  onPassPriority,
}: {
  hasPriority: boolean
  isSessionFinished: boolean
  canResolveCombatDamage: boolean
  combatDamageStage: string | null
  blockPassReason?: string | null
  autoPass: AutoPassSettings
  onChangeAutoPass: (patch: Partial<AutoPassSettings>) => void
  isYielding: boolean
  onYieldTurn: () => void
  onResolveCombatDamage: () => Promise<void>
  onPassPriority: () => Promise<void>
}) {
  const [isPending, setIsPending] = useState(false)
  const [autoOpen, setAutoOpen] = useState(false)
  const anyAutoOn = autoPass.op || autoPass.own || autoPass.stk || autoPass.rsp
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

      <div className="relative w-full">
        <button
          type="button"
          onClick={() => setAutoOpen((v) => !v)}
          title="Auto-pass settings. Never skips your decisions, trigger targets or blocks."
          className={`w-full rounded-xl border px-1 py-2 text-[8px] font-black uppercase tracking-widest transition active:scale-95 ${
            isYielding
              ? 'border-sky-300/60 bg-sky-400/20 text-sky-300'
              : anyAutoOn
                ? 'border-amber-300/60 bg-amber-400/20 text-amber-300'
                : 'border-[#1E2230] text-slate-600'
          }`}
        >
          Auto{isYielding ? ' »' : anyAutoOn ? ' ✓' : ''}
        </button>

        {autoOpen && (
          <>
            {/* click-away */}
            <div className="fixed inset-0 z-40" onClick={() => setAutoOpen(false)} />
            <div className="absolute right-full top-0 z-50 mr-2 w-44 rounded-2xl border border-[#1E2230] bg-[#0C0E14] p-2 shadow-xl">
              <p className="px-1 pb-1 text-[8px] font-black uppercase tracking-widest text-slate-500">Auto-pass</p>
              {AUTOPASS_ROWS.map((row) => {
                const on = autoPass[row.key]
                return (
                  <button
                    key={row.key}
                    type="button"
                    onClick={() => onChangeAutoPass({ [row.key]: !on })}
                    title={row.hint}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition active:scale-95 hover:bg-white/5"
                  >
                    <span className={`text-[10px] font-semibold ${on ? 'text-amber-300' : 'text-slate-400'}`}>{row.label}</span>
                    <span
                      className={`flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors ${on ? 'bg-amber-400/80' : 'bg-slate-700'}`}
                    >
                      <span className={`h-3 w-3 rounded-full bg-white transition-transform ${on ? 'translate-x-3' : ''}`} />
                    </span>
                  </button>
                )
              })}
              <button
                type="button"
                onClick={() => { onYieldTurn(); setAutoOpen(false) }}
                title="Pass every priority until your next turn"
                className={`mt-1 w-full rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition active:scale-95 ${
                  isYielding ? 'border-sky-300/60 bg-sky-400/20 text-sky-300' : 'border-[#1E2230] text-slate-400 hover:bg-white/5'
                }`}
              >
                {isYielding ? 'Yielding…' : 'Yield rest of turn'}
              </button>
            </div>
          </>
        )}
      </div>

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
  onCardTap,
}: {
  graveyard: ControllerCard[]
  exile: ControllerCard[]
  initialTab: MyZoneTab
  onClose: () => void
  // Tapping a graveyard card with an action (e.g. flashback) opens its action
  // sheet; closes this zone sheet so the action sheet is visible.
  onCardTap: (card: ControllerCard) => void
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
                    {graveyard.map((card) => {
                      // A card with a flashback cost is castable from here — make it
                      // tappable (opens its action sheet) and badge it.
                      const hasFlashback = !!normalizeCardBehaviorToV2(
                        card.copied_script ?? card.cards?.script ?? null,
                        card.cards?.type_line,
                      ).flashback
                      return (
                        <div key={card.id} className="w-[60px]">
                          <button
                            type="button"
                            disabled={!hasFlashback}
                            onClick={() => { onCardTap(card); onClose() }}
                            className={`relative block w-full ${hasFlashback ? 'active:scale-95' : 'cursor-default'}`}
                          >
                            <MotionCard
                              card={{ id: card.id, name: card.name, image_url: card.cards?.image_url, is_tapped: false, damage_marked: 0, zone: card.zone }}
                              size="board" useLayoutId={false} className="w-full"
                            />
                            {hasFlashback && (
                              <span className="absolute -right-1 -top-1 rounded-full bg-purple-400 px-1 text-[8px] font-black text-purple-950">
                                FB
                              </span>
                            )}
                          </button>
                        </div>
                      )
                    })}
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
  opponentPlaneswalkers,
  turnState,
  errorMessage,
  onDeclareAttacker,
  onPassPriority,
}: {
  ownCreatures: ControllerCard[]
  opponentPlayers: GameSessionPlayer[]
  opponentPlaneswalkers: { id: string; name: string; loyalty: number }[]
  turnState: GameTurnState | null
  errorMessage: string | null
  onDeclareAttacker: (cardId: string, target: { playerId?: string; planeswalkerId?: string }) => Promise<void>
  onPassPriority: () => Promise<void>
}) {
  const untappedCreatures = ownCreatures.filter((c) => !c.is_tapped)
  // Attackable targets: each opponent player + each opponent planeswalker.
  const targets: { kind: 'player' | 'planeswalker'; id: string; label: string; sub: string }[] = [
    ...opponentPlayers.map((p) => ({ kind: 'player' as const, id: p.player_id, label: p.username ?? `Player ${p.seat_number}`, sub: `♥ ${p.life_total}` })),
    ...opponentPlaneswalkers.map((pw) => ({ kind: 'planeswalker' as const, id: pw.id, label: pw.name, sub: `◆ ${pw.loyalty}` })),
  ]
  const [selectedTargetId, setSelectedTargetId] = useState<string>(targets[0]?.id ?? '')
  const selectedTarget = targets.find((t) => t.id === selectedTargetId) ?? targets[0] ?? null
  const [attackers, setAttackers] = useState<Set<string>>(new Set())
  const [isPending, setIsPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const attackingCount = attackers.size

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
    setAttackers((prev) => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }

  const submit = async () => {
    if (!selectedTarget) return
    setIsPending(true)
    setLocalError(null)
    try {
      const target = selectedTarget.kind === 'planeswalker'
        ? { planeswalkerId: selectedTarget.id }
        : { playerId: selectedTarget.id }
      for (const cardId of attackers) {
        await onDeclareAttacker(cardId, target)
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

      {/* Attack target — an opponent player or one of their planeswalkers */}
      {targets.length > 0 && (
        <div className="shrink-0 border-b border-[#2A2D38] bg-[#0A0B14] px-3 py-2">
          <p className="mb-1.5 px-2 text-[9px] uppercase tracking-widest text-slate-500">Attacking</p>
          <div className="flex gap-2 overflow-x-auto">
            {targets.map((t) => {
              const active = t.id === selectedTargetId
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedTargetId(t.id)}
                  className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 transition active:scale-95 ${
                    active ? 'border-[#D4591A] bg-[#D4591A]/10' : 'border-[#2A2D38] bg-[#131720]'
                  }`}
                >
                  <span className="text-[8px] uppercase tracking-wider text-slate-500">{t.kind === 'planeswalker' ? 'PW' : 'Player'}</span>
                  <span className="text-xs font-black text-white">{t.label}</span>
                  <span className="text-[11px] font-bold text-slate-300">{t.sub}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Creature grid */}
      <div className="flex min-h-0 flex-1 items-center gap-3 overflow-x-auto bg-[#0C0F14] px-5 py-3">
        {untappedCreatures.length === 0 ? (
          <p className="text-sm text-slate-600">No untapped creatures available.</p>
        ) : (
          untappedCreatures.map((card) => {
            const attackable = isAttackable(card)
            const isAttacking = attackers.has(card.id)
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
                {card.animated && (
                  <span className="text-[9px] font-black text-amber-300" title="Animated: this land is a creature until end of turn">⚡</span>
                )}
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
  // B gate: a creature can't block an attacker that has protection from its colour.
  const selectedAttackerCard = selectedAttackerId
    ? boardCards.find((c) => c.id === selectedAttackerId)
    : null
  const attackerProtection = selectedAttackerCard?.protection_colors ?? []
  const cannotBlockSelected = (blocker: ControllerCard) =>
    manaCostColors(blocker.cards?.mana_cost).some((col) => attackerProtection.includes(col))
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
            // Protection: this creature can't block the selected attacker (its colour).
            const cannotBlock = !isBlocking && Boolean(selectedAttackerId) && cannotBlockSelected(card)

            return (
              <motion.button
                key={card.id}
                type="button"
                disabled={cannotBlock}
                onClick={() => { if (!cannotBlock) assignBlocker(card.id) }}
                whileTap={cannotBlock ? undefined : { scale: 0.94 }}
                title={cannotBlock ? 'Has protection — can’t be blocked by this creature' : undefined}
                className={`flex w-16 shrink-0 flex-col items-center gap-1 rounded-xl border-2 p-1.5 transition-colors ${
                  isBlocking
                    ? 'border-cyan-400 bg-cyan-400/10'
                    : cannotBlock
                      ? 'cursor-not-allowed border-[#2A2D38] bg-[#0A0C14] opacity-30'
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
                {card.animated && (
                  <span className="text-[9px] font-black text-amber-300" title="Animated: this land is a creature until end of turn">⚡</span>
                )}
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
