import { PageSkeleton, SkelPockets } from '@/components/collection/Skeletons'

// Works for both views: the shelf (spine-shaped bars) and an opened binder page.
export default function Loading() {
  return (
    <PageSkeleton hint="Opening your binders">
      <div>
        <div className="flex items-end gap-3 px-2">
          {[150, 172, 138, 160].map((height, i) => (
            <div key={i} className="animate-pulse rounded-t-lg" style={{ background: '#2e313a', width: 74, height }} />
          ))}
        </div>
        <div className="bnd-shelfboard" />
      </div>
      <SkelPockets count={12} cols="grid-cols-3 sm:grid-cols-4 md:grid-cols-6" />
    </PageSkeleton>
  )
}
