import dynamic from 'next/dynamic';
import { Suspense } from 'react';

// Lazy-load each controller version so opening the page only compiles the ONE
// requested via ?v=. V4 is the product controller (and the default); V1 is the
// legacy fallback, kept reachable via ?v=1. V2/V3 were retired 2026-06-10.
const ControllerList = dynamic(() => import('@/components/ControllerList'));
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

  return (
    <main className="leyline-table-bg min-h-screen overflow-visible text-white">
      {useLegacyController ? (
        <ControllerList sessionId={id} />
      ) : (
        <ControllerListV4 sessionId={id} />
      )}
    </main>
  );
}
