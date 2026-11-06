import { Ban, ShieldOff, UserMinus, UserPlus, Users } from 'lucide-react'
import { parseAddCommand, parseNames } from '../friends'
import { userRefFor, useStore } from '../store'
import type { UserRef } from '../types'
import { signedIn, username, usernameStep } from './global'
import type { Action, ActionCtx, Expansion } from './types'

const get = () => useStore.getState()

const member = ({ s }: ActionCtx) => signedIn(s)

const person = (u: UserRef, label: string): Expansion => ({
  key: u.username,
  label,
  subtitle: `@${u.username}`,
  subtitleName: true,
  name: true,
  args: { user: u.username },
})

export const friendActions: Action[] = [
  {
    id: 'friends',
    title: 'Open friends',
    scope: 'global',
    group: 'friends',
    icon: Users,
    available: member,
    run: () => get().openFriends(),
  },
  {
    id: 'add_friends',
    title: 'Add friends',
    scope: 'global',
    group: 'friends',
    icon: UserPlus,
    keywords: ['friend request', 'add friend'],
    args: [
      {
        kind: 'text',
        name: 'value',
        prompt: 'Usernames, separated by spaces',
        check: t => (parseNames(t).length ? null : 'Type at least one username'),
      },
    ],
    parse: t => parseAddCommand(t)?.join(' ') ?? null,
    available: member,
    run: (_ctx, { value }) => get().askAddFriends(parseNames(value)),
  },
  {
    id: 'block',
    title: 'Block someone',
    scope: 'global',
    group: 'friends',
    icon: Ban,
    danger: true,
    args: [usernameStep],
    parse: t => /^\s*block\s+@?(\S+)\s*$/i.exec(t)?.[1] ?? null,
    available: member,
    run: ({ s }, { value }) => get().askBlock(userRefFor(s, username(value))),
  },
  {
    id: 'accept',
    title: 'Accept friend request',
    scope: 'global',
    group: 'friends',
    icon: UserPlus,
    available: member,
    expand: ({ s }) =>
      s.incomingRequests.list.map(r =>
        person(r.user, `Accept friend request: ${r.user.display_name}`)
      ),
    run: ({ s }, { user }) => {
      const u = s.incomingRequests.list.find(r => r.user.username === user)?.user
      if (u) void get().acceptFriend(u)
    },
  },
  {
    id: 'deny',
    title: 'Deny friend request',
    scope: 'global',
    group: 'friends',
    icon: UserMinus,
    available: member,
    expand: ({ s }) =>
      s.incomingRequests.list.map(r =>
        person(r.user, `Deny friend request: ${r.user.display_name}`)
      ),
    run: ({ s }, { user }) => {
      if (s.incomingRequests.list.some(r => r.user.username === user)) void get().denyFriend(user)
    },
  },
  {
    id: 'unfriend',
    title: 'Remove friend',
    scope: 'global',
    group: 'friends',
    icon: UserMinus,
    danger: true,
    available: member,
    expand: ({ s }) =>
      s.friends.list.map(f => person(f.user, `Remove friend: ${f.user.display_name}`)),
    run: ({ s }, { user }) => {
      const u = s.friends.list.find(f => f.user.username === user)?.user
      if (u) get().askRemoveFriend(u)
    },
  },
  {
    id: 'unblock',
    title: 'Unblock',
    scope: 'global',
    group: 'friends',
    icon: ShieldOff,
    available: member,
    expand: ({ s }) => s.blockList.list.map(b => person(b.user, `Unblock ${b.user.display_name}`)),
    run: ({ s }, { user }) => {
      const u = s.blockList.list.find(b => b.user.username === user)?.user
      if (u) void get().unblockUser(u.username, u.display_name)
    },
  },
]
