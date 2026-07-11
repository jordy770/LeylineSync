'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { createClient } from '@/lib/supabase/client'

// Room-code entry for the TV (mig 379): big targets for a remote's on-screen
// keyboard, no login. Resolves the code to the tokenized spectator board.
export default function TvCodeEntry() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const trimmed = code.trim()
    if (trimmed.length < 3 || busy) return
    setBusy(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.rpc('get_board_access_by_code', { p_code: trimmed })
      if (error) throw error
      const access = data as { session_id: string; board_token: string }
      router.push(`/board/${access.session_id}?key=${access.board_token}`)
    } catch {
      setError('Unknown code — check the lobby screen and try again.')
      setBusy(false)
    }
  }

  return (
    <div className="w-full max-w-md px-6 text-center">
      <p className="font-display text-sm uppercase tracking-[0.35em] text-amber-300">Leyline Sync</p>
      <h1 className="font-display mt-2 text-3xl font-bold text-white">Watch the table</h1>
      <p className="mt-2 text-sm text-slate-400">
        Enter the room code shown in the game lobby.
      </p>
      <form
        className="mt-8 flex flex-col items-center gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          autoFocus
          maxLength={4}
          placeholder="CODE"
          aria-label="Room code"
          className="w-56 rounded-2xl border border-amber-400/40 bg-slate-950/70 px-4 py-4 text-center font-mono text-4xl font-black tracking-[0.4em] text-amber-200 outline-none placeholder:text-slate-700 focus:border-amber-300"
        />
        <button
          type="submit"
          disabled={busy || code.trim().length < 3}
          className="rounded-2xl bg-amber-500 px-10 py-4 text-lg font-bold text-amber-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Joining…' : 'Watch'}
        </button>
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
      </form>
    </div>
  )
}
