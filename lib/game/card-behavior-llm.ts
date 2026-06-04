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
]

export function buildBehaviorAuthoringGuide(): string {
  const keywords = BUILDER_KEYWORDS.map((k) => `"${k}" (${KEYWORD_LABELS[k]})`).join(', ')
  const events = BUILDER_TRIGGER_EVENTS.map((e) => `"${e.value}" (${e.label})`).join(', ')
  const triggerEffects = BUILDER_EFFECT_TYPES.map((e) => `"${e.value}" (${e.label})`).join(', ')
  const recipients = BUILDER_RECIPIENTS.map((r) => `"${r.value}" (${r.label})`).join(', ')
  const damageTargets = BUILDER_DAMAGE_TARGETS.map((t) => `"${t.value}" (${t.label})`).join(', ')

  return `You convert a Magic: The Gathering card's rules text into a behavior script JSON for the LeylineSync engine.

Output ONLY a single JSON object (no markdown fences, no prose). Use \`"schema_version": 2\`. Include only the sections the card needs; omit empty arrays. If the card has no mechanical behavior the engine supports, output \`{}\`.

The engine supports these sections:

1. continuous_effects — static keyword abilities. Each entry: { "type": <keyword>, "affected": "source", "source_zone_required": "battlefield" }.
   Supported keywords: ${keywords}.

2. triggered_abilities — "when/whenever/at" abilities. Each entry: { "event": <event>, "effects": [ ... ] }.
   Supported events: ${events}.
   Effects here are auto-resolved unless they explicitly target a creature. Supported effect types: ${triggerEffects}.
   - gain_life: { "type": "gain_life", "amount": N } — the controller gains N.
   - draw:      { "type": "draw", "amount": N } — the controller draws N.
   - lose_life / deal_damage: { "type": ..., "amount": N, "recipient": <recipient> }.
     Recipients: ${recipients}. Default recipient is "each_opponent". "deal damage to each opponent" and "each opponent loses N life" are both modeled here.
   - create_token: { "type": "create_token", "token": <token name>, "count": N } — the controller creates N tokens. Allowed token names: ${BUILDER_TOKEN_NAMES.join(', ')}. Pick the closest match by creature type; if none matches, omit this effect.
   - add_counters: { "type": "add_counters", "amount": N } — put N +1/+1 counters on this permanent (the source). Use only for "put a +1/+1 counter on it/CARDNAME".
   - mill: { "type": "mill", "amount": N, "recipient": "controller" | "each_opponent" } — a player puts the top N cards of their library into their graveyard. Default recipient is "controller" ("mill N cards" = you); use "each_opponent" for "each opponent mills N".
   - search_library (tutor): { "type": "search_library", "count": N, "to": "hand" | "battlefield" | "top", "filter": { "type_line": "creature" } } — search YOUR library for up to N cards (optional type_line filter), put them to the destination (default "hand"), then shuffle. The controller chooses at resolution.
   - discard: { "type": "discard", "count": N } — the controller chooses N cards in their hand to discard.
   - may: { "type": "may", "prompt": "Do X?", "effects": [ ... ] } — an optional "you may": the controller is asked yes/no; on yes the inner effects run. Use for "you may" abilities. Inner effects should be simple (no nested scry/search/discard).
   - choose_player: { "type": "choose_player", "filter": "opponent" | "any", "effects": [ ... ] } — the controller chooses a player, then the inner effects apply to that player. Use for "target player of your choice" / "an opponent you choose". Inner effects should be simple player-directed effects (lose_life / gain_life / draw / mill), e.g. [{ "type": "lose_life", "amount": 3 }].
   - Targeted creature triggers may use deal_damage, destroy, exile, bounce, tap, untap, or add_counters with "target_type": "creature". The target_type must be exactly "creature" (not "any") — a trigger that deals damage to "any target" is auto-resolved against each opponent instead of singling out a creature.
   - Controller restriction (triggers and spells): add "target_controller": "opponent" for "a creature an opponent controls", or "target_controller": "you" for "a creature you control". Omit it when there is no restriction.

3. activated_abilities — "{cost}: effect" abilities. Each entry: { "costs": [ ... ], "effects": [ ... ], "is_mana_ability"?: true }.
   Costs: { "type": "tap_self" } for {T}; { "type": "mana", "amount": "{2}{R}" } for a mana cost string.
   Effects: deal_damage with a chosen target — { "type": "deal_damage", "amount": N, "target_type": <target> }; or, for mana abilities only, add_mana — { "type": "add_mana", "color": "W|U|B|R|G|C", "amount": N } with "is_mana_ability": true.
   deal_damage target_type values: ${damageTargets}. "any target" -> ["creature","player"].

4. spell_effect — for Instants and Sorceries (the effect when the spell resolves): { "actions": [ ... ] }.
   Actions:
   - deal_damage { "type": "deal_damage", "amount": N, "target_type": ... } — "any target" -> ["creature","player"].
   - pump      { "type": "pump", "power": N, "toughness": N, "target_type": "creature" } — until end of turn.
   - destroy   { "type": "destroy", "target_type": "creature" } — "destroy target creature" (to its owner's graveyard).
   - exile     { "type": "exile", "target_type": "creature" } — "exile target creature" (to its owner's exile zone).
    - bounce    { "type": "bounce", "target_type": "creature" } — "return target creature to its owner's hand".
    - tap       { "type": "tap", "target_type": "creature" } / untap { "type": "untap", "target_type": "creature" }.
    - add_counters { "type": "add_counters", "amount": N, "target_type": "creature" } — put N +1/+1 counters on target creature.
    - draw      { "type": "draw", "amount": N } — the caster draws N (untargeted).
    - scry      { "type": "scry", "amount": N } — "Scry N": the caster looks at the top N cards of their library and may put any number on the bottom (untargeted).
    - surveil   { "type": "surveil", "amount": N } — "Surveil N": the caster looks at the top N cards of their library and may put any number into their graveyard (untargeted).
    - counter   { "type": "counter", "target_type": "spell" }; add_mana { "type": "add_mana", "color": ..., "amount": N }.
    - mill      { "type": "mill", "amount": N, "recipient": "each_opponent" | "controller" } — top N of a library to its graveyard.
    - search_library { "type": "search_library", "count": N, "to": "hand" | "battlefield" | "top", "filter": { "type_line": "..." } } — tutor; omit "filter" to search for ANY card (Demonic Tutor = count 1, to "hand", no filter).
    - discard   { "type": "discard", "count": N } — the controller discards N.
    - may / choose_player — same shapes as in the triggered-ability notes above; valid as spell actions too.
    Targeted creature effects (destroy/exile/bounce/tap/untap/add_counters) only target creatures right now — if the card targets a non-creature permanent, omit that action.

Rules:
- Only emit behavior the lists above support. If part of the card isn't expressible (targeted exile, non-creature trigger targets, conditional effects, etc.), omit that part rather than inventing a field.
- Prefer continuous_effects for plain keyword lines, triggered_abilities for when/whenever/at, activated_abilities for "{cost}:" lines, spell_effect for instant/sorcery resolution.
- Use the card's printed numbers.

Examples (oracle text -> script):
${EXAMPLES.map((e) => `${e.oracle_text}\n${JSON.stringify(e.script)}`).join('\n\n')}`
}
