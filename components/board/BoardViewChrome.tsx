import type { GameTurnState } from '@/lib/game/types'

export default function BoardViewChrome({
  turnState,
  isFocusMode,
  onToggleFocus,
  onOpenLog,
  castControls,
}: {
  turnState: GameTurnState | null
  isFocusMode: boolean
  onToggleFocus: () => void
  // Absent in spectator mode (the anon log would be empty under RLS).
  onOpenLog?: () => void
  // Member-only 📺/🔗 controls (mig 378); null in spectator mode.
  castControls?: React.ReactNode
}) {
  // Priority sits with someone other than the active (turn) player → a response
  // window. The big screen names who everyone is waiting on, so the table knows
  // why play paused. When priority == the active player it's just their turn
  // (the active-seat highlight already conveys that), so we stay quiet.
  const waitingOn = turnState
    && turnState.priority_player_id
    && turnState.priority_player_id !== turnState.active_player_id
    ? turnState.priority_username ?? null
    : null

  return (
    <div className="relative z-30 mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3 [@media(max-height:640px)]:mb-2 [@media(max-height:640px)]:gap-2">
      <div className="justify-self-start">
        {waitingOn && (
          <span className="flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-200 [@media(max-height:640px)]:px-2.5 [@media(max-height:640px)]:py-1 [@media(max-height:640px)]:text-[11px]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]" />
            Waiting on {waitingOn}
          </span>
        )}
      </div>
      <div className="leyline-phase-pill rounded-full px-6 py-2 text-center text-sm font-semibold text-white [@media(max-height:640px)]:px-4 [@media(max-height:640px)]:py-1.5 [@media(max-height:640px)]:text-xs">
        Turn {turnState?.turn_number ?? '-'} &middot; {formatStepLabel(turnState?.step)}
      </div>
      <div className="flex items-center justify-end gap-2 justify-self-end">
        {castControls}
        {onOpenLog && (
          <button
            type="button"
            onClick={onOpenLog}
            aria-label="Open game log"
            className="rounded-lg border border-slate-700 bg-slate-900/85 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/20 transition-colors hover:border-cyan-300/40 hover:bg-slate-800 [@media(max-height:640px)]:px-2.5 [@media(max-height:640px)]:py-1.5 [@media(max-height:640px)]:text-xs"
          >
            📜
          </button>
        )}
        <button
          type="button"
          onClick={onToggleFocus}
          className="rounded-lg border border-slate-700 bg-slate-900/85 px-4 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/20 transition-colors hover:border-cyan-300/40 hover:bg-slate-800 [@media(max-height:640px)]:px-3 [@media(max-height:640px)]:py-1.5 [@media(max-height:640px)]:text-xs"
        >
          {isFocusMode ? 'Grid View' : 'Focus Priority'}
        </button>
      </div>
    </div>
  )
}

function formatStepLabel(step: GameTurnState['step'] | undefined) {
  if (!step) {
    return '-'
  }

  return step
    .split('_')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}
