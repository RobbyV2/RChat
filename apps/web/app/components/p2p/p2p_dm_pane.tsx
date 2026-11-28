'use client'
import { IconButton } from '../controls'
import { Name } from '../name'
import { p2pName } from '../../lib/names'
import { identityPerson } from '../../lib/people'
import { PeerActorTag } from '../view_actor'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useCallback, useId, type ReactNode } from 'react'
import { ArrowLeft, Menu } from 'lucide-react'
import { useMask, useStore } from '../../lib/store'
import { allPings } from '../../lib/selectors'
import { P2P_DM_INTRO } from '../../lib/home'

import { displayName, shieldOf } from '../../lib/p2p/contacts'
import { type P2pMessage } from '../../lib/p2p/dm'
import { PinsButton } from '../pins'
import { ThreadsButton } from '../threads'
import { PingBadge, pingLabel } from '../ping_badge'
import {
  AccountChip,
  ContactShield,
  KeyAvatar,
  P2pBadge,
  PresenceDot,
  useHasChip,
} from './p2p_badge'
import { useRoomCallShare, VoiceGrid } from '../voice_grid'
import { IncomingCallBar, P2pCallButtons } from './p2p_call'
import { P2pDm } from '../../lib/place/place'
import { PlaceProvider } from '../../lib/place/react'
import { P2pChatBody, P2pIntro } from './p2p_chat'
import { Row, Surface, Inset } from '../layout'

const NONE: string[] = []

const IntroBanner = ({ name }: { name: string }) => (
  <P2pIntro id={P2P_DM_INTRO}>
    This conversation is stored only on your device and{' '}
    <Name of={p2pName(name)} look="font-medium" />
    &apos;s. Messages are delivered when you are both online, and the instance never sees them.
  </P2pIntro>
)

const statusLine = (online: boolean, name: string): ReactNode =>
  online ? (
    'Connected'
  ) : (
    <>
      Offline. Messages wait until <Name of={p2pName(name)} /> is online
    </>
  )

// Who the open conversation is with, who may write in it, and why not when they can't: for the
// conversation and its threads.
export function useDmFacts() {
  const me = useP2p(s => s.me)
  const reader = useP2p(s => s.reader)
  const elsewhere = useP2p(s => s.elsewhere)
  const status = useP2p(s => s.status)
  const peer = useP2p(s => s.contacts.find(c => c.ik === s.chat?.peer))
  const presence = useP2p(s => (s.chat ? (s.presence[s.chat.peer] ?? 'offline') : 'offline'))
  const room = useP2p(s => (s.chat ? s.rooms[s.chat.room] : undefined))
  const peerIk = useP2p(s => s.chat?.peer ?? '')
  const mask = useMask()
  const peerRaw = peer ? displayName(peer) : 'Contact'
  const peerName = mask(peerRaw)
  const online = presence === 'online'
  const canAct = !reader && !elsewhere && peer?.state === 'mutual' && status !== 'moved'
  const mayDelete = useCallback((p: P2pMessage) => p.sender === me, [me])

  return {
    me,
    peer,
    peerIk,
    peerRaw,
    peerName,
    presence,
    online,
    room,
    canAct,
    mayDelete,
  }
}

