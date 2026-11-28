'use client'

import { useEffect } from 'react'
import { Crown } from 'lucide-react'
import { endsText } from '../lib/durations'
import { bans as bansFeature, type BanEntry, type Bans as BansOf } from '../lib/place/bans'
import { featureAt, isUnsupported } from '../lib/place/feature'
import type { Place } from '../lib/place/place'
import { useLive } from '../lib/place/react'
import { Button } from './controls'
import { Row, Stack, Surface } from './layout'
import { Name } from './name'
import { MemberAvatar } from './p2p/p2p_badge'
import { useNow } from './timeout_dialog'
import { Sentinel } from './ui'
import { UserAvatar } from './user_avatar'

function BanRow({ entry, now, onUnban }: { entry: BanEntry; now: number; onUnban: () => void }) {
  const { face, ends } = entry
  const end =
    ends === null
      ? null
      : ends > now
        ? `Ban ends ${endsText(ends, now)}`
        : entry.lapses
          ? "Waiting for a moderator's device"
          : null
  const line = [end, entry.reason].filter(Boolean).join(' · ')
  return (
    <Surface as="li" data-ban={entry.who} pad="sm" inset="bar" tone="plain" radius="lg">
      <Row gap="sm">
        {face.kind === 'account' ? (
          <UserAvatar person={face.user} size={28} />
        ) : (
          <MemberAvatar members={face.of} ik={face.ik} size={28} />
        )}
        <span className="min-w-0 flex-1 text-sm">
          <Row as="span" gap="xs">
            <Name of={entry.name} color={entry.color ?? undefined} look="min-w-0 truncate" />
            {entry.owner && (
              <span title="Owner" aria-label="Owner" role="img" className="flex text-tertiary">
                <Crown size={14} />
              </span>
            )}
            {entry.since !== null && (
              <span className="shrink-0 text-xs text-on-surface-variant">
                · banned {new Date(entry.since).toLocaleDateString()}
              </span>
            )}
          </Row>
          {line && (
            <span className="block text-xs break-words text-on-surface-variant">{line}</span>
          )}
        </span>
        {entry.unban && <Button onClick={onUnban}>Unban</Button>}
      </Row>
    </Surface>
  )
}

// Who is banned from a server or a room, and lifting their bans.
export function BanList({ place }: { place: Place }) {
  const here = featureAt(bansFeature, place)
  if (isUnsupported(here)) return null
  return <Bans bans={here} />
}

function Bans({ bans }: { bans: BansOf }) {
  const state = useLive(bans.state)
  useEffect(() => bans.watch(), [bans])
  const now = useNow(state.timed, 30_000)
  if (!state.ready) return null
  return (
    <Stack gap="md">
      {state.entries.length === 0 ? (
        <Surface pad="sm" inset="bar" tone="plain" radius="none">
          <p className="text-sm text-on-surface-variant">No one is banned.</p>
        </Surface>
      ) : (
        <Stack as="ul" data-bans gap="2xs">
          {state.entries.map(e => (
            <BanRow key={e.who} entry={e} now={now} onUnban={() => bans.unban(e.who)} />
          ))}
        </Stack>
      )}
      {state.more && <Sentinel key={state.entries.length} onVisible={bans.more} />}
      {state.note && (
        <Surface pad="sm" inset="bar" tone="plain" radius="none">
          <p className="text-xs text-on-surface-variant">{state.note}</p>
        </Surface>
      )}
    </Stack>
  )
}
