'use client'

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { create } from 'zustand'
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  Monitor,
  Phone,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Signal,
  SignalLow,
  SignalMedium,
  Video,
  VideoOff,
  Volume2,
  VolumeOff,
} from 'lucide-react'
import { rtc } from '../lib/rtc'
import { p2p } from '../lib/p2p'
import { userRefFor, useStore } from '../lib/store'
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
import type { UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { profileTrigger } from './profile_card'
import { COARSE_QUERY, useMedia } from './context_menu'
import { useEscape } from './server_settings'

const useAudioGate = create<{ blocked: boolean }>(() => ({ blocked: false }))
const useSeenShares = create<{ seen: ReadonlySet<string> }>(() => ({ seen: new Set() }))

const unblockAudio = () => {
  const els = [...document.querySelectorAll<HTMLAudioElement>('audio[data-remote-audio]')]
  void Promise.all(els.map(el => el.play())).then(
    () => useAudioGate.setState({ blocked: false }),
    () => {}
  )
}

function useCallMedia() {
  useStore(s => s.rtcTick)
  const voice = useStore(s => s.voice)
  const call = useStore(s => s.call)
  const { muted, deafened } = useStore(s => s.selfAudio)
  const p2pCall = !voice && call?.kind === 'p2p'
  const connected =
    (p2pCall ? p2p.mediaActive() : rtc.active()) && (voice !== null || call !== null)
  const quality: LinkQuality = p2pCall ? (p2p.remote ? 'good' : 'connecting') : rtc.quality()
  return {
    voice,
    call,
    p2pCall,
    connected,
    deafened,
    muted,
    camera: p2pCall ? p2p.camOn : rtc.videoTrack !== null,
    sharing: p2pCall ? p2p.shareOn : rtc.sharing,
    audioNote: p2pCall ? p2p.audioNote : rtc.audioNote,
    quality,
  }
}

// Whether a share is on in the DM call shown, which then gets a taller stage.
export function useCallShare(dmId: number) {
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
      className={`${ctlBase} fixed top-[calc(env(safe-area-inset-top)+4rem)] left-1/2 z-50 -translate-x-1/2 gap-2 bg-inverse-surface px-4 py-2 text-sm whitespace-nowrap font-medium text-inverse-on-surface shadow-elevation-3 hover:opacity-90`}
    >
      <Volume2 size={16} />
      Click to enable audio
    </button>
  )
}

