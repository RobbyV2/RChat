'use client'

import { useState } from 'react'
import {
  Ban,
  Check,
  Menu,
  MessageCircle,
  Pencil,
  QrCode as QrIcon,
  ShieldCheck,
  Trash2,
  UserPlus,
  Waypoints,
  X,
} from 'lucide-react'
import { useStore } from '../../lib/store'
import { p2p, p2pDm, useP2p } from '../../lib/p2p/app'
import { badgePings } from '../../lib/p2p/alerts'
import { dmRoomId, movedText, MOVING_TEXT, RESUME_TEXT } from '../../lib/p2p/dm'
import { levelOf, mutedOf } from '../../lib/notify'
import {
  displayName,
  PETNAME_MAX,
  requests as requestsOf,
  shieldOf,
  visibleContacts,
  type Contact,
} from '../../lib/p2p/contacts'
import { fingerprint } from '../../lib/p2p/keys'
import { SQUATTED, type Presence } from '../../lib/p2p/node'
import type { ContextMenuItem } from '../../lib/store_types'
import { enterKey } from '../../lib/keys'
import { longPress } from '../context_menu'
import { PingBadge, RailPingBadge } from '../ping_badge'
import { MutedIcon, notifyMenuItems } from '../notify_menu'
import { P2pDmPane } from './p2p_dm_pane'
import { VoiceDock } from '../voice_grid'
import { dangerBtn, Dialog, fieldCls, filledBtn, iconBtn, textBtn } from '../ui'
import { AddContactDialog } from './add_contact'
import { VerifyDialog } from './verify_dialog'
import { P2pFolderDialog, ServerInviteDialog, ServerNewDialog } from './p2p_invite_dialog'
import { ServerSettingsDialog } from './p2p_server_settings'
import { allServerPings, ServerInviteRows, serverUnread } from './p2p_server_view'
import {
  ContactShield,
  KeyAvatar,
  P2pBadge,
  PresenceDot,
  presenceText,
  shieldText,
} from './p2p_badge'

const tile = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-colors'

// Pings of P2P conversations and P2P server channels (the tab title counts both).
export const useP2pPings = () => {
  const rooms = useP2p(s => s.rooms)
  const servers = useP2p(s => s.servers)
  const prefs = useStore(s => s.notifyPrefs)
  return badgePings(rooms, prefs) + allServerPings(servers, prefs)
}

// Only conversations: the P2P tile badges these, server tiles badge their own.
const useDmPings = () => {
  const rooms = useP2p(s => s.rooms)
  const prefs = useStore(s => s.notifyPrefs)
  return badgePings(rooms, prefs)
}

export const useServerUnread = () => {
  const servers = useP2p(s => s.servers)
  const prefs = useStore(s => s.notifyPrefs)
  return Object.values(servers).some(v => serverUnread(v, prefs))
}

// Unread conversations that show it: muted ones don't.
const useP2pUnread = () => {
  const rooms = useP2p(s => s.rooms)
  const prefs = useStore(s => s.notifyPrefs)
  const now = Date.now()
  return Object.values(rooms).some(
    r => r.unread > 0 && !mutedOf(prefs, { kind: 'p2p', room: r.id }, now)
  )
}

// The rail tile under the home button. Pending requests and pings show as a badge.
export function P2pRailTile() {
  const open = useP2p(s => s.home)
  const pending = useP2p(s => requestsOf(s.contacts).length)
  const pings = useDmPings()
  const unread = useP2pUnread()
  const badge = pending + pings
  const label = [
    'Peer-to-peer',
    pending ? `${pending} message ${pending === 1 ? 'request' : 'requests'}` : '',
    pings ? `${pings} ${pings === 1 ? 'notification' : 'notifications'}` : '',
    unread && !pings ? 'unread messages' : '',
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <button
      data-p2p-tile
      title={label}
      aria-label="Peer-to-peer"
      aria-pressed={open}
      onClick={() => (open ? p2p.closeHome() : p2p.openHome())}
      className={`${tile} relative border-2 border-dashed ${
        open
          ? 'border-tertiary bg-tertiary text-on-tertiary'
          : 'border-tertiary/70 bg-surface-container-high text-tertiary hover:bg-tertiary-container hover:text-on-tertiary-container'
      }`}
    >
      <Waypoints size={22} />
      {badge > 0 && <RailPingBadge count={badge} />}
      {badge === 0 && unread && (
        <span
          data-p2p-unread
          aria-hidden
          className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface-container-lowest bg-on-surface"
        />
      )}
    </button>
  )
}

