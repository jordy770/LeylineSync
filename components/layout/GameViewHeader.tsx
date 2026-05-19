import { showDevControls } from '@/lib/game/dev'
import Link from 'next/link'

type GameView = 'board' | 'judge'

export default function GameViewHeader({
  sessionId,
  activeView,
  title,
  compactHeight = false,
}: {
  sessionId: string
  activeView: GameView
  title: string
  compactHeight?: boolean
}) {
  const heightClass = compactHeight
    ? '[@media(max-height:640px)]:mt-2 [@media(max-height:640px)]:h-12 [@media(max-height:640px)]:px-3'
    : ''
  const titleClass = compactHeight ? '[@media(max-height:640px)]:text-xs' : ''
  const itemClass = `rounded-md px-3 py-1.5 text-xs font-semibold transition-colors [@media(max-height:640px)]:px-2`

  return (
    <div className={`leyline-phase-pill mx-3 mt-3 flex h-14 items-center justify-between gap-3 rounded-lg px-4 sm:mx-4 sm:mt-4 ${heightClass}`}>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/80">LeylineSync</p>
        <h1 className={`truncate text-sm font-bold tracking-wide text-cyan-50 ${titleClass}`}>{title}</h1>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <code className="hidden truncate text-xs text-slate-400 sm:block">Session: {sessionId}</code>
        <div className="flex rounded-lg border border-white/15 bg-slate-950/70 p-1">
          <Link
            href={`/controller/${sessionId}`}
            className={`${itemClass} text-slate-300 hover:bg-slate-800 hover:text-white`}
          >
            Controller
          </Link>
          {activeView === 'board' ? (
            <span className={`${itemClass} bg-cyan-500/20 text-cyan-100`}>Board</span>
          ) : (
            <Link
              href={`/board/${sessionId}`}
              className={`${itemClass} text-slate-300 hover:bg-slate-800 hover:text-white`}
            >
              Board
            </Link>
          )}
          {showDevControls ? (
            activeView === 'judge' ? (
              <span className={`${itemClass} bg-amber-500/20 text-amber-100`}>Judge</span>
            ) : (
              <Link
                href={`/judge/${sessionId}`}
                className={`${itemClass} text-amber-200 hover:bg-amber-500/15 hover:text-amber-100`}
              >
                Judge
              </Link>
            )
          ) : null}
        </div>
      </div>
    </div>
  )
}
