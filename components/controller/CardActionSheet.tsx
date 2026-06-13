'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import type { DamageAllocation, TargetController } from '@/lib/game/actions'
import { isAddManaBehaviorAction, normalizeCardBehaviorToV2 } from '@/lib/game/card-behavior'
import { getPowerToughnessLabel } from '@/lib/game/controller-selectors'
import type {
  BoardCard,
  ControllerCard,
  GameSessionPlayer,
  ManaColor,
  StackItem,
} from '@/lib/game/types'
import { KeywordBadges, ManaCostDisplay, ManaSymbol } from './CardDisplay'
import {
  ABILITY_VERB,
  canCastHandSpell,
  cardIsAura,
  cardIsEquipment,
  cardMatchesTargetType,
  creatureMatchesController,
  creatureProtectedFrom,
  effectiveBoardPT,
  formatCounterBag,
  getAbilityEffect,
  getCardKeywords,
  getEffectivePT,
  getSpellPlan,
  manaCostColors,
  renderAbilityCost,
  renderAbilityEffect,
} from './shared'

// ─── Card Action Sheet ────────────────────────────────────────────────────────

export function CardActionSheet({
  card,
  canCastSorceries,
  canCastInstants,
  pendingStackCount,
  players,
  playerId,
  pendingStackItems,
  boardCards,
  commanderIdentity,
  onTapForMana,
  onCastCard,
  onCycleCard,
  onDealDamageToPlayer,
  onDealDamageToCreature,
  onPumpCreature,
  onSetPtCreature,
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
  onCastAdventure,
  onActivateAbility,
  onActivateManaAbility,
  onActivateLoyalty,
  onCastAura,
  onEquip,
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
  commanderIdentity: ManaColor[]
  onTapForMana: (cardId: string, color?: ManaColor) => Promise<void>
  onCastCard: (cardId: string) => Promise<void>
  onCycleCard: (cardId: string) => Promise<void>
  onDealDamageToPlayer: (cardId: string, targetPlayerId: string) => Promise<void>
  onDealDamageToCreature: (cardId: string, targetCardId: string) => Promise<void>
  onPumpCreature: (cardId: string, targetCardId: string) => Promise<void>
  onSetPtCreature: (cardId: string, targetCardId: string) => Promise<void>
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
  onCastAdventure: (cardId: string, opts: { targetCardId?: string | null; stackItemId?: string | null }) => Promise<void>
  onActivateAbility: (
    sourceId: string,
    abilityIndex: number,
    target?: { targetCardId?: string | null; targetPlayerId?: string | null; costCardIds?: string[] | null },
  ) => Promise<void>
  onActivateManaAbility: (sourceId: string, abilityIndex: number) => Promise<void>
  onActivateLoyalty: (sourceId: string, abilityIndex: number) => Promise<void>
  onCastAura: (cardId: string, targetCardId: string) => Promise<void>
  onEquip: (cardId: string, targetCardId: string) => Promise<void>
  onClose: () => void
}) {
  const script = normalizeCardBehaviorToV2(
    card.copied_script ?? card.cards?.script ?? null,
    card.cards?.type_line,
  )
  const zone = card.zone
  // Mirrors activate_ability's zone gate (mig 289): a missing
  // source_zone_required means BATTLEFIELD, not anywhere — otherwise a
  // creature's pump ability shows on the card while it's still in hand
  // (Stormshriek Feral) and the engine rejects the tap anyway.
  const abilityAvailableInZone = (req?: string | null) =>
    req === 'any' || (req ?? 'battlefield') === zone

  // Keep the original index so activate_mana_ability can address the ability.
  const manaAbilities = (script.activated_abilities ?? [])
    .map((ability, index) => ({ ability, index }))
    .filter(({ ability }) => ability.is_mana_ability && abilityAvailableInZone(ability.source_zone_required))
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
    { index: number; type: string; amount: number; canTargetPlayer: boolean; canTargetCreature: boolean; canTargetGraveyard?: boolean; costCardIds?: string[] } | null
  >(null)
  // Attachment picker: 'aura' = choose the creature an Aura enters enchanting;
  // 'equip' = choose the creature to equip this Equipment onto.
  const [attachPick, setAttachPick] = useState<null | 'aura' | 'equip'>(null)
  // Chosen cost payments (mig 284): when an ability's costs include
  // sacrifice_artifacts / return_land / tap_creatures, the player picks the
  // exact cards before activating; the ids ride p_cost_card_ids. If the
  // effect ALSO needs a target, the pick chains into abilityPick.
  const [costPick, setCostPick] = useState<null | {
    index: number
    label: string
    count: number
    eligible: BoardCard[]
    selected: string[]
    // The follow-up target pick (Shacklegeist: tap two Spirits → tap target).
    then: { type: string; amount: number; canTargetPlayer: boolean; canTargetCreature: boolean } | null
  }>(null)
  // Adventure (mig 295/296): when on, the whole cast UI (plan, target pickers,
  // cast button) is driven by the card's adventure half instead of its creature
  // face; the cast is routed to onCastAdventure with the adventure flag.
  const adventure = script.adventure
  const [adventureMode, setAdventureMode] = useState(false)

  const planCard = adventureMode && adventure
    ? ({
        ...card,
        copied_script: { schema_version: 2, spell_effect: adventure.spell_effect },
        // Adventures are instant-speed here; force the timing accordingly.
        cards: { ...(card.cards ?? {}), type_line: 'Instant' },
      } as ControllerCard)
    : card
  const spellPlan = getSpellPlan(planCard)
  // Controller restriction for the chosen creature target ("an opponent controls"
  // / "you control"), relative to the caster. Defaults to any for untargeted plans.
  const spellTargetController: TargetController =
    spellPlan.kind === 'damage' ||
    spellPlan.kind === 'pump' ||
    spellPlan.kind === 'set_pt' ||
    spellPlan.kind === 'add_counters' ||
    spellPlan.kind === 'creature_effect' ||
    spellPlan.kind === 'multi_creature' ||
    spellPlan.kind === 'divided_damage'
      ? spellPlan.targetController
      : 'any'
  // A targeted spell can't choose a creature with protection from its colour (the
  // server rejects it too); the colour comes from the spell card's mana cost.
  const spellColors = manaCostColors(card.cards?.mana_cost)
  const targetableCreatures = boardCards.filter(
    (c) =>
      c.type_line?.toLowerCase().includes('creature') &&
      creatureMatchesController(c, playerId, spellTargetController) &&
      !creatureProtectedFrom(c, spellColors),
  )
  // Creature cards in ANY graveyard — the choices for an "exile a creature card
  // from a graveyard" activated-ability cost (Cemetery Reaper).
  const graveyardCreatures = boardCards.filter(
    (c) => c.zone === 'graveyard' && c.type_line?.toLowerCase().includes('creature'),
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

  // Auras (cast from hand targeting a creature) and Equipment (equip a creature you
  // control). Colour comes from the card's mana cost; creatures with protection from
  // that colour are dropped from the picker (the server enforces it regardless).
  const isAura = cardIsAura(card.cards?.type_line) && zone === 'hand'
  const isEquipment = cardIsEquipment(card.cards?.type_line) && zone === 'battlefield'
  const enchantTargets = boardCards.filter((c) => isCreature(c) && !creatureProtectedFrom(c, spellColors))
  const equipTargets = boardCards.filter(
    (c) => isCreature(c) && c.controller_player_id === playerId && !creatureProtectedFrom(c, spellColors),
  )

  // In adventure mode the cast is the instant-speed adventure half, so gate on
  // planCard (type_line forced to Instant) rather than the creature face.
  const canCast = canCastHandSpell(planCard, canCastSorceries, canCastInstants, pendingStackCount)
  // The adventure half can be entered whenever the creature is in hand.
  const canEnterAdventure = !!adventure && zone === 'hand' && !adventureMode
  // Flashback: a card in the graveyard carrying a `flashback` cost can be re-cast
  // from there for that cost (the server then exiles it). Supported here for the
  // untargeted programs Army of the Damned-style cards use.
  const flashbackCost = script.flashback ?? null
  // Additional "Pay N life" flashback cost (Deep Analysis); the server charges it.
  const flashbackLife = script.flashback_life ?? 0
  // Cycling: a card in hand carrying a `cycling` cost can be discarded to draw.
  const cyclingCost = script.cycling ?? null
  const canCycle = !!cyclingCost && zone === 'hand' && pendingStackCount === 0
  const fbSorcerySpeed = card.cards?.type_line?.toLowerCase().includes('sorcery') ?? false
  const canFlashback =
    !!flashbackCost &&
    zone === 'graveyard' &&
    (fbSorcerySpeed ? canCastSorceries : canCastInstants) &&
    (spellPlan.kind === 'spell_effect' || spellPlan.kind === 'draw' || spellPlan.kind === 'modal')
  const hasCreatureTargets = targetableCreatures.length > 0
  const requiresCreatureTarget =
    spellPlan.kind === 'pump' ||
    spellPlan.kind === 'set_pt' ||
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
      (spellPlan.kind === 'set_pt' && hasCreatureTargets) ||
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

    if (isAura) {
      setAttachPick('aura')
    } else if (needsTarget) {
      setPicking(true)
    } else if (adventureMode) {
      // Untargeted adventure half (e.g. Hildibrand's create-token).
      void onCastAdventure(card.id, {})
      onClose()
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

  const handleFlashback = () => {
    if (spellPlan.kind === 'draw') void onDrawCards(card.id)
    else if (spellPlan.kind === 'modal') void onModalSpell(card.id)
    else void onSpellEffect(card.id)
    onClose()
  }

  const handleCycle = () => { void onCycleCard(card.id); onClose() }

  const hasActions = canCast || canEnterAdventure || canFlashback || canCycle || isEquipment || manaAbilities.length > 0 || otherAbilities.length > 0 || (script.loyalty_abilities?.length ?? 0) > 0

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
        className="absolute inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-3xl border-t border-white/10 bg-[#181C28] px-4 pb-6 pt-4"
      >
        {/* Drag handle */}
        <div className="mx-auto mb-4 h-1 w-10 shrink-0 rounded-full bg-white/15" />

        {/* Two-column body: pinned card preview (left) + scrollable actions (right) */}
        <div className="flex min-h-0 flex-1 items-start gap-4">
          {/* Card preview — pinned; tap to zoom for full detail */}
          {imageUrl && (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              className="w-[160px] shrink-0 overflow-hidden rounded-xl shadow-lg active:scale-95 transition-transform"
            >
              <img src={imageUrl} alt={card.name} className="w-full object-cover" />
            </button>
          )}

          {/* Scrollable actions column */}
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto pr-1">
          {/* Card header text */}
          <div className="mb-5 flex items-start gap-3">
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
            {formatCounterBag(card.counters).map(({ kind, n }) => (
              <span key={kind} className="text-[9px] font-bold text-amber-400">
                {n} {kind}
              </span>
            ))}
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
        {adventureMode && !picking && (
          <button
            type="button"
            onClick={() => setAdventureMode(false)}
            className="mb-2 self-start text-[10px] font-black uppercase tracking-widest text-violet-300/80 transition active:scale-95"
          >
            ← Back to creature
          </button>
        )}

        {canCast && !picking && !attachPick && (
          <button
            type="button"
            aria-label={isAura ? 'Cast - enchant a creature' : castLabel}
            disabled={!hasRequiredTargets}
            onClick={handleCast}
            className={`mb-3 flex w-full items-center justify-between rounded-2xl px-4 py-3.5 transition active:scale-95 ${
              hasRequiredTargets ? 'bg-amber-400' : 'cursor-not-allowed bg-slate-700 opacity-70'
            }`}
          >
            <span className={`font-black ${hasRequiredTargets ? 'text-amber-950' : 'text-slate-300'}`}>
              {isAura ? 'Cast - enchant a creature' : castLabel}
            </span>
            <ManaCostDisplay manaCost={adventureMode ? adventure?.cost : card.cards?.mana_cost} dark={hasRequiredTargets} />
          </button>
        )}

        {/* Adventure entry — switch the cast UI to the card's adventure half */}
        {canEnterAdventure && !picking && !attachPick && (
          <button
            type="button"
            aria-label={`Adventure${adventure?.name ? ` - ${adventure.name}` : ''}`}
            onClick={() => setAdventureMode(true)}
            className="mb-3 flex w-full items-center justify-between rounded-2xl border border-violet-400/50 bg-violet-400/15 px-4 py-3 transition active:scale-95"
          >
            <span className="flex flex-col text-left">
              <span className="text-[9px] font-black uppercase tracking-widest text-violet-300/80">Adventure</span>
              <span className="font-bold text-violet-100">{adventure?.name ?? 'Cast adventure'}</span>
            </span>
            <ManaCostDisplay manaCost={adventure?.cost} />
          </button>
        )}

        {/* Cycling button (hand card with a cycling cost) */}
        {canCycle && !picking && !attachPick && (
          <button
            type="button"
            aria-label={`Cycling ${cyclingCost}`}
            onClick={handleCycle}
            className="mb-3 flex w-full items-center justify-between rounded-2xl bg-sky-400 px-4 py-3.5 transition active:scale-95"
          >
            <span className="font-black text-sky-950">Cycle</span>
            <ManaCostDisplay manaCost={cyclingCost} dark />
          </button>
        )}

        {/* Flashback button (graveyard card with a flashback cost) */}
        {canFlashback && !picking && !attachPick && (
          <button
            type="button"
            aria-label={`Flashback ${flashbackCost}${flashbackLife > 0 ? `, pay ${flashbackLife} life` : ''}`}
            onClick={handleFlashback}
            className="mb-3 flex w-full items-center justify-between rounded-2xl bg-purple-400 px-4 py-3.5 transition active:scale-95"
          >
            <span className="font-black text-purple-950">Flashback</span>
            <span className="flex items-center gap-1.5">
              <ManaCostDisplay manaCost={flashbackCost} dark />
              {flashbackLife > 0 && (
                <span className="font-black text-purple-950">+ {flashbackLife} life</span>
              )}
            </span>
          </button>
        )}

        {/* Equip button (battlefield Equipment) */}
        {isEquipment && !attachPick && (
          <button
            type="button"
            aria-label="Equip"
            disabled={equipTargets.length === 0}
            onClick={() => setAttachPick('equip')}
            className={`mb-3 flex w-full items-center justify-between rounded-2xl px-4 py-3.5 transition active:scale-95 ${
              equipTargets.length > 0 ? 'bg-amber-400' : 'cursor-not-allowed bg-slate-700 opacity-70'
            }`}
          >
            <span className={`font-black ${equipTargets.length > 0 ? 'text-amber-950' : 'text-slate-300'}`}>
              {equipTargets.length > 0 ? 'Equip a creature' : 'No creatures to equip'}
            </span>
          </button>
        )}

        {/* Attachment picker (Aura enchant target / Equipment equip target) */}
        {attachPick && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              {attachPick === 'aura' ? 'Enchant which creature' : 'Equip which creature'}
            </p>
            {(attachPick === 'aura' ? enchantTargets : equipTargets).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  if (attachPick === 'aura') void onCastAura(card.id, c.id)
                  else void onEquip(card.id, c.id)
                  onClose()
                }}
                className="flex w-full items-center justify-between rounded-2xl border border-amber-400/40 bg-amber-400/10 px-4 py-2.5 transition active:scale-95"
              >
                <span className="truncate font-bold text-white">{c.name}</span>
                <span className="ml-2 shrink-0 text-xs font-black text-slate-300">{effectiveBoardPT(c)}</span>
              </button>
            ))}
            {(attachPick === 'aura' ? enchantTargets : equipTargets).length === 0 && (
              <p className="px-1 text-xs text-slate-500">No legal creatures.</p>
            )}
            <button
              type="button"
              onClick={() => setAttachPick(null)}
              className="w-full rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95"
            >
              Back
            </button>
          </div>
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

        {picking && spellPlan.kind === 'set_pt' && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              Make a creature {spellPlan.power}/{spellPlan.toughness} until end of turn
            </p>
            {targetableCreatures.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { void onSetPtCreature(card.id, c.id); onClose() }}
                className="flex w-full items-center justify-between rounded-2xl border border-sky-400/40 bg-sky-400/10 px-4 py-2.5 transition active:scale-95"
              >
                <span className="truncate font-bold text-white">{c.name}</span>
                <span className="ml-2 shrink-0 text-xs font-black text-sky-300">{effectiveBoardPT(c)} → {spellPlan.power}/{spellPlan.toughness}</span>
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
                onClick={() => { void (adventureMode ? onCastAdventure(card.id, { targetCardId: c.id }) : onPermanentEffect(card.id, c.id)); onClose() }}
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
                  onClick={() => { void (adventureMode ? onCastAdventure(card.id, { stackItemId: item.id }) : onCounterSpell(card.id, item.id)); onClose() }}
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
            {manaAbilities.flatMap(({ ability, index }, i) => {
              const addManaEffects = ability.effects.filter(isAddManaBehaviorAction)
              const hasTapCost = ability.costs.some((c) => c.type === 'tap_self')
              const isUnavailable = hasTapCost && card.is_tapped
              // A mana ability with a non-tap cost (a mana cost — Dimir Signet
              // "{1},{T}: Add {U}{B}"; or a "Pay N life" cost — Talisman of
              // Dominance "{T},Pay 1 life: Add {U}") or multiple produced colours
              // is one atomic activation: pay the cost(s), tap, add all colours via
              // activate_mana_ability (so the life/mana payment isn't skipped).
              const hasNonTapCost = ability.costs.some((c) => c.type !== 'tap_self')
              // A producer of "any"/"commander" mana needs a colour pick, so it
              // always uses the per-colour buttons below (which route a sacrifice
              // cost through activate_mana_ability with the chosen colour —
              // Treasure) — never the single atomic button.
              const needsColorChoice = addManaEffects.some((e) => e.color === 'any' || e.color === 'commander')
              if ((hasNonTapCost || addManaEffects.length > 1) && !needsColorChoice) {
                return [(
                  <button
                    key={`mana-${index}`}
                    type="button"
                    disabled={isUnavailable}
                    onClick={() => { void onActivateManaAbility(card.id, index); onClose() }}
                    className={`col-span-2 flex items-center gap-2 rounded-2xl border px-3 py-3 transition active:scale-95 ${
                      isUnavailable ? 'border-white/5 bg-[#0F1117] opacity-30' : 'border-white/10 bg-[#0F1117] hover:border-white/20'
                    }`}
                  >
                    <span className="shrink-0 text-[10px] font-black text-slate-500">{renderAbilityCost(ability.costs)}</span>
                    <span className="text-slate-600">→</span>
                    <span className="flex items-center gap-1">
                      {addManaEffects.flatMap((effect) =>
                        Array.from({ length: Math.max(1, effect.amount) }, (_, k) => (
                          <ManaSymbol key={`${effect.color}-${k}`} color={effect.color as ManaColor} size="md" />
                        )),
                      )}
                    </span>
                  </button>
                )]
              }
              return addManaEffects.flatMap((effect) => {
                // 'commander' → one button per colour in the commander's identity
                // (colourless fallback when there is none); 'any' → one per W/U/B/R/G;
                // else the fixed colour.
                const produces: ManaColor[] =
                  effect.color === 'commander'
                    ? (commanderIdentity.length > 0 ? commanderIdentity : (['C'] as ManaColor[]))
                    : effect.color === 'any'
                      ? (['W', 'U', 'B', 'R', 'G'] as ManaColor[])
                      : [effect.color as ManaColor]
                return produces.map((produced) => (
                  <button
                    key={`${i}-${effect.color}-${produced}`}
                    type="button"
                    disabled={isUnavailable}
                    onClick={() => { void onTapForMana(card.id, produced); onClose() }}
                    className={`flex items-center gap-2.5 rounded-2xl border px-3 py-3 transition active:scale-95 ${
                      isUnavailable
                        ? 'border-white/5 bg-[#0F1117] opacity-30'
                        : 'border-white/10 bg-[#0F1117] hover:border-white/20'
                    }`}
                  >
                    {hasTapCost && (
                      <span className="shrink-0 text-[9px] font-black text-slate-600">{'{T}'}</span>
                    )}
                    <ManaSymbol color={produced} size="md" />
                    <span className="text-sm font-bold text-white">Add {produced}</span>
                  </button>
                ))
              })
            })}
          </div>
        )}

        {/* Non-mana activated abilities */}
        {otherAbilities.length > 0 && !picking && !abilityPick && !costPick && (
          <div className="space-y-1.5">
            <p className="mb-1 text-[9px] uppercase tracking-widest text-slate-700">Abilities</p>
            {otherAbilities.map(({ ability, index }) => {
              const eff = getAbilityEffect(ability.effects)
              const hasTap = ability.costs.some((c) => c.type === 'tap_self')
              // A graveyard-exile COST needs a creature card chosen from a graveyard
              // (Cemetery Reaper), even when the effect itself is untargeted.
              const needsGraveyardCard = ability.costs.some((c) => c.type === 'exile_from_graveyard')
              const supported = Boolean(eff)
              const targetAvailable = Boolean(
                eff && (!eff.needsTarget || eff.canTargetPlayer || (eff.canTargetCreature && targetableCreatures.length > 0)),
              )
              const graveyardAvailable = !needsGraveyardCard || graveyardCreatures.length > 0
              // Pick-able costs (mig 284): the player chooses which cards pay.
              const pickableCostRaw = ability.costs.find((c) =>
                c.type === 'sacrifice_artifacts' || c.type === 'return_land' || c.type === 'tap_creatures')
              const pickableCost = pickableCostRaw
                ? { type: pickableCostRaw.type, count: Number((pickableCostRaw as Record<string, unknown>).count ?? 1) || 1, nontoken: Boolean((pickableCostRaw as Record<string, unknown>).nontoken), type_line: ((pickableCostRaw as Record<string, unknown>).type_line as string | undefined) ?? null }
                : null
              const costEligible = !pickableCost ? [] : boardCards.filter((b) => {
                if (b.zone !== 'battlefield' || b.controller_player_id !== playerId) return false
                const tl = b.type_line ?? ''
                if (pickableCost.type === 'sacrifice_artifacts') {
                  if (!/artifact/i.test(tl) || b.id === card.id) return false
                  // nontoken: token rows are named '… Token' by convention.
                  if (pickableCost.nontoken && /\bToken\b/.test(b.name)) return false
                  return true
                }
                if (pickableCost.type === 'return_land') return /land/i.test(tl)
                // tap_creatures: untapped creatures matching the cost's type filter.
                return !b.is_tapped && /creature/i.test(tl)
                  && (!pickableCost.type_line || new RegExp(pickableCost.type_line, 'i').test(tl))
              })
              const costCount = pickableCost ? Math.max(1, pickableCost.count) : 0
              const costAvailable = !pickableCost || costEligible.length >= costCount
              const available = supported && canCastInstants && (!hasTap || !card.is_tapped) && targetAvailable && graveyardAvailable && costAvailable
              return (
                <button
                  key={index}
                  type="button"
                  disabled={!available}
                  onClick={() => {
                    if (!eff) return
                    if (pickableCost) {
                      setCostPick({
                        index,
                        label: pickableCost.type === 'sacrifice_artifacts' ? `Sacrifice ${costCount} artifact${costCount > 1 ? 's' : ''}`
                          : pickableCost.type === 'return_land' ? `Return ${costCount} land${costCount > 1 ? 's' : ''} to hand`
                          : `Tap ${costCount} ${pickableCost.type_line ?? 'creature'}${costCount > 1 ? 's' : ''}`,
                        count: costCount,
                        eligible: costEligible,
                        selected: [],
                        then: eff.needsTarget
                          ? { type: eff.type, amount: eff.amount, canTargetPlayer: eff.canTargetPlayer, canTargetCreature: eff.canTargetCreature }
                          : null,
                      })
                    } else if (needsGraveyardCard) {
                      setAbilityPick({ index, type: eff.type, amount: eff.amount, canTargetPlayer: false, canTargetCreature: false, canTargetGraveyard: true })
                    } else if (eff.needsTarget) {
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

        {/* Planeswalker loyalty abilities (sorcery speed, once per turn) */}
        {(script.loyalty_abilities?.length ?? 0) > 0 && !picking && !abilityPick && !costPick && (
          <div className="space-y-1.5">
            <p className="mb-1 flex items-center gap-1.5 text-[9px] uppercase tracking-widest text-slate-700">
              Loyalty <span className="text-[11px] font-black text-amber-400">◆ {Number(card.counters?.loyalty ?? 0)}</span>
            </p>
            {(script.loyalty_abilities ?? []).map((ability, index) => {
              const cur = Number(card.counters?.loyalty ?? 0)
              const affordable = cur + ability.cost >= 0
              const available = canCastSorceries && affordable
              const sign = ability.cost > 0 ? `+${ability.cost}` : `${ability.cost}`
              return (
                <button
                  key={index}
                  type="button"
                  disabled={!available}
                  onClick={() => { void onActivateLoyalty(card.id, index); onClose() }}
                  className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 transition active:scale-95 ${
                    available ? 'border-white/15 bg-[#0F1117]' : 'border-white/5 bg-[#0F1117]/60 opacity-50'
                  }`}
                >
                  <span className="shrink-0 rounded-md bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-black text-amber-300">{sign}</span>
                  <span className="text-[10px] text-slate-400">{ability.label ?? renderAbilityEffect(ability.effects)}</span>
                  {!affordable && <span className="ml-auto shrink-0 text-[9px] text-amber-500/70">Not enough</span>}
                  {affordable && !canCastSorceries && <span className="ml-auto shrink-0 text-[9px] text-slate-700">Sorcery speed</span>}
                </button>
              )
            })}
          </div>
        )}

        {/* Activated ability target picker */}
        {costPick && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              {costPick.label} ({costPick.selected.length}/{costPick.count})
            </p>
            <div className="flex flex-wrap gap-2">
              {costPick.eligible.map((c) => {
                const on = costPick.selected.includes(c.id)
                return (
                  <button key={c.id} type="button"
                    onClick={() => setCostPick((prev) => prev && ({
                      ...prev,
                      selected: on ? prev.selected.filter((x) => x !== c.id)
                        : prev.selected.length >= prev.count ? (prev.count === 1 ? [c.id] : prev.selected)
                        : [...prev.selected, c.id],
                    }))}
                    className={`rounded-xl border px-3 py-1.5 text-[11px] font-bold transition active:scale-95 ${on ? 'border-indigo-300 bg-indigo-400/30 text-white' : 'border-white/15 bg-[#0F1117] text-slate-300'}`}>
                    {c.name}
                  </button>
                )
              })}
            </div>
            <div className="flex gap-2">
              <button type="button" disabled={costPick.selected.length !== costPick.count}
                onClick={() => {
                  if (!costPick) return
                  if (costPick.then) {
                    // Chain into the target pick; the cost ids ride along.
                    setAbilityPick({ index: costPick.index, ...costPick.then, costCardIds: costPick.selected })
                    setCostPick(null)
                  } else {
                    void onActivateAbility(card.id, costPick.index, { costCardIds: costPick.selected })
                    setCostPick(null)
                    onClose()
                  }
                }}
                className="rounded-xl bg-indigo-400 px-4 py-2 text-xs font-black uppercase tracking-wide text-indigo-950 transition active:scale-95 disabled:opacity-40">
                {costPick.then ? 'Next: choose target' : 'Pay and activate'}
              </button>
              <button type="button" onClick={() => setCostPick(null)}
                className="rounded-xl border border-slate-600 px-4 py-2 text-xs font-black uppercase tracking-wide text-slate-300 transition active:scale-95">
                Cancel
              </button>
            </div>
          </div>
        )}
        {abilityPick && (
          <div className="mb-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              {abilityPick.canTargetGraveyard
                ? 'Exile which creature card from a graveyard?'
                : abilityPick.type === 'deal_damage'
                  ? `Deal ${abilityPick.amount} damage to`
                  : `${ABILITY_VERB[abilityPick.type] ?? 'Affect'} which target?`}
            </p>
            {abilityPick.canTargetGraveyard && graveyardCreatures.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { void onActivateAbility(card.id, abilityPick.index, { targetCardId: c.id, costCardIds: abilityPick.costCardIds ?? null }); onClose() }}
                className="flex w-full items-center justify-between rounded-2xl border border-[#D4591A]/40 bg-[#D4591A]/10 px-4 py-2.5 transition active:scale-95"
              >
                <span className="truncate font-bold text-white">{c.name}</span>
                <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-slate-500">graveyard</span>
              </button>
            ))}
            {abilityPick.canTargetPlayer && players.map((p) => (
              <button
                key={p.player_id}
                type="button"
                onClick={() => { void onActivateAbility(card.id, abilityPick.index, { targetPlayerId: p.player_id, costCardIds: abilityPick.costCardIds ?? null }); onClose() }}
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
                onClick={() => { void onActivateAbility(card.id, abilityPick.index, { targetCardId: c.id, costCardIds: abilityPick.costCardIds ?? null }); onClose() }}
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
          </div>
        </div>
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
