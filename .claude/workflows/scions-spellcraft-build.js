export const meta = {
  name: 'scions-spellcraft-build',
  description: 'Author + adversarially verify card-scripts.json entries for the 71 needs-building Scions Spellcraft cards',
  whenToUse: 'Bulk-script a triaged commander deck: one card per pipeline item, author then verify against the real engine vocabulary.',
  phases: [
    { title: 'Author', detail: 'one agent per card: produce a V2 script or classify as needing an engine feature' },
    { title: 'Verify', detail: 'adversarial check: every effect/event must be runtime-supported, not just schema-valid' },
  ],
}

// Authoritative engine vocabulary — embedded so agents never read the 26k-token
// schema and never guess. Derived from lib/game/card-behavior-schema.ts +
// supabase/functions_src (verified this session).
const ACTION_TYPES = [
  'add_mana','deal_damage','counter','gain_life','lose_life','draw','create_token','add_counters','destroy','exile','bounce','tap','untap',
  'pump','pump_all','mill','scry','surveil','search_library','discard','may','choose_player','choose_creature_type','add_counters_all','tap_all','untap_all',
  'grant_keyword','fight','gain_control','sacrifice','return_from_graveyard','prevent_damage','set_pt','add_player_counters','proliferate','grant_cast_from_graveyard',
  'amass','destroy_all','return_all_from_graveyard','exile_from_graveyard','conditional','grant_keyword_all','mass_destroy_reanimate_one','choose_color','reanimate_from_graveyard',
  'look_top','deal_damage_all','impulse','choose_one','monstrosity','damage_each_opponent_by_hand','divide_damage','return_self_to_hand','copy_permanent','become_copy',
  'shuffle_into_library','bounce_up_to','exile_until_nonland','put_from_hand','destroy_up_to','play_hideaway','goad','extra_combat','exile_and_manifest','discover',
  'exile_from_any_graveyard','exile_tops_cast','exile_until_leaves','become_monarch','equip','living_weapon','gain_control_all','bounce_all','destroy_all_creatures_token',
  'destroy_all_mv','add_poison','exile_graveyard','exile_all','graveyard_to_library_top','animate','shuffle_self_into_library','vote_wild_free',
]
const COST_TYPES = ['tap_self','untap_self','mana','pay_life','sacrifice_self','sacrifice_creature','discard','exile_self','exile_from_graveyard','energy','tap_creatures','sacrifice_artifacts','return_land','remove_counters']

// The ONLY triggered-ability events the engine actually fires at runtime. An
// event/filter outside this list is a SILENT NO-OP even though it passes schema.
const TRIGGER_FACTS = `
Runtime-supported triggered_ability events ONLY:
  - spell_cast  — fires when a player casts a spell. filter.controller: 'you'|'opponent'|'any' (default 'you'). filter.type_line is a POSITIVE substring match on the spell's type ("Instant","Sorcery","Dragon",...). NO negative/exclude filter exists.
  - creature_entered / creature_died / land_entered / ability_activated — permanent watchers (filter: type_line, controller, nontoken, token, min_power, max_power, has_keyword:'flying', exclude_self, goaded).
  - dies / attacks / fire_etb (enters-the-battlefield) / end_step / upkeep / draw_step — self/turn events.
HARD LIMITS (=> status 'needs_engine', do NOT fake with a passing-but-dead script):
  - "whenever you cast a NONCREATURE spell" — UNSUPPORTED (no noncreature/exclude-type filter on spell_cast). This is the deck's core theme; flag missing_feature "spell_cast noncreature/exclude-type filter".
  - magecraft "cast OR COPY" — only the cast half could fire; copy is unsupported.
  - Sagas (lore counters/chapters), Adventure halves, Partner, "Job select" (ETB token + auto-attach to it), Convoke, Delve, Rebound, Kicker that changes the spell, second-spell-each-turn cost reduction (Dualcast), prowess as a static, conditional double strike, graveyard-cast cost discounts, "no maximum hand size", goad-via-Aura, "until X leaves" Auras — all UNSUPPORTED today.`

