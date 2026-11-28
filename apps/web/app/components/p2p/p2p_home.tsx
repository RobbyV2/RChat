'use client'
import { Covered } from '../covered'
import { Name, NameInput } from '../name'
import { p2pKey, p2pName, notAName, labelList, unnamed, type Label } from '../../lib/names'
import { identityPerson } from '../../lib/people'
import { ActorLabel, PeerActorTag, usePeerActor } from '../view_actor'
import { IdentityEnrollment } from './identity_enrollment'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'
import type { P2pApp } from '../../lib/p2p/app/runtime'

import { client } from '../../lib/client/client'
import { useAccount } from '../../lib/client/react'

import { useSyncExternalStore, useState } from 'react'
import {
  Ban,
  Check,
  Menu,
  Fingerprint,
  QrCode as QrIcon,
  UserPlus,
  Waypoints,
  X,
} from 'lucide-react'
import { useStore, type RChatState } from '../../lib/store'

import { p2pTileCount } from '../../lib/p2p/alerts'
import { dmRoomId, movedText, MOVING_TEXT, RESUME_TEXT } from '../../lib/p2p/dm'
import { levelOf, mutedOf } from '../../lib/notify'
import {
  displayName,
  requests as requestsOf,
  shieldOf,
  visibleContacts,
  type Contact,
} from '../../lib/p2p/contacts'
import { fingerprint } from '../../lib/p2p/keys'
import {
  ADDRESS_HIDDEN,
  UNREACHABLE_TEXT,
  UNSUPPORTED_TEXT,
  type Presence,
} from '../../lib/p2p/node'
import { NOT_STARTED, startFailure, statusText } from '../../lib/p2p/home_card'
import { addsContacts, conversations } from '../../lib/p2p/conversations'
import { enterKey } from '../../lib/keys'
import { longPress } from '../context_menu'
import { PingBadge, RailPingBadge } from '../ping_badge'
import { TypingEllipsis } from '../typing_indicator'
import { MutedIcon } from '../notify_menu'
import { P2pDmPane } from './p2p_dm_pane'
import { VoiceDock } from '../voice_grid'
import { Dialog, fieldCls, Masked, TopDialog } from '../ui'
import { AddContactDialog } from './add_contact'
import { VerifyDialog } from './verify_dialog'
import { P2pFolderDialog, ServerInviteDialog, ServerNewDialog } from './p2p_invite_dialog'
import { ProfileResetDialog, ServerProfileDialog } from './p2p_server_profile'
import { ServerSettingsDialog } from './p2p_server_settings'
import { PermsDialog } from './p2p_server_roles'
import { P2pSeparatorDialog } from './p2p_separator_dialog'
import { ServerInviteRows } from './p2p_server_view'
import { CoOwnerAsks, LostDeviceDialog, RecoverDialog, TransferAsks } from './p2p_server_flows'
import {
  AccountChip,
  badgeDate,
  ContactShield,
  KeyAvatar,
  P2pBadge,
  useHasChip,
  PresenceDot,
  presenceText,
  shieldText,
} from './p2p_badge'
import { badgeState } from '../../lib/p2p/badge'
import { ctxFor } from '../../lib/actions/ctx'
import { menuItems, openActionMenu } from '../../lib/actions/menu'
import { peerContact } from '../../lib/actions/p2p_contact'
import { LabelText, useInstanceLabel } from '../instance_badge'
import { useDrawerClose } from '../drawer'
import { DmListSkeleton } from '../skeletons'
import { Row, Stack, Surface, Inset } from '../layout'
import { GateNote } from '../gate_note'
import { time } from '../../lib/platform/time'
import { Button, IconButton, LinkButton, Tile, CardButton } from '../controls'

// When the conversation with a contact last had a message (0 without one).
export const lastTsOf =
  (rooms: Record<string, { lastTs: number }>, me: string | null) => (ik: string) =>
    me ? (rooms[dmRoomId(me, ik)]?.lastTs ?? 0) : 0

const count = (n: number, one: string, many: string) =>
  n ? [notAName(`${n} ${n === 1 ? one : many}`)] : []

