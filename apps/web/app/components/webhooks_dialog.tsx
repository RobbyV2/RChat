'use client'

import { Covered } from './covered'
import { ask, sendTo } from '../lib/asks'
import { asAccount, pictured } from '../lib/people'
import { instanceName, personCalled, personName } from '../lib/names'
import { Name } from './name'
import { useAccount } from '../lib/client/react'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  KeyRound,
  Pencil,
  Plus,
  Power,
  Send,
  Trash2,
} from 'lucide-react'
import { errorText, useStore } from '../lib/store'
import { sharing } from '../lib/platform'
import { fullTimeOf, relativeTime } from '../lib/timestamps'
import type { AvatarKind, Channel, UserRef } from '../lib/types'
import {
  OUTGOING_EVENTS,
  OUTGOING_MAX,
  OWNER_NOTE,
  deliveryText,
  eventLabel,
  nameProblem,
  outgoingReach,
  outgoingUrl,
  TAKEOVER_URL,
  takeoverUrlProblem,
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
import { Button, IconButton, Tab } from './controls'
import { Grid, Row, Stack, Surface } from './layout'
import { Dialog, FieldError, fieldCls, Masked, sectionCls } from './ui'
import { useCopied } from '../lib/use_copied'
import { useInstanceLabel } from './instance_badge'
import { time } from '../lib/platform/time'

// Who made a webhook, on its own line under its details.
export function CreatorNote({ creator }: { creator: UserRef }) {
  return (
    <Row as="p" gap="2xs">
      <span className="shrink-0 text-xs text-on-surface-variant">by</span>
      <Name
        of={personName(asAccount(creator, 'webhook'))}
        withUsername
        look="flex min-w-0 text-xs text-on-surface-variant"
      />
    </Row>
  )
}

const DEFAULT_COLOR = '#5c6bc0'

const ago = (seconds: number) => relativeTime(seconds * 1000, time().now())

export default function WebhooksDialog() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'webhooks' ? <Webhooks server={dialog.server} /> : null
}

type Tab = 'incoming' | 'outgoing'

