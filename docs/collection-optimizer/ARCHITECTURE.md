# Collection-Aware Commander Deck Optimizer — Architecture

> Status: **design, pre-build**. Stack decision: **native Next.js + Supabase** (not NestJS+Prisma — see §0).
> Last updated: 2026-06-27.

A new LeylineSync module: a "personal EDHRec" that understands a player's collection,
which cards are free vs. locked in decks, and which upgrades are possible without buying.

---

## 0. Stack decision (the load-bearing choice)

The original brief specified **NestJS + Prisma + standalone Postgres + TanStack Query + Zustand**.
The existing app is **Next.js (App Router) + React 19 + Supabase/Postgres (RLS) + RPC engine**,
with `@anthropic-ai/sdk` and a Scryfall import script (`scripts/import-scryfall-cards.mjs`) already present.

**Decision: build native in the existing stack.** Reasons:

| Concern | NestJS+Prisma | Native (Supabase) — chosen |
|---|---|---|
| Auth | rebuild (JWT) | Supabase Auth + RLS already done |
| Deploy | 2nd service + pipeline | single Vercel deploy |
| Card data | new importer | `import-scryfall-cards.mjs` exists |
| AI | new | `@anthropic-ai/sdk` present |
| Multi-tenancy | manual per query | RLS enforces at DB level |

Prisma on top of a Supabase DB ignores RLS (single DB role) → you lose fail-safe tenant isolation
and get two sources of schema truth. A standalone NestJS service doubles deploy + auth surface for
zero gain while this is one product. The only place a separate worker is justified is heavy batch
analysis (§10) — solved with a Supabase Edge Function + pg queue, not a full backend.

Prisma models are still documented in §3 as a reference in case the module is later spun out as a
standalone product.

### 0.1 Same app, isolated module (not a second service, not a fork)

Build in the **same repo + same Supabase project**, as a bounded module — a modular monolith.
What already exists and is reused directly:
- **`cards` Scryfall mirror** — already populated from the full `oracle-cards.json` pool, with a
  `cards_oracle_id_key` unique index on `oracle_id` (migration 313). The optimizer reuses this
  **read-only**; it does NOT create its own card table (the original §2 draft did — corrected below).
- **Import pipeline** — `scripts/import-scryfall-cards.mjs`.
- **Auth + RLS** (same Commander players) and **`@anthropic-ai/sdk`**.

The layers stack cleanly with no shared write paths:
```
cards (full mirror, shared, read-only)
  ├─► game_cards (scripted playable subset — the game engine, untouched)
  └─► collection_items (ownership — the optimizer)
```

**Isolation boundary (the two real risks):**
1. **Coupling to the game engine** — the game DB is heavy (RPC engine, realtime, hundreds of
   migrations). The optimizer is read-mostly CRUD + analytics. Keep them apart: all new tables in
   `public` with a **`co_` prefix** (a separate `collection` Postgres schema was rejected — hosted
   Supabase needs dashboard API-exposure + a per-call `.schema('collection')`, friction not worth it;
   `public.decks` already exists for the game, which the prefix sidesteps), route group
   `app/collection/*`, never touch `game_cards` / the RPC functions, treat `cards` as read-only.
   A collection migration must never be able to break the game engine.
2. **Product focus** — couch-play (phones-as-controllers, together) vs a deckbuilder/collection tool
   (solo, at a desk) are different activities for the same audience. Build the MVP small and in a
   feature branch so it can be parked if the game takes priority. Audience overlap + the
   "tools/perks, never gated gameplay" monetization model justify the cross-sell.

---

## 1. Software architecture

```
CLIENT  (Next.js App Router, React 19)
  Server Components for reads · Client Components for interactive UI
        │ Server Actions (UI mutations)        │ Route Handlers (import, AI, external)
DOMAIN LAYER  (lib/collection/* — pure TS, unit-tested)
  parsers · inventory-math · synergy-engine · power-score · upgrade-scanner · price · ai-orchestrator
        │ supabase-js (RLS) + SQL views/RPC
DATA LAYER  (Supabase Postgres + RLS + FTS)
  cards · oracle_cards · card_tags · collection_items · decks · deck_cards · price_cache · imports · deck_analyses
        ▲ nightly bulk (Scryfall)   ▲ on-demand, cached (Scryfall prices)
```

