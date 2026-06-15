// Minimal service worker. Its only job is to make the app installable: Chrome
// requires a registered service worker WITH a fetch handler before it will fire
// `beforeinstallprompt` (the Android "Install" prompt). We deliberately do NOT
// cache — this is a realtime, auth'd, Supabase-backed app, and stale cached
// responses would cause subtle bugs. The fetch handler is a pure passthrough.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // Intentionally empty: presence of the handler satisfies installability;
  // not calling respondWith() lets the browser handle every request normally.
});
