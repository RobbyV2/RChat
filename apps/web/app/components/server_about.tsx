'use client'

import { Name, NameArea } from './name'
import { serverCalled } from '../lib/names'
import { useMemo, useState } from 'react'
import { minidenticon } from 'minidenticons'
import { useMask } from '../lib/store'
import { charCount, serverInitial } from '../lib/rules'
import {
  ABOUT_MAX,
  ICON_KINDS,
  aboutAnnouncement,
  aboutChange,
  aboutError,
  cleanAbout,
  type AboutChange,
  type ServerAbout,
  type ServerIconKind,
} from '../lib/server_about'
import { iconLook } from '../lib/server_icon'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { Chips, fieldCls, FieldError, Masked, sectionCls } from './ui'

// One server icon for the rail, invite cards and search: the first letter of its name or a
// pattern from its key, on the server's color when it has one.
export function ServerIcon({
  seed,
  name,
  kind,
  color,
  own = false,
  framed = false,
  className = '',
}: {
  // What the pattern is made from: the server's key.
  seed: string
  // The shown name the letter comes from.
  name: string
  kind: ServerIconKind
  color?: string | null
  own?: boolean
  // Leaves a rim of the tile around a colored icon (the open server's tile).
  framed?: boolean
  className?: string
}) {
  const mask = useMask(own)
  const look = iconLook(kind, seed, color)
  const src = useMemo(() => {
    if (kind !== 'identicon') return null
    const svg = minidenticon(seed, 95, 45)
    const inked = look.fg ? svg.replace(/fill="[^"]*"/, `fill="${look.fg}"`) : svg
    return `data:image/svg+xml;utf8,${encodeURIComponent(inked)}`
  }, [kind, seed, look.fg])
  const icon = (
    <span
      data-server-icon={kind}
      style={look.bg ? { background: look.bg, color: look.fg ?? undefined } : undefined}
      className={`flex h-full w-full items-center justify-center overflow-hidden rounded-inherit ${className}`}
    >
      {src ? (
        <img src={src} alt="" draggable={false} className="icon-inset h-full w-full" />
      ) : (
        <Name of={serverCalled(serverInitial(mask(name)))} />
      )}
    </span>
  )
  return framed && look.bg ? (
    <span className="icon-frame flex h-full w-full rounded-inherit">{icon}</span>
  ) : (
    icon
  )
}

// A server's description under its name.
export function AboutLine({
  text,
  own = false,
  oneLine = false,
  className = '',
}: {
  text: string | null
  own?: boolean
  // One line, cut with an ellipsis (lists).
  oneLine?: boolean
  className?: string
}) {
  if (!text) return null
  return (
    <p
      data-server-about
      className={`streamer text-xs break-words text-on-surface-variant ${
        oneLine ? 'truncate' : 'line-clamp-3 whitespace-pre-line'
      } ${className}`}
    >
      <Masked text={oneLine ? text.replace(/\s+/g, ' ') : text} own={own} />
    </p>
  )
}

// The About section of server settings, for hosted and P2P servers alike.
export function AboutEditor({
  seed,
  name,
  color,
  about,
  editable,
  own,
  locked,
  onSave,
}: {
  seed: string
  name: string
  color: string | null
  about: ServerAbout
  editable: boolean
  // The server is your own: its names and text show unmasked to you.
  own: boolean
  // What shows to members who may not change it.
  locked: string
  onSave: (change: AboutChange) => Promise<unknown>
}) {
  const [text, setText] = useState(about.text ?? '')
  const [icon, setIcon] = useState<ServerIconKind>(about.icon)
  const [seen, setSeen] = useState(about)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  if (seen.text !== about.text || seen.icon !== about.icon) {
    if ((cleanAbout(text) || null) === seen.text) setText(about.text ?? '')
    if (icon === seen.icon) setIcon(about.icon)
    setSeen(about)
  }
  const count = charCount(cleanAbout(text))
  const tooLong = aboutError(text)
  const change = aboutChange(about, text, icon)
  const edit = (apply: () => void) => {
    apply()
    setDone(false)
    setError(null)
  }
  const save = () => {
    if (!change || tooLong || saving) return
    setSaving(true)
    setError(null)
    onSave(change)
      .then(
        () => setDone(true),
        (e: unknown) => setError(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setSaving(false))
  }
  return (
    <>
      <p className={sectionCls}>About</p>
      <Stack gap="md">
        <Row gap="md">
          <span
            aria-label="Icon preview"
            role="img"
            className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-surface-container-highest text-lg font-semibold text-on-surface"
          >
            <ServerIcon seed={seed} name={name} kind={icon} color={color} own={own} />
          </span>
          <Stack gap="xs">
            <span className="text-sm text-on-surface">Icon</span>
            <Chips
              label="Icon"
              value={icon}
              options={ICON_KINDS.map(k => ({ value: k.kind, label: k.label }))}
              onChange={k => edit(() => setIcon(k))}
              disabled={!editable}
            />
          </Stack>
        </Row>
        {editable ? (
          <Stack as="label" gap="xs">
            <span className="text-sm text-on-surface">Description</span>
            <NameArea
              value={text}
              rows={3}
              onChange={e => edit(() => setText(e.target.value))}
              placeholder="What this server is about"
              aria-invalid={tooLong !== null}
              className={`${fieldCls} resize-y`}
            />
          </Stack>
        ) : (
          <Stack gap="xs">
            <span className="text-sm text-on-surface">Description</span>
            {about.text ? (
              <p className="streamer text-sm break-words whitespace-pre-line text-on-surface-variant">
                <Masked text={about.text} own={own} />
              </p>
            ) : (
              <p className="text-sm text-on-surface-variant">No description.</p>
            )}
          </Stack>
        )}
        {editable && (
          <p
            aria-live="polite"
            className={`text-xs ${tooLong ? 'text-error' : 'text-on-surface-variant'}`}
          >
            {count}/{ABOUT_MAX}
            <span className="sr-only"> {aboutAnnouncement(count)}</span>
          </p>
        )}
        {editable ? (
          <Row gap="sm" wrap>
            <Button
              variant="filled"
              size="md"
              disabled={!change || tooLong !== null || saving}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save about'}
            </Button>
            {change && !saving && (
              <Button
                size="md"
                onClick={() =>
                  edit(() => {
                    setText(about.text ?? '')
                    setIcon(about.icon)
                  })
                }
              >
                Discard
              </Button>
            )}
            {done && !change && (
              <span role="status" className="text-xs text-on-surface">
                About saved.
              </span>
            )}
          </Row>
        ) : (
          <p className="text-xs text-on-surface-variant">{locked}</p>
        )}
        <FieldError message={error ?? tooLong} />
      </Stack>
    </>
  )
}
