'use client'

import {
  BUILDER_ABILITY_KINDS,
  BUILDER_KEYWORDS,
  BUILDER_MANA_COLORS,
  BUILDER_SPELL_EFFECT_TYPES,
  BUILDER_TRIGGER_EVENTS,
  KEYWORD_LABELS,
  BUILDER_STATIC_SCOPES,
  BUILDER_TRIGGER_CONTROLLERS,
  isWatcherEvent,
  type BuilderTriggerController,
  defaultActivatedAbility,
  defaultEffect,
  defaultKeywordGrant,
  defaultSpellEffect,
  defaultStaticBuff,
  defaultTrigger,
  type BuilderActivatedAbility,
  type BuilderEffect,
  type BuilderForm,
  type BuilderKeyword,
  type BuilderKeywordGrant,
  type BuilderSpellEffect,
  type BuilderSpellEffectType,
  type BuilderStaticBuff,
  type BuilderTrigger,
  type BuilderTriggerEvent,
} from '@/lib/game/card-behavior-builder'
import {
  effectDefault,
  effectKeyOf,
  effectsForContext,
  resolveEffectDef,
  type EffectContext,
  type FieldDescriptor,
} from '@/lib/game/card-behavior-registry'
import type { ManaColor } from '@/lib/game/types'

// A flat registry effect ({ type, ...fields }) — the shape both trigger effects
// and spell actions share, rendered generically by EffectFields.
type FlatEffect = Record<string, unknown> & { type: string }

const inputClass =
  'rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-white disabled:opacity-50'