const CHEAT = `Card scripts are JSON, schema_version 2, keyed by EXACT card name in docs/commander-decks/card-scripts.json.
Top-level keys you may use: schema_version(=2), keywords[], continuous_effects[], activated_abilities[], triggered_abilities[], spell_effect, enters_tapped(true | {unless:{count|hand_has_type|control_type ...}}), flashback(string), flashback_life, kicker, cost_reduction({amount, if?}), cant_be_countered(true), equip_cost, cda, loyalty/loyalty_abilities, enters_with_counters.
Mana ability: {is_mana_ability:true, costs:[{type:'tap_self'}], effects:[{type:'add_mana', color:'W'|'U'|'B'|'R'|'G'|'C'|'commander'|'any', amount:1}]}. One ability per producible color (a "{T}: add W or U" land = TWO mana abilities).
Effect action types (the ONLY runtime-supported ones): ${ACTION_TYPES.join(', ')}.
Cost types: ${COST_TYPES.join(', ')}.
spell_effect = {targets?:[{id,type,controller?}], actions?:[...], modes?:[{label,actions}], choose?:n}. Modal "choose one" uses modes. Untargeted board wipes: destroy_all / destroy_all_mv / exile_all / bounce_all / deal_damage_all.
Targeted removal spell example: {"schema_version":2,"spell_effect":{"actions":[{"type":"destroy","target_type":"permanent"}]}}.
Recipients for untargeted player effects: 'controller','each_opponent','each_player','all_players'. Dynamic amounts: 'X', {count:'...'}, {counters,of}, {power_of}, {toughness_of:'triggering_creature'}.
${TRIGGER_FACTS}
Lands enter with their own mana abilities; "enters tapped" => enters_tapped. Filter/checklands use enters_tapped.unless.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['card', 'status', 'notes'],
  properties: {
    card: { type: 'string', description: 'EXACT card name as the card-scripts.json key' },
    status: { type: 'string', enum: ['scriptable', 'partial', 'needs_engine'] },
    script: {
      type: ['object', 'null'],
      additionalProperties: true,
      description: 'The schema_version-2 script object (the VALUE for the card-scripts.json key). null when status=needs_engine.',
    },
    approximations: { type: 'string', description: 'What the script omits/approximates (empty if none).' },
    missing_features: { type: 'array', items: { type: 'string' }, description: 'Engine features required before this card works (for partial/needs_engine).' },
    notes: { type: 'string', description: 'One-line rationale.' },
  },
}

let cards = args
if (typeof cards === 'string') { try { cards = JSON.parse(cards) } catch { cards = cards.split('\n').map((s) => s.trim()).filter(Boolean) } }
cards = Array.isArray(cards) ? cards : []
if (cards.length === 0) { log('No cards passed via args — nothing to do.'); return [] }
log(`Building scripts for ${cards.length} cards (author → verify).`)

const results = await pipeline(
  cards,
  // Stage 1 — AUTHOR
  (name) => agent(
    `You are scripting one Magic card for the LeylineSync engine.

CARD: "${name}"
Read its oracle text from the "### ${name}" section of docs/commander-decks/next-deck.triage.md (use Grep/Read; read only that section).

Your job: produce a schema_version-2 script that reproduces as much of the card as the engine TRULY supports, OR classify it as needing engine work. Be ruthless: a script that passes schema validation but uses an event/effect the engine does not fire at runtime is WORSE than honest — it looks done but does nothing. When in doubt, downgrade to 'partial' (script the supported parts, list the rest in missing_features) or 'needs_engine'.

${CHEAT}

Decide status:
  - 'scriptable' — the script fully (or near-fully) reproduces the card with supported vocabulary.
  - 'partial' — you can script some of it; list what's omitted in approximations + missing_features.
  - 'needs_engine' — the card's essential function needs an unsupported feature; script:null, list missing_features.
Set card to the exact catalog name (for Adventure cards that is just the creature name, no "//"). Return ONLY the structured object.`,
    { schema: SCHEMA, phase: 'Author', label: name },
  ),
  // Stage 2 — VERIFY (adversarial)
  (authored, name) => {
    if (!authored) return null
    return agent(
      `Adversarially verify this proposed card script. Assume it is wrong until proven right.

CARD: "${name}"
PROPOSED: ${JSON.stringify(authored)}

Re-read the "### ${name}" oracle text from docs/commander-decks/next-deck.triage.md.

Check EVERY element of script against the authoritative engine vocabulary below. Reject (and correct) anything that is schema-valid but NOT runtime-supported — especially triggered_ability events/filters. The single most common error for THIS deck: scripting "whenever you cast a noncreature spell" as a spell_cast trigger — that is a SILENT NO-OP and must be status 'needs_engine' (or 'partial' if other parts work).

${CHEAT}

Verdict rules:
  - If the proposed script is correct and fully supported: keep status, return it as-is.
  - If parts are unsupported: strip them from script, move them to missing_features, set status 'partial' (or 'needs_engine' if nothing meaningful remains, script:null).
  - Fix any malformed JSON, wrong mana-ability split, wrong color codes, wrong action-type names, or wrong keys.
Return the FINAL authoritative structured object (same schema). card must stay the exact name.`,
      { schema: SCHEMA, phase: 'Verify', label: name },
    )
  },
)

const clean = results.filter(Boolean)
const scriptable = clean.filter((r) => r.script && (r.status === 'scriptable' || r.status === 'partial'))
const needsEngine = clean.filter((r) => !r.script || r.status === 'needs_engine')
log(`Done: ${scriptable.length} scriptable/partial, ${needsEngine.length} need engine work.`)

// Aggregate the missing engine features so the synthesis step can report a backlog.
const featureCounts = {}
for (const r of clean) for (const f of (r.missing_features || [])) featureCounts[f] = (featureCounts[f] || 0) + 1

return { scriptable, needsEngine, featureCounts, total: clean.length }
