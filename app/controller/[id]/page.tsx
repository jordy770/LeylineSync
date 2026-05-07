import ControllerList from '@/components/ControllerList';
import CombatAssignmentsPanel from '@/components/CombatAssignmentsPanel';
import GameStatusPanel from '@/components/GameStatusPanel';
import LifeTotalsPanel from '@/components/LifeTotalsPanel';
import ManaPool from '@/components/ManaPool';
import StackPanel from '@/components/StackPanel';
import TurnStatusPanel from '@/components/TurnStatusPanel';
import { showDevControls } from '@/lib/game/dev';
import { Suspense } from 'react';

export default function ControllerPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<main className="bg-black min-h-screen" />}>
      <ControllerContent params={params} />
    </Suspense>
  );
}

async function ControllerContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="min-h-screen overflow-visible bg-[radial-gradient(circle_at_top,_#123047_0,_#07111f_44%,_#020617_100%)] text-white">
      {showDevControls ? (
        <div className="p-4 pb-0 sm:p-6">
          <div className="mb-3 rounded border border-amber-300/30 bg-amber-950/30 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-amber-200">
            Dev controller panels
          </div>
          <GameStatusPanel sessionId={id} />
          <TurnStatusPanel sessionId={id} />
          <StackPanel sessionId={id} />
          <LifeTotalsPanel sessionId={id} />
          <CombatAssignmentsPanel sessionId={id} />
          <ManaPool sessionId={id} />
        </div>
      ) : null}
      
      {/* Een nieuwe component die alle kaarten van de sessie ophaalt voor de controller */}
      <ControllerList sessionId={id} />
    </main>
  );
}
