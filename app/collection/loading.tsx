import { PageSkeleton, SkelDeckboxes, SkelPockets, SkelStatbar, Skel } from '@/components/collection/Skeletons'

// Instant skeleton while the dashboard aggregates the collection (value,
// staples, deck scans) — shapes mirror the real page so nothing jumps.
export default function Loading() {
  return (
    <PageSkeleton hint="Loading your collection">
      <SkelStatbar />
      <Skel className="h-44 w-full" />
      <SkelDeckboxes />
      <SkelPockets />
    </PageSkeleton>
  )
}
