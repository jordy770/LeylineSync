'use client'

import {
  BUILDER_ABILITY_KINDS,
  BUILDER_DAMAGE_TARGETS,
  BUILDER_KEYWORDS,
  BUILDER_MANA_COLORS,
  BUILDER_SPELL_EFFECT_TYPES,
  BUILDER_TRIGGER_EVENTS,
  KEYWORD_LABELS,
  defaultActivatedAbility,
  defaultEffect,
  defaultSpellEffect,
  defaultTrigger,
  type BuilderActivatedAbility,
  type BuilderDamageTarget,
  type BuilderEffect,
  type BuilderForm,
  type BuilderKeyword,
  type BuilderSpellEffect,
  type BuilderSpellEffectType,
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

  const updateSpellAction = (index: number, next: BuilderSpellEffect) => {
    onChange({ ...value, spellEffect: value.spellEffect.map((a, i) => (i === index ? next : a)) })
  }

  const removeSpellAction = (index: number) => {
    onChange({ ...value, spellEffect: value.spellEffect.filter((_, i) => i !== index) })
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

        {value.spellEffect.length === 0 ? (
          <p className="text-xs text-slate-500">No spell effect. Actions resolve in order (e.g. Scry 1, then Draw 1).</p>
        ) : (
          value.spellEffect.map((action, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <select
                value={effectKeyOf(action)}
                disabled={disabled}
                onChange={(event) =>
                  updateSpellAction(index, defaultSpellEffect(event.target.value as BuilderSpellEffectType))
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
                onChange={(next) => updateSpellAction(index, next as BuilderSpellEffect)}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeSpellAction(index)}
                className="ml-auto text-xs text-slate-500 hover:text-red-300 disabled:opacity-50"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </section>
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
}: {
  effect: FlatEffect
  context: EffectContext
  onChange: (next: FlatEffect) => void
  onRemove: () => void
  disabled: boolean
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
          {ability.kind === 'mana' ? 'Tap for mana' : 'Deal damage'}
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

        {ability.kind === 'damage' ? (
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
        ) : null}
      </div>

      {/* Effect row */}
      {ability.kind === 'mana' ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <span>Add</span>
          <input
            type="number"
            min={1}
            max={9}
            value={ability.amount}
            disabled={disabled}
            onChange={(event) => onChange({ ...ability, amount: Math.max(1, Number(event.target.value)) })}
            className={`${inputClass} w-16`}
          />
          <select
            value={ability.color}
            disabled={disabled}
            onChange={(event) => onChange({ ...ability, color: event.target.value as ManaColor })}
            className={inputClass}
          >
            {BUILDER_MANA_COLORS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <span>Deal</span>
          <input
            type="number"
            min={1}
            max={99}
            value={ability.amount}
            disabled={disabled}
            onChange={(event) => onChange({ ...ability, amount: Math.max(1, Number(event.target.value)) })}
            className={`${inputClass} w-16`}
          />
          <span>damage to</span>
          <select
            value={ability.target}
            disabled={disabled}
            onChange={(event) => onChange({ ...ability, target: event.target.value as BuilderDamageTarget })}
            className={inputClass}
          >
            {BUILDER_DAMAGE_TARGETS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