const ENABLE_COPY =
  'Stored only on your devices. Delivered only when the other side is online. The instance can see when you connect, not what you send. Not filtered or moderated by the instance.'

// Another tab runs P2P for this account; only one tab may at a time.
export function ElsewhereNotice() {
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
      <p>P2P is open in another tab.</p>
      <button data-p2p-use-here onClick={() => p2p.useHere()} className={textBtn}>
        Use here
      </button>
    </div>
  )
}

export const ALERT_TEXT =
  'Your P2P identity may be used on another device. Reset your identity to lock it out.'
export const RESET_BODY =
  'You get a new key. Contacts move over when you next connect, but have to verify you again.'
const RESET_MOVED_BODY =
  'You get a new key. This browser no longer has the old one, so contacts get a request from the new key and have to accept and verify you again.'

export const confirmReset = (ask: ReturnType<typeof useStore.getState>['askConfirm']) =>
  ask({
    title: 'Reset your P2P identity?',
    body: useP2p.getState().movedAt === null ? RESET_BODY : RESET_MOVED_BODY,
    confirm: 'Reset',
    action: () => void p2p.resetIdentity(),
  })

// Contacts showed us signs of another copy of this identity, or it moved without an export here.
export function IdentityAlert() {
  const alertAt = useP2p(s => s.alertAt)
  const ask = useStore(s => s.askConfirm)
  if (alertAt === null) return null
  return (
    <div
      role="alert"
      data-p2p-alert
      className="flex flex-col items-start gap-3 rounded-2xl bg-error-container p-4 text-on-error-container"
    >
      <p className="text-sm">{ALERT_TEXT}</p>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => confirmReset(ask)} className={dangerBtn}>
          Reset identity
        </button>
        <button onClick={() => void p2p.clearAlert()} className={textBtn}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

// A P2P export was made here: sending waits, so nothing written here misses the new device.
export function MovingBanner({
  className = 'flex flex-col items-start gap-3 rounded-2xl bg-surface-container-high p-4',
}: {
  className?: string
}) {
  const movingAt = useP2p(s => s.movingAt)
  const moved = useP2p(s => s.status === 'moved')
  const ask = useStore(s => s.askConfirm)
  if (movingAt === null || moved) return null
  return (
    <div role="status" data-p2p-moving className={className}>
      <p className="text-sm text-on-surface">{MOVING_TEXT}</p>
      <button
        onClick={() =>
          ask({
            title: 'Resume sending here?',
            body: RESUME_TEXT,
            confirm: 'Resume',
            action: () => void p2p.resumeSending(),
          })
        }
        className={textBtn}
      >
        Resume
      </button>
    </div>
  )
}

// This browser's identity moved to another device: it can only read, or remove its copy.
export function MovedBanner() {
  const movedAt = useP2p(s => s.movedAt)
  const ask = useStore(s => s.askConfirm)
  return (
    <div
      role="status"
      data-p2p-moved
      className="flex flex-col items-start gap-3 rounded-2xl bg-surface-container-high p-4"
    >
      <p className="text-sm text-on-surface">{movedText(movedAt)}</p>
      <button
        onClick={() =>
          ask({
            title: 'Remove P2P data from this browser?',
            body: 'The identity lives on the other device now. Contacts and history are deleted from this browser.',
            confirm: 'Remove',
            action: () => void p2p.removeData(),
          })
        }
        className={dangerBtn}
      >
        Remove P2P data from this browser
      </button>
    </div>
  )
}

export function EnableDialog() {
  const [name, setName] = useState('')
  const turnOn = () => {
    p2p.closeDialog()
    void p2p.enable(name)
  }
  return (
    <Dialog title="Turn on peer-to-peer" onClose={p2p.closeDialog} compact>
      <div className="flex flex-col items-start gap-3 text-sm">
        <P2pBadge />
        <p>{ENABLE_COPY}</p>
        <p className="text-on-surface-variant">
          On iPhone and iPad, Safari may delete this data after 7 days without a visit. Install the
          app to keep it longer.
        </p>
        <label className="flex w-full flex-col gap-1">
          <span className="text-xs text-on-surface-variant">
            Name shown to contacts (not your account name)
          </span>
          <input
            value={name}
            maxLength={32}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (enterKey(e)) turnOn()
            }}
            placeholder="P2P user"
            aria-label="P2P display name"
            className={`${fieldCls} streamer`}
          />
        </label>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={p2p.closeDialog} className={textBtn}>
          Cancel
        </button>
        <button onClick={turnOn} className={filledBtn}>
          Turn on
        </button>
      </div>
    </Dialog>
  )
}

