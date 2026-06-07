// LLM-facing description of the card behavior script format.
//
// This is the single source of truth that keeps three things in sync: the
// guided form (card-behavior-builder.ts), the validator (card-behavior-schema.ts),
// and the AI generator (app/api/cards/generate-behavior). The guide below is
// derived from the same vocabulary constants the form uses, so adding a new
// keyword / trigger event / effect type to the builder automatically teaches the
// AI about it too.

import {
  BUILDER_DAMAGE_TARGETS,
  BUILDER_EFFECT_TYPES,
  BUILDER_KEYWORDS,
  BUILDER_RECIPIENTS,
  BUILDER_TOKEN_NAMES,
  BUILDER_TRIGGER_EVENTS,
  KEYWORD_LABELS,
} from './card-behavior-builder'

// A few worked examples grounding the schema in real cards. Keep these valid
// against card-behavior-schema.ts (validateCardScript).
const EXAMPLES: { oracle_text: string; script: unknown }[] = [
  {
    oracle_text: 'Flying, vigilance',
    script: {
      schema_version: 2,
      continuous_effects: [
        { type: 'flying', affected: 'source', source_zone_required: 'battlefield' },
        { type: 'vigilance', affected: 'source', source_zone_required: 'battlefield' },
      ],
    },
  },
  {
    oracle_text: 'When CARDNAME enters the battlefield, each opponent loses 2 life and you gain 2 life.',
    script: {
      schema_version: 2,
      triggered_abilities: [
        {
          event: 'enters_the_battlefield',
          effects: [
            { type: 'lose_life', amount: 2, recipient: 'each_opponent' },
            { type: 'gain_life', amount: 2 },
          ],
        },
      ],
    },
  },
  {
    oracle_text: 'At the beginning of your upkeep, draw a card.',
    script: {
      schema_version: 2,
      triggered_abilities: [
        { event: 'beginning_of_upkeep', effects: [{ type: 'draw', amount: 1 }] },
      ],
    },
  },
  {
    oracle_text: 'Whenever CARDNAME attacks, put a +1/+1 counter on it.',
    script: {
      schema_version: 2,
      triggered_abilities: [
        { event: 'attacks', effects: [{ type: 'add_counters', amount: 1 }] },
      ],
    },
  },
  {
    oracle_text: 'At the beginning of your upkeep, create a 1/1 green Saproling creature token.',
    script: {
      schema_version: 2,
      triggered_abilities: [
        {
          event: 'beginning_of_upkeep',
          effects: [{ type: 'create_token', token: 'Saproling Token', count: 1 }],
        },
      ],
    },
  },
  {
    oracle_text: '{T}: CARDNAME deals 1 damage to any target.',
    script: {
      schema_version: 2,
      activated_abilities: [
        {
          costs: [{ type: 'tap_self' }],
          effects: [{ type: 'deal_damage', amount: 1, target_type: ['creature', 'player'] }],
        },
      ],
    },
  },
  {
    oracle_text: '{T}: Add {G}.',
    script: {
      schema_version: 2,
      activated_abilities: [
        {
          is_mana_ability: true,
          costs: [{ type: 'tap_self' }],
          effects: [{ type: 'add_mana', color: 'G', amount: 1 }],
        },
      ],
    },
  },
  {
    oracle_text: 'CARDNAME deals 3 damage to any target. (instant)',
    script: {
      schema_version: 2,
      spell_effect: {
        actions: [{ type: 'deal_damage', amount: 3, target_type: ['creature', 'player'] }],
      },
    },
  },
  {
    oracle_text: 'Destroy target creature. (instant)',
    script: {
      schema_version: 2,
      spell_effect: { actions: [{ type: 'destroy', target_type: 'creature' }] },
    },
  },
  {
    oracle_text: "Return target creature to its owner's hand. (instant)",
    script: {
      schema_version: 2,
      spell_effect: { actions: [{ type: 'bounce', target_type: 'creature' }] },
    },
  },
  {
    oracle_text: 'Draw two cards. (sorcery)',
    script: {
      schema_version: 2,
      spell_effect: { actions: [{ type: 'draw', amount: 2 }] },
    },
  },
  {
    oracle_text: 'When CARDNAME enters the battlefield, destroy target creature an opponent controls.',
    script: {
      schema_version: 2,
      triggered_abilities: [
        {
          event: 'enters_the_battlefield',
          effects: [{ type: 'destroy', target_type: 'creature', target_controller: 'opponent' }],
        },
      ],
    },
  },
  {
    oracle_text: 'Exile target creature. (instant)',
    script: {
      schema_version: 2,
      spell_effect: { actions: [{ type: 'exile', target_type: 'creature' }] },
    },
  },
  {
    oracle_text: 'Scry 2. (instant)',
    script: {
      schema_version: 2,
      spell_effect: { actions: [{ type: 'scry', amount: 2 }] },
    },
  },
  {
    oracle_text: 'Surveil 1. (instant)',
    script: {
      schema_version: 2,
      spell_effect: { actions: [{ type: 'surveil', amount: 1 }] },
    },
  },
  {
    oracle_text: 'When CARDNAME enters the battlefield, each opponent mills three cards.',
    script: {
      schema_version: 2,
      triggered_abilities: [
        {
          event: 'enters_the_battlefield',
          effects: [{ type: 'mill', amount: 3, recipient: 'each_opponent' }],
        },
      ],
    },
  },
  {
    oracle_text: 'Target opponent sacrifices a creature. (instant)',
    script: {
      schema_version: 2,
      spell_effect: { actions: [{ type: 'sacrifice', who: 'opponent', count: 1 }] },
    },
  },
  {
    oracle_text: 'Return target creature card from your graveyard to the battlefield. (sorcery)',
    script: {
      schema_version: 2,
      spell_effect: { actions: [{ type: 'return_from_graveyard', to: 'battlefield', count: 1 }] },
    },
  },
]

