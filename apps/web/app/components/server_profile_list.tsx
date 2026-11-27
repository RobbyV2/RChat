'use client'

import type { ReactNode } from 'react'
import { Button } from './controls'

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
        <Button onClick={more} place="self-start">
          Show more
        </Button>
      )}
    </div>
  )
}

export function ServerProfileRow({ name, onEdit }: { name: ReactNode; onEdit: () => void }) {
  return (
    <li className="flex min-h-10 items-center gap-3">
      <span className="streamer min-w-0 flex-1 truncate text-sm text-on-surface">{name}</span>
      <Button onClick={onEdit} place="shrink-0">
        Edit
      </Button>
    </li>
  )
}
