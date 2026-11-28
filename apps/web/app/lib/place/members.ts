import type { ShownPerson } from '../people'
import type { Target } from '../actions/types'
import { FIRST_GROUPS, FIRST_ROWS, groupParts, serverGroups } from '../member_groups'
import { badgeState } from '../p2p/badge'
import { shieldOf } from '../p2p/contacts'
import { serversLoading } from '../p2p/conversations'
import { VOUCH_INVITER_TEXT } from '../p2p/flows'
import { hex, lookOfMember, memberGroups, viewCan } from '../p2p/roles'
import type { MemberView } from '../p2p/server'
import { ownsP2pServer } from '../p2p/server/types'
import { P } from '../p2p/state'
import { PAGE, pageGroups } from '../paging'
import { onlineSection } from '../presence'
import { hostedMembersHidden, p2pMembersHidden, type MembersHidden } from '../member_list'
import { loaded as rulesLoaded } from '../perms'
import { loadPermissionRules } from '../perms_load'
import { seesMembers } from '../profile_choice'
import type { Look } from '../role_looks'
import { roleLook } from '../selectors'
import { byShownName, lookIn, shownParts, shownUser } from '../server_profile'
import type { RChatState } from '../store_types'
import type { Timeout } from '../timeouts'
import type { Member, UserRef } from '../types'
import { defineFeature, notInDms } from './feature'
import { derived, fromStore, type Live } from './live'
import { time } from '../platform/time'

type Shield = ReturnType<typeof shieldOf> | 'unverified'

// One member row of a hosted server or a P2P room.
export interface MemberEntry {
  who: string
  // An account draws its own picture and name; a key draws the picture its room has for it.
  face:
    { kind: 'account'; user: ShownPerson } | { kind: 'key'; ik: string; of: readonly MemberView[] }
  name: string
  own: boolean
  online: boolean
  // Whether the picture carries a presence dot.
  dot: boolean
  faded: boolean
  look: Look
  tags: ('creator' | 'admin' | 'owner')[]
  // The timeout set for them, where you may see it; it may have ended.
  timeout: Timeout | null
  // The identity whose linked account shows under the name.
  chip: string | null
  note: string | null
  shield: Shield | null
  // What a click opens: the profile card, or the row's menu under the member's card.
  opens: { kind: 'profile'; user: UserRef; server: string } | { kind: 'card'; room: string }
  // The row's menu; null while there is none (signed out).
  menu: Target | null
}

export type MemberItem =
  | { kind: 'head'; key: string; label: string; count: number | null; dot: string | null }
  | { kind: 'member'; key: string; entry: MemberEntry }
  | { kind: 'more'; key: string; load: () => void }

export interface MemberList {
  // `none`: nothing to show here; `hidden`: the server keeps its members to itself.
  state: 'none' | 'loading' | 'hidden' | 'ready'
  // Why a hidden list is hidden.
  why: MembersHidden | null
  // What the loading rows are drawn from.
  seed: string
  items: MemberItem[]
  // Group and role names here are your own text.
  ownText: boolean
  // Whether group and role names go through your display filter.
  masked: boolean
  // Whether the list is an identity's (a room) and not an account's.
  byIdentity: boolean
}

// The member list of a place, 50 at a time.
export interface Members {
  list: Live<MemberList>
  // Loads the first rows and keeps what the list needs loaded; the answer stops it.
  watch: () => () => void
}

const NONE: MemberItem[] = []
const plain = (
  state: MemberList['state'],
  seed: string,
  why: MembersHidden | null = null
): MemberList => ({
  state,
  why,
  seed,
  items: NONE,
  ownText: false,
  masked: false,
  byIdentity: false,
})

const sameParts = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((x, i) => Object.is(x, b[i]))

// Why the server keeps its member list from the viewer, in the open channel (`inChannel`) or
// anywhere in it; null when it shows it. Until the permission rules are loaded only the rule
// for people outside the server is known; the server refuses what it hides either way.
const hostedHidden = (s: RChatState, server: string, inChannel: boolean): MembersHidden | null => {
  const detail = s.servers[server]
  const member = s.me?.servers.some(x => x.name === server) ?? false
  const siteAdmin = s.me?.is_site_admin ?? false
  if (!rulesLoaded())
    return seesMembers(detail?.members_visible, member, siteAdmin) ? null : 'outside'
  const open = s.view?.kind === 'channel' && s.view.server === server ? s.view.channelId : null
  return hostedMembersHidden({
    siteOn: s.settings.member_lists !== false,
    siteAdmin,
    member,
    detail,
    channel: inChannel && open !== null ? detail?.channels.find(c => c.id === open) : null,
  })
}

// The channel a member list loads for: the open one while only it shows the list.
const hostedScope = (s: RChatState, server: string) =>
  hostedHidden(s, server, true) === null && hostedHidden(s, server, false) !== null
    ? s.view?.kind === 'channel' && s.view.server === server
      ? s.view.channelId
      : null
    : null

