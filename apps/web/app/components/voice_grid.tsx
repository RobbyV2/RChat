'use client'
import { P2pProvider, useP2pApp, useP2p } from '../lib/client/p2p_react'
import { useShallow } from 'zustand/react/shallow'

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react'
import { create } from 'zustand'
import {
  HeadphoneOff,
  Headphones,
  MessageCircle,
  Mic,
  MicOff,
  Monitor,
  MoreVertical,
  Phone,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  User,
  Signal,
  SignalLow,
  SignalMedium,
  Video,
  VideoOff,
  Volume2,
  VolumeOff,
} from 'lucide-react'
import { client } from '../lib/client/client'
import { AccountProvider, useAccount, useLiveSessions, useStoreApi } from '../lib/client/react'
import { type P2pState } from '../lib/p2p/app'
import { pastFit, voiceNotice, type VoiceUser } from '../lib/p2p/voice'
import { displayName } from '../lib/p2p/contacts'
import { AccountLabel } from './instance_badge'
import { KeyAvatar, P2pBadge } from './p2p/p2p_badge'
import { useMask, userRefFor, useStore, voiceMutedIn } from '../lib/store'
import { voiceHushedIn } from '../lib/selectors'
import { shownIn } from '../lib/server_profile'
import { accountPrompt } from '../lib/features'
import {
  STAFF_MUTED,
  audibleStreams,
  guestVoiceOff,
  isGuestName,
  voiceSelf,
} from '../lib/guest_voice'
import { useGuestMenu, useGuestMenuOpen } from './guest_voice_menu'
import { bannerColor, cachedProfile, profileKey } from '../lib/profile'
import {
  autoFocus,
  fitGrid,
  keepFocus,
  screenKey,
  stageTiles,
  toggleFocus,
  type LinkQuality,
  type LiveShare,
} from '../lib/voice_layout'
import { canShareScreen } from '../lib/screen'
import { VOICE_STATUS_ON, voiceStatus, type VoiceStatus } from '../lib/voice_status'
import { VoiceStatusIcons } from './voice_status'
import type { UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { profileTrigger } from './profile_card'
import { CallDuration, CallType, DirectBadge } from './call_buttons'
import { COARSE_QUERY, longPress, useMedia } from './context_menu'
import { Dialog, Masked, useEscape, useOwn } from './ui'
import { Row, Stack, Surface } from './layout'
import { NameWithUsername } from './display_name'
import { tileName } from '../lib/display_name'
import { ownsP2pServer } from '../lib/p2p/server/types'
import { ChannelTopic } from './channel_topic'
import { useMyTimeoutEnds, useNow, usePeerTimeoutEnds } from './timeout_dialog'
import {
  NO_CONNECT,
  NO_SPEAK,
  NO_VIDEO,
  shownMedia,
  timedOutIn,
  TIMED_OUT_CAMERA,
  TIMED_OUT_MIC,
  TIMED_OUT_SHARE,
} from '../lib/timeouts'
import { useChannelCan } from '../lib/place/use_rights'
import { useHostedServer, useP2pRoom } from '../lib/place/react'
import { useStable } from '../lib/stable_key'
import { time } from '../lib/platform/time'
import type { Cancel } from '../lib/clock'

const useAudioGate = create<{ blocked: boolean }>(() => ({ blocked: false }))
const seenShares = new WeakMap<object, ReadonlySet<string>>()

const unblockAudio = () => {
  const els = [...document.querySelectorAll<HTMLAudioElement>('audio[data-remote-audio]')]
  void Promise.all(els.map(el => el.play())).then(
    () => useAudioGate.setState({ blocked: false }),
    () => {}
  )
}

const useCallClaim = () =>
  useSyncExternalStore(client.calls.subscribe, client.calls.current, client.calls.current)

export const contactNameOf = (s: P2pState, ik: string) => {
  const c = s.contacts.find(x => x.ik === ik)
  return c ? displayName(c) : 'Contact'
}

function useCallMedia() {
  const identity = useP2pApp()

  const callRtc = identity?.callRtc

  const account = useAccount()
  const { rtc, files: p2p } = account
  const claim = useCallClaim()
  const kind = claim?.account === account ? claim.kind : null
  useStore(s => s.rtcTick)
  const voice = useStore(s => (kind === 'voice' ? s.voice : null))
  const call = useStore(s => (kind === 'dm' ? s.call : null))
  const roomCall = useP2p(s => (kind === 'p2p-call' ? s.call : null))
  const roomVoice = useP2p(s => (kind === 'p2p-voice' ? s.voice : null))
  const { muted, deafened } = useStore(s => s.selfAudio)
  const own = roomCall !== null || roomVoice !== null
  const p2pCall = call?.kind === 'p2p'
  const connected = own
    ? !!callRtc?.active()
    : p2pCall
      ? p2p.mediaActive()
      : (voice !== null || call !== null) && rtc.active()
  const quality: LinkQuality = own
    ? (callRtc?.quality() ?? 'connecting')
    : p2pCall
      ? p2p.remote
        ? 'good'
        : 'connecting'
      : rtc.quality()
  return {
    voice,
    call,
    roomCall,
    roomVoice,
    p2pCall,
    connected,
    deafened,
    muted,
    camera: own ? callRtc?.videoTrack !== null : p2pCall ? p2p.camOn : rtc.videoTrack !== null,
    sharing: own ? callRtc?.sharing : p2pCall ? p2p.shareOn : rtc.sharing,
    audioNote: own ? callRtc?.audioNote : p2pCall ? p2p.audioNote : rtc.audioNote,
    quality,
  }
}

// Whether a share is on in the P2P conversation's call, which then gets a taller stage.
export function useRoomCallShare(room: string) {
  const identity = useP2pApp()
  const callRtc = identity?.callRtc

  useStore(s => s.rtcTick)
  const c = useP2p(s => s.call)
  return c?.room === room && c.state === 'active' && callRtc?.anyShare()
}

// Whether a share is on in the DM call shown, which then gets a taller stage.
export function useCallShare(dmId: number) {
  const { rtc, files: p2p } = useAccount()
  useStore(s => s.rtcTick)
  const call = useStore(s => s.call)
  const voice = useStore(s => s.voice)
  if (voice || call?.dmId !== dmId) return false
  return call.kind === 'p2p' ? p2p.shareOn || p2p.remoteScreenOn : rtc.anyShare()
}

function VideoView({
  stream,
  hidden,
  mirror,
  contain,
}: {
  stream: MediaStream
  hidden: boolean
  mirror: boolean
  contain: boolean
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream
  })
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`absolute inset-0 h-full w-full ${contain ? 'object-contain' : 'object-cover'} ${
        hidden ? 'hidden' : ''
      } ${mirror ? '-scale-x-100' : ''}`}
    />
  )
}

function RemoteAudio({ stream, muted }: { stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = stream
    el.play().catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'NotAllowedError')
        useAudioGate.setState({ blocked: true })
    })
    return () => {
      el.pause()
      el.srcObject = null
    }
  }, [stream])
  return <audio ref={ref} data-remote-audio autoPlay muted={muted} />
}

function AudioUnblock() {
  const blocked = useAudioGate(s => s.blocked)
  useEffect(() => {
    if (!blocked) return
    window.addEventListener('pointerdown', unblockAudio)
    window.addEventListener('keydown', unblockAudio)
    return () => {
      window.removeEventListener('pointerdown', unblockAudio)
      window.removeEventListener('keydown', unblockAudio)
    }
  }, [blocked])
  if (!blocked) return null
  return (
    <button
      onClick={unblockAudio}
      className={`${ctlBase} fixed top-[calc(var(--safe-top)+4rem)] left-1/2 z-top -translate-x-1/2 gap-2 bg-inverse-surface px-4 py-2 text-sm whitespace-nowrap font-medium text-inverse-on-surface shadow-elevation-3 hover:opacity-90`}
    >
      <Volume2 size={16} />
      Click to enable audio
    </button>
  )
}

