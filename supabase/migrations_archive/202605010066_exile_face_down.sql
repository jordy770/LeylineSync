-- Track whether a card is exiled face-down (hidden from opponents).
-- Default false covers all existing rows safely.
alter table public.game_cards
  add column if not exists is_face_down boolean not null default false;

comment on column public.game_cards.is_face_down is
  'True when the card is in exile face-down and should not be revealed to other players.';