function Webhooks({ server }: { server: string }) {
  const openDialog = useStore(s => s.openDialog)
  const [tab, setTab] = useState<Tab>('incoming')
  const back = () => openDialog({ kind: 'server_settings', server, section: 'integrations' })
  return (
    <Dialog full title="Webhooks" onClose={back}>
      <Stack gap="lg">
        <div className="rounded-full bg-surface-container">
          <Surface pad="2xs" tone="plain">
            <Row role="tablist" gap="2xs">
              <Tab selected={tab === 'incoming'} onClick={() => setTab('incoming')} place="flex-1">
                Incoming
              </Tab>
              <Tab selected={tab === 'outgoing'} onClick={() => setTab('outgoing')} place="flex-1">
                Outgoing
              </Tab>
            </Row>
          </Surface>
        </div>
        {tab === 'incoming' ? <Incoming server={server} /> : <Outgoing server={server} />}
      </Stack>
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
    <div className="rounded-2xl border border-primary bg-primary-container/30">
      <Surface pad="md" gap="sm" tone="plain">
        <p className="text-sm font-medium text-on-surface">{label}</p>
        <Row gap="sm">
          <Surface pad="sm" tone="highest" radius="md" place="min-w-0 flex-1">
            <Covered
              what="secret"
              as="code"
              look="font-mono text-xs break-all text-on-surface select-all"
            >
              {value}
            </Covered>
          </Surface>
          <IconButton
            icon={copied ? Check : Copy}
            label={copied ? 'Copied' : 'Copy'}
            onClick={() => void sharing().copyText(value).then(flash)}
          />
        </Row>
        <p className="text-xs text-on-surface-variant">{note}</p>
        <Button onClick={onDone} place="self-end">
          Done
        </Button>
      </Surface>
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
    <Stack as="label" gap="2xs">
      <span className="text-sm text-on-surface-variant">Channel</span>
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
    </Stack>
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
    <Surface pad="md" gap="md" tone="base">
      <Stack as="label" gap="2xs">
        <span className="text-sm text-on-surface-variant">Name</span>
        <input
          value={form.name}
          maxLength={80}
          onChange={e => setForm({ ...form, name: e.target.value })}
          placeholder="Deploy bot"
          className={`${fieldCls} text-on-surface`}
        />
      </Stack>
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
      <Row gap="sm" justify="end">
        {onCancel && (
          <Button size="md" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          variant="filled"
          size="md"
          disabled={busy || form.channel === null}
          onClick={() => void save()}
        >
          {submitLabel}
        </Button>
      </Row>
    </Surface>
  )
}

function Incoming({ server }: { server: string }) {
  const account = useAccount()
  const { shareOrigin } = account
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
    sendTo(account, ask.listWebhooks(server))
      .then(setList)
      .catch((e: unknown) => setError(errorText(e)))
  }, [server])
  useEffect(load, [load])

  const channelName = (id: number) => channels.find(c => c.id === id)?.name ?? 'unknown'
  const reveal = (name: string, path: string) =>
    setSecret({ name, url: webhookUrl(shareOrigin, path) })

  const create = async (f: HookForm): Promise<string | null> => {
    if (f.channel === null) return 'Pick a channel'
    setBusy(true)
    try {
      const made = await sendTo(
        account,
        ask.createWebhook(server, {
          channel_id: f.channel,
          name: f.name.trim(),
          avatar_kind: f.kind,
          avatar_color: f.kind === 'color' ? f.color : null,
        })
      )
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
      await sendTo(
        account,
        ask.updateWebhook(server, hook.id, {
          name: f.name.trim(),
          channel_id: f.channel ?? hook.channel_id,
          avatar_kind: f.kind,
          avatar_color: f.kind === 'color' ? f.color : null,
        })
      )
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
        void sendTo(account, ask.resetWebhookToken(server, hook.id))
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
        void sendTo(account, ask.deleteWebhook(server, hook.id))
          .then(load)
          .catch((e: unknown) => setError(errorText(e))),
    })

  const first = channels[0]?.id ?? null
  return (
    <Stack gap="2xl">
      <Stack gap="md">
        <p className="text-sm text-on-surface-variant">
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
          <Button
            variant="filled"
            size="md"
            icon={Plus}
            onClick={() => setCreating(true)}
            disabled={channels.length === 0}
            place="self-start"
          >
            New webhook
          </Button>
        )}
      </Stack>
      <section>
        <p className={sectionCls}>Webhooks</p>
        {list === null ? (
          <Surface pad="sm" inset="bar" tone="plain">
            <p className="text-sm text-on-surface-variant">Loading…</p>
          </Surface>
        ) : list.length === 0 ? (
          <Surface pad="sm" inset="bar" tone="plain">
            <p className="text-sm text-on-surface-variant">No webhooks yet.</p>
          </Surface>
        ) : (
          <Stack as="ul" gap="2xs">
            {list.map(h => (
              <li key={h.id} className="rounded-xl hover:bg-surface-container">
                <Surface pad="sm" gap="sm" tone="plain">
                  <Row gap="md">
                    <UserAvatar
                      person={pictured(
                        `@webhook:${h.id}`,
                        { kind: h.avatar_kind, color: h.avatar_color },
                        'webhook'
                      )}
                      size={32}
                    />
                    <div className="min-w-0 flex-1">
                      <Name
                        as="p"
                        of={personCalled(h.name, h.creator?.username)}
                        look="truncate text-sm font-medium text-on-surface"
                      />
                      <p className="truncate text-xs text-on-surface-variant">
                        #{channelName(h.channel_id)}
                        {' · '}
                        <span title={h.last_used_at ? fullTimeOf(h.last_used_at) : undefined}>
                          {h.last_used_at ? `used ${ago(h.last_used_at)}` : 'never used'}
                        </span>
                      </p>
                      {h.creator && <CreatorNote creator={h.creator} />}
                    </div>
                    <IconButton
                      icon={Pencil}
                      label={`Edit ${h.name}`}
                      tooltip="Edit"
                      onClick={() => setEditing(editing === h.id ? null : h.id)}
                    />
                    <IconButton
                      icon={KeyRound}
                      label={`New URL for ${h.name}`}
                      tooltip="New URL"
                      onClick={() => resetUrl(h)}
                    />
                    <IconButton
                      icon={Trash2}
                      label={`Delete ${h.name}`}
                      tooltip="Delete"
                      tone="danger"
                      onClick={() => remove(h)}
                    />
                  </Row>
                  {editing === h.id && (
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
                  )}
                </Surface>
              </li>
            ))}
          </Stack>
        )}
      </section>
    </Stack>
  )
}

interface OutForm {
  name: string
  url: string
  events: string[]
}