// The P2P tile in the rail's P2P frame: opens the contacts. What waits for an answer (message
// requests, server invites, co-owner and transfer asks) shows as its badge; conversation pings
// count on the DM tile.
function P2pRailTileBody({ actorLabel }: { actorLabel?: Label }) {
  const identity = useP2pApp()!
  const { p2p } = identity

  const acct = useAccount()

  const open = useP2p(s => s.home && !s.dmList)
  const enabled = useP2p(s => s.enabled)
  const pending = useP2p(s => requestsOf(s.contacts).length)
  const invites = useP2p(s => s.serverInvites.length)
  const asks = useP2p(s => s.coOwnerAsks.length + s.transferAsks.length)
  const badge = useP2p(p2pTileCount)
  const label = labelList([
    actorLabel ?? unnamed('Peer-to-peer'),
    ...count(pending, 'message request', 'message requests'),
    ...count(invites, 'server invite', 'server invites'),
    ...count(asks, 'request to answer', 'requests to answer'),
  ])
  return (
    <Tile
      data-p2p-tile
      data-peer-home
      onClick={() => {
        const alreadyShown = client.shown() === acct && acct.identities.viewed() === identity
        if (!alreadyShown && actorLabel) {
          client.show(acct)
          acct.identities.show(identity)
        }
        if (open && (alreadyShown || !actorLabel)) p2p.closeHome()
        else p2p.openHome()
      }}
      {...(enabled
        ? longPress((x, y) => openActionMenu(x, y, { kind: 'p2p_home' }, undefined, acct, identity))
        : {})}
      tone={open ? 'p2p-active' : 'p2p'}
      label={actorLabel ?? 'Peer-to-peer'}
      tooltip={label}
      pressed={open}
    >
      {actorLabel ? (
        <span className="rounded-full outline-2 outline-dashed outline-tertiary">
          <KeyAvatar
            person={identityPerson(identity.useP2p.getState().ik ?? identity.localId, 'own')}
            size={28}
            covered
          />
        </span>
      ) : (
        <Waypoints size={22} />
      )}
      {badge > 0 && <RailPingBadge count={badge} />}
    </Tile>
  )
}

const ENABLE_COPY =
  'Stored only on your devices. Delivered only when the other side is online. The instance can see when you connect, not what you send. Not filtered or moderated by the instance.'

// Another tab runs P2P for this account; only one tab may at a time.
function ElsewhereNoticeBody() {
  const identity = useP2pApp()!
  const { p2p } = identity

  return (
    <Surface role="status" pad="md" tone="plain" radius="none">
      <Row gap="md" wrap>
        <p className="text-sm">P2P is open in another tab.</p>
        <Button data-p2p-use-here onClick={() => p2p.useHere()}>
          Use here
        </Button>
      </Row>
    </Surface>
  )
}

export const ALERT_TEXT =
  'Your P2P identity may be used on another device. Reset your identity to lock it out.'
export const RESET_BODY =
  'You get a new key. Contacts move over when you next connect, but have to verify you again.'
const RESET_MOVED_BODY =
  'You get a new key. This browser no longer has the old one, so contacts get a request from the new key and have to accept and verify you again.'

export const confirmResetFor = (identity: P2pApp) => (ask: RChatState['askConfirm']) => {
  const { p2p } = identity
  return ask({
    title: 'Reset your P2P identity?',
    body: identity.useP2p.getState().movedAt === null ? RESET_BODY : RESET_MOVED_BODY,
    confirm: 'Reset',
    action: () => void p2p.resetIdentity(),
  })
}

// Contacts showed us signs of another copy of this identity, or it moved without an export here.
function IdentityAlertBody() {
  const identity = useP2pApp()!
  const { p2p } = identity

  const alertAt = useP2p(s => s.alertAt)
  const ask = useStore(s => s.askConfirm)
  if (alertAt === null) return null
  return (
    <Surface role="alert" data-p2p-alert pad="lg" gap="md" tone="error" align="start">
      <p className="text-sm">{ALERT_TEXT}</p>
      <Row gap="sm" align="stretch" wrap>
        <Button variant="danger" onClick={() => confirmResetFor(identity)(ask)}>
          Reset identity
        </Button>
        <Button onClick={() => void p2p.clearAlert()}>Dismiss</Button>
      </Row>
    </Surface>
  )
}

