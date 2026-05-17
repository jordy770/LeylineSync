import GameBoard from '@/components/GameBoard';
import { showDevControls } from '@/lib/game/dev';
import Link from 'next/link';
import { Suspense } from 'react';

export default function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-950" />}>
      <BoardContent params={params} />
    </Suspense>
  );
}

async function BoardContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="leyline-table-bg min-h-screen overflow-hidden text-white">
      <div className="leyline-phase-pill mx-3 mt-3 flex h-14 items-center justify-between gap-3 rounded-lg px-4 [@media(max-height:640px)]:mt-2 [@media(max-height:640px)]:h-12 [@media(max-height:640px)]:px-3 sm:mx-4 sm:mt-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/80">LeylineSync</p>
          <h1 className="truncate text-sm font-bold tracking-wide text-cyan-50 [@media(max-height:640px)]:text-xs">Board View</h1>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <code className="hidden truncate text-xs text-slate-400 sm:block">Session: {id}</code>
          <div className="flex rounded-lg border border-white/15 bg-slate-950/70 p-1">
            <Link
              href={`/controller/${id}`}
              className="rounded-md px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 hover:text-white [@media(max-height:640px)]:px-2"
            >
              Controller
            </Link>
            <span className="rounded-md bg-cyan-500/20 px-3 py-1.5 text-xs font-semibold text-cyan-100 [@media(max-height:640px)]:px-2">
              Board
            </span>
            {showDevControls ? (
              <Link
                href={`/judge/${id}`}
                className="rounded-md px-3 py-1.5 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/15 hover:text-amber-100 [@media(max-height:640px)]:px-2"
              >
                Judge
              </Link>
            ) : null}
          </div>
        </div>
      </div>
      <GameBoard sessionId={id} />
    </main>
  );
}
