'use client';

import { useEffect, useState } from 'react';

// Chrome/Android fires this before showing its own install UI; we capture it so
// we can trigger the prompt from our own button instead.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'leyline-a2hs-dismissed';

// "Add to Home Screen" nudge. Installing gives repeat players a standalone
// controller with no browser URL bar (see ControllerFullscreen for the
// per-tap fallback). Shown as a dismissible bottom banner:
//   - Android/Chrome: a real install button via the captured beforeinstallprompt
//   - iOS Safari: manual Share → Add to Home Screen instructions (no API exists)
// Hidden entirely when already installed, or once dismissed (remembered locally).
export default function AddToHomeScreen() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    if (standalone) return;

    if (localStorage.getItem(DISMISS_KEY)) return;

    const ua = window.navigator.userAgent;
    const ios = /iphone|ipad|ipod/i.test(ua) && !/crios|fxios/i.test(ua); // Safari only — others can't A2HS on iOS
    if (ios) {
      setIsIOS(true);
      setVisible(true);
      return;
    }

    const onPrompt = (e: Event) => {
      e.preventDefault(); // stop Chrome's default mini-infobar
      setInstallEvent(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setVisible(false);
  };

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice; // resolves whether accepted or dismissed
    dismiss();
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[60] mx-auto flex max-w-md items-center gap-3 border-t border-white/10 bg-[#181C28]/95 px-4 py-3 text-sm text-white shadow-2xl backdrop-blur"
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      role="dialog"
      aria-label="Add LeylineSync to your home screen"
    >
      <span aria-hidden className="text-lg">📲</span>
      <div className="min-w-0 flex-1">
        {isIOS ? (
          <p className="leading-snug text-slate-200">
            Add to Home Screen for fullscreen: tap{' '}
            <span className="font-semibold">Share</span> then{' '}
            <span className="font-semibold">Add to Home Screen</span>.
          </p>
        ) : (
          <p className="leading-snug text-slate-200">
            Install LeylineSync for a fullscreen controller — no address bar.
          </p>
        )}
      </div>
      {!isIOS && (
        <button
          type="button"
          onClick={install}
          className="shrink-0 rounded-lg bg-[#5EE6C7] px-3 py-1.5 font-semibold text-[#0F1117] active:scale-95"
        >
          Install
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-lg px-2 py-1.5 text-slate-400 active:scale-95"
      >
        ✕
      </button>
    </div>
  );
}