// A P2P export was made here: sending waits, so nothing written here misses the new device.
// `bar`: in the composer's place.
function MovingBannerBody({ bar = false }: { bar?: boolean }) {
  const identity = useP2pApp()!
  const { p2p } = identity

  const movingAt = useP2p(s => s.movingAt)
  const moved = useP2p(s => s.status === 'moved')
  const ask = useStore(s => s.askConfirm)
  if (movingAt === null || moved) return null
  const body = (
    <>
      <p className="text-sm text-on-surface">{MOVING_TEXT}</p>
      <Button
        onClick={() =>
          ask({
            title: 'Resume sending here?',
            body: RESUME_TEXT,
            confirm: 'Resume',
            action: () => void p2p.resumeSending(),
          })
        }
      >
        Resume
      </Button>
    </>
  )
  if (bar)
    return (
      <GateNote role="status" data-p2p-moving>
        {body}
      </GateNote>
    )
  return (
    <Surface role="status" data-p2p-moving pad="lg" gap="md" align="start">
      {body}
    </Surface>
  )
}

// The PeerJS server didn't answer: the node keeps trying, and Retry tries now.
function UnreachableNoticeBody() {
  const identity = useP2pApp()!
  const { p2p } = identity

  return (
    <Surface role="status" data-p2p-unreachable pad="lg" gap="md" align="start">
      <p className="text-sm text-on-surface">{UNREACHABLE_TEXT}</p>
      <Button onClick={() => void p2p.retry()}>Retry</Button>
    </Surface>
  )
}

// PeerJS found no WebRTC here: no retry helps, so there is no Retry.
export function UnsupportedNotice() {
  return (
    <Surface role="status" data-p2p-unsupported pad="lg">
      <p className="text-sm break-words text-on-surface">{UNSUPPORTED_TEXT}</p>
    </Surface>
  )
}

function AddressNoticeBody() {
  const identity = useP2pApp()!
  const { p2p } = identity

  return (
    <Surface role="status" data-p2p-address-hidden pad="lg" gap="md" align="start">
      <p className="text-sm text-on-surface">{ADDRESS_HIDDEN}</p>
      <Button onClick={p2p.dismissAddress}>Dismiss</Button>
    </Surface>
  )
}

// This browser's identity moved to another device: it can only read, or remove its copy.
function MovedBannerBody() {
  const identity = useP2pApp()!
  const { p2p } = identity

  const movedAt = useP2p(s => s.movedAt)
  const ask = useStore(s => s.askConfirm)
  return (
    <Surface role="status" data-p2p-moved pad="lg" gap="md" align="start">
      <p className="text-sm text-on-surface">{movedText(movedAt)}</p>
      <Button
        variant="danger"
        onClick={() =>
          ask({
            title: 'Remove P2P data from this browser?',
            body: 'The identity lives on the other device now. Contacts and history are deleted from this browser.',
            confirm: 'Remove',
            action: () => void p2p.removeData(),
          })
        }
      >
        Remove P2P data from this browser
      </Button>
    </Surface>
  )
}

function EnableDialogBody() {
  const identity = useP2pApp()!
  const { p2p } = identity

  const account = useAccount()
  return (
    <TopDialog label="Add a P2P identity" wide backdrop onCancel={p2p.closeDialog}>
      <IdentityEnrollment account={account} cancel={p2p.closeDialog} />
    </TopDialog>
  )
}

function DroppedNote({ n }: { n: number }) {
  const identity = useP2pApp()!
  const { p2p } = identity

  return (
    <Surface pad="md" inset="bar" tone="plain" radius="none">
      <Row as="p" gap="sm">
        <span className="text-xs text-on-surface-variant">
          {n === 1 ? '1 request was' : `${n} requests were`} dropped to limit spam.
        </span>
        <span className="text-xs">
          <LinkButton onClick={() => void p2p.clearDropped()} tone="muted" underlined>
            Dismiss
          </LinkButton>
        </span>
      </Row>
    </Surface>
  )
}

