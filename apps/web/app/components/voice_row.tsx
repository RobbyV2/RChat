'use client'

import { p2pName, type NameValue, notAName } from '../lib/names'
import { personName } from '../lib/names'
import { Name } from './name'
import { Lock, Volume2 } from 'lucide-react'
import { useStore } from '../lib/client/react'
import { isGuestName } from '../lib/guest_voice'
import type { ChannelEntry } from '../lib/place/channels'
import { isUnsupported } from '../lib/place/feature'
import { useFeature, useLive, usePlace } from '../lib/place/react'
import { useChannelCan } from '../lib/place/use_rights'
import { voice as voiceFeature, type Voice, type VoiceSeat } from '../lib/place/voice'
import { userRefFor } from '../lib/selectors'
import { useMask } from '../lib/store'
import { NO_CONNECT } from '../lib/timeouts'
import { longPress } from './context_menu'
import type { DragSpec } from './drag'
import { useGuestMenu } from './guest_voice_menu'
import { MemberAvatar } from './p2p/p2p_badge'
import { ProfileButton } from './profile_card'
import { useShown } from './shown_user'
import { Masked } from './ui'
import { UserAvatar } from './user_avatar'
import { LiveBadge } from './voice_grid'
import { VoiceStatusIcons } from './voice_status'
import { Surface } from './layout'
import { sideSeatLook } from '../lib/controls'
import { SideRow, Pressable } from './controls'

const seatCls = sideSeatLook
const opensCls =
  'cursor-pointer hover:bg-surface-container hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary active:bg-surface-container-high'

function SeatBody({
  seat,
  face,
  name,
}: {
  seat: VoiceSeat
  face: React.ReactNode
  name: NameValue
}) {
  return (
    <>
      <span
        data-speaking={seat.speaking || undefined}
        className={`flex shrink-0 rounded-full transition-shadow ${
          seat.speaking
            ? 'ring-2 ring-status-green ring-offset-1 ring-offset-surface-container-low'
            : ''
        }`}
      >
        {face}
      </span>
      <Name
        of={name}
        withUsername
        look={seat.speaking ? 'min-w-0 flex-1 truncate text-on-surface' : 'min-w-0 flex-1 truncate'}
      />
      {seat.live && (
        <LiveBadge
          size="sm"
          title={seat.self ? "You're sharing your screen" : 'Sharing their screen'}
        />
      )}
      <VoiceStatusIcons status={seat.status} self={seat.self} size={14} variant="row" />
    </>
  )
}

// An account in a voice channel: shown as its server shows it, opening its profile card (a
// guest opens the menu the server has for guests, where you have one).
function AccountSeat({
  seat,
  username,
  server,
}: {
  seat: VoiceSeat
  username: string
  server: string
}) {
  const user = useStore(s => userRefFor(s, username))
  const shown = useShown(user, server)
  const menu = useGuestMenu(server, username)
  const guest = isGuestName(username)
  const body = (
    <SeatBody seat={seat} face={<UserAvatar person={shown} size={22} />} name={personName(shown)} />
  )
  return guest ? (
    <div {...(menu ? longPress(menu) : {})} className={seatCls}>
      {body}
    </div>
  ) : (
    <ProfileButton user={user} server={server} place="flex w-full">
      <span className={`${seatCls} ${opensCls} min-w-0 flex-1`}>{body}</span>
    </ProfileButton>
  )
}

// An identity in a voice channel: the picture and name its room has for it, opening the menu
// the room has for its members.
function KeySeat({
  seat,
  face,
  open,
}: {
  seat: VoiceSeat
  face: Extract<VoiceSeat['face'], { kind: 'key' }>
  open: ((x: number, y: number) => void) | null
}) {
  const body = (
    <SeatBody
      seat={seat}
      face={<MemberAvatar members={face.of} ik={face.ik} size={22} />}
      name={p2pName(face.name, seat.self)}
    />
  )
  return open ? (
    <Pressable
      data-voice-member={face.name}
      {...longPress(open)}
      onClick={e => {
        const r = e.currentTarget.getBoundingClientRect()
        open(r.left + 24, r.bottom)
      }}
      aria-haspopup="menu"
      place="flex w-full"
    >
      <span className={`${seatCls} ${opensCls} min-w-0 flex-1`}>{body}</span>
    </Pressable>
  ) : (
    <div data-voice-member={face.name} className={seatCls}>
      {body}
    </div>
  )
}

function Row({
  voice,
  channel,
  own,
  menu,
  drag,
}: {
  voice: Voice
  channel: ChannelEntry
  own: boolean
  menu: (x: number, y: number) => void
  drag?: DragSpec
}) {
  const place = usePlace()
  const mask = useMask(own)
  const { connected, seats } = useLive(voice.channel(channel.key))
  const can = useChannelCan(
    place,
    place?.kind === 'hostedServer' ? Number(channel.key) : channel.key
  )
  const locked = !connected && !can.connect
  const count = seats.length
  return (
    <div data-drag-box className="flex flex-col rounded-lg">
      <SideRow
        data-voice-channel={channel.name}
        title={locked ? NO_CONNECT : connected ? 'Open voice channel' : 'Join voice channel'}
        label={notAName(
          `${connected ? 'Open' : 'Join'} voice channel ${mask(channel.name)}${
            count ? `, ${count} connected` : ''
          }${locked ? `. ${NO_CONNECT}` : ''}`
        )}
        aria-disabled={locked || undefined}
        onClick={() => {
          if (!locked) voice.enter(channel.key)
        }}
        {...longPress(menu, drag)}
        current={channel.active}
        place="group"
      >
        <Volume2 size={16} className={`shrink-0 ${connected ? 'text-status-green' : ''}`} />
        <span className="truncate">
          <Masked text={channel.name} own={own} />
        </span>
        {channel.private && (
          <span
            title="Private channel"
            aria-label="Private channel"
            role="img"
            className="flex shrink-0"
          >
            <Lock size={12} />
          </span>
        )}
        {count > 0 && (
          <Surface
            title={`${count} in voice`}
            as="span"
            pad="xs"
            inset="sides"
            tone="highest"
            radius="full"
            text="2xs"
            ink="muted"
            look="leading-4 font-medium tabular-nums"
            place="ml-auto shrink-0"
          >
            {count}
          </Surface>
        )}
      </SideRow>
      {seats.map(seat =>
        seat.face.kind === 'account' ? (
          <AccountSeat
            key={seat.key}
            seat={seat}
            username={seat.face.username}
            server={seat.face.server}
          />
        ) : (
          <KeySeat
            key={seat.key}
            seat={seat}
            face={seat.face}
            open={voice.seatMenu ? (x, y) => voice.seatMenu?.(channel.key, seat.key, x, y) : null}
          />
        )
      )}
    </div>
  )
}

// A voice channel in the channel list of the server or room around it: the row joins it (or
// shows it when you are in it), and who is in it shows under it.
export function VoiceRow(props: {
  channel: ChannelEntry
  // The channel's name is your own text.
  own: boolean
  menu: (x: number, y: number) => void
  drag?: DragSpec
}) {
  const here = useFeature(voiceFeature)
  return isUnsupported(here) ? null : <Row voice={here} {...props} />
}