function DroppedNote({ n }: { n: number }) {
  return (
    <p className="flex items-center gap-2 px-3 pb-2 text-xs text-on-surface-variant">
      {n === 1 ? '1 request was' : `${n} requests were`} dropped to limit spam.
      <button onClick={() => void p2p.clearDropped()} className="underline">
        Dismiss
      </button>
    </p>
  )
}

const statusText = (status: string, paused: boolean) =>
  status === 'online'
    ? 'Online'
    : status === 'paused' || paused
      ? 'Paused'
      : status === 'squatted'
        ? SQUATTED
        : status === 'moved'
          ? 'Moved to another device'
          : 'Connecting…'

const noticeText = (c: Contact) =>
  c.notice?.kind === 'moved'
    ? `${displayName(c)} moved to a new device`
    : c.notice?.kind === 'reset'
      ? `${displayName(c)} reset their P2P identity`
      : null

export const contactMenu = (c: Contact, me: string | null = null): ContextMenuItem[] => {
  const ask = useStore.getState().askConfirm
  const name = displayName(c)
  const items: ContextMenuItem[] = []
  if (c.state === 'mutual') {
    items.push({ label: 'Message', icon: MessageCircle, action: () => void p2pDm.openDm(c.ik) })
    if (me) items.push(...notifyMenuItems({ kind: 'p2p', room: dmRoomId(me, c.ik) }, 'DM'))
  }
  if (c.state !== 'blocked')
    items.push(
      { label: 'Rename', icon: Pencil, action: () => p2p.openDialog({ kind: 'rename', ik: c.ik }) },
      {
        label: 'Verify',
        icon: ShieldCheck,
        action: () => p2p.openDialog({ kind: 'verify', ik: c.ik }),
      },
      {
        label: 'Block',
        icon: Ban,
        danger: true,
        action: () =>
          ask({
            title: `Block ${name}?`,
            body: 'They can no longer reach you over P2P. You can remove the block later.',
            confirm: 'Block',
            action: () => void p2p.block(c.ik),
          }),
      }
    )
  items.push({
    label: c.state === 'blocked' ? 'Remove block' : 'Remove',
    icon: Trash2,
    danger: c.state !== 'blocked',
    action: () =>
      c.state === 'blocked'
        ? void p2p.remove(c.ik)
        : ask({
            title: `Remove ${name}?`,
            body: 'They stay able to send you a new request.',
            confirm: 'Remove',
            action: () => void p2p.remove(c.ik),
          }),
  })
  return items
}