// What happened to a contact's identity, as the words after their name.
const noticeText = (c: Contact) =>
  c.notice?.kind === 'moved'
    ? 'moved to a new device'
    : c.notice?.kind === 'reset'
      ? 'reset their P2P identity'
      : null

function ContactNotice({ c, words }: { c: Contact; words: string }) {
  return (
    <>
      <Name of={p2pName(displayName(c))} /> {words}
    </>
  )
}

// A contact: opens the conversation (in the P2P home, or beside the instance's DM list with
// `where="dms"`), or the contact's card while it isn't mutual.
function ContactRowBody({
  c,
  presence,
  active = false,
  where = 'home',
}: {
  c: Contact
  presence: Presence
  active?: boolean
  where?: 'home' | 'dms'
}) {
  const identity = useP2pApp()!
  const { p2p, p2pDm } = identity

  const acct = useAccount()

  const me = useP2p(s => s.me)
  const room = me && c.state === 'mutual' ? dmRoomId(me, c.ik) : null
  const summary = useP2p(s => (room ? s.rooms[room] : undefined))
  const typingOn = useStore(s => s.typingOn)
  const typing = useP2p(s => typingOn && !!room && (s.typing[room] ?? []).includes(c.ik))
  const prefs = useStore(s => s.notifyPrefs)
  const scope = room ? ({ kind: 'p2p', room } as const) : null
  const pings = summary && scope && levelOf(prefs, scope) !== 'nothing' ? summary.pings : 0
  const unread =
    !!summary && !!scope && summary.unread > 0 && !mutedOf(prefs, scope, acct.time.now())
  const notice = noticeText(c)
  const shield = shieldOf(c)
  const ownsContact = () =>
    client.book
      .getState()
      .instances.some(i => i.accounts.some(a => a.identities.some(peer => peer.ik === c.ik)))
  const yours = useSyncExternalStore(client.book.subscribe, ownsContact, () => false)
  const chip = useHasChip(c.ik)
  const closeDrawer = useDrawerClose()
  return (
    <li>
      <CardButton
        data-contact={c.ik}
        data-unread={unread ? '' : undefined}
        onClick={() => {
          if (c.state !== 'mutual') return p2p.openDialog({ kind: 'contact', ik: c.ik })
          closeDrawer()
          void p2pDm.openDm(c.ik, where)
        }}
        {...longPress((x, y) =>
          peerContact.forIdentity(identity).openContactMenu(x, y, c, me, acct)
        )}
        pad={where === 'dms' ? 'sm' : 'md'}
        current={!!active}
        place="w-full"
      >
        <span className="relative shrink-0">
          <KeyAvatar
            person={identityPerson(c.ik, 'contact')}
            size={where === 'dms' ? 28 : undefined}
          />
          <PresenceDot presence={presence} />
        </span>
        <span className="min-w-0 flex-1">
          <Row as="span" gap="xs">
            <Name
              of={p2pName(displayName(c))}
              place={chip ? 'max-w-3/5 shrink-0' : undefined}
              look={
                unread || pings
                  ? 'truncate text-sm font-bold text-on-surface'
                  : 'truncate text-sm font-medium'
              }
            />
            {yours && <span className="text-xs text-on-surface-variant">yours</span>}
            <ContactShield kind={shield} size={14} />
            <AccountChip ik={c.ik} />
            {scope && <MutedIcon scope={scope} size={12} className="text-on-surface-variant" />}
          </Row>
          <span className="block truncate text-xs text-on-surface-variant">
            {shield === 'warning'
              ? 'New key: verify before you trust it'
              : ((notice && <ContactNotice c={c} words={notice} />) ??
                (c.state === 'outgoing'
                  ? 'Request sent'
                  : c.state === 'blocked'
                    ? 'Blocked'
                    : presenceText(presence)))}
          </span>
        </span>
        {typing && <TypingEllipsis names={[displayName(c)]} p2p />}
        <PingBadge count={pings} />
        {!pings && unread && !typing && (
          <span
            aria-label="Unread"
            role="img"
            className="h-2 w-2 shrink-0 rounded-full bg-on-surface"
          />
        )}
      </CardButton>
    </li>
  )
}

