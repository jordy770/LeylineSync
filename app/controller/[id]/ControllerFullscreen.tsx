'use client';

import { useEffect } from 'react';

// Guests usually just open the controller URL (scan a QR), so they never get the
// PWA's standalone mode and are stuck with the browser URL bar. The Fullscreen
// API can hide it, but only when called from a user gesture — so we request
// fullscreen on the first tap inside the controller.
//
// No-ops where it can't or shouldn't run:
//   - already a standalone PWA (no chrome to hide)
//   - iOS Safari on iPhone (no element Fullscreen API → call simply absent)
// A failed/blocked request is swallowed; the `svh`-sized layout still fits.
export default function ControllerFullscreen() {
  useEffect(() => {
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      // iOS Safari's non-standard flag for home-screen apps.
      (window.navigator as { standalone?: boolean }).standalone === true;

    const el = document.documentElement;
    if (standalone || typeof el.requestFullscreen !== 'function') return;

    const goFullscreen = () => {
      if (document.fullscreenElement) return;
      el.requestFullscreen().catch(() => {
        /* user denied or unsupported — layout already fits via svh */
      });
    };

    // `once` cleans the listener up after the first tap.
    window.addEventListener('pointerdown', goFullscreen, { once: true });
    return () => window.removeEventListener('pointerdown', goFullscreen);
  }, []);

  return null;
}
