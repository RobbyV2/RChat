'use client'
import { Button, IconButton } from '../controls'
import { Name } from '../name'
import { p2pName } from '../../lib/names'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useState } from 'react'
import { ChevronDown, Phone, PhoneOff, Video } from 'lucide-react'
import { useAccount } from '../../lib/client/react'
import { openActionMenu } from '../../lib/actions/menu'
import { useStore } from '../../lib/store'
import { CALL_ELSEWHERE } from '../../lib/p2p/app'
import { Row, Surface, Inset } from '../layout'

// Call and Video for a P2P contact. A call with a contact is always direct; the chevron offers
// a relay of the user's own for this call only, as in instance DMs.
function SplitCall({ peer, video, why }: { peer: string; video: boolean; why: string | null }) {
  const identity = useP2pApp()!
  const { p2pCall } = identity

  const account = useAccount()
  const [shown, setShown] = useState<object | null>(null)
  const open = useStore(s => shown !== null && s.contextMenu === shown)
  const kind = video ? 'Video call' : 'Call'
  const Icon = video ? Video : Phone
  const off = why !== null
  const title = why ?? `${kind}, direct (P2P)`
  const menu = (x: number, y: number) => {
    openActionMenu(
      x,
      y,
      { kind: 'p2p_call', peer, video },
      {
        header: (
          <Surface as="span" pad="sm" tone="plain" radius="none">
            <span className="text-xs font-medium text-on-surface-variant">
              {video ? 'Start a video call' : 'Start a call'}
            </span>
          </Surface>
        ),
      },
      account,
      identity
    )
    setShown(account.store.getState().contextMenu)
  }
  return (
    <div
      data-call-split={video ? 'video' : 'voice'}
      className={`flex items-center rounded-full ${off ? 'opacity-40' : ''}`}
    >
      <IconButton
        icon={Icon}
        label={title}
        tone="inherit"
        size="lg"
        disabled={off}
        onClick={() => void p2pCall.start(peer, video)}
      >
        <Inset
          aria-hidden
          as="span"
          pad="3xs"
          inset="sides"
          look="rounded bg-tertiary-container text-3xs leading-tight font-bold text-on-tertiary-container"
          place="absolute -bottom-0.5 left-3"
        >
          P2P
        </Inset>
      </IconButton>
      <IconButton
        icon={ChevronDown}
        label={`${kind} options`}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={off}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          menu(r.left - 24, r.bottom + 4)
        }}
      />
    </div>
  )
}

// The header's call buttons, or why there are none right now.
function P2pCallButtonsBody({
  peer,
  name,
  online,
  canCall,
}: {
  peer: string
  name: string
  online: boolean
  canCall: boolean
}) {
  const elsewhere = useP2p(s => s.reader || s.elsewhere)
  const there = useP2p(s => s.callElsewhere)
  const busy = useP2p(
    s => s.call?.peer === peer || (s.call?.dir === 'in' && s.call.state === 'ringing')
  )
  if (elsewhere && there)
    return (
      <Surface
        data-call-elsewhere
        as="span"
        pad="sm"
        inset="chip"
        tone="high"
        radius="full"
        text="xs"
        ink="muted"
      >
        {CALL_ELSEWHERE}
      </Surface>
    )
  const why = elsewhere
    ? 'P2P is open in another tab'
    : !canCall
      ? 'Calls need a mutual contact'
      : busy
        ? 'Already in a call'
        : !online
          ? `${name} is offline`
          : null
  return (
    <Row gap="2xs">
      <SplitCall peer={peer} video={false} why={why} />
      <SplitCall peer={peer} video why={why} />
    </Row>
  )
}

// An incoming call in the open conversation: always here, also when its ringing is quiet.
function IncomingCallBarBody({ room, name }: { room: string; name: string }) {
  const identity = useP2pApp()!
  const { p2pCall } = identity

  const c = useP2p(s => (s.call?.room === room ? s.call : null))
  const accepting = useP2p(s => s.callAccepting)
  if (!c || c.dir !== 'in' || c.state !== 'ringing') return null
  return (
    <Surface
      role="status"
      data-p2p-incoming
      pad="lg"
      inset="bar"
      tone="base"
      radius="none"
      border="bottom"
      place="shrink-0"
    >
      <Row gap="md" wrap>
        <Row as="span" gap="sm" place="flex-1">
          {c.video ? (
            <Video size={16} className="shrink-0 text-status-green" aria-hidden />
          ) : (
            <Phone size={16} className="shrink-0 text-status-green" aria-hidden />
          )}
          <span className="min-w-0 truncate text-sm">
            <Name of={p2pName(name)} look="font-medium" />{' '}
            {c.video ? 'is video calling you' : 'is calling you'}
          </span>
        </Row>
        <Row as="span" gap="xs">
          <Button
            variant="accept"
            icon={Phone}
            title="Accept"
            disabled={accepting}
            onClick={() => void p2pCall.accept()}
          >
            Accept
          </Button>
          <Button
            variant="filled-danger"
            icon={PhoneOff}
            title="Decline"
            onClick={() => p2pCall.decline()}
          >
            Decline
          </Button>
        </Row>
      </Row>
    </Surface>
  )
}

export const P2pCallButtons = withP2pIdentity(P2pCallButtonsBody)
export const IncomingCallBar = withP2pIdentity(IncomingCallBarBody)
