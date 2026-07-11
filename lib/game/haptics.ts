'use client'

// One-line haptics for the phone controller. Android vibrates; iOS Safari has
// no navigator.vibrate and silently ignores it — exactly the fallback we want.
export function buzz(pattern: number | number[] = 10) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // Some webviews throw on vibrate without permission — never let that surface.
  }
}
