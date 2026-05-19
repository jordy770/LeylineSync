'use client'

import CombatAssignmentsPanel from '@/components/CombatAssignmentsPanel'
import DevAdminPanel from '@/components/DevAdminPanel'
import GameStatusPanel from '@/components/GameStatusPanel'
import LifeTotalsPanel from '@/components/LifeTotalsPanel'
import PlayerActionPanel from '@/components/PlayerActionPanel'
import StackPanel from '@/components/StackPanel'
import TurnStatusPanel from '@/components/TurnStatusPanel'
import JudgePlayerCardTools from '@/components/judge/JudgePlayerCardTools'
import JudgeStatChip from '@/components/judge/JudgeStatChip'
import PlayerManaPool from '@/components/judge/PlayerManaPool'
import RecentJudgeActions from '@/components/judge/RecentJudgeActions'
import { showDevControls } from '@/lib/game/dev'
import { getEmptyPlayerJudgeStats } from '@/lib/game/judge-selectors'
import { useJudgeGameState } from '@/lib/game/use-judge-game-state'

export default function JudgePanel({ sessionId }: { sessionId: string }) {
  const {
    sessionStatus,
    sessionPlayers,
    turnState,
    actionLogs,
    playerStats,
    errorMessage,
    refresh,
  } = useJudgeGameState(sessionId)

  if (!showDevControls) {
    return (
      <section className="leyline-glass-panel rounded-lg p-5 text-sm text-amber-100">
        Judge tools are disabled. Set NEXT_PUBLIC_SHOW_DEV_CONTROLS=true to expose this page.
      </section>
    )
  }

  const firstPlayerId = sessionPlayers[0]?.player_id ?? null
  const isSessionFinished = sessionStatus === 'finished'

  return (
    <div className="grid gap-5">
      <section className="leyline-glass-panel rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/80">Judge Console</p>
            <h1 className="text-xl font-bold text-white">Session Admin</h1>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-md border border-white/10 bg-slate-950/60 px-3 py-1.5 text-slate-300">
              Status: {sessionStatus}
            </span>
            <span className="rounded-md border border-white/10 bg-slate-950/60 px-3 py-1.5 text-slate-300">
              Players: {sessionPlayers.length}
            </span>
          </div>
        </div>
      </section>

      {errorMessage ? (
        <div className="rounded-lg border border-red-300/25 bg-red-950/40 p-3 text-sm text-red-100">
          {errorMessage}
        </div>
      ) : null}

      <DevAdminPanel
        sessionId={sessionId}
        currentPlayerId={firstPlayerId}
        sessionPlayers={sessionPlayers}
        turnState={turnState}
        onChanged={refresh}
      />

      <RecentJudgeActions actions={actionLogs} players={sessionPlayers} onChanged={refresh} />

      <section className="grid gap-4 2xl:grid-cols-2">
        {sessionPlayers.map((player) => {
          const stats = playerStats[player.player_id] ?? getEmptyPlayerJudgeStats()

          return (
            <div key={player.player_id} className="leyline-glass-panel rounded-lg p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300">
                    Player {player.seat_number}
                  </p>
                  <h2 className="text-base font-bold text-white">{player.username ?? player.player_id.slice(0, 8)}</h2>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <JudgeStatChip label="Life" value={player.life_total} tone="life" />
                  <JudgeStatChip label="Hand" value={stats.handCount} tone="hand" />
                  <JudgeStatChip label="Library" value={stats.libraryCount} tone="library" />
                  <JudgeStatChip label="Tapped" value={stats.tappedBattlefieldCount} tone="tapped" />
                </div>
              </div>
              <PlayerActionPanel
                sessionId={sessionId}
                playerId={player.player_id}
                libraryCount={stats.libraryCount}
                handCount={stats.handCount}
                tappedBattlefieldCount={stats.tappedBattlefieldCount}
                isSessionFinished={isSessionFinished}
                judgeMode
              />
              <PlayerManaPool manaPool={stats.manaPool} />
              <JudgePlayerCardTools
                sessionId={sessionId}
                playerId={player.player_id}
                cards={stats.cards}
                isSessionFinished={isSessionFinished}
                onChanged={refresh}
              />
            </div>
          )
        })}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <GameStatusPanel sessionId={sessionId} />
        <TurnStatusPanel sessionId={sessionId} />
        <StackPanel sessionId={sessionId} />
        <LifeTotalsPanel sessionId={sessionId} />
        <CombatAssignmentsPanel sessionId={sessionId} />
      </section>
    </div>
  )
}
