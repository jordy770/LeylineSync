import Link from 'next/link'
import { redirect } from 'next/navigation'

import { GameAnalysisList } from '@/components/collection/GameAnalysisList'
import { Panel, Shell } from '@/components/collection/Shell'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// 🎮 Post-game coaching — your recent finished games, analysable straight from
// the engine's action log. Nested under the Advisor (not in the sub-nav).

export default async function GamesPage() {
  const supabase = await createClient()
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims?.claims?.sub) redirect('/auth/login')
  const userId = claims.claims.sub as string

  // is_bot=false: bot test runs seat a bot under a real auth id — those are not
  // the user's games and must never reach the coach (bug-1210).
  const { data: rows } = await supabase
    .from('game_session_players')
    .select('session_id, game_sessions!inner(id, status, created_at, finished_at, winner_player_id, format)')
    .eq('player_id', userId)
    .eq('is_bot', false)
    .eq('game_sessions.status', 'finished')
    .limit(60)

  const games = (rows ?? [])
    .flatMap((r) => {
      const s = Array.isArray(r.game_sessions) ? r.game_sessions[0] : r.game_sessions
      if (!s) return []
      return [
        {
          id: s.id as string,
          date: ((s.finished_at ?? s.created_at) as string) ?? '',
          won: s.winner_player_id === userId,
          format: (s.format as string) ?? 'commander',
        },
      ]
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 15)

  return (
    <Shell
      title="Post-game coaching"
      lead="Your finished games, analysed from the engine's own action log — what turned the game, and what your deck should learn."
      actions={
        <Link href="/collection/advisor" className="rounded-lg px-4 py-2 text-sm" style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}>
          ← Advisor
        </Link>
      }
    >
      {games.length === 0 ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            No finished games yet — play a game first (your phone is the controller, the TV is the board), then come
            back for the debrief.
          </p>
        </Panel>
      ) : (
        <GameAnalysisList games={games} />
      )}
    </Shell>
  )
}
