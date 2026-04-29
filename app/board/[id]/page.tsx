import GameBoard from '@/components/GameBoard';
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
    <main className="bg-slate-900 min-h-screen">
      <div className="p-4 bg-slate-800 text-white flex justify-between items-center">
        <h1 className="font-bold">LeylineSync - Board View</h1>
        <code className="text-xs text-slate-400">Session: {id}</code>
      </div>
      
      {/* Hier komt de component die luistert naar de database */}
      <GameBoard sessionId={id} />
    </main>
  );
}
