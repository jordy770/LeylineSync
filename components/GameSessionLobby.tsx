'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  createGameSession,
  finishGameSession,
  getErrorMessage,
  joinGameSession,
  lockGameSession,
  spawnDeckForSession,
} from '@/lib/game/actions'
import { getCurrentPlayerSessions, getGameSession, getGameSessionPlayers } from '@/lib/game/data'
import type { GameSession, GameSessionPlayer } from '@/lib/game/types'

export default function GameSessionLobby() {
  const supabase = useMemo(() => createClient(), [])
  const [sessionIdInput, setSessionIdInput] = useState('')
  const [deckIdInput, setDeckIdInput] = useState('')
  const [playerSessions, setPlayerSessions] = useState<GameSession[]>([])
  const [activeSession, setActiveSession] = useState<GameSession | null>(null)
  const [players, setPlayers] = useState<GameSessionPlayer[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)

  const refreshSession = async (sessionId: string) => {
    const [session, sessionPlayers] = await Promise.all([
      getGameSession(supabase, sessionId),
      getGameSessionPlayers(supabase, sessionId),
    ])

    setActiveSession(session)
    setPlayers(sessionPlayers)
  }

  const refreshPlayerSessions = async () => {
    const sessions = await getCurrentPlayerSessions(supabase)
    setPlayerSessions(sessions)
  }

  useEffect(() => {
    let isMounted = true

    const loadPlayerSessions = async () => {
      try {
        const sessions = await getCurrentPlayerSessions(supabase)

        if (isMounted) {
          setPlayerSessions(sessions)
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to load player sessions:', message, error)
        if (isMounted) {
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
      const sessionId = await createGameSession(supabase)
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

  const handleLockSession = async () => {
    if (!activeSession) {
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)

    try {
      await lockGameSession(supabase, activeSession.id)
      await refreshSession(activeSession.id)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to lock game session:', message, error)
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

    const deckId = deckIdInput.trim()

    if (!deckId) {
      setErrorMessage('Enter a deck id')
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)

    try {
      const result = await spawnDeckForSession(supabase, activeSession.id, deckId)
      setStatusMessage(`${result.count} card(s) spawned into your library`)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to spawn deck:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  const winner = activeSession?.winner_player_id
    ? players.find((player) => player.player_id === activeSession.winner_player_id)
    : null

  return (
    <section className="w-full rounded-lg border border-slate-800 bg-slate-950 p-5 text-white">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="session-id" className="mb-2 block text-sm font-medium text-slate-300">
            Session ID
          </label>
          <input
            id="session-id"
            value={sessionIdInput}
            onChange={(event) => setSessionIdInput(event.target.value)}
            placeholder="Paste a session id"
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-slate-400"
          />
        </div>
        <button
          type="button"
          onClick={handleJoinSession}
          disabled={isWorking}
          className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Join
        </button>
        <button
          type="button"
          onClick={handleCreateSession}
          disabled={isWorking}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Create
        </button>
      </div>

      {playerSessions.length > 0 ? (
        <div className="mb-5 rounded-md border border-slate-800 p-3">
          <p className="mb-2 text-sm font-medium text-slate-300">Your Sessions</p>
          <div className="grid gap-2">
            {playerSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => handleSelectSession(session.id)}
                disabled={isWorking}
                className="flex flex-col gap-1 rounded-md bg-slate-900 p-3 text-left transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="break-all font-mono text-xs text-slate-300">{session.id}</span>
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {session.status}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {activeSession ? (
        <div className="space-y-4 rounded-md bg-slate-900 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs text-slate-500">Active Session</p>
              <p className="break-all font-mono text-sm">{activeSession.id}</p>
              <p className="mt-1 text-xs text-slate-400">Status: {activeSession.status}</p>
              {activeSession.status === 'finished' ? (
                <p className="mt-1 text-xs text-emerald-300">
                  Winner:{' '}
                  {winner
                    ? winner.username || `Player ${winner.player_id.slice(0, 8)}`
                    : activeSession.winner_player_id
                      ? activeSession.winner_player_id.slice(0, 8)
                      : 'None'}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleLockSession}
                disabled={isWorking || activeSession.status !== 'open'}
                className="rounded-md bg-slate-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Lock
              </button>
              <button
                type="button"
                onClick={handleFinishSession}
                disabled={isWorking || activeSession.status === 'finished'}
                className="rounded-md bg-red-500 px-4 py-2 text-sm font-semibold text-red-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Finish
              </button>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs text-slate-500">Players</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {players.map((player) => (
                <div key={player.player_id} className="rounded-md border border-slate-800 p-3">
                  <p className="text-sm font-semibold">Seat {player.seat_number}</p>
                  <p className="truncate text-sm text-slate-300">
                    {player.username || `Player ${player.player_id.slice(0, 8)}`}
                  </p>
                  <p className="truncate font-mono text-xs text-slate-500">{player.player_id}</p>
                  <p className="text-xs text-slate-500">Life {player.life_total}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-slate-800 p-3">
            <label htmlFor="deck-id" className="mb-2 block text-sm font-medium text-slate-300">
              Deck ID
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="deck-id"
                value={deckIdInput}
                onChange={(event) => setDeckIdInput(event.target.value)}
                placeholder="Paste a deck id"
                className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-slate-400"
              />
              <button
                type="button"
                onClick={handleSpawnDeck}
                disabled={isWorking}
                className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Spawn Deck
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href={`/controller/${activeSession.id}`}
              className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950"
            >
              Controller
            </Link>
            <Link
              href={`/board/${activeSession.id}`}
              className="rounded-md bg-slate-700 px-4 py-2 text-sm font-semibold text-white"
            >
              Board
            </Link>
          </div>
        </div>
      ) : null}

      {statusMessage ? <p className="mt-3 text-sm text-emerald-300">{statusMessage}</p> : null}
      {errorMessage ? <p className="mt-3 text-sm text-red-300">{errorMessage}</p> : null}
    </section>
  )
}
