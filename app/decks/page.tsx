import { binderFonts } from '@/components/binder-fonts'
import DeckManager from '@/components/DeckManager'
import SiteNav from '@/components/SiteNav'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { hasEnvVars } from '@/lib/utils'

export default function DecksPage() {
  return (
    // Same binder shell as the collection and the landing — one identity.
    <main className={`binder-shell relative min-h-screen overflow-hidden text-[var(--text)] ${binderFonts}`}>
      <div className="relative flex min-h-screen flex-col items-center">
        <SiteNav active="decks" />

        <div className="w-full max-w-5xl flex-1 px-5 pb-20">
          {/* Header */}
          <header className="flex flex-col items-center pt-12 text-center sm:pt-16">
            <p className="font-display text-[11px] uppercase tracking-[0.42em] text-[var(--frame-gold)]">
              Your spellbook
            </p>
            <h1 className="mt-3 font-display text-4xl tracking-wide text-[var(--text-bright)] sm:text-5xl">
              Decks
            </h1>
            <p className="mt-4 max-w-md font-rules text-[15px] leading-relaxed text-[var(--text-dim)]">
              Forge a deck from a plain text list, tune each card&apos;s behaviour, then bring it to
              the table.
            </p>
          </header>

          <div className="mt-12">
            {hasEnvVars ? (
              <DeckManager />
            ) : (
              <div className="rounded-xl border border-red-900 bg-red-950/60 p-4 text-sm text-red-100">
                Add your Supabase environment variables before decks can be managed.
              </div>
            )}
          </div>
        </div>

        <footer className="w-full border-t border-[var(--frame-gold)]/15 py-10">
          <div className="mx-auto flex w-full max-w-5xl items-center justify-center gap-6 px-5 text-center text-xs text-[var(--text-faint)]">
            <p>
              Powered by{' '}
              <a
                href="https://supabase.com/?utm_source=create-next-app&utm_medium=template&utm_term=nextjs"
                target="_blank"
                className="font-semibold text-[var(--text-dim)] hover:underline"
                rel="noreferrer"
              >
                Supabase
              </a>
            </p>
            <ThemeSwitcher />
          </div>
        </footer>
      </div>
    </main>
  )
}
