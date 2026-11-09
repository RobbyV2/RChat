// The menus of a server icon on the rail, of the previewed server's icon and of a rail folder.
// Marking read, muting and leaving a server are the server's palette commands (place.ts).

import { Bell, BellOff, CheckCheck } from 'lucide-react'
import { inviteUrl } from '../invite'
import { muteEnd, mutedText } from '../notify'
import { sharing } from '../platform'
import { myPerms, previewServer, serverNames, serversMarkTargets, useStore } from '../store'
import type { RChatState } from '../store_types'
import { Perm, hasPerm } from '../types'
import { signedIn } from './global'
import { muteStep, muteUntil, notifySettings } from './notify'
import type { Action, ActionCtx } from './types'

const get = () => useStore.getState()

const copy = (text: string) => void sharing().copyText(text)

// The rail icon of a server you are in (or keep as a guest).
export const railServer = ({ s, target }: ActionCtx): string | null =>
  target.kind === 'server' && serverNames(s).includes(target.server) ? target.server : null

// The icon of the server open without joining.
const previewed = ({ s, target }: ActionCtx): string | null =>
  target.kind === 'server' && previewServer(s) === target.server ? target.server : null

const folderOf = ({ target }: ActionCtx) => (target.kind === 'folder' ? target.folder : null)

// The folder's servers, each with its own mute end (null: not muted).
const folderMutes = (s: RChatState, servers: string[]) => {
  const now = Date.now()
  return servers.map(name => muteEnd(s.notifyPrefs, { kind: 'server', name }, now))
}

const allMuted = (ctx: ActionCtx) => {
  const servers = folderOf(ctx)?.servers ?? []
  return servers.length > 0 && folderMutes(ctx.s, servers).every(e => e !== null)
}

const onServer = { scope: 'server', targets: ['server'] } as const
const onFolder = { scope: 'server', targets: ['folder'] } as const

export const serverActions: Action[] = [
  notifySettings('server_notify', 'server', ['server'], ctx => {
    const server = railServer(ctx)
    return server === null ? null : { kind: 'server', name: server }
  }),
  {
    id: 'server_create_category',
    title: 'Create category',
    ...onServer,
    order: 200,
    available: ctx => {
      const server = railServer(ctx)
      return (
        server !== null && signedIn(ctx.s) && hasPerm(myPerms(ctx.s, server), Perm.ManageChannels)
      )
    },
    run: ctx => {
      const server = railServer(ctx)
      if (server) get().openDialog({ kind: 'category', server })
    },
  },
  {
    id: 'server_copy_invite',
    title: 'Copy invite link',
    ...onServer,
    order: 900,
    available: ctx => railServer(ctx) !== null,
    run: ctx => {
      const server = railServer(ctx)
      if (server) copy(inviteUrl(server))
    },
  },
  {
    id: 'server_copy_id',
    title: 'Copy Server ID',
    ...onServer,
    order: 910,
    available: ctx => railServer(ctx) !== null,
    run: ctx => {
      const server = railServer(ctx)
      if (server) copy(server)
    },
  },
  {
    id: 'server_remove_from_folder',
    title: 'Remove from folder',
    ...onServer,
    order: 920,
    available: ctx =>
      railServer(ctx) !== null && ctx.target.kind === 'server' && ctx.target.folder !== null,
    run: ctx => {
      const server = railServer(ctx)
      if (server && ctx.target.kind === 'server') get().moveServer(server, ctx.target.at + 1)
    },
  },
  {
    id: 'guest_server_join',
    title: 'Join Server',
    ...onServer,
    order: 100,
    available: ctx => previewed(ctx) !== null,
    run: ctx => {
      const server = previewed(ctx)
      if (server) void get().joinPreview(server)
    },
  },
  {
    id: 'guest_server_copy_id',
    title: 'Copy Server ID',
    ...onServer,
    order: 910,
    available: ctx => previewed(ctx) !== null,
    run: ctx => {
      const server = previewed(ctx)
      if (server) copy(server)
    },
  },
  {
    id: 'folder_mark_read',
    title: 'Mark as read',
    icon: CheckCheck,
    ...onFolder,
    order: 110,
    available: ctx => !!ctx.s.me && !!folderOf(ctx)?.servers.length,
    disabled: ctx => !serversMarkTargets(ctx.s, folderOf(ctx)?.servers ?? []).length,
    run: ctx => {
      const folder = folderOf(ctx)
      if (folder) void get().markServersRead(folder.servers)
    },
  },
  {
    id: 'folder_mute',
    title: 'Mute folder',
    icon: BellOff,
    ...onFolder,
    order: 120,
    args: [muteStep],
    available: ctx => !!folderOf(ctx)?.servers.length && !allMuted(ctx),
    run: (ctx, { value }) => {
      const folder = folderOf(ctx)
      if (folder) get().muteServers(folder.servers, muteUntil(value))
    },
  },
  {
    id: 'folder_unmute',
    title: 'Unmute folder',
    icon: Bell,
    ...onFolder,
    order: 120,
    subtitle: ctx => {
      const ends = folderMutes(ctx.s, folderOf(ctx)?.servers ?? [])
      const [first] = ends
      return first != null && ends.every(e => e === first)
        ? mutedText(first, Date.now())
        : undefined
    },
    available: allMuted,
    run: ctx => {
      const folder = folderOf(ctx)
      if (folder) get().muteServers(folder.servers, null)
    },
  },
  {
    id: 'folder_rename',
    title: 'Edit folder',
    ...onFolder,
    order: 300,
    available: ctx => folderOf(ctx) !== null,
    run: ctx => {
      const folder = folderOf(ctx)
      if (folder) get().openDialog({ kind: 'rename_folder', id: folder.id })
    },
  },
  {
    id: 'folder_ungroup',
    title: 'Ungroup',
    ...onFolder,
    order: 310,
    available: ctx => folderOf(ctx) !== null,
    run: ctx => {
      const folder = folderOf(ctx)
      if (folder) get().ungroupFolder(folder.id)
    },
  },
]
