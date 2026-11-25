'use client'

import type { ReactNode } from 'react'
import { textBtn } from './ui'

// The "Server profiles" list of a settings page, the same for hosted servers and P2P servers:
// your servers, each opening the profile you show only there.
export function ServerProfileList({
  children,
  more,
}: {
  children: ReactNode
  more?: (() => void) | null
}) {
  return (
    <div data-server-profiles className="flex flex-col gap-1">
      <span className="text-sm text-on-surface-variant">Server profiles</span>
      <p className="text-xs text-on-surface-variant">
        A name, avatar, banner and description that only one server shows.
      </p>
      <ul className="flex flex-col">{children}</ul>
      {more && (
        <button onClick={more} className={`${textBtn} self-start`}>
          Show more
        </button>
      )}
    </div>
  )
}

export function ServerProfileRow({ name, onEdit }: { name: ReactNode; onEdit: () => void }) {
  return (
    <li className="flex min-h-10 items-center gap-3">
      <span className="streamer min-w-0 flex-1 truncate text-sm text-on-surface">{name}</span>
      <button onClick={onEdit} className={`${textBtn} shrink-0`}>
        Edit
      </button>
    </li>
  )
}
