'use client'
import { identityPerson } from '../../lib/people'
import { Button, IconButton, ListRow, LinkButton } from '../controls'
import { localInput } from '../../lib/scheduled'
import { client } from '../../lib/client/client'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'
import type { P2pApp } from '../../lib/p2p/app/runtime'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CircleAlert, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { type P2pDialog } from '../../lib/p2p/app'
import { displayName } from '../../lib/p2p/contacts'
import {
  actParts,
  APPLY_ANYWAY,
  CARRY_FAILED_TEXT,
  carryWaitText,
  CO_OWNERS_MAX,
  CO_OWNERS_MAX_TEXT,
  CO_OWNERS_TEXT,
  CONFLICT_TEXT,
  DEVICES_TEXT,
  DISPUTED_TEXT,
  INVITE_AGAIN,
  lostOthersText,
  lostTimes,
  lostText,
  MIGRATE_DIFF_TEXT,
  OWN_RESIGN_TEXT,
  reachedText,
  REAPPLY_TEXT,
  RECOVERY_TEXT,
  SYNC_WAIT_TEXT,
  SYNCING_TEXT,
  TRANSFER_CO_OWNERS_TEXT,
} from '../../lib/p2p/flows'
import { reapplyLine } from '../../lib/p2p/roles'
import type { ServerView } from '../../lib/p2p/server'
import { ownsP2pServer } from '../../lib/p2p/server/types'
import { Dialog, fieldCls, Masked } from '../ui'
import { KeyAvatar } from './p2p_badge'
import { Row, Stack, Surface } from '../layout'
import { andMore, fewOf, nextPage, page, PAGE } from '../../lib/paging'
import { time as appTime } from '../../lib/platform/time'

// The flows of P2P servers the user takes part in: actions waiting for sync, removals
// that took others along, moderation to apply again, a device that conflicts with a copy of
// itself, sync progress, co-owner requests, and our devices.

// A notice of a server, on its own surface: its parts on a line that wraps.
function Note({
  tone = 'base',
  children,
  ...rest
}: {
  tone?: 'base' | 'error'
  children: ReactNode
  role: 'status' | 'alert'
  [data: `data-${string}`]: string | boolean | undefined
}) {
  return (
    <Surface {...rest} pad="lg" tone={tone}>
      <div
        className={`flex flex-wrap items-center gap-3 text-sm${tone === 'base' ? ' text-on-surface-variant' : ''}`}
      >
        {children}
      </div>
    </Surface>
  )
}

// A member's name in a line, blurred in streamer mode.
function Who({ room, ik }: { room: string; ik: string }) {
  const identity = useP2pApp()!
  const { memberName } = identity

  const own = useP2p(s => s.me === ik)
  return (
    <span className="streamer font-medium text-on-surface">
      <Masked text={memberName(room, ik)} own={own} />
    </span>
  )
}

// Names inline: a few, then "and N more", which shows the rest 50 at a time.
function NameList({ room, iks }: { room: string; iks: string[] }) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const { first, more } = fewOf(iks)
  const list = open ? page(iks, shown) : { items: first, more: false }
  return (
    <span data-p2p-names>
      {list.items.map((ik, i) => (
        <span key={ik}>
          {i > 0 && ', '}
          <Who room={room} ik={ik} />
        </span>
      ))}
      {!open && more > 0 && (
        <>
          {' '}
          <LinkButton onClick={() => setOpen(true)}>{andMore(more)}</LinkButton>
        </>
      )}
      {list.more && (
        <>
          {' '}
          <LinkButton onClick={() => setShown(n => nextPage(n, iks.length))}>Show more</LinkButton>
        </>
      )}
    </span>
  )
}

