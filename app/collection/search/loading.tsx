import { PageSkeleton, Skel, SkelRows } from '@/components/collection/Skeletons'

export default function Loading() {
  return (
    <PageSkeleton hint="Preparing search">
      <Skel className="h-11 w-full max-w-md" />
      <SkelRows count={3} height="h-24" />
    </PageSkeleton>
  )
}
