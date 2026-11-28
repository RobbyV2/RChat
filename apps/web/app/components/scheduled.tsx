'use client'
import { OwnLoadNotice } from './own_load'

// Send later and scheduled messages, the same for hosted and P2P places: the composers' Send
// button and chip, the lists, the date and time picker, the account-wide view and the prompt
// for P2P messages that were due while the app was closed.

import { Name } from './name'
import { personCalled, serverCalled } from '../lib/names'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { CalendarClock, Pencil, RotateCcw, SendHorizontal, Trash2 } from 'lucide-react'
import { useAccount, useClock } from '../lib/client/react'
import { useP2p, useP2pApp } from '../lib/client/p2p_react'
import type { AccountSession } from '../lib/client/session'
import { actionPress, openActionMenu, openChoiceMenu } from '../lib/actions/menu'
import { registerAppActions } from '../lib/actions'
import { setOpenComposer } from '../lib/actions/scheduled'
import { laterKey } from '../lib/keys'
import { limitsOf } from '../lib/instance_limits'
import { LIMITS as P2P_LIMITS } from '../lib/p2p/content'
import { previewText } from '../lib/invite'
import {
  chipText,
  chipTitle,
  type ComposerDraft,
  countsFor,
  fromLocalInput,
  isUnsent,
  localInput,
  NOWHERE,
  PICK_MIN_MS,
  pickProblem,
  presetTime,
  SCHEDULE_MAX_MS,
  type ScheduledItem,
  type ScheduledLabel,
  type ScheduledOps,
  type ScheduledRow,
  type ScheduledSide,
  sortItems,
  stateText,
  whenText,
  whenTitle,
} from '../lib/scheduled'
import { useStore } from '../lib/store'
import type { Target } from '../lib/actions/types'
import { longPress, useMedia } from './context_menu'
import { MessageEditor, type EditBinding } from './message_editor'
import { Badge, Button, IconButton, SectionHeading } from './controls'
import { Row, Stack, Surface } from './layout'
import { Dialog, FieldError, fieldCls, Masked } from './ui'
import { ViewActorTag } from './view_actor'

const composerTarget = (now: () => ComposerDraft | null): Target => ({ kind: 'composer', now })

// The Send later menu at the Send button.
export const openLaterMenu = (
  el: Element | null,
  now: () => ComposerDraft | null,
  acct: AccountSession
) => {
  registerAppActions()
  const r = el?.getBoundingClientRect()
  openActionMenu(r ? r.left : 0, r ? r.top : 0, composerTarget(now), {}, acct)
}

// Send later at a composer: the draft its menu and the palette read, the Send button the menu
// opens at, and the menu key.
export const useSendLater = (read: () => ComposerDraft | null) => {
  const acct = useAccount()
  const latest = useRef(read)
  useEffect(() => {
    latest.current = read
  })
  const draft = useCallback(() => latest.current(), [])
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => setOpenComposer(acct, draft), [acct, draft])
  return useMemo(
    () => ({
      draft,
      button,
      focused: () => {
        setOpenComposer(acct, draft)
      },
      key: (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!laterKey(e)) return false
        e.preventDefault()
        openLaterMenu(button.current, draft, acct)
        return true
      },
    }),
    [acct, draft]
  )
}

// The composers' Send button: a click sends, right-click, long-press and the menu key open Send
// later.
export function SendButton({
  title,
  disabled,
  onSend,
  draft,
  buttonRef,
}: {
  title: string
  disabled: boolean
  onSend: () => void
  draft: () => ComposerDraft | null
  buttonRef?: RefObject<HTMLButtonElement | null>
}) {
  const acct = useAccount()
  const fine = useMedia('(pointer: fine)')
  const press = longPress((x, y) => {
    registerAppActions()
    openActionMenu(x, y, composerTarget(draft), {}, acct)
  })
  return (
    <IconButton
      ref={buttonRef}
      icon={SendHorizontal}
      label="Send"
      tooltip={fine && !disabled ? `${title} (right-click to send later)` : title}
      tone="filled"
      tight
      aria-haspopup="menu"
      data-send-button
      disabled={disabled}
      onClick={onSend}
      {...press}
    />
  )
}

// The ops of this account's hosted rows.
export const useHostedOps = (): ScheduledOps => {
  const max = useStore(s => limitsOf(s.instance).message_chars)
  const edit = useStore(s => s.editScheduled)
  const removeReply = useStore(s => s.removeScheduledReply)
  const reschedule = useStore(s => s.rescheduleScheduled)
  const sendNow = useStore(s => s.sendScheduledNow)
  const remove = useStore(s => s.deleteScheduled)
  return useMemo(
    () => ({ side: 'hosted', max, edit, removeReply, reschedule, sendNow, remove }),
    [max, edit, removeReply, reschedule, sendNow, remove]
  )
}

