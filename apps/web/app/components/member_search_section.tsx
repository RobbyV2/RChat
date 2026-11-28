'use client'

import { useEffect, useMemo, useState } from 'react'
import { Crown } from 'lucide-react'
import { NO_FILTERS, allowedFilters, type MemberFilters } from '../lib/member_filters'
import { featureAt, isUnsupported } from '../lib/place/feature'
import {
  memberSearch as searchFeature,
  type MemberSearch,
  type SearchChoices,
  type SearchRow,
} from '../lib/place/member_search'
import { moderation, type Moderation } from '../lib/place/moderation'
import type { Place } from '../lib/place/place'
import { useLive, useWatch } from '../lib/place/react'
import { Loaded, More } from './loaded'
import { Stack } from './layout'
import { MemberFilterBar, MemberTable, MemberTableRow } from './member_table'
import { Name } from './name'
import { MemberAvatar } from './p2p/p2p_badge'
import { MemberCard } from './p2p/p2p_server_roles'
import { Badge } from './profile_card'
import { TimeoutBadge, useNow } from './timeout_dialog'
import { UserAvatar } from './user_avatar'
import { time } from '../lib/platform/time'

function RowTimeout({ moderated, who }: { moderated: Moderation; who: string }) {
  const { timeout } = useWatch(() => moderated.member(who), [moderated, who])
  const now = useNow(timeout !== null && timeout.ends > time().now())
  return timeout && timeout.ends > now ? <TimeoutBadge t={timeout} compact /> : null
}

function Row({
  row,
  choices,
  search,
  moderated,
  room,
}: {
  row: SearchRow
  choices: SearchChoices
  search: MemberSearch
  moderated: Moderation | null
  room: string | null
}) {
  const { face } = row
  return (
    <MemberTableRow
      rowKey={row.who}
      avatar={
        face.kind === 'account' ? (
          <UserAvatar person={face.user} size={28} />
        ) : (
          <MemberAvatar members={face.of} ik={face.ik} size={28} />
        )
      }
      name={
        <Name
          data-member-row={row.who}
          of={row.name}
          withUsername={face.kind === 'account'}
          color={row.color ?? undefined}
          look="min-w-0 flex-1 truncate text-sm"
        />
      }
      badges={
        <>
          {row.owner && (
            <span title="Owner" aria-label="Owner" role="img" className="flex text-tertiary">
              <Crown size={14} />
            </span>
          )}
          {row.invited && (
            <span className="shrink-0 text-xs text-on-surface-variant">{row.invited}</span>
          )}
          {moderated && <RowTimeout moderated={moderated} who={row.who} />}
          {row.creator && <Badge tone="tertiary">Creator</Badge>}
          {row.admin && <Badge tone="primary">Admin</Badge>}
        </>
      }
      facts={row.facts}
      joinedAt={row.joinedAt}
      createdAt={row.createdAt}
      created={choices.created}
      joined={choices.joined}
      menu={(x, y) =>
        search.menu(
          row.who,
          x,
          y,
          choices.cards && room !== null ? <MemberCard room={room} ik={row.who} /> : undefined
        )
      }
    />
  )
}

function List({
  search,
  choices,
  filters,
  moderated,
  room,
}: {
  search: MemberSearch
  choices: SearchChoices
  filters: MemberFilters
  moderated: Moderation | null
  room: string | null
}) {
  const source = useMemo(() => search.search(filters), [search, filters])
  const load = useLive(source)
  return (
    <Loaded load={load} what="members" empty="No matching members.">
      {found => (
        <Stack gap="none">
          <MemberTable created={choices.created} joined={choices.joined} label="Members">
            {found.items.map(row => (
              <Row
                key={row.who}
                row={row}
                choices={choices}
                search={search}
                moderated={moderated}
                room={room}
              />
            ))}
          </MemberTable>
          <More pages={found} auto />
        </Stack>
      )}
    </Loaded>
  )
}

function Body({ search, place }: { search: MemberSearch; place: Place }) {
  const choices = useLive(search.choices)
  useEffect(() => search.watch(), [search])
  const [filters, setFilters] = useState<MemberFilters>(NO_FILTERS)
  const moderating = featureAt(moderation, place)
  const moderated = isUnsupported(moderating) ? null : moderating
  if (!choices) return null
  const shown = allowedFilters(filters, { created: choices.created, via: choices.via !== null })
  return (
    <Stack data-member-search gap="md">
      {choices.filters && (
        <MemberFilterBar
          value={shown}
          onChange={setFilters}
          choices={{ roles: choices.roles, via: choices.via, created: choices.created }}
        />
      )}
      <List
        search={search}
        choices={choices}
        filters={choices.filters ? shown : NO_FILTERS}
        moderated={moderated}
        room={place.kind === 'p2pRoom' ? place.room : null}
      />
      {choices.notes.length > 0 && (
        <Stack gap="2xs">
          {choices.notes.map(n => (
            <p key={n} className="text-xs text-on-surface-variant">
              {n}
            </p>
          ))}
        </Stack>
      )}
    </Stack>
  )
}

// The members of a server or a room in its settings: filters, the list 50 at a time, and each
// member's menu.
export function MemberSearchSection({ place }: { place: Place }) {
  const here = featureAt(searchFeature, place)
  return isUnsupported(here) ? null : <Body search={here} place={place} />
}
