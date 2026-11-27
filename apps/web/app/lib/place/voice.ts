import { openActionMenu } from '../actions/menu'
import type { AccountSession } from '../client/session'
import { voiceSelf } from '../guest_voice'
import type { P2pApp } from '../p2p/app/runtime'
import type { MemberView } from '../p2p/server'
import { shownMedia } from '../timeouts'
import { channelTarget } from '../viewing'
import { voiceStatus, type VoiceStatus } from '../voice_status'
import { defineFeature, notInDms } from './feature'
import { built, type Live } from './live'

// Someone in a voice channel as its row in the channel list shows them.
export interface VoiceSeat {
  key: string
  self: boolean
  // An account shows as its server shows it; a key shows the picture and name its room has.
  face:
    | { kind: 'account'; username: string; server: string }
    | { kind: 'key'; ik: string; name: string; of: readonly MemberView[] }
  speaking: boolean
  status: VoiceStatus
  // Sharing a screen you can see.
  live: boolean
}

export interface VoiceChannelState {
  // You are in this channel.
  connected: boolean
  // Who is in it; nobody while the channel is closed by a viewing choice here.
  seats: VoiceSeat[]
}

export interface Voice {
  channel: (key: string) => Live<VoiceChannelState>
  // Joins the channel, or shows it when you are in it already.
  enter: (key: string) => void
  // The menu of someone in a channel, where the place has one for them here.
  seatMenu: ((channel: string, seat: string, x: number, y: number) => void) | null
}

const perChannel = (make: (key: string) => Live<VoiceChannelState>) => {
  const made = new Map<string, Live<VoiceChannelState>>()
  return (key: string) => {
    let known = made.get(key)
    if (!known) {
      known = make(key)
      made.set(key, known)
    }
    return known
  }
}

const NOBODY: string[] = []

const hosted = (account: AccountSession, server: string): Voice => {
  const { store, rtc, viewing, conn } = account
  const subscribe = (changed: () => void) => {
    const stops = [store.subscribe(changed), viewing.useViewing.subscribe(changed)]
    return () => stops.forEach(stop => stop())
  }
  const channel = perChannel(key => {
    const id = Number(key)
    const state = (initial: boolean) =>
      built(
        () => {
          const s = initial ? store.getInitialState() : store.getState()
          return [
            s.servers[server]?.channels,
            s.voiceUsers[id],
            s.voice?.channelId === id,
            voiceSelf(s),
            s.me?.username ?? null,
            s.selfAudio,
            s.rtcTick,
            s.voiceMuted,
            s.voiceHushed,
            s.voiceAudio[id],
            viewing.useViewing.getState().revision,
          ] as const
        },
        ([channels, users, inRoom, mine, me, selfAudio, , muted, hushedBy, audio]) => {
          const c = channels?.find(x => x.id === id)
          const open = c && viewing.canView(channelTarget(me, 'instance', server, c, conn))
          const seats = (open ? (users ?? NOBODY) : NOBODY).map((username): VoiceSeat => {
            const self = mine === username
            const silenced = Object.values(muted).some(l => l.includes(username))
            const hushed = Object.values(hushedBy).some(l => l.includes(username))
            const peer = inRoom && !self ? rtc.peer(username) : undefined
            return {
              key: username,
              self,
              face: { kind: 'account', username, server },
              speaking: inRoom && rtc.isSpeaking(username) && !silenced && !hushed,
              status: voiceStatus({
                self: self && inRoom,
                selfAudio,
                live: peer ? { muted: peer.muted } : null,
                roster: audio?.[username] ?? null,
                forced: hushed ? 'staff' : silenced ? 'timeout' : null,
              }),
              live:
                inRoom && (self ? rtc.sharing : shownMedia(rtc.peer(username), silenced).screen),
            }
          })
          return { connected: inRoom, seats }
        }
      )
    return { get: state(false), initial: state(true), subscribe }
  })
  return {
    channel,
    enter: key => void store.getState().joinVoice(server, Number(key)),
    seatMenu: null,
  }
}

const peer = (app: P2pApp, room: string): Voice => {
  const { useP2p, callRtc, peerTarget, p2pServer, p2pVoice, owner } = app
  const subscribe = (changed: () => void) => {
    const stops = [
      useP2p.subscribe(changed),
      owner.store.subscribe(changed),
      owner.viewing.useViewing.subscribe(changed),
    ]
    return () => stops.forEach(stop => stop())
  }
  const connected = (key: string) => {
    const s = useP2p.getState()
    const a = owner.store.getState()
    return s.voice?.room === room && s.voice.ch === key && a.voice === null && a.call === null
  }
  const channel = perChannel(key => {
    const state = (initial: boolean) =>
      built(
        () => {
          const s = initial ? useP2p.getInitialState() : useP2p.getState()
          const a = initial ? owner.store.getInitialState() : owner.store.getState()
          const v = s.servers[room]
          const target = peerTarget(s, room, key)
          return [
            v?.voice[key],
            v?.members,
            s.voice?.room === room && s.voice.ch === key && a.voice === null && a.call === null,
            s.me,
            s.name,
            a.selfAudio,
            a.rtcTick,
            !!target && !owner.viewing.canView(target),
            owner.viewing.useViewing.getState().revision,
          ] as const
        },
        ([users, members, inRoom, me, myName, selfAudio, , closed]) => {
          const seats = (closed ? [] : (users ?? [])).map((u): VoiceSeat => {
            const self = u.ik === me
            const other = inRoom && !self ? callRtc.peer(u.ik) : undefined
            const silenced = u.silenced === true
            return {
              key: u.ik,
              self,
              face: {
                kind: 'key',
                ik: u.ik,
                name: members?.find(m => m.ik === u.ik)?.name ?? (self ? myName : 'Member'),
                of: members ?? [],
              },
              speaking: inRoom && callRtc.isSpeaking(u.ik),
              status: voiceStatus({
                self: self && inRoom,
                selfAudio: silenced ? { ...selfAudio, muted: true } : selfAudio,
                live: other ? { muted: other.muted || silenced } : null,
                roster: { muted: u.muted || silenced, deafened: u.deafened },
                forced: null,
              }),
              live: inRoom && (self ? callRtc.sharing : (other?.screenOn ?? false)),
            }
          })
          return { connected: inRoom, seats }
        }
      )
    return { get: state(false), initial: state(true), subscribe }
  })
  return {
    channel,
    enter: key => {
      if (connected(key)) void p2pServer.openChannel(key)
      else void p2pVoice.join(room, key)
    },
    seatMenu: (_channel, seat, x, y) => {
      const v = useP2p.getState().servers[room]
      const m = v?.members.find(x => x.ik === seat)
      if (v && m) openActionMenu(x, y, { kind: 'p2p_member', v, m }, undefined, owner, app)
    },
  }
}

// The voice channels of a server or a room as their rows in the channel list show them.
export const voice = defineFeature<Voice>('voice', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})
