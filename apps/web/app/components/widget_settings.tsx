'use client'
import { useAccount, useApi } from '../lib/client/react'
import { useEffect, useMemo, useState } from 'react'
import { withCursor } from '../lib/api'
import { appendUnique } from '../lib/lists'
import { sharing } from '../lib/platform'
import { useStore, errorText } from '../lib/store'
import type { Channel } from '../lib/types'
import {
  embedCode,
  widgetUrl,
  type Widget,
  type WidgetConfig,
  type WidgetMode,
} from '../lib/widgets'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { fieldCls } from './ui'

const labels: Record<WidgetMode, string> = {
  public_read: 'Public read-only',
  public_chat: 'Public chat',
  members: 'Members only',
  read_link: 'Private read link',
  voice: 'Voice room',
}
type WidgetSettingsProps = { server: string; channels: Channel[] }

export function WidgetSettings({ server, channels }: WidgetSettingsProps) {
  const enabled = useStore(s => s.settings.widgets && s.instance?.widgets)
  return (
    <Stack as="section" aria-label="Widgets" gap="sm">
      {enabled ? (
        <WidgetPicker key={server} server={server} channels={channels} />
      ) : (
        <p className="text-sm text-on-surface-variant">Widgets are turned off for this site.</p>
      )}
    </Stack>
  )
}

function WidgetPicker({ server, channels }: WidgetSettingsProps) {
  const api = useApi()
  const [list, setList] = useState<Widget[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [next, setNext] = useState<string | null>(null)
  const [request, setRequest] = useState<{ cursor: string | null } | null>({ cursor: null })
  const channelNames = useMemo(() => new Map(channels.map(c => [c.id, c.name])), [channels])
  const path = '/servers/' + encodeURIComponent(server) + '/widgets'
  useEffect(() => {
    if (!request) return
    const abort = new AbortController()
    api.page<Widget>(withCursor(path, request.cursor), abort.signal).then(
      page => {
        if (abort.signal.aborted) return
        setList(previous => appendUnique(previous, page.items, row => row.id))
        setNext(page.next)
        setError('')
        setRequest(null)
      },
      e => {
        if (abort.signal.aborted) return
        setError(errorText(e))
        setRequest(null)
      }
    )
    return () => abort.abort()
  }, [api, path, request])
  return (
    <>
      <label className="block text-sm">
        Widget
        <select
          aria-label="Widget"
          className={fieldCls + ' w-full cursor-pointer'}
          value={selected}
          onChange={e => setSelected(e.target.value)}
        >
          <option value="">New widget</option>
          {list.map(w => (
            <option key={w.id} value={w.id}>
              {channelNames.get(w.channel_id)} · {labels[w.mode]}
              {w.enabled ? '' : ' (disabled)'}
            </option>
          ))}
        </select>
      </label>
      {(next || error) && (
        <Button
          disabled={request !== null}
          onClick={() => setRequest({ cursor: next })}
          place="self-start"
        >
          {error ? 'Retry loading widgets' : 'Load more widgets'}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <WidgetForm
        key={selected}
        widget={list.find(w => w.id === selected)}
        channels={channels}
        save={async body => {
          const w = await api.req<Widget>(
            selected ? 'PUT' : 'POST',
            selected ? path + '/' + selected : path,
            body
          )
          setList(previous => [...previous.filter(row => row.id !== w.id), w])
          setSelected(w.id)
        }}
      />
    </>
  )
}

function WidgetForm({
  widget,
  channels,
  save,
}: {
  widget?: Widget
  channels: Channel[]
  save: (body: WidgetConfig) => Promise<void>
}) {
  const { conn: home } = useAccount()
  const [channel, setChannel] = useState(widget?.channel_id ?? channels[0]?.id ?? 0)
  const voice = channels.find(c => c.id === channel)?.kind === 'voice'
  const [mode, setMode] = useState<WidgetMode>(widget?.mode ?? (voice ? 'voice' : 'public_read'))
  const [origins, setOrigins] = useState(widget?.origins.join('\n') ?? '')
  const [composer, setComposer] = useState(widget?.composer ?? true)
  const [enabled, setEnabled] = useState(widget?.enabled ?? true)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(false)
  const streamer = useStore(s => s.streamer)
  const savedVoice = channels.find(c => c.id === widget?.channel_id)?.kind === 'voice'
  const url = widget ? widgetUrl(home.origin, widget) : ''
  const code = embedCode(url, savedVoice)
  return (
    <Stack gap="md">
      <label className="block text-sm">
        Widget channel
        <select
          aria-label="Widget channel"
          className={fieldCls + ' w-full cursor-pointer'}
          value={channel}
          onChange={e => {
            const id = Number(e.target.value)
            setChannel(id)
            setMode(channels.find(c => c.id === id)?.kind === 'voice' ? 'voice' : 'public_read')
          }}
        >
          {channels.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Widget access
        <select
          aria-label="Widget access"
          className={fieldCls + ' w-full cursor-pointer'}
          value={mode}
          onChange={e => setMode(e.target.value as WidgetMode)}
        >
          {(Object.keys(labels) as WidgetMode[])
            .filter(m => (voice ? m === 'voice' || m === 'members' : m !== 'voice'))
            .map(m => (
              <option key={m} value={m}>
                {labels[m]}
              </option>
            ))}
        </select>
      </label>
      <label className="block text-sm">
        Allowed parent origins, one per line
        <textarea
          className={fieldCls + ' w-full'}
          rows={2}
          placeholder="https://community.example"
          value={origins}
          onChange={e => setOrigins(e.target.value)}
        />
      </label>
      <Row gap="lg" wrap>
        <label className="cursor-pointer text-sm">
          <input
            className="cursor-pointer"
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
          />{' '}
          Enabled
        </label>
        {!voice && ['public_chat', 'members'].includes(mode) && (
          <label className="cursor-pointer text-sm">
            <input
              type="checkbox"
              className="cursor-pointer"
              checked={composer}
              onChange={e => setComposer(e.target.checked)}
            />{' '}
            Show chat composer
          </label>
        )}
      </Row>
      <Button
        variant="filled"
        size="md"
        disabled={!channel || busy}
        place="self-start"
        onClick={async () => {
          setBusy(true)
          setMessage('')
          setPreview(false)
          try {
            await save({
              channel_id: channel,
              mode,
              enabled,
              composer,
              origins: origins
                .split('\n')
                .map(s => s.trim())
                .filter(Boolean),
            })
            setMessage('Saved')
          } catch (e) {
            setMessage(errorText(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        Save widget
      </Button>
      {widget?.enabled && (
        <>
          <label className="block text-sm">
            Embed code
            <textarea
              aria-label="Embed code"
              rows={3}
              className={fieldCls + ' w-full font-mono text-xs'}
              readOnly
              value={code}
            />
          </label>
          <Row gap="sm" wrap>
            <Button
              onClick={async () =>
                setMessage(
                  (await sharing().copyText(code)) ? 'Copied' : 'Select the embed code to copy it.'
                )
              }
            >
              Copy embed code
            </Button>
            <Button onClick={() => setPreview(v => !v)}>
              {preview ? 'Close preview' : 'Preview widget'}
            </Button>
          </Row>
          {preview && (
            <iframe
              className="h-72 w-full rounded-lg border border-outline"
              title="Widget preview"
              data-preview-streamer={streamer ? 'on' : 'off'}
              src={url}
              allow={savedVoice ? 'microphone' : undefined}
            />
          )}
        </>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </Stack>
  )
}