// The ops of this identity's device rows; null without P2P here.
export const useDeviceOps = (): ScheduledOps | null => {
  const identity = useP2pApp()
  return useMemo(() => {
    const p = identity?.p2pScheduled
    if (!p) return null
    return {
      side: 'device',
      max: P2P_LIMITS.body,
      edit: p.edit,
      removeReply: p.removeReply,
      reschedule: p.reschedule,
      sendNow: p.sendNow,
      remove: p.remove,
    }
  }, [identity])
}

export const useHostedItems = () => {
  const items = useStore(s => s.scheduled.items)
  return useMemo(() => Object.values(items), [items])
}

export const useDeviceItems = (): ScheduledItem[] => useP2p(s => s.scheduled)

// "2 scheduled, 1 not sent" above a composer, opening the place's list.
export function ScheduledChip({
  place,
  items,
  ops,
}: {
  place: string
  items: ScheduledItem[]
  ops: ScheduledOps | null
}) {
  const [open, setOpen] = useState(false)
  const counts = countsFor(items, place)
  const text = chipText(counts)
  const here = useMemo(() => items.filter(i => i.place === place), [items, place])
  if (!text && !open) return null
  const label = chipTitle(counts)
  return (
    <>
      {text && (
        <Row gap="none" justify="end">
          <Button
            variant={counts.unsent ? 'danger' : 'tonal'}
            icon={CalendarClock}
            title={label}
            data-scheduled-chip
            onClick={() => setOpen(true)}
          >
            {text}
          </Button>
        </Row>
      )}
      {open && ops && (
        <Dialog title="Scheduled here" onClose={() => setOpen(false)}>
          <ScheduledList items={here} ops={ops} />
        </Dialog>
      )}
    </>
  )
}

function PlaceLine({ label }: { label: ScheduledLabel | null }) {
  if (!label) return <span>{NOWHERE}</span>
  if (label.person) return <Name of={personCalled(label.person, label.by)} />
  const channel = label.channel ? (
    <span className="streamer">
      #<Masked text={label.channel} />
    </span>
  ) : null
  if (label.thread) return <span>Thread in {channel ?? 'a channel'}</span>
  return (
    <span>
      {channel}
      {label.server && (
        <>
          {' · '}
          <Name of={serverCalled(label.server)} />
        </>
      )}
    </span>
  )
}

