'use client'

import { useCallback, useEffect } from 'react'
import { Perm, hasPerm, type Member } from '../lib/types'
import { myPerms, roleColor, roleMenuItems, useStore, type ContextMenuItem } from '../lib/store'
import { UserAvatar } from './user_avatar'
import { longPress } from './context_menu'
import { Sentinel } from './server_settings'

const byName = (a: Member, b: Member) => a.display_name.localeCompare(b.display_name)

function Badge({ tone, children }: { tone: 'primary' | 'tertiary'; children: string }) {
  const cls =
    tone === 'primary'
      ? 'bg-primary-container text-on-primary-container'
      : 'bg-tertiary-container text-on-tertiary-container'
  return (
    <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {children}
    </span>
  )
}

export default function MemberSidebar() {
  const detail = useStore(s => (s.view?.kind === 'channel' ? s.servers[s.view.server] : null))
  const cache = useStore(s => (s.view?.kind === 'channel' ? s.members[s.view.server] : undefined))
  const inter = useStore(s =>
    s.view?.kind === 'channel' ? s.interacted[s.view.server] : undefined
  )
  const me = useStore(s => s.me)
  const perms = useStore(s => (s.view?.kind === 'channel' ? myPerms(s, s.view.server) : 0))
  const loadMembers = useStore(s => s.loadMembers)
  const loadInteracted = useStore(s => s.loadInteracted)
  const openContextMenu = useStore(s => s.openContextMenu)
  const openDialog = useStore(s => s.openDialog)
  const startDm = useStore(s => s.startDm)
  const kickMember = useStore(s => s.kickMember)
  const grantAdmin = useStore(s => s.grantAdmin)
  const revokeAdmin = useStore(s => s.revokeAdmin)
  const transferAdmin = useStore(s => s.transferAdmin)
  const server = detail?.name
  useEffect(() => {
    if (server) {
      void loadMembers(server, true)
      void loadInteracted(server, true)
    }
  }, [server, loadMembers, loadInteracted])
  const more = useCallback(() => {
    if (server) void loadMembers(server)
  }, [server, loadMembers])
  const moreInteracted = useCallback(() => {
    if (server) void loadInteracted(server)
  }, [server, loadInteracted])
  if (!detail) return null

  const loaded = cache?.list ?? []
  const online = loaded.filter(m => m.online).sort(byName)
  const offline = loaded.filter(m => !m.online).sort(byName)
  const offlineCount = Math.max(0, detail.member_count - detail.online_count)

  const menuFor = (m: Member, x: number, y: number): ContextMenuItem[] => {
    if (!me) return []
    const self = m.username === me.username
    const items: ContextMenuItem[] = [
      {
        label: 'Direct Message',
        action: () => void startDm(m.username),
      },
    ]
    if (hasPerm(perms, Perm.Kick) && !self)
      items.push({
        label: 'Kick',
        danger: true,
        action: () => void kickMember(detail.name, m.username),
      })
    if (hasPerm(perms, Perm.ManageAdmins)) {
      items.push(
        m.is_admin
          ? {
              label: 'Revoke Admin',
              danger: true,
              action: () => void revokeAdmin(detail.name, m.username),
            }
          : { label: 'Promote to Admin', action: () => void grantAdmin(detail.name, m.username) }
      )
      if (!self)
        items.push({
          label: 'Transfer Admin',
          action: () => void transferAdmin(detail.name, m.username),
        })
      if (detail.roles.length)
        items.push({
          label: 'Assign Role',
          action: () => openContextMenu(x, y, roleMenuItems(detail.name, m.username)),
        })
    }
    if (me.is_site_admin && !self)
      items.push({
        label: 'Ban',
        danger: true,
        action: () => openDialog({ kind: 'ban_confirm', username: m.username }),
      })
    items.push({
      label: 'Copy User ID',
      action: () => void navigator.clipboard.writeText(m.username),
    })
    return items
  }

  const row = (m: Member) => {
    return (
      <div
        key={m.username}
        {...(me
          ? longPress((x, y) => {
              const items = menuFor(m, x, y)
              if (items.length) openContextMenu(x, y, items)
            })
          : {})}
        className={`flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-surface-container-high ${
          m.online ? '' : 'opacity-50'
        }`}
      >
        <UserAvatar
          username={m.username}
          avatarKind={m.avatar_kind}
          avatarColor={m.avatar_color}
          size={28}
        />
        <span
          style={{ color: roleColor(detail.roles, m.role_ids) }}
          className="streamer min-w-0 flex-1 truncate text-sm"
        >
          {m.display_name}
        </span>
        {m.is_creator && <Badge tone="tertiary">Creator</Badge>}
        {m.is_admin && <Badge tone="primary">Admin</Badge>}
      </div>
    )
  }

  const section = (label: string, count: number, list: Member[]) =>
    count > 0 || list.length ? (
      <div>
        <p className="px-2 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          {label} ({count})
        </p>
        {list.map(row)}
      </div>
    ) : null

  const interacted = inter?.list ?? []

  return (
    <aside className="h-full w-60 shrink-0 overflow-y-auto bg-surface-container-low p-2">
      {section('Online', detail.online_count, online)}
      {section('Offline', offlineCount, offline)}
      {(cache?.hasMore ?? false) && <Sentinel key={loaded.length} onVisible={more} />}
      {interacted.length > 0 && (
        <div>
          <p className="px-2 pt-3 pb-1 text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Interacted ({interacted.length}
            {inter?.hasMore ? '+' : ''})
          </p>
          {interacted.map(u => (
            <div
              key={u.username}
              {...(me
                ? longPress((x, y) =>
                    openContextMenu(x, y, [
                      {
                        label: 'Direct Message',
                        action: () => void startDm(u.username),
                      },
                      {
                        label: 'Copy User ID',
                        action: () => void navigator.clipboard.writeText(u.username),
                      },
                    ])
                  )
                : {})}
              className="flex items-center gap-2 rounded-xl px-2 py-1.5 opacity-70 hover:bg-surface-container-high"
            >
              <UserAvatar
                username={u.username}
                avatarKind={u.avatar_kind}
                avatarColor={u.avatar_color}
                size={28}
              />
              <span className="streamer min-w-0 flex-1 truncate text-sm">{u.display_name}</span>
            </div>
          ))}
          {(inter?.hasMore ?? false) && (
            <Sentinel key={`i${interacted.length}`} onVisible={moreInteracted} />
          )}
        </div>
      )}
    </aside>
  )
}
