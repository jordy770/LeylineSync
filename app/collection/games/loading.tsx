import { PageSkeleton, SkelRows } from '@/components/collection/Skeletons'

export default function Loading() {
  return (
    <PageSkeleton hint="Loading your finished games">
      <SkelRows count={5} height="h-16" />
    </PageSkeleton>
  )
}
