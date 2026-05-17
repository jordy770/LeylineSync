import ControllerList from '@/components/ControllerList';
import ControllerListV2 from '@/components/ControllerListV2';
import { showDevControls } from '@/lib/game/dev';
import Link from 'next/link';
import { Suspense } from 'react';

export default function ControllerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ v?: string }>
}) {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-950" />}>
      <ControllerContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function ControllerContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ v?: string }>
}) {
  const { id } = await params;
  const { v } = await searchParams;
  const useLegacyController = v === '1';

  return (
    <main className="leyline-table-bg min-h-screen overflow-visible text-white">
      <div className="fixed inset-x-0 top-0 z-[240] flex h-8 items-center justify-end border-b border-white/10 bg-slate-950/88 px-3 shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur">
        <span className="rounded bg-cyan-500/20 px-3 py-1 text-xs font-semibold text-cyan-100">
          {useLegacyController ? 'Controller V1' : 'Controller V2'}
        </span>
        <Link
          href={`/controller/${id}${useLegacyController ? '' : '?v=1'}`}
          className="rounded px-3 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
        >
          {useLegacyController ? 'V2' : 'V1'}
        </Link>
        <Link
          href={`/board/${id}`}
          className="rounded px-3 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
        >
          Board
        </Link>
        {showDevControls ? (
          <Link
            href={`/judge/${id}`}
            className="rounded px-3 py-1 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/15 hover:text-amber-100"
          >
            Judge
          </Link>
        ) : null}
      </div>
      
      {useLegacyController ? <ControllerList sessionId={id} /> : <ControllerListV2 sessionId={id} />}
    </main>
  );
}
