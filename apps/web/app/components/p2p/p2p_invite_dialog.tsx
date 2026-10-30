'use client'

import { useEffect, useMemo, useState } from 'react'
import { Eye, Waypoints } from 'lucide-react'
import { useStore } from '../../lib/store'
import { CODE_TTLS, NEEDS_INVITER, p2p, p2pRail, p2pServer, useP2p } from '../../lib/p2p/app'
import { displayName } from '../../lib/p2p/contacts'
import { P } from '../../lib/p2p/state'
import { CopyButton, QrCode } from '../config_sync'
import { Dialog, FieldError, fieldCls, filledBtn, textBtn } from '../ui'
import { KeyAvatar, P2pBadge } from './p2p_badge'
import { QrScan } from './qr_scan'

const IP_NOTE =
  'Members you connect with can see your IP address unless you use relay only (Settings, Voice and P2P).'

// Invite codes of P2P servers (note section 6): a code names the server, a secret and a few
// members who can let people in; it expires and can be revoked. Joining with one needs one of
// those members online.

const areaCls = `${fieldCls} w-full resize-none font-mono text-xs break-all md:text-xs`

export interface CodeRow {
  hash: string
  exp: number
  revoked: boolean
  label: string
  by: string
  text: string | null
}

const expiryText = (exp: number, now: number) => {
  if (exp <= now) return 'Expired'
  const left = exp - now
  const h = Math.round(left / 3_600_000)
  if (h < 1) return 'Expires within an hour'
  if (h < 48) return `Expires in ${h} ${h === 1 ? 'hour' : 'hours'}`
  return `Expires in ${Math.round(h / 24)} days`
}

// A code as a QR and a string; in streamer mode both stay hidden until asked for.
export function CodeBox({ text }: { text: string }) {
  const streamer = useStore(s => s.streamer)
  const [shown, setShown] = useState(false)
  if (streamer && !shown)
    return (
      <button
        type="button"
        onClick={() => setShown(true)}
        className={`${textBtn} flex items-center gap-1.5`}
      >
        <Eye size={16} />
        Show code
      </button>
    )
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="w-64 max-w-full">
        <QrCode text={text} label="P2P server invite code" wide />
      </div>
      <div className="flex w-full items-start gap-1">
        <textarea
          readOnly
          value={text}
          rows={4}
          aria-label="Invite code"
          data-p2p-code
          onFocus={e => e.currentTarget.select()}
          className={areaCls}
        />
        <CopyButton text={text} label="Copy invite code" />
      </div>
      <p className="text-xs text-on-surface-variant">
        Anyone with this code can join while it is valid. Share it privately, not in an instance
        channel or DM: the instance would see it. A revoked code may still work until every member
        who can let people in has synced.
      </p>
    </div>
  )
}

