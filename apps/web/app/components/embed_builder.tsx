'use client'

import { useId, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, PanelTop, Pencil, Plus, Trash2, X } from 'lucide-react'
import {
  AUTHOR_MAX,
  DESCRIPTION_MAX,
  EMBEDS_MAX,
  FIELDS_MAX,
  FIELD_NAME_MAX,
  FIELD_VALUE_MAX,
  FOOTER_MAX,
  TITLE_MAX,
  URL_MAX,
  draftOf,
  embedLabel,
  embedOfDraft,
  embedProblem,
  emptyDraft,
  movedField,
  type EmbedDraft,
} from '../lib/rich_embeds'
import { cardAccent } from '../lib/embed_colors'
import { useStore } from '../lib/store'
import { useClock } from '../lib/client/react'
import { labelWith, notAName } from '../lib/names'
import type { RichEmbed } from '../lib/types'
import { ColorField } from './color_field'
import { Button, IconButton } from './controls'
import { Row, Stack, Surface } from './layout'
import { Dialog, FieldError, fieldCls } from './ui'

// Rich embeds as a message shows them; the caller passes the message renderer.
export type EmbedPreview = (embeds: RichEmbed[]) => ReactNode

const PRESETS = [
  { color: '#ed4245', label: 'Red' },
  { color: '#f0883e', label: 'Orange' },
  { color: '#fee75c', label: 'Yellow' },
  { color: '#57f287', label: 'Green' },
  { color: '#3ba7ff', label: 'Blue' },
  { color: '#5865f2', label: 'Indigo' },
  { color: '#eb459e', label: 'Pink' },
  { color: '#99aab5', label: 'Grey' },
]

const EMPTY = 'Embed is empty'

function TextField({
  label,
  value,
  max,
  onChange,
  placeholder,
  link = false,
}: {
  label: string
  value: string
  max: number
  onChange: (v: string) => void
  placeholder?: string
  link?: boolean
}) {
  return (
    <Stack as="label" gap="xs">
      <span className="text-sm text-on-surface">{label}</span>
      <input
        value={value}
        maxLength={max * 2}
        type={link ? 'url' : 'text'}
        inputMode={link ? 'url' : undefined}
        spellCheck={!link}
        autoComplete="off"
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className={fieldCls}
      />
    </Stack>
  )
}

function Check({
  label,
  on,
  onChange,
}: {
  label: string
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex min-h-11 cursor-pointer md:min-h-0">
      <Row as="span" gap="sm">
        <input
          type="checkbox"
          checked={on}
          onChange={e => onChange(e.target.checked)}
          className="size-4 shrink-0 accent-primary"
        />
        <span className="text-sm text-on-surface">{label}</span>
      </Row>
    </label>
  )
}

function FieldRows({
  fields,
  onChange,
}: {
  fields: EmbedDraft['fields']
  onChange: (fields: EmbedDraft['fields']) => void
}) {
  const set = (i: number, p: Partial<EmbedDraft['fields'][number]>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...p } : f)))
  return (
    <Stack gap="sm">
      <span className="text-sm text-on-surface">Fields</span>
      {fields.map((f, i) => (
        <Surface key={i} pad="sm" tone="plain" border gap="xs" data-embed-field={i}>
          <input
            value={f.name}
            maxLength={FIELD_NAME_MAX * 2}
            aria-label={`Field ${i + 1} name`}
            placeholder="Name"
            onChange={e => set(i, { name: e.target.value })}
            className={fieldCls}
          />
          <textarea
            value={f.value}
            rows={2}
            maxLength={FIELD_VALUE_MAX * 2}
            aria-label={`Field ${i + 1} value`}
            placeholder="Value"
            onChange={e => set(i, { value: e.target.value })}
            className={`${fieldCls} resize-y`}
          />
          <Row gap="2xs">
            <span className="mr-auto">
              <Check label="Inline" on={f.inline} onChange={inline => set(i, { inline })} />
            </span>
            <IconButton
              icon={ArrowUp}
              label={labelWith`Move field ${i + 1} up`}
              tooltip="Move up"
              disabled={i === 0}
              onClick={() => onChange(movedField(fields, i, -1))}
            />
            <IconButton
              icon={ArrowDown}
              label={labelWith`Move field ${i + 1} down`}
              tooltip="Move down"
              disabled={i === fields.length - 1}
              onClick={() => onChange(movedField(fields, i, 1))}
            />
            <IconButton
              icon={Trash2}
              label={labelWith`Remove field ${i + 1}`}
              tooltip="Remove field"
              onClick={() => onChange(fields.filter((_, j) => j !== i))}
            />
          </Row>
        </Surface>
      ))}
      <Button
        icon={Plus}
        data-embed-add-field
        disabled={fields.length >= FIELDS_MAX}
        onClick={() => onChange([...fields, { name: '', value: '', inline: false }])}
        place="self-start"
      >
        Add field
      </Button>
    </Stack>
  )
}