const hostedList = (s: RChatState, server: string) => {
  const parts = shownParts(s, server)
  return [
    s.servers[server],
    s.members[server],
    s.memberInfo[server],
    s.interacted[server],
    s.hoisted[server],
    s.timeouts[server],
    hostedHidden(s, server, true),
    s.me !== null,
    parts.names,
    parts.rest,
  ] as const
}

const hosted = ({
  account,
  server,
}: {
  account: { store: import('zustand').StoreApi<RChatState> }
  server: string
}): Members => {
  const { store } = account
  const act = () => store.getState()
  const list = derived(
    fromStore(store, s => hostedList(s, server), sameParts),
    ([detail, cache, info, inter, hoisted, timeouts, why, signedIn, names, rest]): MemberList => {
      if (!detail) return plain('loading', server)
      if (why !== null) return plain('hidden', server, why)
      if (detail.member_count > 0 && (!cache || (cache.loading && !cache.list.length)))
        return plain('loading', server)
      const shownOf = <T extends UserRef & { profile?: Member['profile'] }>(
        m: T
      ): T & ShownPerson => shownUser(m, m.profile ? lookIn(m.profile, { names, rest }) : null)
      const items: MemberItem[] = []
      const row = (m: Member): MemberItem => {
        const user = shownOf(m)
        return {
          kind: 'member',
          key: `m${m.username}`,
          entry: {
            who: m.username,
            face: { kind: 'account', user },
            name: user.display_name,
            own: false,
            online: m.online,
            dot: false,
            faded: false,
            look: roleLook(detail.roles, m.role_ids),
            tags: [
              ...(m.is_creator ? ['creator' as const] : []),
              ...(m.is_admin ? ['admin' as const] : []),
            ],
            timeout: timeouts?.[m.username] ?? null,
            chip: null,
            note: null,
            shield: null,
            opens: { kind: 'profile', user: m, server },
            menu: signedIn ? { kind: 'member', user: m, server, where: 'list' } : null,
          },
        }
      }
      const interacted = () => {
        const users = inter?.list ?? []
        if (!users.length) return
        items.push({
          kind: 'head',
          key: 'hint',
          label: `Interacted (${users.length}${inter?.hasMore ? '+' : ''})`,
          count: null,
          dot: null,
        })
        for (const u of users)
          items.push({
            kind: 'member',
            key: `u${u.username}`,
            entry: {
              who: u.username,
              face: { kind: 'account', user: shownUser(u, null) },
              name: u.display_name,
              own: false,
              online: true,
              dot: false,
              faded: true,
              look: {},
              tags: [],
              timeout: null,
              chip: null,
              note: null,
              shield: null,
              opens: { kind: 'profile', user: u, server },
              menu: signedIn
                ? { kind: 'member', user: u, server: null, where: 'interacted' }
                : null,
            },
          })
        if (inter?.hasMore)
          items.push({
            kind: 'more',
            key: `imore${users.length}`,
            load: () => void act().loadInteracted(server),
          })
      }
      const groups = serverGroups(detail.roles)
      if (groups.length > 0) {
        for (const part of groupParts(groups, hoisted, m => shownOf(m).display_name))
          items.push(
            part.kind === 'more'
              ? {
                  kind: 'more',
                  key: part.key,
                  load: () => void act().loadGroup(server, part.group),
                }
              : part.kind === 'member'
                ? row(part.m)
                : { kind: 'head', key: part.key, label: part.label, count: null, dot: null }
          )
        interacted()
        return {
          state: 'ready',
          why: null,
          seed: server,
          items,
          ownText: false,
          masked: false,
          byIdentity: false,
        }
      }
      const loaded = cache?.list ?? []
      const { online, offline, totals, more } = onlineSection(
        detail.online_count,
        detail.member_count,
        cache,
        info
      )
      // Each section in the order of the names the server shows.
      const section = (id: string, label: string, count: number, of: Member[]) => {
        if (count <= 0 && !of.length) return
        items.push({
          kind: 'head',
          key: `h${id}`,
          label: `${label} (${count})`,
          count: null,
          dot: null,
        })
        const shown = of.map(m => ({ m, shown: shownOf(m) }))
        for (const { m } of shown.sort((a, b) => byShownName(a.shown, b.shown))) items.push(row(m))
      }
      section('on', 'Online', totals.online, online)
      if (more)
        items.push({ kind: 'more', key: more, load: () => void act().loadMissingOnline(server) })
      section('off', 'Offline', totals.offline, offline)
      if (cache?.hasMore)
        items.push({
          kind: 'more',
          key: `more${loaded.length}`,
          load: () => void act().loadMembers(server),
        })
      interacted()
      return {
        state: 'ready',
        why: null,
        seed: server,
        items,
        ownText: false,
        masked: false,
        byIdentity: false,
      }
    }
  )
  return {
    list,
    watch: () => {
      let started = false
      let ids: string | null = null
      let loaded: boolean | null = null
      let busy = false
      let scope: number | null = null
      if (!rulesLoaded())
        void loadPermissionRules().then(
          () => store.setState({}),
          () => undefined
        )
      const run = () => {
        if (busy) return
        busy = true
        try {
          for (let again = true; again;) {
            again = false
            const s = act()
            const detail = s.servers[server]
            if (!detail || hostedHidden(s, server, true) !== null) break
            const nowScope = hostedScope(s, server)
            if (nowScope !== scope) {
              scope = nowScope
              started = false
              ids = null
            }
            if (!started) {
              s.scopeMembers(server, scope)
              started = true
              void s.loadMembers(server, true)
              void s.loadInteracted(server, true)
            }
            const now = serverGroups(detail.roles)
              .map(g => g.id)
              .join(',')
            if (now !== ids) {
              ids = now
              loaded = null
              s.clearGroups(server)
              again = true
              continue
            }
            const has = !!s.hoisted[server]
            if (has === loaded) break
            loaded = has
            if (!now || has) break
            for (const id of now.split(',').slice(0, FIRST_GROUPS))
              void s.loadGroup(server, Number(id), true, FIRST_ROWS)
            void s.loadGroup(server, 'rest', true)
          }
        } finally {
          busy = false
        }
      }
      run()
      return store.subscribe(run)
    },
  }
}

