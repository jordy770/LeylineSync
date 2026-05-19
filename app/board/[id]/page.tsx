import GameBoard from '@/components/GameBoard';
import GameViewHeader from '@/components/layout/GameViewHeader';
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
      <GameViewHeader sessionId={id} activeView="board" title="Board View" compactHeight />
      <GameBoard sessionId={id} />
    </main>
  );
}
