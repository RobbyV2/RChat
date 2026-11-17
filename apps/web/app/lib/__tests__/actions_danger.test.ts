import { expect, test } from 'bun:test'
import { registerAppActions } from '../actions'
import { actionById, allActions } from '../actions/registry'
import type { Action } from '../actions/types'
import type { ProfileAction } from '../profile'
import { cardDanger } from '../../components/profile_card'

registerAppActions()

// Words in an id or a title that say an action takes something from someone or can't be undone.
const RISKY = new Set([
  'kick',
  'ban',
  'timeout',
  'untimeout',
  'transfer',
  'revoke',
  'delete',
  'remove',
  'leave',
  'block',
  'logout',
  'unfriend',
  'reset',
  'hangup',
  'promote',
  'assign',
  'role',
])

// Words that do the same when the action is on another member.
const RISKY_ON_MEMBER = new Set(['mute', 'deafen', 'disconnect'])

const words = (a: Action) =>
  `${a.id} ${a.title}`
    .toLowerCase()
    .replace(/time out/g, 'timeout')
    .replace(/log out/g, 'logout')
    .split(/[^a-z]+/)

const risky = (a: Action) =>
  words(a).some(w => RISKY.has(w) || (a.id.startsWith('member_') && RISKY_ON_MEMBER.has(w)))
const marked = (a: Action) => !!a.danger || !!a.dangerFor

// Risky by name, shown plain, each with the reason.
const PLAIN: Record<string, string> = {
  untimeout: 'lifts a restriction and is easily redone',
  member_timeout_remove: 'lifts a restriction and is easily redone',
  member_promote_admin: 'gives rights; Revoke Admin takes them back',
  member_roles: 'opens the role list; taking a role away is marked there',
  p2p_limits_reset: 'puts your own storage limits back to the defaults',
  server_remove_from_folder: 'moves a server out of a folder on your own rail',
  card_forget: 'takes a card off your own Home; it comes back when you visit the place',
  p2p_server_remove_from_folder: 'moves a P2P server out of a folder on your own rail',
  p2p_role_up: 'moves a role one step; a move that takes rights away asks first',
  p2p_role_down: 'moves a role one step; a move that takes rights away asks first',
}

test('every action that changes standing or cannot be undone is marked as danger', () => {
  const unmarked = allActions()
    .filter(a => risky(a) && !marked(a))
    .map(a => a.id)
    .sort()
  expect(unmarked).toEqual(Object.keys(PLAIN).sort())
})

test('the actions marked as danger', () => {
  expect(
    allActions()
      .filter(marked)
      .map(a => a.id)
  ).toEqual([
    'selection_delete',
    'timeout_member',
    'leave_server',
    'hangup',
    'leave_voice',
    'logout',
    'block',
    'unfriend',
    'member_kick',
    'member_ban',
    'member_timeout',
    'member_revoke_admin',
    'member_transfer_admin',
    'friend_remove',
    'member_block',
    'admin_ban_site_wide',
    'admin_remove_phrase',
    'message_delete',
    'embed_remove',
    'embed_remove_banner',
    'embed_remove_all',
    'channel_delete',
    'category_delete',
    'voice_guest_disconnect',
    'p2p_contact_block',
    'p2p_contact_remove',
    'p2p_server_leave',
    'p2p_server_remove',
    'p2p_channel_leave_voice',
    'p2p_channel_delete',
    'p2p_member_kick',
    'p2p_member_withdraw',
    'p2p_member_transfer',
    'p2p_member_ban',
    'p2p_role_delete',
    'p2p_message_delete',
  ])
})

test('the check reads ids and titles as words', () => {
  expect(risky({ id: 'x.wipe', title: 'Kick everyone' } as Action)).toBe(true)
  expect(risky({ id: 'x.time', title: 'Time out' } as Action)).toBe(true)
  expect(risky({ id: 'member_unblock', title: 'Unblock' } as Action)).toBe(false)
  expect(risky({ id: 'member_server_mute', title: 'Server mute' } as Action)).toBe(true)
  expect(risky({ id: 'mute_here', title: 'Mute' } as Action)).toBe(false)
})

// The profile card's own rows, and the member menu's rows for the same actions.
const CARD: Record<ProfileAction, string> = {
  kick: 'member_kick',
  server_ban: 'member_ban',
  timeout: 'member_timeout',
  untimeout: 'member_timeout_remove',
  promote: 'member_promote_admin',
  revoke: 'member_revoke_admin',
  transfer: 'member_transfer_admin',
  site_ban: 'admin_ban_site_wide',
}

test('the profile card marks the same actions as the menus and the palette', () => {
  const card = (Object.keys(CARD) as ProfileAction[]).map(a => [a, cardDanger(a, false)])
  const menu = (Object.keys(CARD) as ProfileAction[]).map(a => [a, marked(actionById(CARD[a])!)])
  expect(card).toEqual(menu)
  expect([marked(actionById('untimeout')!), marked(actionById('timeout_member')!)]).toEqual([
    false,
    true,
  ])
  // Change timeout, on someone timed out already, is plain in the menu (`dangerFor`) and the card.
  expect([cardDanger('timeout', true), cardDanger('untimeout', true)]).toEqual([false, false])
  expect(typeof actionById('member_timeout')!.dangerFor).toBe('function')
})
