import { redirect } from 'next/navigation';
import JoinSessionRunner from '@/components/JoinSessionRunner';
import { createClient } from '@/lib/supabase/server';

// QR landing: scan the code in the lobby, land here, and you're seated. The
// only friction left is login (redirected back here afterwards) — no more
// typing session IDs across the couch.
export default async function JoinPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) {
    redirect(`/auth/login?next=/join/${id}`);
  }
  return (
    <main className="leyline-table-bg flex min-h-screen items-center justify-center text-white">
      <JoinSessionRunner sessionId={id} />
    </main>
  );
}
