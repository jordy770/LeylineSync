import { showDevControls } from '@/lib/game/dev'
import Link from 'next/link'

export default function ControllerViewNav({
  sessionId,
  isLegacy,
}: {
  sessionId: string
  isLegacy: boolean
}) {
  return (
    <div className="fixed inset-x-0 top-0 z-[240] flex h-8 items-center justify-end border-b border-white/10 bg-slate-950/88 px-3 shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur">
      <span className="rounded bg-cyan-500/20 px-3 py-1 text-xs font-semibold text-cyan-100">
        {isLegacy ? 'Controller V1' : 'Controller V2'}
      </span>
      <Link
        href={`/controller/${sessionId}${isLegacy ? '' : '?v=1'}`}
        className="rounded px-3 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
      >
        {isLegacy ? 'V2' : 'V1'}
      </Link>
      <Link
        href={`/board/${sessionId}`}
        className="rounded px-3 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
      >
        Board
      </Link>
      {showDevControls ? (
        <Link
          href={`/judge/${sessionId}`}
          className="rounded px-3 py-1 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/15 hover:text-amber-100"
        >
          Judge
        </Link>
      ) : null}
    </div>
  )
}
