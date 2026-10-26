'use client'

import { useRouter } from 'next/navigation'
import { FolderOpen, LogOut, MessageCircle, Plus, Settings, Shield } from 'lucide-react'
import {
  dmsUnread,
  folderLabel,
  railServers,
  serverUnread,
  useStore,
  type RailServer,
} from '../lib/store'
import { folderKey, railItems, serverKey, type Folder } from '../lib/nav_layout'
import type { DropTarget } from '../lib/drag'
import type { ServerDetail } from '../lib/types'
import { serverInitial } from '../lib/rules'
import { inviteUrl } from '../lib/invite'
import { longPress } from './context_menu'
import { dragScope } from './drag'
import { InstallButton } from './pwa_register'
import { Sentinel } from './server_settings'
import { ThemeToggle } from './status_clock'

const tile = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-colors'
const idle =
  'bg-surface-container-high text-on-surface hover:bg-primary-container hover:text-on-primary-container'

const NO_DETAILS: Record<string, ServerDetail> = {}
const SERVER = serverKey('')
const FOLDER = folderKey('')

const strip = (key: string | null, prefix: string) =>
  key?.startsWith(prefix) ? key.slice(prefix.length) : null

const dropServer = (name: string, { zone, index, onto }: DropTarget) => {
  const s = useStore.getState()
  const folder = strip(onto, FOLDER)
  const target = strip(onto, SERVER)
  const into = strip(zone, FOLDER)
  if (folder !== null) s.addToFolder(name, folder)
  else if (target !== null) s.mergeServers(name, target)
  else if (into !== null) s.moveIntoFolder(name, into, index)
  else s.moveServer(name, index)
}

export function ServerGlyph({ name, displayName }: { name: string; displayName: string }) {
  return name === 'rchat' ? (
    <img
      src="/rchat_r.png"
      alt="RChat"
      draggable={false}
      className="h-full w-full object-contain p-1"
    />
  ) : (
    <span className="streamer">{serverInitial(displayName)}</span>
  )
}

function UnreadDot() {
  return (
    <span
      title="Unread messages"
      aria-hidden
      className="absolute -top-1 -right-1 h-3 w-3 rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-error"
    />
  )
}

