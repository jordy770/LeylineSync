# Leyline Sync

Realtime Magic: The Gathering board/controller app built with Next.js and Supabase.

The current goal is a shared board screen plus a player controller screen. A deck can be spawned into `game_cards`, the board shows live card state, and controller buttons execute scripted card actions such as Llanowar Elves adding green mana.

## Stack

- Next.js app router
- React 19
- Tailwind CSS
- Supabase Auth, Database, Realtime, and Edge Functions

## Clone And Run

Install dependencies:

```powershell
npm install
```

Create `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=your-supabase-project-url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-or-anon-key
```

Run the dev server:

```powershell
npm run dev
```

Open:

- App: `http://localhost:3000`
- Board view: `http://localhost:3000/board/<session-id>`
- Controller view: `http://localhost:3000/controller/<session-id>`

## Build And Verify

Use these before committing or deploying:

```powershell
npx tsc --noEmit
npm run lint
npm run build
```

Start a production build locally:

```powershell
npm run start
```

## Supabase Edge Function

The deck spawning function lives at:

```text
supabase/functions/spawn-deck/index.ts
```

Check it locally with Deno:

```powershell
deno check --config "supabase/functions/spawn-deck/deno.json" "supabase/functions/spawn-deck/index.ts"
```

Deploy it:

```powershell
supabase functions deploy spawn-deck
```

Call it with:

```powershell
curl -i --location --request POST "https://<PROJECT_REF>.supabase.co/functions/v1/spawn-deck" `
  --header "Authorization: Bearer <SUPABASE_ANON_KEY>" `
  --header "Content-Type: application/json" `
  --data "{""sessionId"":""..."",""deckId"":""..."",""ownerId"":""...""}"
```

## Expected Database Shape

The app currently expects these tables/columns.

`cards`:

- `id`
- `name`
- `script`
- `type_line`
- `image_url`

`decks`:

- `id`
- `list_data`, an array of card ids

`game_cards`:

- `id`
- `session_id`
- `card_id`
- `owner_id`
- `zone`
- `is_tapped`
- `position_x`
- `position_y`

`game_players`:

- `session_id`
- `player_id`
- `mana_pool`

Add the image column if it does not exist yet:

```sql
alter table public.cards
add column if not exists image_url text;
```

## RLS Policies Needed

The browser client needs to read card metadata:

```sql
create policy "Authenticated users can read cards"
on public.cards
for select
to authenticated
using (true);
```

Players need to manage their own player state:

```sql
create policy "Players can read their own player state"
on public.game_players
for select
to authenticated
using (player_id = auth.uid());

create policy "Players can create their own player state"
on public.game_players
for insert
to authenticated
with check (player_id = auth.uid());

create policy "Players can update their own player state"
on public.game_players
for update
to authenticated
using (player_id = auth.uid())
with check (player_id = auth.uid());
```

Depending on your existing policies, `game_cards` also needs authenticated read/update access for the relevant session/player.

## Realtime

The board and controller subscribe to `game_cards` and `cards`. A 2 second fallback refresh is also in place.

Enable Supabase Realtime for the relevant tables:

```sql
alter publication supabase_realtime add table public.game_cards;
alter publication supabase_realtime add table public.cards;
alter publication supabase_realtime add table public.game_players;
```

If a table is already in the publication, Supabase may return an error. That is fine.

## Current App State

Implemented:

- `/board/[id]` renders the shared board for a session.
- `/controller/[id]` renders the player controller for a session.
- `spawn-deck` Edge Function reads `decks.list_data` and inserts rows into `game_cards`.
- `GameBoard` fetches `game_cards`, joins card metadata manually by `card_id`, and renders `cards.image_url` when present.
- `ControllerList` fetches the current authenticated player, loads only their `game_cards`, joins card metadata manually, and renders controls.
- `CardController` can tap/untap a card.
- `ActionButtons` reads `cards.script` and supports:
  - `type: "add_mana"`
  - `triggers: ["manual_tap"]`
- Llanowar Elves script example:

```json
{
  "actions": [
    {
      "type": "add_mana",
      "color": "G",
      "amount": 1
    }
  ],
  "triggers": ["manual_tap"]
}
```

Known next steps:

- Add/fill `cards.image_url` values.
- Confirm RLS policies for `cards`, `game_cards`, and `game_players`.
- Add a visible mana pool UI so mana changes can be seen immediately.
- Decide how zones should work: library, hand, battlefield, graveyard, exile.
- Move more MTG script effects into typed executors: draw card, move zone, create token, deal damage.
- Consider moving action execution into an Edge Function or RPC for safer server-side rules.

## Notes

Next build currently warns that there is another `package-lock.json` at `C:\Users\jordy\package-lock.json`. The build still succeeds. To silence that warning later, either remove the unrelated parent lockfile or configure `turbopack.root` in `next.config.ts`.
