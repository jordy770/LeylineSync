import JudgePanel from '@/components/JudgePanel'
import Link from 'next/link'
import { Suspense } from 'react'

export default function JudgePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-950" />}>
      <JudgeContent params={params} />
    </Suspense>
  )
}

async function JudgeContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  return (
    <main className="leyline-table-bg min-h-screen text-white">
      <div className="leyline-phase-pill mx-3 mt-3 flex h-14 items-center justify-between gap-3 rounded-lg px-4 sm:mx-4 sm:mt-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/80">LeylineSync</p>
          <h1 className="truncate text-sm font-bold tracking-wide text-cyan-50">Judge View</h1>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <code className="hidden truncate text-xs text-slate-400 sm:block">Session: {id}</code>
          <div className="flex rounded-lg border border-white/15 bg-slate-950/70 p-1">
            <Link
              href={`/controller/${id}`}
              className="rounded-md px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
            >
              Controller
            </Link>
            <Link
              href={`/board/${id}`}
              className="rounded-md px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
            >
              Board
            </Link>
            <span className="rounded-md bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-100">
              Judge
            </span>
          </div>
        </div>
      </div>

      <div className="p-4 sm:p-6">
        <JudgePanel sessionId={id} />
      </div>
    </main>
  )
}
