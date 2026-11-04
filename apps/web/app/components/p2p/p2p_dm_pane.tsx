'use client'

import { useCallback, useMemo, type ReactNode } from 'react'
import { ArrowLeft, Menu } from 'lucide-react'
import { useMask, useStore } from '../../lib/store'
import { allPings } from '../../lib/selectors'
import { P2P_DM_INTRO } from '../../lib/home'
import { p2p, p2pDm, useP2p } from '../../lib/p2p/app'
import { displayName, shieldOf } from '../../lib/p2p/contacts'
import {
  FULL_BYTES_TEXT,
  FULL_TEXT,
  movedText,
  withMissed,
  type P2pMessage,
} from '../../lib/p2p/dm'
import { DAG } from '../../lib/p2p/dag'
import { PinsButton } from '../pins'
import { PingBadge, pingLabel } from '../ping_badge'
import {
  AccountChip,
  ContactShield,
  KeyAvatar,
  P2pBadge,
  PresenceDot,
  useHasChip,
} from './p2p_badge'
import { ElsewhereNotice, MovingBanner } from './p2p_home'
import { useRoomCallShare, VoiceGrid } from '../voice_grid'
import { IncomingCallBar, P2pCallButtons } from './p2p_call'
import { noteBarCls, P2pChatBody, P2pIntro, type Mentionable } from './p2p_chat'

const NONE: string[] = []

const IntroBanner = ({ name }: { name: string }) => (
  <P2pIntro id={P2P_DM_INTRO}>
    This conversation is stored only on your device and{' '}
    <span className="streamer font-medium">{name}</span>&apos;s. Messages are delivered when you are
    both online, and the instance never sees them.
  </P2pIntro>
)

const statusLine = (online: boolean, name: string): ReactNode =>
  online ? (
    'Connected'
  ) : (
    <>
      Offline. Messages wait until <span className="streamer">{name}</span> is online
    </>
  )

