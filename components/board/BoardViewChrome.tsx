import type { GameTurnState } from '@/lib/game/types'

export default function BoardViewChrome({
  turnState,
  isFocusMode,
  onToggleFocus,
}: {
  turnState: GameTurnState | null
  isFocusMode: boolean
  onToggleFocus: () => void
}) {
  return (
    <div className="relative z-30 mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3 [@media(max-height:640px)]:mb-2 [@media(max-height:640px)]:gap-2">
      <div />
      <div className="leyline-phase-pill rounded-full px-6 py-2 text-center text-sm font-semibold text-white [@media(max-height:640px)]:px-4 [@media(max-height:640px)]:py-1.5 [@media(max-height:640px)]:text-xs">
        Turn {turnState?.turn_number ?? '-'} &middot; {formatStepLabel(turnState?.step)}
      </div>
      <button
        type="button"
        onClick={onToggleFocus}
        className="justify-self-end rounded-lg border border-slate-700 bg-slate-900/85 px-4 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/20 transition-colors hover:border-cyan-300/40 hover:bg-slate-800 [@media(max-height:640px)]:px-3 [@media(max-height:640px)]:py-1.5 [@media(max-height:640px)]:text-xs"
      >
        {isFocusMode ? 'Grid View' : 'Focus Priority'}
      </button>
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
