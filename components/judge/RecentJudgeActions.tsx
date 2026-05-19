import { useJudgeActionLog } from '@/lib/game/use-judge-action-log'
import type { GameActionLog, GameSessionPlayer } from '@/lib/game/types'

export default function RecentJudgeActions({
  actions,
  players,
  onChanged,
}: {
  actions: GameActionLog[]
  players: GameSessionPlayer[]
  onChanged: () => Promise<void>
}) {
  const { pendingActionId, message, handleUndo } = useJudgeActionLog(onChanged)

  const getPlayerLabel = (playerId?: string | null) => {
    const player = players.find((item) => item.player_id === playerId)
    return player?.username ?? (playerId ? playerId.slice(0, 8) : 'Session')
  }

  return (
    <section className="leyline-glass-panel rounded-lg p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">Judge Log</p>
          <h2 className="text-base font-bold text-white">Recent Actions</h2>
        </div>
        <span className="rounded-md border border-white/10 bg-slate-950/60 px-3 py-1 text-xs text-slate-400">
          {actions.length}
        </span>
      </div>

      {actions.length > 0 ? (
        <div className="grid gap-2">
          {actions.map((action) => (
            <div
              key={action.id}
              className={`grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_auto] sm:items-center ${
                action.undone_at
                  ? 'border-slate-700 bg-slate-950/40 opacity-60'
                  : 'border-white/10 bg-slate-950/60'
              }`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">
                  {action.description ?? action.action_type}
                </p>
                <p className="text-xs text-slate-500">
                  {getPlayerLabel(action.target_player_id)} - {new Date(action.created_at).toLocaleTimeString()}
                  {action.undone_at ? ' - undone' : ''}
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(action.undone_at) || pendingActionId === action.id}
                onClick={() => handleUndo(action.id)}
                className="rounded-md border border-amber-300/25 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pendingActionId === action.id ? 'Undoing...' : 'Undo'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-white/10 p-3 text-sm text-slate-500">
          No judge actions logged yet.
        </p>
      )}
      {message ? <p className="mt-3 text-xs text-slate-300">{message}</p> : null}
    </section>
  )
}