// List entries: a few, then "and N more", which shows the rest 50 at a time.
function Capped({ items }: { items: ReactNode[] }) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const { first, more } = fewOf(items, 5)
  const list = open ? page(items, shown) : { items: first, more: false }
  return (
    <>
      {list.items}
      {((!open && more > 0) || list.more) && (
        <li>
          <LinkButton
            onClick={() => (open ? setShown(n => nextPage(n, items.length)) : setOpen(true))}
          >
            {open ? 'Show more' : andMore(more)}
          </LinkButton>
        </li>
      )}
    </>
  )
}

// A sentence of the flows' copy, written with a marker for the name, with the name put in.
const withNames = (text: string, name: ReactNode) => {
  const parts = text.split('\u0000')
  return parts.flatMap((p, i) => (i === 0 ? [p] : [<span key={i}>{name}</span>, p]))
}

function ModNote({ v, m }: { v: ServerView; m: ServerView['mods'][number] }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  return (
    <Note role="status" data-p2p-mod>
      <RefreshCw size={16} className="shrink-0 animate-spin text-tertiary" aria-hidden />
      <span className="min-w-48 flex-1">
        {SYNC_WAIT_TEXT}{' '}
        <span className="text-on-surface">
          {m.act}
          {m.who && (
            <>
              {' '}
              <Who room={v.id} ik={m.who} />
            </>
          )}
        </span>
      </span>
      <Row as="span" gap="2xs" align="stretch">
        <Button size="md" onClick={() => p2pServer.cancelMod(v.id, m.id)}>
          Cancel
        </Button>
        <Button variant="filled" size="md" onClick={() => p2pServer.applyAnyway(v.id, m.id)}>
          {APPLY_ANYWAY}
        </Button>
      </Row>
    </Note>
  )
}

function ReachedNote({ v, r }: { v: ServerView; r: ServerView['reached'][number] }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  return (
    <Note role="status" data-p2p-reached>
      <span className="min-w-48 flex-1">
        {withNames(reachedText('\u0000', r.lost.length), <Who room={v.id} ik={r.by} />)}{' '}
        <NameList room={v.id} iks={r.lost} />
      </span>
      <Row as="span" gap="2xs">
        <Button variant="filled" size="md" onClick={() => void p2pServer.inviteAgain(v.id, r.by)}>
          {INVITE_AGAIN}
        </Button>
        <IconButton
          icon={X}
          label="Dismiss"
          tone="inherit"
          size="sm"
          onClick={() => p2pServer.dismissReached(v.id, r.by)}
        />
      </Row>
    </Note>
  )
}

