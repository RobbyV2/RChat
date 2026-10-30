'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Copy, KeyRound, Pencil, Plus, Power, Send, Trash2 } from 'lucide-react'
import { api, shareOrigin } from '../lib/instances'
import { errorText, useStore } from '../lib/store'
import { sharing } from '../lib/platform'
import { fullTimeOf, relativeTime } from '../lib/timestamps'
import type { AvatarKind, Channel } from '../lib/types'
import {
  OUTGOING_EVENTS,
  OUTGOING_MAX,
  OWNER_NOTE,
  deliveryText,
  eventLabel,
  nameProblem,
  outgoingReach,
  takesOver,
  urlProblem,
  webhookUrl,
  type Delivery,
  type OutgoingList,
  type OutgoingWebhook,
  type Webhook,
} from '../lib/webhooks'
import { AvatarPicker } from './avatar_picker'
import { UserAvatar } from './user_avatar'
import {
  Dialog,
  FieldError,
  fieldCls,
  filledBtn,
  iconBtn,
  Masked,
  sectionCls,
  textBtn,
  useCopied,
} from './ui'

const DEFAULT_COLOR = '#5c6bc0'

const ago = (seconds: number) => relativeTime(seconds * 1000, Date.now())

export default function WebhooksDialog() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'webhooks' ? <Webhooks server={dialog.server} /> : null
}

type Tab = 'incoming' | 'outgoing'

function Webhooks({ server }: { server: string }) {
  const openDialog = useStore(s => s.openDialog)
  const [tab, setTab] = useState<Tab>('incoming')
  const back = () => openDialog({ kind: 'server_settings', server })
  const tabCls = (on: boolean) =>
    `flex-1 rounded-full px-3 py-1.5 text-sm font-medium ${
      on
        ? 'bg-secondary-container text-on-secondary-container'
        : 'text-on-surface-variant hover:bg-surface-container-highest'
    }`
  return (
    <Dialog full title="Webhooks" onClose={back}>
      <div role="tablist" className="mb-4 flex gap-1 rounded-full bg-surface-container p-1">
        <button
          role="tab"
          aria-selected={tab === 'incoming'}
          onClick={() => setTab('incoming')}
          className={tabCls(tab === 'incoming')}
        >
          Incoming
        </button>
        <button
          role="tab"
          aria-selected={tab === 'outgoing'}
          onClick={() => setTab('outgoing')}
          className={tabCls(tab === 'outgoing')}
        >
          Outgoing
        </button>
      </div>
      {tab === 'incoming' ? <Incoming server={server} /> : <Outgoing server={server} />}
    </Dialog>
  )
}

function SecretBox({
  label,
  value,
  note,
  onDone,
}: {
  label: string
  value: string
  note: string
  onDone: () => void
}) {
  const [copied, flash] = useCopied()
  return (
    <div className="mb-4 rounded-2xl border border-primary bg-primary-container/30 p-3">
      <p className="text-sm font-medium text-on-surface">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="streamer min-w-0 flex-1 rounded-lg bg-surface-container-highest px-2 py-1.5 font-mono text-xs break-all text-on-surface select-all">
          {value}
        </code>
        <button
          title={copied ? 'Copied' : 'Copy'}
          aria-label={copied ? 'Copied' : 'Copy'}
          onClick={() => void sharing().copyText(value).then(flash)}
          className={iconBtn}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <p className="mt-2 text-xs text-on-surface-variant">{note}</p>
      <div className="mt-2 flex justify-end">
        <button onClick={onDone} className={textBtn}>
          Done
        </button>
      </div>
    </div>
  )
}

const textChannels = (channels: Channel[] | undefined) =>
  (channels ?? []).filter(c => c.kind === 'text')

function ChannelSelect({
  channels,
  value,
  onChange,
}: {
  channels: Channel[]
  value: number | null
  onChange: (id: number) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
      Channel
      <select
        value={value ?? ''}
        onChange={e => onChange(Number(e.target.value))}
        className={`${fieldCls} bg-surface-container-high text-on-surface`}
      >
        {channels.map(c => (
          <option key={c.id} value={c.id}>
            #{c.name}
          </option>
        ))}
      </select>
    </label>
  )
}

