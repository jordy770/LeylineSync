import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import ControllerFullscreen from './ControllerFullscreen';
import AddToHomeScreen from './AddToHomeScreen';

// Lazy-load each controller version so opening the page only compiles the ONE
// requested via ?v=. V5 (Arena-style HandFan) is now the default product
// controller. V4 is kept reachable via ?v=4 as a fallback while V5's gesture
// UX is validated on real devices; V1 is the legacy fallback via ?v=1. V2/V3
// were retired 2026-06-10.
const ControllerList = dynamic(() => import('@/components/ControllerList'));
const ControllerListV4 = dynamic(() => import('@/components/ControllerListV4'));
const ControllerListV5 = dynamic(() => import('@/components/ControllerListV5'));

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

  return (
    <main className="leyline-table-bg min-h-screen overflow-visible text-white">
      <ControllerFullscreen />
      <AddToHomeScreen />
      {v === '1' ? (
        <ControllerList sessionId={id} />
      ) : v === '4' ? (
        <ControllerListV4 sessionId={id} />
      ) : (
        <ControllerListV5 sessionId={id} />
      )}
    </main>
  );
}
