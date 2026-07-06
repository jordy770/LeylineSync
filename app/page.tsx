import Link from "next/link";
import { ThemeSwitcher } from "@/components/theme-switcher";
import GameSessionLobby from "@/components/GameSessionLobby";
import LandingHero from "@/components/LandingHero";
import FanContentNotice from "@/components/layout/FanContentNotice";
import SiteNav from "@/components/SiteNav";
import { hasEnvVars } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";

// The five colours of mana, used as a structural device throughout the landing.
const MANA_PIPS = [
  { c: "#f4efdd", r: "#cfc6ad" },
  { c: "#2e6fc9", r: "#1d4f99" },
  { c: "#4a3b5c", r: "#2f2640" },
  { c: "#c0402b", r: "#8f2c1d" },
  { c: "#3c7a4e", r: "#2a5a39" },
];

export default async function Home() {
  // Only logged-in users (who have a profile, created on signup) can play. The
  // landing stays public as a welcome page; the Table gates on auth.
  let isSignedIn = false;
  if (hasEnvVars) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    isSignedIn = Boolean(data?.claims);
  }

  return (
    <main className="landing-void relative min-h-screen overflow-hidden text-[var(--text)]">
      <div className="ley-grid pointer-events-none absolute inset-0" />

      <div className="relative flex min-h-screen flex-col items-center">
        <SiteNav active="home" />

        <div className="w-full max-w-5xl flex-1 px-5 pb-20">
          {/* Hero — the card */}
          <section className="flex flex-col items-center pt-10 text-center sm:pt-16">
            <p className="font-display text-[11px] uppercase tracking-[0.42em] text-[var(--frame-gold)]">
              The sync ritual
            </p>
            <div className="mt-3.5 flex items-center gap-2" aria-hidden>
              {MANA_PIPS.map((p, i) => (
                <span
                  key={i}
                  className="h-2 w-2 rounded-full"
                  style={{ background: p.c, boxShadow: `0 0 0 1px ${p.r}, 0 0 8px ${p.c}55` }}
                />
              ))}
            </div>

            <div className="mt-8 w-full">
              <LandingHero />
            </div>

            <p className="mt-8 max-w-md font-rules text-[15px] leading-relaxed text-[var(--text-dim)]">
              Shuffle up on the couch. Cast from your phone and watch it resolve on the big screen —
              no laptop, no spreadsheets, no arguing over the stack.
            </p>
            <a
              href="#table"
              className="mt-6 inline-flex items-center gap-2 rounded-full border border-[var(--frame-gold)]/40 bg-[var(--frame-gold)]/10 px-5 py-2 font-display text-xs uppercase tracking-[0.2em] text-[var(--gold-bright)] transition-colors hover:bg-[var(--frame-gold)]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gold-bright)]"
            >
              Find your table
              <span aria-hidden>↓</span>
            </a>
          </section>

          {/* Games table */}
          <section id="table" className="mt-16 scroll-mt-20 sm:mt-20">
            <div className="mb-5 flex items-center gap-3">
              <span className="h-px flex-1 bg-gradient-to-r from-transparent to-[var(--frame-gold)]/30" />
              <h2 className="font-display text-sm uppercase tracking-[0.3em] text-[#cdbf9b]">
                The Table
              </h2>
              <span className="h-px flex-1 bg-gradient-to-l from-transparent to-[var(--frame-gold)]/30" />
            </div>
            {!hasEnvVars ? (
              <div className="rounded-xl border border-red-900 bg-red-950/60 p-4 text-sm text-red-100">
                Add your Supabase environment variables to create or join a game.
              </div>
            ) : isSignedIn ? (
              <GameSessionLobby />
            ) : (
              <SignInToPlay />
            )}
          </section>
        </div>

        <footer className="w-full border-t border-[var(--frame-gold)]/15 py-8">
          <FanContentNotice />
          <div className="mx-auto mt-4 flex w-full max-w-5xl items-center justify-center px-5">
            <ThemeSwitcher />
          </div>
        </footer>
      </div>
    </main>
  );
}

// Logged-out gate for the Table: a welcome CTA pointing to login / sign-up.
function SignInToPlay() {
  return (
    <div className="flex flex-col items-center gap-5 rounded-2xl border border-[var(--frame-gold)]/20 bg-[var(--frame-gold)]/[0.04] px-6 py-10 text-center">
      <p className="max-w-sm font-rules text-[15px] leading-relaxed text-[var(--text-dim)]">
        Sign in to create a table, build decks, and start a game. It only takes a moment.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/auth/login"
          className="inline-flex items-center rounded-full border border-[var(--frame-gold)]/40 bg-[var(--frame-gold)]/15 px-6 py-2.5 font-display text-xs uppercase tracking-[0.2em] text-[var(--gold-bright)] transition-colors hover:bg-[var(--frame-gold)]/25"
        >
          Log in
        </Link>
        <Link
          href="/auth/sign-up"
          className="inline-flex items-center rounded-full border border-[var(--frame-gold)]/20 px-6 py-2.5 font-display text-xs uppercase tracking-[0.2em] text-[var(--text-dim)] transition-colors hover:text-[var(--gold-bright)]"
        >
          Create account
        </Link>
      </div>
    </div>
  );
}
