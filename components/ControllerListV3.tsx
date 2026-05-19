'use client'

import { useMemo, useState } from 'react'
import {
  addManaFromCard,
  advanceStep,
  castCardFromHand,
  declareAttacker as declareAttackerAction,
  declareBlocker as declareBlockerAction,
  passPriority as passPriorityAction,
} from '@/lib/game/actions'
import { isAddManaBehaviorAction, selectFirstManaAbility } from '@/lib/game/card-behavior'
import { canCardRespond, isLandCard } from '@/lib/game/controller-selectors'
import { useControllerGameState } from '@/lib/game/use-controller-game-state'
import type {
  BoardCard,
  CombatAssignment,
  ControllerCard,
  GameSessionPlayer,
  GameTurnState,
  ManaColor,
  ManaPool,
  StackItem,
} from '@/lib/game/types'

export enum GamePhase {
  Untap = 'untap',
  Upkeep = 'upkeep',
  Draw = 'draw',
  PreCombatMain = 'precombat_main',
  BeginningOfCombat = 'beginning_of_combat',
  DeclareAttackers = 'declare_attackers',
  DeclareBlockers = 'declare_blockers',
  CombatDamage = 'combat_damage',
  EndOfCombat = 'end_of_combat',
  PostCombatMain = 'postcombat_main',
  End = 'end',
  Cleanup = 'cleanup',
}

export enum PriorityState {
  HasPriority = 'has_priority',
  WaitingForOpponent = 'waiting_for_opponent',
  NoPriority = 'no_priority',
}

export enum ControllerLayoutState {
  MainPhase = 'main_phase',
  DeclareAttackers = 'declare_attackers',
  DeclareBlockers = 'declare_blockers',
  StackActive = 'stack_active',
  Default = 'default',
}

export type ZoneCounters = {
  libraryCount: number
  graveyardCardIds: string[]
  exileCardIds: string[]
}

export type ControllerV3Actions = {
  passPriority: () => Promise<void>
  respondWithInstantOrAbility: (cardId: string) => Promise<void>
  castSpell: (cardId: string) => Promise<void>
  tapForMana: (cardId: string, color?: ManaColor) => Promise<void>
  declareAttacker: (cardId: string, targetPlayerId: string) => Promise<void>
  declareBlocker: (blockerCardId: string, attackingCardId: string) => Promise<void>
  submitPhaseAction: () => Promise<void>
}

export type ControllerV3State = {
  currentPhase: GamePhase | null
  priorityState: PriorityState
  layoutState: ControllerLayoutState
  hasPriority: boolean
  currentPlayerId: string | null
  activePlayerId: string | null
  currentPlayer: GameSessionPlayer | null
  opponentPlayers: GameSessionPlayer[]
  handCards: ControllerCard[]
  battlefieldCards: ControllerCard[]
  ownCreatures: ControllerCard[]
  ownLands: ControllerCard[]
  opponentBattlefieldCards: BoardCard[]
  incomingAttackers: CombatAssignment[]
  stackItems: StackItem[]
  responseCards: ControllerCard[]
  manaPool: ManaPool
  zoneCounters: ZoneCounters
  isSessionFinished: boolean
  errorMessage: string | null
}

const manaColors: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']

