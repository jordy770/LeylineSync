import GameBoard from '@/components/GameBoard';
import GameViewHeader from '@/components/layout/GameViewHeader';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

export default function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ key?: string }>;
}) {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-950" />}>
      <BoardContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function BoardContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ key?: string }>;
}) {
  const { id } = await params;
  const { key } = await searchParams;

  // Two ways in:
  //  * a logged-in session member (realtime-first board, cast/share controls);
  //  * a SPECTATOR carrying the session's board_token (mig 378) — the TV / cast
  //    receiver. No login; the board polls get_board_state_by_token (realtime
  //    delivers nothing to anon under RLS) and hides member-only chrome.
  const supabase = await createClient();
  const { data: claims, error } = await supabase.auth.getClaims();
  const isMember = !error && Boolean(claims?.claims?.sub);
  if (!isMember && !key) {
    redirect(`/auth/login?next=/board/${id}`);
  }
  const shareToken = isMember ? null : (key ?? null);

  return (
    <main className="leyline-table-bg min-h-screen overflow-hidden text-white">
      {shareToken ? null : (
        <GameViewHeader sessionId={id} activeView="board" title="Board View" compactHeight />
      )}
      <GameBoard sessionId={id} shareToken={shareToken} />
    </main>
  );
}
