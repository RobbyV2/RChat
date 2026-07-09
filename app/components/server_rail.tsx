'use client'

import { useRouter } from 'next/navigation'
import { LogOut, Plus, Settings, Shield } from 'lucide-react'
import { useStore } from '../lib/store'
import { UserAvatar } from './user_avatar'
import { InstallButton } from './pwa_register'
import { ThemeToggle } from './status_clock'

const tile = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-colors'

export function ServerRail() {
  const router = useRouter()
  const me = useStore(s => s.me)
  const guestServers = useStore(s => s.guestServers)
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const view = useStore(s => s.view)
  const openDm = useStore(s => s.openDm)
  const openServer = useStore(s => s.openServer)
  const openDialog = useStore(s => s.openDialog)
  const openContextMenu = useStore(s => s.openContextMenu)
  const leaveServer = useStore(s => s.leaveServer)
  const logout = useStore(s => s.logout)

  const serverList = me
    ? me.servers.map(({ name, display_name, creator }) => ({ name, display_name, creator }))
    : guestServers.map(name => ({
        name,
        display_name: servers[name]?.display_name ?? name,
        creator: servers[name]?.creator ?? null,
      }))

  const sortedDms = [...dms].sort((a, b) => Number(b.is_self) - Number(a.is_self))

  return (
    <nav className="flex h-full w-18 shrink-0 flex-col items-center gap-2 overflow-y-auto bg-surface-container-lowest py-3">
      {me &&
        sortedDms.map(dm => {
          const { id, other, is_self } = dm
          const active = view?.kind === 'dm' && view.dmId === id
          return (
            <button
              key={id}
              title={is_self ? `${other.display_name} (yourself)` : other.display_name}
              onClick={() => void openDm(id)}
              className={`relative shrink-0 rounded-full ${active ? 'ring-2 ring-primary ring-offset-2 ring-offset-surface-container-lowest' : ''}`}
            >
              <UserAvatar
                username={other.username}
                avatarKind={other.avatar_kind}
                avatarColor={other.avatar_color}
                size={44}
              />
              {is_self && (
                <span className="absolute -right-1 -bottom-0.5 rounded-full bg-primary px-1.5 text-[9px] leading-4 font-bold text-on-primary">
                  you
                </span>
              )}
            </button>
          )
        })}
      {me && <div className="my-1 h-px w-8 shrink-0 bg-outline-variant" />}
      {serverList.map(({ name, display_name, creator }) => {
        const active = view?.kind === 'channel' && view.server === name
        const mine = me !== null && creator === me.username
        return (
          <button
            key={name}
            title={mine ? `${display_name} (Creator)` : display_name}
            onClick={() => void openServer(name)}
            onContextMenu={e => {
              e.preventDefault()
              if (name === 'rchat') return
              openContextMenu(e.clientX, e.clientY, [
                { label: 'Leave Server', danger: true, action: () => void leaveServer(name) },
              ])
            }}
            className={`${tile} relative text-lg font-semibold ${
              active
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-high text-on-surface hover:bg-primary-container hover:text-on-primary-container'
            }`}
          >
            {name === 'rchat' ? (
              <img src="/rchat_r.png" alt="RChat" className="h-full w-full object-contain p-1" />
            ) : (
              <span className="streamer">{display_name.trim().charAt(0).toUpperCase() || '?'}</span>
            )}
            {mine && (
              <span
                title="Creator"
                className="absolute -right-1 -bottom-0.5 rounded-full bg-tertiary-container px-1.5 text-[9px] leading-4 font-bold text-on-tertiary-container"
              >
                C
              </span>
            )}
          </button>
        )
      })}
      <button
        title="Add a server"
        onClick={() => openDialog({ kind: 'add_server' })}
        className={`${tile} bg-primary-container text-on-primary-container shadow-elevation-1 hover:bg-primary hover:text-on-primary`}
      >
        <Plus size={22} />
      </button>
      <div className="mt-auto flex shrink-0 flex-col items-center gap-2 pt-2">
        <ThemeToggle />
        <InstallButton compact />
        <button
          title="Settings"
          onClick={() => openDialog({ kind: 'settings' })}
          className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
        >
          <Settings size={20} />
        </button>
        {me?.is_site_admin && (
          <button
            title="Site administration"
            onClick={() => openDialog({ kind: 'admin_panel' })}
            className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <Shield size={20} />
          </button>
        )}
        <button
          title={me ? 'Log out' : 'Exit guest mode'}
          onClick={() => {
            logout()
            router.replace('/login')
          }}
          className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-error"
        >
          <LogOut size={20} />
        </button>
      </div>
    </nav>
  )
}
