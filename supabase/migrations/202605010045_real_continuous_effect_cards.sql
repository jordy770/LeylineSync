insert into public.cards (
  id,
  name,
  type_line,
  mana_cost,
  script
)
select
  gen_random_uuid(),
  'Exploration',
  'Enchantment',
  '{G}',
  jsonb_build_object(
    'continuous_effects',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'additional_land_plays',
        'amount', 1,
        'affected', 'controller',
        'source_zone_required', 'battlefield'
      )
    )
  )
where not exists (
  select 1
  from public.cards
  where lower(name) = 'exploration'
);

update public.cards
set script = jsonb_build_object(
  'continuous_effects',
  jsonb_build_array(
    jsonb_build_object(
      'type', 'additional_land_plays',
      'amount', 1,
      'affected', 'controller',
      'source_zone_required', 'battlefield'
    )
  )
)
where lower(name) = 'exploration';

insert into public.cards (
  id,
  name,
  type_line,
  mana_cost,
  script
)
select
  gen_random_uuid(),
  'Azusa, Lost but Seeking',
  'Legendary Creature - Human Monk',
  '{2}{G}',
  jsonb_build_object(
    'continuous_effects',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'additional_land_plays',
        'amount', 2,
        'affected', 'controller',
        'source_zone_required', 'battlefield'
      )
    )
  )
where not exists (
  select 1
  from public.cards
  where lower(name) = 'azusa, lost but seeking'
);

update public.cards
set script = jsonb_build_object(
  'continuous_effects',
  jsonb_build_array(
    jsonb_build_object(
      'type', 'additional_land_plays',
      'amount', 2,
      'affected', 'controller',
      'source_zone_required', 'battlefield'
    )
  )
)
where lower(name) = 'azusa, lost but seeking';

insert into public.cards (
  id,
  name,
  type_line,
  mana_cost,
  script
)
select
  gen_random_uuid(),
  'Upwelling',
  'Enchantment',
  '{3}{G}',
  jsonb_build_object(
    'continuous_effects',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'mana_does_not_empty',
        'colors', jsonb_build_array('W', 'U', 'B', 'R', 'G', 'C'),
        'affected', 'all_players',
        'source_zone_required', 'battlefield'
      )
    )
  )
where not exists (
  select 1
  from public.cards
  where lower(name) = 'upwelling'
);

update public.cards
set script = jsonb_build_object(
  'continuous_effects',
  jsonb_build_array(
    jsonb_build_object(
      'type', 'mana_does_not_empty',
      'colors', jsonb_build_array('W', 'U', 'B', 'R', 'G', 'C'),
      'affected', 'all_players',
      'source_zone_required', 'battlefield'
    )
  )
)
where lower(name) = 'upwelling';

insert into public.cards (
  id,
  name,
  type_line,
  mana_cost,
  script
)
select
  gen_random_uuid(),
  'Omnath, Locus of Mana',
  'Legendary Creature - Elemental',
  '{2}{G}',
  jsonb_build_object(
    'continuous_effects',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'mana_does_not_empty',
        'colors', jsonb_build_array('G'),
        'affected', 'controller',
        'source_zone_required', 'battlefield'
      )
    )
  )
where not exists (
  select 1
  from public.cards
  where lower(name) = 'omnath, locus of mana'
);

update public.cards
set script = jsonb_build_object(
  'continuous_effects',
  jsonb_build_array(
    jsonb_build_object(
      'type', 'mana_does_not_empty',
      'colors', jsonb_build_array('G'),
      'affected', 'controller',
      'source_zone_required', 'battlefield'
    )
  )
)
where lower(name) = 'omnath, locus of mana';
