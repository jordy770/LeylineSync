import GameBoard from '@/components/GameBoard';
import GameViewHeader from '@/components/layout/GameViewHeader';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
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

  // Require a logged-in session. The board reads + subscribes to session state, and
  // Supabase realtime postgres_changes are RLS-filtered per subscriber: an ANONYMOUS
  // board gets a SUBSCRIBED channel that delivers ZERO events, so it would fall back
  // to constant polling. Logging in (the board operator is normally the host, a
  // session member) lets realtime deliver and keeps the fallback poll off.
  const supabase = await createClient();
  const { data: claims, error } = await supabase.auth.getClaims();
  if (error || !claims?.claims?.sub) {
    redirect(`/auth/login?next=/board/${id}`);
  }

  return (
    <main className="leyline-table-bg min-h-screen overflow-hidden text-white">
      <GameViewHeader sessionId={id} activeView="board" title="Board View" compactHeight />
      <GameBoard sessionId={id} />
    </main>
  );
}
