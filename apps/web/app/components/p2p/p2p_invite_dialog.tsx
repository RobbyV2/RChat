'use client'
import { identityPerson } from '../../lib/people'
import { Button, Tab } from '../controls'
import { Row, Stack, Surface } from '../layout'
import { client } from '../../lib/client/client'
import { useAccount } from '../../lib/client/react'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useEffect, useMemo, useState } from 'react'
import { Eye, Waypoints } from 'lucide-react'
import { useStore } from '../../lib/store'
import { codeTtls, NEEDS_INVITER } from '../../lib/p2p/app'
import { displayName } from '../../lib/p2p/contacts'
import { P } from '../../lib/p2p/state'
import { fieldMax } from '../../lib/p2p/event_v2'
import { CopyButton, QrCode } from '../config_sync'
import { Dialog, FieldError, fieldCls, Masked } from '../ui'
import { FolderColorField } from '../folder_dialog'
import { KeyAvatar, P2pBadge } from './p2p_badge'
import { QrScan } from './qr_scan'
import { CoOwnerAsks, CoOwnerPicker } from './p2p_server_flows'
import {
  CODE_DEATH_TEXT,
  CODE_PAUSED_TEXT,
  CODE_RETRY_TEXT,
  CODE_REVOKE_TEXT,
  OWNER_TEXT,
} from '../../lib/p2p/flows'
import { time } from '../../lib/platform/time'

const IP_NOTE =
  'Members you connect with can see your IP address unless you use relay only (Settings, Voice and P2P).'

// Invite codes of P2P servers: a code names the server, a secret and a few
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
  paused?: true
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
      <Button onClick={() => setShown(true)}>
        <Eye size={16} />
        Show code
      </Button>
    )
  return (
    <Stack gap="md" align="start">
      <div className="w-64 max-w-full">
        <QrCode text={text} label="P2P server invite code" wide />
      </div>
      <Row gap="2xs" align="start" place="w-full">
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
      </Row>
      <p className="text-xs text-on-surface-variant">
        Anyone with this code can join while it is valid. Share it privately, not in an instance
        channel or DM: the instance would see it. A revoked code may still work until every member
        who can let people in has synced.
      </p>
    </Stack>
  )
}

