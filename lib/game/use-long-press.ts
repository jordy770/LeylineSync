import { useRef } from 'react'

/**
 * Press-and-hold detection for card "peek" (hold a card to read its full
 * oracle text). Returns a `bind(onLongPress)` factory so a single hook
 * instance can serve every card in a list — only one press is live at a time.
 *
 * Spread the returned props onto the card's <button>. A long-press fires
 * `onLongPress` after `delay` ms; the click that follows the release is
 * swallowed (via onClickCapture) so the normal tap action (action sheet /
 * auto-tap) does NOT also trigger. A pointer move past `moveTolerance`px
 * cancels the press, so horizontal scrolling of a card strip never peeks.
 */
export function useLongPress(delay = 350, moveTolerance = 10) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const origin = useRef<{ x: number; y: number } | null>(null)

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  return (onLongPress: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false
      origin.current = { x: e.clientX, y: e.clientY }
      clear()
      timer.current = setTimeout(() => {
        fired.current = true
        onLongPress()
      }, delay)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!origin.current) return
      if (Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > moveTolerance) clear()
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    // Swallow the click that fires after a long-press so the card's tap
    // handler (open action sheet / auto-tap mana) doesn't also run.
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.stopPropagation()
        e.preventDefault()
        fired.current = false
      }
    },
    // Suppress the OS long-press context menu on touch.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  })
}