// Makes or changes one rich embed, with a live preview. A link is optional everywhere.
export function EmbedBuilderDialog({
  initial,
  onSave,
  onClose,
  preview,
}: {
  initial?: RichEmbed | null
  onSave: (embed: RichEmbed) => void
  onClose: () => void
  preview: EmbedPreview
}) {
  const clock = useClock()
  const [d, setD] = useState<EmbedDraft>(() => (initial ? draftOf(initial) : emptyDraft()))
  const [error, setError] = useState<string | null>(null)
  const [now] = useState(() => Math.floor(clock.now() / 1000))
  const descId = useId()
  const patch = (p: Partial<EmbedDraft>) => {
    setD(cur => ({ ...cur, ...p }))
    setError(null)
  }
  const embed = embedOfDraft(d, now)
  const problem = embedProblem(embed)
  const save = () => {
    if (problem) setError(problem)
    else onSave(embed)
  }
  return (
    <Dialog title={initial ? 'Edit embed' : 'Create embed'} onClose={onClose} size="lg">
      <Stack gap="md" data-embed-builder>
        <Stack gap="lg" rowFrom="md" align="start">
          <Stack gap="md" place="min-w-0 flex-1">
            <ColorField
              label="Color"
              value={d.color}
              shown={d.color ?? '#5865f2'}
              onChange={color => patch({ color })}
              presets={PRESETS}
              defaultNote="No color"
              resetLabel="No color"
            />
            <TextField
              label="Author"
              value={d.author}
              max={AUTHOR_MAX}
              onChange={author => patch({ author })}
            />
            <TextField
              label="Author link"
              value={d.authorUrl}
              max={URL_MAX}
              link
              placeholder="https://"
              onChange={authorUrl => patch({ authorUrl })}
            />
            <TextField
              label="Title"
              value={d.title}
              max={TITLE_MAX}
              onChange={title => patch({ title })}
            />
            <TextField
              label="Title link"
              value={d.url}
              max={URL_MAX}
              link
              placeholder="https://"
              onChange={url => patch({ url })}
            />
            <Stack as="label" gap="xs" htmlFor={descId}>
              <span className="text-sm text-on-surface">Description</span>
              <textarea
                id={descId}
                value={d.description}
                rows={4}
                maxLength={DESCRIPTION_MAX * 2}
                placeholder="Markdown works here, like [a link](https://example.com)"
                onChange={e => patch({ description: e.target.value })}
                className={`${fieldCls} resize-y`}
              />
            </Stack>
            <FieldRows fields={d.fields} onChange={fields => patch({ fields })} />
            <TextField
              label="Footer"
              value={d.footer}
              max={FOOTER_MAX}
              onChange={footer => patch({ footer })}
            />
            <Check
              label="Show the time next to the footer"
              on={d.stamped}
              onChange={stamped => patch({ stamped, at: stamped ? d.at : null })}
            />
          </Stack>
          <Stack gap="xs" place="min-w-0 md:w-72 md:shrink-0">
            <span className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
              Preview
            </span>
            <div data-embed-preview className="min-w-0">
              {problem === EMPTY ? (
                <p className="text-sm text-on-surface-variant">
                  Add a title, a description, a field or a footer to see it here.
                </p>
              ) : (
                preview([embed])
              )}
            </div>
          </Stack>
        </Stack>
        <FieldError message={error} />
        <Row gap="xs" justify="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="filled" data-embed-save onClick={save}>
            {initial ? 'Save' : 'Add embed'}
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

// The composer's button that starts an embed.
export function EmbedButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <IconButton
      icon={PanelTop}
      label="Create embed"
      tooltip={disabled ? `Up to ${EMBEDS_MAX} embeds` : 'Create embed'}
      data-create-embed
      disabled={disabled}
      onClick={onClick}
    />
  )
}

// The embeds waiting in a composer, as chips above it, with the builder for a new or changed
// one. `builder` is the index being changed, `'new'` for a new one, or null.
export function ComposerEmbeds({
  list,
  onChange,
  builder,
  setBuilder,
  preview,
}: {
  list: readonly RichEmbed[]
  onChange: (list: RichEmbed[]) => void
  builder: number | 'new' | null
  setBuilder: (at: number | 'new' | null) => void
  preview: EmbedPreview
}) {
  const theme = useStore(s => s.theme)
  return (
    <>
      {list.length > 0 && (
        <Row gap="xs" wrap data-composer-embeds>
          {list.map((e, i) => (
            <div
              key={i}
              data-composer-embed={i}
              style={{ borderLeftColor: cardAccent(e.color, theme) ?? undefined }}
              className="max-w-60 min-w-0 rounded-xl border-l-4 border-outline bg-surface-container"
            >
              <Surface pad="2xs" tone="plain">
                <Row gap="2xs">
                  <span className="min-w-0 truncate text-sm text-on-surface">
                    {notAName(embedLabel(e))}
                  </span>
                  <IconButton
                    icon={Pencil}
                    size="sm"
                    label={labelWith`Edit embed ${i + 1}`}
                    tooltip="Edit embed"
                    onClick={() => setBuilder(i)}
                  />
                  <IconButton
                    icon={X}
                    size="sm"
                    label={labelWith`Remove embed ${i + 1}`}
                    tooltip="Remove embed"
                    onClick={() => onChange(list.filter((_, j) => j !== i))}
                  />
                </Row>
              </Surface>
            </div>
          ))}
        </Row>
      )}
      {builder !== null && (
        <EmbedBuilderDialog
          initial={builder === 'new' ? null : (list[builder] ?? null)}
          preview={preview}
          onClose={() => setBuilder(null)}
          onSave={e => {
            onChange(
              builder === 'new' || builder >= list.length
                ? [...list, e].slice(0, EMBEDS_MAX)
                : list.map((x, j) => (j === builder ? e : x))
            )
            setBuilder(null)
          }}
        />
      )}
    </>
  )
}
