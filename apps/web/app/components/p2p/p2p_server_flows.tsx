'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CircleAlert, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useMask, useStore } from '../../lib/store'
import { memberName, p2p, p2pDevices, p2pServer, useP2p, type P2pDialog } from '../../lib/p2p/app'
import { displayName } from '../../lib/p2p/contacts'
import {
  actParts,
  APPLY_ANYWAY,
  CARRY_FAILED_TEXT,
  carryWaitText,
  CO_OWNERS_TEXT,
  CONFLICT_TEXT,
  DEVICES_TEXT,
  DISPUTED_TEXT,
  INVITE_AGAIN,
  LOST_TIMES,
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
import type { ServerView } from '../../lib/p2p/server'
import { Dialog, dangerBtn, filledBtn, Masked, textBtn } from '../ui'
import { KeyAvatar } from './p2p_badge'

// The flows of P2P servers the user takes part in (spec 8.2): actions waiting for sync, removals
// that took others along, moderation to apply again, a device that conflicts with a copy of
// itself, sync progress, co-owner requests, and our devices.

const noteCls =
  'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-surface-container px-4 py-2.5 text-sm text-on-surface-variant'

// A member's name in a line, blurred in streamer mode.
function Who({ room, ik }: { room: string; ik: string }) {
  const mask = useMask()
  return <span className="streamer font-medium text-on-surface">{mask(memberName(room, ik))}</span>
}

// A sentence of the spec's copy, written with a marker for the name, with the name put in.
const withNames = (text: string, name: ReactNode) => {
  const parts = text.split('\u0000')
  return parts.flatMap((p, i) => (i === 0 ? [p] : [<span key={i}>{name}</span>, p]))
}

function ModNote({ v, m }: { v: ServerView; m: ServerView['mods'][number] }) {
  return (
    <div role="status" data-p2p-mod className={noteCls}>
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
      <span className="flex gap-1">
        <button onClick={() => p2pServer.cancelMod(v.id, m.id)} className={textBtn}>
          Cancel
        </button>
        <button onClick={() => p2pServer.applyAnyway(v.id, m.id)} className={filledBtn}>
          {APPLY_ANYWAY}
        </button>
      </span>
    </div>
  )
}

function ReachedNote({ v, r }: { v: ServerView; r: ServerView['reached'][number] }) {
  return (
    <div role="status" data-p2p-reached className={noteCls}>
      <span className="min-w-48 flex-1">
        {withNames(reachedText('\u0000', r.lost.length), <Who room={v.id} ik={r.by} />)}{' '}
        {r.lost.map((ik, i) => (
          <span key={ik}>
            {i > 0 && ', '}
            <Who room={v.id} ik={ik} />
          </span>
        ))}
      </span>
      <span className="flex items-center gap-1">
        <button onClick={() => void p2pServer.inviteAgain(v.id, r.by)} className={filledBtn}>
          {INVITE_AGAIN}
        </button>
        <button
          title="Dismiss"
          aria-label="Dismiss"
          onClick={() => p2pServer.dismissReached(v.id, r.by)}
          className="rounded-full p-1.5 hover:bg-surface-container-highest"
        >
          <X size={16} />
        </button>
      </span>
    </div>
  )
}

function ReapplyNote({ v }: { v: ServerView }) {
  return (
    <div role="status" data-p2p-reapply className={noteCls}>
      <span className="flex min-w-48 flex-1 flex-col gap-1">
        <span className="font-medium text-on-surface">{REAPPLY_TEXT}</span>
        <ul className="flex flex-col">
          {v.reapply.map(r => {
            const { act, who } = actParts(r.t, typeof r.c.to === 'string' ? r.c.to : undefined)
            return (
              <li key={r.id}>
                {act}
                {who && (
                  <>
                    {' '}
                    <Who room={v.id} ik={who} />
                  </>
                )}
              </li>
            )
          })}
        </ul>
      </span>
      <button onClick={() => void p2pServer.reapply(v.id)} className={filledBtn}>
        Re-apply
      </button>
    </div>
  )
}

function ConflictNote() {
  return (
    <div
      role="alert"
      data-p2p-conflict
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-error-container px-4 py-2.5 text-sm text-on-error-container"
    >
      <CircleAlert size={16} className="shrink-0" aria-hidden />
      <span className="min-w-48 flex-1">{CONFLICT_TEXT}</span>
      <button onClick={() => void p2pServer.newDevice()} className={dangerBtn}>
        Set up as a new device
      </button>
    </div>
  )
}

// More than one upgrade (spec 3.8): the user picks the copy to follow.
function DisputedNote({ v }: { v: ServerView }) {
  const [list, setList] = useState<Successor[] | null>(null)
  useEffect(() => {
    let live = true
    void p2pServer.successors(v.id).then(r => live && setList(r ?? []))
    return () => {
      live = false
    }
  }, [v.id])
  return (
    <div role="status" data-p2p-disputed className={noteCls}>
      <span className="min-w-48 flex-1">
        <span className="font-medium text-on-surface">{DISPUTED_TEXT}</span>
        {v.next ? '' : '. Pick the copy to follow.'}
      </span>
      <span className="flex flex-wrap gap-1">
        {(list ?? []).map(x => (
          <button
            key={x.id}
            onClick={() => void p2pServer.followTo(v.id, x.g)}
            disabled={v.next === x.id}
            aria-current={v.next === x.id ? 'true' : undefined}
            title={v.next === x.id ? 'The copy you follow' : 'Follow this copy'}
            className={`${textBtn} disabled:cursor-default disabled:text-on-surface-variant disabled:hover:bg-transparent`}
          >
            Owned by <Who room={v.id} ik={x.owner} />, from <Who room={v.id} ik={x.by} />
          </button>
        ))}
      </span>
    </div>
  )
}

type Successor = {
  id: string
  owner: string
  by: string
  g: Parameters<typeof p2pServer.followTo>[1]
}

// The new owner's carry-over of the old copy (spec 3.8): waiting for members, or stopped.
function CarryNote({ v }: { v: ServerView }) {
  const c = v.carry
  if (!c || c.state === 'running') return null
  return (
    <div role="status" data-p2p-carry={c.state} className={noteCls}>
      <span className="min-w-48 flex-1">
        {c.state === 'failed'
          ? `${CARRY_FAILED_TEXT}: ${c.why ?? ''}`
          : carryWaitText(c.why ?? undefined)}
      </span>
      {c.state === 'failed' && (
        <button onClick={() => p2pServer.retryCarry(v.id)} className={filledBtn}>
          Try again
        </button>
      )}
    </div>
  )
}

// Spec 3.8 step 5: the member list the new owner carried over isn't the old copy's.
function MigrateDiffNote({ v }: { v: ServerView }) {
  const d = v.migrateDiff
  if (!d) return null
  const names = (list: string[]) =>
    list.map((ik, i) => (
      <span key={ik}>
        {i > 0 && ', '}
        <Who room={v.id} ik={ik} />
      </span>
    ))
  return (
    <div role="status" data-p2p-migrate-diff className={noteCls}>
      <span className="flex min-w-48 flex-1 flex-col gap-0.5">
        <span className="font-medium text-on-surface">{MIGRATE_DIFF_TEXT}</span>
        {d.added.length > 0 && <span>Added: {names(d.added)}</span>}
        {d.removed.length > 0 && <span>Left out: {names(d.removed)}</span>}
      </span>
    </div>
  )
}

// Between a server channel's header and its messages.
export function ServerNotices({ v }: { v: ServerView }) {
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
    <div data-p2p-notices className="flex shrink-0 flex-col gap-2 px-3 pt-2">
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
        <p role="status" data-p2p-syncing className="flex items-center gap-2 px-2 text-xs">
          <RefreshCw size={12} className="animate-spin text-tertiary" aria-hidden />
          <span className="text-on-surface-variant">{SYNCING_TEXT(v.syncing)}</span>
        </p>
      )}
    </div>
  )
}

