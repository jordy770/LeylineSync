alter table public.game_stack_items
drop constraint if exists game_stack_items_action_type_check;

alter table public.game_stack_items
add constraint game_stack_items_action_type_check
check (action_type in ('deal_damage_player', 'cast_permanent', 'counter_spell'));
