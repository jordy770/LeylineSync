-- Capture the ManaBox "Binder Name" so a player can physically locate a card
-- ("which binder is my Sol Ring in?"). Additive: nullable column + the dedup key
-- now includes binder_name, so the SAME printing split across two binders stays as
-- two rows (each keeps its location); availability still sums over oracle_id.

alter table public.co_collection_items add column if not exists binder_name text;

drop index if exists co_collection_items_uniq;
create unique index if not exists co_collection_items_uniq
  on public.co_collection_items (
    user_id, oracle_id, finish, language,
    coalesce(condition, ''), coalesce(set_code, ''), coalesce(collector_num, ''), coalesce(binder_name, '')
  );