function ContactRow({
  c,
  presence,
  active = false,
}: {
  c: Contact
  presence: Presence
  active?: boolean
}) {
  const openMenu = useStore(s => s.openContextMenu)
  const me = useP2p(s => s.me)
  const room = me && c.state === 'mutual' ? dmRoomId(me, c.ik) : null
  const summary = useP2p(s => (room ? s.rooms[room] : undefined))
  const prefs = useStore(s => s.notifyPrefs)
  const scope = room ? ({ kind: 'p2p', room } as const) : null
  const pings = summary && scope && levelOf(prefs, scope) !== 'nothing' ? summary.pings : 0
  const unread = !!summary && !!scope && summary.unread > 0 && !mutedOf(prefs, scope, Date.now())
  const notice = noticeText(c)
  const shield = shieldOf(c)
  return (
    <li>
      <button
        data-contact={c.ik}
        data-unread={unread ? '' : undefined}
        aria-current={active || undefined}
        onClick={() =>
          c.state === 'mutual'
            ? void p2pDm.openDm(c.ik)
            : p2p.openDialog({ kind: 'contact', ik: c.ik })
        }
        {...longPress((x, y) => openMenu(x, y, contactMenu(c, me)))}
        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${
          active ? 'bg-surface-container-highest' : 'hover:bg-surface-container-high'
        }`}
      >
        <span className="relative">
          <KeyAvatar ik={c.ik} />
          <PresenceDot presence={presence} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={`streamer truncate text-sm ${unread || pings ? 'font-bold text-on-surface' : 'font-medium'}`}
            >
              {displayName(c)}
            </span>
            <ContactShield kind={shield} size={14} />
            {scope && <MutedIcon scope={scope} size={12} className="text-on-surface-variant" />}
          </span>
          <span className="block truncate text-xs text-on-surface-variant">
            {shield === 'warning'
              ? 'New key: verify before you trust it'
              : (notice ??
                (c.state === 'outgoing'
                  ? 'Request sent'
                  : c.state === 'blocked'
                    ? 'Blocked'
                    : presenceText(presence)))}
          </span>
        </span>
        <PingBadge count={pings} />
        {!pings && unread && (
          <span
            aria-label="Unread"
            role="img"
            className="h-2 w-2 shrink-0 rounded-full bg-on-surface"
          />
        )}
      </button>
    </li>
  )
}

function RequestRow({ c }: { c: Contact }) {
  const shield = shieldOf(c)
  return (
    <li data-request={c.ik} className="rounded-xl bg-surface-container px-3 py-2">
      <div className="flex items-center gap-3">
        <KeyAvatar ik={c.ik} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5">
            <span className="streamer truncate text-sm font-medium">{displayName(c)}</span>
            <ContactShield kind={shield} size={14} />
          </p>
          <p className="streamer truncate font-mono text-[11px] text-on-surface-variant">
            {fingerprint(c.ik)}
          </p>
        </div>
        <button
          title="Accept"
          aria-label="Accept"
          onClick={() => void p2p.accept(c.ik)}
          className={iconBtn}
        >
          <Check size={18} />
        </button>
        <button
          title="Ignore"
          aria-label="Ignore"
          onClick={() => void p2p.ignore(c.ik)}
          className={iconBtn}
        >
          <X size={18} />
        </button>
        <button
          title="Block"
          aria-label="Block"
          onClick={() => void p2p.block(c.ik)}
          className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-error"
        >
          <Ban size={18} />
        </button>
      </div>
      {shield === 'warning' && (
        <p className="mt-1 text-xs text-error">Uses the same name as one of your contacts.</p>
      )}
      {c.intros.map((t, i) => (
        <p key={i} className="streamer mt-1 text-sm break-words whitespace-pre-wrap">
          {t}
        </p>
      ))}
    </li>
  )
}

function Off() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-4 px-6 py-10">
      <Waypoints size={40} className="text-tertiary" />
      <h2 className="text-xl font-medium">Peer-to-peer contacts</h2>
      <p className="text-sm text-on-surface-variant">{ENABLE_COPY}</p>
      <button onClick={() => p2p.openDialog({ kind: 'enable' })} className={filledBtn}>
        Turn on P2P
      </button>
    </div>
  )
}

// Conversations on the left (desktop), the open one on the right.
function DmList() {
  const contacts = useP2p(s => s.contacts)
  const presence = useP2p(s => s.presence)
  const rooms = useP2p(s => s.rooms)
  const me = useP2p(s => s.me)
  const open = useP2p(s => s.chat?.peer)
  const list = visibleContacts(contacts)
    .filter(c => c.state === 'mutual')
    .sort((a, b) => {
      const ta = me ? (rooms[dmRoomId(me, a.ik)]?.lastTs ?? 0) : 0
      const tb = me ? (rooms[dmRoomId(me, b.ik)]?.lastTs ?? 0) : 0
      return tb - ta || displayName(a).localeCompare(displayName(b))
    })
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-r border-outline-variant bg-surface-container-low md:flex">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-4">
        <button onClick={p2pDm.closeDm} className="font-medium hover:underline">
          Contacts
        </button>
        <P2pBadge />
      </header>
      <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {list.map(c => (
          <ContactRow
            key={c.ik}
            c={c}
            presence={presence[c.ik] ?? 'offline'}
            active={c.ik === open}
          />
        ))}
      </ul>
      <VoiceDock />
    </aside>
  )
}

export function P2pHome({ onMenu }: { onMenu: () => void }) {
  const chatOpen = useP2p(s => s.chat !== null)
  if (chatOpen)
    return (
      <div className="flex min-w-0 flex-1">
        <DmList />
        <P2pDmPane onBack={p2pDm.closeDm} onMenu={onMenu} />
      </div>
    )
  return <P2pContacts onMenu={onMenu} />
}

function P2pContacts({ onMenu }: { onMenu: () => void }) {
  const enabled = useP2p(s => s.enabled)
  const loading = useP2p(s => s.loading)
  const status = useP2p(s => s.status)
  const paused = useP2p(s => s.paused)
  const contacts = useP2p(s => s.contacts)
  const presence = useP2p(s => s.presence)
  const elsewhere = useP2p(s => s.elsewhere)
  const reader = useP2p(s => s.reader)
  const dropped = useP2p(s => s.dropped)
  const [showBlocked, setShowBlocked] = useState(false)
  const list = visibleContacts(contacts)
  const pending = requestsOf(contacts)
  const blockedList = contacts.filter(c => c.state === 'blocked')

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-outline-variant px-4">
        <button
          title="Menu"
          aria-label="Menu"
          onClick={onMenu}
          className="rounded-full p-1.5 hover:bg-surface-container-high md:hidden"
        >
          <Menu size={20} />
        </button>
        <span className="font-medium">Contacts</span>
        <P2pBadge />
        {enabled && !elsewhere && (
          <span
            data-p2p-status={status}
            className="min-w-0 truncate text-xs text-on-surface-variant"
          >
            {loading ? 'Starting…' : statusText(status, paused)}
          </span>
        )}
        <span className="flex-1" />
        {enabled && !loading && !elsewhere && (
          <>
            <button
              title="Show my code"
              aria-label="Show my code"
              onClick={() => p2p.openDialog({ kind: 'add', tab: 'mine' })}
              className={iconBtn}
            >
              <QrIcon size={20} />
            </button>
            <button
              title="Add contact"
              aria-label="Add contact"
              onClick={() => p2p.openDialog({ kind: 'add' })}
              className={iconBtn}
            >
              <UserPlus size={20} />
            </button>
          </>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!enabled ? (
          <Off />
        ) : elsewhere && !reader ? (
          <div className="mx-auto flex max-w-2xl flex-col p-4">
            <ElsewhereNotice />
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
            {elsewhere && <ElsewhereNotice />}
            {!elsewhere && <IdentityAlert />}
            {status === 'moved' && !elsewhere && <MovedBanner />}
            {!elsewhere && <MovingBanner />}
            {dropped > 0 && <DroppedNote n={dropped} />}
            <ServerInviteRows />
            {pending.length > 0 && (
              <section aria-label="Message requests">
                <p className="px-3 pb-2 text-xs font-medium tracking-wide text-on-surface-variant uppercase">
                  Message requests ({pending.length})
                </p>
                <ul className="flex flex-col gap-2">
                  {pending.map(c => (
                    <RequestRow key={c.ik} c={c} />
                  ))}
                </ul>
              </section>
            )}
            {list.length === 0 && pending.length === 0 ? (
              <div className="flex flex-col items-start gap-3 px-3 py-6">
                <p className="font-medium">No P2P contacts yet</p>
                <p className="text-sm text-on-surface-variant">
                  Swap contact codes with someone: scan theirs, paste it, or show them yours.
                </p>
                <div className="flex gap-2">
                  <button onClick={() => p2p.openDialog({ kind: 'add' })} className={filledBtn}>
                    Add contact
                  </button>
                  <button
                    onClick={() => p2p.openDialog({ kind: 'add', tab: 'mine' })}
                    className={textBtn}
                  >
                    Show my code
                  </button>
                </div>
              </div>
            ) : (
              list.length > 0 && (
                <section aria-label="Contacts">
                  <p className="px-3 pb-2 text-xs font-medium tracking-wide text-on-surface-variant uppercase">
                    Contacts ({list.length})
                  </p>
                  <ul className="flex flex-col">
                    {list.map(c => (
                      <ContactRow key={c.ik} c={c} presence={presence[c.ik] ?? 'offline'} />
                    ))}
                  </ul>
                </section>
              )
            )}
            {blockedList.length > 0 && (
              <section>
                <button onClick={() => setShowBlocked(v => !v)} className={textBtn}>
                  {showBlocked ? 'Hide blocked' : `Blocked (${blockedList.length})`}
                </button>
                {showBlocked && (
                  <ul className="mt-2 flex flex-col">
                    {blockedList.map(c => (
                      <ContactRow key={c.ik} c={c} presence="offline" />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  )
}

function ContactDialog({ ik }: { ik: string }) {
  const c = useP2p(s => s.contacts.find(x => x.ik === ik))
  const presence = useP2p(s => s.presence[ik] ?? 'offline')
  if (!c) return null
  const shield = shieldOf(c)
  const notice = noticeText(c)
  return (
    <Dialog title="P2P contact" onClose={p2p.closeDialog} full>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="relative">
            <KeyAvatar ik={c.ik} size={48} />
            <PresenceDot presence={presence} />
          </span>
          <div className="min-w-0">
            <p className="streamer truncate text-lg font-medium">{displayName(c)}</p>
            {c.petname && c.name && (
              <p className="streamer truncate text-xs text-on-surface-variant">
                Calls themselves {c.name}
              </p>
            )}
            <p className="text-xs text-on-surface-variant">
              {c.state === 'outgoing'
                ? 'Request sent. They see it the next time you are both online.'
                : c.state === 'blocked'
                  ? 'Blocked'
                  : presenceText(presence)}
            </p>
          </div>
        </div>
        <button
          onClick={() => p2p.openDialog({ kind: 'verify', ik })}
          className="flex items-center gap-2 rounded-xl bg-surface-container px-3 py-2 text-left text-sm hover:bg-surface-container-highest"
        >
          <ContactShield kind={shield} />
          <span className="flex-1">
            {shieldText(shield)}
            {c.verifiedAt && shield === 'verified' && (
              <span className="text-on-surface-variant">
                {' '}
                on {new Date(c.verifiedAt).toLocaleDateString()}
              </span>
            )}
          </span>
          <span className="text-primary">Verify</span>
        </button>
        {notice && <p className="text-sm text-on-surface-variant">{notice}</p>}
        <p className="streamer font-mono text-xs text-on-surface-variant">{fingerprint(c.ik)}</p>
        <div className="flex flex-wrap justify-end gap-2">
          {contactMenu(c, useP2p.getState().me)
            .filter(item => item.action && !item.submenu)
            .map(item => (
              <button
                key={item.label}
                onClick={item.action}
                className={
                  item.danger
                    ? 'rounded-full px-3 py-1.5 text-sm font-medium text-error hover:bg-surface-container-highest'
                    : textBtn
                }
              >
                {item.label}
              </button>
            ))}
        </div>
      </div>
    </Dialog>
  )
}

function RenameDialog({ ik }: { ik: string }) {
  const c = useP2p(s => s.contacts.find(x => x.ik === ik))
  const [name, setName] = useState(c?.petname ?? '')
  if (!c) return null
  const save = () => {
    void p2p.rename(ik, name)
    p2p.closeDialog()
  }
  return (
    <Dialog title="Rename contact" onClose={p2p.closeDialog} compact>
      <input
        autoFocus
        value={name}
        maxLength={PETNAME_MAX}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (enterKey(e)) save()
        }}
        placeholder={c.name || 'Name'}
        aria-label="Name for this contact"
        className={`${fieldCls} w-full`}
      />
      <p className="pt-1.5 text-xs text-on-surface-variant">
        Only you see this name. Leave empty to use theirs.
      </p>
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

export function P2pDialogs() {
  const dialog = useP2p(s => s.dialog)
  const me = useStore(s => s.me !== null)
  if (!dialog || !me) return null
  switch (dialog.kind) {
    case 'add':
      return <AddContactDialog initial={dialog.tab} />
    case 'verify':
      return <VerifyDialog ik={dialog.ik} />
    case 'contact':
      return <ContactDialog key={dialog.ik} ik={dialog.ik} />
    case 'rename':
      return <RenameDialog key={dialog.ik} ik={dialog.ik} />
    case 'enable':
      return <EnableDialog />
    case 'server_new':
      return <ServerNewDialog tab={dialog.tab} code={dialog.code} />
    case 'server_invite':
      return <ServerInviteDialog key={dialog.room} room={dialog.room} />
    case 'server_settings':
      return <ServerSettingsDialog key={dialog.room} room={dialog.room} tab={dialog.tab} />
    case 'p2p_folder':
      return <P2pFolderDialog key={dialog.id} id={dialog.id} />
  }
}
