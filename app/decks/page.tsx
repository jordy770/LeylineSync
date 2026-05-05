import Link from 'next/link'
import { Suspense } from 'react'
import { AuthButton } from '@/components/auth-button'
import DeckManager from '@/components/DeckManager'
import { EnvVarWarning } from '@/components/env-var-warning'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { hasEnvVars } from '@/lib/utils'

export default function DecksPage() {
  return (
    <main className="flex min-h-screen flex-col items-center">
      <div className="flex w-full flex-1 flex-col items-center gap-20">
        <nav className="flex h-16 w-full justify-center border-b border-b-foreground/10">
          <div className="flex w-full max-w-5xl items-center justify-between p-3 px-5 text-sm">
            <div className="flex items-center gap-5 font-semibold">
              <Link href="/">Leyline Sync</Link>
              <Link href="/decks" className="text-foreground/70 hover:text-foreground">
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

        <div className="flex w-full max-w-5xl flex-1 flex-col gap-8 p-5">
          <section className="flex flex-1 flex-col gap-6 px-4">
            <div>
              <h1 className="text-3xl font-bold tracking-normal">Decks</h1>
              <p className="mt-2 max-w-2xl text-sm text-foreground/70">
                Create reusable decks from text lists, then select them when spawning into a game session.
              </p>
            </div>
            {hasEnvVars ? (
              <DeckManager />
            ) : (
              <div className="rounded-lg border border-red-900 bg-red-950 p-4 text-sm text-red-100">
                Supabase environment variables are required before decks can be managed.
              </div>
            )}
          </section>
        </div>

        <footer className="mx-auto flex w-full items-center justify-center gap-8 border-t py-16 text-center text-xs">
          <p>
            Powered by{' '}
            <a
              href="https://supabase.com/?utm_source=create-next-app&utm_medium=template&utm_term=nextjs"
              target="_blank"
              className="font-bold hover:underline"
              rel="noreferrer"
            >
              Supabase
            </a>
          </p>
          <ThemeSwitcher />
        </footer>
      </div>
    </main>
  )
}
