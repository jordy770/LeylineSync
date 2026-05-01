import ControllerList from '@/components/ControllerList';
import ManaPool from '@/components/ManaPool';
import TurnStatusPanel from '@/components/TurnStatusPanel';
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
    <main className="bg-black min-h-screen p-6">
      <h1 className="text-white text-xl font-bold mb-6 text-center">Your Hand</h1>
      <TurnStatusPanel sessionId={id} />
      <ManaPool sessionId={id} />
      
      {/* Een nieuwe component die alle kaarten van de sessie ophaalt voor de controller */}
      <ControllerList sessionId={id} />
    </main>
  );
}