function ReapplyNote({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const own = useP2p(s => ownsP2pServer(v, s.me))
  return (
    <Note role="status" data-p2p-reapply>
      <span className="min-w-48 flex-1">
        <Stack as="span" gap="2xs">
          <span className="font-medium text-on-surface">{REAPPLY_TEXT}</span>
          <Stack as="ul" gap="none">
            <Capped
              items={v.reapply.map(r => {
                const { act, who, role } = reapplyLine(r.t, r.c, v.roles)
                return (
                  <li key={r.id}>
                    {act}
                    {who && (
                      <>
                        {' '}
                        <Who room={v.id} ik={who} />
                      </>
                    )}
                    {role && (
                      <>
                        : <Masked text={role} own={own} />
                      </>
                    )}
                  </li>
                )
              })}
            />
          </Stack>
        </Stack>
      </span>
      <Button variant="filled" size="md" onClick={() => void p2pServer.reapply(v.id)}>
        Re-apply
      </Button>
    </Note>
  )
}

function ConflictNote() {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  return (
    <Note role="alert" data-p2p-conflict tone="error">
      <CircleAlert size={16} className="shrink-0" aria-hidden />
      <span className="min-w-48 flex-1">{CONFLICT_TEXT}</span>
      <Button variant="danger" onClick={() => void p2pServer.newDevice()}>
        Set up as a new device
      </Button>
    </Note>
  )
}

// More than one upgrade: the user picks the copy to follow.
function DisputedNote({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const [list, setList] = useState<Successor[] | null>(null)
  useEffect(() => {
    let live = true
    void p2pServer.successors(v.id).then(r => live && setList(r ?? []))
    return () => {
      live = false
    }
  }, [v.id])
  return (
    <Note role="status" data-p2p-disputed>
      <span className="min-w-48 flex-1">
        <span className="font-medium text-on-surface">{DISPUTED_TEXT}</span>
        {v.next ? '' : '. Pick the copy to follow.'}
      </span>
      <Row as="span" gap="2xs" align="stretch" wrap>
        {(list ?? []).map(x => (
          <ListRow
            wrap
            key={x.id}
            onClick={() => void p2pServer.followTo(v.id, x.g)}
            disabled={v.next === x.id}
            current={v.next === x.id}
            title={v.next === x.id ? 'The copy you follow' : 'Follow this copy'}
            label={
              <>
                Owned by <Who room={v.id} ik={x.owner} />, from <Who room={v.id} ik={x.by} />
              </>
            }
          />
        ))}
      </Row>
    </Note>
  )
}

type Successor = {
  id: string
  owner: string
  by: string
  g: Parameters<P2pApp['p2pServer']['followTo']>[1]
}

// The new owner's carry-over of the old copy: waiting for members, or stopped.
function CarryNote({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const c = v.carry
  if (!c || c.state === 'running') return null
  return (
    <Note role="status" data-p2p-carry={c.state}>
      <span className="min-w-48 flex-1">
        {c.state === 'failed'
          ? `${CARRY_FAILED_TEXT}: ${c.why ?? ''}`
          : carryWaitText(c.why ?? undefined)}
      </span>
      {c.state === 'failed' && (
        <Button variant="filled" size="md" onClick={() => p2pServer.retryCarry(v.id)}>
          Try again
        </Button>
      )}
    </Note>
  )
}

// The member list the new owner carried over isn't the old copy's.
function MigrateDiffNote({ v }: { v: ServerView }) {
  const d = v.migrateDiff
  if (!d) return null
  const names = (list: string[]) => <NameList room={v.id} iks={list} />
  return (
    <Note role="status" data-p2p-migrate-diff>
      <span className="min-w-48 flex-1">
        <Stack as="span" gap="3xs">
          <span className="font-medium text-on-surface">{MIGRATE_DIFF_TEXT}</span>
          {d.added.length > 0 && <span>Added: {names(d.added)}</span>}
          {d.removed.length > 0 && <span>Left out: {names(d.removed)}</span>}
        </Stack>
      </span>
    </Note>
  )
}

// Between a server channel's header and its messages, or (`flush`, with no room of their own)
// on top of the server's settings.
function ServerNoticesBody({ v, flush = false }: { v: ServerView; flush?: boolean }) {
  const reapply = v.reapply.length > 0 && v.me === 'join'
  const asks = useP2p(s => s.transferAsks.filter(a => a.room === v.id).length)
  if (
    !v.mods.length &&
    !v.reached.length &&
    !reapply &&
    !v.conflict &&
    v.syncing === null &&
    !v.disputed &&
    !asks &&
    !v.carry &&
    !v.migrateDiff
  )
    return null
  return (
    <Surface
      data-p2p-notices
      pad={flush ? 'none' : 'md'}
      gap="sm"
      tone="plain"
      radius="none"
      place="shrink-0"
    >
      {asks > 0 && <TransferAsks room={v.id} />}
      {v.disputed && <DisputedNote v={v} />}
      {v.carry && <CarryNote v={v} />}
      {v.migrateDiff && <MigrateDiffNote v={v} />}
      {v.conflict && <ConflictNote />}
      {v.mods.map(m => (
        <ModNote key={m.id} v={v} m={m} />
      ))}
      {v.reached.map(r => (
        <ReachedNote key={r.by} v={v} r={r} />
      ))}
      {reapply && <ReapplyNote v={v} />}
      {v.syncing !== null && (
        <Surface
          as="p"
          role="status"
          data-p2p-syncing
          pad="sm"
          inset="bar"
          tone="plain"
          radius="none"
        >
          <Row as="span" gap="sm">
            <RefreshCw size={12} className="animate-spin text-tertiary" aria-hidden />
            <span className="text-xs text-on-surface-variant">{SYNCING_TEXT(v.syncing)}</span>
          </Row>
        </Surface>
      )}
    </Surface>
  )
}

// ----- Transfer -----

// Owners asking us to take a server over, or (co-owners) to approve its transfer.
function TransferAsksBody({ room }: { room?: string }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const all = useP2p(s => s.transferAsks)
  const asks = room ? all.filter(a => a.room === room) : all
  if (!asks.length) return null
  return (
    <Stack as="ul" aria-label="Transfer requests" gap="sm">
      {asks.map(a => (
        <li
          key={a.key}
          data-p2p-transfer-ask={a.kind}
          className="rounded-2xl border border-dashed border-tertiary bg-surface-container"
        >
          <Surface pad="md" tone="plain" radius="none">
            <Row gap="md" wrap>
              <KeyAvatar person={identityPerson(a.from, 'request')} size={32} />
              <p className="min-w-48 flex-1 text-sm">
                <Who room={a.room} ik={a.from} />{' '}
                {a.kind === 'take' ? (
                  <>
                    wants to make you the owner of a new copy of{' '}
                    <span className="streamer font-medium">
                      <Masked text={a.name} />
                    </span>
                    .
                  </>
                ) : (
                  <>
                    wants to transfer{' '}
                    <span className="streamer font-medium">
                      <Masked text={a.name} />
                    </span>{' '}
                    to <Who room={a.room} ik={a.to} />. {TRANSFER_CO_OWNERS_TEXT}
                  </>
                )}
              </p>
              <Row as="span" gap="2xs" align="stretch" place="ml-auto">
                <Button size="md" onClick={() => void p2pServer.answerTransfer(a.key, false)}>
                  Decline
                </Button>
                <Button
                  variant="filled"
                  size="md"
                  onClick={() => void p2pServer.answerTransfer(a.key, true)}
                >
                  {a.kind === 'take' ? 'Take it' : 'Approve'}
                </Button>
              </Row>
            </Row>
          </Surface>
        </li>
      ))}
    </Stack>
  )
}

// ----- Co-owners -----

// Contacts creating a server who want us as a co-owner: agree or decline while they wait.
function CoOwnerAsksBody() {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const asks = useP2p(s => s.coOwnerAsks)
  const contacts = useP2p(s => s.contacts)
  if (!asks.length) return null
  return (
    <Stack as="section" aria-label="Co-owner requests" gap="sm">
      <Surface pad="md" inset="bar" tone="plain" radius="none">
        <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
          Co-owner requests ({asks.length})
        </p>
      </Surface>
      <Stack as="ul" gap="sm">
        {asks.map(a => {
          const c = contacts.find(x => x.ik === a.from)
          return (
            <li
              key={a.key}
              data-p2p-coowner-ask={a.name}
              className="rounded-2xl border border-dashed border-tertiary bg-surface-container"
            >
              <Surface pad="md" tone="plain" radius="none">
                <Row gap="md" wrap>
                  <KeyAvatar person={identityPerson(a.from, 'request')} size={32} />
                  <p className="min-w-48 flex-1 text-sm">
                    <span className="streamer font-medium">
                      {c ? <Masked text={displayName(c)} /> : 'A contact'}
                    </span>{' '}
                    wants you as a co-owner of{' '}
                    <span className="streamer font-medium">
                      <Masked text={a.name || 'a new server'} />
                    </span>
                    .
                  </p>
                  <Row as="span" gap="2xs" align="stretch" place="ml-auto">
                    <Button size="md" onClick={() => p2pServer.answerCoOwner(a.key, false)}>
                      Decline
                    </Button>
                    <Button
                      variant="filled"
                      size="md"
                      onClick={() => p2pServer.answerCoOwner(a.key, true)}
                    >
                      Agree
                    </Button>
                  </Row>
                </Row>
              </Surface>
            </li>
          )
        })}
      </Stack>
    </Stack>
  )
}

// Online mutual contacts the creator may list as co-owners.
function CoOwnerPickerBody({
  value,
  onChange,
}: {
  value: string[]
  onChange: (v: string[]) => void
}) {
  const contacts = useP2p(s => s.contacts)
  const presence = useP2p(s => s.presence)
  const list = contacts.filter(c => c.state === 'mutual')
  return (
    <Stack as="fieldset" gap="2xs">
      <legend className="text-xs text-on-surface-variant">{CO_OWNERS_TEXT}</legend>
      {list.length === 0 ? (
        <p className="text-xs text-on-surface-variant">No P2P contacts yet.</p>
      ) : (
        <ul className="flex max-h-40 flex-col overflow-y-auto">
          {list.map(c => {
            const online = presence[c.ik] === 'online'
            const full = value.length >= CO_OWNERS_MAX && !value.includes(c.ik)
            return (
              <li key={c.ik} className={online && !full ? undefined : 'opacity-60'}>
                <Surface as="label" pad="sm" tone="plain" radius="lg">
                  <Row as="span" gap="md">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      disabled={!online || full}
                      checked={value.includes(c.ik)}
                      onChange={e =>
                        onChange(
                          e.target.checked ? [...value, c.ik] : value.filter(ik => ik !== c.ik)
                        )
                      }
                    />
                    <KeyAvatar person={identityPerson(c.ik, 'contact')} size={24} />
                    <span className="streamer min-w-0 flex-1 truncate text-sm">
                      <Masked text={displayName(c)} />
                    </span>
                    {!online && <span className="text-xs text-on-surface-variant">Offline</span>}
                  </Row>
                </Surface>
              </li>
            )
          })}
        </ul>
      )}
      {value.length >= CO_OWNERS_MAX && (
        <p className="text-xs text-on-surface-variant">{CO_OWNERS_MAX_TEXT}</p>
      )}
    </Stack>
  )
}

// ----- Devices -----

const when = (ms: number) =>
  ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown'

const useDevices = () => {
  const identity = useP2pApp()!
  const { p2pDevices } = identity

  const servers = useP2p(s => s.servers)
  const me = useP2p(s => s.ik)
  return useMemo(() => (servers && me ? p2pDevices.list() : []), [servers, me])
}

// From the settings dialog: it closes, so the P2P dialog shows.
const openOver = (identity: P2pApp) => (d: P2pDialog) => {
  const { p2p } = identity

  ;(identity.owner ?? client.shown()).store.getState().closeDialog()
  p2p.openDialog(d)
}

// P2P settings: our devices in P2P servers, a lost or stolen one, and recovery.
function DevicesSectionBody() {
  const identity = useP2pApp()!
  const { p2pDevices } = identity

  const list = useDevices()
  const mine = p2pDevices.current()
  if (!list.length) return null
  const others = list.filter(d => d.dk !== mine)
  return (
    <Surface data-p2p-devices pad="sm" inset="bar" gap="sm" tone="plain" radius="none">
      <p className="text-sm font-medium">Devices in P2P servers</p>
      <p className="text-xs text-on-surface-variant">{DEVICES_TEXT}</p>
      <Stack as="ul" gap="2xs">
        {list.map(d => (
          <Surface
            as="li"
            key={d.dk}
            data-p2p-device={d.dk === mine ? 'this' : 'other'}
            pad="md"
            tone="base"
            radius="lg"
          >
            <Row gap="sm" wrap>
              <div className="min-w-0 flex-1">
                <Row as="p" gap="sm" align="baseline">
                  <span className="truncate text-sm">{d.label}</span>
                  {d.dk === mine && (
                    <span className="shrink-0 text-xs text-on-surface-variant">This device</span>
                  )}
                </Row>
                <p className="font-mono text-2xs text-on-surface-variant">
                  {d.dk.slice(0, 12)} · {d.rooms.length}{' '}
                  {d.rooms.length === 1 ? 'server' : 'servers'}
                  {d.created ? ` · added ${when(d.created)}` : ''}
                </p>
              </div>
              {d.dk !== mine && (
                <Button
                  variant="danger"
                  onClick={() => openOver(identity)({ kind: 'lost_device', dk: d.dk })}
                >
                  Lost or stolen
                </Button>
              )}
            </Row>
          </Surface>
        ))}
      </Stack>
      {others.length > 0 && (
        <Button onClick={() => openOver(identity)({ kind: 'recover' })} place="self-start">
          <ShieldCheck size={16} />
          Recover with your recovery key
        </Button>
      )}
    </Surface>
  )
}

type Preview = Awaited<ReturnType<P2pApp['p2pDevices']['preview']>>

function LostDeviceDialogBody({ dk }: { dk: string }) {
  const identity = useP2pApp()!
  const { p2p, p2pDevices } = identity

  const [at] = useState(() => appTime().now())
  const times = lostTimes(p2p.limits().misc)
  const [t, setT] = useState(() => at - times[0].ms)
  const [list, setList] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const servers = useP2p(s => s.servers)
  // Each run reads every server's ACL: once the time stops changing.
  useEffect(() => {
    let live = true
    setList(null)
    const timer = appTime().after(
      400,
      () => void p2pDevices.preview(dk, t).then(r => live && setList(r))
    )
    return () => {
      live = false
      timer()
    }
  }, [dk, t])
  const time = when(t)
  const remove = async () => {
    setBusy(true)
    await p2pDevices.disown(dk, t)
    setBusy(false)
    p2p.closeDialog()
  }
  return (
    <Dialog title="Lost or stolen device" onClose={p2p.closeDialog} full>
      <Stack gap="lg">
        <Stack gap="sm">
          <Stack as="label" gap="2xs">
            <span className="text-sm">It was yours until</span>
            <input
              type="datetime-local"
              step={1}
              value={localInput(t, true)}
              max={localInput(at, true)}
              onChange={e => {
                const v = new Date(e.target.value).getTime()
                if (Number.isFinite(v)) setT(Math.min(v, at))
              }}
              data-p2p-lost-time
              className={fieldCls}
            />
          </Stack>
          <Row gap="2xs" align="stretch" wrap>
            {times.map(o => (
              <Button key={o.ms} onClick={() => setT(at - o.ms)}>
                {o.label}
              </Button>
            ))}
          </Row>
        </Stack>
        <p data-p2p-lost-text className="text-sm">
          {lostText(time)}
        </p>
        {list === null ? (
          <p className="text-sm text-on-surface-variant">Looking at what it did…</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-on-surface-variant">It is in none of your servers any more.</p>
        ) : (
          <Stack as="ul" gap="md">
            {list.map(p => (
              <Surface
                as="li"
                key={p.room}
                data-p2p-lost-room
                pad="md"
                gap="sm"
                tone="base"
                radius="lg"
              >
                <Stack gap="2xs">
                  <p className="streamer text-sm font-medium">
                    <Masked text={servers[p.room]?.name ?? 'P2P server'} />
                  </p>
                  {p.acts.length === 0 && p.content === 0 ? (
                    <p className="text-xs text-on-surface-variant">Nothing since then.</p>
                  ) : (
                    <ul className="flex flex-col text-xs text-on-surface-variant">
                      <Capped
                        items={p.acts.map(x => {
                          const { act, who } = actParts(x.t, x.to, x.ends)
                          return (
                            <li key={x.id}>
                              {act}
                              {who && (
                                <>
                                  {' '}
                                  <Who room={p.room} ik={who} />
                                </>
                              )}
                              <span className="opacity-70">
                                {' '}
                                · received {when(p.at[x.id] ?? x.ts)}
                              </span>
                            </li>
                          )
                        })}
                      />
                      {p.content > 0 && (
                        <li>
                          {p.content} {p.content === 1 ? 'message' : 'messages'}
                        </li>
                      )}
                    </ul>
                  )}
                </Stack>
                {p.others.length > 0 && (
                  <p data-p2p-lost-others className="text-xs text-on-surface-variant">
                    {lostOthersText(p.others.length)}
                  </p>
                )}
                {p.resign.length > 0 && (
                  <div data-p2p-lost-own className="text-xs text-on-surface-variant">
                    <Stack gap="2xs">
                      <p>{OWN_RESIGN_TEXT}</p>
                      <ul className="text-on-surface">
                        <Capped
                          items={p.resign.map(x => {
                            const { act, who } = actParts(x.t, x.to, x.ends)
                            return (
                              <li key={x.id}>
                                {act}
                                {who && (
                                  <>
                                    {' '}
                                    <Who room={p.room} ik={who} />
                                  </>
                                )}
                              </li>
                            )
                          })}
                        />
                      </ul>
                    </Stack>
                  </div>
                )}
                {!p.ap && (
                  <p className="text-xs text-on-surface-variant">
                    It made this server, so what it did here stays. Nothing it signs from now on
                    counts.
                  </p>
                )}
                {p.lose.length > 0 && (
                  <p className="text-xs">
                    Lose access: <NameList room={p.room} iks={p.lose} />
                  </p>
                )}
              </Surface>
            ))}
          </Stack>
        )}
        <Row gap="sm" justify="end">
          <Button onClick={p2p.closeDialog}>Cancel</Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy || !list?.length}>
            Remove device
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

function RecoverDialogBody() {
  const identity = useP2pApp()!
  const { p2pDevices, p2p } = identity

  const list = useDevices()
  const mine = p2pDevices.current()
  const others = list.filter(d => d.dk !== mine)
  const [keep, setKeep] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    await p2pDevices.recover(keep)
    setBusy(false)
    p2p.closeDialog()
  }
  return (
    <Dialog title="Recover with your recovery key" onClose={p2p.closeDialog} full>
      <Stack gap="lg">
        <p className="text-sm">{RECOVERY_TEXT}</p>
        <Stack as="fieldset" gap="2xs">
          <legend className="text-xs text-on-surface-variant">Devices to keep</legend>
          {others.map(d => (
            <Surface as="label" key={d.dk} pad="sm" tone="plain" radius="lg">
              <Row as="span" gap="md">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={keep.includes(d.dk)}
                  onChange={e =>
                    setKeep(e.target.checked ? [...keep, d.dk] : keep.filter(x => x !== d.dk))
                  }
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {d.label}{' '}
                  <span className="font-mono text-2xs text-on-surface-variant">
                    {d.dk.slice(0, 12)}
                  </span>
                </span>
              </Row>
            </Surface>
          ))}
          <Surface pad="sm" inset="bar" tone="plain" radius="none">
            <p className="text-xs text-on-surface-variant">This device stays.</p>
          </Surface>
        </Stack>
        <Row gap="sm" justify="end">
          <Button onClick={p2p.closeDialog}>Cancel</Button>
          <Button variant="danger" onClick={() => void run()} disabled={busy}>
            Sign out the others
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

export const ServerNotices = withP2pIdentity(ServerNoticesBody)
export const TransferAsks = withP2pIdentity(TransferAsksBody)
export const CoOwnerAsks = withP2pIdentity(CoOwnerAsksBody)
export const CoOwnerPicker = withP2pIdentity(CoOwnerPickerBody)
export const DevicesSection = withP2pIdentity(DevicesSectionBody)
export const LostDeviceDialog = withP2pIdentity(LostDeviceDialogBody)
export const RecoverDialog = withP2pIdentity(RecoverDialogBody)