function RequestRow({ c }: { c: Contact }) {
  const identity = useP2pApp()!
  const { p2p } = identity

  const shield = shieldOf(c)
  const chip = useHasChip(c.ik)
  return (
    <Surface as="li" data-request={c.ik} pad="md" gap="2xs" tone="base" radius="lg">
      <Row gap="md">
        <KeyAvatar person={identityPerson(c.ik, 'request')} />
        <div className="min-w-0 flex-1">
          <Row as="p" gap="xs">
            <Name
              of={p2pName(displayName(c))}
              place={chip ? 'max-w-3/5 shrink-0' : undefined}
              look="truncate text-sm font-medium"
            />
            <ContactShield kind={shield} size={14} />
            <AccountChip ik={c.ik} />
          </Row>
          <Name
            as="p"
            of={p2pKey(fingerprint(c.ik))}
            look="truncate font-mono text-2xs text-on-surface-variant"
          />
        </div>
        <IconButton icon={Check} label="Accept" size="lg" onClick={() => void p2p.accept(c.ik)} />
        <IconButton icon={X} label="Ignore" size="lg" onClick={() => void p2p.ignore(c.ik)} />
        <IconButton icon={Ban} label="Block" tone="danger" onClick={() => void p2p.block(c.ik)} />
      </Row>
      {shield === 'warning' && (
        <p className="text-xs text-error">Uses the same name or account as one of your contacts.</p>
      )}
      {c.intros.map((t, i) => (
        <Covered what="about" as="p" key={i} look="text-sm break-words whitespace-pre-wrap">
          <Masked text={t} />
        </Covered>
      ))}
    </Surface>
  )
}

function Off() {
  const identity = useP2pApp()!
  const { p2p } = identity

  const error = useP2p(s => s.error)
  return (
    <Surface pad="2xl" gap="lg" tone="plain" radius="none" align="start" place="mx-auto max-w-md">
      <Waypoints size={40} className="text-tertiary" />
      <h2 className="text-xl font-medium">Peer-to-peer contacts</h2>
      <p className="text-sm text-on-surface-variant">{ENABLE_COPY}</p>
      {error && (
        <p role="alert" className="text-sm text-error">
          <LabelText text={error} />
        </p>
      )}
      <Button variant="filled" size="md" onClick={() => p2p.openDialog({ kind: 'enable' })}>
        Turn on P2P
      </Button>
    </Surface>
  )
}

// Conversations on the left (desktop), the open one on the right.
function DmList() {
  const identity = useP2pApp()!
  const { p2pDm } = identity

  const contacts = useP2p(s => s.contacts)
  const presence = useP2p(s => s.presence)
  const rooms = useP2p(s => s.rooms)
  const me = useP2p(s => s.me)
  const open = useP2p(s => s.chat?.peer)
  const loading = useP2p(s => s.loading)
  const list = conversations(contacts, lastTsOf(rooms, me))
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-r border-outline-variant bg-surface-container-low md:flex">
      <Surface
        as="header"
        pad="lg"
        inset="sides"
        gap="sm"
        row
        tone="plain"
        radius="none"
        border="bottom"
        look="h-14"
        place="shrink-0"
      >
        <LinkButton onClick={p2pDm.closeDm} tone="inherit">
          Contacts
        </LinkButton>
        <P2pBadge />
      </Surface>
      {loading && !list.length ? (
        <Surface pad="sm" tone="plain" radius="none" place="min-h-0 flex-1 overflow-hidden">
          <DmListSkeleton seed={identity.localId} label="Loading contacts" className="flex-1" />
        </Surface>
      ) : (
        <Surface as="ul" pad="sm" tone="plain" radius="none" place="min-h-0 flex-1 overflow-y-auto">
          {list.map(c => (
            <ContactRow
              key={c.ik}
              c={c}
              presence={presence[c.ik] ?? 'offline'}
              active={c.ik === open}
            />
          ))}
        </Surface>
      )}
      <VoiceDock />
    </aside>
  )
}

