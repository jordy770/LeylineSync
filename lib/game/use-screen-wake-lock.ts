'use client'

import { useEffect } from 'react'

// Keep the TV awake while the board is on screen. Primary: the Screen Wake
// Lock API. Fallback for TV browsers without it: play an invisible 2×2 canvas
// stream — active media playback holds off most screensavers. Best-effort on
// both paths; a TV that ignores everything needs its own screensaver setting.
export function useScreenWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return

    let lock: WakeLockSentinel | null = null
    let video: HTMLVideoElement | null = null
    let repaint: number | null = null
    let disposed = false

    const requestLock = async () => {
      try {
        lock = (await navigator.wakeLock?.request('screen')) ?? null
        if (disposed && lock) {
          void lock.release().catch(() => {})
          lock = null
        }
      } catch {
        lock = null
      }
      return Boolean(lock)
    }

    const startVideoFallback = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 2
      canvas.height = 2
      const ctx = canvas.getContext('2d')
      if (!ctx || typeof canvas.captureStream !== 'function') return
      const paint = () => {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, 2, 2)
      }
      paint()
      video = document.createElement('video')
      video.muted = true
      video.setAttribute('playsinline', '')
      video.style.cssText = 'position:fixed;bottom:0;right:0;width:2px;height:2px;opacity:0;pointer-events:none'
      video.srcObject = canvas.captureStream(1)
      document.body.appendChild(video)
      void video.play().catch(() => {})
      // Some browsers pause a captureStream whose canvas never changes.
      repaint = window.setInterval(paint, 15000)
    }

    void requestLock().then((gotLock) => {
      if (!gotLock && !disposed) startVideoFallback()
    })

    // The wake lock auto-releases whenever the page is hidden (tab switch, TV
    // input change) — re-request on return.
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !video) void requestLock()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibility)
      void lock?.release().catch(() => {})
      if (repaint) window.clearInterval(repaint)
      if (video) {
        video.pause()
        video.remove()
      }
    }
  }, [active])
}
