'use client'

import type { ActorTagRow } from '../lib/client/view_actor'
import { UserAvatar } from './user_avatar'
import { KeyAvatar } from './p2p/p2p_badge'
import { useMask, useStore } from '../lib/store'
import { Masked } from './ui'

export const TAG_COLORS = ['#433878', '#245147', '#78364c', '#4a4275', '#264d6b', '#634121']
export function tagColor(origin: string) {
  let hash = 0
  for (const c of origin) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0
  return TAG_COLORS[hash % TAG_COLORS.length]
}
export function InstanceTag({ origin, name }: { origin: string; name: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: tagColor(origin), color: '#fff' }}
      className="streamer inline-flex size-5 shrink-0 items-center justify-center rounded-md text-xs font-bold"
    >
      {[...name][0]?.toUpperCase()}
    </span>
  )
}
export function ActorAvatar({ row, size = 32 }: { row: ActorTagRow; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={
        'streamer inline-flex shrink-0 rounded-full ' +
        (row.local ? 'outline-2 outline-offset-1 outline-dashed outline-tertiary' : '')
      }
    >
      {row.local ? (
        <KeyAvatar ik={row.ik ?? row.local} size={size} />
      ) : (
        <UserAvatar
          username={row.username ?? 'Guest'}
          avatarKind={row.avatar?.kind ?? 'identicon'}
          avatarColor={row.avatar?.color ?? null}
          size={size}
        />
      )}
    </span>
  )
}
export function AccountTag({
  row,
  name,
  compactOnPhone = false,
}: {
  row: ActorTagRow
  name: string
  compactOnPhone?: boolean
}) {
  const streamer = useStore(s => s.streamer)
  const mask = useMask()
  return (
    <span
      title={
        streamer
          ? 'Account'
          : mask(
              (row.local ? row.display + ' · P2P · ' : '') +
                (row.username ?? 'Guest') +
                '@' +
                new URL(row.origin).host +
                ' · ' +
                name
            )
      }
      className="streamer inline-flex min-w-0 items-center gap-1.5 text-xs"
    >
      <ActorAvatar row={row} size={16} />
      <span className={compactOnPhone ? 'max-md:sr-only truncate' : 'truncate'}>
        <Masked
          text={row.local ? row.display + ' · P2P · ' + row.username : (row.username ?? 'Guest')}
        />
        {compactOnPhone && (
          <span className="ml-1.5 hidden md:inline-flex">
            <InstanceTag origin={row.origin} name={name} />
          </span>
        )}
      </span>
      {!compactOnPhone && <InstanceTag origin={row.origin} name={name} />}
    </span>
  )
}