function P2pHomeBody({ onMenu }: { onMenu: () => void }) {
  const identity = useP2pApp()!
  const { p2pDm } = identity

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
  const actor = usePeerActor()
  const identity = useP2pApp()!
  const { p2p } = identity

  const { label } = useInstanceLabel()
  const enabled = useP2p(s => s.enabled)
  const loading = useP2p(s => s.loading)
  const status = useP2p(s => s.status)
  const paused = useP2p(s => s.paused)
  const contacts = useP2p(s => s.contacts)
  const presence = useP2p(s => s.presence)
  const elsewhere = useP2p(s => s.elsewhere)
  const reader = useP2p(s => s.reader)
  const dropped = useP2p(s => s.dropped)
  const addressHidden = useP2p(s => s.addressHidden)
  const failure = useP2p(s => startFailure(s))
  const [showBlocked, setShowBlocked] = useState(false)
  const list = visibleContacts(contacts)
  const pending = requestsOf(contacts)
  const blockedList = contacts.filter(c => c.state === 'blocked')
  const adds = addsContacts({ enabled, loading, elsewhere })

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface">
      <Inset
        as="header"
        row
        pad="lg"
        inset="sides"
        gap={actor ? '2xs' : 'md'}
        border="bottom"
        look="h-14"
        place="shrink-0"
      >
        <IconButton
          icon={Menu}
          label="Menu"
          onClick={onMenu}
          size="lg"
          tone="inherit"
          place="md:hidden"
        />
        <ActorLabel actor={actor} header />
        <span className="font-medium">Contacts</span>
        <P2pBadge />
        {enabled && !elsewhere && (
          <span
            data-p2p-status={status}
            className="min-w-0 truncate text-xs text-on-surface-variant"
          >
            {loading ? (
              'Starting…'
            ) : (
              <LabelText
                text={failure === null ? statusText(status, paused, label) : NOT_STARTED}
              />
            )}
          </span>
        )}
        <span className="flex-1" />
        {enabled && (
          <Button
            title="Add a P2P identity"
            onClick={() => p2p.openDialog({ kind: 'enable' })}
            place="shrink-0"
          >
            {actor && <Fingerprint size={20} className="sm:hidden" aria-hidden />}
            <span className={actor ? 'max-sm:sr-only' : undefined}>Add a P2P identity</span>
          </Button>
        )}
        {adds && (
          <>
            <IconButton
              icon={QrIcon}
              label="Show my code"
              size="lg"
              onClick={() => p2p.openDialog({ kind: 'add', tab: 'mine' })}
            />
            <IconButton
              icon={UserPlus}
              label="Add contact"
              size="lg"
              onClick={() => p2p.openDialog({ kind: 'add' })}
            />
          </>
        )}
      </Inset>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!enabled ? (
          <Off />
        ) : elsewhere && !reader ? (
          <Surface pad="lg" tone="plain" radius="none" place="mx-auto max-w-2xl">
            <ElsewhereNotice />
          </Surface>
        ) : (
          <Surface pad="lg" gap="xl" tone="plain" radius="none" place="mx-auto max-w-2xl">
            {elsewhere && <ElsewhereNotice />}
            {!elsewhere && <IdentityAlert />}
            {status === 'moved' && !elsewhere && <MovedBanner />}
            {status === 'unreachable' && !elsewhere && <UnreachableNotice />}
            {status === 'unsupported' && !elsewhere && <UnsupportedNotice />}
            {failure !== null && (
              <Surface as="p" role="alert" data-p2p-not-started pad="lg" tone="error">
                <span className="text-sm break-words">
                  <LabelText text={failure} />
                </span>
              </Surface>
            )}
            {addressHidden && status === 'online' && !elsewhere && <AddressNotice />}
            {!elsewhere && <MovingBanner />}
            {dropped > 0 && <DroppedNote n={dropped} />}
            <CoOwnerAsks />
            <TransferAsks />
            <ServerInviteRows />
            {pending.length > 0 && (
              <Stack as="section" aria-label="Message requests" gap="none">
                <Surface pad="md" inset="bar" tone="plain" radius="none">
                  <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
                    Message requests ({pending.length})
                  </p>
                </Surface>
                <Stack as="ul" gap="sm">
                  {pending.map(c => (
                    <RequestRow key={c.ik} c={c} />
                  ))}
                </Stack>
              </Stack>
            )}
            {list.length === 0 && pending.length === 0 && loading ? (
              <DmListSkeleton seed={identity.localId} label="Loading contacts" />
            ) : list.length === 0 && pending.length === 0 ? (
              <Surface pad="xl" gap="md" tone="plain" radius="none" align="start">
                <p className="font-medium">No P2P contacts yet</p>
                <p className="text-sm text-on-surface-variant">
                  Swap contact codes with someone: scan theirs, paste it, or show them yours.
                </p>
                {adds && (
                  <Row gap="sm" align="stretch">
                    <Button
                      variant="filled"
                      size="md"
                      onClick={() => p2p.openDialog({ kind: 'add' })}
                    >
                      Add contact
                    </Button>
                    <Button onClick={() => p2p.openDialog({ kind: 'add', tab: 'mine' })}>
                      Show my code
                    </Button>
                  </Row>
                )}
              </Surface>
            ) : (
              list.length > 0 && (
                <Stack as="section" aria-label="Contacts" gap="none">
                  <Surface pad="md" inset="bar" tone="plain" radius="none">
                    <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
                      Contacts ({list.length})
                    </p>
                  </Surface>
                  <Stack as="ul" gap="none">
                    {list.map(c => (
                      <ContactRow key={c.ik} c={c} presence={presence[c.ik] ?? 'offline'} />
                    ))}
                  </Stack>
                </Stack>
              )
            )}
            {blockedList.length > 0 && (
              <Stack as="section" gap="sm" align="start">
                <Button onClick={() => setShowBlocked(v => !v)}>
                  {showBlocked ? 'Hide blocked' : `Blocked (${blockedList.length})`}
                </Button>
                {showBlocked && (
                  <Stack as="ul" gap="none" place="w-full">
                    {blockedList.map(c => (
                      <ContactRow key={c.ik} c={c} presence="offline" />
                    ))}
                  </Stack>
                )}
              </Stack>
            )}
          </Surface>
        )}
      </div>
    </main>
  )
}