// ----- Transfer (spec 3.8) -----

// Owners asking us to take a server over, or (co-owners) to approve its transfer.
export function TransferAsks({ room }: { room?: string }) {
  const all = useP2p(s => s.transferAsks)
  const asks = room ? all.filter(a => a.room === room) : all
  if (!asks.length) return null
  return (
    <ul aria-label="Transfer requests" className="flex flex-col gap-2">
      {asks.map(a => (
        <li
          key={a.key}
          data-p2p-transfer-ask={a.kind}
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-tertiary bg-surface-container px-3 py-2"
        >
          <KeyAvatar ik={a.from} size={32} />
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
          <span className="ml-auto flex gap-1">
            <button onClick={() => void p2pServer.answerTransfer(a.key, false)} className={textBtn}>
              Decline
            </button>
            <button
              onClick={() => void p2pServer.answerTransfer(a.key, true)}
              className={filledBtn}
            >
              {a.kind === 'take' ? 'Take it' : 'Approve'}
            </button>
          </span>
        </li>
      ))}
    </ul>
  )
}

// ----- Co-owners (spec 8.2) -----

// Contacts creating a server who want us as a co-owner: agree or decline while they wait.
export function CoOwnerAsks() {
  const asks = useP2p(s => s.coOwnerAsks)
  const contacts = useP2p(s => s.contacts)
  const mask = useMask()
  if (!asks.length) return null
  return (
    <section aria-label="Co-owner requests" className="flex flex-col gap-2">
      <p className="px-3 text-xs font-medium tracking-wide text-on-surface-variant uppercase">
        Co-owner requests ({asks.length})
      </p>
      <ul className="flex flex-col gap-2">
        {asks.map(a => {
          const c = contacts.find(x => x.ik === a.from)
          return (
            <li
              key={a.key}
              data-p2p-coowner-ask={a.name}
              className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-tertiary bg-surface-container px-3 py-2"
            >
              <KeyAvatar ik={a.from} size={32} />
              <p className="min-w-48 flex-1 text-sm">
                <span className="streamer font-medium">
                  {c ? mask(displayName(c)) : 'A contact'}
                </span>{' '}
                wants you as a co-owner of{' '}
                <span className="streamer font-medium">
                  <Masked text={a.name || 'a new server'} />
                </span>
                .
              </p>
              <span className="ml-auto flex gap-1">
                <button onClick={() => p2pServer.answerCoOwner(a.key, false)} className={textBtn}>
                  Decline
                </button>
                <button onClick={() => p2pServer.answerCoOwner(a.key, true)} className={filledBtn}>
                  Agree
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// Online mutual contacts the creator may list as co-owners.
export function CoOwnerPicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (v: string[]) => void
}) {
  const contacts = useP2p(s => s.contacts)
  const presence = useP2p(s => s.presence)
  const mask = useMask()
  const list = contacts.filter(c => c.state === 'mutual')
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="pb-1 text-xs text-on-surface-variant">{CO_OWNERS_TEXT}</legend>
      {list.length === 0 ? (
        <p className="text-xs text-on-surface-variant">No P2P contacts yet.</p>
      ) : (
        <ul className="flex max-h-40 flex-col overflow-y-auto">
          {list.map(c => {
            const online = presence[c.ik] === 'online'
            return (
              <li key={c.ik}>
                <label
                  className={`flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm ${online ? '' : 'opacity-60'}`}
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    disabled={!online}
                    checked={value.includes(c.ik)}
                    onChange={e =>
                      onChange(
                        e.target.checked ? [...value, c.ik] : value.filter(ik => ik !== c.ik)
                      )
                    }
                  />
                  <KeyAvatar ik={c.ik} size={24} />
                  <span className="streamer min-w-0 flex-1 truncate">{mask(displayName(c))}</span>
                  {!online && <span className="text-xs text-on-surface-variant">Offline</span>}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </fieldset>
  )
}

// ----- Devices (spec 3.9, 8.2) -----

const when = (ms: number) =>
  ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown'

const useDevices = () => {
  const servers = useP2p(s => s.servers)
  const me = useP2p(s => s.ik)
  return useMemo(() => (servers && me ? p2pDevices.list() : []), [servers, me])
}

// From the settings dialog: it closes, so the P2P dialog shows.
const openOver = (d: P2pDialog) => {
  useStore.getState().closeDialog()
  p2p.openDialog(d)
}

// P2P settings: our devices in P2P servers, a lost or stolen one, and recovery.
export function DevicesSection() {
  const list = useDevices()
  const mine = p2pDevices.current()
  if (!list.length) return null
  const others = list.filter(d => d.dk !== mine)
  return (
    <div data-p2p-devices className="flex flex-col gap-2 px-2">
      <p className="text-sm font-medium">Devices in P2P servers</p>
      <p className="text-xs text-on-surface-variant">{DEVICES_TEXT}</p>
      <ul className="flex flex-col gap-1">
        {list.map(d => (
          <li
            key={d.dk}
            data-p2p-device={d.dk === mine ? 'this' : 'other'}
            className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-container px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {d.label}
                {d.dk === mine && (
                  <span className="ml-2 text-xs text-on-surface-variant">This device</span>
                )}
              </p>
              <p className="font-mono text-[11px] text-on-surface-variant">
                {d.dk.slice(0, 12)} · {d.rooms.length} {d.rooms.length === 1 ? 'server' : 'servers'}
                {d.created ? ` · added ${when(d.created)}` : ''}
              </p>
            </div>
            {d.dk !== mine && (
              <button
                onClick={() => openOver({ kind: 'lost_device', dk: d.dk })}
                className="rounded-full px-3 py-1.5 text-sm font-medium text-error hover:bg-surface-container-highest"
              >
                Lost or stolen
              </button>
            )}
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <button
          onClick={() => openOver({ kind: 'recover' })}
          className={`${textBtn} flex items-center gap-1.5 self-start`}
        >
          <ShieldCheck size={16} />
          Recover with your recovery key
        </button>
      )}
    </div>
  )
}

type Preview = Awaited<ReturnType<typeof p2pDevices.preview>>

// A time as a datetime-local input shows it (local time, to the second).
const localInput = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function LostDeviceDialog({ dk }: { dk: string }) {
  const [at] = useState(() => Date.now())
  const [t, setT] = useState(() => at - LOST_TIMES[0].ms)
  const [list, setList] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const servers = useP2p(s => s.servers)
  useEffect(() => {
    let live = true
    setList(null)
    void p2pDevices.preview(dk, t).then(r => live && setList(r))
    return () => {
      live = false
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
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          It was yours until
          <input
            type="datetime-local"
            step={1}
            value={localInput(t)}
            max={localInput(at)}
            onChange={e => {
              const v = new Date(e.target.value).getTime()
              if (Number.isFinite(v)) setT(Math.min(v, at))
            }}
            data-p2p-lost-time
            className="rounded-xl border border-outline-variant bg-transparent px-3 py-2 text-base md:text-sm"
          />
        </label>
        <div className="-mt-2 flex flex-wrap gap-1">
          {LOST_TIMES.map(o => (
            <button key={o.ms} onClick={() => setT(at - o.ms)} className={textBtn}>
              {o.label}
            </button>
          ))}
        </div>
        <p data-p2p-lost-text className="text-sm">
          {lostText(time)}
        </p>
        {list === null ? (
          <p className="text-sm text-on-surface-variant">Looking at what it did…</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-on-surface-variant">It is in none of your servers any more.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {list.map(p => (
              <li key={p.room} data-p2p-lost-room className="rounded-xl bg-surface-container p-3">
                <p className="streamer text-sm font-medium">
                  <Masked text={servers[p.room]?.name ?? 'P2P server'} />
                </p>
                {p.acts.length === 0 && p.content === 0 ? (
                  <p className="text-xs text-on-surface-variant">Nothing since then.</p>
                ) : (
                  <ul className="mt-1 flex flex-col text-xs text-on-surface-variant">
                    {p.acts.map(x => {
                      const { act, who } = actParts(x.t, x.to)
                      return (
                        <li key={x.id}>
                          {act}
                          {who && (
                            <>
                              {' '}
                              <Who room={p.room} ik={who} />
                            </>
                          )}
                          <span className="opacity-70"> · received {when(p.at[x.id] ?? x.ts)}</span>
                        </li>
                      )
                    })}
                    {p.content > 0 && (
                      <li>
                        {p.content} {p.content === 1 ? 'message' : 'messages'}
                      </li>
                    )}
                  </ul>
                )}
                {p.resign.length > 0 && (
                  <div data-p2p-lost-own className="mt-2 text-xs text-on-surface-variant">
                    <p>{OWN_RESIGN_TEXT}</p>
                    <ul className="mt-1 text-on-surface">
                      {p.resign.map(x => {
                        const { act, who } = actParts(x.t, x.to)
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
                    </ul>
                  </div>
                )}
                {!p.ap && (
                  <p className="mt-2 text-xs text-on-surface-variant">
                    It made this server, so what it did here stays. Nothing it signs from now on
                    counts.
                  </p>
                )}
                {p.lose.length > 0 && (
                  <p className="mt-2 text-xs">
                    Lose access:{' '}
                    {p.lose.map((ik, i) => (
                      <span key={ik}>
                        {i > 0 && ', '}
                        <Who room={p.room} ik={ik} />
                      </span>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={p2p.closeDialog} className={textBtn}>
            Cancel
          </button>
          <button
            onClick={() => void remove()}
            disabled={busy || !list?.length}
            className={dangerBtn}
          >
            Remove device
          </button>
        </div>
      </div>
    </Dialog>
  )
}

export function RecoverDialog() {
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
      <div className="flex flex-col gap-4">
        <p className="text-sm">{RECOVERY_TEXT}</p>
        <fieldset className="flex flex-col gap-1">
          <legend className="pb-1 text-xs text-on-surface-variant">Devices to keep</legend>
          {others.map(d => (
            <label key={d.dk} className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm">
              <input
                type="checkbox"
                className="accent-primary"
                checked={keep.includes(d.dk)}
                onChange={e =>
                  setKeep(e.target.checked ? [...keep, d.dk] : keep.filter(x => x !== d.dk))
                }
              />
              <span className="min-w-0 flex-1 truncate">
                {d.label}{' '}
                <span className="font-mono text-[11px] text-on-surface-variant">
                  {d.dk.slice(0, 12)}
                </span>
              </span>
            </label>
          ))}
          <p className="px-2 text-xs text-on-surface-variant">This device stays.</p>
        </fieldset>
        <div className="flex justify-end gap-2">
          <button onClick={p2p.closeDialog} className={textBtn}>
            Cancel
          </button>
          <button onClick={() => void run()} disabled={busy} className={dangerBtn}>
            Sign out the others
          </button>
        </div>
      </div>
    </Dialog>
  )
}
