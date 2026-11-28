'use client'

import { identityPerson, pictured } from '../lib/people'
import type { ActorTagRow } from '../lib/client/view_actor'
import { UserAvatar } from './user_avatar'
import { KeyAvatar } from './p2p/p2p_badge'
import { useMask, useStore } from '../lib/store'
import { Masked } from './ui'
import { Row } from './layout'

// The tag colors of globals.css (`--color-tag-1` to `-6`), one per instance by its origin.
export const TAG_CLASSES = ['bg-tag-1', 'bg-tag-2', 'bg-tag-3', 'bg-tag-4', 'bg-tag-5', 'bg-tag-6']
export function tagClass(origin: string) {
  let hash = 0
  for (const c of origin) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0
  return TAG_CLASSES[hash % TAG_CLASSES.length]
}
export function InstanceTag({ origin, name }: { origin: string; name: string }) {
  return (
    <span
      aria-hidden="true"
      className={`streamer inline-flex size-5 shrink-0 items-center justify-center rounded-md text-xs font-bold text-on-tag ${tagClass(origin)}`}
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
        <KeyAvatar person={identityPerson(row.ik ?? row.local, 'own')} size={size} />
      ) : (
        <UserAvatar person={pictured(row.username ?? 'Guest', row.avatar, 'own')} size={size} />
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
      className="streamer inline-flex min-w-0 text-xs"
    >
      <Row as="span" gap="xs">
        <ActorAvatar row={row} size={16} />
        <span className={compactOnPhone ? 'max-md:sr-only truncate' : 'truncate'}>
          <Masked
            text={row.local ? row.display + ' · P2P · ' + row.username : (row.username ?? 'Guest')}
          />
        </span>
        {compactOnPhone ? (
          <span className="hidden md:inline-flex">
            <InstanceTag origin={row.origin} name={name} />
          </span>
        ) : (
          <InstanceTag origin={row.origin} name={name} />
        )}
      </Row>
    </span>
  )
}