export default function CardBehaviorForm({
  value,
  onChange,
  disabled = false,
}: {
  value: BuilderForm
  onChange: (next: BuilderForm) => void
  disabled?: boolean
}) {
  const toggleKeyword = (keyword: BuilderKeyword) => {
    const has = value.keywords.includes(keyword)
    onChange({
      ...value,
      keywords: has
        ? value.keywords.filter((k) => k !== keyword)
        : [...value.keywords, keyword],
    })
  }

  const updateStaticBuff = (index: number, next: BuilderStaticBuff) => {
    onChange({ ...value, staticBuffs: value.staticBuffs.map((b, i) => (i === index ? next : b)) })
  }

  const removeStaticBuff = (index: number) => {
    onChange({ ...value, staticBuffs: value.staticBuffs.filter((_, i) => i !== index) })
  }

  const updateKeywordGrant = (index: number, next: BuilderKeywordGrant) => {
    onChange({ ...value, keywordGrants: value.keywordGrants.map((g, i) => (i === index ? next : g)) })
  }

  const removeKeywordGrant = (index: number) => {
    onChange({ ...value, keywordGrants: value.keywordGrants.filter((_, i) => i !== index) })
  }

  const updateTrigger = (index: number, next: BuilderTrigger) => {
    onChange({ ...value, triggers: value.triggers.map((t, i) => (i === index ? next : t)) })
  }

  const removeTrigger = (index: number) => {
    onChange({ ...value, triggers: value.triggers.filter((_, i) => i !== index) })
  }

  const updateAbility = (index: number, next: BuilderActivatedAbility) => {
    onChange({
      ...value,
      activatedAbilities: value.activatedAbilities.map((a, i) => (i === index ? next : a)),
    })
  }

  const removeAbility = (index: number) => {
    onChange({ ...value, activatedAbilities: value.activatedAbilities.filter((_, i) => i !== index) })
  }

  return (
    <div className="grid gap-5">
      {/* Keywords */}
      <section className="grid gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Keywords</h3>
        <div className="flex flex-wrap gap-2">
          {BUILDER_KEYWORDS.map((keyword) => {
            const active = value.keywords.includes(keyword)
            return (
              <button
                key={keyword}
                type="button"
                disabled={disabled}
                onClick={() => toggleKeyword(keyword)}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition disabled:opacity-50 ${
                  active
                    ? 'border-fuchsia-400 bg-fuchsia-400/20 text-fuchsia-100'
                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
                }`}
              >
                {KEYWORD_LABELS[keyword]}
              </button>
            )
          })}
        </div>
      </section>

      {/* Static buffs / anthems */}
      <section className="grid gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Static buffs <span className="font-normal normal-case text-slate-500">(anthems / lords)</span>
          </h3>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...value, staticBuffs: [...value.staticBuffs, defaultStaticBuff()] })}
            className="rounded border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-200 disabled:opacity-50"
          >
            + Add static buff
          </button>
        </div>

        {value.staticBuffs.length === 0 ? (
          <p className="text-xs text-slate-500">
            No static buffs. Use these for &quot;[Other] [Type] creatures you control get +P/+T&quot;.
          </p>
        ) : (
          value.staticBuffs.map((buff, index) => (
            <StaticBuffEditor
              key={index}
              buff={buff}
              disabled={disabled}
              onChange={(next) => updateStaticBuff(index, next)}
              onRemove={() => removeStaticBuff(index)}
            />
          ))
        )}
      </section>

      {/* Typed keyword grants */}
      <section className="grid gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Keyword grants <span className="font-normal normal-case text-slate-500">(&quot;Zombies you control have flying&quot;)</span>
          </h3>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...value, keywordGrants: [...value.keywordGrants, defaultKeywordGrant()] })}
            className="rounded border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-200 disabled:opacity-50"
          >
            + Add keyword grant
          </button>
        </div>

        {value.keywordGrants.length === 0 ? (
          <p className="text-xs text-slate-500">
            No keyword grants. Use these for &quot;[Type] creatures you control have &lt;keyword&gt;&quot;.
          </p>
        ) : (
          value.keywordGrants.map((grant, index) => (
            <KeywordGrantEditor
              key={index}
              grant={grant}
              disabled={disabled}
              onChange={(next) => updateKeywordGrant(index, next)}
              onRemove={() => removeKeywordGrant(index)}
            />
          ))
        )}
      </section>

      {/* Triggered abilities */}
      <section className="grid gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Triggered abilities
          </h3>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...value, triggers: [...value.triggers, defaultTrigger()] })}
            className="rounded border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-200 disabled:opacity-50"
          >
            + Add trigger
          </button>
        </div>

        {value.triggers.length === 0 ? (
          <p className="text-xs text-slate-500">No triggered abilities.</p>
        ) : (
          value.triggers.map((trigger, index) => (
            <TriggerEditor
              key={index}
              trigger={trigger}
              disabled={disabled}
              onChange={(next) => updateTrigger(index, next)}
              onRemove={() => removeTrigger(index)}
            />
          ))
        )}
      </section>

      {/* Activated abilities */}
      <section className="grid gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Activated abilities
          </h3>
          <div className="flex gap-1">
            {BUILDER_ABILITY_KINDS.map((kind) => (
              <button
                key={kind.value}
                type="button"
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...value,
                    activatedAbilities: [
                      ...value.activatedAbilities,
                      defaultActivatedAbility(kind.value),
                    ],
                  })
                }
                className="rounded border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-200 disabled:opacity-50"
              >
                + {kind.label}
              </button>
            ))}
          </div>
        </div>

        {value.activatedAbilities.length === 0 ? (
          <p className="text-xs text-slate-500">No activated abilities.</p>
        ) : (
          value.activatedAbilities.map((ability, index) => (
            <ActivatedAbilityEditor
              key={index}
              ability={ability}
              disabled={disabled}
              onChange={(next) => updateAbility(index, next)}
              onRemove={() => removeAbility(index)}
            />
          ))
        )}
      </section>

      {/* Spell effect (instant / sorcery) */}
      <section className="grid gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Spell effect <span className="font-normal normal-case text-slate-500">(instant / sorcery)</span>
          </h3>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...value, spellEffect: [...value.spellEffect, defaultSpellEffect('scry')] })}
            className="rounded border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-200 disabled:opacity-50"
          >
            + Add spell action
          </button>
        </div>

        <SpellActionList
          actions={value.spellEffect}
          disabled={disabled}
          emptyText="No spell effect. Actions resolve in order (e.g. Scry 1, then Draw 1)."
          onChange={(next) => onChange({ ...value, spellEffect: next })}
        />
      </section>

      {/* Flashback (cast the spell effect above from the graveyard, then exile) */}
      <section className="grid gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Flashback <span className="font-normal normal-case text-slate-500">(cast from graveyard, then exile)</span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={value.flashback}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, flashback: event.target.value })}
            placeholder="e.g. {7}{B}{B}{B}"
            className={`${inputClass} flex-1`}
          />
          <label className="flex items-center gap-1.5 text-xs text-slate-300">
            + pay
            <input
              type="number"
              min={0}
              max={99}
              value={value.flashbackLife}
              disabled={disabled}
              title="Additional life payment (e.g. Deep Analysis pays 3 life)"
              onChange={(event) => onChange({ ...value, flashbackLife: Math.max(0, Number(event.target.value)) })}
              className={`${inputClass} w-16`}
            />
            life
          </label>
        </div>
        <p className="text-xs text-slate-500">
          Leave blank for no flashback. The cost re-casts the spell effect above from your graveyard.
          Add a life payment for costs like Deep Analysis ({'{1}{U}'}, pay 3 life).
        </p>
      </section>

      {/* Flashback effect — replaces the spell effect when cast via flashback */}
      <section className="grid gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Flashback effect <span className="font-normal normal-case text-slate-500">(replaces the effect above on flashback)</span>
          </h3>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...value, flashbackEffect: [...value.flashbackEffect, defaultSpellEffect('scry')] })}
            className="rounded border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-200 disabled:opacity-50"
          >
            + Add flashback action
          </button>
        </div>
        <SpellActionList
          actions={value.flashbackEffect}
          disabled={disabled}
          emptyText="Empty = the flashback cast runs the normal spell effect. Add actions for cards that do more/different from the graveyard (e.g. create ten tokens instead of five)."
          onChange={(next) => onChange({ ...value, flashbackEffect: next })}
        />
      </section>
    </div>
  )
}

// A reusable ordered list of untargeted spell actions (a dropdown + the action's
// fields + remove), shared by the Spell effect and Flashback effect sections.
// Move an array item to a new index (no-op if out of range). Used by the
// reorderable effect/action lists.
function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr
  const next = arr.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

// Up/down controls for reordering a list item.
function ReorderButtons({ index, count, onMove, disabled }: {
  index: number
  count: number
  onMove: (to: number) => void
  disabled: boolean
}) {
  const btn = 'px-1 text-xs leading-none text-slate-500 hover:text-slate-200 disabled:opacity-30'
  return (
    <span className="flex items-center">
      <button type="button" title="Move up" disabled={disabled || index === 0} onClick={() => onMove(index - 1)} className={btn}>↑</button>
      <button type="button" title="Move down" disabled={disabled || index === count - 1} onClick={() => onMove(index + 1)} className={btn}>↓</button>
    </span>
  )
}

function SpellActionList({
  actions,
  onChange,
  disabled,
  emptyText,
}: {
  actions: BuilderSpellEffect[]
  onChange: (next: BuilderSpellEffect[]) => void
  disabled: boolean
  emptyText: string
}) {
  if (actions.length === 0) {
    return <p className="text-xs text-slate-500">{emptyText}</p>
  }
  return (
    <>
      {actions.map((action, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <select
            value={effectKeyOf(action)}
            disabled={disabled}
            onChange={(event) =>
              onChange(actions.map((a, i) => (i === index ? defaultSpellEffect(event.target.value as BuilderSpellEffectType) : a)))
            }
            className={inputClass}
          >
            {BUILDER_SPELL_EFFECT_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <EffectFields
            effect={action}
            disabled={disabled}
            onChange={(next) => onChange(actions.map((a, i) => (i === index ? (next as BuilderSpellEffect) : a)))}
          />
          <span className="ml-auto flex items-center gap-1.5">
            <ReorderButtons index={index} count={actions.length} disabled={disabled} onMove={(to) => onChange(moveItem(actions, index, to))} />
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(actions.filter((_, i) => i !== index))}
              className="text-xs text-slate-500 hover:text-red-300 disabled:opacity-50"
            >
              ✕
            </button>
          </span>
        </div>
      ))}
    </>
  )
}

function StaticBuffEditor({
  buff,
  onChange,
  onRemove,
  disabled,
}: {
  buff: BuilderStaticBuff
  onChange: (next: BuilderStaticBuff) => void
  onRemove: () => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300">
      <input
        type="number"
        min={-99}
        max={99}
        value={buff.power}
        disabled={disabled}
        title="Power"
        onChange={(event) => onChange({ ...buff, power: Number(event.target.value) })}
        className={`${inputClass} w-16`}
      />
      <span>/</span>
      <input
        type="number"
        min={-99}
        max={99}
        value={buff.toughness}
        disabled={disabled}
        title="Toughness"
        onChange={(event) => onChange({ ...buff, toughness: Number(event.target.value) })}
        className={`${inputClass} w-16`}
      />
      <span>to</span>
      <input
        type="text"
        value={buff.creatureType}
        disabled={disabled}
        placeholder="any type"
        title="Creature type (blank = all creatures)"
        onChange={(event) => onChange({ ...buff, creatureType: event.target.value })}
        className={`${inputClass} w-32`}
      />
      <span>creatures</span>
      <select
        value={buff.scope}
        disabled={disabled}
        title="Which creatures this affects"
        onChange={(event) => onChange({ ...buff, scope: event.target.value as BuilderStaticBuff['scope'] })}
        className={inputClass}
      >
        {BUILDER_STATIC_SCOPES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5" title="Exclude this permanent (the &quot;Other&quot; wording)">
        <input
          type="checkbox"
          checked={buff.excludeSource}
          disabled={disabled}
          onChange={(event) => onChange({ ...buff, excludeSource: event.target.checked })}
        />
        Other (not itself)
      </label>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="ml-auto text-xs text-slate-500 hover:text-red-300 disabled:opacity-50"
      >
        ✕
      </button>
    </div>
  )
}

function KeywordGrantEditor({
  grant,
  onChange,
  onRemove,
  disabled,
}: {
  grant: BuilderKeywordGrant
  onChange: (next: BuilderKeywordGrant) => void
  onRemove: () => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300">
      <input
        type="text"
        value={grant.creatureType}
        disabled={disabled}
        placeholder="any type"
        title="Creature type (blank = all creatures)"
        onChange={(event) => onChange({ ...grant, creatureType: event.target.value })}
        className={`${inputClass} w-32`}
      />
      <span>creatures</span>
      <select
        value={grant.scope}
        disabled={disabled}
        title="Which creatures this affects"
        onChange={(event) => onChange({ ...grant, scope: event.target.value as BuilderKeywordGrant['scope'] })}
        className={inputClass}
      >
        {BUILDER_STATIC_SCOPES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span>have</span>
      <select
        value={grant.keyword}
        disabled={disabled}
        title="Keyword"
        onChange={(event) => onChange({ ...grant, keyword: event.target.value as BuilderKeyword })}
        className={inputClass}
      >
        {BUILDER_KEYWORDS.map((keyword) => (
          <option key={keyword} value={keyword}>
            {KEYWORD_LABELS[keyword]}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5" title="Exclude this permanent (the &quot;Other&quot; wording)">
        <input
          type="checkbox"
          checked={grant.excludeSource}
          disabled={disabled}
          onChange={(event) => onChange({ ...grant, excludeSource: event.target.checked })}
        />
        Other (not itself)
      </label>
      <label className="flex items-center gap-1.5" title="Only token creatures (&quot;Zombie tokens you control have …&quot;)">
        <input
          type="checkbox"
          checked={grant.tokenOnly}
          disabled={disabled}
          onChange={(event) => onChange({ ...grant, tokenOnly: event.target.checked })}
        />
        Tokens only
      </label>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="ml-auto text-xs text-slate-500 hover:text-red-300 disabled:opacity-50"
      >
        ✕
      </button>
    </div>
  )
}

function TriggerEditor({
  trigger,
  onChange,
  onRemove,
  disabled,
}: {
  trigger: BuilderTrigger
  onChange: (next: BuilderTrigger) => void
  onRemove: () => void
  disabled: boolean
}) {
  const updateEffect = (index: number, next: BuilderEffect) => {
    onChange({ ...trigger, effects: trigger.effects.map((e, i) => (i === index ? next : e)) })
  }

  return (
    <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-center gap-2">
        <select
          value={trigger.event}
          disabled={disabled}
          onChange={(event) => onChange({ ...trigger, event: event.target.value as BuilderTriggerEvent })}
          className={`${inputClass} flex-1`}
        >
          {BUILDER_TRIGGER_EVENTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className="rounded border border-red-500/40 px-2 py-1.5 text-xs font-semibold text-red-300 disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      {/* Watcher filter — which OTHER creature this fires on (Champion of the Perished). */}
      {isWatcherEvent(trigger.event) && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-slate-800 bg-slate-900/40 p-2 text-xs text-slate-300">
          <span>Whenever a</span>
          <input
            type="text"
            value={trigger.filter.typeLine}
            disabled={disabled}
            placeholder="any type"
            title="Creature type the trigger watches (blank = any creature)"
            onChange={(event) => onChange({ ...trigger, filter: { ...trigger.filter, typeLine: event.target.value } })}
            className={`${inputClass} w-28`}
          />
          <select
            value={trigger.filter.controller}
            disabled={disabled}
            title="Whose creatures this watches"
            onChange={(event) => onChange({ ...trigger, filter: { ...trigger.filter, controller: event.target.value as BuilderTriggerController } })}
            className={inputClass}
          >
            {BUILDER_TRIGGER_CONTROLLERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5" title="Exclude this creature (the &quot;another&quot; wording)">
            <input
              type="checkbox"
              checked={trigger.filter.excludeSelf}
              disabled={disabled}
              onChange={(event) => onChange({ ...trigger, filter: { ...trigger.filter, excludeSelf: event.target.checked } })}
            />
            another (not this)
          </label>
          <label className="flex items-center gap-1.5" title="Ignore token creatures (Midnight Reaper, Open the Graves)">
            <input
              type="checkbox"
              checked={trigger.filter.nontoken}
              disabled={disabled}
              onChange={(event) => onChange({ ...trigger, filter: { ...trigger.filter, nontoken: event.target.checked } })}
            />
            nontoken only
          </label>
        </div>
      )}

      <div className="grid gap-2 border-l-2 border-slate-800 pl-3">
        {trigger.effects.map((effect, index) => (
          <EffectEditor
            key={index}
            effect={effect}
            context="trigger"
            disabled={disabled}
            onChange={(next) => updateEffect(index, next as BuilderEffect)}
            onRemove={() =>
              onChange({ ...trigger, effects: trigger.effects.filter((_, i) => i !== index) })
            }
          />
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ ...trigger, effects: [...trigger.effects, defaultEffect('gain_life')] })}
          className="justify-self-start rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50"
        >
          + Add effect
        </button>
      </div>
    </div>
  )
}

// One effect row: a type dropdown (the effect types valid in `context`) plus its
// declared fields. Used both for trigger effects and, recursively, for the inner
// effects of `may`/`choose_player` (via EffectListControl).
function EffectEditor({
  effect,
  context,
  onChange,
  onRemove,
  disabled,
  reorder,
}: {
  effect: FlatEffect
  context: EffectContext
  onChange: (next: FlatEffect) => void
  onRemove: () => void
  disabled: boolean
  reorder?: { index: number; count: number; onMove: (to: number) => void }
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={effectKeyOf(effect)}
        disabled={disabled}
        onChange={(event) => onChange(effectDefault(event.target.value))}
        className={inputClass}
      >
        {effectsForContext(context).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <EffectFields effect={effect} disabled={disabled} onChange={onChange} />

      <span className="ml-auto flex items-center gap-1.5">
        {reorder ? <ReorderButtons index={reorder.index} count={reorder.count} disabled={disabled} onMove={reorder.onMove} /> : null}
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className="text-xs text-slate-500 hover:text-red-300 disabled:opacity-50"
        >
          ✕
        </button>
      </span>
    </div>
  )
}

// Renders the input widgets for an effect's declared fields, driven entirely by
// the registry — so a new effect type's fields appear with no per-type JSX.
function EffectFields({
  effect,
  onChange,
  disabled,
}: {
  effect: FlatEffect
  onChange: (next: FlatEffect) => void
  disabled: boolean
}) {
  const def = resolveEffectDef(effect)
  if (!def) {
    return null
  }
  return (
    <>
      {def.fields.map((field) => (
        <FieldControl
          key={field.name}
          field={field}
          value={effect[field.name]}
          disabled={disabled}
          onChange={(next) => onChange({ ...effect, [field.name]: next })}
        />
      ))}
    </>
  )
}

function FieldControl({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldDescriptor
  value: unknown
  onChange: (next: unknown) => void
  disabled: boolean
}) {
  if (field.kind === 'number') {
    const min = field.min ?? 0
    return (
      <input
        type="number"
        min={min}
        max={field.max ?? 99}
        value={typeof value === 'number' ? value : field.default}
        disabled={disabled}
        title={field.label}
        onChange={(event) => onChange(Math.max(min, Number(event.target.value)))}
        className={`${inputClass} w-20`}
      />
    )
  }

  if (field.kind === 'text') {
    return (
      <input
        type="text"
        value={typeof value === 'string' ? value : field.default}
        disabled={disabled}
        placeholder={field.label}
        title={field.label}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClass} w-44`}
      />
    )
  }

  if (field.kind === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-xs text-slate-300" title={field.label}>
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.label}
      </label>
    )
  }

  // Nested record — render its sub-fields inline, writing back into the object.
  if (field.kind === 'object') {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    return (
      <>
        {field.fields.map((sub) => (
          <FieldControl
            key={sub.name}
            field={sub}
            value={v[sub.name]}
            disabled={disabled}
            onChange={(next) => onChange({ ...v, [sub.name]: next })}
          />
        ))}
      </>
    )
  }

  // Recursive list of effects (may / choose_player).
  if (field.kind === 'effect-list') {
    return (
      <EffectListControl
        field={field}
        value={Array.isArray(value) ? (value as FlatEffect[]) : []}
        disabled={disabled}
        onChange={onChange}
      />
    )
  }

  // enum | select — both render as a dropdown of the field's options.
  return (
    <select
      value={typeof value === 'string' ? value : field.default}
      disabled={disabled}
      title={field.label}
      onChange={(event) => onChange(event.target.value)}
      className={inputClass}
    >
      {field.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

// A bordered, indented block holding a list of nested effect rows plus an add
// button — the UI for an `effect-list` field. Each row recurses into EffectEditor
// (which recurses back into EffectFields), so arbitrarily nested effects work.
function EffectListControl({
  field,
  value,
  onChange,
  disabled,
}: {
  field: Extract<FieldDescriptor, { kind: 'effect-list' }>
  value: FlatEffect[]
  onChange: (next: FlatEffect[]) => void
  disabled: boolean
}) {
  const types = effectsForContext(field.itemContext)
  return (
    <div className="grid w-full gap-2 rounded border border-slate-800 bg-slate-900/40 p-2">
      {field.label ? (
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{field.label}</p>
      ) : null}
      {value.length === 0 ? (
        <p className="text-xs text-slate-500">No effects.</p>
      ) : (
        value.map((item, index) => (
          <EffectEditor
            key={index}
            effect={item}
            context={field.itemContext}
            disabled={disabled}
            onChange={(next) => onChange(value.map((e, i) => (i === index ? next : e)))}
            onRemove={() => onChange(value.filter((_, i) => i !== index))}
            reorder={{ index, count: value.length, onMove: (to) => onChange(moveItem(value, index, to)) }}
          />
        ))
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...value, effectDefault(types[0].value)])}
        className="justify-self-start rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50"
      >
        + Add effect
      </button>
    </div>
  )
}

function ActivatedAbilityEditor({
  ability,
  onChange,
  onRemove,
  disabled,
}: {
  ability: BuilderActivatedAbility
  onChange: (next: BuilderActivatedAbility) => void
  onRemove: () => void
  disabled: boolean
}) {
  return (
    <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-300">
          {ability.kind === 'mana' ? 'Tap for mana' : 'Effect'}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className="rounded border border-red-500/40 px-2 py-1 text-xs font-semibold text-red-300 disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      {/* Cost row */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={ability.tapSelf}
            disabled={disabled}
            onChange={(event) => onChange({ ...ability, tapSelf: event.target.checked })}
          />
          Tap {'{T}'}
        </label>

        {ability.kind === 'effect' ? (
          <>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={ability.sacSelf}
                disabled={disabled}
                onChange={(event) => onChange({ ...ability, sacSelf: event.target.checked })}
              />
              Sacrifice this
            </label>
            <label className="flex items-center gap-1.5" title="Spark Reaper / Vampiric Rites: sacrifice a creature you control as a cost">
              <input
                type="checkbox"
                checked={ability.sacCreature}
                disabled={disabled}
                onChange={(event) => onChange({ ...ability, sacCreature: event.target.checked })}
              />
              Sacrifice a creature
            </label>
            <label className="flex items-center gap-1.5" title="Cemetery Reaper: exile a creature card from any graveyard as a cost">
              <input
                type="checkbox"
                checked={ability.exileFromGraveyard}
                disabled={disabled}
                onChange={(event) => onChange({ ...ability, exileFromGraveyard: event.target.checked })}
              />
              Exile a creature from a graveyard
            </label>
            <label className="flex items-center gap-1.5">
              Mana cost
              <input
                type="text"
                value={ability.mana}
                disabled={disabled}
                placeholder="e.g. {2}{R}"
                onChange={(event) => onChange({ ...ability, mana: event.target.value })}
                className={`${inputClass} w-28`}
              />
            </label>
          </>
        ) : null}

        {ability.kind === 'mana' ? (
          <label className="flex items-center gap-1.5" title="An activation mana cost, e.g. Dimir Signet pays {1}">
            Mana cost
            <input
              type="text"
              value={ability.mana}
              disabled={disabled}
              placeholder="e.g. {1}"
              onChange={(event) => onChange({ ...ability, mana: event.target.value })}
              className={`${inputClass} w-24`}
            />
          </label>
        ) : null}

        {ability.kind === 'mana' ? (
          <label className="flex items-center gap-1.5" title="An additional 'Pay N life' cost, e.g. Talisman of Dominance pays 1 life">
            Pay life
            <input
              type="number"
              min={0}
              max={20}
              value={ability.payLife}
              disabled={disabled}
              onChange={(event) => onChange({ ...ability, payLife: Math.max(0, Number(event.target.value)) })}
              className={`${inputClass} w-16`}
            />
          </label>
        ) : null}
      </div>

      {/* Effect row */}
      {ability.kind === 'mana' ? (
        <div className="grid gap-2 text-xs text-slate-300">
          {ability.colors.map((out, ci) => (
            <div key={ci} className="flex flex-wrap items-center gap-2">
              <span>Add</span>
              <input
                type="number"
                min={1}
                max={9}
                value={out.amount}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...ability, colors: ability.colors.map((o, i) => (i === ci ? { ...o, amount: Math.max(1, Number(event.target.value)) } : o)) })
                }
                className={`${inputClass} w-16`}
              />
              <select
                value={out.color}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...ability, colors: ability.colors.map((o, i) => (i === ci ? { ...o, color: event.target.value as ManaColor } : o)) })
                }
                className={inputClass}
              >
                {BUILDER_MANA_COLORS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {ability.colors.length > 1 && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ ...ability, colors: ability.colors.filter((_, i) => i !== ci) })}
                  className="text-xs text-slate-500 hover:text-red-300 disabled:opacity-50"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...ability, colors: [...ability.colors, { color: 'C', amount: 1 }] })}
            className="justify-self-start rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50"
          >
            + Add colour
          </button>
        </div>
      ) : (
        // Generic effect: a registry effect editor (type dropdown + its fields),
        // resolved in spell context (the targeted creature effects + draw, etc.).
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <select
            value={effectKeyOf(ability.effect)}
            disabled={disabled}
            onChange={(event) => onChange({ ...ability, effect: effectDefault(event.target.value) })}
            className={inputClass}
          >
            {effectsForContext('spell').map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <EffectFields
            effect={ability.effect}
            disabled={disabled}
            onChange={(next) => onChange({ ...ability, effect: next })}
          />
        </div>
      )}
    </div>
  )
}
