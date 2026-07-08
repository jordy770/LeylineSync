'use client'

import { useEffect, useState } from 'react'

import { CAST_NAMESPACE } from '@/lib/game/cast'

// The Chromecast-side page (registered as the custom receiver URL, see
// docs/cast-setup.md). It boots the CAF receiver framework, waits for the
// sender to message which board to show, and then fills the TV with that
// board in an iframe. The board URL carries the spectator token (mig 378),
// so the TV needs no login. Public route on purpose — a Chromecast has no
// session; only same-origin board URLs are accepted.

const RECEIVER_SDK = 'https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js'

export default function CastReceiverPage() {
  const [boardUrl, setBoardUrl] = useState<string | null>(null)
  const [status, setStatus] = useState('Starting receiver…')

  useEffect(() => {
    const script = document.createElement('script')
    script.src = RECEIVER_SDK
    script.onload = () => {
      try {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const w = window as any
        const context = w.cast.framework.CastReceiverContext.getInstance()
        context.addCustomMessageListener(CAST_NAMESPACE, (event: any) => {
          const url = event?.data?.boardUrl
          // Same-origin only — the sender may only point the TV at our own board.
          if (typeof url === 'string' && url.startsWith(window.location.origin)) {
            setBoardUrl(url)
          }
        })
        // A board session runs for hours without media — never idle out.
        context.start({ disableIdleTimeout: true, statusText: 'LeylineSync board' })
        /* eslint-enable @typescript-eslint/no-explicit-any */
        setStatus('Connected — waiting for a board…')
      } catch {
        setStatus('Cast framework failed to start.')
      }
    }
    script.onerror = () => setStatus('Could not load the Cast receiver framework.')
    document.head.appendChild(script)
  }, [])

  if (boardUrl) {
    return (
      <iframe src={boardUrl} title="LeylineSync board" style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', border: 'none', background: '#0F1117' }} />
    )
  }

  return (
    <div
      className="landing-void grid min-h-screen place-items-center"
      style={{ background: '#0F1117', color: 'var(--text, #d9d3c5)' }}
    >
      <div className="text-center">
        <div className="font-display text-3xl" style={{ color: 'var(--gold-bright, #e0b45c)' }}>
          LeylineSync
        </div>
        <p className="font-rules mt-3 text-sm opacity-70">{status}</p>
      </div>
    </div>
  )
}
