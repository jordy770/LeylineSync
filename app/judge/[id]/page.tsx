import JudgePanel from '@/components/JudgePanel'
import GameViewHeader from '@/components/layout/GameViewHeader'
import { Suspense } from 'react'

export default function JudgePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-950" />}>
      <JudgeContent params={params} />
    </Suspense>
  )
}

async function JudgeContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  return (
    <main className="leyline-table-bg min-h-screen text-white">
      <GameViewHeader sessionId={id} activeView="judge" title="Judge View" />

      <div className="p-4 sm:p-6">
        <JudgePanel sessionId={id} />
      </div>
    </main>
  )
}
