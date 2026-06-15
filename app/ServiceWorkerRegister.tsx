'use client';

import { useEffect } from 'react';

// Registers /sw.js so the app meets Chrome's PWA install criteria (a service
// worker with a fetch handler must exist before `beforeinstallprompt` fires —
// see AddToHomeScreen). The SW itself does no caching.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* registration failure shouldn't break the app; install just won't offer */
    });
  }, []);

  return null;
}
