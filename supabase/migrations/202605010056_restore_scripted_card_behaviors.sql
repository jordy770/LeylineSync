insert into public.cards (
  id,
  name,
  type_line,
  mana_cost,
  oracle_text,
  script
)
select
  gen_random_uuid(),
  'Green Mana Vessel Test',
  'Artifact',
  '{2}',
  'Green mana does not empty from your mana pool as steps and phases end.',
  $json${
    "continuous_effects": [
      {
        "type": "mana_does_not_empty",
        "colors": ["G"],
        "affected": "controller",
        "source_zone_required": "battlefield"
      }
    ]
  }$json$::jsonb
where not exists (
  select 1
  from public.cards
  where lower(name) = 'green mana vessel test'
);

insert into public.cards (
  id,
  name,
  type_line,
  mana_cost,
  oracle_text,
  script
)
select
  gen_random_uuid(),
  'Exploration Test',
  'Enchantment',
  '{G}',
  'You may play an additional land on each of your turns.',
  $json${
    "continuous_effects": [
      {
        "type": "additional_land_plays",
        "amount": 1,
        "affected": "controller",
        "source_zone_required": "battlefield"
      }
    ]
  }$json$::jsonb
where not exists (
  select 1
  from public.cards
  where lower(name) = 'exploration test'
);

with scripted_cards(name, script) as (
  values
    (
      'Forest',
      $json${
        "actions": [
          { "type": "add_mana", "color": "G", "amount": 1 }
        ],
        "triggers": ["manual_tap"]
      }$json$::jsonb
    ),
    (
      'Mountain',
      $json${
        "actions": [
          { "type": "add_mana", "color": "R", "amount": 1 }
        ],
        "triggers": ["manual_tap"]
      }$json$::jsonb
    ),
    (
      'Island',
      $json${
        "actions": [
          { "type": "add_mana", "color": "U", "amount": 1 }
        ],
        "triggers": ["manual_tap"]
      }$json$::jsonb
    ),
    (
      'Swamp',
      $json${
        "actions": [
          { "type": "add_mana", "color": "B", "amount": 1 }
        ],
        "triggers": ["manual_tap"]
      }$json$::jsonb
    ),
    (
      'Plains',
      $json${
        "actions": [
          { "type": "add_mana", "color": "W", "amount": 1 }
        ],
        "triggers": ["manual_tap"]
      }$json$::jsonb
    ),
    (
      'Sol Ring',
      $json${
        "actions": [
          { "type": "add_mana", "color": "C", "amount": 2 }
        ],
        "triggers": ["manual_tap"]
      }$json$::jsonb
    ),
    (
      'Llanowar Elves',
      $json${
        "actions": [
          { "type": "add_mana", "color": "G", "amount": 1 }
        ],
        "triggers": ["manual_tap"]
      }$json$::jsonb
    ),
    (
      'Lightning Bolt',
      $json${
        "actions": [
          { "type": "deal_damage", "amount": 3, "target_type": "any" }
        ],
        "triggers": ["cast"]
      }$json$::jsonb
    ),
    (
      'Counterspell',
      $json${
        "actions": [
          { "type": "counter_spell", "target": "spell", "timing": "instant" }
        ],
        "triggers": ["cast"]
      }$json$::jsonb
    ),
    (
      'Exploration',
      $json${
        "continuous_effects": [
          {
            "type": "additional_land_plays",
            "amount": 1,
            "affected": "controller",
            "source_zone_required": "battlefield"
          }
        ]
      }$json$::jsonb
    ),
    (
      'Exploration Test',
      $json${
        "continuous_effects": [
          {
            "type": "additional_land_plays",
            "amount": 1,
            "affected": "controller",
            "source_zone_required": "battlefield"
          }
        ]
      }$json$::jsonb
    ),
    (
      'Azusa, Lost but Seeking',
      $json${
        "continuous_effects": [
          {
            "type": "additional_land_plays",
            "amount": 2,
            "affected": "controller",
            "source_zone_required": "battlefield"
          }
        ]
      }$json$::jsonb
    ),
    (
      'Upwelling',
      $json${
        "continuous_effects": [
          {
            "type": "mana_does_not_empty",
            "colors": ["W", "U", "B", "R", "G", "C"],
            "affected": "all_players",
            "source_zone_required": "battlefield"
          }
        ]
      }$json$::jsonb
    ),
    (
      'Omnath, Locus of Mana',
      $json${
        "continuous_effects": [
          {
            "type": "mana_does_not_empty",
            "colors": ["G"],
            "affected": "controller",
            "source_zone_required": "battlefield"
          }
        ]
      }$json$::jsonb
    ),
    (
      'Green Mana Vessel Test',
      $json${
        "continuous_effects": [
          {
            "type": "mana_does_not_empty",
            "colors": ["G"],
            "affected": "controller",
            "source_zone_required": "battlefield"
          }
        ]
      }$json$::jsonb
    ),
    (
      'Raging Goblin',
      $json${
        "continuous_effects": [
          { "type": "haste", "affected": "source", "source_zone_required": "battlefield" }
        ]
      }$json$::jsonb
    ),
    (
      'Serra Angel',
      $json${
        "continuous_effects": [
          { "type": "vigilance", "affected": "source", "source_zone_required": "battlefield" }
        ]
      }$json$::jsonb
    ),
    (
      'Darksteel Myr',
      $json${
        "continuous_effects": [
          { "type": "indestructible", "affected": "source", "source_zone_required": "battlefield" }
        ]
      }$json$::jsonb
    ),
    (
      'Colossal Dreadmaw',
      $json${
        "continuous_effects": [
          { "type": "trample", "affected": "source", "source_zone_required": "battlefield" }
        ]
      }$json$::jsonb
    ),
    (
      'White Knight',
      $json${
        "continuous_effects": [
          { "type": "first_strike", "affected": "source", "source_zone_required": "battlefield" }
        ]
      }$json$::jsonb
    ),
    (
      'Fencing Ace',
      $json${
        "continuous_effects": [
          { "type": "double_strike", "affected": "source", "source_zone_required": "battlefield" }
        ]
      }$json$::jsonb
    )
)
update public.cards
set script = scripted_cards.script
from scripted_cards
where lower(public.cards.name) = lower(scripted_cards.name);