// The server's codes: active ones with their string (when made here) and revoke.
function CodeListBody({ room, version }: { room: string; version: number }) {
  const ownerAccount = useAccount()

  const identity = useP2pApp()!
  const { p2pServer } = identity

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
  const now = time().now()
  const manage = !!v && (v.perms & P.ManageServer) !== 0
  return (
    <Stack as="ul" gap="sm">
      {list.map(c => {
        const live = !c.revoked && c.exp > now
        const mine = c.by === me
        return (
          <Surface
            as="li"
            key={c.hash}
            data-p2p-code-row={c.label || c.hash.slice(0, 6)}
            pad="md"
            gap="sm"
            tone="base"
            radius="lg"
          >
            <Row gap="sm">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.label || 'Invite'}</p>
                <p className="text-xs text-on-surface-variant">
                  {c.revoked ? 'Revoked' : expiryText(c.exp, now)}
                  {mine ? ' · made by you' : ''}
                </p>
              </div>
              {live && c.text && (
                <Button onClick={() => setOpen(open === c.hash ? null : c.hash)}>
                  {open === c.hash ? 'Hide' : 'Show'}
                </Button>
              )}
              {live && (mine || manage) && (
                <Button
                  variant="danger"
                  onClick={() =>
                    ownerAccount.store.getState().askConfirm({
                      title: 'Revoke Invite',
                      body: `Revoke this invite? ${CODE_REVOKE_TEXT}`,
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
                >
                  Revoke
                </Button>
              )}
            </Row>
            {live && c.paused && (
              <p className="text-xs text-on-surface-variant">{CODE_PAUSED_TEXT}</p>
            )}
            {open === c.hash && c.text && <CodeBox text={c.text} />}
          </Surface>
        )
      })}
    </Stack>
  )
}

function ServerInviteDialogBody({ room }: { room: string }) {
  const identity = useP2pApp()!
  const { p2p, p2pServer } = identity

  const v = useP2p(s => s.servers[room])
  const contacts = useP2p(s => s.contacts)
  const ttls = codeTtls(p2p.limits().server)
  const [ttl, setTtl] = useState(ttls[1].ms)
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
      <Stack gap="xl">
        <Stack as="section" gap="md">
          <p className="text-sm text-on-surface-variant">
            To{' '}
            <span className="streamer font-medium text-on-surface">
              <Masked text={v.name} />
            </span>
            . Make a code and share it. {NEEDS_INVITER} when someone uses it.
          </p>
          <Row gap="sm" align="end" wrap>
            <Stack as="label" gap="2xs">
              <span className="text-xs text-on-surface-variant">Expires after</span>
              <select
                value={ttl}
                onChange={e => setTtl(Number(e.target.value))}
                aria-label="Expires after"
                className={fieldCls}
              >
                {ttls.map(t => (
                  <option key={t.ms} value={t.ms}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Stack>
            <Stack as="label" gap="2xs" place="flex-1">
              <span className="text-xs text-on-surface-variant">
                Label (only for you and the server)
              </span>
              <input
                value={label}
                maxLength={fieldMax(p2p.limits().display.label)}
                onChange={e => setLabel(e.target.value)}
                placeholder="For the book club"
                className={fieldCls}
              />
            </Stack>
            <Button variant="filled" size="md" onClick={() => void make()} disabled={busy}>
              Create invite
            </Button>
          </Row>
          <p className="text-xs text-on-surface-variant">{CODE_DEATH_TEXT}</p>
          {code && <CodeBox text={code} />}
        </Stack>
        <Stack as="section" gap="sm">
          <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Invite a contact
          </p>
          {candidates.length === 0 ? (
            <p className="text-sm text-on-surface-variant">
              Your P2P contacts are all here already, or you have none yet.
            </p>
          ) : (
            <Stack as="ul" gap="2xs">
              {candidates.map(c => {
                const pending =
                  invited.has(c.ik) || v.members.some(m => m.ik === c.ik && m.m === 'invite')
                return (
                  <Surface as="li" key={c.ik} pad="sm" tone="plain" radius="lg">
                    <Row gap="md">
                      <KeyAvatar person={identityPerson(c.ik, 'contact')} size={32} />
                      <span className="streamer min-w-0 flex-1 truncate text-sm">
                        <Masked text={displayName(c)} />
                      </span>
                      <Button
                        disabled={pending}
                        onClick={() =>
                          void p2pServer.invite(room, c.ik).then(r => {
                            if (r !== null) setInvited(s => new Set(s).add(c.ik))
                          })
                        }
                      >
                        {pending ? 'Invited' : 'Invite'}
                      </Button>
                    </Row>
                  </Surface>
                )
              })}
            </Stack>
          )}
        </Stack>
        <Stack as="section" gap="sm">
          <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Invites
          </p>
          <CodeList room={room} version={version} />
        </Stack>
      </Stack>
    </Dialog>
  )
}

type NewTab = 'create' | 'join'

function ServerNewDialogBody({
  tab: first = 'create',
  code: given = '',
  routed,
}: {
  tab?: NewTab
  code?: string
  routed?: { close(): void; valid(): boolean; finish(): void }
}) {
  const ownerAccount = useAccount()

  const identity = useP2pApp()!
  const { p2pServer, p2p } = identity

  const [tab, setTab] = useState<NewTab>(given ? 'join' : first)
  const [name, setName] = useState('')
  const [coOwners, setCoOwners] = useState<string[]>([])
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
    const room = await p2pServer.create(name, coOwners)
    setBusy(false)
    if (!room) setError(ownerAccount.store.getState().toast?.text ?? "Couldn't create the server")
  }
  const join = async () => {
    if (routed && !routed.valid()) return routed.close()
    setBusy(true)
    setError(null)
    const shown = client.shown()
    const navigation = shown.store.navigationMark()
    const selection = client.actorSelectionMark()
    const dialog = identity.useP2p.getState().dialog
    const room = await p2pServer.join(code)
    setBusy(false)
    if (
      !identity.isCurrent() ||
      client.shown() !== shown ||
      client.actorSelectionMark() !== selection ||
      shown.store.navigationMark() !== navigation ||
      (routed ? !routed.valid() : identity.useP2p.getState().dialog !== dialog)
    )
      return
    if (!room) setError(ownerAccount.store.getState().toast?.text ?? "Couldn't join")
    else {
      routed?.finish()
      void p2pServer.open(room)
    }
  }
  return (
    <Dialog title="P2P server" onClose={routed?.close ?? p2p.closeDialog} full>
      {!enabled ? (
        <Stack gap="md" align="start">
          <p className="text-sm text-on-surface-variant">
            Turn on peer-to-peer first: P2P servers live on their members&apos; devices.
          </p>
          <Button variant="filled" size="md" onClick={() => p2p.openDialog({ kind: 'enable' })}>
            Turn on P2P
          </Button>
        </Stack>
      ) : (
        <Stack gap="lg">
          <Row role="tablist" gap="2xs" align="stretch">
            {(
              [
                ['create', 'Create'],
                ['join', 'Join with a code'],
              ] as const
            )
              .filter(([key]) => !routed || key === 'join')
              .map(([key, label]) => (
                <Tab
                  key={key}
                  selected={tab === key}
                  onClick={() => {
                    setTab(key)
                    setError(null)
                  }}
                >
                  {label}
                </Tab>
              ))}
          </Row>
          <CoOwnerAsks />
          {tab === 'create' ? (
            <Stack gap="md">
              <div className="rounded-xl border border-dashed border-tertiary text-sm text-on-surface-variant">
                <Surface pad="md" tone="plain" radius="none">
                  <Row gap="md" align="start">
                    <Waypoints size={18} className="shrink-0 text-tertiary" />
                    <p>
                      A P2P server is stored only on its members&apos; devices: its channels,
                      messages and who may do what. There is no copy on the instance, and the
                      instance doesn&apos;t filter it.
                    </p>
                  </Row>
                </Surface>
              </div>
              <p className="text-xs text-on-surface-variant">{IP_NOTE}</p>
              <input
                autoFocus
                value={name}
                maxLength={p2p.limits().server.nameMax}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && name.trim() && !busy) void create()
                }}
                placeholder="Server name"
                aria-label="Server name"
                className={`${fieldCls} streamer w-full`}
              />
              <p className="text-xs text-on-surface-variant">{OWNER_TEXT}</p>
              <CoOwnerPicker value={coOwners} onChange={setCoOwners} />
              {busy && coOwners.length > 0 && (
                <p role="status" className="text-xs text-on-surface-variant">
                  Waiting for co-owners to agree…
                </p>
              )}
              <FieldError message={error} />
              <Row gap="sm" justify="end">
                <Button size="md" onClick={routed?.close ?? p2p.closeDialog}>
                  Cancel
                </Button>
                <Button
                  variant="filled"
                  size="md"
                  onClick={() => void create()}
                  disabled={!name.trim() || busy}
                >
                  Create
                </Button>
              </Row>
            </Stack>
          ) : (
            <Stack gap="md">
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
              <Button onClick={() => setScan(s => !s)} place="self-start">
                {scan ? 'Paste instead' : 'Scan a QR code'}
              </Button>
              {code.trim() && !peek && (
                <FieldError message="This isn't a P2P server invite code." />
              )}
              {peek && (
                <Surface pad="md" tone="base" radius="lg">
                  <Row gap="md">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-tertiary font-semibold">
                      <Waypoints size={18} className="text-tertiary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="streamer truncate text-sm font-medium">
                        <Masked text={peek.name} />
                      </p>
                      <p className="text-xs text-on-surface-variant">{NEEDS_INVITER}</p>
                    </div>
                    <P2pBadge />
                  </Row>
                </Surface>
              )}
              <p data-p2p-needs-inviter className="text-xs text-on-surface-variant">
                {NEEDS_INVITER}. Your contact code and name go to whoever lets you in.{' '}
                {CODE_RETRY_TEXT}
              </p>
              <p className="text-xs text-on-surface-variant">{IP_NOTE}</p>
              <FieldError message={error} />
              <Row gap="sm" justify="end">
                <Button size="md" onClick={routed?.close ?? p2p.closeDialog}>
                  Cancel
                </Button>
                <Button
                  variant="filled"
                  size="md"
                  onClick={() => void join()}
                  disabled={!peek || busy || !ready}
                >
                  {busy ? 'Joining…' : 'Join'}
                </Button>
              </Row>
            </Stack>
          )}
        </Stack>
      )}
    </Dialog>
  )
}