// The server's codes: active ones with their string (when made here) and revoke.
export function CodeList({ room, version }: { room: string; version: number }) {
  const v = useP2p(s => s.servers[room])
  const me = useP2p(s => s.me)
  const [list, setList] = useState<CodeRow[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const state = v ? `${v.members.length}:${version}` : ''
  useEffect(() => {
    let live = true
    void p2pServer.codes(room).then(rows => live && setList(rows ?? []))
    return () => {
      live = false
    }
  }, [room, state])
  if (!list) return <p className="text-sm text-on-surface-variant">Loading invites…</p>
  if (!list.length) return <p className="text-sm text-on-surface-variant">No invites yet.</p>
  const now = Date.now()
  const manage = !!v && (v.perms & P.ManageServer) !== 0
  return (
    <ul className="flex flex-col gap-2">
      {list.map(c => {
        const live = !c.revoked && c.exp > now
        const mine = c.by === me
        return (
          <li
            key={c.hash}
            data-p2p-code-row={c.label || c.hash.slice(0, 6)}
            className="flex flex-col gap-2 rounded-xl bg-surface-container px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.label || 'Invite'}</p>
                <p className="text-xs text-on-surface-variant">
                  {c.revoked ? 'Revoked' : expiryText(c.exp, now)}
                  {mine ? ' · made by you' : ''}
                </p>
              </div>
              {live && c.text && (
                <button
                  onClick={() => setOpen(open === c.hash ? null : c.hash)}
                  className={textBtn}
                >
                  {open === c.hash ? 'Hide' : 'Show'}
                </button>
              )}
              {live && (mine || manage) && (
                <button
                  onClick={() =>
                    useStore.getState().askConfirm({
                      title: 'Revoke Invite',
                      body: 'Revoke this invite? Members stop letting people in with it as they hear of it.',
                      confirm: 'Revoke',
                      action: () =>
                        void p2pServer
                          .revokeCode(room, c.hash)
                          .then(() =>
                            setList(
                              cur =>
                                cur?.map(x => (x.hash === c.hash ? { ...x, revoked: true } : x)) ??
                                cur
                            )
                          ),
                    })
                  }
                  className="rounded-full px-3 py-1.5 text-sm font-medium text-error hover:bg-surface-container-highest"
                >
                  Revoke
                </button>
              )}
            </div>
            {open === c.hash && c.text && <CodeBox text={c.text} />}
          </li>
        )
      })}
    </ul>
  )
}

export function ServerInviteDialog({ room }: { room: string }) {
  const v = useP2p(s => s.servers[room])
  const contacts = useP2p(s => s.contacts)
  const [ttl, setTtl] = useState(CODE_TTLS[1].ms)
  const [label, setLabel] = useState('')
  const [code, setCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const [invited, setInvited] = useState<Set<string>>(new Set())
  const candidates = useMemo(
    () =>
      contacts.filter(
        c =>
          c.state === 'mutual' &&
          !v?.members.some(m => m.ik === c.ik && (m.m === 'join' || m.m === 'ban'))
      ),
    [contacts, v]
  )
  if (!v) return null
  const make = async () => {
    setBusy(true)
    const text = await p2pServer.issueCode(room, ttl, label)
    setBusy(false)
    if (text) {
      setCode(text)
      setVersion(n => n + 1)
    }
  }
  return (
    <Dialog title="Invite people" onClose={p2p.closeDialog} full>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <p className="text-sm text-on-surface-variant">
            To <span className="streamer font-medium text-on-surface">{v.name}</span>. Make a code
            and share it. {NEEDS_INVITER} when someone uses it.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-on-surface-variant">
              Expires after
              <select
                value={ttl}
                onChange={e => setTtl(Number(e.target.value))}
                aria-label="Expires after"
                className={fieldCls}
              >
                {CODE_TTLS.map(t => (
                  <option key={t.ms} value={t.ms}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-on-surface-variant">
              Label (only for you and the server)
              <input
                value={label}
                maxLength={64}
                onChange={e => setLabel(e.target.value)}
                placeholder="For the book club"
                className={fieldCls}
              />
            </label>
            <button onClick={() => void make()} disabled={busy} className={filledBtn}>
              Create invite
            </button>
          </div>
          {code && <CodeBox text={code} />}
        </section>
        <section className="flex flex-col gap-2">
          <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Invite a contact
          </p>
          {candidates.length === 0 ? (
            <p className="text-sm text-on-surface-variant">
              Your P2P contacts are all here already, or you have none yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {candidates.map(c => {
                const pending =
                  invited.has(c.ik) || v.members.some(m => m.ik === c.ik && m.m === 'invite')
                return (
                  <li key={c.ik} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
                    <KeyAvatar ik={c.ik} size={32} />
                    <span className="streamer min-w-0 flex-1 truncate text-sm">
                      {displayName(c)}
                    </span>
                    <button
                      disabled={pending}
                      onClick={() =>
                        void p2pServer.invite(room, c.ik).then(r => {
                          if (r !== null) setInvited(s => new Set(s).add(c.ik))
                        })
                      }
                      className={textBtn}
                    >
                      {pending ? 'Invited' : 'Invite'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Invites
          </p>
          <CodeList room={room} version={version} />
        </section>
      </div>
    </Dialog>
  )
}

type NewTab = 'create' | 'join'

export function ServerNewDialog({
  tab: first = 'create',
  code: given = '',
}: {
  tab?: NewTab
  code?: string
}) {
  const [tab, setTab] = useState<NewTab>(given ? 'join' : first)
  const [name, setName] = useState('')
  const [code, setCode] = useState(given)
  const [scan, setScan] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const enabled = useP2p(s => s.enabled)
  const ready = useP2p(s => s.status === 'online' || s.status === 'connecting')
  const peek = code.trim() ? p2pServer.peek(code) : null
  const create = async () => {
    setBusy(true)
    setError(null)
    const room = await p2pServer.create(name)
    setBusy(false)
    if (!room) setError("Couldn't create the server")
  }
  const join = async () => {
    setBusy(true)
    setError(null)
    const room = await p2pServer.join(code)
    setBusy(false)
    if (!room) setError(useStore.getState().toast?.text ?? "Couldn't join")
  }
  return (
    <Dialog title="P2P server" onClose={p2p.closeDialog} full>
      {!enabled ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-on-surface-variant">
            Turn on peer-to-peer first: P2P servers live on their members&apos; devices.
          </p>
          <button onClick={() => p2p.openDialog({ kind: 'enable' })} className={filledBtn}>
            Turn on P2P
          </button>
        </div>
      ) : (
        <>
          <div role="tablist" className="mb-4 flex gap-1">
            {(
              [
                ['create', 'Create'],
                ['join', 'Join with a code'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => {
                  setTab(key)
                  setError(null)
                }}
                className={`rounded-full px-3 py-1.5 text-sm ${
                  tab === key
                    ? 'bg-secondary-container text-on-secondary-container'
                    : 'text-on-surface-variant hover:bg-surface-container-highest'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'create' ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3 rounded-xl border border-dashed border-tertiary px-3 py-2 text-sm text-on-surface-variant">
                <Waypoints size={18} className="mt-0.5 shrink-0 text-tertiary" />
                <p>
                  A P2P server is stored only on its members&apos; devices: its channels, messages
                  and who may do what. There is no copy on the instance, and the instance
                  doesn&apos;t filter it.
                </p>
              </div>
              <p className="text-xs text-on-surface-variant">{IP_NOTE}</p>
              <input
                autoFocus
                value={name}
                maxLength={100}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && name.trim() && !busy) void create()
                }}
                placeholder="Server name"
                aria-label="Server name"
                className={`${fieldCls} streamer w-full`}
              />
              <FieldError message={error} />
              <div className="flex justify-end gap-2">
                <button onClick={p2p.closeDialog} className={textBtn}>
                  Cancel
                </button>
                <button
                  onClick={() => void create()}
                  disabled={!name.trim() || busy}
                  className={filledBtn}
                >
                  Create
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {scan ? (
                <QrScan
                  label="Camera view for an invite code"
                  onCode={text => {
                    setCode(text)
                    setScan(false)
                  }}
                />
              ) : (
                <textarea
                  autoFocus
                  value={code}
                  onChange={e => {
                    setCode(e.target.value)
                    setError(null)
                  }}
                  rows={4}
                  placeholder="Paste an invite code (rci1.…)"
                  aria-label="Invite code"
                  className={`${areaCls} streamer`}
                />
              )}
              <button onClick={() => setScan(s => !s)} className={`${textBtn} self-start`}>
                {scan ? 'Paste instead' : 'Scan a QR code'}
              </button>
              {code.trim() && !peek && (
                <FieldError message="This isn't a P2P server invite code." />
              )}
              {peek && (
                <div className="flex items-center gap-3 rounded-xl bg-surface-container px-3 py-2">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-tertiary font-semibold">
                    <Waypoints size={18} className="text-tertiary" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="streamer truncate text-sm font-medium">{peek.name}</p>
                    <p className="text-xs text-on-surface-variant">{NEEDS_INVITER}</p>
                  </div>
                  <P2pBadge />
                </div>
              )}
              <p data-p2p-needs-inviter className="text-xs text-on-surface-variant">
                {NEEDS_INVITER}. Your contact code and name go to whoever lets you in.
              </p>
              <p className="text-xs text-on-surface-variant">{IP_NOTE}</p>
              <FieldError message={error} />
              <div className="flex justify-end gap-2">
                <button onClick={p2p.closeDialog} className={textBtn}>
                  Cancel
                </button>
                <button
                  onClick={() => void join()}
                  disabled={!peek || busy || !ready}
                  className={filledBtn}
                >
                  {busy ? 'Joining…' : 'Join'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Dialog>
  )
}

export function P2pFolderDialog({ id }: { id: string }) {
  const folder = useP2p(s => s.layout.servers.find(e => typeof e !== 'string' && e.id === id))
  const [name, setName] = useState(typeof folder === 'object' ? (folder.name ?? '') : '')
  if (!folder) return null
  const save = () => {
    p2pRail.rename(id, name)
    p2p.closeDialog()
  }
  return (
    <Dialog title="Rename folder" onClose={p2p.closeDialog} compact>
      <input
        autoFocus
        value={name}
        maxLength={50}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') save()
        }}
        placeholder="Folder name"
        aria-label="Folder name"
        className={`${fieldCls} w-full`}
      />
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={p2p.closeDialog} className={textBtn}>
          Cancel
        </button>
        <button onClick={save} className={filledBtn}>
          Save
        </button>
      </div>
    </Dialog>
  )
}
