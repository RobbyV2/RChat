// The rows of a message author's menu that the message panes still build themselves (Task C4
// moves those menus to the registry and removes these).

import { userRefFor, useStore } from '../store'
import type { ContextMenuItem } from '../store_types'
import type { UserRef } from '../types'
import { ctxFor } from './ctx'
import { registerAppActions } from './index'
import { itemFor } from './menu'

export const authorItem = (id: string, user: UserRef, server: string | null = null) => {
  registerAppActions()
  const s = useStore.getState()
  return itemFor(id, ctxFor(s, { kind: 'member', user, server, where: 'author' }, 'menu'))
}

const refOf = (username: string) => userRefFor(useStore.getState(), username)

export const banMenuItem = (server: string, username: string) =>
  authorItem('member_ban', refOf(username), server)

export const timeoutMenuItems = (server: string, user: UserRef): ContextMenuItem[] =>
  ['member_timeout', 'member_timeout_remove'].flatMap(id => authorItem(id, user, server) ?? [])

export const roleMenuItems = (server: string, username: string): ContextMenuItem[] =>
  authorItem('member_roles', refOf(username), server)?.submenu ?? []