function OutEditor({
  initial,
  urlHidden = false,
  busy,
  submit,
  submitLabel,
  onCancel,
}: {
  initial: OutForm
  urlHidden?: boolean
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
    const problem =
      nameProblem(form.name) ?? (urlHidden && !form.url.trim() ? null : urlProblem(form.url))
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
    <Surface pad="md" gap="md" tone="base">
      <Stack as="label" gap="2xs">
        <span className="text-sm text-on-surface-variant">Name</span>
        <input
          value={form.name}
          maxLength={80}
          onChange={e => setForm({ ...form, name: e.target.value })}
          placeholder="Moderation log"
          className={`${fieldCls} text-on-surface`}
        />
      </Stack>
      <Stack as="label" gap="2xs">
        <span className="text-sm text-on-surface-variant">URL</span>
        <input
          value={form.url}
          type="url"
          inputMode="url"
          onChange={e => setForm({ ...form, url: e.target.value })}
          placeholder={urlHidden ? 'Keep the current URL' : 'https://example.com/hooks/chat'}
          className={`${fieldCls} text-on-surface`}
        />
        {urlHidden && (
          <span className="text-xs text-on-surface-variant">
            Only the owner sees the whole URL. Leave this empty to keep it.
          </span>
        )}
      </Stack>
      <Stack as="fieldset" gap="2xs">
        <legend className="text-sm text-on-surface-variant">Events</legend>
        <Grid cols={{ base: 1, sm: 2 }} gap="2xs">
          {OUTGOING_EVENTS.map(e => (
            <Row as="label" key={e.key} gap="sm" text="sm" ink="strong" look="min-h-9">
              <input
                type="checkbox"
                checked={form.events.includes(e.key)}
                onChange={() => toggle(e.key)}
                className="h-4 w-4 accent-primary"
              />
              {e.label}
            </Row>
          ))}
        </Grid>
      </Stack>
      <p className="text-xs text-on-surface-variant">
        Events include only channels its owner can see. Each request is signed with a secret you get
        once.
      </p>
      <FieldError message={error} />
      <Row gap="sm" justify="end">
        <Button size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="filled" size="md" disabled={busy} onClick={() => void save()}>
          {submitLabel}
        </Button>
      </Row>
    </Surface>
  )
}

// Taking over someone else's webhook: its owner's URL path is never shown, so the new owner
// types the whole destination URL.
function TakeoverForm({
  hook,
  host,
  kind,
  busy,
  submit,
  onCancel,
}: {
  hook: OutgoingWebhook
  host: string
  kind: 'on' | 'secret'
  busy: boolean
  submit: (url: string) => Promise<string | null>
  onCancel: () => void
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    const problem = takeoverUrlProblem(url)
    if (problem) return setError(problem)
    setError(await submit(url.trim()))
  }
  return (
    <Surface role="group" aria-label={`Take over ${hook.name}`} pad="md" gap="md" tone="base">
      <p className="text-sm text-on-surface">
        {kind === 'on'
          ? `Turn on ${hook.name}? `
          : `Make a new secret for ${hook.name}? Requests are signed with it from now on. `}
        {OWNER_NOTE} It will then send only what you can see.
      </p>
      <Stack as="label" gap="2xs">
        <span className="text-sm text-on-surface-variant">Destination URL</span>
        <input
          value={url}
          type="url"
          inputMode="url"
          autoFocus
          onChange={e => setUrl(e.target.value)}
          placeholder={`https://${host}/…`}
          className={`${fieldCls} text-on-surface`}
        />
        <span className="text-xs text-on-surface-variant">
          It sends to {host}. Only the owner sees the whole URL, so enter it in full.
        </span>
      </Stack>
      <FieldError message={error} />
      <Row gap="sm" justify="end">
        <Button size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="filled" size="md" disabled={busy} onClick={() => void go()}>
          {kind === 'on' ? 'Turn on' : 'Make new secret'}
        </Button>
      </Row>
    </Surface>
  )
}

const statusCls: Record<Delivery['status'], string> = {
  delivered: 'bg-status-green',
  pending: 'bg-tertiary',
  failed: 'bg-error',
}

function DeliveryNote({ children }: { children: ReactNode }) {
  return (
    <Surface pad="sm" inset="bar" tone="plain">
      <p className="text-xs text-on-surface-variant">{children}</p>
    </Surface>
  )
}