interface HookForm {
  name: string
  channel: number | null
  kind: AvatarKind
  color: string
}

function HookEditor({
  initial,
  channels,
  busy,
  submit,
  submitLabel,
  onCancel,
}: {
  initial: HookForm
  channels: Channel[]
  busy: boolean
  submit: (f: HookForm) => Promise<string | null>
  submitLabel: string
  onCancel?: () => void
}) {
  const [form, setForm] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const problem = nameProblem(form.name)
    if (problem) {
      setError(problem)
      return
    }
    setError(await submit(form))
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface-container p-3">
      <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
        Name
        <input
          value={form.name}
          maxLength={80}
          onChange={e => setForm({ ...form, name: e.target.value })}
          placeholder="Deploy bot"
          className={`${fieldCls} text-on-surface`}
        />
      </label>
      <ChannelSelect
        channels={channels}
        value={form.channel}
        onChange={channel => setForm({ ...form, channel })}
      />
      <AvatarPicker
        username={`@webhook:${form.name}`}
        kind={form.kind}
        color={form.color}
        onKind={kind => setForm({ ...form, kind })}
        onColor={color => setForm({ ...form, color })}
      />
      <FieldError message={error} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button onClick={onCancel} className={textBtn}>
            Cancel
          </button>
        )}
        <button
          disabled={busy || form.channel === null}
          onClick={() => void save()}
          className={filledBtn}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