function VoiceAudio() {
  const { connected, p2pCall, deafened } = useCallMedia()
  useEffect(() => {
    if (!connected) useAudioGate.setState({ blocked: false })
  }, [connected])
  if (!connected) return null
  const streams: [string, MediaStream][] = p2pCall
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
        {streams.map(([key, stream]) => (
          <RemoteAudio key={key} stream={stream} muted={deafened} />
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
  muted: boolean
  deafened: boolean
  speaking: boolean
  mirror: boolean
  pending: boolean
  tint: string
  screen: boolean
  shareId: string | null
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
      className={`flex shrink-0 items-center rounded-[4px] bg-danger font-bold tracking-wide text-on-danger ${
        size === 'sm' ? 'px-1 py-px text-[9px] leading-3' : 'px-1.5 py-0.5 text-[11px] leading-4'
      }`}
    >
      LIVE
    </span>
  )
}

function StateIcons({
  muted,
  deafened,
  size,
}: {
  muted: boolean
  deafened: boolean
  size: number
}) {
  const badge = 'flex shrink-0 rounded-full bg-mute p-0.5 text-on-mute'
  return (
    <>
      {muted && !deafened && (
        <span title="Muted" aria-label="Muted" role="img" className={badge}>
          <MicOff size={size} strokeWidth={2.5} />
        </span>
      )}
      {deafened && (
        <span title="Deafened" aria-label="Deafened" role="img" className={badge}>
          <HeadphoneOff size={size} strokeWidth={2.5} />
        </span>
      )}
    </>
  )
}

function Tile({
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
  const { user, stream, hasVideo, muted, deafened, speaking, mirror, pending, tint, screen } = tile
  const box = height ?? (compact ? 72 : 240)
  const avatar = compact ? 32 : Math.round(Math.max(40, Math.min(96, box * 0.3)))
  const label = screen ? `${user.display_name}'s screen` : user.display_name
  return (
    <div
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
          className={`pointer-events-none absolute z-10 ${compact ? 'top-1 left-1' : 'top-2 left-2'}`}
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
                  : 'ring-[3px] ring-status-green'
              }`}
            />
          )}
          <UserAvatar
            username={user.username}
            avatarKind={user.avatar_kind}
            avatarColor={user.avatar_color}
            size={avatar}
          />
        </span>
      )}
      {speaking && !screen && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl shadow-[inset_0_0_0_3px_var(--color-status-green)] motion-safe:animate-speak"
        />
      )}
      <button
        data-tile={tile.key}
        aria-label={`${focused ? 'Back to grid from' : 'Focus'} ${label}`}
        aria-pressed={focused}
        title={focused ? 'Back to grid' : 'Focus'}
        onClick={onToggle}
        className="absolute inset-0 cursor-pointer rounded-xl outline-offset-[-3px] transition-colors hover:bg-on-surface/5 focus-visible:outline-2 focus-visible:outline-primary"
      />
      <span
        {...profileTrigger(user, server)}
        title="View profile"
        className={`absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] cursor-pointer items-center gap-1 rounded-md bg-scrim/70 font-medium text-white outline-offset-2 hover:bg-scrim/85 focus-visible:outline-2 focus-visible:outline-primary ${
          compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs'
        }`}
      >
        {screen ? (
          <Monitor size={compact ? 11 : 13} className="shrink-0" aria-hidden />
        ) : (
          <StateIcons muted={muted} deafened={deafened} size={compact ? 10 : 12} />
        )}
        <span className="streamer truncate">{user.display_name}</span>
        {pending && <span className="shrink-0 opacity-75">Ringing…</span>}
      </span>
    </div>
  )
}

const ctlBase =
  'flex shrink-0 items-center justify-center rounded-full outline-offset-2 transition-colors focus-visible:outline-2 focus-visible:outline-primary'

function CallControls({ size = 'lg' }: { size?: 'lg' | 'sm' }) {
  const { voice, connected, muted, deafened, camera, sharing } = useCallMedia()
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
  const leave = () => (voice ? leaveVoice() : hangupCall())
  return (
    <div className={`flex items-center ${lg ? 'gap-2 sm:gap-3' : 'w-full gap-1.5'}`}>
      <button
        title={muted ? 'Unmute' : 'Mute'}
        aria-label={muted ? 'Unmute' : 'Mute'}
        aria-pressed={muted}
        onClick={toggleMute}
        className={btn(muted ? 'off' : 'idle')}
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
        title={camera ? 'Turn off camera' : 'Turn on camera'}
        aria-label={camera ? 'Turn off camera' : 'Turn on camera'}
        aria-pressed={camera}
        onClick={() => void toggleCamera()}
        className={btn(camera ? 'on' : 'idle')}
      >
        {camera ? <Video size={icon} /> : <VideoOff size={icon} />}
      </button>
      {canShareScreen() && (
        <button
          title={sharing ? 'Stop sharing' : 'Share screen'}
          aria-label={sharing ? 'Stop sharing' : 'Share screen'}
          aria-pressed={sharing}
          onClick={() => void toggleShare()}
          className={btn(sharing ? 'on' : 'idle')}
        >
          {sharing ? <ScreenShareOff size={icon} /> : <ScreenShare size={icon} />}
        </button>
      )}
      {lg && (
        <button
          title={voice ? 'Leave voice' : 'Leave call'}
          aria-label={voice ? 'Leave voice' : 'Leave call'}
          onClick={leave}
          className={`${ctlBase} h-11 w-16 bg-danger text-on-danger hover:brightness-110 sm:h-12 sm:w-18`}
        >
          <PhoneOff size={icon} />
        </button>
      )}
    </div>
  )
}

const smallTone = (state: 'idle' | 'on' | 'off') =>
  state === 'on'
    ? 'bg-primary text-on-primary hover:opacity-90'
    : state === 'off'
      ? 'bg-mute text-on-mute hover:bg-mute-hover'
      : 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest'

export function VoiceControls() {
  return <CallControls size="sm" />
}

const QUALITY: Record<LinkQuality, { label: string; cls: string; Icon: typeof Signal }> = {
  good: { label: 'Voice Connected', cls: 'text-status-green', Icon: Signal },
  connecting: { label: 'Connecting…', cls: 'text-status-yellow', Icon: SignalMedium },
  bad: { label: 'Connection lost', cls: 'text-status-red', Icon: SignalLow },
}

export function VoiceDock() {
  const { voice, call, connected, quality } = useCallMedia()
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const me = useStore(s => s.me)
  const openChannel = useStore(s => s.openChannel)
  const openDm = useStore(s => s.openDm)
  const leaveVoice = useStore(s => s.leaveVoice)
  const hangupCall = useStore(s => s.hangupCall)
  if (!connected) return null
  const detail = voice ? servers[voice.server] : undefined
  const place = voice
    ? (detail?.channels.find(c => c.id === voice.channelId)?.name ?? 'voice')
    : (dms.find(d => d.id === call?.dmId)?.other.display_name ??
      call?.dmUsers.find(u => u !== me?.username) ??
      'call')
  const ringing = !voice && call?.state === 'ringing'
  const status = ringing
    ? { label: 'Calling…', cls: 'text-status-yellow', Icon: SignalMedium }
    : QUALITY[quality]
  const { Icon } = status
  return (
    <div className="shrink-0 border-t border-outline-variant bg-surface-container px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-2 px-1">
        <span title={status.label} className={`flex shrink-0 ${status.cls}`}>
          <Icon size={18} strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm leading-tight font-semibold ${status.cls}`}>
            {status.label}
          </p>
          <button
            title={`Go to ${voice ? 'voice channel' : 'call'}`}
            onClick={() => {
              if (voice) void openChannel(voice.server, voice.channelId)
              else if (call) void openDm(call.dmId)
            }}
            className="flex max-w-full min-w-0 items-center gap-1 rounded-sm text-left text-xs leading-tight text-on-surface-variant outline-offset-2 hover:text-on-surface hover:underline focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span className="streamer truncate">{place}</span>
            {voice && detail && (
              <>
                <span className="shrink-0">/</span>
                <span className="streamer truncate">{detail.display_name}</span>
              </>
            )}
          </button>
        </div>
        <button
          title={voice ? 'Disconnect' : 'Leave call'}
          aria-label={voice ? 'Disconnect' : 'Leave call'}
          onClick={() => (voice ? leaveVoice() : hangupCall())}
          className={`${ctlBase} h-8 w-8 text-on-surface-variant hover:bg-error/15 hover:text-error`}
        >
          <PhoneOff size={18} />
        </button>
      </div>
      <div className="mt-2">
        <VoiceControls />
      </div>
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const arm = () => {
    if (timer.current) clearTimeout(timer.current)
    const tick = () => {
      const el = bar.current
      if (el && (el.matches(':hover') || el.contains(document.activeElement)))
        timer.current = setTimeout(tick, 1000)
      else setIdle(true)
    }
    timer.current = setTimeout(tick, 3000)
  }
  const wake = () => {
    setIdle(false)
    if (enabled) arm()
    else if (timer.current) clearTimeout(timer.current)
  }
  const armRef = useRef(arm)
  useEffect(() => {
    armRef.current = arm
  })
  useEffect(() => {
    if (!enabled) setIdle(false)
    else armRef.current()
    return () => {
      if (timer.current) clearTimeout(timer.current)
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
    <div className="flex shrink-0 justify-center px-3 pt-3 sm:px-4">
      <div
        role="status"
        className={`flex max-w-full min-w-0 items-center gap-2.5 bg-surface-container-high py-1 pr-1 pl-3 text-sm text-on-surface shadow-elevation-2 ${
          audioNote ? 'rounded-3xl' : 'rounded-full'
        }`}
      >
        <span aria-hidden className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inset-0 rounded-full bg-danger/60 motion-safe:animate-ring" />
          <span className="relative h-2.5 w-2.5 rounded-full bg-danger" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <Monitor size={15} aria-hidden className="shrink-0 text-on-surface-variant" />
            <span className="truncate">You&apos;re sharing your screen</span>
          </span>
          {audioNote && (
            <span
              data-share-audio-note
              title="This browser can't keep the call's own sound out of system audio, so it isn't sent, or everyone would hear an echo. Share a tab to include its audio."
              className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-on-surface-variant"
            >
              <VolumeOff size={13} aria-hidden className="shrink-0" />
              <span className="truncate">System audio isn&apos;t shared on this browser</span>
            </span>
          )}
        </span>
        <button
          title="Stop sharing"
          onClick={() => void toggleShare()}
          className={`${ctlBase} h-7 shrink-0 gap-1 bg-danger px-3 text-xs font-semibold text-on-danger hover:brightness-110`}
        >
          <ScreenShareOff size={14} aria-hidden />
          Stop
        </button>
      </div>
    </div>
  )
}

export function VoiceGrid({ channelId, dmId }: { channelId?: number; dmId?: number }) {
  useStore(s => s.rtcTick)
  useStore(s => s.members)
  useStore(s => s.memberInfo)
  useStore(s => s.dms)
  const me = useStore(s => s.me)
  const guest = useStore(s => s.guest)
  const voice = useStore(s => s.voice)
  const call = useStore(s => s.call)
  const { muted: selfMuted, deafened } = useStore(s => s.selfAudio)
  const roomUsers = useStore(s => (channelId !== undefined ? s.voiceUsers[channelId] : undefined))
  const view = useStore(s => s.view)
  const joinVoice = useStore(s => s.joinVoice)
  const server = channelId !== undefined && view?.kind === 'channel' ? view.server : null
  const coarse = useMedia(COARSE_QUERY)

  const forDm = dmId !== undefined && call?.dmId === dmId ? call : null
  const p2pKind = forDm?.kind === 'p2p'
  const joined =
    channelId !== undefined
      ? voice?.channelId === channelId
      : (p2pKind ? p2p.mediaActive() : rtc.active()) && call?.dmId === dmId && !voice
  const users =
    channelId !== undefined
      ? (roomUsers ?? [])
      : forDm
        ? forDm.state === 'active'
          ? forDm.dmUsers
          : forDm.dmUsers.filter(u => u === me?.username)
        : []
  const pendingOther =
    forDm?.state === 'ringing' ? forDm.dmUsers.find(u => u !== me?.username) : undefined
  const state = useStore.getState()

  const tint = (user: UserRef) =>
    bannerColor(
      user,
      user.username === me?.username
        ? me.banner_color
        : cachedProfile(profileKey(user.username, server))?.banner_color
    )

  const people: TileData[] = users.map(u => {
    const user = userRefFor(state, u)
    const base = { key: u, user, pending: false, tint: tint(user), screen: false, shareId: null }
    if (joined && u === me?.username)
      return {
        ...base,
        stream: p2pKind ? p2p.camView : rtc.local,
        hasVideo: p2pKind ? p2p.camOn : rtc.videoTrack !== null,
        muted: selfMuted,
        deafened,
        speaking: p2pKind ? p2p.localSpeaking : rtc.isSpeaking(u),
        mirror: p2pKind ? p2p.camOn : rtc.videoTrack !== null,
      }
    if (p2pKind)
      return {
        ...base,
        stream: joined ? p2p.remote : null,
        hasVideo: joined && p2p.remoteCamOn,
        muted: false,
        deafened: false,
        speaking: joined && p2p.remoteSpeaking,
        mirror: false,
      }
    const peer = joined ? rtc.peer(u) : undefined
    return {
      ...base,
      stream: peer?.stream ?? null,
      hasVideo: peer?.camOn ?? false,
      muted: peer?.muted ?? false,
      deafened: false,
      speaking: joined && rtc.isSpeaking(u),
      mirror: false,
    }
  })
  const screenOf = (t: TileData): TileData | null => {
    if (!joined) return null
    const u = t.user.username
    const share =
      u === me?.username
        ? p2pKind
          ? { stream: p2p.screenView, id: p2p.shareId }
          : { stream: rtc.screenStream, id: rtc.shareId }
        : p2pKind
          ? { stream: p2p.remoteScreenOn ? p2p.remoteScreen : null, id: p2p.remoteShareId }
          : (() => {
              const peer = rtc.peer(u)
              return { stream: peer?.screenOn ? peer.screen : null, id: peer?.shareId ?? null }
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
    const user = userRefFor(state, pendingOther)
    tiles.push({
      key: pendingOther,
      user,
      stream: null,
      hasVideo: false,
      muted: false,
      deafened: false,
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
  const shares = JSON.stringify(
    tiles.flatMap((t): LiveShare[] =>
      t.screen && t.shareId !== null
        ? [{ key: t.key, id: t.shareId, own: t.user.username === me?.username }]
        : []
    )
  )
  useEffect(() => {
    const next = autoFocus(useSeenShares.getState().seen, JSON.parse(shares) as LiveShare[])
    useSeenShares.setState({ seen: next.seen })
    if (next.focus !== null) setFocus(next.focus)
  }, [shares])
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
      {dmId !== undefined && forDm && (
        <div className="flex shrink-0 items-center gap-2 px-4 pt-3 text-xs text-on-surface-variant">
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${
              forDm.state === 'active'
                ? 'bg-status-green'
                : 'bg-status-yellow motion-safe:animate-pulse'
            }`}
          />
          <span className="flex min-w-0 items-center gap-1">
            {forDm.state === 'active' ? 'In call with' : 'Calling'}
            <span className="streamer truncate font-medium text-on-surface">
              {dm?.other.display_name ?? pendingOther ?? ''}
              {forDm.state === 'ringing' && '…'}
            </span>
          </span>
          {p2pKind && (
            <span
              title="P2P call"
              className="shrink-0 rounded bg-tertiary-container px-1 py-0.5 text-[10px] font-bold text-on-tertiary-container"
            >
              P2P
            </span>
          )}
        </div>
      )}
      {joined && <SharePill />}
      <div
        ref={area}
        className={`min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 ${
          joined || channelId !== undefined ? 'pb-20 sm:pb-22' : ''
        }`}
      >
        {focused ? (
          <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="min-h-0 flex-1">{tile(focused, 'focus')}</div>
            {others.length > 0 && (
              <div className="flex shrink-0 justify-center-safe gap-2 overflow-x-auto pb-1">
                {others.map(t => tile(t, 'strip'))}
              </div>
            )}
          </div>
        ) : tiles.length > 0 ? (
          <div
            style={{ gap: GAP }}
            className="flex min-h-full flex-wrap content-center-safe items-center justify-center"
          >
            {box.width > 0 && tiles.map(t => tile(t, 'grid'))}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <p className="text-lg font-semibold text-on-surface">No one is here yet</p>
            <p className="text-sm text-on-surface-variant">
              {guest ? 'Create an account to join voice.' : 'Join to start talking.'}
            </p>
          </div>
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
          ) : (
            channelId !== undefined &&
            !guest && (
              <button
                onClick={() => {
                  if (view?.kind === 'channel') void joinVoice(view.server, channelId)
                }}
                className={`${ctlBase} h-11 gap-2 bg-status-green px-6 text-sm font-semibold text-surface hover:brightness-110`}
              >
                <Phone size={18} />
                Join voice
              </button>
            )
          )}
        </div>
      </div>
    </div>
  )
}

export function CallBanner() {
  const call = useStore(s => s.call)
  const me = useStore(s => s.me)
  const view = useStore(s => s.view)
  const acceptCall = useStore(s => s.acceptCall)
  const declineCall = useStore(s => s.declineCall)
  const hangupCall = useStore(s => s.hangupCall)
  const openDm = useStore(s => s.openDm)
  useStore(s => s.dms)
  const ringing = call !== null && call.state === 'ringing' && me !== null
  const incoming = ringing && call.from !== me.username
  const watching = view?.kind === 'dm' && view.dmId === call?.dmId
  const banner = (() => {
    if (!ringing || (!incoming && watching)) return null
    const state = useStore.getState()
    const other = userRefFor(state, call.dmUsers.find(u => u !== me.username) ?? me.username)
    const p2pBadge = call.kind === 'p2p' && (
      <span
        title="P2P call"
        className="shrink-0 rounded bg-tertiary-container px-1 py-0.5 text-[10px] font-bold text-on-tertiary-container"
      >
        P2P
      </span>
    )
    const avatar = (size: number) => (
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
          <UserAvatar
            username={other.username}
            avatarKind={other.avatar_kind}
            avatarColor={other.avatar_color}
            size={size}
          />
        </span>
      </span>
    )
    if (!incoming)
      return (
        <div
          role="status"
          className="fixed top-[calc(env(safe-area-inset-top)+0.75rem)] left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full bg-surface-container-high py-1.5 pr-1.5 pl-2 shadow-elevation-3"
        >
          <button
            title="Go to call"
            onClick={() => void openDm(call.dmId)}
            className="flex min-w-0 items-center gap-3 rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
          >
            {avatar(28)}
            <span className="flex min-w-0 items-center gap-1 text-sm">
              Calling
              <span className="streamer truncate font-medium">{other.display_name}</span>…
            </span>
          </button>
          {p2pBadge}
          <button
            title="Cancel call"
            onClick={hangupCall}
            className={`${ctlBase} h-9 w-9 bg-danger text-on-danger hover:brightness-110`}
          >
            <PhoneOff size={16} />
          </button>
        </div>
      )
    return (
      <div
        role="alertdialog"
        aria-label="Incoming call"
        className="fixed top-[calc(env(safe-area-inset-top)+0.75rem)] left-1/2 z-50 flex w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-3 rounded-3xl bg-surface-container-high px-5 pt-6 pb-5 text-center shadow-elevation-3 max-sm:flex-row max-sm:rounded-2xl max-sm:px-4 max-sm:py-3 max-sm:text-left"
      >
        <span className="max-sm:hidden">{avatar(72)}</span>
        <span className="sm:hidden">{avatar(40)}</span>
        <div className="flex min-w-0 flex-col items-center max-sm:flex-1 max-sm:items-start">
          <span className="streamer w-full truncate text-base font-semibold">
            {other.display_name}
          </span>
          <span className="flex items-center gap-1.5 text-sm text-on-surface-variant">
            Incoming call
            {p2pBadge}
          </span>
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
              void openDm(call.dmId)
              void acceptCall()
            }}
            className={`${ctlBase} h-12 w-12 bg-status-green text-surface hover:brightness-110 max-sm:h-11 max-sm:w-11`}
          >
            <Phone size={20} />
          </button>
        </div>
      </div>
    )
  })()
  return (
    <>
      <VoiceAudio />
      {banner}
    </>
  )
}