**Core principle:** all "smart" logic (inventory math, synergy, scoring, upgrade scan) lives as
pure TypeScript in `lib/collection/`, decoupled from HTTP and DB. That is the test surface. DB does
storage + heavy set ops; UI does presentation; domain layer does reasoning.

**Free vs occupied (the heart):** a physical card is either free or occupied, never both. Model
ownership and usage **separately** and derive availability — never store it (drifts):

```
available(oracle_id) = owned_qty − Σ committed_qty (over all decks)   ← as a SQL view, single source of truth
```

---

## 2. Database schema

Identity is everything. Scryfall has two keys: `id` (one print) and `oracle_id` (gameplay identity,
stable across reprints). **Playability & synergy run on `oracle_id`; value & ownership on the print
(`scryfall_id` + finish).**

> **VERIFIED against live schema (2026-06-27) — original draft was wrong.** The existing
> `public.cards` table is a thin, game-oriented catalog, NOT a collector-grade Scryfall mirror.
> Live columns: `id` uuid (PK = representative printing id), `name`, `mana_cost` text, `type_line`,
> `oracle_text`, `keywords` **jsonb**, `script` jsonb, `image_url`, `power`/`toughness`/`power_toughness`,
> `is_token`, `oracle_id` **text**. It holds **one representative printing per `oracle_id`** (to attach
> game scripts), not every printing.
>
> **Missing — no source for these in `cards`:** `color_identity`/`colors`, `cmc`, `set_code`/`collector_num`,
> `prices`, `rarity`, `layout`, `search_tsv`, finish. These are exactly the columns the optimizer's
> color filter, mana curve, ManaBox match (Set + Collector#), buy suggestions and value depend on.
>
> **Decision — option B: the optimizer owns its own card-data layer.** Do NOT stuff collector concerns
> into the shared game `cards` table (it can't represent multiple printings anyway). Instead add a full
> **`co_card_printings`** table (public, `co_` prefix) fed by a dedicated Scryfall import; MVP feeds it
> from the oracle-cards bulk (one representative printing per card), pointing it at `default-cards` later
> fills every printing into the same table. Reuse `cards.oracle_id` only as the join key to gameplay text.
>
> **BUILT (2026-06-28):** migration `supabase/migrations/202605010364_collection_optimizer.sql`
> (all `co_*` tables + `co_card_oracle`/`co_card_availability` views + RLS) and importer
> `scripts/import-card-printings.mjs` (`npm run import:printings`). Applied + verified end-to-end against
> the local DB (color_identity/cmc/prices/finishes/generated search_tsv all populate). The SQL sketch
> below is superseded by that migration; table/column names there read `collection.*`/`oracle_cards` but
> the built schema is `public.co_*` with `oracle_id text`.

```sql
-- card_printings : NEW, optimizer-owned (collection schema). Full Scryfall printings.
create table collection.card_printings (
  scryfall_id uuid primary key,
  oracle_id text not null,                         -- joins to public.cards.oracle_id (text!)
  name text not null, set_code text not null, collector_num text not null,
  colors text[] not null default '{}', color_identity text[] not null default '{}',
  mana_cost text, cmc numeric not null default 0,
  type_line text not null, oracle_text text, keywords text[] not null default '{}',
  rarity text, layout text, finishes text[] not null default '{}', image_uris jsonb,
  prices jsonb, prices_synced_at timestamptz,
  search_tsv tsvector
);
create index on collection.card_printings (oracle_id);
create index on collection.card_printings using gin (search_tsv);
create index on collection.card_printings using gin (color_identity);
-- Oracle-level identity for synergy/scoring = distinct-on(oracle_id) view over card_printings.
-- public.cards (game catalog) is reused READ-ONLY, joined on oracle_id for script/behavior only.

-- ── NEW tables below (collection schema). `references oracle_cards` = FK to oracle identity;
--    in practice validate oracle_id (text) against card_printings in the app layer. ──

create table card_tags (
  oracle_id uuid references oracle_cards, tag text not null,
  weight numeric not null default 1, source text not null,   -- heuristic|manual|ai
  primary key (oracle_id, tag)
);
create index on card_tags (tag);

create table collection_items (   -- RLS ON
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  scryfall_id uuid not null references collection.card_printings,
  oracle_id text not null,                         -- text to match live cards.oracle_id; denormalized for availability view
  quantity int not null check (quantity > 0),
  finish text not null default 'nonfoil',
  language text not null default 'en', condition text,
  binder_type text not null default 'binder',      -- binder|deck|list
  import_id uuid references imports, updated_at timestamptz default now(),
  unique (user_id, scryfall_id, finish, language, condition)
);
create index on collection_items (user_id, oracle_id);

create table decks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  name text not null,
  commander_oracle_id text,   -- oracle_id (text); validated against card_printings in app layer
  partner_oracle_id text,
  color_identity text[] not null default '{}',
  source text, source_url text, power_score numeric, updated_at timestamptz default now()
);

create table deck_cards (
  deck_id uuid references decks on delete cascade,
  oracle_id text not null,                          -- text; validated against card_printings in app layer
  quantity int not null default 1, is_commander boolean not null default false, category text,
  primary key (deck_id, oracle_id)
);

create table price_cache (
  scryfall_id uuid primary key references collection.card_printings,
  eur numeric, eur_foil numeric, usd numeric, fetched_at timestamptz not null default now()
);

create table imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  kind text not null, source text not null, filename text,
  rows_total int, rows_matched int, rows_unmatched int, unmatched jsonb,
  created_at timestamptz default now()
);

create table deck_analyses (
  deck_id uuid primary key references decks on delete cascade,
  computed_at timestamptz default now(),
  power_score numeric, buckets jsonb, curve jsonb, colors jsonb,
  avg_mv numeric, land_count int, explanation text
);
```

**Availability view (single source of truth):**

```sql
create view v_card_availability as
select c.user_id, c.oracle_id,
       sum(c.quantity) filter (where c.binder_type = 'binder') as free_qty,
       sum(c.quantity) as owned_qty,
       coalesce(d.committed_qty, 0) as committed_qty
from collection_items c
left join (
  select dk.user_id, dc.oracle_id, sum(dc.quantity) committed_qty
  from deck_cards dc join decks dk on dk.id = dc.deck_id
  group by dk.user_id, dc.oracle_id
) d on d.user_id = c.user_id and d.oracle_id = c.oracle_id
group by c.user_id, c.oracle_id, d.committed_qty;
```

**Schema pitfalls (must solve up front):**
- MDFC/split/adventure: one `oracle_id`, multiple names. ManaBox may give the back-face name. Match via `oracle_id`, never raw name string.
- Basic lands explode availability math — treat as infinitely available, never list as "free staple".
- Foil vs nonfoil: play-identical, price-different. Ownership splits on finish; availability aggregates over it.
- ManaBox `binder_type = deck` is not the same as "in an imported deck". Use `deck_cards` as the source of truth for "occupied"; treat ManaBox's tag only as a hint, else double-counting.

---

## 3. Prisma models (reference only — for a future standalone spin-out)

```prisma
model Card {
  scryfallId String @id @map("scryfall_id") @db.Uuid
  oracleId   String @map("oracle_id") @db.Uuid
  name String; setCode String @map("set_code"); collectorNum String @map("collector_num")
  colorIdentity String[] @map("color_identity"); cmc Decimal
  typeLine String @map("type_line"); oracleText String? @map("oracle_text"); keywords String[]
  prices Json?; collection CollectionItem[]
  @@index([oracleId]) @@map("cards")
}
model CollectionItem {
  id String @id @default(uuid()) @db.Uuid
  userId String @map("user_id") @db.Uuid
  scryfallId String @map("scryfall_id") @db.Uuid; oracleId String @map("oracle_id") @db.Uuid
  quantity Int; finish String @default("nonfoil"); binderType String @default("binder") @map("binder_type")
  @@unique([userId, scryfallId, finish, language, condition])
  @@index([userId, oracleId]) @@map("collection_items")
}
```

⚠️ Prisma ignores RLS (single DB role). If used, every query MUST carry `where: { userId }` and the
Prisma connection must never be client-reachable. This loses the fail-safe RLS gives — the main
reason native-Supabase is recommended.

---

## 4. API endpoints

Route Handlers (REST) for external/heavy/cacheable work; Server Actions for direct UI mutations;
reads via Server Components straight on Supabase.

```
POST   /api/collection/import         CSV → parse → match → upsert; returns import report
GET    /api/collection                ?filter=free&colors=UB  (paginated)
GET    /api/collection/stats          totals, unique, free, multi-deck, dupes
POST   /api/decks/import              {source, raw|url} → normalized deck
GET    /api/decks/:id                 deck + cards + availability join
GET    /api/decks/:id/analysis        buckets, curve, power score (cached)
POST   /api/decks/:id/analysis/refresh
GET    /api/decks/:id/upgrades        ?budget=5&category=free|occupied|buy   ← core feature
POST   /api/decks/:id/swaps           apply a swap (out X, in Y)
POST   /api/collection/move-card      move a card between decks
GET    /api/conflicts                 cards claimed by >1 deck
POST   /api/ai/recommend              {deckId, budget, theme} → ranked swaps + explanation (stream)
GET    /api/dashboard                 composed widgets
GET    /api/cards/search              FTS proxy (autocomplete)
```

Core contract — `GET /api/decks/:id/upgrades`:
```jsonc
{
  "free":     [{ "out": {}, "in": {}, "delta": 1.8, "reason": "", "owned": true }],
  "occupied": [{ "in": {}, "usedBy": ["Cloud Equipment"], "action": "move|buy|proxy" }],
  "buy":      [{ "in": {}, "priceEur": 1.84, "reason": "" }]
}
```

---

## 5. Folder structure

```
app/
  collection/{page.tsx, import/page.tsx}
  decks/{page.tsx, [id]/{page.tsx, upgrade/page.tsx}}
  dashboard/page.tsx
  api/collection/{import,stats,move-card}/route.ts
  api/decks/[id]/{analysis,upgrades,swaps}/route.ts
  api/{ai/recommend,conflicts}/route.ts
lib/collection/                  # pure domain logic, unit-tested
  parsers/{manabox,moxfield,archidekt,text,index}.ts
  inventory.ts
  synergy/{tagger,score}.ts
  power-score.ts  upgrade-scanner.ts  price.ts  ai-orchestrator.ts  types.ts
components/collection/
  ImportWizard.tsx CollectionTable.tsx CollectionFilters.tsx
  DeckAnalysisCard.tsx PowerScoreGauge.tsx ManaCurveChart.tsx
  UpgradeScanner.tsx SwapCard.tsx ConflictList.tsx DashboardWidgets.tsx
scripts/{import-scryfall-cards.mjs (extend), tag-backfill.mjs (new)}
```

Follows existing conventions (`lib/game/` → `lib/collection/`, `components/<feature>/`).

---

## 6. Frontend components (key)

- **ImportWizard** — drag-drop CSV → live match preview (matched/unmatched with manual resolve) → confirm. Never silent-import; unmatched rows are the #1 support question.
- **CollectionTable** — virtualized (10k+ rows). Filter chips: Free / Multi-deck / Dupes / Colors.
- **PowerScoreGauge** — 0–10 with clickable breakdown (transparency > precision).
- **UpgradeScanner** — three tabs (Free/Occupied/Buy); each swap is a **SwapCard** (OUT→IN, delta, reason, one primary action).
- **ManaCurveChart** — CSS bars (no charting lib; fits framer-motion stack).
- **ConflictList** — card → decks that want it → advice.

State: **no Zustand/TanStack for MVP.** Server Components + Server Actions + React 19 `useOptimistic`.
Add TanStack only when client-side refetch grows (live budget slider in the scanner is the first real
candidate). Deliberate choice, not omission.

---

## 7. UX flow

```
Onboarding → import collection (ManaBox CSV) → import decks (Moxfield/Archidekt/txt)
          → Dashboard (value, free staples, top upgrades)
              ├─ Deck → Analysis (power score + buckets) → Upgrade Scanner
              │     ├─ Free: Apply (1 click) → update deck + availability
              │     ├─ Occupied: Move card (shows conflict) or Buy
              │     └─ Buy: budget filter → Scryfall link
              └─ Conflicts → advice per shared staple
```

**Golden flow to prove in MVP:** CSV in → within 10s, a deck with 3 concrete applyable free upgrades.

---

## 8. Wireframes (textual)

```
┌ Atraxa Superfriends ───────────── Power 6.8/10 ▸ ┐
│ Budget: (Free)(<€2)(<€5)(<€10)(∞)  Colors: WUBG  │
│  FREE            OCCUPIED            BUY          │
│ ┌──────────────────────────────────────────────┐ │
│ │ OUT Curiosity      IN Phyrexian Arena  Δ+1.8 │ │
│ │ ▸ More consistent card draw   in binder ✓    │ │
│ │                                    [ Apply ] │ │
│ └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘

Esper Sentinel   occupied · 1 copy
 wanted by: Cloud · Y'shtola · Urza
 advice: [buy 2nd €38] [proxy] [assign to Urza]
```

---

## 9. AI architecture

**Principle: the AI reasons, it does not retrieve.** Never let the LLM invent cards (hallucinated
prices/legality). RAG over the user's own data:

```
1. RETRIEVE (deterministic TS): deck buckets + power score + candidate swaps from upgrade-scanner
   (already filtered on color identity, legality, budget, ownership) — context ≈ 30 cards.
2. RANK + EXPLAIN (Anthropic, @anthropic-ai/sdk): theme + buckets + candidates → order + explain,
   structured output (zod schema) so it's validatable.
3. VALIDATE (TS): every proposed card MUST be in the candidate list, else discard. Trust no free-text card names.
```

Model: `claude-opus-4-8` for the deck-doctor reasoning step; `claude-haiku-4-5` for cheap bulk explanation.

**Pitfalls:**
- Cost: cache explanation per deck version (`deck_analyses.explanation`); regenerate only on change.
- **EDHREC data is not freely redistributable** — cannot scrape/store as the synergy source. Synergy must come from Scryfall oracle text + own heuristics (`tagger.ts`). This is the biggest legal risk.
- Determinism: scoring lives in deterministic TS; LLM only does the natural-language layer + tie-breaking, so power score stays reproducible.

**Synergy engine (no AI needed):**
```
tagger.ts: regex/keyword over oracle_text → {ramp, removal, card_draw, wipe, …}
score(card, deck) = Σ tag_weight × deck_need(tag) × color_fit × commander_synergy
power_score(deck) = normalized weighted bucket coverage vs ideal profile
```
Start with ~15 tags (the brief's list) and transparent weights. Heuristics first, AI refinement later.

---

## 10. Performance

- Scryfall: never per-card live. One nightly bulk import (oracle-cards + default-cards). Prices: bulk daily. Respect 10 req/s + User-Agent (ToS).
- Availability as a view, not a trigger-maintained column. Materialize only past ~50k items/user.
- Tagger runs offline batch (`tag-backfill.mjs`); tags static per oracle_id → cache forever.
- Upgrade scan (heaviest): pre-filter in SQL (color identity via GIN, FTS) → score candidates in TS. Target <500ms for a 100-card deck vs 5k binder cards.
- Import: streaming Route Handler; >5000 rows → batch upsert (chunks of 500). Large CSV not in a single Server Action (body limit).
- AI: cache + stream, never blocking on page load.

---

## 11. Scalability

- RLS = free multi-tenancy; every user table has `user_id` + policy `auth.uid() = user_id`. Build from row 1.
- `cards`/`oracle_cards`/`card_tags` shared read-mostly (no RLS) → small, aggressively cacheable.
- Per-user data scales linearly, partitionable on `user_id`.
- Heavy analysis that won't fit a request → Supabase Edge Function + pg queue (`analysis_jobs`), not a NestJS worker.
- Meilisearch only if Postgres FTS falls short on fuzzy names at scale — not MVP.

---

## 12. Roadmap

**MVP (prove the golden flow):** ManaBox CSV import + Scryfall match · collection stats · txt/Moxfield
deck import · availability view · **Free Upgrade Scanner** (heuristic synergy + power score) · basic
dashboard. *Success: CSV → 3 applyable free upgrades < 10s.*

**v1 (complete it):** Occupied upgrades + Move-card · Conflicts · Buy suggestions (budget filters +
Scryfall prices) · Archidekt import · deck buckets + curve + colors · import history.

**v2 (the "personal EDHRec"):** AI Recommendation Engine (RAG, theme preservation, explanation) ·
deck-health on dashboard · collection value/timeline · auto deck-tags · combo detector (known 2-card combos).

**v3 (expand):** Commander recs from collection · deck similarity · mana-base optimizer · trade binder ·
MTGO/Arena/Dragon Shield imports · ManaBox sync · AI deck-doctor / playtester.
