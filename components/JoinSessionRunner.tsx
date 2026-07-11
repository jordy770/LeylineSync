'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { getErrorMessage, joinGameSession } from '@/lib/game/actions'
import { createClient } from '@/lib/supabase/client'

// Joins the session and forwards to the controller. Already being a member
// (rescan, refresh) is success, not an error — just go to the controller.
export default function JoinSessionRunner({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const supabase = createClient()
    joinGameSession(supabase, sessionId)
      .then(() => router.replace(`/controller/${sessionId}`))
      .catch((err) => {
        const message = getErrorMessage(err)
        if (/already|member|joined/i.test(message)) {
          router.replace(`/controller/${sessionId}`)
          return
        }
        setError(message)
      })
  }, [router, sessionId])

  if (error) {
    return (
      <div className="max-w-sm px-6 text-center">
        <p className="font-display text-sm uppercase tracking-[0.35em] text-amber-300">Leyline Sync</p>
        <p className="mt-4 text-sm text-red-300">Couldn&apos;t join this game: {error}</p>
        <p className="mt-2 text-sm text-slate-400">Ask the host for a fresh QR code, or check that the game hasn&apos;t started without open seats.</p>
      </div>
    )
  }

  return (
    <div className="text-center">
      <p className="font-display text-sm uppercase tracking-[0.35em] text-amber-300">Leyline Sync</p>
      <p className="mt-4 animate-pulse text-lg font-bold text-white">Taking your seat…</p>
    </div>
  )
}