function ServerTile({
  server: { name, display_name, creator },
  folder,
  at,
}: {
  server: RailServer
  folder: string | null
  at: number
}) {
  const me = useStore(s => s.me)
  const active = useStore(s => s.view?.kind === 'channel' && s.view.server === name)
  const unread = useStore(s => serverUnread(s, name))
  const openServer = useStore(s => s.openServer)
  const openContextMenu = useStore(s => s.openContextMenu)
  const leaveServer = useStore(s => s.leaveServer)
  const askConfirm = useStore(s => s.askConfirm)
  const moveServer = useStore(s => s.moveServer)
  const mine = me !== null && creator === me.username
  const parent = folder === null ? null : folderKey(folder)
  return (
    <button
      title={mine ? `${display_name} (Creator)` : display_name}
      onClick={() => void openServer(name)}
      {...longPress(
        (x, y) =>
          openContextMenu(x, y, [
            {
              label: 'Copy invite link',
              action: () => void navigator.clipboard.writeText(inviteUrl(name)),
            },
            {
              label: 'Copy Server ID',
              action: () => void navigator.clipboard.writeText(name),
            },
            ...(folder === null
              ? []
              : [{ label: 'Remove from folder', action: () => moveServer(name, at + 1) }]),
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
        {
          group: 'rail',
          key: serverKey(name),
          onto: key => key !== parent,
          onDrop: target => dropServer(name, target),
        }
      )}
      data-drop-onto={folder === null ? 'Create folder' : undefined}
      className={`${tile} relative text-lg font-semibold ${active ? 'bg-primary text-on-primary' : idle}`}
    >
      <ServerGlyph name={name} displayName={display_name} />
      {mine && (
        <span
          title="Creator"
          className="absolute -right-1 -bottom-0.5 rounded-full bg-tertiary-container px-1.5 text-[9px] leading-4 font-bold text-on-tertiary-container"
        >
          C
        </span>
      )}
      {unread && <UnreadDot />}
    </button>
  )
}

function MiniIcon({ server: { name, display_name } }: { server: RailServer }) {
  const active = useStore(s => s.view?.kind === 'channel' && s.view.server === name)
  return (
    <span
      className={`flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-md text-[9px] leading-none font-semibold ${
        active ? 'bg-primary text-on-primary' : 'folder-mini'
      }`}
    >
      {name === 'rchat' ? (
        <img src="/rchat_r.png" alt="" draggable={false} className="h-full w-full object-contain" />
      ) : (
        <span className="streamer">{serverInitial(display_name)}</span>
      )}
    </span>
  )
}

function FolderEntry({
  folder,
  servers,
  at,
}: {
  folder: Folder
  servers: RailServer[]
  at: number
}) {
  const toggleFolder = useStore(s => s.toggleFolder)
  const moveFolder = useStore(s => s.moveFolder)
  const ungroupFolder = useStore(s => s.ungroupFolder)
  const openDialog = useStore(s => s.openDialog)
  const openContextMenu = useStore(s => s.openContextMenu)
  const unread = useStore(s => !folder.open && servers.some(x => serverUnread(s, x.name)))
  const key = folderKey(folder.id)
  const header = {
    title: folderLabel(useStore.getState(), folder),
    'aria-expanded': folder.open,
    'data-drop-onto': 'Add to folder',
    onClick: () => toggleFolder(folder.id),
    ...longPress(
      (x, y) =>
        openContextMenu(x, y, [
          {
            label: 'Rename folder',
            action: () => openDialog({ kind: 'rename_folder', id: folder.id }),
          },
          { label: 'Ungroup', action: () => ungroupFolder(folder.id) },
        ]),
      {
        group: 'rail',
        key,
        zones: zone => zone === 'servers',
        onDrop: ({ index }) => moveFolder(folder.id, index),
      }
    ),
  }
  if (!folder.open) {
    return (
      <button {...header} className={`${tile} folder-tile relative p-1.5`}>
        <span className="grid size-9 grid-cols-2 grid-rows-2 gap-1">
          {servers.slice(0, 4).map(s => (
            <MiniIcon key={s.name} server={s} />
          ))}
        </span>
        {unread && <UnreadDot />}
      </button>
    )
  }
  return (
    <div
      data-drag-box
      className="folder-group flex w-14 shrink-0 flex-col items-center rounded-[20px] py-1"
    >
      <button
        {...header}
        className={`${tile} text-primary hover:bg-primary-container hover:text-on-primary-container`}
      >
        <FolderOpen size={22} />
      </button>
      <div
        data-drop-zone={key}
        data-drop-label="Add to folder"
        className="flex flex-col items-center gap-2 pt-2"
      >
        {servers.map(s => (
          <ServerTile key={s.name} server={s} folder={folder.id} at={at} />
        ))}
      </div>
    </div>
  )
}

export function ServerRail() {
  const router = useRouter()
  const me = useStore(s => s.me)
  const guestServers = useStore(s => s.guestServers)
  const guestNames = useStore(s => s.guestNames)
  const servers = useStore(s => (s.me ? NO_DETAILS : s.servers))
  const view = useStore(s => s.view)
  const dmUnread = useStore(dmsUnread)
  const openLastDm = useStore(s => s.openLastDm)
  const serversMore = useStore(s => s.serversMore)
  const loadMoreServers = useStore(s => s.loadMoreServers)
  const openDialog = useStore(s => s.openDialog)
  const logout = useStore(s => s.logout)
  const saved = useStore(s => s.layout.servers)

  const items = railItems(
    railServers({ me, guestServers, guestNames, servers }),
    x => x.name,
    saved
  )

  return (
    <nav className="flex h-full w-18 shrink-0 flex-col bg-surface-container-lowest">
      <div
        ref={dragScope}
        className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto pt-3 pb-2"
      >
        {me && (
          <button
            title="Direct messages"
            onClick={openLastDm}
            className={`${tile} relative ${view?.kind === 'dm' ? 'bg-primary text-on-primary' : idle}`}
          >
            <MessageCircle size={22} />
            {dmUnread && <UnreadDot />}
          </button>
        )}
        {me && <div className="my-1 h-px w-8 shrink-0 bg-outline-variant" />}
        <div
          data-drop-zone="servers"
          data-drop-label="Remove from folder"
          className="flex shrink-0 flex-col items-center gap-2"
        >
          {items.map((item, at) =>
            item.kind === 'server' ? (
              <ServerTile key={item.key} server={item.server} folder={null} at={at} />
            ) : (
              <FolderEntry key={item.key} folder={item.folder} servers={item.servers} at={at} />
            )
          )}
        </div>
        {me && serversMore && <Sentinel key={me.servers.length} onVisible={loadMoreServers} />}
        <button
          title="Add a server"
          onClick={() => openDialog({ kind: 'add_server' })}
          className={`${tile} bg-primary-container text-on-primary-container shadow-elevation-1 hover:bg-primary hover:text-on-primary`}
        >
          <Plus size={22} />
        </button>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2 border-t border-outline-variant pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
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
