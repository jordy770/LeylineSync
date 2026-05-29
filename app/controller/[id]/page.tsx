import ControllerList from '@/components/ControllerList';
import ControllerListV2 from '@/components/ControllerListV2';
import ControllerListV3 from '@/components/ControllerListV3';
import ControllerListV4 from '@/components/ControllerListV4';
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
  const useControllerV3 = v === '3';
  const useControllerV4 = v === '4';

  return (
    <main className="leyline-table-bg min-h-screen overflow-visible text-white">

      {useControllerV4 ? (
        <ControllerListV4 sessionId={id} />
      ) : useControllerV3 ? (
        <ControllerListV3 sessionId={id} />
      ) : useLegacyController ? (
        <ControllerList sessionId={id} />
      ) : (
        <ControllerListV2 sessionId={id} />
      )}
    </main>
  );
}
