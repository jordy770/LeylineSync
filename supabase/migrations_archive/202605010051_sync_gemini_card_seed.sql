alter table public.cards
add column if not exists oracle_text text;

alter table public.cards
add column if not exists keywords jsonb not null default '[]'::jsonb;

alter table public.cards
add column if not exists image_url text;

alter table public.cards
add column if not exists mana_cost text;

alter table public.cards
add column if not exists power_toughness text;

alter table public.cards
add column if not exists power integer;

alter table public.cards
add column if not exists toughness integer;

alter table public.cards
add column if not exists script jsonb not null default '{}'::jsonb;

create temporary table seed_gemini_cards (
  id uuid,
  name text,
  mana_cost text,
  type_line text,
  oracle_text text,
  power_toughness text,
  keywords jsonb,
  script jsonb,
  image_url text,
  power integer,
  toughness integer
) on commit drop;

insert into seed_gemini_cards (
  id,
  name,
  mana_cost,
  type_line,
  oracle_text,
  power_toughness,
  keywords,
  script,
  image_url,
  power,
  toughness
)
values
  (
    '0d201b99-60db-42fb-920e-e61c8a793c78',
    'Green Mana Vessel Test',
    '{2}',
    'Artifact',
    $card$Green mana doesn't empty from your mana pool as steps and phases end.$card$,
    null,
    '[]',
    '{"continuous_effects": [{"type": "mana_does_not_empty", "colors": ["G"], "affected": "controller", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/1/5/157297e6-7649-43c3-a3a9-e859021a8300.jpg',
    null,
    null
  ),
  (
    '0d724ba8-a621-43d4-9235-36939c1691ab',
    'Colossal Dreadmaw',
    '{4}{G}{G}',
    'Creature - Dinosaur',
    $card$Trample$card$,
    '6/6',
    '[]',
    '{"continuous_effects": [{"type": "trample", "affected": "source", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/e/0/e01d2b69-c56d-4939-9235-36939c1691ab.jpg',
    6,
    6
  ),
  (
    '1499f1fb-ec2b-4eef-8f46-bd31333b7b92',
    'Counterspell',
    '{U}{U}',
    'Instant',
    $card$Counter target spell.$card$,
    null,
    '[]',
    '{}',
    'https://cards.scryfall.io/normal/front/0/a/0a1b4e2e-5459-4fae-81d9-1e882647daac.jpg?1559597169',
    null,
    null
  ),
  (
    '14f5849a-ae83-49ba-8742-c0e9b60e61e0',
    'Sol Ring',
    '{1}',
    'Artifact',
    $card${T}: Add {C}{C}.$card$,
    null,
    '[]',
    '{"actions": [{"type": "add_mana", "color": "C", "amount": 2}], "triggers": ["manual_tap"]}',
    'https://cards.scryfall.io/normal/front/0/6/06be8262-4636-4a2c-a0c8-de741cf45aed.jpg?1696638321',
    null,
    null
  ),
  (
    '29eedf1d-7204-4822-b535-64367332f1b7',
    'Mountain',
    null,
    'Basic Land - Mountain',
    $card$({T}: Add {R}.)$card$,
    null,
    '[]',
    '{"actions": [{"type": "add_mana", "color": "R", "amount": 1}], "triggers": ["manual_tap"]}',
    'https://cards.scryfall.io/normal/front/2/9/29eedf1d-7204-4822-b535-64367332f1b7.jpg',
    null,
    null
  ),
  (
    '2c089083-25c6-4cc0-ace1-fd321d2ec9b4',
    'Fencing Ace',
    '{1}{W}',
    'Creature - Human Soldier',
    $card$Double strike$card$,
    '1/1',
    '[]',
    '{"continuous_effects": [{"type": "double_strike", "affected": "source", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/b/3/b3bc648c-023c-411a-9694-8740c064972d.jpg',
    1,
    1
  ),
  (
    '2d1b2f25-603b-4663-a7e5-2c64581024d7',
    'Exploration Test',
    '{G}',
    'Enchantment',
    $card$You may play an additional land on each of your turns.$card$,
    null,
    '[]',
    '{"continuous_effects": [{"type": "additional_land_plays", "amount": 1, "affected": "controller", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/1/c/1c3fc61c-c26e-47f3-a1eb-f6f10f8469e2.jpg',
    null,
    null
  ),
  (
    '40de8139-314b-4bbc-bb12-1cdd3405bd2e',
    'Serra Angel',
    '{3}{W}{W}',
    'Creature - Angel',
    $card$Flying; Vigilance$card$,
    '4/4',
    '[]',
    '{"continuous_effects": [{"type": "vigilance", "affected": "source", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/8/8/88e2fc19-869d-474c-8367-720612401777.jpg',
    4,
    4
  ),
  (
    '4704efc3-9831-4e42-990a-2009228308c3',
    'Forest',
    null,
    'Basic Land - Forest',
    $card$({T}: Add {G}.)$card$,
    null,
    '[]',
    '{"actions": [{"type": "add_mana", "color": "G", "amount": 1}], "triggers": ["manual_tap"]}',
    'https://cards.scryfall.io/normal/front/4/7/4704efc3-9831-4e42-990a-2009228308c3.jpg',
    null,
    null
  ),
  (
    '4e776ba5-db57-47bf-a614-677765a655b4',
    'Exploration',
    '{G}',
    'Enchantment',
    $card$You may play an additional land on each of your turns.$card$,
    null,
    '[]',
    '{"continuous_effects": [{"type": "additional_land_plays", "amount": 1, "affected": "controller", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/1/c/1c3fc61c-c26e-47f3-a1eb-f6f10f8469e2.jpg',
    null,
    null
  ),
  (
    '5231731e-992e-4b43-8296-e24161497900',
    'Island',
    null,
    'Basic Land - Island',
    $card$({T}: Add {U}.)$card$,
    null,
    '[]',
    '{"actions": [{"type": "add_mana", "color": "U", "amount": 1}], "triggers": ["manual_tap"]}',
    'https://cards.scryfall.io/normal/front/5/2/5231731e-992e-4b43-8296-e24161497900.jpg',
    null,
    null
  ),
  (
    '6b8741cc-04c0-4193-a41a-acbc11e6a929',
    'Darksteel Myr',
    '{3}',
    'Artifact Creature - Myr',
    $card$Indestructible$card$,
    '0/1',
    '[]',
    '{"continuous_effects": [{"type": "indestructible", "affected": "source", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/0/f/0f5712cf-c6a9-4a2e-90db-8ca17c621724.jpg',
    0,
    1
  ),
  (
    '8365ab45-6d78-47ad-a6ed-282069b0fabc',
    'Swamp',
    null,
    'Basic Land - Swamp',
    $card$({T}: Add {B}.)$card$,
    null,
    '[]',
    '{"actions": [{"type": "add_mana", "color": "B", "amount": 1}], "triggers": ["manual_tap"]}',
    'https://cards.scryfall.io/normal/front/8/3/8365ab45-6d78-47ad-a6ed-282069b0fabc.jpg',
    null,
    null
  ),
  (
    '8bbcfb77-daa1-4ce5-b5f9-48d0a8edbba9',
    'Llanowar Elves',
    '{G}',
    'Creature - Elf Druid',
    $card${T}: Add {G}.$card$,
    '1/1',
    '[]',
    '{"actions": [{"type": "add_mana", "color": "G", "amount": 1}], "triggers": ["manual_tap"]}',
    'https://cards.scryfall.io/normal/front/0/1/01c6f877-6b00-4d57-8a88-36cd3b16edbc.jpg?1562630529',
    1,
    1
  ),
  (
    '97d6b4f7-a617-40a1-b40b-b6f086abc29d',
    'Raging Goblin',
    '{R}',
    'Creature - Goblin Berserker',
    $card$Haste$card$,
    '1/1',
    '[]',
    '{"continuous_effects": [{"type": "haste", "affected": "source", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/8/c/8c5123fc-6a94-4a2e-90db-8ca17c621724.jpg',
    1,
    1
  ),
  (
    'a88e1486-3303-4f33-9135-376fd687ec7b',
    'Plains',
    null,
    'Basic Land - Plains',
    $card$({T}: Add {W}.)$card$,
    null,
    '[]',
    '{"actions": [{"type": "add_mana", "color": "W", "amount": 1}], "triggers": ["manual_tap"]}',
    'https://cards.scryfall.io/normal/front/a/8/a88e1486-3303-4f33-9135-376fd687ec7b.jpg',
    null,
    null
  ),
  (
    'b24a63bf-bdbd-4fda-97f2-e54362b78448',
    'White Knight',
    '{W}{W}',
    'Creature - Human Knight',
    $card$First strike; Protection from black$card$,
    '2/2',
    '[]',
    '{"continuous_effects": [{"type": "first_strike", "affected": "source", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/e/0/e04543bf-bd21-438f-9a0d-9657685a444a.jpg',
    2,
    2
  ),
  (
    'e00f686a-0f38-44a2-a4d0-592478a233d3',
    'Upwelling',
    '{3}{G}',
    'Enchantment',
    $card$Mana pools don't empty as steps and phases end.$card$,
    null,
    '[]',
    '{"continuous_effects": [{"type": "mana_does_not_empty", "colors": ["W", "U", "B", "R", "G", "C"], "affected": "all_players", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/d/2/d276b976-5868-4509-906d-449e75619da0.jpg',
    null,
    null
  ),
  (
    'ec4cb33e-ac9b-461d-81f8-16e51d471eae',
    'Azusa, Lost but Seeking',
    '{2}{G}',
    'Legendary Creature - Human Monk',
    $card$You may play two additional lands on each of your turns.$card$,
    '1/2',
    '[]',
    '{"continuous_effects": [{"type": "additional_land_plays", "amount": 2, "affected": "controller", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/c/c/ccb1070e-f495-46b5-9017-0248f2f2214d.jpg',
    1,
    2
  ),
  (
    'f29ba16f-c8fb-42fe-aabf-87089cb214a7',
    'Lightning Bolt',
    '{R}',
    'Instant',
    $card$Lightning Bolt deals 3 damage to any target.$card$,
    null,
    '[]',
    '{"actions": [{"type": "deal_damage", "amount": 3, "target_type": "any"}], "triggers": ["cast"]}',
    'https://cards.scryfall.io/normal/front/0/2/0277c0b1-da97-49c1-a539-7fbaa1f77419.jpg?1758887999',
    null,
    null
  ),
  (
    'f66c40d8-46b4-498d-b476-4c3634935e80',
    'Omnath, Locus of Mana',
    '{2}{G}',
    'Legendary Creature - Elemental',
    $card$Green mana doesn't empty from your mana pool as steps and phases end.; Omnath gets +1/+1 for each unspent green mana you have.$card$,
    '1/1',
    '[]',
    '{"continuous_effects": [{"type": "mana_does_not_empty", "colors": ["G"], "affected": "controller", "source_zone_required": "battlefield"}]}',
    'https://cards.scryfall.io/normal/front/4/e/4e7d95a2-3f7d-4f9c-b56e-8263032d845e.jpg',
    1,
    1
  );

update public.cards cards
set
  mana_cost = seed.mana_cost,
  type_line = seed.type_line,
  oracle_text = seed.oracle_text,
  power_toughness = seed.power_toughness,
  keywords = seed.keywords,
  script = seed.script,
  power = seed.power,
  toughness = seed.toughness
from seed_gemini_cards seed
where lower(cards.name) = lower(seed.name);

insert into public.cards (
  id,
  name,
  mana_cost,
  type_line,
  oracle_text,
  power_toughness,
  keywords,
  script,
  power,
  toughness
)
select
  seed.id,
  seed.name,
  seed.mana_cost,
  seed.type_line,
  seed.oracle_text,
  seed.power_toughness,
  seed.keywords,
  seed.script,
  seed.power,
  seed.toughness
from seed_gemini_cards seed
where not exists (
  select 1
  from public.cards cards
  where lower(cards.name) = lower(seed.name)
);
