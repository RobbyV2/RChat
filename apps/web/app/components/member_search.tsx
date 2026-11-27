'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from '../lib/client/react'
import { errorText, useStore } from '../lib/store'
import type { Member } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { useShownMembers } from './shown_user'
import { Row, Stack, Surface } from './layout'
import { Masked, fieldCls } from './ui'

// Searching a hosted server's members: the paged search, its field, and a picker that adds one.

const SEARCH_DEBOUNCE = 250
const PICKER_HITS = 8
const PICKER_PAGES = 4

interface MemberSearch {
  list: Member[]
  next: string | null
  loading: boolean
}

export function useMemberSearch(server: string, q: string, admins = false, enabled = true) {
  const {
    api,
    lifetime: { inSession },
  } = useAccount()
  const needle = q.trim()
  const active = enabled && (needle !== '' || admins)
  const [state, setState] = useState<MemberSearch>({ list: [], next: null, loading: false })
  const [tick, setTick] = useState(0)
  const epoch = useRef(0)
  const setError = useStore(s => s.setError)

  const fetchFrom = useCallback(
    async (cursor: string | null, mine: number) => {
      const showError = inSession(setError)
      setState(s => ({ ...s, loading: true }))
      try {
        const page = await api.listMembers(server, cursor, {
          q: needle || undefined,
          admins,
        })
        if (epoch.current !== mine) return
        setState(s => {
          const base = cursor === null ? [] : s.list
          const seen = new Set(base.map(m => m.username))
          return {
            list: [...base, ...page.items.filter(m => !seen.has(m.username))],
            next: page.next,
            loading: false,
          }
        })
      } catch (e) {
        if (epoch.current !== mine) return
        setState(s => ({ ...s, loading: false }))
        showError(errorText(e))
      }
    },
    [server, needle, admins, setError]
  )

  useEffect(() => {
    const mine = ++epoch.current
    if (!active) {
      setState({ list: [], next: null, loading: false })
      return
    }
    const t = setTimeout(() => void fetchFrom(null, mine), needle ? SEARCH_DEBOUNCE : 0)
    return () => clearTimeout(t)
  }, [active, needle, fetchFrom, tick])

  const more = useCallback(() => {
    if (state.loading || state.next === null) return
    void fetchFrom(state.next, epoch.current)
  }, [state, fetchFrom])
  const reload = useCallback(() => setTick(t => t + 1), [])
  return {
    active,
    list: state.list,
    loading: state.loading,
    more,
    hasMore: state.next !== null,
    reload,
  }
}

export function MemberSearchField({
  value,
  onChange,
  placeholder = 'Search members',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <Row gap="none">
      <input
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={fieldCls}
      />
    </Row>
  )
}

export function MemberPicker({
  server,
  onPick,
  exclude,
}: {
  server: string
  onPick: (m: Member) => void
  exclude?: (m: Member) => boolean
}) {
  const [q, setQ] = useState('')
  const found = useMemberSearch(server, q)
  const shownOf = useShownMembers(server)
  const matching = found.list.filter(m => !exclude?.(m))
  const hits = matching.slice(0, PICKER_HITS)
  const pages = useRef({ q: '', count: 0 })
  const { active, loading, hasMore, more } = found
  useEffect(() => {
    if (pages.current.q !== q) pages.current = { q, count: 0 }
    if (!active || loading || !hasMore || matching.length >= PICKER_HITS) return
    if (pages.current.count >= PICKER_PAGES) return
    pages.current.count += 1
    more()
  }, [q, active, loading, hasMore, more, matching.length])
  return (
    <Stack gap="2xs" place="flex-1">
      <input
        type="search"
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Add member…"
        title="Search members to add"
        className={`${fieldCls} w-full`}
      />
      {found.active && (
        <Stack gap="3xs">
          {hits.map(m => (
            <button
              key={m.username}
              onClick={() => {
                onPick(m)
                setQ('')
              }}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-1 text-left hover:bg-surface-container-highest"
            >
              <UserAvatar
                username={m.username}
                avatarKind={shownOf(m).avatar_kind}
                avatarColor={shownOf(m).avatar_color}
                size={20}
              />
              <span className="streamer min-w-0 flex-1 truncate text-sm">
                <Masked text={shownOf(m).display_name} by={m.username} />
              </span>
            </button>
          ))}
          {!found.loading && hits.length === 0 && (
            <Surface pad="sm" inset="bar" tone="plain" radius="none">
              <p className="text-xs text-on-surface-variant">
                {found.hasMore ? 'Keep typing to narrow the search.' : 'No matching members.'}
              </p>
            </Surface>
          )}
        </Stack>
      )}
    </Stack>
  )
}
