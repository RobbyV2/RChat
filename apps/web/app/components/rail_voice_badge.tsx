'use client'
import { Volume2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useAccount } from '../lib/client/react'
import { useP2p, useP2pApp } from '../lib/client/p2p_react'
import type { AccountSession } from '../lib/client/session'
import { useMotionPlays } from '../lib/motion/use_motion'
import type { P2pApp } from '../lib/p2p/app/runtime'
import type { P2pState } from '../lib/p2p/app/store'
import { useStore } from '../lib/store'
import {
  hostedVoiceCounter,
  p2pVoiceCounter,
  voiceBadgeTitle,
  voiceLabel,
  voiceListsWanted,
  voiceSum,
} from '../lib/voice_rail'
import { stableKey, useStableSelector } from '../lib/stable_key'
import type { RChatState } from '../lib/store_types'

// The top-left badge of a server or folder tile while people are in its voice channels.
export function RailVoiceBadge({ count }: { count: number }) {
  const streamer = useStore(s => s.streamer)
  const moves = useMotionPlays()
  if (count <= 0) return null
  return (
    <span
      data-voice-badge={count}
      title={voiceBadgeTitle(count, streamer)}
      className={`absolute -top-1.5 -left-1.5 flex size-5 items-center justify-center rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-status-green text-surface ${moves ? 'animate-badge-pop' : ''}`}
    >
      <Volume2 size={11} strokeWidth={2.5} aria-hidden />
      <span className="sr-only">{voiceLabel(count)}</span>
    </span>
  )
}

const hostedCounters = new WeakMap<AccountSession, ReturnType<typeof hostedVoiceCounter>>()
const hostedCounter = (account: AccountSession) => {
  const known = hostedCounters.get(account)
  if (known) return known
  const made = hostedVoiceCounter(account.viewing)
  hostedCounters.set(account, made)
  return made
}

const p2pCounters = new WeakMap<P2pApp, ReturnType<typeof p2pVoiceCounter<P2pState>>>()
const p2pCounter = (app: P2pApp) => {
  const known = p2pCounters.get(app)
  if (known) return known
  const made = p2pVoiceCounter<P2pState>((s, room, ch) => app.peerVisible(s, room, ch))
  p2pCounters.set(app, made)
  return made
}

// How many people are in voice in the hosted servers named, as this account may see.
export function useHostedVoice(names: readonly string[]) {
  const account = useAccount()
  const revision = account.viewing.useViewing(s => s.revision)
  const count = hostedCounter(account)
  return useStore(s => voiceSum(count(s, revision), names))
}

// The same for the P2P rooms named, in the shown identity.
export function useP2pVoice(rooms: readonly string[]) {
  const app = useP2pApp()
  const revision = useAccount().viewing.useViewing(s => s.revision)
  const count = app && p2pCounter(app)
  return useP2p(s => (count ? voiceSum(count(s, revision), rooms) : 0))
}

// Hosted servers with people in voice but no current channel list: the rail asks for each list
// once, and their badges show when it arrives.
export function useVoiceLists() {
  const discover = useStore(s => s.discoverChannels)
  const wanted = useStore(
    useStableSelector((s: RChatState) => ({
      epoch: s.channelLabelEpoch,
      names: voiceListsWanted(s),
    }))
  )
  const asked = useRef(new Set<string>())
  useEffect(() => {
    const { epoch, names } = wanted
    for (const name of names) {
      const key = stableKey([epoch, name])
      if (asked.current.has(key)) continue
      asked.current.add(key)
      discover(name).catch(() => {})
    }
  }, [wanted, discover])
}