// One scheduled message: when, what, where (with `showPlace`), its state and its buttons.
function ScheduledRowView({
  item,
  ops,
  showPlace,
  editing,
  onEdit,
  onPick,
}: {
  item: ScheduledItem
  ops: ScheduledOps
  showPlace: boolean
  editing: boolean
  onEdit: (key: string | null) => void
  onPick: (key: string) => void
}) {
  const acct = useAccount()
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState(item.body)
  const clock = useClock()
  const [now] = useState(() => clock.now())
  const state = stateText(item)
  const report = (p: Promise<string | null>) => void p.then(e => setError(e))
  const row: ScheduledRow = {
    item,
    edit: () => {
      setText(item.body)
      onEdit(item.key)
    },
    sendNow: async () => setError(await ops.sendNow(item.key)),
    reschedule: async at => setError(await ops.reschedule(item.key, at)),
    pick: () => onPick(item.key),
    remove: async () => setError(await ops.remove(item.key)),
  }
  const target: Target = { kind: 'scheduled', now: () => row }
  const press = longPress((x, y) => {
    registerAppActions()
    openActionMenu(x, y, target, {}, acct)
  })
  const run = (id: string) => (e: React.MouseEvent) => {
    registerAppActions()
    actionPress(id, target, acct)?.(e.clientX, e.clientY)
  }
  const binding: EditBinding = {
    max: ops.max,
    text,
    listKey: `scheduled:${item.key}`,
    focus: 1,
    getText: () => text,
    setText,
    save: () => {
      if (!text.trim()) return
      void ops.edit(item.key, text).then(e => {
        setError(e)
        if (!e) onEdit(null)
      })
    },
    cancel: () => onEdit(null),
  }
  const unsent = isUnsent(item)
  return (
    <Surface
      as="li"
      pad="sm"
      gap="2xs"
      tone="plain"
      data-scheduled-row={item.key}
      {...(editing ? {} : press)}
    >
      <Row gap="sm" wrap>
        <span className="min-w-0 flex-1 text-sm font-medium" title={whenTitle(item.at)}>
          {whenText(item.at, now)}
        </span>
        {!editing && item.state !== 'sending' && (
          <Row gap="3xs" place="shrink-0">
            <IconButton icon={Pencil} label="Edit" size="sm" onClick={() => row.edit()} />
            <IconButton
              icon={unsent ? RotateCcw : SendHorizontal}
              label={unsent ? 'Retry' : 'Send now'}
              size="sm"
              onClick={run('scheduled_send_now')}
            />
            <IconButton
              icon={CalendarClock}
              label="Reschedule"
              size="sm"
              onClick={e => {
                registerAppActions()
                openChoiceMenu(e.clientX, e.clientY, 'scheduled_reschedule', target, {}, acct)
              }}
            />
            <IconButton
              icon={Trash2}
              label="Delete"
              size="sm"
              tone="danger"
              onClick={run('scheduled_delete')}
            />
          </Row>
        )}
      </Row>
      {editing ? (
        <Stack gap="2xs" align="start">
          <MessageEditor binding={binding} />
          {item.reply && (
            <Button onClick={() => report(ops.removeReply(item.key))}>Remove reply</Button>
          )}
        </Stack>
      ) : (
        <p className="min-w-0 truncate text-sm text-on-surface-variant">
          <Masked text={previewText(item.body)} />
        </p>
      )}
      {showPlace && (
        <p className="min-w-0 truncate text-xs text-on-surface-variant">
          <PlaceLine label={item.label} />
        </p>
      )}
      {(state || item.reply) && (
        <p className={`text-xs ${unsent ? 'text-error' : 'text-on-surface-variant'}`}>
          {[state, item.reply && !unsent ? 'Replying to a message' : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <FieldError message={error} />
    </Surface>
  )
}

// A list of scheduled messages: unsent first, then by time.
export function ScheduledList({
  items,
  ops,
  showPlace = false,
  focus,
}: {
  items: ScheduledItem[]
  ops: ScheduledOps
  showPlace?: boolean
  focus?: string
}) {
  const [editing, setEditing] = useState<string | null>(focus ?? null)
  const [picking, setPicking] = useState<string | null>(null)
  const sorted = useMemo(() => sortItems(items), [items])
  if (!sorted.length)
    return (
      <Surface pad="lg" gap="2xs" tone="plain" align="center" data-scheduled-empty>
        <CalendarClock size={20} className="text-on-surface-variant" />
        <p className="text-sm font-medium">Nothing scheduled</p>
        <p className="text-center text-xs text-on-surface-variant">
          Right-click or long-press Send to send a message later.
        </p>
      </Surface>
    )
  return (
    <>
      <Stack as="ul" gap="2xs">
        {sorted.map(item => (
          <ScheduledRowView
            key={item.key}
            item={item}
            ops={ops}
            showPlace={showPlace}
            editing={editing === item.key}
            onEdit={setEditing}
            onPick={setPicking}
          />
        ))}
      </Stack>
      {picking && (
        <SendLaterDialog
          side={ops.side}
          onClose={() => setPicking(null)}
          onPick={async at => {
            const e = await ops.reschedule(picking, at)
            if (!e) setPicking(null)
            return e
          }}
        />
      )}
    </>
  )
}

// The date and time picker of Send later and Reschedule.
export function SendLaterDialog({
  side,
  onPick,
  onClose,
}: {
  side: ScheduledSide
  onPick: (at: number) => Promise<string | null>
  onClose: () => void
}) {
  const clock = useClock()
  const [now, setNow] = useState(() => clock.now())
  const [value, setValue] = useState(() => localInput(presetTime('hour', new Date(clock.now()))))
  const [refused, setRefused] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => clock.every(30_000, () => setNow(clock.now())), [clock])
  const at = fromLocalInput(value)
  const problem = at === null ? 'Pick a date and time' : pickProblem(at, now)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const submit = async () => {
    if (at === null || problem || busy) return
    setBusy(true)
    const e = await onPick(at)
    setBusy(false)
    setRefused(e)
  }
  return (
    <Dialog title="Send later" onClose={onClose} layer="confirm">
      <Stack
        as="form"
        gap="md"
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault()
          void submit()
        }}
      >
        <input
          type="datetime-local"
          aria-label="Date and time"
          value={value}
          min={localInput(now + PICK_MIN_MS)}
          max={localInput(now + SCHEDULE_MAX_MS)}
          onChange={e => {
            setValue(e.target.value)
            setRefused(null)
          }}
          data-send-later-time
          className={`${fieldCls} w-full text-base`}
        />
        <p className="text-sm text-on-surface-variant">
          {at !== null && !problem ? `Sends ${whenText(at, now)}` : 'Pick when it sends'}
          {` · ${zone}`}
        </p>
        <p className="text-xs text-on-surface-variant">
          {side === 'device'
            ? 'Sends from this device. Keep the app open then.'
            : "Sends even if you're offline."}
        </p>
        <FieldError message={refused ?? (value ? problem : null)} />
        <Row gap="sm" justify="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="filled" size="md" disabled={!!problem} busy={busy}>
            Schedule
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

// The account's scheduled messages: the ones this site sends, and the ones this device sends.
export function ScheduledDialog() {
  const dialog = useStore(s => (s.activeDialog?.kind === 'scheduled' ? s.activeDialog : null))
  const closeDialog = useStore(s => s.closeDialog)
  const hostedOn = useStore(s => s.settings.scheduled_messages)
  const loadScheduled = useStore(s => s.loadScheduled)
  const loadScheduledCounts = useStore(s => s.loadScheduledCounts)
  const more = useStore(s => s.scheduled.pages[''] ?? null)
  const hosted = useHostedItems()
  const hostedOps = useHostedOps()
  const device = useDeviceItems()
  const deviceOps = useDeviceOps()
  const p2pHere = useP2p(s => s.enabled && !s.elsewhere)
  useEffect(() => {
    if (dialog) void loadScheduled('')
  }, [dialog, loadScheduled])
  if (!dialog) return null
  const showHosted = hostedOn || hosted.length > 0
  return (
    <Dialog title="Scheduled messages" onClose={closeDialog} full actor={<ViewActorTag header />}>
      <Stack gap="lg">
        {showHosted && (
          <Stack as="section" gap="2xs" data-scheduled-hosted>
            <SectionHeading>Sent by this site</SectionHeading>
            <OwnLoadNotice
              what="scheduled:"
              lead="Could not load the scheduled messages."
              retry={() => void loadScheduled('', more !== null)}
            />
            <OwnLoadNotice
              what="scheduled_counts"
              lead="Could not count the scheduled messages."
              retry={() => void loadScheduledCounts()}
            />
            <ScheduledList items={hosted} ops={hostedOps} showPlace focus={dialog.focus} />
            {more && (
              <Button place="self-center" onClick={() => void loadScheduled('', true)}>
                Load more
              </Button>
            )}
          </Stack>
        )}
        {deviceOps && p2pHere && (
          <Stack as="section" gap="2xs" data-scheduled-device>
            <SectionHeading>Sent from this device</SectionHeading>
            <ScheduledList items={device} ops={deviceOps} showPlace focus={dialog.focus} />
          </Stack>
        )}
      </Stack>
    </Dialog>
  )
}

// The inbox header's way to the scheduled messages, with the count of unsent ones.
export function ScheduledButton() {
  const openDialog = useStore(s => s.openDialog)
  const failed = useStore(s => s.scheduled.counts?.failed ?? 0)
  const missed = useP2p(s => s.scheduledMissed.length)
  const unsent = failed + missed
  const label = unsent ? `Scheduled messages, ${unsent} not sent` : 'Scheduled messages'
  return (
    <IconButton
      icon={CalendarClock}
      label={label}
      data-scheduled-open
      onClick={() => openDialog({ kind: 'scheduled' })}
    >
      {unsent > 0 && (
        <Badge aria-hidden place="absolute -top-1 -right-1">
          {unsent}
        </Badge>
      )}
    </IconButton>
  )
}

// P2P messages that were due while the app was closed: never sent without asking.
export function MissedDialog() {
  const identity = useP2pApp()
  const missed = useP2p(s => s.scheduledMissed)
  const items = useDeviceItems()
  const ops = useDeviceOps()
  const openDialog = useStore(s => s.openDialog)
  const [closed, setClosed] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const clock = useClock()
  const [now] = useState(() => clock.now())
  const shown = items.filter(i => missed.includes(i.key) && !closed.includes(i.key))
  if (!identity || !ops || !shown.length) return null
  const close = () => setClosed(c => [...c, ...shown.map(i => i.key)])
  if (shown.length > 1)
    return (
      <Dialog title="Scheduled messages not sent" onClose={close}>
        <Stack gap="md">
          <p className="text-sm text-on-surface-variant">
            These were due while the app was closed.
          </p>
          <ScheduledList items={shown} ops={ops} showPlace />
          <Row gap="sm" justify="end">
            <Button onClick={close}>Close</Button>
          </Row>
        </Stack>
      </Dialog>
    )
  const [one] = shown
  return (
    <Dialog title="Scheduled message not sent" onClose={close}>
      <Stack gap="md">
        <p className="text-sm">Send the message you scheduled for {whenText(one.at, now)} now?</p>
        <Surface pad="sm" gap="3xs" tone="base">
          <p className="truncate text-sm">
            <Masked text={previewText(one.body)} />
          </p>
          <p className="truncate text-xs text-on-surface-variant">
            <PlaceLine label={one.label} />
          </p>
        </Surface>
        <FieldError message={error} />
        <Row gap="sm" justify="end" wrap>
          <Button variant="danger" onClick={() => void ops.remove(one.key).then(setError)}>
            Delete
          </Button>
          <Button
            onClick={() => {
              close()
              openDialog({ kind: 'scheduled', focus: one.key })
            }}
          >
            Edit
          </Button>
          <Button
            variant="filled"
            size="md"
            onClick={() => void ops.sendNow(one.key).then(setError)}
          >
            Send
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}