// The open conversation. Beside the instance's DM list it has no way back: the list is there.
function P2pDmPaneBody({ onBack, onMenu }: { onBack?: () => void; onMenu: () => void }) {
  const identity = useP2pApp()!
  const { p2p } = identity

  const chat = useP2p(s => s.chat)
  const typingIks = useP2p(s => (s.chat ? (s.typing[s.chat.room] ?? NONE) : NONE))
  const nameId = useId()
  const shieldId = useId()
  const statusId = useId()
  const streamer = useStore(s => s.streamer)
  const menuPings = useStore(allPings)
  const staged = useP2p(
    s =>
      s.chat !== null &&
      s.call?.room === s.chat.room &&
      (s.call.dir === 'out' || s.call.state === 'active')
  )
  const callShare = useRoomCallShare(chat?.room ?? '')
  const facts = useDmFacts()
  const { peer, peerIk, peerRaw, peerName, presence, online, room, canAct } = facts
  const { mayDelete } = facts
  const chip = useHasChip(peerIk)

  if (!chat) return null

  const header = (
    <Inset
      as="header"
      row
      pad="md"
      inset="sides"
      gap="2xs"
      border="bottom"
      look="h-14"
      place="shrink-0"
    >
      <IconButton
        icon={Menu}
        label="Menu"
        tooltip={menuPings ? `Menu, ${pingLabel(menuPings)}` : 'Menu'}
        tone="inherit"
        size="lg"
        onClick={onMenu}
        place="relative md:hidden"
      >
        <PingBadge
          count={menuPings}
          className="absolute -top-1 -right-1.5 border-2 border-surface"
        />
      </IconButton>
      <PeerActorTag header />
      {onBack && (
        <IconButton
          icon={ArrowLeft}
          label="Back to contacts"
          tone="inherit"
          size="lg"
          onClick={onBack}
        />
      )}
      {/* Below 360 px the header has room for the avatar only: the shield sits on it, and the
          name stays the label. */}
      <Surface
        title={streamer ? 'Contact' : peerName}
        aria-labelledby={peer ? `${nameId} ${shieldId} ${statusId}` : `${nameId} ${statusId}`}
        onClick={() => peer && p2p.openDialog({ kind: 'contact', ik: peer.ik })}
        as="button"
        row
        pad="2xs"
        gap="sm"
        tone="plain"
        radius="full"
        look="hover:bg-surface-container-high"
        place="min-w-0"
      >
        <span className="relative shrink-0">
          <KeyAvatar person={identityPerson(peerIk, 'contact')} size={28} />
          <PresenceDot presence={presence} />
          {peer && (
            <span className="absolute -top-1 -right-1 hidden rounded-full bg-surface-container-low max-[360px]:flex">
              <ContactShield kind={shieldOf(peer)} size={12} />
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-col text-left max-[360px]:hidden">
          <Row as="span" gap="xs">
            <Name
              id={nameId}
              of={p2pName(peerRaw)}
              titled
              place={chip ? 'min-w-0 sm:max-w-3/5 sm:shrink-0' : 'min-w-0'}
              look="truncate text-sm font-medium"
            />
            {peer && <ContactShield id={shieldId} kind={shieldOf(peer)} size={14} />}
            <span className="flex min-w-0 max-sm:hidden">
              <AccountChip ik={peerIk} />
            </span>
          </Row>
          {/* A phone's header has no room next to the name: the badge leads the status line. */}
          <Row as="span" gap="2xs">
            <span className="flex shrink-0 sm:hidden">
              <AccountChip ik={peerIk} size="icon" />
            </span>
            <span
              id={statusId}
              data-p2p-online={online ? 'yes' : 'no'}
              className="truncate text-xs text-on-surface-variant"
            >
              {statusLine(online, peerName)}
            </span>
          </Row>
        </span>
      </Surface>
      <span className="max-sm:hidden">
        <P2pBadge />
      </span>
      <Row gap="2xs" place="ml-auto shrink-0">
        <P2pCallButtons peer={peerIk} name={peerName} online={online} canCall={canAct} />
        <PlaceProvider place={P2pDm.open(identity, chat.room)}>
          <PinsButton />
          <ThreadsButton />
        </PlaceProvider>
      </Row>
    </Inset>
  )

  const above = (
    <>
      <IncomingCallBar room={chat.room} name={peerName} />
      {staged && (
        <div
          data-p2p-stage
          className={`flex shrink-0 flex-col overflow-hidden ${callShare ? 'h-dvh-70' : 'h-dvh-45'}`}
        >
          <VoiceGrid key={`p${chat.room}`} p2pRoom={chat.room} />
        </div>
      )}
    </>
  )

  return (
    <P2pChatBody
      chat={chat}
      header={header}
      above={above}
      intro={<IntroBanner name={peerName} />}
      canAct={canAct}
      title={peerName}
      placeholder={`Message ${peerName}`}
      pendingTip={`Waiting for ${peerName} to come online`}
      peerFull={room?.peerFull === true}
      gap={room?.gap === true}
      online={online}
      gapOffline={
        <>
          Older messages unavailable until <Name of={p2pName(peerRaw)} /> is online
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
      typingNames={typingIks.filter(ik => ik === peerIk).map(() => peerRaw)}
      mayDelete={mayDelete}
      mayPin
      forwardSkip={peerIk}
      dataAttr={{ 'data-p2p-dm': '' }}
    />
  )
}

export const P2pDmPane = withP2pIdentity(P2pDmPaneBody)