// The members of P2P room `room` a timeout mutes, by this device's clock.
function usePeerSilenced(room: string | undefined): string[] {
  const members = useP2p(s => (room === undefined ? undefined : s.servers[room]?.members))
  const now = useNow(timedOutIn(members).length > 0)
  const key = timedOutIn(members, now).join('\n')
  return useMemo(() => (key === '' ? [] : key.split('\n')), [key])
}

const NO_NAMES: string[] = []
// The members of a P2P voice channel whose audio nobody plays: they hold no Speak there.
const unheardIn = (users: readonly VoiceUser[] | undefined): string[] => {
  const out = (users ?? []).filter(u => u.silenced).map(u => u.ik)
  return out.length ? out : NO_NAMES
}

// Whether a timeout or the server's listing mutes you in the voice channel you are in, a hosted
// one or a P2P room's.
function useForcedMute(): boolean {
  const voice = useStore(s => s.voice)
  const me = useStore(s => s.me?.username)
  const listed = useStore(s => voiceMutedIn(s, voice?.channelId ?? null).includes(me ?? ''))
  const peerRoom = useP2p(s => s.voice?.room)
  const peer = usePeerTimeoutEnds(
    useP2p(s => (peerRoom === undefined ? undefined : s.servers[peerRoom]?.timedOutUntil))
  )
  return useMyTimeoutEnds(voice?.server) !== null || listed || peer !== null
}

// Whether staff muted you for everyone in the voice channel you are in, as a guest.
function useStaffMuted(): boolean {
  const voice = useStore(s => s.voice)
  const self = useStore(voiceSelf)
  return useStore(s => self !== null && voiceHushedIn(s, voice?.channelId ?? null).includes(self))
}

function VoiceAudio() {
  const identity = useP2pApp()

  const callRtc = identity?.callRtc

  const { rtc, files: p2p } = useAccount()
  const { connected, p2pCall, roomCall, roomVoice, deafened, voice } = useCallMedia()
  const hosted = useStore(s => voiceMutedIn(s, voice?.channelId ?? null))
  const peers = usePeerSilenced(roomVoice?.room)
  const quiet = useP2p(
    useShallow(s =>
      roomVoice ? unheardIn(s.servers[roomVoice.room]?.voice[roomVoice.ch]) : NO_NAMES
    )
  )
  const silenced = roomVoice ? [...peers, ...quiet] : hosted
  const hushed = useStore(s => voiceHushedIn(s, voice?.channelId ?? null))
  useEffect(() => {
    if (!connected) useAudioGate.setState({ blocked: false })
  }, [connected])
  if (!connected) return null
  const streams: [string, MediaStream][] =
    roomCall || roomVoice
      ? (callRtc?.remoteStreams() ?? [])
      : p2pCall
        ? [
            ...(p2p.remote ? [['remote', p2p.remote] as [string, MediaStream]] : []),
            ...(p2p.remoteScreen && p2p.remoteScreenOn
              ? [['remote:screen', p2p.remoteScreen] as [string, MediaStream]]
              : []),
          ]
        : rtc.remoteStreams()
  return (
    <>
      <div hidden>
        {audibleStreams(streams, [...silenced, ...hushed], deafened).map(a => (
          <RemoteAudio key={a.key} stream={a.stream} muted={a.muted} />
        ))}
      </div>
      <AudioUnblock />
    </>
  )
}

interface TileData {
  key: string
  user: UserRef
  stream: MediaStream | null
  hasVideo: boolean
  status: VoiceStatus
  speaking: boolean
  mirror: boolean
  pending: boolean
  tint: string
  screen: boolean
  shareId: string | null
  // A P2P contact (or this side of a P2P call): no instance profile to open.
  local?: boolean
  // In a P2P call, whether the tile is your own: people there go by their P2P identity.
  own?: boolean
}

export function LiveBadge({
  size = 'md',
  title = 'Sharing their screen',
}: {
  size?: 'sm' | 'md'
  title?: string
}) {
  return (
    <span
      title={title}
      className={`flex shrink-0 items-center rounded-sm bg-danger font-bold tracking-wide text-on-danger ${
        size === 'sm' ? 'px-1 py-px text-3xs leading-3' : 'px-1.5 py-0.5 text-2xs leading-4'
      }`}
    >
      LIVE
    </span>
  )
}

function AvatarHidden({ size }: { size: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant"
    >
      <User size={Math.round(size * 0.55)} aria-hidden />
    </span>
  )
}