function ContactDialog({ ik }: { ik: string }) {
  const identity = useP2pApp()!
  const { p2p } = identity

  const acct = useAccount()

  const c = useP2p(s => s.contacts.find(x => x.ik === ik))
  const presence = useP2p(s => s.presence[ik] ?? 'offline')
  if (!c) return null
  const shield = shieldOf(c)
  const notice = noticeText(c)
  return (
    <Dialog title="P2P contact" onClose={p2p.closeDialog} full>
      <PeerActorTag seen />
      <Stack gap="lg">
        <Row gap="md">
          <span className="relative">
            <KeyAvatar person={identityPerson(c.ik, 'contact')} size={48} />
            <PresenceDot presence={presence} />
          </span>
          <div className="min-w-0">
            <Name as="p" of={p2pName(displayName(c))} look="truncate text-lg font-medium" />
            {c.petname && c.name && (
              <Name
                as="p"
                of={p2pName(c.name)}
                before="Calls themselves "
                look="truncate text-xs text-on-surface-variant"
              />
            )}
            <p className="text-xs text-on-surface-variant">
              {c.state === 'outgoing'
                ? 'Request sent. They see it the next time you are both online.'
                : c.state === 'blocked'
                  ? 'Blocked'
                  : presenceText(presence)}
            </p>
          </div>
        </Row>
        <CardButton onClick={() => p2p.openDialog({ kind: 'verify', ik })} tone="base" pad="md">
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
        </CardButton>
        <BadgeRow ik={c.ik} />
        {notice && (
          <p className="text-sm text-on-surface-variant">
            <ContactNotice c={c} words={notice} />
          </p>
        )}
        <Name
          as="p"
          of={p2pKey(fingerprint(c.ik))}
          look="font-mono text-xs text-on-surface-variant"
        />
        <Row gap="sm" justify="end" wrap>
          {menuItems(
            ctxFor(
              acct.store.getState(),
              { kind: 'p2p_contact', c, me: identity.useP2p.getState().me },
              'menu',
              acct,
              identity
            )
          )
            .filter(item => item.action && !item.submenu)
            .map(item => (
              <Button
                variant={item.danger ? 'danger' : 'text'}
                key={item.label}
                onClick={item.action}
              >
                {item.label}
              </Button>
            ))}
        </Row>
      </Stack>
    </Dialog>
  )
}