function DeliveryLog({ server, hook }: { server: string; hook: number }) {
  const account = useAccount()
  const [list, setList] = useState<Delivery[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    sendTo(account, ask.listDeliveries(server, hook))
      .then(setList)
      .catch((e: unknown) => setError(errorText(e)))
  }, [server, hook])
  useEffect(() => {
    load()
    const id = time().every(5000, load)
    return () => id()
  }, [load])
  if (error) return <FieldError message={error} />
  if (list === null) return <DeliveryNote>Loading…</DeliveryNote>
  if (list.length === 0) return <DeliveryNote>No deliveries yet.</DeliveryNote>
  return (
    <Surface as="ul" pad="sm" gap="3xs" tone="base" radius="lg">
      {list.map(d => (
        <Row as="li" key={d.id} gap="sm" wrap>
          <span
            title={d.status}
            aria-label={d.status}
            className={`h-2 w-2 shrink-0 rounded-full ${statusCls[d.status]}`}
          />
          <span className="min-w-0 flex-1 truncate text-xs text-on-surface sm:w-28 sm:flex-none">
            {eventLabel(d.event)}
          </span>
          <span className="order-last basis-full truncate text-xs text-on-surface-variant sm:order-none sm:min-w-0 sm:flex-1 sm:basis-auto">
            {deliveryText(d)}
          </span>
          <span
            title={fullTimeOf(d.created_at)}
            className="shrink-0 text-xs text-on-surface-variant"
          >
            {ago(d.created_at)}
          </span>
        </Row>
      ))}
    </Surface>
  )
}

