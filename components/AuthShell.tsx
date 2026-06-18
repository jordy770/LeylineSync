import Link from "next/link";
import type { ReactNode } from "react";

// The Leyline entry-flow frame: arcane void ground, ley grid, the wordmark in
// Cinzel gold. `dark` keeps the Shadcn card rendering as dark chrome on the void.
export default function AuthShell({ children }: { children?: ReactNode }) {
  return (
    <main className="landing-void dark relative flex min-h-svh w-full flex-col items-center justify-center overflow-hidden p-6 text-[var(--text)]">
      <div className="ley-grid pointer-events-none absolute inset-0" />
      <div className="relative flex w-full max-w-sm flex-col items-center gap-7">
        <Link href="/" className="flex flex-col items-center gap-1.5">
          <span className="font-display text-2xl tracking-[0.06em] text-[var(--gold-bright)]">
            Leyline Sync
          </span>
          <span className="font-rules text-xs italic text-[var(--text-dim)]">Couch-play Magic</span>
        </Link>
        <div className="w-full">{children}</div>
      </div>
    </main>
  );
}
