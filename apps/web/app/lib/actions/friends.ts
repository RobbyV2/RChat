import { Ban, ShieldOff, UserMinus, UserPlus, Users } from 'lucide-react'
import { parseAddCommand, parseNames } from '../friends'
import { userRefFor } from '../store'
import type { UserRef } from '../types'
import { signedIn, username, usernameStep } from './global'
import type { Action, ActionCtx, Expansion } from './types'
import { markedLabelsOf } from './ctx'
import { unnamed, labelWith, personCalled, type Said } from '../names'

const member = ({ s }: ActionCtx) => signedIn(s)

const person = <const V extends string>(ctx: ActionCtx, u: UserRef, verb: Said<V>): Expansion => ({
  key: u.username,
  label: labelWith`${unnamed(verb)} ${markedLabelsOf(ctx)(personCalled(u.display_name, u.username))}`,
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
    run: ({ acct }) => acct.store.getState().openFriends(),
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
    run: (_ctx, { value }) => _ctx.acct.store.getState().askAddFriends(parseNames(value)),
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
    run: ({ acct, s }, { value }) => acct.store.getState().askBlock(userRefFor(s, username(value))),
  },
  {
    id: 'accept',
    title: 'Accept friend request',
    scope: 'global',
    group: 'friends',
    icon: UserPlus,
    available: member,
    expand: ctx =>
      ctx.s.incomingRequests.list.map(r => person(ctx, r.user, 'Accept friend request:')),
    run: ({ acct, s }, { user }) => {
      const u = s.incomingRequests.list.find(r => r.user.username === user)?.user
      if (u) void acct.store.getState().acceptFriend(u)
    },
  },
  {
    id: 'deny',
    title: 'Deny friend request',
    scope: 'global',
    group: 'friends',
    icon: UserMinus,
    available: member,
    expand: ctx =>
      ctx.s.incomingRequests.list.map(r => person(ctx, r.user, 'Deny friend request:')),
    run: ({ acct, s }, { user }) => {
      if (s.incomingRequests.list.some(r => r.user.username === user))
        void acct.store.getState().denyFriend(user)
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
    expand: ctx => ctx.s.friends.list.map(f => person(ctx, f.user, 'Remove friend:')),
    run: ({ acct, s }, { user }) => {
      const u = s.friends.list.find(f => f.user.username === user)?.user
      if (u) acct.store.getState().askRemoveFriend(u)
    },
  },
  {
    id: 'unblock',
    title: 'Unblock',
    scope: 'global',
    group: 'friends',
    icon: ShieldOff,
    available: member,
    expand: ctx => ctx.s.blockList.list.map(b => person(ctx, b.user, 'Unblock')),
    run: ({ acct, s }, { user }) => {
      const u = s.blockList.list.find(b => b.user.username === user)?.user
      if (u) void acct.store.getState().unblockUser(u.username, u.display_name)
    },
  },
]
