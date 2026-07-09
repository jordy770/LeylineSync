import { PageSkeleton, SkelRows } from '@/components/collection/Skeletons'

// The Advisor diagnoses every deck server-side — the heaviest collection page,
// so an instant skeleton matters most here.
export default function Loading() {
  return (
    <PageSkeleton hint="The Advisor is diagnosing your decks">
      <SkelRows count={2} height="h-36" />
      <SkelRows count={3} height="h-20" />
      <SkelRows count={2} height="h-28" />
    </PageSkeleton>
  )
}