function P2pFolderDialogBody({ id, colorFirst = false }: { id: string; colorFirst?: boolean }) {
  const identity = useP2pApp()!
  const { p2pRail, p2p } = identity

  const folder = useP2p(s => s.layout.servers.find(e => typeof e !== 'string' && e.id === id))
  const [name, setName] = useState(typeof folder === 'object' ? (folder.name ?? '') : '')
  const [color, setColor] = useState(typeof folder === 'object' ? (folder.color ?? null) : null)
  if (!folder) return null
  const save = () => {
    p2pRail.rename(id, name)
    p2pRail.setFolderColor(id, color)
    p2p.closeDialog()
  }
  return (
    <Dialog title="Edit folder" onClose={p2p.closeDialog} compact>
      <Stack gap="xl">
        <Stack gap="lg">
          <input
            autoFocus={!colorFirst}
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
          <FolderColorField color={color} onColor={setColor} tone="tertiary" />
        </Stack>
        <Row gap="sm" justify="end">
          <Button size="md" onClick={p2p.closeDialog}>
            Cancel
          </Button>
          <Button variant="filled" size="md" onClick={save}>
            Save
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

export const CodeList = withP2pIdentity(CodeListBody)
export const ServerInviteDialog = withP2pIdentity(ServerInviteDialogBody)
export const ServerNewDialog = withP2pIdentity(ServerNewDialogBody)
export const P2pFolderDialog = withP2pIdentity(P2pFolderDialogBody)
