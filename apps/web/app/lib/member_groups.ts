import type { MemberGroup } from './api'
import { hoistGroups, hostedShown, onlineFirst, type Shown } from './role_looks'
import type { Paged } from './store_types'
import type { Member, Role } from './types'

// The groups of a hosted server's member list: a page of members for each role shown separately
// and one for everyone else (`rest`), by server, then group.
export type GroupPages = Record<string, Record<string, Paged<Member>>>

// Groups whose first page loads when the list opens, and how many rows it holds.
export const FIRST_GROUPS = 3
export const FIRST_ROWS = 20

export const groupKey = (group: MemberGroup) => String(group)

// Every loaded group page of `server` (of every server when null) through `fn`.
export const mapGroups = (
  pages: GroupPages,
  server: string | null,
  fn: (list: Member[]) => Member[]
): GroupPages => {
  let out: GroupPages | null = null
  for (const [name, groups] of Object.entries(pages)) {
    if (server !== null && name !== server) continue
    let next: Record<string, Paged<Member>> | null = null
    for (const [key, page] of Object.entries(groups)) {
      const list = fn(page.list)
      if (list === page.list) continue
      next ??= { ...groups }
      next[key] = { ...page, list }
    }
    if (next) (out ??= { ...pages })[name] = next
  }
  return out ?? pages
}

// The roles of a server shown as groups, in display order.
export const serverGroups = (roles: readonly Role[] | undefined): Shown<number>[] =>
  hoistGroups(hostedShown(roles))

export type GroupPart =
  | { kind: 'head'; key: string; label: string }
  | { kind: 'member'; key: string; m: Member }
  | { kind: 'more'; key: string; group: MemberGroup }

// The member list of a server with groups: each group's loaded members (online first), then
// everyone else split into online and offline. A group not loaded yet, or with more to load,
// ends with a `more` part.
export const groupParts = (
  groups: readonly Shown<number>[],
  pages: Record<string, Paged<Member>> | undefined,
  name: (m: Member) => string
): GroupPart[] => {
  const out: GroupPart[] = []
  const tail = (group: MemberGroup, page: Paged<Member> | undefined) => {
    if (!page || page.hasMore)
      out.push({ kind: 'more', key: `more${groupKey(group)}:${page?.list.length ?? 0}`, group })
  }
  const rows = (list: readonly Member[]) => {
    for (const m of list) out.push({ kind: 'member', key: `m${m.username}`, m })
  }
  const seen = new Set<string>()
  for (const g of groups) {
    const page = pages?.[groupKey(g.id)]
    const list = (page?.list ?? []).filter(m => !seen.has(m.username))
    for (const m of list) seen.add(m.username)
    if (!list.length && page && !page.hasMore) continue
    out.push({ kind: 'head', key: `g${g.id}`, label: g.name })
    rows(onlineFirst(list, m => m.online, name))
    tail(g.id, page)
  }
  const page = pages?.rest
  const rest = (page?.list ?? []).filter(m => !seen.has(m.username))
  const on = rest.filter(m => m.online)
  const off = rest.filter(m => !m.online)
  for (const [key, label, list] of [
    ['on', 'Online', on],
    ['off', 'Offline', off],
  ] as const) {
    if (!list.length) continue
    out.push({ kind: 'head', key: `h${key}`, label })
    rows(onlineFirst(list, () => false, name))
  }
  tail('rest', page)
  return out
}
