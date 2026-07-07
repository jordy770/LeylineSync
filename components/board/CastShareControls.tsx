'use client'

import { useEffect, useMemo, useState } from 'react'

import { getBoardShareToken } from '@/lib/game/data'
import { createClient } from '@/lib/supabase/client'

// Cast the board to a TV. Two paths off the same spectator link (mig 378):
//   📺 Presentation API — a Chromecast/Miracast device loads the tokenized board
//      URL itself (crisp, no mirroring); Chromium-only, hidden elsewhere.
//   🔗 Copy link — paste into any smart-TV/console browser; the token grants
//      read-only board polling without a login.
export default function CastShareControls({ sessionId }: { sessionId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [castError, setCastError] = useState(false)

  useEffect(() => {
    let live = true
    getBoardShareToken(supabase, sessionId)
      .then((token) => {
        if (live) setShareUrl(`${window.location.origin}/board/${sessionId}?key=${token}`)
      })
      .catch(() => {}) // non-member or offline — controls simply stay hidden
    return () => {
      live = false
    }
  }, [supabase, sessionId])

  const canCast = typeof window !== 'undefined' && 'PresentationRequest' in window

  if (!shareUrl) return null

  const startCast = async () => {
    setCastError(false)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PresentationRequest is Chromium-only
      const request = new (window as any).PresentationRequest([shareUrl])
      await request.start()
    } catch {
      setCastError(true) // dismissed the picker or no devices — not fatal
      setTimeout(() => setCastError(false), 2500)
    }
  }

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const buttonClass =
    'rounded-lg border border-slate-700 bg-slate-900/85 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/20 transition-colors hover:border-cyan-300/40 hover:bg-slate-800 [@media(max-height:640px)]:px-2.5 [@media(max-height:640px)]:py-1.5 [@media(max-height:640px)]:text-xs'

  return (
    <>
      {canCast && (
        <button type="button" onClick={() => void startCast()} className={buttonClass}
          title={castError ? 'No cast device found' : 'Cast the board to a TV (Chromecast)'}>
          {castError ? '📺✕' : '📺'}
        </button>
      )}
      <button type="button" onClick={() => void copyLink()} className={buttonClass}
        title="Copy the board link — opens read-only in any TV browser, no login needed">
        {copied ? '✓' : '🔗'}
      </button>
    </>
  )
}