function Outgoing({ server }: { server: string }) {
  const account = useAccount()
  const {
    lifetime: { inSession },
  } = account
  const { label } = useInstanceLabel()
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
  const [taking, setTaking] = useState<{ id: number; kind: 'on' | 'secret' } | null>(null)

  const load = useCallback(() => {
    sendTo(account, ask.listOutgoing(server))
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
      const made = await sendTo(
        account,
        ask.createOutgoing(server, {
          name: f.name.trim(),
          url: f.url.trim(),
          events: f.events,
        })
      )
      setCreating(false)
      setSecret({ name: made.name, value: made.secret })
    })

  const save = (hook: OutgoingWebhook, f: OutForm) =>
    run(async () => {
      await sendTo(
        account,
        ask.updateOutgoing(server, hook.id, {
          name: f.name.trim(),
          url: outgoingUrl(hook, f.url),
          events: f.events,
        })
      )
      setEditing(null)
    })

  const update = (hook: OutgoingWebhook) => (f: OutForm) => {
    if (!outgoingReach(hook, f) || !takesOver(hook.creator, me)) return save(hook, f)
    if (outgoingUrl(hook, f.url) === undefined) return Promise.resolve(TAKEOVER_URL)
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
    void run(() =>
      sendTo(account, ask.updateOutgoing(server, hook.id, { enabled: !hook.enabled }))
    ).then(setError)

  const toggle = (hook: OutgoingWebhook) =>
    hook.enabled || !takesOver(hook.creator, me)
      ? flip(hook)
      : setTaking({ id: hook.id, kind: 'on' })

  const takeOver = (hook: OutgoingWebhook, kind: 'on' | 'secret', url: string) =>
    run(async () => {
      if (kind === 'on')
        await sendTo(account, ask.updateOutgoing(server, hook.id, { enabled: true, url }))
      else {
        const made = await sendTo(account, ask.resetOutgoingSecret(server, hook.id, url))
        setSecret({ name: made.name, value: made.secret })
      }
      setTaking(null)
    })

  const test = (hook: OutgoingWebhook) => {
    const queued = inSession(showToast)
    void run(async () => {
      await sendTo(account, ask.testOutgoing(server, hook.id))
      setLog(hook.id)
      queued('Test event queued')
    }).then(setError)
  }

  const newSecret = (hook: OutgoingWebhook) =>
    takesOver(hook.creator, me)
      ? setTaking({ id: hook.id, kind: 'secret' })
      : askConfirm({
          title: 'New signing secret',
          body: `Make a new secret for ${hook.name}? Requests are signed with it from now on.`,
          confirm: 'Make new secret',
          action: () =>
            void sendTo(account, ask.resetOutgoingSecret(server, hook.id))
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
        void sendTo(account, ask.deleteOutgoing(server, hook.id))
          .then(load)
          .catch((e: unknown) => setError(errorText(e))),
    })

  if (data === null)
    return error ? (
      <FieldError message={error} />
    ) : (
      <Surface pad="sm" inset="bar" tone="plain">
        <p className="text-sm text-on-surface-variant">Loading…</p>
      </Surface>
    )
  const hostOf = (url: string) => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }
  return (
    <Stack gap="2xl">
      <Stack gap="md">
        <p className="text-sm text-on-surface-variant">
          Outgoing webhooks send events from this server to a URL you choose, as signed JSON.
        </p>
        {!data.available && (
          <Surface pad="md" tone="base" radius="lg">
            <p className="text-sm text-on-surface-variant">
              Outgoing webhooks are turned off on <Name of={instanceName(label)} />. Nothing is sent
              until an instance admin turns them on.
            </p>
          </Surface>
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
            <Button
              variant="filled"
              size="md"
              icon={Plus}
              onClick={() => setCreating(true)}
              disabled={data.webhooks.length >= OUTGOING_MAX}
              title={data.webhooks.length >= OUTGOING_MAX ? 'At most 10 per server' : undefined}
              place="self-start"
            >
              New outgoing webhook
            </Button>
          ))}
      </Stack>
      <section>
        <p className={sectionCls}>Outgoing webhooks</p>
        {data.webhooks.length === 0 ? (
          <Surface pad="sm" inset="bar" tone="plain">
            <p className="text-sm text-on-surface-variant">None yet.</p>
          </Surface>
        ) : (
          <Stack as="ul" gap="2xs">
            {data.webhooks.map(h => (
              <li key={h.id} className="rounded-xl hover:bg-surface-container">
                <Surface pad="sm" gap="sm" tone="plain">
                  <Row gap="sm">
                    <span
                      title={h.enabled ? 'On' : 'Off'}
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${h.enabled ? 'bg-status-green' : 'bg-outline'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-on-surface">
                        <Masked text={h.name} by={h.creator?.username} />
                      </p>
                      <p
                        className="truncate text-xs text-on-surface-variant"
                        title={h.url_hidden ? `${h.url} (path hidden)` : h.url}
                      >
                        {hostOf(h.url)} · {h.events.map(eventLabel).join(', ')}
                      </p>
                      {h.creator && <CreatorNote creator={h.creator} />}
                    </div>
                    <IconButton
                      icon={Power}
                      label={h.enabled ? `Turn off ${h.name}` : `Turn on ${h.name}`}
                      tooltip={h.enabled ? 'Turn off' : 'Turn on'}
                      pressed={h.enabled}
                      disabled={busy || (!h.enabled && !data.available)}
                      onClick={() => toggle(h)}
                    />
                    <IconButton
                      icon={Send}
                      label={`Send a test event to ${h.name}`}
                      tooltip="Send test event"
                      disabled={busy || !h.enabled || !data.available}
                      onClick={() => test(h)}
                    />
                    <IconButton
                      icon={Pencil}
                      label={`Edit ${h.name}`}
                      tooltip="Edit"
                      onClick={() => setEditing(editing === h.id ? null : h.id)}
                    />
                    <IconButton
                      icon={KeyRound}
                      label={`New secret for ${h.name}`}
                      tooltip="New secret"
                      onClick={() => newSecret(h)}
                    />
                    <IconButton
                      icon={Trash2}
                      label={`Delete ${h.name}`}
                      tooltip="Delete"
                      tone="danger"
                      onClick={() => remove(h)}
                    />
                  </Row>
                  {h.disabled_at !== null && !h.enabled && (
                    <Surface pad="sm" tone="error" radius="md">
                      <p className="text-xs text-on-error-container">
                        {h.disabled_reason === 'owner'
                          ? `Turned off ${ago(h.disabled_at)}: its owner is no longer in this server. Turning it back on makes you the owner.`
                          : `Turned off ${ago(h.disabled_at)} after 10 failed deliveries in a row. Check the URL, then turn it back on.`}
                      </p>
                    </Surface>
                  )}
                  {taking?.id === h.id && (
                    <TakeoverForm
                      hook={h}
                      host={hostOf(h.url)}
                      kind={taking.kind}
                      busy={busy}
                      submit={url => takeOver(h, taking.kind, url)}
                      onCancel={() => setTaking(null)}
                    />
                  )}
                  {editing === h.id && (
                    <OutEditor
                      initial={{ name: h.name, url: h.url_hidden ? '' : h.url, events: h.events }}
                      urlHidden={h.url_hidden}
                      busy={busy}
                      submit={update(h)}
                      submitLabel="Save"
                      onCancel={() => setEditing(null)}
                    />
                  )}
                  <Button
                    icon={log === h.id ? ChevronUp : ChevronDown}
                    onClick={() => setLog(log === h.id ? null : h.id)}
                    aria-expanded={log === h.id}
                    place="self-start"
                  >
                    Recent deliveries
                  </Button>
                  {log === h.id && <DeliveryLog server={server} hook={h.id} />}
                </Surface>
              </li>
            ))}
          </Stack>
        )}
        {data.webhooks.length > 0 && (
          <Surface pad="sm" inset="bar" tone="plain">
            <p className="text-xs text-on-surface-variant">
              Failed deliveries are retried 5 times over about 40 minutes. The log keeps status
              codes and timings for 7 days.
            </p>
          </Surface>
        )}
      </section>
    </Stack>
  )
}
