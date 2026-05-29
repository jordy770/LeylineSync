import { gameZones } from '@/lib/game/data'
import { useJudgeCardTools } from '@/lib/game/use-judge-card-tools'
import type { ControllerCard, GameZone } from '@/lib/game/types'

export default function JudgePlayerCardTools({
  sessionId,
  playerId,
  cards,
  isSessionFinished,
  onChanged,
}: {
  sessionId: string
  playerId: string
  cards: ControllerCard[]
  isSessionFinished: boolean
  onChanged: () => Promise<void>
}) {
  const {
    visibleCards,
    selectedCard,
    targetZone,
    damageMarked,
    isPending,
    message,
    setSelectedCardId,
    setTargetZone,
    setDamageMarked,
    shuffleLibrary,
    moveSelectedCard,
    toggleSelectedCardTapped,
    updateSelectedCardDamage,
    putSelectedCardOnTop,
    putSelectedCardOnBottom,
    clearSelectedCardSummoningSickness,
  } = useJudgeCardTools({
    sessionId,
    playerId,
    cards,
    onChanged,
  })

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/55 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-300">Card Corrections</h3>
        <button
          type="button"
          disabled={isSessionFinished || isPending}
          onClick={shuffleLibrary}
          className="rounded-md border border-white/15 bg-slate-800 px-2 py-1 text-xs font-semibold text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Shuffle Library
        </button>
      </div>

      {visibleCards.length > 0 ? (
        <div className="grid gap-2">
          <select
            value={selectedCard?.id ?? ''}
            onChange={(event) => setSelectedCardId(event.target.value)}
            className="min-w-0 rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
          >
            {visibleCards.map((card) => (
              <option key={card.id} value={card.id}>
                {card.name} ({card.zone})
              </option>
            ))}
          </select>

          {selectedCard ? (
            <>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <select
                  value={targetZone}
                  onChange={(event) => setTargetZone(event.target.value as GameZone)}
                  className="min-w-0 rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
                >
                  {gameZones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={isSessionFinished || isPending}
                  onClick={moveSelectedCard}
                  className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Move
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isSessionFinished || isPending}
                  onClick={toggleSelectedCardTapped}
                  className="rounded-md border border-white/15 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {selectedCard.is_tapped ? 'Untap' : 'Tap'}
                </button>
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <input
                    type="number"
                    min={0}
                    value={damageMarked}
                    onChange={(event) => setDamageMarked(Number(event.target.value))}
                    className="min-w-0 rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
                  />
                  <button
                    type="button"
                    disabled={isSessionFinished || isPending}
                    onClick={updateSelectedCardDamage}
                    className="rounded-md border border-white/15 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Damage
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isSessionFinished || isPending}
                  onClick={putSelectedCardOnTop}
                  className="rounded-md border border-cyan-300/20 bg-cyan-950/30 px-3 py-2 text-sm font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Top Library
                </button>
                <button
                  type="button"
                  disabled={isSessionFinished || isPending}
                  onClick={putSelectedCardOnBottom}
                  className="rounded-md border border-cyan-300/20 bg-cyan-950/30 px-3 py-2 text-sm font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Bottom Library
                </button>
              </div>

              {selectedCard.zone === 'battlefield' ? (
                <button
                  type="button"
                  disabled={isSessionFinished || isPending}
                  onClick={clearSelectedCardSummoningSickness}
                  className="w-full rounded-md border border-violet-300/20 bg-violet-950/30 px-3 py-2 text-sm font-semibold text-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Clear Summoning Sickness
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-slate-500">No visible cards for this player.</p>
      )}

      {message ? <p className="mt-2 text-xs text-slate-300">{message}</p> : null}
    </div>
  )
}