function Incoming({ server }: { server: string }) {
  const all = useStore(s => s.servers[server]?.channels)
  const channels = useMemo(() => textChannels(all), [all])
  const askConfirm = useStore(s => s.askConfirm)
  const me = useStore(s => s.me?.username)
  const [list, setList] = useState<Webhook[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [secret, setSecret] = useState<{ name: string; url: string } | null>(null)

  const load = useCallback(() => {
    api
      .listWebhooks(server)
      .then(setList)
      .catch((e: unknown) => setError(errorText(e)))
  }, [server])
  useEffect(load, [load])

  const channelName = (id: number) => channels.find(c => c.id === id)?.name ?? 'unknown'
  const reveal = (name: string, path: string) =>
    setSecret({ name, url: webhookUrl(shareOrigin(), path) })

  const create = async (f: HookForm): Promise<string | null> => {
    if (f.channel === null) return 'Pick a channel'
    setBusy(true)
    try {
      const made = await api.createWebhook(server, {
        channel_id: f.channel,
        name: f.name.trim(),
        avatar_kind: f.kind,
        avatar_color: f.kind === 'color' ? f.color : null,
      })
      setCreating(false)
      reveal(made.name, made.path)
      load()
      return null
    } catch (e) {
      return errorText(e)
    } finally {
      setBusy(false)
    }
  }

  const save = async (hook: Webhook, f: HookForm) => {
    setBusy(true)
    try {
      await api.updateWebhook(server, hook.id, {
        name: f.name.trim(),
        channel_id: f.channel ?? hook.channel_id,
        avatar_kind: f.kind,
        avatar_color: f.kind === 'color' ? f.color : null,
      })
      setEditing(null)
      load()
      return null
    } catch (e) {
      return errorText(e)
    } finally {
      setBusy(false)
    }
  }

  const update = (hook: Webhook) => (f: HookForm) => {
    const moving = f.channel !== null && f.channel !== hook.channel_id
    if (!moving || !takesOver(hook.creator, me)) return save(hook, f)
    return new Promise<string | null>(resolve =>
      askConfirm({
        title: 'Move webhook',
        body: `Move ${hook.name} to #${channelName(f.channel ?? hook.channel_id)}? ${OWNER_NOTE}`,
        confirm: 'Move',
        action: () => void save(hook, f).then(resolve),
      })
    )
  }

  const resetUrl = (hook: Webhook) =>
    askConfirm({
      title: 'New webhook URL',
      body: `Make a new URL for ${hook.name}? The current URL stops working right away.${takesOver(hook.creator, me) ? ` ${OWNER_NOTE}` : ''}`,
      confirm: 'Make new URL',
      action: () =>
        void api
          .resetWebhookToken(server, hook.id)
          .then(made => {
            reveal(made.name, made.path)
            load()
          })
          .catch((e: unknown) => setError(errorText(e))),
    })

  const remove = (hook: Webhook) =>
    askConfirm({
      title: 'Delete webhook',
      body: `Delete ${hook.name}? Its URL stops working. Messages it posted stay.`,
      confirm: 'Delete',
      action: () =>
        void api
          .deleteWebhook(server, hook.id)
          .then(load)
          .catch((e: unknown) => setError(errorText(e))),
    })

  const first = channels[0]?.id ?? null
  return (
    <div>
      <p className="mb-3 text-sm text-on-surface-variant">
        A webhook posts into one channel from a script or service through a secret URL. No account
        needed. Its messages show a WEBHOOK badge.
      </p>
      {secret && (
        <SecretBox
          label={`URL of ${secret.name}`}
          value={secret.url}
          note={
            'Copy it now: it is shown only once. Anyone with this URL can post as the webhook. POST JSON like {"content": "Hello"}.'
          }
          onDone={() => setSecret(null)}
        />
      )}
      <FieldError message={error} />
      {creating ? (
        <HookEditor
          initial={{ name: '', channel: first, kind: 'identicon', color: DEFAULT_COLOR }}
          channels={channels}
          busy={busy}
          submit={create}
          submitLabel="Create webhook"
          onCancel={() => setCreating(false)}
        />
      ) : (
        <button
          onClick={() => setCreating(true)}
          disabled={channels.length === 0}
          className={`${filledBtn} flex items-center gap-1.5`}
        >
          <Plus size={16} />
          New webhook
        </button>
      )}
      <p className={sectionCls + ' mt-4'}>Webhooks</p>
      {list === null ? (
        <p className="px-2 text-sm text-on-surface-variant">Loading…</p>
      ) : list.length === 0 ? (
        <p className="px-2 text-sm text-on-surface-variant">No webhooks yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {list.map(h => (
            <li key={h.id} className="rounded-xl px-2 py-2 hover:bg-surface-container">
              <div className="flex items-center gap-3">
                <UserAvatar
                  username={`@webhook:${h.id}`}
                  avatarKind={h.avatar_kind}
                  avatarColor={h.avatar_color}
                  size={32}
                />
                <div className="min-w-0 flex-1">
                  <p className="streamer truncate text-sm font-medium text-on-surface">
                    <Masked text={h.name} />
                  </p>
                  <p className="truncate text-xs text-on-surface-variant">
                    #{channelName(h.channel_id)}
                    {' · '}
                    <span title={h.last_used_at ? fullTimeOf(h.last_used_at) : undefined}>
                      {h.last_used_at ? `used ${ago(h.last_used_at)}` : 'never used'}
                    </span>
                    {h.creator && (
                      <>
                        {' · by '}
                        <span className="streamer">
                          <Masked text={h.creator.display_name} />
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <button
                  title="Edit"
                  aria-label={`Edit ${h.name}`}
                  onClick={() => setEditing(editing === h.id ? null : h.id)}
                  className={iconBtn}
                >
                  <Pencil size={16} />
                </button>
                <button
                  title="New URL"
                  aria-label={`New URL for ${h.name}`}
                  onClick={() => resetUrl(h)}
                  className={iconBtn}
                >
                  <KeyRound size={16} />
                </button>
                <button
                  title="Delete"
                  aria-label={`Delete ${h.name}`}
                  onClick={() => remove(h)}
                  className={`${iconBtn} hover:text-error`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              {editing === h.id && (
                <div className="mt-2">
                  <HookEditor
                    initial={{
                      name: h.name,
                      channel: h.channel_id,
                      kind: h.avatar_kind,
                      color: h.avatar_color ?? DEFAULT_COLOR,
                    }}
                    channels={channels}
                    busy={busy}
                    submit={update(h)}
                    submitLabel="Save"
                    onCancel={() => setEditing(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface OutForm {
  name: string
  url: string
  events: string[]
}

function OutEditor({
  initial,
  busy,
  submit,
  submitLabel,
  onCancel,
}: {
  initial: OutForm
  busy: boolean
  submit: (f: OutForm) => Promise<string | null>
  submitLabel: string
  onCancel: () => void
}) {
  const [form, setForm] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const toggle = (key: string) =>
    setForm(f => ({
      ...f,
      events: f.events.includes(key) ? f.events.filter(e => e !== key) : [...f.events, key],
    }))
  const save = async () => {
    const problem = nameProblem(form.name) ?? urlProblem(form.url)
    if (problem) {
      setError(problem)
      return
    }
    if (!form.events.length) {
      setError('Choose at least one event')
      return
    }
    setError(await submit(form))
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface-container p-3">
      <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
        Name
        <input
          value={form.name}
          maxLength={80}
          onChange={e => setForm({ ...form, name: e.target.value })}
          placeholder="Moderation log"
          className={`${fieldCls} text-on-surface`}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
        URL
        <input
          value={form.url}
          type="url"
          inputMode="url"
          onChange={e => setForm({ ...form, url: e.target.value })}
          placeholder="https://example.com/hooks/chat"
          className={`${fieldCls} text-on-surface`}
        />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm text-on-surface-variant">Events</legend>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {OUTGOING_EVENTS.map(e => (
            <label key={e.key} className="flex min-h-9 items-center gap-2 text-sm text-on-surface">
              <input
                type="checkbox"
                checked={form.events.includes(e.key)}
                onChange={() => toggle(e.key)}
                className="h-4 w-4 accent-primary"
              />
              {e.label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-on-surface-variant">
        Events include only channels its owner can see. Each request is signed with a secret you get
        once.
      </p>
      <FieldError message={error} />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={textBtn}>
          Cancel
        </button>
        <button disabled={busy} onClick={() => void save()} className={filledBtn}>
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

const statusCls: Record<Delivery['status'], string> = {
  delivered: 'bg-status-green',
  pending: 'bg-tertiary',
  failed: 'bg-error',
}

function DeliveryLog({ server, hook }: { server: string; hook: number }) {
  const [list, setList] = useState<Delivery[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    api
      .listDeliveries(server, hook)
      .then(setList)
      .catch((e: unknown) => setError(errorText(e)))
  }, [server, hook])
  useEffect(() => {
    load()
    const id = window.setInterval(load, 5000)
    return () => window.clearInterval(id)
  }, [load])
  if (error) return <FieldError message={error} />
  if (list === null) return <p className="px-2 py-1 text-xs text-on-surface-variant">Loading…</p>
  if (list.length === 0)
    return <p className="px-2 py-1 text-xs text-on-surface-variant">No deliveries yet.</p>
  return (
    <ul className="mt-1 flex flex-col gap-0.5 rounded-xl bg-surface-container p-2">
      {list.map(d => (
        <li key={d.id} className="flex flex-wrap items-center gap-x-2 text-xs">
          <span
            title={d.status}
            aria-label={d.status}
            className={`h-2 w-2 shrink-0 rounded-full ${statusCls[d.status]}`}
          />
          <span className="min-w-0 flex-1 truncate text-on-surface sm:w-28 sm:flex-none">
            {eventLabel(d.event)}
          </span>
          <span className="order-last basis-full truncate pl-4 text-on-surface-variant sm:order-none sm:min-w-0 sm:flex-1 sm:basis-auto sm:pl-0">
            {deliveryText(d)}
          </span>
          <span title={fullTimeOf(d.created_at)} className="shrink-0 text-on-surface-variant">
            {ago(d.created_at)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Outgoing({ server }: { server: string }) {
  const askConfirm = useStore(s => s.askConfirm)
  const showToast = useStore(s => s.showToast)
  const me = useStore(s => s.me?.username)
  const [data, setData] = useState<OutgoingList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [log, setLog] = useState<number | null>(null)
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null)

  const load = useCallback(() => {
    api
      .listOutgoing(server)
      .then(setData)
      .catch((e: unknown) => setError(errorText(e)))
  }, [server])
  useEffect(load, [load])

  const run = async (job: () => Promise<unknown>): Promise<string | null> => {
    setBusy(true)
    try {
      await job()
      load()
      return null
    } catch (e) {
      return errorText(e)
    } finally {
      setBusy(false)
    }
  }

  const create = (f: OutForm) =>
    run(async () => {
      const made = await api.createOutgoing(server, {
        name: f.name.trim(),
        url: f.url.trim(),
        events: f.events,
      })
      setCreating(false)
      setSecret({ name: made.name, value: made.secret })
    })

  const save = (hook: OutgoingWebhook, f: OutForm) =>
    run(async () => {
      await api.updateOutgoing(server, hook.id, {
        name: f.name.trim(),
        url: f.url.trim(),
        events: f.events,
      })
      setEditing(null)
    })

  const update = (hook: OutgoingWebhook) => (f: OutForm) => {
    if (!outgoingReach(hook, f) || !takesOver(hook.creator, me)) return save(hook, f)
    return new Promise<string | null>(resolve =>
      askConfirm({
        title: 'Change outgoing webhook',
        body: `Change where ${hook.name} sends events? ${OWNER_NOTE} It will then send only what you can see.`,
        confirm: 'Save',
        action: () => void save(hook, f).then(resolve),
      })
    )
  }

  const flip = (hook: OutgoingWebhook) =>
    void run(() => api.updateOutgoing(server, hook.id, { enabled: !hook.enabled })).then(setError)

  const toggle = (hook: OutgoingWebhook) =>
    hook.enabled || !takesOver(hook.creator, me)
      ? flip(hook)
      : askConfirm({
          title: 'Turn on outgoing webhook',
          body: `Turn on ${hook.name}? ${OWNER_NOTE} It will then send only what you can see.`,
          confirm: 'Turn on',
          action: () => flip(hook),
        })

  const test = (hook: OutgoingWebhook) =>
    void run(async () => {
      await api.testOutgoing(server, hook.id)
      setLog(hook.id)
      showToast('Test event queued')
    }).then(setError)

  const newSecret = (hook: OutgoingWebhook) =>
    askConfirm({
      title: 'New signing secret',
      body: `Make a new secret for ${hook.name}? Requests are signed with it from now on.${takesOver(hook.creator, me) ? ` ${OWNER_NOTE} It will then send only what you can see.` : ''}`,
      confirm: 'Make new secret',
      action: () =>
        void api
          .resetOutgoingSecret(server, hook.id)
          .then(made => {
            setSecret({ name: made.name, value: made.secret })
            load()
          })
          .catch((e: unknown) => setError(errorText(e))),
    })

  const remove = (hook: OutgoingWebhook) =>
    askConfirm({
      title: 'Delete outgoing webhook',
      body: `Delete ${hook.name}? Pending deliveries are dropped.`,
      confirm: 'Delete',
      action: () =>
        void api
          .deleteOutgoing(server, hook.id)
          .then(load)
          .catch((e: unknown) => setError(errorText(e))),
    })

  if (data === null)
    return error ? (
      <FieldError message={error} />
    ) : (
      <p className="px-2 text-sm text-on-surface-variant">Loading…</p>
    )
  const hostOf = (url: string) => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }
  return (
    <div>
      <p className="mb-3 text-sm text-on-surface-variant">
        Outgoing webhooks send events from this server to a URL you choose, as signed JSON.
      </p>
      {!data.available && (
        <p className="mb-3 rounded-xl bg-surface-container p-3 text-sm text-on-surface-variant">
          Outgoing webhooks are turned off on this instance. Nothing is sent until an instance admin
          turns them on.
        </p>
      )}
      {secret && (
        <SecretBox
          label={`Signing secret of ${secret.name}`}
          value={secret.value}
          note="Copy it now: it is shown only once. Check X-Webhook-Signature: sha256= plus the HMAC-SHA256 of the X-Webhook-Timestamp, a dot and the raw body. Reject timestamps more than 5 minutes off. X-Webhook-Delivery stays the same across retries."
          onDone={() => setSecret(null)}
        />
      )}
      <FieldError message={error} />
      {data.available &&
        (creating ? (
          <OutEditor
            initial={{ name: '', url: '', events: ['message.created'] }}
            busy={busy}
            submit={create}
            submitLabel="Create"
            onCancel={() => setCreating(false)}
          />
        ) : (
          <button
            onClick={() => setCreating(true)}
            disabled={data.webhooks.length >= OUTGOING_MAX}
            title={data.webhooks.length >= OUTGOING_MAX ? 'At most 10 per server' : undefined}
            className={`${filledBtn} flex items-center gap-1.5`}
          >
            <Plus size={16} />
            New outgoing webhook
          </button>
        ))}
      <p className={sectionCls + ' mt-4'}>Outgoing webhooks</p>
      {data.webhooks.length === 0 ? (
        <p className="px-2 text-sm text-on-surface-variant">None yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {data.webhooks.map(h => (
            <li key={h.id} className="rounded-xl px-2 py-2 hover:bg-surface-container">
              <div className="flex items-center gap-2">
                <span
                  title={h.enabled ? 'On' : 'Off'}
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${h.enabled ? 'bg-status-green' : 'bg-outline'}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-on-surface">
                    <Masked text={h.name} />
                  </p>
                  <p className="truncate text-xs text-on-surface-variant" title={h.url}>
                    {hostOf(h.url)} · {h.events.map(eventLabel).join(', ')}
                    {h.creator && (
                      <>
                        {' · by '}
                        <span className="streamer">
                          <Masked text={h.creator.display_name} />
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <button
                  title={h.enabled ? 'Turn off' : 'Turn on'}
                  aria-label={h.enabled ? `Turn off ${h.name}` : `Turn on ${h.name}`}
                  aria-pressed={h.enabled}
                  disabled={busy || (!h.enabled && !data.available)}
                  onClick={() => toggle(h)}
                  className={`${iconBtn} disabled:opacity-40`}
                >
                  <Power size={16} />
                </button>
                <button
                  title="Send test event"
                  aria-label={`Send a test event to ${h.name}`}
                  disabled={busy || !h.enabled || !data.available}
                  onClick={() => test(h)}
                  className={`${iconBtn} disabled:opacity-40`}
                >
                  <Send size={16} />
                </button>
                <button
                  title="Edit"
                  aria-label={`Edit ${h.name}`}
                  onClick={() => setEditing(editing === h.id ? null : h.id)}
                  className={iconBtn}
                >
                  <Pencil size={16} />
                </button>
                <button
                  title="New secret"
                  aria-label={`New secret for ${h.name}`}
                  onClick={() => newSecret(h)}
                  className={iconBtn}
                >
                  <KeyRound size={16} />
                </button>
                <button
                  title="Delete"
                  aria-label={`Delete ${h.name}`}
                  onClick={() => remove(h)}
                  className={`${iconBtn} hover:text-error`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              {h.disabled_at !== null && !h.enabled && (
                <p className="mt-1.5 rounded-lg bg-error-container px-2.5 py-1.5 text-xs text-on-error-container">
                  {h.disabled_reason === 'owner'
                    ? `Turned off ${ago(h.disabled_at)}: its owner is no longer in this server. Turning it back on makes you the owner.`
                    : `Turned off ${ago(h.disabled_at)} after 10 failed deliveries in a row. Check the URL, then turn it back on.`}
                </p>
              )}
              {editing === h.id && (
                <div className="mt-2">
                  <OutEditor
                    initial={{ name: h.name, url: h.url, events: h.events }}
                    busy={busy}
                    submit={update(h)}
                    submitLabel="Save"
                    onCancel={() => setEditing(null)}
                  />
                </div>
              )}
              <button
                onClick={() => setLog(log === h.id ? null : h.id)}
                aria-expanded={log === h.id}
                className={`${textBtn} mt-1 flex items-center gap-1 px-2 py-1 text-xs`}
              >
                <ChevronDown
                  size={14}
                  className={`transition-transform ${log === h.id ? 'rotate-180' : ''}`}
                />
                Recent deliveries
              </button>
              {log === h.id && <DeliveryLog server={server} hook={h.id} />}
            </li>
          ))}
        </ul>
      )}
      {data.webhooks.length > 0 && (
        <p className="mt-3 px-2 text-xs text-on-surface-variant">
          Failed deliveries are retried 5 times over about 40 minutes. The log keeps status codes
          and timings for 7 days.
        </p>
      )}
    </div>
  )
}
