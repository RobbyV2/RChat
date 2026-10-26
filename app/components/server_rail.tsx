'use client'

import { useRouter } from 'next/navigation'
import { LogOut, MessageCircle, Plus, Settings, Shield } from 'lucide-react'
import { dmsUnread, serverUnread, useStore } from '../lib/store'
import { orderServers } from '../lib/nav_layout'
import { serverInitial } from '../lib/rules'
import { longPress } from './context_menu'
import { dragScope } from './drag'
import { InstallButton } from './pwa_register'
import { Sentinel } from './server_settings'
import { ThemeToggle } from './status_clock'

const tile = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-colors'

export function ServerRail() {
  const router = useRouter()
  const me = useStore(s => s.me)
  const guestServers = useStore(s => s.guestServers)
  const servers = useStore(s => s.servers)
  const view = useStore(s => s.view)
  const openLastDm = useStore(s => s.openLastDm)
  const openServer = useStore(s => s.openServer)
  const serversMore = useStore(s => s.serversMore)
  const loadMoreServers = useStore(s => s.loadMoreServers)
  const openDialog = useStore(s => s.openDialog)
  const openContextMenu = useStore(s => s.openContextMenu)
  const leaveServer = useStore(s => s.leaveServer)
  const askConfirm = useStore(s => s.askConfirm)
  const logout = useStore(s => s.logout)
  const moveServer = useStore(s => s.moveServer)
  const saved = useStore(s => s.layout.servers)
  useStore(s => s.reads)
  const dot = (
    <span
      title="Unread messages"
      aria-hidden
      className="absolute -top-1 -right-1 h-3 w-3 rounded-full border-2 border-surface-container-lowest bg-error"
    />
  )

  const serverList = orderServers(
    me
      ? me.servers.map(({ name, display_name, creator }) => ({ name, display_name, creator }))
      : guestServers.map(name => ({
          name,
          display_name: servers[name]?.display_name ?? name,
          creator: servers[name]?.creator ?? null,
        })),
    x => x.name,
    saved
  )

  return (
    <nav
      ref={dragScope}
      className="flex h-full w-18 shrink-0 flex-col items-center gap-2 overflow-y-auto bg-surface-container-lowest pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      {me && (
        <button
          title="Direct messages"
          onClick={openLastDm}
          className={`${tile} relative ${
            view?.kind === 'dm'
              ? 'bg-primary text-on-primary'
              : 'bg-surface-container-high text-on-surface hover:bg-primary-container hover:text-on-primary-container'
          }`}
        >
          <MessageCircle size={22} />
          {dmsUnread(useStore.getState()) && dot}
        </button>
      )}
      {me && <div className="my-1 h-px w-8 shrink-0 bg-outline-variant" />}
      <div data-drop-zone="servers" className="flex shrink-0 flex-col items-center gap-2">
        {serverList.map(({ name, display_name, creator }) => {
          const active = view?.kind === 'channel' && view.server === name
          const mine = me !== null && creator === me.username
          return (
            <button
              key={name}
              title={mine ? `${display_name} (Creator)` : display_name}
              onClick={() => void openServer(name)}
              {...longPress(
                (x, y) =>
                  openContextMenu(x, y, [
                    {
                      label: 'Copy Server ID',
                      action: () => void navigator.clipboard.writeText(name),
                    },
                    ...(name === 'rchat'
                      ? []
                      : [
                          {
                            label: 'Leave Server',
                            danger: true,
                            action: () =>
                              askConfirm({
                                title: 'Leave Server',
                                body: 'Leave this server? You can join it again later.',
                                confirm: 'Leave',
                                action: () => void leaveServer(name),
                              }),
                          },
                        ]),
                  ]),
                { group: 'rail', key: name, onDrop: ({ index }) => moveServer(name, index) }
              )}
              className={`${tile} relative text-lg font-semibold ${
                active
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-container-high text-on-surface hover:bg-primary-container hover:text-on-primary-container'
              }`}
            >
              {name === 'rchat' ? (
                <img
                  src="/rchat_r.png"
                  alt="RChat"
                  draggable={false}
                  className="h-full w-full object-contain p-1"
                />
              ) : (
                <span className="streamer">{serverInitial(display_name)}</span>
              )}
              {mine && (
                <span
                  title="Creator"
                  className="absolute -right-1 -bottom-0.5 rounded-full bg-tertiary-container px-1.5 text-[9px] leading-4 font-bold text-on-tertiary-container"
                >
                  C
                </span>
              )}
              {serverUnread(useStore.getState(), name) && dot}
            </button>
          )
        })}
      </div>
      {me && serversMore && <Sentinel key={me.servers.length} onVisible={loadMoreServers} />}
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