export default function ControllerListV3({ sessionId }: { sessionId: string }) {
  const {
    supabase,
    cards,
    boardCards,
    players,
    turnState,
    combatAssignments,
    stackItems,
    manaPool,
    playerId,
    isSessionFinished,
    isLoading,
    errorMessage,
    setErrorMessage,
    refresh,
  } = useControllerGameState(sessionId)

  const state = useMemo(
    () =>
      buildControllerV3State({
        cards,
        boardCards,
        players,
        playerId,
        turnState,
        combatAssignments,
        stackItems,
        manaPool,
        isSessionFinished,
        errorMessage,
      }),
    [
      boardCards,
      cards,
      combatAssignments,
      errorMessage,
      isSessionFinished,
      manaPool,
      playerId,
      players,
      stackItems,
      turnState,
    ],
  )

  const actions: ControllerV3Actions = {
    passPriority: async () => {
      await passPriorityAction(supabase, sessionId)
      await refresh()
    },
    respondWithInstantOrAbility: async (cardId) => {
      await castCardFromHand(supabase, sessionId, cardId)
      await refresh()
    },
    castSpell: async (cardId) => {
      await castCardFromHand(supabase, sessionId, cardId)
      await refresh()
    },
    tapForMana: async (cardId, color) => {
      if (!playerId) {
        setErrorMessage('Cannot add mana without a current player.')
        return
      }

      const card = state.battlefieldCards.find((battlefieldCard) => battlefieldCard.id === cardId)
      const script = card?.copied_script ?? card?.cards?.script ?? null
      const ability = selectFirstManaAbility(script, card?.cards?.type_line, color)
      const manaEffect = ability?.effects.find(
        (effect) => isAddManaBehaviorAction(effect) && (!color || effect.color === color),
      )

      if (!card || !ability || !manaEffect || !isAddManaBehaviorAction(manaEffect)) {
        setErrorMessage('No mana ability found for this card.')
        return
      }

      await addManaFromCard({
        supabase,
        cardId,
        sessionId,
        playerId,
        color: manaEffect.color,
        amount: manaEffect.amount,
        shouldTapCard: ability.costs.some((cost) => cost.type === 'tap_self'),
      })
      await refresh()
    },
    declareAttacker: async (cardId, targetPlayerId) => {
      await declareAttackerAction(supabase, sessionId, cardId, targetPlayerId)
      await refresh()
    },
    declareBlocker: async (blockerCardId, attackingCardId) => {
      await declareBlockerAction(supabase, sessionId, blockerCardId, attackingCardId)
      await refresh()
    },
    submitPhaseAction: async () => {
      await advanceStep(supabase, sessionId)
      await refresh()
    },
  }

  if (isLoading) {
    return <ControllerLoadingState />
  }

  return <ControllerV3Switcher state={state} actions={actions} />
}

export function ControllerV3Switcher({
  state,
  actions,
}: {
  state: ControllerV3State
  actions: ControllerV3Actions
}) {
  if (state.isSessionFinished) {
    return <ControllerFinishedState state={state} />
  }

  if (state.layoutState === ControllerLayoutState.StackActive) {
    return <StackActiveLayout state={state} actions={actions} />
  }

  if (state.layoutState === ControllerLayoutState.DeclareAttackers) {
    return <DeclareAttackersLayout state={state} actions={actions} />
  }

  if (state.layoutState === ControllerLayoutState.DeclareBlockers) {
    return <DeclareBlockersLayout state={state} actions={actions} />
  }

  if (state.layoutState === ControllerLayoutState.MainPhase) {
    return <MainPhaseLayout state={state} actions={actions} />
  }

  return <DefaultControllerLayout state={state} actions={actions} />
}

function MainPhaseLayout({
  state,
  actions,
}: {
  state: ControllerV3State
  actions: ControllerV3Actions
}) {
  return (
    <main>
      <ControllerStateHeader state={state} />
      <ZoneDataIndicators counters={state.zoneCounters} />
      <ManaPoolComponent manaPool={state.manaPool} onTapForMana={actions.tapForMana} lands={state.ownLands} />
      <HandZoneComponent cards={state.handCards} onCastSpell={actions.castSpell} />
      <BattlefieldZoneComponent cards={state.battlefieldCards} onTapForMana={actions.tapForMana} />
    </main>
  )
}