// The account badge on the contact's card: the chip, when it was checked, and what it means.
function BadgeRow({ ik }: { ik: string }) {
  const slot = useP2p(s => s.badges[ik])
  const state = badgeState(slot, time().now())
  if (!slot || !state) return null
  const ok = slot.ok
  return (
    <Surface data-badge-row pad="md" gap="2xs" tone="base" radius="lg">
      <span className="flex min-w-0">
        <AccountChip ik={ik} pressable />
      </span>
      <p className="text-xs text-on-surface-variant">
        {state === 'confirmed' && ok
          ? `The instance says this P2P identity belongs to that account. Checked ${badgeDate(ok.checked)}.`
          : state === 'expired' && ok
            ? `It expired on ${badgeDate(ok.exp * 1000)}. They may have turned their badge off.`
            : "The instance couldn't be asked about it yet. Trying again later."}
      </p>
    </Surface>
  )
}

function RenameDialog({ ik }: { ik: string }) {
  const identity = useP2pApp()!
  const { p2p } = identity

  const c = useP2p(s => s.contacts.find(x => x.ik === ik))
  const [name, setName] = useState(c?.petname ?? '')
  if (!c) return null
  const save = () => {
    void p2p.rename(ik, name)
    p2p.closeDialog()
  }
  return (
    <Dialog title="Rename contact" onClose={p2p.closeDialog} compact>
      <Stack gap="xl">
        <Stack gap="xs">
          <NameInput
            autoFocus
            value={name}
            maxLength={p2p.limits().contacts.petnameMax}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (enterKey(e)) save()
            }}
            placeholder={c.name || 'Name'}
            aria-label="Name for this contact"
            className={`${fieldCls} w-full`}
          />
          <p className="text-xs text-on-surface-variant">
            Only you see this name. Leave empty to use theirs.
          </p>
        </Stack>
        <Row gap="sm" justify="end">
          <Button onClick={p2p.closeDialog}>Cancel</Button>
          <Button variant="filled" size="md" onClick={save}>
            Save
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

function P2pDialogsBody() {
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
    case 'server_profile':
      return <ServerProfileDialog key={dialog.room} room={dialog.room} />
    case 'profile_reset':
      return (
        <ProfileResetDialog
          key={`${dialog.room}\n${dialog.ik}`}
          room={dialog.room}
          ik={dialog.ik}
        />
      )
    case 'perms':
      return (
        <PermsDialog
          key={`${dialog.room}:${dialog.ch ?? dialog.cat}`}
          room={dialog.room}
          ch={dialog.ch}
          cat={dialog.cat}
        />
      )
    case 'separator':
      return (
        <P2pSeparatorDialog
          key={`${dialog.room}:${dialog.id ?? 'new'}`}
          room={dialog.room}
          id={dialog.id}
          cat={dialog.cat}
        />
      )
    case 'p2p_folder':
      return (
        <P2pFolderDialog key={dialog.id} id={dialog.id} colorFirst={dialog.focus === 'color'} />
      )
    case 'lost_device':
      return <LostDeviceDialog key={dialog.dk} dk={dialog.dk} />
    case 'recover':
      return <RecoverDialog />
  }
}

export const P2pRailTile = withP2pIdentity(P2pRailTileBody)
export const ElsewhereNotice = withP2pIdentity(ElsewhereNoticeBody)
export const IdentityAlert = withP2pIdentity(IdentityAlertBody)
export const MovingBanner = withP2pIdentity(MovingBannerBody)
export const UnreachableNotice = withP2pIdentity(UnreachableNoticeBody)
export const AddressNotice = withP2pIdentity(AddressNoticeBody)
export const MovedBanner = withP2pIdentity(MovedBannerBody)
export const EnableDialog = withP2pIdentity(EnableDialogBody)
export const ContactRow = withP2pIdentity(ContactRowBody)
export const P2pHome = withP2pIdentity(P2pHomeBody)
export const P2pDialogs = withP2pIdentity(P2pDialogsBody)