export function P2pDmPane({ onBack, onMenu }: { onBack: () => void; onMenu: () => void }) {
  const chat = useP2p(s => s.chat)
  const me = useP2p(s => s.me)
  const myName = useP2p(s => s.name)
  const reader = useP2p(s => s.reader)
  const elsewhere = useP2p(s => s.elsewhere)
  const status = useP2p(s => s.status)
  const movedAt = useP2p(s => s.movedAt)
  const movingAt = useP2p(s => s.movingAt)
  const peer = useP2p(s => s.contacts.find(c => c.ik === s.chat?.peer))
  const presence = useP2p(s => (s.chat ? (s.presence[s.chat.peer] ?? 'offline') : 'offline'))
  const room = useP2p(s => (s.chat ? s.rooms[s.chat.room] : undefined))
  const typingIks = useP2p(s => (s.chat ? (s.typing[s.chat.room] ?? NONE) : NONE))
  const pinsOpen = useP2p(s => s.pins !== null && s.pins.room === s.chat?.room)
  const menuPings = useStore(allPings)
  const staged = useP2p(
    s =>
      s.chat !== null &&
      s.call?.room === s.chat.room &&
      (s.call.dir === 'out' || s.call.state === 'active')
  )
  const callShare = useRoomCallShare(chat?.room ?? '')

  const raw = chat?.messages
  const missed = chat?.missed
  const more = chat?.more ?? false
  const messages = useMemo(
    () => (raw && missed ? withMissed(raw, missed, more) : (raw ?? [])),
    [raw, missed, more]
  )
  const peerIk = chat?.peer ?? ''
  const chip = useHasChip(peerIk)
  const mask = useMask()
  const peerName = peer ? mask(displayName(peer)) : 'Contact'
  const online = presence === 'online'
  const canAct = !reader && !elsewhere && peer?.state === 'mutual' && status !== 'moved'
  const nameOf = useCallback(
    (ik: string) => (ik === me ? mask(myName) || 'You' : peerName),
    [me, myName, peerName, mask]
  )
  const people = useMemo<Mentionable[]>(() => {
    const out: Mentionable[] = []
    if (peer) {
      const handle = peer.name || peer.petname || ''
      out.push({ ik: peer.ik, name: displayName(peer), handle })
      if (peer.petname && peer.name)
        out.push({ ik: peer.ik, name: peer.petname, handle: peer.petname })
    }
    if (me && myName) out.push({ ik: me, name: myName, handle: myName })
    return out
  }, [peer, me, myName])
  const mayDelete = useCallback((p: P2pMessage) => p.sender === me, [me])

  if (!chat) return null

  const disabled: ReactNode =
    reader || elsewhere ? (
      <div className={noteBarCls}>
        <ElsewhereNotice />
      </div>
    ) : status === 'moved' ? (
      <div className={noteBarCls}>{movedText(movedAt)}</div>
    ) : movingAt !== null ? (
      <MovingBanner className={noteBarCls} />
    ) : room?.full ? (
      <div className={noteBarCls} role="status">
        {room.fullWhy === 'bytes' ? FULL_BYTES_TEXT(DAG.roomBytes) : FULL_TEXT(DAG.roomCap)}
      </div>
    ) : !peer ? (
      <div className={noteBarCls}>This contact was removed.</div>
    ) : peer.state === 'blocked' ? (
      <div className={noteBarCls}>
        You blocked <span className="streamer font-medium">{peerName}</span>. Remove the block to
        message them again.
      </div>
    ) : peer.state !== 'mutual' ? (
      <div className={noteBarCls}>
        <span className="streamer font-medium">{peerName}</span> isn&apos;t a mutual contact right
        now.
      </div>
    ) : null

  const header = (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-3 md:px-4">
      <button
        title={menuPings ? `Menu, ${pingLabel(menuPings)}` : 'Menu'}
        aria-label="Menu"
        onClick={onMenu}
        className="relative rounded-full p-1.5 hover:bg-surface-container-high md:hidden"
      >
        <Menu size={20} />
        <PingBadge
          count={menuPings}
          className="absolute -top-1 -right-1.5 border-2 border-surface"
        />
      </button>
      <button
        title="Back to contacts"
        aria-label="Back to contacts"
        onClick={onBack}
        className="rounded-full p-1.5 hover:bg-surface-container-high"
      >
        <ArrowLeft size={20} />
      </button>
      <button
        onClick={() => peer && p2p.openDialog({ kind: 'contact', ik: peer.ik })}
        className="flex min-w-0 items-center gap-2 rounded-full py-1 pr-2.5 pl-1 hover:bg-surface-container-high"
      >
        <span className="relative">
          <KeyAvatar ik={peerIk} size={28} />
          <PresenceDot presence={presence} />
        </span>
        <span className="flex min-w-0 flex-col text-left">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={`streamer min-w-0 truncate text-sm font-medium ${chip ? 'sm:max-w-[60%] sm:shrink-0' : ''}`}
            >
              {peerName}
            </span>
            {peer && <ContactShield kind={shieldOf(peer)} size={14} />}
            <span className="flex min-w-0 max-sm:hidden">
              <AccountChip ik={peerIk} />
            </span>
          </span>
          {/* A phone's header has no room next to the name: the badge leads the status line. */}
          <span className="flex min-w-0 items-center gap-1">
            <span className="flex shrink-0 sm:hidden">
              <AccountChip ik={peerIk} size="icon" />
            </span>
            <span
              data-p2p-online={online ? 'yes' : 'no'}
              className="truncate text-xs text-on-surface-variant"
            >
              {statusLine(online, peerName)}
            </span>
          </span>
        </span>
      </button>
      <span className="max-sm:hidden">
        <P2pBadge />
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <P2pCallButtons peer={peerIk} name={peerName} online={online} canCall={canAct} />
        <PinsButton
          toggle={{
            open: pinsOpen,
            onClick: () => (pinsOpen ? p2pDm.closePins() : void p2pDm.openPins()),
          }}
        />
      </div>
    </header>
  )

  const above = (
    <>
      <IncomingCallBar room={chat.room} name={peerName} />
      {staged && (
        <div
          data-p2p-stage
          className={`flex shrink-0 flex-col overflow-hidden ${callShare ? 'h-[70dvh]' : 'h-[45dvh]'}`}
        >
          <VoiceGrid key={`p${chat.room}`} p2pRoom={chat.room} />
        </div>
      )}
    </>
  )

  return (
    <P2pChatBody
      chat={{ ...chat, messages }}
      header={header}
      above={above}
      intro={<IntroBanner name={peerName} />}
      disabled={disabled}
      canAct={canAct}
      nameOf={nameOf}
      people={people}
      title={peerName}
      placeholder={`Message ${peerName}`}
      pendingTip={`Waiting for ${peerName} to come online`}
      peerFull={room?.peerFull === true}
      gap={room?.gap === true}
      online={online}
      gapOffline={
        <>
          Older messages unavailable until <span className="streamer">{peerName}</span> is online
        </>
      }
      empty={
        <>
          <span className="text-2xl font-semibold">No messages here yet</span>
          <span className="text-sm">
            Say hi. It arrives when {online ? 'sent' : 'they are online'}.
          </span>
        </>
      }
      typingNames={typingIks.filter(ik => ik === peerIk).map(() => peerName)}
      mayDelete={mayDelete}
      mayPin
      forwardSkip={peerIk}
      pinsEmpty="This conversation doesn't have any pinned messages yet."
      pinsPlace="conversation"
      dataAttr={{ 'data-p2p-dm': '' }}
    />
  )
}