function DeclareAttackersLayout({
  state,
  actions,
}: {
  state: ControllerV3State
  actions: ControllerV3Actions
}) {
  const [assignments, setAssignments] = useState<Record<string, string>>({})
  const attackableCreatures = state.ownCreatures.filter((card) => !card.is_tapped)

  const submitAttackers = async () => {
    for (const [cardId, targetPlayerId] of Object.entries(assignments)) {
      if (targetPlayerId) {
        await actions.declareAttacker(cardId, targetPlayerId)
      }
    }

    await actions.submitPhaseAction()
  }

  return (
    <main>
      <ControllerStateHeader state={state} />
      <ZoneDataIndicators counters={state.zoneCounters} />
      <section>
        <h2>Declare Attackers</h2>
        <ul>
          {attackableCreatures.map((card) => (
            <li key={card.id}>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(assignments[card.id])}
                  onChange={(event) => {
                    setAssignments((current) => {
                      const next = { ...current }
                      if (event.target.checked) {
                        next[card.id] = state.opponentPlayers[0]?.player_id ?? ''
                      } else {
                        delete next[card.id]
                      }
                      return next
                    })
                  }}
                />
                {card.name}
              </label>
              <select
                value={assignments[card.id] ?? ''}
                disabled={!assignments[card.id]}
                onChange={(event) =>
                  setAssignments((current) => ({
                    ...current,
                    [card.id]: event.target.value,
                  }))
                }
              >
                <option value="">No target</option>
                {state.opponentPlayers.map((player) => (
                  <option key={player.player_id} value={player.player_id}>
                    {getPlayerLabel(player)}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
        <button type="button" onClick={submitAttackers}>
          Lock Attackers & Submit
        </button>
      </section>
    </main>
  )
}

function DeclareBlockersLayout({
  state,
  actions,
}: {
  state: ControllerV3State
  actions: ControllerV3Actions
}) {
  const [blockAssignments, setBlockAssignments] = useState<Record<string, string>>({})
  const blockableCreatures = state.ownCreatures.filter((card) => !card.is_tapped)

  const submitBlockers = async () => {
    for (const [blockerCardId, attackingCardId] of Object.entries(blockAssignments)) {
      if (attackingCardId) {
        await actions.declareBlocker(blockerCardId, attackingCardId)
      }
    }

    await actions.submitPhaseAction()
  }

  return (
    <main>
      <ControllerStateHeader state={state} />
      <ZoneDataIndicators counters={state.zoneCounters} />
      <section>
        <h2>Incoming Attackers</h2>
        <ul>
          {state.incomingAttackers.map((assignment) => (
            <li key={assignment.id}>
              {assignment.attacker_name} attacking {assignment.defending_username}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Assign Blockers</h2>
        <ul>
          {blockableCreatures.map((card) => (
            <li key={card.id}>
              <label htmlFor={`block-${card.id}`}>{card.name}</label>
              <select
                id={`block-${card.id}`}
                value={blockAssignments[card.id] ?? ''}
                onChange={(event) =>
                  setBlockAssignments((current) => ({
                    ...current,
                    [card.id]: event.target.value,
                  }))
                }
              >
                <option value="">No block</option>
                {state.incomingAttackers.map((assignment) => (
                  <option key={assignment.id} value={assignment.attacker_card_id}>
                    {assignment.attacker_name}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
        <button type="button" onClick={submitBlockers}>
          Lock Blockers & Submit
        </button>
      </section>
    </main>
  )
}

function StackActiveLayout({
  state,
  actions,
}: {
  state: ControllerV3State
  actions: ControllerV3Actions
}) {
  return (
    <main>
      <ControllerStateHeader state={state} />
      <ZoneDataIndicators counters={state.zoneCounters} />
      <StackComponent stackItems={state.stackItems} />
      <PriorityButton
        hasPriority={state.hasPriority}
        responseCards={state.responseCards}
        onPassPriority={actions.passPriority}
        onRespondWithInstantOrAbility={actions.respondWithInstantOrAbility}
      />
    </main>
  )
}

function DefaultControllerLayout({
  state,
  actions,
}: {
  state: ControllerV3State
  actions: ControllerV3Actions
}) {
  return (
    <main>
      <ControllerStateHeader state={state} />
      <ZoneDataIndicators counters={state.zoneCounters} />
      <HandZoneComponent cards={state.handCards} onCastSpell={actions.castSpell} />
      <BattlefieldZoneComponent cards={state.battlefieldCards} onTapForMana={actions.tapForMana} />
    </main>
  )
}

function ControllerFinishedState({ state }: { state: ControllerV3State }) {
  return (
    <main>
      <ControllerStateHeader state={state} />
      <p>Game finished.</p>
    </main>
  )
}

function ControllerLoadingState() {
  return <p>Loading controller...</p>
}

function ControllerStateHeader({ state }: { state: ControllerV3State }) {
  return (
    <header>
      <h1>Controller V3</h1>
      <p>Player: {state.currentPlayer ? getPlayerLabel(state.currentPlayer) : 'Unknown'}</p>
      <p>Phase: {state.currentPhase ?? 'unknown'}</p>
      <p>Priority: {state.priorityState}</p>
      {state.errorMessage ? <p>{state.errorMessage}</p> : null}
    </header>
  )
}

function ZoneDataIndicators({ counters }: { counters: ZoneCounters }) {
  return (
    <section>
      <h2>Zones</h2>
      <dl>
        <dt>Library</dt>
        <dd>{counters.libraryCount}</dd>
        <dt>Graveyard</dt>
        <dd>{counters.graveyardCardIds.length}</dd>
        <dt>Exile</dt>
        <dd>{counters.exileCardIds.length}</dd>
      </dl>
    </section>
  )
}

function ManaPoolComponent({
  manaPool,
  lands,
  onTapForMana,
}: {
  manaPool: ManaPool
  lands: ControllerCard[]
  onTapForMana: (cardId: string, color?: ManaColor) => Promise<void>
}) {
  return (
    <section>
      <h2>Mana Pool</h2>
      <ul>
        {manaColors.map((color) => (
          <li key={color}>
            {color}: {manaPool[color] ?? 0}
          </li>
        ))}
      </ul>
      <h3>Mana Sources</h3>
      <ul>
        {lands.map((card) => (
          <li key={card.id}>
            <button type="button" disabled={card.is_tapped} onClick={() => onTapForMana(card.id)}>
              Tap {card.name}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function HandZoneComponent({
  cards,
  onCastSpell,
}: {
  cards: ControllerCard[]
  onCastSpell: (cardId: string) => Promise<void>
}) {
  return (
    <section>
      <h2>Hand</h2>
      <ul>
        {cards.map((card) => (
          <li key={card.id}>
            <article>
              <h3>{card.name}</h3>
              <p>{card.cards?.mana_cost ?? 'No cost'}</p>
              <p>{card.cards?.type_line ?? 'Card'}</p>
              <button type="button" onClick={() => onCastSpell(card.id)}>
                Cast
              </button>
            </article>
          </li>
        ))}
      </ul>
    </section>
  )
}

function BattlefieldZoneComponent({
  cards,
  onTapForMana,
}: {
  cards: ControllerCard[]
  onTapForMana: (cardId: string, color?: ManaColor) => Promise<void>
}) {
  return (
    <section>
      <h2>Battlefield</h2>
      <ul>
        {cards.map((card) => (
          <li key={card.id}>
            <article>
              <h3>{card.name}</h3>
              <p>{card.is_tapped ? 'Tapped' : 'Untapped'}</p>
              <p>{card.damage_marked} damage</p>
              {isLandCard(card) ? (
                <button type="button" disabled={card.is_tapped} onClick={() => onTapForMana(card.id)}>
                  Tap for mana
                </button>
              ) : null}
            </article>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StackComponent({ stackItems }: { stackItems: StackItem[] }) {
  return (
    <section>
      <h2>Stack</h2>
      <ol>
        {stackItems.map((item) => (
          <li key={item.id}>
            <article>
              <h3>{item.source_card_name ?? item.action_type}</h3>
              <p>{item.controller_username ?? item.controller_player_id}</p>
              <p>{item.status}</p>
            </article>
          </li>
        ))}
      </ol>
    </section>
  )
}

function PriorityButton({
  hasPriority,
  responseCards,
  onPassPriority,
  onRespondWithInstantOrAbility,
}: {
  hasPriority: boolean
  responseCards: ControllerCard[]
  onPassPriority: () => Promise<void>
  onRespondWithInstantOrAbility: (cardId: string) => Promise<void>
}) {
  const [selectedResponseCardId, setSelectedResponseCardId] = useState(responseCards[0]?.id ?? '')

  return (
    <section>
      <h2>Priority</h2>
      {hasPriority ? (
        <>
          <button type="button" onClick={onPassPriority}>
            Pass Priority
          </button>
          <select
            value={selectedResponseCardId}
            onChange={(event) => setSelectedResponseCardId(event.target.value)}
          >
            <option value="">Select response</option>
            {responseCards.map((card) => (
              <option key={card.id} value={card.id}>
                {card.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!selectedResponseCardId}
            onClick={() => onRespondWithInstantOrAbility(selectedResponseCardId)}
          >
            Respond
          </button>
        </>
      ) : (
        <>
          <p>Wachten op tegenstander</p>
          <button type="button" disabled>
            Pass Priority
          </button>
          <button type="button" disabled>
            Respond
          </button>
        </>
      )}
    </section>
  )
}

function buildControllerV3State({
  cards,
  boardCards,
  players,
  playerId,
  turnState,
  combatAssignments,
  stackItems,
  manaPool,
  isSessionFinished,
  errorMessage,
}: {
  cards: ControllerCard[]
  boardCards: BoardCard[]
  players: GameSessionPlayer[]
  playerId: string | null
  turnState: GameTurnState | null
  combatAssignments: CombatAssignment[]
  stackItems: StackItem[]
  manaPool: ManaPool
  isSessionFinished: boolean
  errorMessage: string | null
}): ControllerV3State {
  const currentPhase = normalizeGamePhase(turnState?.step)
  const pendingStackItems = stackItems.filter((item) => item.status === 'pending')
  const currentPlayer = players.find((player) => player.player_id === playerId) ?? null
  const opponentPlayers = players.filter((player) => player.player_id !== playerId)
  const hasPriority = Boolean(playerId && turnState && (turnState.priority_player_id ?? turnState.active_player_id) === playerId)
  const priorityState = turnState
    ? hasPriority
      ? PriorityState.HasPriority
      : PriorityState.WaitingForOpponent
    : PriorityState.NoPriority
  const handCards = cards
    .filter((card) => card.zone === 'hand')
    .sort((left, right) => left.zone_position - right.zone_position)
  const battlefieldCards = cards.filter((card) => card.zone === 'battlefield')
  const ownCreatures = battlefieldCards.filter((card) => card.cards?.type_line?.toLowerCase().includes('creature'))
  const ownLands = battlefieldCards.filter(isLandCard)
  const incomingAttackers = combatAssignments.filter((assignment) => assignment.defending_player_id === playerId)
  const responseCards = cards.filter((card) => canCardRespond(card, pendingStackItems.length > 0))

  return {
    currentPhase,
    priorityState,
    layoutState: selectControllerLayoutState({
      currentPhase,
      hasPriority,
      playerId,
      activePlayerId: turnState?.active_player_id ?? null,
      pendingStackItems,
      incomingAttackers,
    }),
    hasPriority,
    currentPlayerId: playerId,
    activePlayerId: turnState?.active_player_id ?? null,
    currentPlayer,
    opponentPlayers,
    handCards,
    battlefieldCards,
    ownCreatures,
    ownLands,
    opponentBattlefieldCards: boardCards.filter((card) => card.controller_player_id !== playerId),
    incomingAttackers,
    stackItems: pendingStackItems,
    responseCards,
    manaPool,
    zoneCounters: {
      libraryCount: cards.filter((card) => card.zone === 'library').length,
      graveyardCardIds: cards.filter((card) => card.zone === 'graveyard').map((card) => card.id),
      exileCardIds: cards.filter((card) => card.zone === 'exile').map((card) => card.id),
    },
    isSessionFinished,
    errorMessage,
  }
}

function selectControllerLayoutState({
  currentPhase,
  hasPriority,
  playerId,
  activePlayerId,
  pendingStackItems,
  incomingAttackers,
}: {
  currentPhase: GamePhase | null
  hasPriority: boolean
  playerId: string | null
  activePlayerId: string | null
  pendingStackItems: StackItem[]
  incomingAttackers: CombatAssignment[]
}) {
  if (pendingStackItems.length > 0) {
    return ControllerLayoutState.StackActive
  }

  if (currentPhase === GamePhase.DeclareAttackers && hasPriority && playerId && activePlayerId === playerId) {
    return ControllerLayoutState.DeclareAttackers
  }

  if (currentPhase === GamePhase.DeclareBlockers && incomingAttackers.length > 0) {
    return ControllerLayoutState.DeclareBlockers
  }

  if (currentPhase === GamePhase.PreCombatMain || currentPhase === GamePhase.PostCombatMain) {
    return ControllerLayoutState.MainPhase
  }

  return ControllerLayoutState.Default
}

function normalizeGamePhase(step: GameTurnState['step'] | undefined): GamePhase | null {
  if (!step) {
    return null
  }

  return Object.values(GamePhase).includes(step as GamePhase) ? (step as GamePhase) : null
}

function getPlayerLabel(player: GameSessionPlayer) {
  return player.username || `Player ${player.seat_number}`
}
