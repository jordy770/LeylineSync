import TvCodeEntry from '@/components/board/TvCodeEntry'

// The TV's one stable address (bookmark it once on the TV browser): enter the
// room code shown in the lobby and land on the read-only spectator board
// (mig 379). Deliberately login-free — the auth proxy exempts /tv.

export default function TvPage() {
  return (
    <main className="leyline-table-bg flex min-h-screen items-center justify-center text-white">
      <TvCodeEntry />
    </main>
  )
}
