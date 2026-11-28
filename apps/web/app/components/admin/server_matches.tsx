'use client'

import { ask, asked } from '../../lib/asks'
import type { ReactNode } from 'react'
import type { ServerSummaryLite } from '../../lib/types'
import { ServerGlyph } from '../server_rail'
import { Stack } from '../layout'
import { Loaded, useAccountRequest } from '../loaded'

function Matches({
  text,
  limit,
  row,
}: {
  text: string
  limit: number
  row: (server: ServerSummaryLite) => ReactNode
}) {
  const load = useAccountRequest(
    () => asked(ask.adminServers(null, text), found => found.items.slice(0, limit)),
    [text, limit],
    { delayMs: 300, empty: found => found.length === 0 }
  )
  return (
    <Loaded
      load={load}
      skeleton={null}
      empty="No server matches that name."
      what="the matching servers"
    >
      {found => <Stack gap="2xs">{found.map(row)}</Stack>}
    </Loaded>
  )
}

// The servers of the instance whose name matches what is typed, each drawn by `row`.
export function ServerMatches({
  q,
  limit,
  row,
}: {
  q: string
  limit: number
  row: (server: ServerSummaryLite) => ReactNode
}) {
  const text = q.trim()
  return text === '' ? null : <Matches text={text} limit={limit} row={row} />
}

// A server's icon (its picture where it has one) at the start of an admin row.
export function AdminServerGlyph({ server }: { server: ServerSummaryLite }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 overflow-hidden rounded-md bg-surface-container-highest text-xs text-on-surface"
    >
      <ServerGlyph name={server.name} displayName={server.display_name} look={server} />
    </span>
  )
}