export function Tile({
  tile,
  server,
  focused,
  compact,
  width,
  height,
  onToggle,
}: {
  tile: TileData
  server: string | null
  focused: boolean
  compact: boolean
  width?: number
  height?: number
  onToggle: () => void
}) {
  const store = useStoreApi()
  const { user, stream, hasVideo, status, speaking, mirror, pending, tint, screen } = tile
  const streamer = useStore(s => s.streamer)
  const box = height ?? (compact ? 72 : 240)
  const avatar = compact ? 32 : Math.round(Math.max(40, Math.min(96, box * 0.3)))
  const mine = useOwn(user.username)
  const mask = useMask(tile.own ?? mine)
  const name = tileName(user, tile.local === true, mask)
  const label = screen ? `${name}'s screen` : name
  const menu = useGuestMenu(tile.local || screen || pending ? null : server, user.username)
  const menuOpen = useGuestMenuOpen(user.username)
  return (
    <div
      {...(menu ? longPress(menu) : {})}
      style={{
        width,
        height,
        background:
          hasVideo || screen
            ? undefined
            : `color-mix(in srgb, ${tint} 34%, var(--color-surface-container))`,
      }}
      className={`group/tile relative isolate flex shrink-0 items-center justify-center overflow-hidden rounded-xl select-none ${
        screen ? 'bg-black ring-1 ring-white/10 ring-inset' : 'bg-surface-container'
      } ${
        width === undefined && height === undefined
          ? compact
            ? 'aspect-video w-32 sm:w-40'
            : 'h-full w-full'
          : ''
      }`}
    >
      {stream && (
        <VideoView
          stream={stream}
          hidden={!hasVideo}
          mirror={mirror && !screen}
          contain={focused || screen}
        />
      )}
      {screen && (
        <span
          className={`pointer-events-none absolute z-raised ${compact ? 'top-1 left-1' : 'top-2 left-2'}`}
        >
          <LiveBadge size={compact ? 'sm' : 'md'} />
        </span>
      )}
      {!hasVideo && !screen && (
        <span className="relative flex rounded-full">
          {(pending || speaking) && (
            <span
              aria-hidden
              className={`absolute -inset-1 rounded-full ${
                pending
                  ? 'border-2 border-on-surface/40 motion-safe:animate-ring'
                  : 'ring-3 ring-status-green'
              }`}
            />
          )}
          {streamer ? (
            <AvatarHidden size={avatar} />
          ) : tile.local ? (
            <KeyAvatar
              ik={user.username}
              size={avatar}
              kind={user.avatar_kind}
              bg={user.avatar_color}
            />
          ) : (
            <UserAvatar
              username={user.username}
              avatarKind={user.avatar_kind}
              avatarColor={user.avatar_color}
              size={avatar}
            />
          )}
        </span>
      )}
      {speaking && !screen && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl inset-ring-3 inset-ring-status-green motion-safe:animate-speak"
        />
      )}
      <button
        data-tile={tile.key}
        aria-label={`${focused ? 'Back to grid from' : 'Focus'} ${label}`}
        aria-pressed={focused}
        title={focused ? 'Back to grid' : 'Focus'}
        onClick={onToggle}
        className="absolute inset-0 rounded-xl -outline-offset-3 transition-colors hover:bg-on-surface/5 focus-visible:outline-2 focus-visible:outline-primary"
      />
      <span
        {...(tile.local || isGuestName(user.username) ? {} : profileTrigger(store, user, server))}
        title={tile.local || isGuestName(user.username) ? undefined : 'View profile'}
        className={`absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] ${
          isGuestName(user.username) ? '' : 'cursor-pointer'
        } items-center gap-1 rounded-md bg-scrim/70 font-medium text-white outline-offset-2 hover:bg-scrim/85 focus-visible:outline-2 focus-visible:outline-primary ${
          compact ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-1 text-xs'
        }`}
      >
        {screen ? (
          <Monitor size={compact ? 11 : 13} className="shrink-0" aria-hidden />
        ) : (
          <VoiceStatusIcons
            status={status}
            self={tile.own ?? mine}
            size={compact ? 10 : 12}
            variant="tile"
          />
        )}
        <span className="streamer truncate">
          {tile.local ? (
            <Masked text={user.display_name} own={tile.own} />
          ) : (
            <NameWithUsername user={user} own={tile.own} />
          )}
        </span>
        {pending && <span className="shrink-0 opacity-75">Ringing…</span>}
        {status.forced === 'staff' && !screen && !compact && (
          <span className="shrink-0 opacity-75">{STAFF_MUTED}</span>
        )}
      </span>
      {menu && (
        <button
          title="More"
          aria-label={`More for ${name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect()
            menu(r.right, r.bottom + 4)
          }}
          className={`absolute top-1.5 right-1.5 flex cursor-pointer items-center justify-center rounded-full bg-scrim/70 text-white outline-offset-2 hover:bg-scrim/85 focus-visible:outline-2 focus-visible:outline-primary ${
            compact ? 'p-0.5' : 'p-1'
          }`}
        >
          <MoreVertical size={compact ? 12 : 16} />
        </button>
      )}
    </div>
  )
}

const ctlBase =
  'flex shrink-0 items-center justify-center rounded-full outline-offset-2 transition-colors focus-visible:outline-2 focus-visible:outline-primary'

function CallControls({ size = 'lg' }: { size?: 'lg' | 'sm' }) {
  const identity = useP2pApp()
  const p2pVoice = identity?.p2pVoice
  const peerCall = identity?.p2pCall

  const {
    voice,
    roomCall,
    roomVoice,
    connected,
    muted: selfMuted,
    deafened,
    camera,
    sharing,
  } = useCallMedia()
  const hostedVoice = useHostedServer(voice?.server ?? null)
  const peerVoice = useP2pRoom(voice ? null : (roomVoice?.room ?? null))
  const can = useChannelCan(hostedVoice ?? peerVoice, voice?.channelId ?? roomVoice?.ch ?? null)
  const listed = useForcedMute() && (voice !== null || roomVoice !== null)
  const timeout = useMyTimeoutEnds(voice?.server) !== null && voice !== null
  // A mute listed for someone who holds Speak is a timeout's.
  const timedOut = timeout || (listed && can.speak)
  const forced = listed || !can.speak
  const sightless = timedOut || !can.video
  const hushed = useStaffMuted() && voice !== null
  const muted = selfMuted || forced || hushed
  const micTitle = !can.speak
    ? NO_SPEAK
    : forced
      ? TIMED_OUT_MIC
      : hushed
        ? STAFF_MUTED
        : muted
          ? 'Unmute'
          : 'Mute'
  const off = (timed: string, on: string) => (!can.video ? NO_VIDEO : timedOut ? timed : on)
  const camTitle = off(TIMED_OUT_CAMERA, camera ? 'Turn off camera' : 'Turn on camera')
  const shareTitle = off(TIMED_OUT_SHARE, sharing ? 'Stop sharing' : 'Share screen')
  const toggleMute = useStore(s => s.toggleMute)
  const toggleDeafen = useStore(s => s.toggleDeafen)
  const toggleCamera = useStore(s => s.toggleCamera)
  const toggleShare = useStore(s => s.toggleShare)
  const leaveVoice = useStore(s => s.leaveVoice)
  const hangupCall = useStore(s => s.hangupCall)
  if (!connected) return null
  const lg = size === 'lg'
  const dim = lg ? 'h-11 w-11 sm:h-12 sm:w-12' : 'h-8 flex-1'
  const icon = lg ? 20 : 16
  const tone = (state: 'idle' | 'on' | 'off') =>
    state === 'on'
      ? 'bg-on-surface text-surface hover:bg-on-surface/85'
      : state === 'off'
        ? 'bg-mute text-on-mute hover:bg-mute-hover'
        : 'bg-surface-container-highest text-on-surface hover:bg-surface-bright'
  const btn = (state: 'idle' | 'on' | 'off') =>
    `${ctlBase} ${dim} ${lg ? tone(state) : smallTone(state)}`
  const leave = () =>
    voice
      ? leaveVoice()
      : roomVoice
        ? p2pVoice?.leave()
        : roomCall
          ? peerCall?.hangup()
          : hangupCall()
  const inVoice = voice !== null || roomVoice !== null
  return (
    <Row gap={lg ? 'md' : 'xs'} place={lg ? undefined : 'w-full'}>
      <button
        title={micTitle}
        aria-label={micTitle}
        aria-pressed={muted}
        disabled={forced || hushed}
        onClick={toggleMute}
        className={`${btn(muted ? 'off' : 'idle')} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {muted ? <MicOff size={icon} /> : <Mic size={icon} />}
      </button>
      <button
        title={deafened ? 'Undeafen' : 'Deafen (others see you as muted)'}
        aria-label={deafened ? 'Undeafen' : 'Deafen (others see you as muted)'}
        aria-pressed={deafened}
        onClick={toggleDeafen}
        className={btn(deafened ? 'off' : 'idle')}
      >
        {deafened ? <HeadphoneOff size={icon} /> : <Headphones size={icon} />}
      </button>
      <button
        title={camTitle}
        aria-label={camTitle}
        aria-pressed={camera}
        disabled={sightless}
        onClick={() => void toggleCamera()}
        className={`${btn(camera ? 'on' : 'idle')} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {camera ? <Video size={icon} /> : <VideoOff size={icon} />}
      </button>
      {canShareScreen() && (
        <button
          title={shareTitle}
          aria-label={shareTitle}
          aria-pressed={sharing}
          disabled={sightless}
          onClick={() => void toggleShare()}
          className={`${btn(sharing ? 'on' : 'idle')} disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {sharing ? <ScreenShareOff size={icon} /> : <ScreenShare size={icon} />}
        </button>
      )}
      {lg && (
        <button
          title={inVoice ? 'Leave voice' : 'Leave call'}
          aria-label={inVoice ? 'Leave voice' : 'Leave call'}
          onClick={leave}
          className={`${ctlBase} h-11 w-16 bg-danger text-on-danger hover:brightness-110 sm:h-12 sm:w-18`}
        >
          <PhoneOff size={icon} />
        </button>
      )}
    </Row>
  )
}

function StageHeader({
  active,
  name,
  video,
  since,
  badge,
}: {
  active: boolean
  name: string
  video: boolean
  since: number | null
  badge: ReactNode
}) {
  return (
    <Surface pad="lg" inset="bar" tone="plain" radius="none" place="shrink-0">
      <div className="text-xs text-on-surface-variant">
        <Row gap="sm">
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${
              active ? 'bg-status-green' : 'bg-status-yellow motion-safe:animate-pulse'
            }`}
          />
          <Row as="span" gap="2xs">
            {active ? 'In call with' : 'Calling'}
            <span className="streamer truncate font-medium text-on-surface">
              {name}
              {!active && '…'}
            </span>
          </Row>
          <span aria-hidden>·</span>
          <span className="shrink-0">{video ? 'Video call' : 'Voice call'}</span>
          {badge}
          {active && since !== null && (
            <span
              title="Call length"
              className="ml-auto shrink-0 font-medium text-on-surface tabular-nums"
            >
              <CallDuration from={since} />
            </span>
          )}
        </Row>
      </div>
    </Surface>
  )
}

const smallTone = (state: 'idle' | 'on' | 'off') =>
  state === 'on'
    ? 'bg-primary text-on-primary hover:opacity-90'
    : state === 'off'
      ? 'bg-mute text-on-mute hover:bg-mute-hover'
      : 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest'

const QUALITY: Record<LinkQuality, { label: string; cls: string; Icon: typeof Signal }> = {
  good: { label: 'Voice Connected', cls: 'text-status-green', Icon: Signal },
  connecting: { label: 'Connecting…', cls: 'text-status-yellow', Icon: SignalMedium },
  bad: { label: 'Connection lost', cls: 'text-status-red', Icon: SignalLow },
}

// How far a P2P voice mesh goes, past `voice.fitAudio` people (`fitVideo` with video). Joining
// is never blocked.
export function MeshNotice({ users, at }: { users: VoiceUser[]; at: 'stage' | 'dock' }) {
  const identity = useP2pApp()
  const p2pApp = identity?.p2p

  const fit = p2pApp?.limits().voice
  if (!fit) return null
  if (
    !pastFit(
      users.length,
      users.some(u => u.video),
      fit
    )
  )
    return null
  const note = (
    <p
      role="note"
      data-p2p-voice-notice
      className="rounded-lg border border-dashed border-tertiary bg-tertiary-container/40 px-2.5 py-1.5 text-xs text-on-surface"
    >
      {voiceNotice(fit)}
    </p>
  )
  return at === 'stage' ? (
    <Surface pad="lg" inset="bar" tone="plain" radius="none" align="start" place="shrink-0">
      {note}
    </Surface>
  ) : (
    <Surface pad="2xs" tone="plain" radius="none">
      {note}
    </Surface>
  )
}

const NO_USERS: VoiceUser[] = []

// Where the dock's call is: the person of a DM call, else the channel or contact name.
export function DockPlace({ place, peer }: { place: string; peer?: UserRef }) {
  return peer ? <NameWithUsername user={peer} /> : <Masked text={place} />
}

function CallOwner({ children }: { children: ReactNode }) {
  const shown = useAccount()
  const call = useSyncExternalStore(
    client.calls.subscribe,
    client.calls.current,
    client.calls.current
  )
  const session = call?.account ?? shown
  const peer = call?.kind === 'p2p-call' || call?.kind === 'p2p-voice'
  const identity = peer ? session.identities.get(call.identity ?? 'main') : undefined
  const content = peer ? (
    <P2pProvider identity={identity ?? null}>{children}</P2pProvider>
  ) : (
    children
  )
  return shown === session ? (
    content
  ) : (
    <AccountProvider session={session}>{content}</AccountProvider>
  )
}

export function VoiceDock() {
  return (
    <CallOwner>
      <VoiceDockBody />
    </CallOwner>
  )
}

export function ExpandedCallPane() {
  const call = useSyncExternalStore(
    client.calls.subscribe,
    client.calls.expandedCall,
    client.calls.expandedCall
  )
  if (!call) return null
  return (
    <Dialog
      layer="page"
      full
      title={call.kind === 'p2p-voice' ? 'Voice channel' : 'Call'}
      onClose={client.calls.collapse}
    >
      <CallOwner>
        <PeerCallPane />
      </CallOwner>
    </Dialog>
  )
}

function PeerCallPane() {
  const { roomCall, roomVoice } = useCallMedia()
  if (!roomCall && !roomVoice) return null
  return (
    <div className="flex h-dvh-60 min-h-52">
      <VoiceGrid p2pRoom={roomVoice?.room ?? roomCall?.room} p2pCh={roomVoice?.ch} />
    </div>
  )
}

function VoiceDockBody() {
  const claim = useCallClaim()
  const identity = useP2pApp()
  const p2pServer = identity?.p2pServer
  const p2pApp = identity?.p2p
  const p2pDm = identity?.p2pDm
  const p2pVoice = identity?.p2pVoice
  const peerCall = identity?.p2pCall

  const account = useAccount()
  const { voice, call, roomCall, roomVoice, connected, quality } = useCallMedia()
  const contactName = useP2p(s => (roomCall ? contactNameOf(s, roomCall.peer) : ''))
  const sv = useP2p(s => (roomVoice ? s.servers[roomVoice.room] : undefined))
  const ownSv = useP2p(s => ownsP2pServer(sv, s.me))
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const me = useStore(s => s.me)
  const openChannel = useStore(s => s.openChannel)
  const openDm = useStore(s => s.openDm)
  const leaveVoice = useStore(s => s.leaveVoice)
  const hangupCall = useStore(s => s.hangupCall)
  if (!connected) return null
  const detail = voice ? servers[voice.server] : undefined
  const users = (roomVoice && sv?.voice[roomVoice.ch]) || NO_USERS
  const place = voice
    ? (detail?.channels.find(c => c.id === voice.channelId)?.name ?? 'voice')
    : roomVoice
      ? (sv?.channels.find(c => c.id === roomVoice.ch)?.name ?? 'voice')
      : roomCall
        ? contactName
        : (call?.dmUsers.find(u => u !== me?.username) ?? 'call')
  const dmPeer =
    voice || roomVoice || roomCall ? undefined : dms.find(d => d.id === call?.dmId)?.other
  const inVoice = voice !== null || roomVoice !== null
  const ringing = !inVoice && (roomCall ? roomCall.state === 'ringing' : call?.state === 'ringing')
  const status = ringing
    ? { label: 'Calling…', cls: 'text-status-yellow', Icon: SignalMedium }
    : QUALITY[quality]
  const { Icon } = status
  return (
    <div className="shrink-0 border-t border-outline-variant bg-surface-container px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <Stack gap="sm">
        <Surface pad="2xs" tone="plain" radius="none">
          <Row gap="sm">
            <span title={status.label} className={`flex shrink-0 ${status.cls}`}>
              <Icon size={18} strokeWidth={2.5} />
            </span>
            <div className="min-w-0 flex-1">
              {account !== client.shown() && <AccountLabel />}
              <p className={`truncate text-sm leading-tight font-semibold ${status.cls}`}>
                {status.label}
              </p>
              <Row
                as="button"
                title={`Go to ${inVoice ? 'voice channel' : 'call'}`}
                onClick={() => {
                  if (identity && (roomVoice || roomCall)) {
                    if (claim && account !== client.shown()) {
                      client.calls.expand(claim)
                      return
                    }
                    account.identities.show(identity)
                  }
                  if ((voice || call) && account !== client.shown()) client.show(account, 'none')
                  if (voice) void openChannel(voice.server, voice.channelId)
                  else if (roomVoice) p2pServer?.open(roomVoice.room, roomVoice.ch)
                  else if (roomCall) {
                    p2pApp?.openHome()
                    void p2pDm?.openDm(roomCall.peer)
                  } else if (call) void openDm(call.dmId)
                }}
                gap="2xs"
                text="xs"
                ink="muted"
                look="rounded-sm text-left leading-tight outline-offset-2 hover:text-on-surface hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                place="max-w-full min-w-0"
              >
                {roomVoice && <P2pBadge />}
                <span className={`streamer truncate ${roomVoice ? 'max-w-3/5 shrink-0' : ''}`}>
                  <DockPlace place={place} peer={dmPeer} />
                </span>
                {roomCall && <P2pBadge />}
                {voice && detail && (
                  <>
                    <span className="shrink-0">/</span>
                    <span className="streamer truncate">
                      <Masked text={detail.display_name} by={detail.creator} />
                    </span>
                  </>
                )}
                {roomVoice && sv && (
                  <>
                    <span className="shrink-0">/</span>
                    <span className="streamer min-w-0 truncate">
                      <Masked text={sv.name} own={ownSv} />
                    </span>
                  </>
                )}
              </Row>
            </div>
            <button
              title={inVoice ? 'Disconnect' : 'Leave call'}
              aria-label={inVoice ? 'Disconnect' : 'Leave call'}
              onClick={() =>
                voice
                  ? leaveVoice()
                  : roomVoice
                    ? p2pVoice?.leave()
                    : roomCall
                      ? peerCall?.hangup()
                      : hangupCall()
              }
              className={`${ctlBase} h-8 w-8 text-on-surface-variant hover:bg-error/15 hover:text-error`}
            >
              <PhoneOff size={18} />
            </button>
          </Row>
        </Surface>
        {roomVoice && <MeshNotice users={users} at="dock" />}
        <CallControls size="sm" />
      </Stack>
    </div>
  )
}

function useBox(ref: RefObject<HTMLDivElement | null>) {
  const [box, setBox] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const height = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      setBox(b => (b.width === width && b.height === height ? b : { width, height }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return box
}

function useIdle(enabled: boolean, bar: RefObject<HTMLDivElement | null>) {
  const [idle, setIdle] = useState(false)
  const timer = useRef<Cancel | null>(null)
  const arm = () => {
    timer.current?.()
    const tick = () => {
      const el = bar.current
      if (el && (el.matches(':hover') || el.contains(document.activeElement)))
        timer.current = time().after(1000, tick)
      else setIdle(true)
    }
    timer.current = time().after(3000, tick)
  }
  const wake = () => {
    setIdle(false)
    if (enabled) arm()
    else timer.current?.()
  }
  const armRef = useRef(arm)
  useEffect(() => {
    armRef.current = arm
  })
  useEffect(() => {
    if (!enabled) setIdle(false)
    else armRef.current()
    return () => {
      timer.current?.()
    }
  }, [enabled])
  return { idle: enabled && idle, wake }
}

const GAP = 8

function SharePill() {
  const { sharing, audioNote } = useCallMedia()
  const toggleShare = useStore(s => s.toggleShare)
  if (!sharing) return null
  return (
    <Surface pad="lg" inset="bar" tone="plain" radius="none" align="center" place="shrink-0">
      <div
        role="status"
        className={`max-w-full min-w-0 bg-surface-container-high py-1 pr-1 pl-3 text-sm text-on-surface shadow-elevation-2 ${
          audioNote ? 'rounded-3xl' : 'rounded-full'
        }`}
      >
        <Row gap="sm">
          <span aria-hidden className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inset-0 rounded-full bg-danger/60 motion-safe:animate-ring" />
            <span className="relative h-2.5 w-2.5 rounded-full bg-danger" />
          </span>
          <Stack as="span" gap="none">
            <Row as="span" gap="xs">
              <Monitor size={15} aria-hidden className="shrink-0 text-on-surface-variant" />
              <span className="truncate">You&apos;re sharing your screen</span>
            </Row>
            {audioNote && (
              <Row
                as="span"
                gap="xs"
                data-share-audio-note
                title="This browser can't keep the call's own sound out of system audio, so it isn't sent, or everyone would hear an echo. Share a tab to include its audio."
              >
                <VolumeOff size={13} aria-hidden className="shrink-0 text-on-surface-variant" />
                <span className="truncate text-xs leading-4 text-on-surface-variant">
                  System audio isn&apos;t shared on this browser
                </span>
              </Row>
            )}
          </Stack>
          <button
            title="Stop sharing"
            onClick={() => void toggleShare()}
            className={`${ctlBase} h-7 shrink-0 gap-1 bg-danger px-3 text-xs font-semibold text-on-danger hover:brightness-110`}
          >
            <ScreenShareOff size={14} aria-hidden />
            Stop
          </button>
        </Row>
      </div>
    </Surface>
  )
}

export function VoiceGrid({
  channelId,
  dmId,
  p2pRoom,
  p2pCh,
}: {
  channelId?: number
  dmId?: number
  p2pRoom?: string
  // A voice channel of the P2P server `p2pRoom`.
  p2pCh?: string
}) {
  const identity = useP2pApp()
  const callRtc = identity?.callRtc
  const p2pUser = identity?.p2pUser
  const memberUser = identity?.memberUser
  const p2pVoice = identity?.p2pVoice

  const { rtc, files: p2p, store, lifetime } = useAccount()
  useStore(s => s.rtcTick)
  useStore(s => s.members)
  useStore(s => s.memberInfo)
  useStore(s => s.dms)
  const me = useStore(s => s.me)
  const mine = useStore(voiceSelf)
  const ask = useStore(s => accountPrompt(s.settings))
  const voice = useStore(s => s.voice)
  const call = useStore(s => s.call)
  const selfAudio = useStore(s => s.selfAudio)
  const roomUsers = useStore(s => (channelId !== undefined ? s.voiceUsers[channelId] : undefined))
  const roomAudio = useStore(s => (channelId !== undefined ? s.voiceAudio[channelId] : undefined))
  const listed = useStore(s => voiceMutedIn(s, channelId ?? null))
  const peers = usePeerSilenced(p2pCh === undefined ? undefined : p2pRoom)
  const hushed = useStore(s => voiceHushedIn(s, channelId ?? null))
  const view = useStore(s => s.view)
  const joinVoice = useStore(s => s.joinVoice)
  const server = channelId !== undefined && view?.kind === 'channel' ? view.server : null
  const channel = useStore(s =>
    server !== null && channelId !== undefined
      ? s.servers[server]?.channels.find(c => c.id === channelId)
      : undefined
  )
  const shut = useStore(s => (server === null ? null : guestVoiceOff(s, server)))
  const coarse = useMedia(COARSE_QUERY)
  const contactCall = useP2p(s => s.call)
  const myIk = useP2p(s => s.me)
  const myP2pName = useP2p(s => s.name)
  const peerName = useP2p(s =>
    p2pRoom !== undefined && s.call?.room === p2pRoom ? contactNameOf(s, s.call.peer) : ''
  )
  const serverVoice = useP2p(s => s.voice)
  const p2pElsewhere = useP2p(s => s.reader || s.elsewhere)
  const sv = useP2p(s =>
    p2pRoom !== undefined && p2pCh !== undefined ? s.servers[p2pRoom] : undefined
  )
  const forVoice =
    p2pRoom !== undefined && p2pCh !== undefined ? { room: p2pRoom, ch: p2pCh } : null
  const voiceUsers = (p2pCh !== undefined && sv?.voice[p2pCh]) || NO_USERS
  const silenced = forVoice ? [...peers, ...unheardIn(voiceUsers)] : listed
  const unseen = forVoice ? voiceUsers.filter(u => u.unseen).map(u => u.ik) : NO_NAMES
  const hostedHere = useHostedServer(forVoice ? null : server)
  const peerHere = useP2pRoom(forVoice?.room ?? null)
  const here = useChannelCan(peerHere ?? hostedHere, forVoice ? forVoice.ch : (channelId ?? null))

  const forRoom =
    !forVoice && p2pRoom !== undefined && contactCall?.room === p2pRoom && !voice && !call
      ? contactCall
      : null
  const forDm = dmId !== undefined && call?.dmId === dmId ? call : null
  const p2pKind = forDm?.kind === 'p2p'
  const mgr = (forRoom || forVoice ? callRtc : null) ?? rtc
  const self = forRoom || forVoice ? (myIk ?? '') : (mine ?? undefined)
  const joined =
    channelId !== undefined
      ? voice?.channelId === channelId
      : forVoice
        ? !voice &&
          !call &&
          serverVoice?.room === forVoice.room &&
          serverVoice.ch === forVoice.ch &&
          !!callRtc?.active()
        : forRoom
          ? !!callRtc?.active() && (forRoom.dir === 'out' || forRoom.state === 'active')
          : (p2pKind ? p2p.mediaActive() : rtc.active()) && call?.dmId === dmId && !voice
  const users =
    channelId !== undefined
      ? (roomUsers ?? [])
      : forVoice
        ? voiceUsers.map(u => u.ik)
        : forRoom
          ? forRoom.state === 'active'
            ? [self ?? '', forRoom.peer]
            : forRoom.dir === 'out'
              ? [self ?? '']
              : []
          : forDm
            ? forDm.state === 'active'
              ? forDm.dmUsers
              : forDm.dmUsers.filter(u => u === me?.username)
            : []
  const pendingOther = forRoom
    ? forRoom.state === 'ringing' && forRoom.dir === 'out'
      ? forRoom.peer
      : undefined
    : forDm?.state === 'ringing'
      ? forDm.dmUsers.find(u => u !== me?.username)
      : undefined
  const state = store.getState()
  const refFor = (u: string): UserRef =>
    forVoice && memberUser
      ? u === self
        ? { ...memberUser(forVoice.room, u), display_name: myP2pName || 'You' }
        : memberUser(forVoice.room, u)
      : forRoom && p2pUser
        ? p2pUser(u, u === self ? myP2pName || 'You' : peerName)
        : shownIn(state, server, userRefFor(state, u)).user

  const tint = (user: UserRef) =>
    bannerColor(
      user,
      user.username === me?.username
        ? me.banner_color
        : cachedProfile(profileKey(user.username, server), lifetime.sessionMark())?.banner_color
    )

  const p2pIdentity = forRoom !== null || forVoice !== null
  const people: TileData[] = users.map(u => {
    const user = refFor(u)
    const base = {
      key: u,
      user,
      pending: false,
      tint: tint(user),
      screen: false,
      shareId: null,
      local: p2pIdentity,
      own: p2pIdentity ? u === self : undefined,
    }
    const quiet = silenced.includes(u) || hushed.includes(u)
    const seat = forVoice ? voiceUsers.find(v => v.ik === u) : undefined
    const status = (own: boolean, live: { muted: boolean } | null) =>
      voiceStatus({
        self: own,
        selfAudio,
        live,
        roster: channelId !== undefined ? (roomAudio?.[u] ?? null) : (seat ?? null),
        forced: hushed.includes(u) ? 'staff' : silenced.includes(u) ? 'timeout' : null,
      })
    if (joined && u === self)
      return {
        ...base,
        stream: p2pKind ? p2p.camView : mgr.local,
        hasVideo: p2pKind ? p2p.camOn : mgr.videoTrack !== null,
        status: status(true, null),
        speaking: p2pKind ? p2p.localSpeaking : mgr.isSpeaking(u) && !quiet,
        mirror: p2pKind ? p2p.camOn : mgr.videoTrack !== null,
      }
    if (p2pKind)
      return {
        ...base,
        stream: joined ? p2p.remote : null,
        hasVideo: joined && p2p.remoteCamOn,
        status: status(false, joined ? { muted: p2p.remoteMuted } : null),
        speaking: joined && p2p.remoteSpeaking,
        mirror: false,
      }
    const peer = joined ? mgr.peer(u) : undefined
    return {
      ...base,
      stream: peer?.stream ?? null,
      hasVideo: shownMedia(peer, silenced.includes(u) || unseen.includes(u)).cam,
      status: status(false, peer ? { muted: peer.muted } : null),
      speaking: joined && mgr.isSpeaking(u) && !quiet,
      mirror: false,
    }
  })
  const screenOf = (t: TileData): TileData | null => {
    if (!joined) return null
    const u = t.user.username
    const share =
      u === self
        ? p2pKind
          ? { stream: p2p.screenView, id: p2p.shareId }
          : { stream: mgr.screenStream, id: mgr.shareId }
        : p2pKind
          ? { stream: p2p.remoteScreenOn ? p2p.remoteScreen : null, id: p2p.remoteShareId }
          : (() => {
              const peer = mgr.peer(u)
              const shown = shownMedia(peer, silenced.includes(u) || unseen.includes(u)).screen
              return { stream: shown ? (peer?.screen ?? null) : null, id: peer?.shareId ?? null }
            })()
    if (!share.stream || share.id === null) return null
    return {
      ...t,
      key: screenKey(u),
      stream: share.stream,
      hasVideo: true,
      speaking: false,
      mirror: false,
      screen: true,
      shareId: share.id,
    }
  }
  const tiles = stageTiles(people, screenOf)
  if (pendingOther) {
    const user = refFor(pendingOther)
    tiles.push({
      local: forRoom !== null,
      own: forRoom !== null ? false : undefined,
      key: pendingOther,
      user,
      stream: null,
      hasVideo: false,
      status: VOICE_STATUS_ON,
      speaking: false,
      mirror: false,
      pending: true,
      tint: tint(user),
      screen: false,
      shareId: null,
    })
  }

  const [focusRaw, setFocus] = useState<string | null>(null)
  const focus = keepFocus(
    focusRaw,
    tiles.map(t => t.key)
  )
  useEffect(() => {
    if (focus === null && focusRaw !== null) setFocus(null)
  }, [focus, focusRaw])
  const shares = useStable(
    tiles.flatMap((t): LiveShare[] =>
      t.screen && t.shareId !== null
        ? [{ key: t.key, id: t.shareId, own: t.user.username === self }]
        : []
    )
  )
  useEffect(() => {
    const next = autoFocus(seenShares.get(store) ?? new Set(), shares)
    seenShares.set(store, next.seen)
    if (next.focus !== null) setFocus(next.focus)
  }, [store, shares])
  const area = useRef<HTMLDivElement>(null)
  const refocus = useRef<string | null>(null)
  useEscape(() => {
    refocus.current = focus
    setFocus(null)
  }, 'stage')
  useEffect(() => {
    const key = refocus.current
    const el = area.current
    refocus.current = null
    const active = document.activeElement
    if (key === null || !el || (active && active !== document.body && !el.contains(active))) return
    el.querySelector<HTMLElement>(`[data-tile="${CSS.escape(key)}"]`)?.focus()
  })

  const box = useBox(area)
  const anyVideo = tiles.some(t => t.hasVideo)
  const bar = useRef<HTMLDivElement>(null)
  const { idle, wake } = useIdle(joined && anyVideo && !coarse, bar)
  const fit = fitGrid(tiles.length, box.width, box.height, GAP)
  const focused = focus === null ? undefined : tiles.find(t => t.key === focus)
  const others = tiles.filter(t => t.key !== focus)
  const dm = dmId !== undefined ? state.dms.find(d => d.id === dmId) : undefined

  const tile = (t: TileData, mode: 'grid' | 'focus' | 'strip') => (
    <Tile
      key={t.key}
      tile={t}
      server={server}
      focused={mode === 'focus'}
      compact={mode === 'strip'}
      width={mode === 'grid' ? fit.width : undefined}
      height={mode === 'grid' ? fit.height : undefined}
      onToggle={() => {
        refocus.current = t.key
        setFocus(toggleFocus(focus, t.key))
      }}
    />
  )

  return (
    <div
      onPointerMove={wake}
      onPointerDown={wake}
      onFocus={wake}
      className={`stage relative flex min-h-0 w-full flex-1 flex-col overflow-hidden ${
        idle ? 'cursor-none' : ''
      }`}
    >
      {forRoom && (
        <StageHeader
          active={forRoom.state === 'active'}
          name={peerName}
          video={forRoom.video}
          since={forRoom.since === null ? null : Math.floor(forRoom.since / 1000)}
          badge={<P2pBadge />}
        />
      )}
      {dmId !== undefined && forDm && (
        <Surface pad="lg" inset="bar" tone="plain" radius="none" place="shrink-0">
          <div className="text-xs text-on-surface-variant">
            <Row gap="sm">
              <span
                aria-hidden
                className={`h-2 w-2 shrink-0 rounded-full ${
                  forDm.state === 'active'
                    ? 'bg-status-green'
                    : 'bg-status-yellow motion-safe:animate-pulse'
                }`}
              />
              <Row as="span" gap="2xs">
                {forDm.state === 'active' ? 'In call with' : 'Calling'}
                <span className="streamer truncate font-medium text-on-surface">
                  {dm ? <NameWithUsername user={dm.other} /> : <Masked text={pendingOther ?? ''} />}
                  {forDm.state === 'ringing' && '…'}
                </span>
              </Row>
              <span aria-hidden>·</span>
              <span className="shrink-0">{forDm.video ? 'Video call' : 'Voice call'}</span>
              {p2pKind && <DirectBadge />}
              {forDm.state === 'active' && forDm.since !== null && (
                <span
                  title="Call length"
                  className="ml-auto shrink-0 font-medium text-on-surface tabular-nums"
                >
                  <CallDuration from={forDm.since} />
                </span>
              )}
            </Row>
          </div>
        </Surface>
      )}
      {channel?.topic && (
        <Surface pad="lg" inset="bar" tone="plain" radius="none" align="start" place="shrink-0">
          <ChannelTopic channel={channel} variant="voice" />
        </Surface>
      )}
      {forVoice && <MeshNotice users={voiceUsers} at="stage" />}
      {joined && <SharePill />}
      <div
        ref={area}
        className={`min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 ${
          joined || channelId !== undefined || forVoice ? 'pb-20 sm:pb-22' : ''
        }`}
      >
        {focused ? (
          <Stack gap="sm" place="h-full min-h-0">
            <div className="min-h-0 flex-1">{tile(focused, 'focus')}</div>
            {others.length > 0 && (
              <div className="flex shrink-0 justify-center-safe gap-2 overflow-x-auto pb-1">
                {others.map(t => tile(t, 'strip'))}
              </div>
            )}
          </Stack>
        ) : tiles.length > 0 ? (
          <div
            style={{ gap: GAP }}
            className="flex min-h-full flex-wrap content-center-safe items-center justify-center"
          >
            {box.width > 0 && tiles.map(t => tile(t, 'grid'))}
          </div>
        ) : (
          <Stack gap="2xs" align="center" justify="center" place="h-full">
            <p className="text-center text-lg font-semibold text-on-surface">No one is here yet</p>
            <p className="text-center text-sm text-on-surface-variant">
              {mine === null && !forVoice
                ? `${ask} to join voice.`
                : shut !== null && !forVoice
                  ? `${shut}.`
                  : forVoice && p2pElsewhere
                    ? 'P2P is open in another tab.'
                    : 'Join to start talking.'}
            </p>
          </Stack>
        )}
      </div>
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-linear-to-t from-surface-container-lowest/90 to-transparent px-3 pt-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-opacity duration-300 ${
          idle ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <div ref={bar} className="pointer-events-auto" onFocus={wake}>
          {joined ? (
            <CallControls />
          ) : forVoice ? (
            !p2pElsewhere && (
              <button
                data-p2p-voice-join
                disabled={!here.connect}
                title={here.connect ? undefined : NO_CONNECT}
                onClick={() => void p2pVoice?.join(forVoice.room, forVoice.ch)}
                className={`${ctlBase} h-11 gap-2 bg-status-green px-6 text-sm font-semibold text-surface hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <Phone size={18} />
                Join voice
              </button>
            )
          ) : (
            channelId !== undefined &&
            mine !== null &&
            (shut !== null ? (
              tiles.length > 0 && (
                <p className="rounded-full bg-surface-container-high px-4 py-2 text-sm text-on-surface-variant shadow-elevation-1">
                  {shut}
                </p>
              )
            ) : (
              <button
                disabled={!here.connect}
                title={here.connect ? undefined : NO_CONNECT}
                onClick={() => {
                  if (view?.kind === 'channel') void joinVoice(view.server, channelId)
                }}
                className={`${ctlBase} h-11 gap-2 bg-status-green px-6 text-sm font-semibold text-surface hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <Phone size={18} />
                Join voice
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export function CallBanner() {
  const sessions = useLiveSessions()
  return (
    <>
      <CallOwner>
        <VoiceAudio />
      </CallOwner>
      <div
        data-call-banner
        className="pointer-events-none fixed inset-x-0 top-app z-top flex max-h-[calc(100dvh-var(--safe-top))] flex-col items-center gap-2 overflow-y-auto pt-3 pb-5 empty:hidden"
      >
        {sessions.map(account => (
          <AccountProvider key={account.renderKey} session={account}>
            <CallBannerBody />
          </AccountProvider>
        ))}
      </div>
    </>
  )
}

function CallBannerBody() {
  const account = useAccount()
  const call = useStore(s => s.call)
  const streamer = useStore(s => s.streamer)
  const me = useStore(s => s.me)
  const view = useStore(s => s.view)
  const acceptCall = useStore(s => s.acceptCall)
  const declineCall = useStore(s => s.declineCall)
  const hangupCall = useStore(s => s.hangupCall)
  const openDm = useStore(s => s.openDm)
  const dms = useStore(s => s.dms)
  const ringing = call !== null && call.state === 'ringing' && me !== null
  const incoming = ringing && call.from !== me.username
  const shown = account === client.shown()
  const watching = shown && view?.kind === 'dm' && view.dmId === call?.dmId
  const other = useStore(s =>
    call && me ? userRefFor(s, call.dmUsers.find(u => u !== me.username) ?? me.username) : null
  )
  if (!call) return <ContactCallBanners />
  if (!ringing || !other || (!incoming && watching)) return null
  const go = () => {
    if (account !== client.shown()) client.show(account, 'none')
    void openDm(call.dmId)
  }
  const p2pCall = call.kind === 'p2p'
  const dm = dms.find(d => d.id === call.dmId)
  const avatar = (size: number) => <RingAvatar user={other} size={size} streamer={streamer} />
  if (!incoming)
    return (
      <div
        role="status"
        className="pointer-events-auto shrink-0 max-w-screen-inset rounded-full bg-surface-container-high py-1.5 pr-1.5 pl-2 shadow-elevation-3"
      >
        <Row gap="md">
          <Surface
            as="button"
            title="Go to call"
            onClick={go}
            pad="none"
            gap="md"
            row
            tone="plain"
            radius="full"
            look="outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
            place="min-w-0"
          >
            {avatar(28)}
            <span className="flex min-w-0 flex-col text-left">
              <span className="text-sm">
                <Row as="span" gap="2xs">
                  Calling
                  <span className="streamer truncate font-medium">
                    <NameWithUsername user={other} />
                  </span>
                  …
                </Row>
              </span>
              {!shown && <AccountLabel />}
              <CallType video={call.video} p2p={p2pCall} />
            </span>
          </Surface>
          <button
            title="Cancel call"
            aria-label="Cancel call"
            onClick={hangupCall}
            className={`${ctlBase} h-9 w-9 bg-danger text-on-danger hover:brightness-110`}
          >
            <PhoneOff size={16} />
          </button>
        </Row>
      </div>
    )
  return (
    <div
      role="alertdialog"
      aria-label="Incoming call"
      className="pointer-events-auto flex shrink-0 w-72 max-w-screen-inset flex-col items-center gap-3 rounded-3xl bg-surface-container-high px-5 pt-6 pb-5 text-center shadow-elevation-3 max-sm:flex-row max-sm:rounded-2xl max-sm:px-4 max-sm:py-3 max-sm:text-left"
    >
      <span className="max-sm:hidden">{avatar(72)}</span>
      <span className="sm:hidden">{avatar(40)}</span>
      <div className="flex min-w-0 flex-col items-center gap-0.5 max-sm:flex-1 max-sm:items-start">
        <span className="streamer w-full truncate text-base font-semibold">
          <NameWithUsername user={other} />
        </span>
        {!shown && <AccountLabel />}
        <CallType video={call.video} p2p={p2pCall} incoming />
        <Row
          as="button"
          title="Go to DM"
          onClick={go}
          gap="2xs"
          text="xs"
          ink="muted"
          look="rounded-sm outline-offset-2 hover:text-on-surface hover:underline focus-visible:outline-2 focus-visible:outline-primary"
          place="max-w-full min-w-0"
        >
          <MessageCircle size={12} aria-hidden className="shrink-0" />
          <span className="shrink-0">DM with</span>
          <span className="streamer truncate">
            <NameWithUsername user={dm?.other ?? other} />
          </span>
        </Row>
      </div>
      <div className="flex shrink-0 items-center gap-4 max-sm:gap-2 sm:mt-1">
        <button
          title="Decline"
          aria-label="Decline"
          onClick={declineCall}
          className={`${ctlBase} h-12 w-12 bg-danger text-on-danger hover:brightness-110 max-sm:h-11 max-sm:w-11`}
        >
          <PhoneOff size={20} />
        </button>
        <button
          title="Accept"
          aria-label="Accept"
          onClick={() => {
            go()
            void acceptCall()
          }}
          className={`${ctlBase} h-12 w-12 bg-status-green text-surface hover:brightness-110 max-sm:h-11 max-sm:w-11`}
        >
          <Phone size={20} />
        </button>
      </div>
    </div>
  )
}

function RingAvatar({ user, size, streamer }: { user: UserRef; size: number; streamer: boolean }) {
  return (
    <span className="relative flex shrink-0 rounded-full">
      <span
        aria-hidden
        className="absolute inset-0 rounded-full bg-status-green/40 motion-safe:animate-ring"
      />
      <span
        aria-hidden
        className="absolute inset-0 rounded-full bg-status-green/30 [animation-delay:700ms] motion-safe:animate-ring"
      />
      <span className="relative flex rounded-full ring-2 ring-status-green">
        {streamer ? (
          <AvatarHidden size={size} />
        ) : (
          <UserAvatar
            username={user.username}
            avatarKind={user.avatar_kind}
            avatarColor={user.avatar_color}
            size={size}
          />
        )}
      </span>
    </span>
  )
}

function ContactCallBanners() {
  const { identities } = useAccount()
  const snapshot = () =>
    identities
      .list()
      .map(app => app.localId)
      .join(',')
  const ids = useSyncExternalStore(identities.subscribe, snapshot, snapshot)
  return ids
    .split(',')
    .filter(Boolean)
    .map(id => (
      <P2pProvider key={id} identity={identities.get(id) ?? null}>
        <ContactCallBanner />
      </P2pProvider>
    ))
}

// The ringing card of a call with a P2P contact: the same card as an instance call, with the P2P
// chip. A quiet call (the conversation is set to "Nothing" or muted) rings only in the
// conversation itself.
function ContactCallBanner() {
  const identity = useP2pApp()
  const p2pUser = identity?.p2pUser
  const p2pApp = identity?.p2p
  const p2pDm = identity?.p2pDm
  const peerCall = identity?.p2pCall

  const account = useAccount()
  const viewed = () => account.identities.viewed()
  const selected = useSyncExternalStore(account.identities.subscribe, viewed, viewed)
  const shown = account === client.shown() && selected === identity
  const c = useP2p(s => s.call)
  const quiet = useP2p(s => s.callQuiet)
  const accepting = useP2p(s => s.callAccepting)
  const watching = useP2p(s => s.home && s.chat !== null && s.chat.room === s.call?.room)
  const name = useP2p(s => (s.call ? contactNameOf(s, s.call.peer) : ''))
  const streamer = useStore(s => s.streamer)
  const voice = useStore(s => s.voice)
  if (!c || c.state !== 'ringing' || voice) return null
  const incoming = c.dir === 'in'
  if (incoming ? quiet : shown && watching) return null
  if (!p2pUser) return null
  const user = p2pUser(c.peer, name)
  const avatar = (size: number) => <RingAvatar user={user} size={size} streamer={streamer} />
  const go = () => {
    if (account !== client.shown() && !client.show(account)) return
    if (identity) account.identities.show(identity)
    p2pApp?.openHome()
    void p2pDm?.openDm(c.peer)
  }
  if (!incoming)
    return (
      <div
        role="status"
        className="pointer-events-auto shrink-0 max-w-screen-inset rounded-full bg-surface-container-high py-1.5 pr-1.5 pl-2 shadow-elevation-3"
      >
        <Row gap="md">
          <Surface
            as="button"
            title="Go to call"
            onClick={go}
            pad="none"
            gap="md"
            row
            tone="plain"
            radius="full"
            look="outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
            place="min-w-0"
          >
            {avatar(28)}
            <span className="flex min-w-0 flex-col text-left">
              <span className="text-sm">
                <Row as="span" gap="2xs">
                  Calling
                  <span className="streamer truncate font-medium">
                    <Masked text={name} />
                  </span>
                  …
                </Row>
              </span>
              <CallType video={c.video} p2p chip={<P2pBadge />} />
            </span>
          </Surface>
          <button
            title="Cancel call"
            aria-label="Cancel call"
            onClick={() => peerCall?.hangup()}
            className={`${ctlBase} h-9 w-9 bg-danger text-on-danger hover:brightness-110`}
          >
            <PhoneOff size={16} />
          </button>
        </Row>
      </div>
    )
  return (
    <div
      role="alertdialog"
      aria-label="Incoming call"
      data-p2p-call-card
      className="pointer-events-auto flex shrink-0 w-72 max-w-screen-inset flex-col items-center gap-3 rounded-3xl bg-surface-container-high px-5 pt-6 pb-5 text-center shadow-elevation-3 max-sm:flex-row max-sm:rounded-2xl max-sm:px-4 max-sm:py-3 max-sm:text-left"
    >
      <span className="max-sm:hidden">{avatar(72)}</span>
      <span className="sm:hidden">{avatar(40)}</span>
      <div className="flex min-w-0 flex-col items-center gap-0.5 max-sm:flex-1 max-sm:items-start">
        <span className="streamer w-full truncate text-base font-semibold">
          <Masked text={name} />
        </span>
        <CallType video={c.video} p2p incoming chip={<P2pBadge />} />
        <Row
          as="button"
          title="Go to conversation"
          onClick={go}
          gap="2xs"
          text="xs"
          ink="muted"
          look="rounded-sm outline-offset-2 hover:text-on-surface hover:underline focus-visible:outline-2 focus-visible:outline-primary"
          place="max-w-full min-w-0"
        >
          <MessageCircle size={12} aria-hidden className="shrink-0" />
          <span className="shrink-0">Conversation with</span>
          <span className="streamer truncate">
            <Masked text={name} />
          </span>
        </Row>
      </div>
      <div className="flex shrink-0 items-center gap-4 max-sm:gap-2 sm:mt-1">
        <button
          title="Decline"
          aria-label="Decline"
          onClick={() => peerCall?.decline()}
          className={`${ctlBase} h-12 w-12 bg-danger text-on-danger hover:brightness-110 max-sm:h-11 max-sm:w-11`}
        >
          <PhoneOff size={20} />
        </button>
        <button
          title="Accept"
          aria-label="Accept"
          disabled={accepting}
          onClick={() => {
            go()
            void peerCall?.accept()
          }}
          className={`${ctlBase} h-12 w-12 bg-status-green text-surface hover:brightness-110 disabled:opacity-60 max-sm:h-11 max-sm:w-11`}
        >
          <Phone size={20} />
        </button>
      </div>
    </div>
  )
}
