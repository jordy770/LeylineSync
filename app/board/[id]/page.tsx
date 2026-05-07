import GameBoard from '@/components/GameBoard';
import CombatAssignmentsPanel from '@/components/CombatAssignmentsPanel';
import GameStatusPanel from '@/components/GameStatusPanel';
import LifeTotalsPanel from '@/components/LifeTotalsPanel';
import StackPanel from '@/components/StackPanel';
import TurnStatusPanel from '@/components/TurnStatusPanel';
import { showDevControls } from '@/lib/game/dev';
import { Suspense } from 'react';

export default function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<main className="bg-slate-900 min-h-screen" />}>
      <BoardContent params={params} />
    </Suspense>
  );
}

async function BoardContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#082f49_0,_#07111f_38%,_#020617_100%)] text-white">
      <div className="flex items-center justify-between border-b border-cyan-200/10 bg-slate-950/80 p-4 shadow-[0_0_28px_rgba(14,165,233,0.12)] backdrop-blur">
        <h1 className="font-bold tracking-wide text-cyan-50">LeylineSync - Board View</h1>
        <code className="text-xs text-slate-400">Session: {id}</code>
      </div>
      
      {showDevControls ? (
        <div className="p-4 pb-0 sm:p-6">
          <div className="mb-3 rounded border border-amber-300/30 bg-amber-950/30 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-amber-200">
            Dev board panels
          </div>
          <GameStatusPanel sessionId={id} />
          <TurnStatusPanel sessionId={id} />
          <StackPanel sessionId={id} />
          <LifeTotalsPanel sessionId={id} />
          <CombatAssignmentsPanel sessionId={id} />
        </div>
      ) : null}
      <GameBoard sessionId={id} />
    </main>
  );
}
