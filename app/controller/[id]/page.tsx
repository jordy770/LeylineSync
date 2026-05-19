import ControllerList from '@/components/ControllerList';
import ControllerListV2 from '@/components/ControllerListV2';
import ControllerViewNav from '@/components/layout/ControllerViewNav';
import { Suspense } from 'react';

export default function ControllerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ v?: string }>
}) {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-950" />}>
      <ControllerContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function ControllerContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ v?: string }>
}) {
  const { id } = await params;
  const { v } = await searchParams;
  const useLegacyController = v === '1';

  return (
    <main className="leyline-table-bg min-h-screen overflow-visible text-white">
      <ControllerViewNav sessionId={id} isLegacy={useLegacyController} />
      
      {useLegacyController ? <ControllerList sessionId={id} /> : <ControllerListV2 sessionId={id} />}
    </main>
  );
}
