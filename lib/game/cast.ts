// Google Cast (Chromecast) wiring — shared by the sender button
// (CastShareControls) and the receiver page (/cast-receiver).
//
// Chrome on Android can't PRESENT a URL to a Chromecast via the Presentation
// API (desktop-only behaviour), and an installed PWA has no browser menu to
// fall back on — so real phone casting needs the Cast SDK with a REGISTERED
// custom receiver. Registration (one-time, $5) is documented in
// docs/cast-setup.md; paste the App ID below and every Chrome sender (desktop
// AND Android/PWA) gets the native cast picker. Until then CAST_APP_ID stays
// null and the sender falls back to the Presentation API (desktop Chromium).
//
// iOS never gets a cast button either way: WebKit has neither API.

export const CAST_APP_ID: string | null = null

/** Custom message channel: the sender tells the receiver which board to load. */
export const CAST_NAMESPACE = 'urn:x-cast:com.leylinesync.board'

// The Cast SDKs attach themselves to window — typed loosely on purpose; the
// official typings are a heavyweight dependency for two call sites.
/* eslint-disable @typescript-eslint/no-explicit-any */

const SENDER_SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'

let senderLoading = false

/**
 * Load the Cast sender framework and configure it for our receiver app.
 * Resolves true when the cast framework is available and initialised;
 * false when this browser has no Cast support (non-Chrome) or no app id is set.
 */
export function initCastSender(): Promise<boolean> {
  if (!CAST_APP_ID || typeof window === 'undefined') return Promise.resolve(false)
  const w = window as any

  // Already initialised in this page lifetime.
  if (w.__leylineCastReady) return Promise.resolve(true)

  return new Promise((resolve) => {
    w.__onGCastApiAvailable = (available: boolean) => {
      if (!available) {
        resolve(false)
        return
      }
      try {
        w.cast.framework.CastContext.getInstance().setOptions({
          receiverApplicationId: CAST_APP_ID,
          autoJoinPolicy: w.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        })
        w.__leylineCastReady = true
        resolve(true)
      } catch {
        resolve(false)
      }
    }
    if (!senderLoading) {
      senderLoading = true
      const script = document.createElement('script')
      script.src = SENDER_SDK
      script.onerror = () => resolve(false)
      document.head.appendChild(script)
    }
  })
}

/** Open the native cast picker and tell the receiver which board to show. */
export async function castBoardUrl(boardUrl: string): Promise<void> {
  const w = window as any
  const context = w.cast.framework.CastContext.getInstance()
  // requestSession rejects when the user dismisses the picker — caller handles.
  await context.requestSession()
  const session = context.getCurrentSession()
  if (!session) throw new Error('No cast session.')
  await session.sendMessage(CAST_NAMESPACE, { boardUrl })
}
