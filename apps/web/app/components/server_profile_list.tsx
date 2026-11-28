'use client'

import type { NameValue } from '../lib/names'
import { Name } from './name'
import type { ReactNode } from 'react'
import { Button } from './controls'
import { Stack, Row } from './layout'

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
    <Stack data-server-profiles gap="2xs">
      <span className="text-sm text-on-surface-variant">Server profiles</span>
      <p className="text-xs text-on-surface-variant">
        A name, avatar, banner and description that only one server shows.
      </p>
      <Stack as="ul" gap="none">
        {children}
      </Stack>
      {more && (
        <Button onClick={more} place="self-start">
          Show more
        </Button>
      )}
    </Stack>
  )
}

export function ServerProfileRow({ name, onEdit }: { name: NameValue; onEdit: () => void }) {
  return (
    <li className="flex min-h-10 items-center">
      <Row gap="md" place="flex-1">
        <Name of={name} look="min-w-0 flex-1 truncate text-sm text-on-surface" />
        <Button onClick={onEdit} place="shrink-0">
          Edit
        </Button>
      </Row>
    </li>
  )
}
