import { DeckScanSkeleton, PageSkeleton } from '@/components/collection/Skeletons'

export default function Loading() {
  return (
    <PageSkeleton hint="Opening the deck">
      <DeckScanSkeleton />
    </PageSkeleton>
  )
}
