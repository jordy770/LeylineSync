'use client'

import {
  BUILDER_ABILITY_KINDS,
  BUILDER_DAMAGE_TARGETS,
  BUILDER_EFFECT_TYPES,
  BUILDER_KEYWORDS,
  BUILDER_MANA_COLORS,
  BUILDER_RECIPIENTS,
  BUILDER_SPELL_EFFECT_TYPES,
  BUILDER_TOKEN_NAMES,
  BUILDER_TRIGGER_EVENTS,
  KEYWORD_LABELS,
  defaultActivatedAbility,
  defaultEffect,
  defaultSpellEffect,
  defaultTrigger,
  type BuilderActivatedAbility,
  type BuilderDamageTarget,
  type BuilderEffect,
  type BuilderEffectType,
  type BuilderForm,
  type BuilderKeyword,
  type BuilderRecipient,
  type BuilderSpellEffect,
  type BuilderSpellEffectType,
  type BuilderTrigger,
  type BuilderTriggerEvent,
} from '@/lib/game/card-behavior-builder'
import type { ManaColor } from '@/lib/game/types'

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
                value={action.type}
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
              <input
                type="number"
                min={1}
                max={99}
                value={action.amount}
                disabled={disabled}
                onChange={(event) => updateSpellAction(index, { ...action, amount: Math.max(1, Number(event.target.value)) })}
                className={`${inputClass} w-20`}
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
            disabled={disabled}
            onChange={(next) => updateEffect(index, next)}
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

function EffectEditor({
  effect,
  onChange,
  onRemove,
  disabled,
}: {
  effect: BuilderEffect
  onChange: (next: BuilderEffect) => void
  onRemove: () => void
  disabled: boolean
}) {
  const hasRecipient = effect.type === 'lose_life' || effect.type === 'deal_damage'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={effect.type}
        disabled={disabled}
        onChange={(event) => onChange(defaultEffect(event.target.value as BuilderEffectType))}
        className={inputClass}
      >
        {BUILDER_EFFECT_TYPES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {effect.type === 'create_token' ? (
        <>
          <input
            type="number"
            min={1}
            max={20}
            value={effect.count}
            disabled={disabled}
            onChange={(event) => onChange({ ...effect, count: Math.max(1, Number(event.target.value)) })}
            className={`${inputClass} w-16`}
          />
          <span className="text-slate-400">×</span>
          <select
            value={effect.token}
            disabled={disabled}
            onChange={(event) => onChange({ ...effect, token: event.target.value })}
            className={inputClass}
          >
            {BUILDER_TOKEN_NAMES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </>
      ) : (
        <input
          type="number"
          min={1}
          max={99}
          value={effect.amount}
          disabled={disabled}
          onChange={(event) => onChange({ ...effect, amount: Math.max(0, Number(event.target.value)) })}
          className={`${inputClass} w-20`}
        />
      )}

      {hasRecipient ? (
        <select
          value={(effect as { recipient: BuilderRecipient }).recipient}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...effect, recipient: event.target.value as BuilderRecipient } as BuilderEffect)
          }
          className={inputClass}
        >
          {BUILDER_RECIPIENTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}

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
