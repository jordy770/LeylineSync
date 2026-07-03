import { createBrowserClient } from "@supabase/ssr";

let realtimeAuthWired = false;

export function createClient() {
  const client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );

  // @supabase/ssr restores the cookie session on page load as an INITIAL_SESSION
  // auth event — which supabase-js's _handleTokenChanged does NOT propagate to
  // realtime.setAuth (it only reacts to SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT).
  // Without this, Realtime stays on the anon apikey after a reload, so RLS-filtered
  // `postgres_changes` deliver ZERO events to a logged-in player — the board/
  // controller would then never update from realtime and fall back to constant
  // polling. Push the restored session's token to Realtime once so events flow.
  // createBrowserClient is a browser singleton, so this wires exactly one client.
  if (!realtimeAuthWired && typeof window !== "undefined") {
    realtimeAuthWired = true;
    client.auth.getSession().then(({ data }) => {
      if (data.session?.access_token) {
        client.realtime.setAuth(data.session.access_token);
      }
    });
  }

  return client;
}