export function buildBehaviorAuthoringGuide(): string {
  const keywords = BUILDER_KEYWORDS.map((k) => `"${k}" (${KEYWORD_LABELS[k]})`).join(', ')
  const events = BUILDER_TRIGGER_EVENTS.map((e) => `"${e.value}" (${e.label})`).join(', ')
  const triggerEffects = BUILDER_EFFECT_TYPES.map((e) => `"${e.value}" (${e.label})`).join(', ')
  const recipients = BUILDER_RECIPIENTS.map((r) => `"${r.value}" (${r.label})`).join(', ')
  const damageTargets = BUILDER_DAMAGE_TARGETS.map((t) => `"${t.value}" (${t.label})`).join(', ')

  return `You convert a Magic: The Gathering card's rules text into a behavior script JSON for the LeylineSync engine.

Output ONLY a single JSON object (no markdown fences, no prose). Use \`"schema_version": 2\`. Include only the sections the card needs; omit empty arrays. If the card has no mechanical behavior the engine supports, output \`{}\`.

Top-level flags: if the card says "this spell can't be countered" (or "can't be countered by spells or abilities"), add \`"cant_be_countered": true\` at the top level of the object (alongside schema_version). It applies to any spell type.

If the card says "enters the battlefield with N +1/+1 counters on it" (Walking Ballista, Hangarback Walker — often 0/0 creatures), add \`"enters_with_counters": { "amount": N }\` at the top level (counter_type defaults +1/+1; add "counter_type" for a bag kind). This is a REPLACEMENT applied as it enters, so a 0/0 survives — do NOT model it as an enters_the_battlefield add_counters trigger (that resolves too late, after the 0/0 would already have died).

If the card says "if an effect would put one or more counters on a permanent you control, it puts twice that many" (Doubling Season, Corpsejack Menace), add \`"doubles_counters": true\` at the top level. It's a static replacement: while on the battlefield, every counter PLACED on a permanent its controller controls is doubled (two of them stack to ×4). Removal and player counters (poison/energy) are unaffected. Do NOT model the doubling on each counter source — just flag the doubler.

The engine supports these sections:

1. continuous_effects — static keyword abilities. Each entry: { "type": <keyword>, "affected": "source", "source_zone_required": "battlefield" }.
   Supported keywords: ${keywords}.
   - protection: { "type": "protection", "from": <colour>, "affected": "source", "source_zone_required": "battlefield" } — "Protection from <colour>". A creature with this can't be targeted, damaged, or blocked by sources of that colour (DEBT, minus the equip/enchant case). Colour is one of white, blue, black, red, green; emit one entry per colour for multi-colour protection.
   - infect: { "type": "infect", "affected": "source", "source_zone_required": "battlefield" } — "Infect". This creature's combat damage to PLAYERS is dealt as poison counters (no life loss; 10 poison loses) and to CREATURES as −1/−1 counters. Emit for the "Infect" keyword line.
   - wither: { "type": "wither", "affected": "source", "source_zone_required": "battlefield" } — "Wither". This creature's combat damage to CREATURES is dealt as −1/−1 counters (damage to players is normal). Emit for the "Wither" keyword line.
   - toxic: { "type": "toxic", "amount": N, "affected": "source", "source_zone_required": "battlefield" } — "Toxic N". When this creature deals combat damage to a player, that player also gets N poison counters (in ADDITION to the normal damage). amount = the N in "Toxic N".
   - Auras & Equipment grant an effect to the permanent they are attached to: author the granted effect with "affected": "attached" (instead of "source"). Use type "pump" with "payload": { "power": N, "toughness": N } for a +N/+N bonus, or a keyword type for a granted keyword. An Aura is type_line "Enchantment — Aura" (cast targeting a creature; it enters attached). An Equipment is type_line "Artifact — Equipment" (enters unattached; add a top-level "equip_cost": "{N}" for its equip ability). Example Aura: { "continuous_effects": [ { "type": "pump", "affected": "attached", "payload": { "power": 2, "toughness": 2 } } ] }.

2. triggered_abilities — "when/whenever/at" abilities. Each entry: { "event": <event>, "effects": [ ... ] }.
   Supported events: ${events}.
   Effects here are auto-resolved unless they explicitly target a creature. Supported effect types: ${triggerEffects}.
   DYNAMIC AMOUNT: instead of a fixed "amount": N, gain_life/lose_life/deal_damage/draw/mill/add_counters/add_player_counters may use "amount": { "counters": <kind>, "of": "self" | "you" | "target" } — resolved at apply time to that counter count. "of":"self" (default) counts that kind on the SOURCE permanent (e.g. { "counters": "plus_one_one", "of": "self" } for "equal to the number of +1/+1 counters on ~"); "of":"you" counts the controller's player counters (e.g. { "counters": "experience", "of": "you" } — also energy/poison); "of":"target" counts them on the targeted creature (e.g. "deal damage to target creature equal to the number of +1/+1 counters on it"). Works in triggered abilities, activated abilities, and targeted creature spell effects. (A SPELL's "of":"self" is empty — a spell has no counters; use "you"/"target". The untargeted multi-action spell program supports "of":"you".)
   - gain_life: { "type": "gain_life", "amount": N, "recipient"?: <recipient> } — default is the controller; use "each_player"/"all_players" when every player gains life.
   - draw:      { "type": "draw", "amount": N } — the controller draws N.
   - lose_life / deal_damage: { "type": ..., "amount": N, "recipient": <recipient> }.
      Recipients: ${recipients}. Default recipient is "each_opponent". "deal damage to each opponent" and "each opponent loses N life" are both modeled here; use "each_player"/"all_players" when every player loses life.
   - create_token: { "type": "create_token", "token": <token name>, "count": N } — the controller creates N tokens. Allowed token names: ${BUILDER_TOKEN_NAMES.join(', ')}. Pick the closest match by creature type; if none matches, omit this effect.
   - add_counters: { "type": "add_counters", "amount": N } — put N +1/+1 counters on this permanent (the source). Use only for "put a +1/+1 counter on it/CARDNAME". For a non-+1/+1 counter add "counter_type": "minus_one_one" | "charge" | "quest" | "generic" (omit it, or use "plus_one_one", for +1/+1). "minus_one_one" is a −1/−1 counter — it LOWERS power/toughness (a creature dropped to 0 toughness dies), and +1/+1 and −1/−1 counters on the same creature annihilate in pairs. Use it for "put a −1/−1 counter on target creature". Other bag counters (charge/quest/…) have NO P/T effect — they only exist to be referenced/proliferated. REMOVAL: a NEGATIVE amount removes counters ("remove a +1/+1 counter" → "amount": -1), or "all": true removes every counter of that kind (Hex Parasite / "remove all +1/+1 counters"). Removing +1/+1 counters can be lethal (toughness drops).
   - add_counters_all: { "type": "add_counters_all", "amount": N, "target_controller": "you" } — put N +1/+1 counters on each creature the controller controls. Also takes "counter_type"; negative amount / "all": true removes.
   - add_player_counters: { "type": "add_player_counters", "amount": N, "counter_type": "poison", "recipient": "each_opponent" } — put N player counters on players. counter_type ∈ poison | energy | experience; recipient defaults each_opponent (poison/infect lands on opponents). A player with 10+ poison counters loses the game. Use for "target player gets a poison counter" / proliferate-poison decks. Negative amount / "all": true removes (e.g. leeches removing poison). For COMBAT poison/−1/−1, use the infect/wither/toxic continuous_effects keywords instead (this effect is for non-combat "target player gets a poison counter").
   - proliferate: { "type": "proliferate" } — the controller chooses any number of permanents OR players that already have a counter; each chosen one gets +1 of every counter kind it has (+1/+1 AND bag counters AND player poison/energy/…). Use for "proliferate" (Atraxa end-step, Karn's Bastion).
   - tap_all / untap_all: { "type": "tap_all" | "untap_all", "target_controller": "you" } — tap/untap each creature the controller controls.
   - mill: { "type": "mill", "amount": N, "recipient": "controller" | "each_opponent" | "each_player" | "all_players" } — a player puts the top N cards of their library into their graveyard. Default recipient is "controller" ("mill N cards" = you); use "each_opponent" for "each opponent mills N".
   - search_library (tutor): { "type": "search_library", "count": N, "to": "hand" | "battlefield" | "top" | "graveyard", "tapped": true, "reveal": true, "filter": { "type_line": "creature", "name": "..." } } — search YOUR library for up to N cards, put them to the destination (default "hand"), then shuffle. The controller chooses at resolution. Optional: "to":"graveyard" (Entomb/Buried Alive); "tapped":true makes a permanent enter tapped (Rampant Growth/fetchlands — only with "to":"battlefield"); "reveal":true records the found cards; "filter.name" matches by card name (alongside or instead of type_line). Omit "filter" to search for ANY card.
   - discard: { "type": "discard", "count": N, "who": "you" | "opponent", "random": true } — a player discards N cards. "who" is "you" (controller, default) or "opponent" (Mind Rot: target opponent discards). "random": true discards at random (Hymn-style); omit it for the discarding player to choose. (For "target player mills N", use choose_player wrapping a mill instead.)
   - may: { "type": "may", "prompt": "Do X?", "effects": [ ... ] } — an optional "you may": the controller is asked yes/no; on yes the inner effects run. Use for "you may" abilities. Inner effects should be simple (no nested scry/search/discard).
   - choose_player: { "type": "choose_player", "filter": "opponent" | "any", "effects": [ ... ] } — the controller chooses a player, then the inner effects apply to that player. Use for "target player of your choice" / "an opponent you choose". Inner effects should be simple player-directed effects (lose_life / gain_life / draw / mill), e.g. [{ "type": "lose_life", "amount": 3 }].
   - sacrifice: { "type": "sacrifice", "who": "you" | "opponent" | "each_opponent", "count": N, "filter": { "type_line": "creature" } } — a player sacrifices N permanents they control. "who" is "you" (default — "sacrifice a creature"), "opponent" for a single-opponent edict (Diabolic Edict), or "each_opponent" for "each opponent sacrifices a creature" (every opponent, each choosing their own in turn). The sacrificing player chooses at resolution. Default filter is creatures; set "filter": { "type_line": "artifact" } etc. for other permanents.
   - return_from_graveyard: { "type": "return_from_graveyard", "to": "hand" | "battlefield", "count": N, "filter": { "type_line": "creature" } } — return up to N cards from YOUR graveyard to "hand" (Raise Dead) or "battlefield" (Reanimate / Zombify — fires ETB triggers). Default destination "hand", default filter creatures. The controller chooses at resolution.
   - set_pt: { "type": "set_pt", "power": P, "toughness": T, "target_type": "creature", "target_controller": "any" } — a target creature's BASE power/toughness become P/T until end of turn ("becomes a 0/1", Turn to Frog / Ovinize). +1/+1 counters and pumps still apply on top (so a creature with a +1/+1 counter that becomes 0/1 is 1/2). Use for "becomes" / "base power and toughness are" effects. target_type must be "creature".
   - prevent_damage: { "type": "prevent_damage", "amount": N, "combat_only"?: true } — prevent the next N damage that would be dealt to YOU (the controller) this turn (omit "amount" to prevent ALL damage, Fog-style). "combat_only": true restricts it to combat damage. This is a replacement effect — it consumes damage before it reaches your life (it does NOT prevent life LOSS). Use for "Prevent the next 3 damage that would be dealt to you this turn." Shielding an opponent or a chosen player is not supported yet.
   - grant_keyword: { "type": "grant_keyword", "keyword": "flying", "target_type": "creature", "target_controller": "you" } — a target creature gains the keyword until end of turn. Allowed keywords: flying, reach, trample, vigilance, haste, first_strike, double_strike, deathtouch, indestructible. Valid as a triggered ability or as an instant/sorcery combat trick. target_type must be exactly "creature".
   - gain_control: { "type": "gain_control", "duration": "permanent" | "end_of_turn", "target_type": "creature", "target_controller": "opponent" } — the ability's controller/caster gains control of a target creature. duration "permanent" (Mind Control) or "end_of_turn" (Threaten). Use "target_controller": "opponent" for "you don't control". Valid as a triggered ability or as an instant/sorcery (Act of Treason). Add "untap": true and/or "haste": true for the "threaten" combat extras (untap the creature and give it haste so it can attack the turn you take it). target_type must be exactly "creature".
   - Targeted creature triggers may use deal_damage, destroy, exile, bounce, tap, untap, add_counters, grant_keyword, fight, or gain_control with "target_type": "creature". For these the target_type must be exactly "creature" (not "any") — a trigger that deals damage to "any target" is auto-resolved against each opponent instead of singling out a creature. For a fight trigger ("when this enters, it fights target creature"), the SOURCE creature is the fighter and target_type/target_controller describe the fought creature.
   - NON-CREATURE PERMANENT triggers: destroy/exile/bounce/tap/untap may also target a non-creature permanent via "target_type" — "artifact", "enchantment", "land", "planeswalker", or "permanent" (any). E.g. "when this enters, destroy target artifact" = { "type": "destroy", "target_type": "artifact" }. (Spells support this too, mig 113.)
   - MULTI-TARGET triggers: destroy/exile/bounce/tap/untap may add "targets": N to hit up to N targets — "when this enters, destroy up to two target creatures" = { "type": "destroy", "target_type": "creature", "target_controller": "opponent", "targets": 2 }.
   - Controller restriction (triggers and spells): add "target_controller": "opponent" for "a creature an opponent controls", or "target_controller": "you" for "a creature you control". Omit it when there is no restriction.

3. activated_abilities — "{cost}: effect" abilities. Each entry: { "costs": [ ... ], "effects": [ ... ], "is_mana_ability"?: true }.
   Costs: { "type": "tap_self" } for {T}; { "type": "mana", "amount": "{2}{R}" } for a mana cost string; { "type": "energy", "amount": N } to spend N energy counters ({E}{E} = amount 2). Combine multiple cost entries for "{T}, Pay two energy: …".
   The ability has ONE effect. Supported: deal_damage ({ "type": "deal_damage", "amount": N, "target_type": <target> }), the creature-target effects destroy/exile/bounce/tap/untap/add_counters/pump/grant_keyword/gain_control (with "target_type": "creature", e.g. "{T}: Destroy target creature" = { "type": "destroy", "target_type": "creature" }), and untargeted draw ({ "type": "draw", "amount": N }, e.g. "{2}: Draw a card"). For a MANA ability use add_mana — { "type": "add_mana", "color": "W|U|B|R|G|C", "amount": N } with "is_mana_ability": true. For "any color in your commander's color identity" (Command Tower, Arcane Signet), use "color": "commander" — the player picks an identity colour at tap time. Do NOT put decision effects (scry/search/sacrifice/may/choose_player) in an activated ability.
   deal_damage target_type values: ${damageTargets}. "any target" -> ["creature","player"].

4. spell_effect — for Instants and Sorceries (the effect when the spell resolves): { "actions": [ ... ] }.
   Actions:
   - deal_damage { "type": "deal_damage", "amount": N, "target_type": ... } — "any target" -> ["creature","player"]. Add "divided": true for "deal N damage divided as you choose among any number of target creatures and/or players" (Forked Bolt): { "type": "deal_damage", "amount": 2, "divided": true, "target_type": ["creature","player"] }. The caster allocates N across targets at cast.
   - pump      { "type": "pump", "power": N, "toughness": N, "target_type": "creature" } — until end of turn.
   - destroy   { "type": "destroy", "target_type": "creature" } — "destroy target creature" (to its owner's graveyard).
   - exile     { "type": "exile", "target_type": "creature" } — "exile target creature" (to its owner's exile zone).
    - bounce    { "type": "bounce", "target_type": "creature" } — "return target creature to its owner's hand".
    - tap       { "type": "tap", "target_type": "creature" } / untap { "type": "untap", "target_type": "creature" }.
    - MULTI-TARGET (spell only): destroy/exile/bounce/tap/untap accept "targets": N to hit up to N creatures — "destroy up to N target creatures", Cone of Cold (tap), etc. The same removal is applied in full to each chosen creature. Add "targets": 2 to the action, e.g. { "type": "destroy", "target_type": "creature", "targets": 2 }. Omit "targets" (or 1) for a single target.
    - NONLAND PERMANENT: "target_type": "nonland_permanent" matches any permanent except a land (creatures, artifacts, enchantments, planeswalkers). Use for "exile target nonland permanent" (Anguished Unmaking), "destroy target nonland permanent", etc.
    - SELF-RIDER ("…and you lose 3 life" / "…and you draw a card"): a SINGLE-target destroy/exile/bounce/tap/untap may add "then": [ ... ] — simple effects applied to the CASTER on resolution. Allowed riders: { "type": "lose_life" | "gain_life" | "draw", "amount": N }. E.g. Anguished Unmaking = { "type": "exile", "target_type": "nonland_permanent", "then": [{ "type": "lose_life", "amount": 3 }] }. Do not combine "then" with "targets" > 1.
    - AFFECTED-CONTROLLER RAMP (Assassin's Trophy): add "controller_searches_basic_land": true so the destroyed/affected permanent's CONTROLLER may search their library for a basic land, put it onto the battlefield, then shuffle. E.g. Assassin's Trophy = { "type": "destroy", "target_type": "permanent", "target_controller": "opponent", "controller_searches_basic_land": true }.
    - add_counters { "type": "add_counters", "amount": N, "target_type": "creature" } — put N +1/+1 counters on target creature.
    - fight     { "type": "fight", "target_type": "creature", "target_controller": "opponent" } — "target creature you control fights target creature ...". The fighter is implicit (a creature you control as a spell, or the SOURCE creature as a trigger); target_type/target_controller describe the FOUGHT creature (use "opponent" for "you don't control", omit target_controller for "another target creature"). Each deals damage equal to its power to the other.
    - draw      { "type": "draw", "amount": N } — the caster draws N (untargeted).
    - scry      { "type": "scry", "amount": N } — "Scry N": the caster looks at the top N cards of their library and may put any number on the bottom (untargeted).
    - surveil   { "type": "surveil", "amount": N } — "Surveil N": the caster looks at the top N cards of their library and may put any number into their graveyard (untargeted).
    - counter   { "type": "counter", "target_type": "spell" }; add_mana { "type": "add_mana", "color": ..., "amount": N }.
     - mill      { "type": "mill", "amount": N, "recipient": "each_opponent" | "controller" | "each_player" | "all_players" } — top N of a library to its graveyard.
     - add_counters_all { "type": "add_counters_all", "amount": N, "target_controller": "you" } — put N +1/+1 counters on each creature the caster controls.
     - tap_all / untap_all { "type": "tap_all" | "untap_all", "target_controller": "you" } — tap/untap each creature the caster controls.
    - search_library { "type": "search_library", "count": N, "to": "hand" | "battlefield" | "top" | "graveyard", "tapped": true, "reveal": true, "filter": { "type_line": "...", "name": "..." } } — tutor; omit "filter" to search for ANY card (Demonic Tutor = count 1, to "hand", no filter). "to":"graveyard" = Entomb; "tapped":true = enters tapped (with "to":"battlefield"); "filter.name" = search for a card by name.
    - discard   { "type": "discard", "count": N, "who": "you" | "opponent", "random": true } — a player discards N. "who": "opponent" = Mind Rot (target opponent discards); "random": true = at random. Default: the controller chooses.
    - sacrifice { "type": "sacrifice", "who": "you" | "opponent" | "each_opponent", "count": N } — a player sacrifices N creatures they control. "opponent" = an edict (one opponent); "each_opponent" = every opponent sacrifices (each chooses their own, in turn). Same shape as the triggered-ability note above.
    - return_from_graveyard { "type": "return_from_graveyard", "to": "hand" | "battlefield", "count": N } — return up to N cards from your graveyard (Raise Dead / Reanimate). Same shape as above.
    - may / choose_player — same shapes as in the triggered-ability notes above; valid as spell actions too.
    Variable X: for a spell with {X} in its cost (Fireball, Mind Spring), write the scaling "amount" as the string "X" instead of a number — e.g. deal_damage { "amount": "X", "target_type": ["creature","player"] } or draw { "amount": "X" }. The caster picks X at cast and pays it as {X} generic mana. Only "amount" (deal_damage/draw/gain_life/lose_life/mill/add_counters) supports "X".
    NON-CREATURE PERMANENTS (spell or trigger): destroy/exile/bounce/tap/untap can target any permanent type via "target_type" — "artifact" (Disenchant: { "type": "destroy", "target_type": "artifact" }), "enchantment" (Naturalize: target_type ["artifact","enchantment"]), "land", "planeswalker", or "permanent" (Beast Within / Vindicate: { "type": "destroy", "target_type": "permanent" } hits anything). Default target_type is "creature". add_counters/pump/fight/grant_keyword/gain_control remain creature-only.
   MODAL spells ("choose one —" / Charms): use "spell_effect": { "modes": [ { "label": "...", "actions": [ ... ] }, ... ], "choose": 1 } INSTEAD of "actions". The caster picks "choose" of the modes at cast (default 1). Each mode's "actions" are a small list of SIMPLE effects — gain_life / lose_life / draw / mill / deal_damage / and creature-target destroy/exile/bounce/tap/untap/add_counters/pump with "target_type": "creature". Do NOT put decision effects (scry/surveil/search_library/discard/may/choose_player/sacrifice) in a mode — they will not resolve. A mode may target ONE creature; all targeted actions in a chosen mode hit that one creature. Example (a Charm): { "spell_effect": { "modes": [ { "label": "Draw a card", "actions": [{ "type": "draw", "amount": 1 }] }, { "label": "Destroy target creature", "actions": [{ "type": "destroy", "target_type": "creature" }] }, { "label": "Gain 3 life", "actions": [{ "type": "gain_life", "amount": 3 }] } ], "choose": 1 } }.

Rules:
- Only emit behavior the lists above support. If part of the card isn't expressible (targeted exile, non-creature trigger targets, conditional effects, etc.), omit that part rather than inventing a field.
- Prefer continuous_effects for plain keyword lines, triggered_abilities for when/whenever/at, activated_abilities for "{cost}:" lines, spell_effect for instant/sorcery resolution.
- Use the card's printed numbers.

Examples (oracle text -> script):
${EXAMPLES.map((e) => `${e.oracle_text}\n${JSON.stringify(e.script)}`).join('\n\n')}`
}
