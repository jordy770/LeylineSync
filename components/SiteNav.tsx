import Link from "next/link";
import { Suspense } from "react";
import { AuthButton } from "@/components/auth-button";
import { EnvVarWarning } from "@/components/env-var-warning";
import { hasEnvVars } from "@/lib/utils";

// Shared top nav so the landing and decks pages wear the same identity.
export default function SiteNav({ active }: { active?: "home" | "decks" }) {
  return (
    <nav className="h-16 w-full border-b border-[var(--frame-gold)]/15">
      <div className="mx-auto flex h-full w-full max-w-5xl items-center justify-between px-5 text-sm">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-display text-base tracking-wide text-[var(--gold-bright)]">
            Leyline Sync
          </Link>
          <Link
            href="/decks"
            className={
              active === "decks"
                ? "text-[var(--text)]"
                : "text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
            }
          >
            Decks
          </Link>
        </div>
        {!hasEnvVars ? (
          <EnvVarWarning />
        ) : (
          <Suspense>
            <AuthButton />
          </Suspense>
        )}
      </div>
    </nav>
  );
}
