'use client'

import { useEffect, useRef } from 'react'
import {
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react'
import { rtc } from '../lib/rtc'
import { p2p } from '../lib/p2p'
import { userRefFor, useStore } from '../lib/store'
import type { UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'

function VideoView({
  stream,
  hidden,
  mirror,
  muteAudio,
}: {
  stream: MediaStream
  hidden: boolean
  mirror: boolean
  muteAudio: boolean
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
      muted={muteAudio}
      className={`absolute inset-0 h-full w-full object-contain ${hidden ? 'hidden' : ''} ${
        mirror ? '-scale-x-100' : ''
      }`}
    />
  )
}

function Tile({
  user,
  stream,
  hasVideo,
  muted,
  speaking = false,
  mirror = false,
  muteAudio = false,
  pending = false,
}: {
  user: UserRef
  stream: MediaStream | null
  hasVideo: boolean
  muted: boolean
  speaking?: boolean
  mirror?: boolean
  muteAudio?: boolean
  pending?: boolean
}) {
  return (
    <div
      className={`relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl bg-surface-container transition-shadow ${
        speaking ? 'ring-2 ring-green-500' : ''
      }`}
    >
      {stream && (
        <VideoView stream={stream} hidden={!hasVideo} mirror={mirror} muteAudio={muteAudio} />
      )}
      {!hasVideo && (
        <UserAvatar
          username={user.username}
          avatarKind={user.avatar_kind}
          avatarColor={user.avatar_color}
          size={56}
        />
      )}
      <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full bg-scrim/60 px-2 py-0.5 text-xs text-white">
        {muted && (
          <span title="Muted" className="flex shrink-0">
            <MicOff size={12} />
          </span>
        )}
        <span className="streamer truncate">
          {user.display_name}
          {pending ? '…' : ''}
        </span>
      </span>
    </div>
  )
}

export function VoiceControls() {
  useStore(s => s.rtcTick)
  const voice = useStore(s => s.voice)
  const call = useStore(s => s.call)
  const toggleMute = useStore(s => s.toggleMute)
  const toggleCamera = useStore(s => s.toggleCamera)
  const toggleShare = useStore(s => s.toggleShare)
  const leaveVoice = useStore(s => s.leaveVoice)
  const hangupCall = useStore(s => s.hangupCall)
  const p2pCall = !voice && call?.kind === 'p2p'
  if ((p2pCall ? !p2p.mediaActive() : !rtc.active()) || (!voice && !call)) return null
  const muted = p2pCall ? p2p.muted : rtc.muted
  const camera = p2pCall ? p2p.camOn : rtc.videoTrack !== null && !rtc.sharing
  const sharing = p2pCall ? p2p.shareOn : rtc.sharing
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  const btn = (active: boolean) =>
    `rounded-full p-2 ${
      active
        ? 'bg-primary text-on-primary'
        : 'bg-surface-container-highest text-on-surface hover:bg-surface-container-high'
    }`
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 border-t border-outline-variant p-2">
      <button title={muted ? 'Unmute' : 'Mute'} onClick={toggleMute} className={btn(muted)}>
        {muted ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      <button
        title={camera ? 'Turn off camera' : 'Turn on camera'}
        onClick={() => void toggleCamera()}
        className={btn(camera)}
      >
        {camera ? <Video size={16} /> : <VideoOff size={16} />}
      </button>
      {canShare && (
        <button
          title={sharing ? 'Stop sharing' : 'Share screen'}
          onClick={() => void toggleShare()}
          className={btn(sharing)}
        >
          {sharing ? <MonitorOff size={16} /> : <Monitor size={16} />}
        </button>
      )}
      <button
        title={voice ? 'Leave voice' : 'Leave call'}
        onClick={() => (voice ? leaveVoice() : hangupCall())}
        className="rounded-full bg-error p-2 text-on-error hover:opacity-90"
      >
        <PhoneOff size={16} />
      </button>
    </div>
  )
}

export function VoiceDock() {
  useStore(s => s.rtcTick)
  const voice = useStore(s => s.voice)
  const call = useStore(s => s.call)
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const me = useStore(s => s.me)
  const p2pCall = !voice && call?.kind === 'p2p'
  if ((p2pCall ? !p2p.mediaActive() : !rtc.active()) || (!voice && !call)) return null
  const label = voice
    ? (servers[voice.server]?.channels.find(c => c.id === voice.channelId)?.name ?? 'voice')
    : (dms.find(d => d.id === call?.dmId)?.other.display_name ??
      call?.dmUsers.find(u => u !== me?.username) ??
      'call')
  return (
    <div className="shrink-0 border-t border-outline-variant bg-surface-container">
      <p className="flex items-center gap-1 truncate px-3 pt-2 text-xs font-medium text-primary">
        <Volume2 size={12} className="shrink-0" />
        <span className="streamer truncate">{label}</span>
      </p>
      <VoiceControls />
    </div>
  )
}

export function VoiceGrid({ channelId, dmId }: { channelId?: number; dmId?: number }) {
  useStore(s => s.rtcTick)
  useStore(s => s.members)
  useStore(s => s.dms)
  const me = useStore(s => s.me)
  const voice = useStore(s => s.voice)
  const call = useStore(s => s.call)
  const roomUsers = useStore(s => (channelId !== undefined ? s.voiceUsers[channelId] : undefined))
  const view = useStore(s => s.view)
  const joinVoice = useStore(s => s.joinVoice)

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

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="grid flex-1 auto-rows-min content-center gap-3 overflow-y-auto p-4 sm:grid-cols-2">
        {users.map(u => {
          const user = userRefFor(state, u)
          if (joined && u === me?.username)
            return (
              <Tile
                key={u}
                user={user}
                stream={p2pKind ? p2p.local : rtc.local}
                hasVideo={p2pKind ? p2p.camOn || p2p.shareOn : rtc.videoTrack !== null}
                muted={p2pKind ? p2p.muted : rtc.muted}
                speaking={p2pKind ? p2p.localSpeaking : rtc.isSpeaking(u)}
                mirror={
                  p2pKind ? p2p.camOn && !p2p.shareOn : rtc.videoTrack !== null && !rtc.sharing
                }
                muteAudio
              />
            )
          if (p2pKind)
            return (
              <Tile
                key={u}
                user={user}
                stream={joined ? p2p.remote : null}
                hasVideo={joined && p2p.remoteCamOn}
                muted={false}
                speaking={joined && p2p.remoteSpeaking}
              />
            )
          const peer = joined ? rtc.peer(u) : undefined
          return (
            <Tile
              key={u}
              user={user}
              stream={peer?.stream ?? null}
              hasVideo={peer?.camOn ?? false}
              muted={peer?.muted ?? false}
              speaking={joined && rtc.isSpeaking(u)}
            />
          )
        })}
        {pendingOther && (
          <Tile
            key={pendingOther}
            user={userRefFor(state, pendingOther)}
            stream={null}
            hasVideo={false}
            muted={false}
            pending
          />
        )}
        {users.length === 0 && !pendingOther && (
          <p className="col-span-full text-center text-sm text-on-surface-variant">
            No one is in voice yet
          </p>
        )}
      </div>
      {joined ? (
        <VoiceControls />
      ) : (
        channelId !== undefined && (
          <div className="flex shrink-0 justify-center border-t border-outline-variant p-3">
            <button
              onClick={() => {
                if (view?.kind === 'channel') void joinVoice(view.server, channelId)
              }}
              className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary hover:opacity-90"
            >
              Join voice
            </button>
          </div>
        )
      )}
    </div>
  )
}

export function CallBanner() {
  const call = useStore(s => s.call)
  const me = useStore(s => s.me)
  const dms = useStore(s => s.dms)
  const acceptCall = useStore(s => s.acceptCall)
  const declineCall = useStore(s => s.declineCall)
  const hangupCall = useStore(s => s.hangupCall)
  const openDm = useStore(s => s.openDm)
  if (!call || call.state !== 'ringing' || !me) return null
  const incoming = call.from !== me.username
  const other = call.dmUsers.find(u => u !== me.username) ?? me.username
  const name = dms.find(d => d.other.username === other)?.other.display_name ?? other
  return (
    <div className="fixed top-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-2xl bg-surface-container-high px-4 py-3 shadow-elevation-3">
      <Phone size={18} className="shrink-0 text-primary" />
      {call.kind === 'p2p' && (
        <span
          title="P2P call"
          className="shrink-0 rounded bg-tertiary-container px-1 py-0.5 text-[10px] font-bold text-on-tertiary-container"
        >
          P2P
        </span>
      )}
      <span className="streamer truncate text-sm font-medium">
        {incoming ? `${name} is calling` : `Calling ${name}…`}
      </span>
      {incoming ? (
        <>
          <button
            title="Accept"
            onClick={() => {
              void openDm(call.dmId)
              void acceptCall()
            }}
            className="shrink-0 rounded-full bg-primary p-2 text-on-primary hover:opacity-90"
          >
            <Phone size={16} />
          </button>
          <button
            title="Decline"
            onClick={declineCall}
            className="shrink-0 rounded-full bg-error p-2 text-on-error hover:opacity-90"
          >
            <PhoneOff size={16} />
          </button>
        </>
      ) : (
        <button
          title="Cancel call"
          onClick={hangupCall}
          className="shrink-0 rounded-full bg-error p-2 text-on-error hover:opacity-90"
        >
          <PhoneOff size={16} />
        </button>
      )}
    </div>
  )
}
