drop policy if exists "Authenticated users can read decks"
on public.decks;

drop policy if exists "Users can read own decks"
on public.decks;

create policy "Users can read own decks"
on public.decks
for select
to authenticated
using (created_by = auth.uid());
