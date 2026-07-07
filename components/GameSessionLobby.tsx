'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  Copy,
  Crown,
  Flag,
  Gamepad2,
  Library,
  LogIn,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  Smartphone,
  Sparkles,
  Trophy,
  Users,
  X,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import {
  addBotToSession,
  clearDeckFromSession,
  createGameSession,
  finishGameSession,
  getErrorMessage,
  joinGameSession,
  spawnDeckForSession,
  startGameSession,
} from '@/lib/game/actions'
import {
  getCurrentPlayerSessions,
  getGameSession,
  getGameSessionPlayers,
  getPreconDecks,
  getSpawnedDeckOwnerIds,
  getUserDecks,
} from '@/lib/game/data'
import CastShareControls from '@/components/board/CastShareControls'
import type { DeckSummary, GameSession, GameSessionPlayer, GameSessionStatus } from '@/lib/game/types'

export default function GameSessionLobby() {
  const supabase = useMemo(() => createClient(), [])
  const [sessionIdInput, setSessionIdInput] = useState('')
  const [selectedDeckId, setSelectedDeckId] = useState('')
  const [userDecks, setUserDecks] = useState<DeckSummary[]>([])
  const [preconDecks, setPreconDecks] = useState<DeckSummary[]>([])
  const [playerSessions, setPlayerSessions] = useState<GameSession[]>([])
  const [activeSession, setActiveSession] = useState<GameSession | null>(null)
  const [players, setPlayers] = useState<GameSessionPlayer[]>([])
  // Players that have spawned a deck = "ready" (derived, no DB column). Set on
  // every refreshSession + kept live by the realtime subscription below.
  const [readyPlayerIds, setReadyPlayerIds] = useState<Set<string>>(() => new Set())
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)
  const [format, setFormat] = useState<'standard' | 'commander'>('standard')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // When set, the "pick your deck" step is shown before the game actually starts.
  const [isPickingDeck, setIsPickingDeck] = useState(false)

  const refreshSession = async (sessionId: string) => {
    const [session, sessionPlayers, readyIds] = await Promise.all([
      getGameSession(supabase, sessionId),
      getGameSessionPlayers(supabase, sessionId),
      getSpawnedDeckOwnerIds(supabase, sessionId),
    ])

    setActiveSession(session)
    setPlayers(sessionPlayers)
    setReadyPlayerIds(readyIds)
  }

  const refreshPlayerSessions = async () => {
    const sessions = await getCurrentPlayerSessions(supabase)
    setPlayerSessions(sessions)
  }

  const refreshUserDecks = async () => {
    const [decks, precons] = await Promise.all([getUserDecks(supabase), getPreconDecks(supabase)])
    setUserDecks(decks)
    setPreconDecks(precons)
    setSelectedDeckId((current) => current || decks[0]?.id || precons[0]?.id || '')
  }

  useEffect(() => {
    let isMounted = true

    const loadPlayerSessions = async () => {
      try {
        const [{ data: auth }, sessions, decks, precons] = await Promise.all([
          supabase.auth.getUser(),
          getCurrentPlayerSessions(supabase),
          getUserDecks(supabase),
          getPreconDecks(supabase),
        ])

        if (isMounted) {
          setMyPlayerId(auth.user?.id ?? null)
          setPlayerSessions(sessions)
          setUserDecks(decks)
          setPreconDecks(precons)
          setSelectedDeckId((current) => current || decks[0]?.id || precons[0]?.id || '')
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to load player sessions:', message, error)
        // A signed-out visitor simply has no sessions yet — that's the normal
        // anonymous state, not an error worth a red banner on first paint.
        // Real auth errors still surface when they ACT (join/create).
        if (isMounted && !/auth session missing/i.test(message)) {
          setErrorMessage(message)
        }
      }
    }

    loadPlayerSessions()

    return () => {
      isMounted = false
    }
  }, [supabase])

  const handleCreateSession = async () => {
    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)

    try {
      const sessionId = await createGameSession(supabase, format)
      setSessionIdInput(sessionId)
      await refreshSession(sessionId)
      await refreshPlayerSessions()
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to create game session:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  const handleJoinSession = async () => {
    const sessionId = sessionIdInput.trim()

    if (!sessionId) {
      setErrorMessage('Enter a session id')
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)

    try {
      await joinGameSession(supabase, sessionId)
      await refreshSession(sessionId)
      await refreshPlayerSessions()
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to join game session:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  // Run the actual game start. Optionally spawn the picked deck first, so the
  // host can go from "Start" → pick deck → playing in one step. Re-spawning is
  // harmless: if this player already seeded a library we just start.
  const handleStartGame = async (spawnDeckId?: string) => {
    if (!activeSession) {
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)

    try {
      const deckId = spawnDeckId?.trim()
      if (deckId) {
        try {
          const isPrecon = preconDecks.some((deck) => deck.id === deckId)
          await spawnDeckForSession(supabase, activeSession.id, deckId, !isPrecon)
        } catch (error) {
          if (!/already have a deck/i.test(getErrorMessage(error))) {
            throw error
          }
        }
      }

      const result = await startGameSession(supabase, activeSession.id)
      await refreshSession(activeSession.id)
      setIsPickingDeck(false)
      setStatusMessage(
        `Game started — ${result.players} players, first player chosen at random`,
      )
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to start game session:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  const handleAddBot = async () => {
    if (!activeSession) {
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)

    try {
      await addBotToSession(supabase, activeSession.id)
      await refreshSession(activeSession.id)
      setStatusMessage(
        'CPU seated. It takes its turns automatically once the game starts (the bot service is ' +
          'always on in production; for local dev run `npm run bot -- --watch`).',
      )
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to add CPU opponent:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  const handleFinishSession = async () => {
    if (!activeSession) {
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)

    try {
      await finishGameSession(supabase, activeSession.id)
      await refreshSession(activeSession.id)
      await refreshPlayerSessions()
      setStatusMessage('Game session finished')
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to finish game session:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  const handleSelectSession = async (sessionId: string) => {
    setErrorMessage(null)
    setStatusMessage(null)
    setSessionIdInput(sessionId)
    setIsWorking(true)

    try {
      await refreshSession(sessionId)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to select game session:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  const handleSpawnDeck = async () => {
    if (!activeSession) {
      return
    }

    const deckId = selectedDeckId.trim()

    if (!deckId) {
      setErrorMessage('Select a deck')
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)

    try {
      const isPrecon = preconDecks.some((deck) => deck.id === deckId)
      const result = await spawnDeckForSession(supabase, activeSession.id, deckId, !isPrecon)
      await refreshSession(activeSession.id)
      setStatusMessage(
        `Deck locked in (${result.library} card(s)) · you're ready` +
          (result.commander_seeded ? ' · commander placed in the command zone' : ''),
      )
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to lock in deck:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  // Undo a lock-in (lobby only): clears the spawned cards so a different deck can
  // be picked. The server refuses once the game has started.
  const handleChangeDeck = async () => {
    if (!activeSession) {
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)

    try {
      await clearDeckFromSession(supabase, activeSession.id)
      await refreshSession(activeSession.id)
      setStatusMessage('Deck cleared — pick another and lock in.')
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to change deck:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  // Close the deck-pick step (if open) or the manage modal on Escape.
  useEffect(() => {
    if (!activeSession) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (isPickingDeck) {
        setIsPickingDeck(false)
      } else {
        setActiveSession(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeSession, isPickingDeck])

  // Reset the deck-pick step whenever the manage modal closes.
  useEffect(() => {
    if (!activeSession) setIsPickingDeck(false)
  }, [activeSession])

  // While managing a session, keep players + readiness live so the host sees
  // others ready up (spawn a deck) and the game start without a manual refresh.
  useEffect(() => {
    const sessionId = activeSession?.id
    if (!sessionId) return

    const channel = supabase
      .channel(`lobby:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `session_id=eq.${sessionId}` }, () => {
        refreshSession(sessionId).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_session_players', filter: `session_id=eq.${sessionId}` }, () => {
        refreshSession(sessionId).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` }, () => {
        refreshSession(sessionId).catch(() => {})
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.id, supabase])

  const handleCopyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      setCopiedId(id)
      setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500)
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  const winner = activeSession?.winner_player_id
    ? players.find((player) => player.player_id === activeSession.winner_player_id)
    : null

  const hasDecks = userDecks.length > 0 || preconDecks.length > 0

  // Readiness (derived from a spawned library). The host can start once every
  // OTHER player is ready — the host readies themselves through the deck-pick
  // step's spawn. We surface who we're still waiting on.
  const isPlayerReady = (playerId: string) => readyPlayerIds.has(playerId)
  const iAmReady = myPlayerId ? isPlayerReady(myPlayerId) : false
  const waitingOnOthers = players.filter((p) => p.player_id !== myPlayerId && !isPlayerReady(p.player_id))
  const canHostStart = waitingOnOthers.length === 0

  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-slate-950 p-5 text-white shadow-2xl shadow-black/40 sm:p-6">
      {/* Arcane glow accents */}
      <div className="pointer-events-none absolute -left-20 -top-24 h-72 w-72 rounded-full bg-amber-600/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-emerald-600/10 blur-3xl" />
      <div className="relative space-y-7">
      {/* ── Create / Join ─────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* New game */}
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-amber-950/50 via-slate-950 to-slate-950 p-6 text-white shadow-xl shadow-black/30">
          <div className="pointer-events-none absolute -right-12 -top-12 h-44 w-44 rounded-full bg-amber-500/20 blur-3xl" />
          <div className="relative">
            <div className="flex items-center gap-2 text-amber-300">
              <Sparkles className="h-4 w-4" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em]">New game</span>
            </div>
            <h2 className="mt-2 text-2xl font-bold tracking-tight">Start a table</h2>
            <p className="mt-1 max-w-md text-sm text-slate-400">
              Spin up a session, open the board on the big screen, and hand a controller to every phone.
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <div
                className="inline-flex rounded-lg border border-white/10 bg-black/20 p-1"
                role="group"
                aria-label="Game format"
              >
                {(['standard', 'commander'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFormat(f)}
                    disabled={isWorking}
                    aria-pressed={format === f}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold capitalize transition disabled:opacity-50 ${
                      format === f
                        ? 'bg-amber-500 text-white shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {f === 'commander' && <Crown className="h-3.5 w-3.5" />}
                    {f}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={handleCreateSession}
                disabled={isWorking}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-bold text-emerald-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Create game
              </button>
            </div>
          </div>
        </div>

        {/* Join by ID */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-white">
          <div className="flex items-center gap-2 text-slate-300">
            <LogIn className="h-4 w-4" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">Join a game</span>
          </div>
          <p className="mt-2 text-sm text-slate-500">Got a session ID from a friend? Drop in here.</p>
          <div className="mt-4 flex gap-2">
            <input
              id="session-id"
              value={sessionIdInput}
              onChange={(event) => setSessionIdInput(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && handleJoinSession()}
              placeholder="Session ID"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-sm text-white outline-none transition focus:border-amber-400/60"
            />
            <button
              type="button"
              onClick={handleJoinSession}
              disabled={isWorking}
              className="shrink-0 rounded-lg bg-white px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Join
            </button>
          </div>
        </div>
      </div>

      {/* ── Your games overview ───────────────────────────────────────── */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <Gamepad2 className="h-5 w-5 text-slate-400" />
          <h2 className="text-lg font-bold text-white">Your games</h2>
          {playerSessions.length > 0 && (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold text-slate-300">
              {playerSessions.length}
            </span>
          )}
        </div>

        {playerSessions.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {playerSessions.map((session) => {
              const meta = statusMeta(session.status)
              const isActive = activeSession?.id === session.id
              const when = relativeTime(session.created_at)
              return (
                <div
                  key={session.id}
                  className={`group relative flex flex-col gap-3 rounded-xl border bg-slate-900/60 p-4 transition ${
                    isActive
                      ? 'border-amber-400/60 ring-1 ring-amber-400/30'
                      : 'border-white/10 hover:border-white/20 hover:bg-slate-900'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${meta.cls}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
                    {when && <span className="text-[11px] text-slate-500">{when}</span>}
                  </div>

                  <button
                    type="button"
                    onClick={() => handleCopyId(session.id)}
                    title="Copy session ID"
                    className="flex items-center gap-2 self-start font-mono text-xs text-slate-400 transition hover:text-slate-200"
                  >
                    {copiedId === session.id ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5 opacity-60" />
                    )}
                    {session.id.slice(0, 8)}…{session.id.slice(-4)}
                  </button>

                  <div className="mt-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSelectSession(session.id)}
                      disabled={isWorking}
                      className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        isActive
                          ? 'bg-amber-500 text-white'
                          : 'bg-white/10 text-slate-200 hover:bg-white/15'
                      }`}
                    >
                      {isActive ? 'Managing' : 'Manage'}
                    </button>
                    <Link
                      href={`/controller/${session.id}`}
                      title="Open controller"
                      className="rounded-lg bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
                    >
                      <Smartphone className="h-4 w-4" />
                    </Link>
                    <Link
                      href={`/board/${session.id}`}
                      title="Open board"
                      className="rounded-lg bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
                    >
                      <Monitor className="h-4 w-4" />
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-12 text-center">
            <Gamepad2 className="h-8 w-8 text-slate-600" />
            <p className="mt-3 text-sm font-medium text-slate-400">No games yet</p>
            <p className="mt-1 text-xs text-slate-500">Create a table above or join one with a session ID.</p>
          </div>
        )}
      </div>

      {/* ── Manage session — modal so the landing page never has to scroll ── */}
      {activeSession ? (
        <div
          className="fixed inset-0 z-[70] flex justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setActiveSession(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="relative mx-auto my-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--frame-gold)]/25 bg-slate-950 shadow-2xl shadow-black/60"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setActiveSession(null)}
              aria-label="Close"
              className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full bg-white/5 text-slate-400 transition hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          {/* Header */}
          <div className="flex flex-col gap-4 border-b border-white/10 bg-white/[0.02] p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {(() => {
                  const meta = statusMeta(activeSession.status)
                  return (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${meta.cls}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
                  )
                })()}
                <span className="text-xs text-slate-500">Active session</span>
              </div>
              <button
                type="button"
                onClick={() => handleCopyId(activeSession.id)}
                className="mt-2 flex items-center gap-2 font-mono text-sm text-slate-300 transition hover:text-white"
                title="Copy session ID"
              >
                {copiedId === activeSession.id ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : (
                  <Copy className="h-4 w-4 opacity-60" />
                )}
                <span className="truncate">{activeSession.id}</span>
              </button>
              {activeSession.status === 'finished' && (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-300">
                  <Trophy className="h-3.5 w-3.5" />
                  Winner: {winner
                    ? winner.username || `Player ${winner.player_id.slice(0, 8)}`
                    : activeSession.winner_player_id
                      ? activeSession.winner_player_id.slice(0, 8)
                      : 'None'}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleAddBot}
                disabled={isWorking || activeSession.status !== 'open'}
                title="Seat an AI CPU opponent (run the bot-runner --watch to make it play)"
                className="inline-flex items-center gap-1.5 rounded-lg border border-sky-400/30 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-300 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Gamepad2 className="h-4 w-4" />
                Add CPU
              </button>
              <button
                type="button"
                onClick={() => setIsPickingDeck(true)}
                disabled={isWorking || activeSession.status !== 'open' || !canHostStart}
                title={
                  canHostStart
                    ? undefined
                    : `Waiting for ${waitingOnOthers.length} player(s) to pick a deck`
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Play className="h-4 w-4" />
                {activeSession.status === 'open' && !canHostStart
                  ? `Waiting (${waitingOnOthers.length})`
                  : 'Start'}
              </button>
              <button
                type="button"
                onClick={handleFinishSession}
                disabled={isWorking || activeSession.status === 'finished'}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Flag className="h-4 w-4" />
                Finish
              </button>
            </div>
          </div>

          <div className="space-y-5 p-5">
            {/* Players */}
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <Users className="h-3.5 w-3.5" /> Players · {players.length}
              </p>
              {players.length > 0 ? (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {players.map((player) => {
                    const name = player.username || `Player ${player.player_id.slice(0, 8)}`
                    const isWinner = activeSession.winner_player_id === player.player_id
                    const ready = isPlayerReady(player.player_id)
                    return (
                      <div
                        key={player.player_id}
                        className={`flex items-center gap-3 rounded-lg border p-3 ${
                          isWinner ? 'border-amber-500/40 bg-amber-500/5' : 'border-white/10 bg-white/[0.02]'
                        }`}
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-500/40 to-sky-500/30 text-sm font-bold text-white">
                          {name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-white">
                            {name}
                            {isWinner && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
                          </p>
                          <p className="text-xs text-slate-500">Seat {player.seat_number} · {player.life_total} life</p>
                        </div>
                        {activeSession.status === 'open' && (
                          ready ? (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                              <Check className="h-3 w-3" /> Ready
                            </span>
                          ) : (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" /> Choosing…
                            </span>
                          )
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-slate-500">
                  No players have joined yet.
                </p>
              )}
            </div>

            {/* Deck spawn */}
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <Library className="h-3.5 w-3.5" /> Your deck
                  {activeSession.status === 'open' && (
                    iAmReady ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                        <Check className="h-3 w-3" /> Ready
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                        Lock in a deck to ready up
                      </span>
                    )
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      refreshUserDecks().catch((error) => {
                        const message = getErrorMessage(error)
                        console.error('Failed to refresh decks:', message, error)
                        setErrorMessage(message)
                      })
                    }
                    disabled={isWorking}
                    className="inline-flex items-center gap-1.5 rounded-md bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className="h-3 w-3" /> Refresh
                  </button>
                  <Link
                    href="/decks"
                    className="rounded-md bg-sky-400 px-3 py-1 text-xs font-semibold text-sky-950 transition hover:bg-sky-300"
                  >
                    Manage decks
                  </Link>
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  id="deck-select"
                  value={selectedDeckId}
                  onChange={(event) => setSelectedDeckId(event.target.value)}
                  disabled={isWorking || !hasDecks || iAmReady}
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none transition focus:border-amber-400/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {!hasDecks ? (
                    <option value="">No decks found</option>
                  ) : (
                    <>
                      {userDecks.length > 0 && (
                        <optgroup label="Your decks">
                          {userDecks.map((deck) => (
                            <option key={deck.id} value={deck.id}>
                              {deck.name || 'Untitled Deck'} ({deck.card_count})
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {preconDecks.length > 0 && (
                        <optgroup label="Precons">
                          {preconDecks.map((deck) => (
                            <option key={deck.id} value={deck.id}>
                              {deck.name || 'Untitled Precon'} ({deck.card_count})
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </>
                  )}
                </select>
                {iAmReady ? (
                  <button
                    type="button"
                    onClick={handleChangeDeck}
                    disabled={isWorking}
                    title="Clear your locked-in deck so you can pick a different one"
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className="h-4 w-4" /> Change deck
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSpawnDeck}
                    disabled={isWorking || !selectedDeckId}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-bold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Sparkles className="h-4 w-4" /> Lock in deck
                  </button>
                )}
              </div>
              {!hasDecks && (
                <p className="mt-2 text-xs text-slate-500">Create a deck first, then refresh this list.</p>
              )}
            </div>

            {/* Open surfaces */}
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/controller/${activeSession.id}`}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-slate-200"
              >
                <Smartphone className="h-4 w-4" /> Open controller
              </Link>
              <Link
                href={`/board/${activeSession.id}`}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-white transition hover:bg-white/10"
              >
                <Monitor className="h-4 w-4" /> Open board
              </Link>
              {/* Put the board on the TV straight from the lobby (mig 378):
                  📺 casts via the Presentation API, 🔗 copies the no-login
                  spectator link for any smart-TV browser. */}
              <CastShareControls sessionId={activeSession.id} />
            </div>
            {/* Phones can't cast reliably (Android Chrome won't present URLs to a
                Chromecast; iOS not at all) — the TV route is the room code. */}
            {activeSession.tv_code ? (
              <p className="text-xs text-slate-400">
                📺 TV without cast? Open{' '}
                <span className="font-semibold text-slate-200">leylinesync.com/tv</span> in its browser and enter code{' '}
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-sm font-black tracking-[0.25em] text-amber-300">
                  {activeSession.tv_code}
                </span>
              </p>
            ) : null}
          </div>

          {/* Deck-pick step — shown after pressing Start, before the game begins. */}
          {isPickingDeck ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/85 p-5 backdrop-blur-sm">
              <div className="w-full max-w-md rounded-2xl border border-amber-400/20 bg-slate-900 p-5 shadow-2xl">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-300">
                  <Library className="h-3.5 w-3.5" /> Choose your deck
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  Pick the deck you&apos;ll play. We&apos;ll lock it in and start the game.
                </p>

                <select
                  value={selectedDeckId}
                  onChange={(event) => setSelectedDeckId(event.target.value)}
                  disabled={isWorking || !hasDecks}
                  className="mt-4 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none transition focus:border-amber-400/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {!hasDecks ? (
                    <option value="">No decks found</option>
                  ) : (
                    <>
                      {userDecks.length > 0 && (
                        <optgroup label="Your decks">
                          {userDecks.map((deck) => (
                            <option key={deck.id} value={deck.id}>
                              {deck.name || 'Untitled Deck'} ({deck.card_count})
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {preconDecks.length > 0 && (
                        <optgroup label="Precons">
                          {preconDecks.map((deck) => (
                            <option key={deck.id} value={deck.id}>
                              {deck.name || 'Untitled Precon'} ({deck.card_count})
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </>
                  )}
                </select>
                {!hasDecks && (
                  <p className="mt-2 text-xs text-slate-500">Create a deck first, then refresh this list.</p>
                )}

                <div className="mt-5 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => handleStartGame()}
                    disabled={isWorking}
                    className="text-xs font-semibold text-slate-400 underline-offset-2 transition hover:text-slate-200 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Skip — decks already spawned
                  </button>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setIsPickingDeck(false)}
                      disabled={isWorking}
                      className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => handleStartGame(selectedDeckId)}
                      disabled={isWorking || !selectedDeckId}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Play className="h-4 w-4" /> Spawn &amp; start
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          </div>
        </div>
      ) : null}

      {/* Messages */}
      {statusMessage && (
        <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {errorMessage}
        </p>
      )}
      </div>
    </section>
  )
}

const STATUS_META: Record<GameSessionStatus, { label: string; cls: string; dot: string }> = {
  open: { label: 'Lobby', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300', dot: 'bg-amber-400' },
  locked: {
    label: 'Playing',
    cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    dot: 'bg-emerald-400 animate-pulse',
  },
  finished: { label: 'Finished', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-400', dot: 'bg-slate-500' },
}

function statusMeta(status: GameSessionStatus) {
  return STATUS_META[status] ?? STATUS_META.open
}

function relativeTime(iso?: string): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const seconds = Math.floor((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
