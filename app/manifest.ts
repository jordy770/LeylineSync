import type { MetadataRoute } from 'next';

// PWA manifest. `display: "standalone"` is what removes the browser URL bar once
// the controller is launched from the home screen.
//
// Icons are square PNGs (192 + 512) — Chrome requires a square icon to offer
// install. We deliberately do NOT list the SVG here: Chrome's manifest icon
// loader is unreliable with SVG and reports "failed to load", which surfaces as
// an installability error. The SVG is still used as the favicon (see layout).
// Screenshots enable Chrome's richer install dialog (wide = desktop, narrow = mobile).
//
// NOTE: these files (manifest, icons, screenshots, /sw.js) must be reachable
// WITHOUT auth. Behind Cloudflare Access that needs a Bypass policy for those
// paths — browsers fetch them without the Access cookie, so otherwise Access
// redirects them to its login page and install silently fails.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'LeylineSync',
    short_name: 'LeylineSync',
    description: 'Your phone, your controller — couch-play Magic.',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0F1117',
    theme_color: '#0F1117',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    screenshots: [
      {
        src: '/screenshot-wide.png',
        sizes: '1280x720',
        type: 'image/png',
        form_factor: 'wide',
      },
      {
        src: '/screenshot-narrow.png',
        sizes: '720x1280',
        type: 'image/png',
        form_factor: 'narrow',
      },
    ],
  };
}
