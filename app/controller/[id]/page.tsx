import dynamic from 'next/dynamic';
import { Suspense } from 'react';

// Lazy-load each controller version so opening the page only compiles the ONE
// requested via ?v= — not all four (V1+V2+V3+V4 ≈ 7,900 lines) on every visit.
const ControllerList = dynamic(() => import('@/components/ControllerList'));
const ControllerListV2 = dynamic(() => import('@/components/ControllerListV2'));
const ControllerListV3 = dynamic(() => import('@/components/ControllerListV3'));
const ControllerListV4 = dynamic(() => import('@/components/ControllerListV4'));

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