const peer = ({
  app,
  room,
}: {
  app: import('../p2p/app/runtime').P2pApp
  room: string
}): Members => {
  let shown = PAGE
  const waiting = new Set<() => void>()
  const grow = () => {
    shown += PAGE
    for (const changed of waiting) changed()
  }
  const parts = fromStore(
    app.useP2p,
    s =>
      [
        s.servers[room],
        s.me,
        s.contacts,
        s.badges,
        s.server?.room === room && serversLoading(s),
        s.server?.room === room ? (s.server.ch ?? null) : null,
        rulesLoaded(),
      ] as const,
    sameParts
  )
  const build = (count: number): MemberList => {
    const [v, me, contacts, badges, loading, ch, rules] = parts.get()
    if (!v) return { ...plain(loading ? 'loading' : 'none', room), byIdentity: true }
    if (!rules) return { ...plain('loading', room), byIdentity: true }
    const why = me
      ? p2pMembersHidden(v, me, ch, app.owner.store.getState().settings.member_lists !== false)
      : null
    if (why !== null) return { ...plain('hidden', room, why), byIdentity: true }
    const now = time().now()
    const sees = viewCan(v, P.TimeoutMembers)
    const paged = pageGroups(memberGroups(v.members, v.roles, me), count)
    const items: MemberItem[] = []
    for (const g of paged.groups) {
      items.push({
        kind: 'head',
        key: `h${g.key}`,
        label: g.label,
        count: g.total,
        dot: g.key.startsWith('r:') ? (hex(g.color) ?? 'var(--color-outline)') : null,
      })
      for (const m of g.list) {
        const own = m.ik === me
        const contact = contacts.find(c => c.ik === m.ik)
        items.push({
          kind: 'member',
          key: `m${m.ik}`,
          entry: {
            who: m.ik,
            face: { kind: 'key', ik: m.ik, of: v.members },
            name: m.name,
            own,
            online: m.online || own,
            dot: m.m === 'join',
            faded: false,
            look: lookOfMember(m, v.roles),
            tags: m.owner ? ['owner'] : [],
            timeout:
              (own || sees) && m.timeoutUntil !== undefined
                ? { ends: m.timeoutUntil, reason: m.timeoutReason ?? null }
                : null,
            chip: !own && badgeState(badges[m.ik], now) ? m.ik : null,
            note: m.waits ? VOUCH_INVITER_TEXT : null,
            shield: own ? null : contact ? shieldOf(contact) : 'unverified',
            opens: { kind: 'card', room },
            menu: { kind: 'p2p_member', v, m },
          },
        })
      }
    }
    if (paged.more) items.push({ kind: 'more', key: `more${count}`, load: grow })
    return {
      state: 'ready',
      why: null,
      seed: room,
      items,
      ownText: ownsP2pServer(v, me),
      masked: true,
      byIdentity: true,
    }
  }
  let held: { from: unknown; count: number; value: MemberList } | null = null
  const get = () => {
    const from = parts.get()
    if (held === null || held.from !== from || held.count !== shown)
      held = { from, count: shown, value: build(shown) }
    return held.value
  }
  return {
    list: {
      get,
      subscribe: changed => {
        waiting.add(changed)
        const stop = parts.subscribe(changed)
        return () => {
          waiting.delete(changed)
          stop()
        }
      },
    },
    watch: () => {
      shown = PAGE
      if (!rulesLoaded())
        void loadPermissionRules().then(
          () => {
            for (const changed of waiting) changed()
          },
          () => undefined
        )
      return () => {}
    },
  }
}

export const members = defineFeature<Members>('members', {
  hostedServer: hosted,
  p2pRoom: peer,
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})
